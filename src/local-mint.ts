// Public-mint execution with no OpenSea in the loop.
//
// Because the calldata is known ahead of time (see seadrop-public.ts), every
// transaction can be signed and serialised *before* the stage opens. At T-0 the
// only work left is writing bytes to sockets — no API poll, no signing, no
// encoding. That is strictly faster than the OpenSea path, which cannot sign
// until the API hands over calldata roughly a second after the stage starts.
//
// Nonce-bump escalation: if a tx sits pending past bumpAfterMs, we re-sign with
// a higher maxFee (bumpFactor ×) using the same nonce and re-blast. The old tx
// is invalidated by replacement rules (same nonce + higher fee + higher tip).
// Caps at maxBumps — after that we just wait for the receipt.

import chalk from "chalk";
import { performance } from "perf_hooks";
import { JsonRpcProvider, Wallet, formatEther } from "ethers";
import { blastToAll, parseRpcEndpoints, prepareBlast, waitForReceipt, PreparedBlast, probeTxStatus } from "./rpc-blast";
import { warmConnections } from "./connection-warmer";
import { waitForMintTime } from "./timer";
import { explorerTx } from "./chains";
import { LocalMintPlan } from "./seadrop-public";

export interface LocalSnipeOpts {
  nftContract: string;
  quantity: number;
  walletKeys: string[];
  rpcUrls: string[];
  maxFeePerGas: bigint;
  maxPriorityFee: bigint;
  gasLimit: number;
  targetStart: Date | null;
  plan: LocalMintPlan;
}

// Bump policy — tuned for L2 (fast blocks, cheap): start bumping at 8s, add
// 50% maxFee per bump, allow 3 bumps. On Ethereum mainnet raise bumpAfterMs.
const BUMP_AFTER_MS = 8_000;
const BUMP_NUM = 3n; // +50% as integer ratio 3/2
const BUMP_DEN = 2n;
const MAX_BUMPS = 3;
const SETTLE_TIMEOUT_MS = 90_000;

interface FiredTx {
  idx: number;
  address: string;
  txHash: string;
  responsePromise: Promise<{ label: string; txHash: string | null; error: string | null }[]>;
}

export async function localPublicSnipe(opts: LocalSnipeOpts): Promise<void> {
  const {
    nftContract, quantity, walletKeys, rpcUrls,
    maxFeePerGas, maxPriorityFee, gasLimit, targetStart, plan,
  } = opts;

  const provider = new JsonRpcProvider(rpcUrls[0]);
  const endpoints = parseRpcEndpoints(rpcUrls);
  const wallets = walletKeys.map((k) => new Wallet(k, provider));

  console.log(chalk.bold.magenta("\n── LOCAL PUBLIC MINT (no OpenSea) ──"));
  console.log(chalk.gray(`  SeaDrop:       ${plan.to}`));
  console.log(chalk.gray(`  NFT:           ${nftContract}`));
  console.log(chalk.gray(`  Fee recipient: ${plan.feeRecipient}`));
  console.log(
    chalk.gray(
      `  Price:         ${formatEther(plan.drop.mintPrice)} × ${quantity} = ${formatEther(plan.value)} per wallet`
    )
  );
  console.log(chalk.gray(`  Calldata:      ${(plan.data.length - 2) / 2} bytes (identical for every wallet)`));

  // ── Warm sockets and pre-fetch everything the signature depends on ──
  await warmConnections(rpcUrls);

  const [nonces, network] = await Promise.all([
    Promise.all(wallets.map((w) => provider.getTransactionCount(w.address, "pending"))),
    provider.getNetwork(),
  ]);
  const chainId = network.chainId;
  console.log(chalk.gray(`  Nonces: [${nonces.join(", ")}] | chainId: ${chainId}`));

  // ── Sign everything now, well before the stage opens ──
  const signStart = performance.now();
  const prepared: { idx: number; address: string; blast: PreparedBlast; rawTx: string }[] = [];

  for (let i = 0; i < wallets.length; i++) {
    const rawTx = await wallets[i].signTransaction({
      to: plan.to,
      data: plan.data,
      value: plan.value,
      nonce: nonces[i],
      maxFeePerGas,
      maxPriorityFeePerGas: maxPriorityFee,
      gasLimit: gasLimit || 250_000,
      type: 2,
      chainId,
    });
    prepared.push({ idx: i, address: wallets[i].address, blast: prepareBlast(rawTx), rawTx });
  }

  console.log(
    chalk.green(
      `  ✓ ${prepared.length} tx(s) signed and serialised in ${(performance.now() - signStart).toFixed(1)}ms — nothing left to compute at fire time`
    )
  );

  // ── Wait for the stage, then blast pre-built bytes ──
  if (targetStart) {
    await waitForMintTime(targetStart, 0);
  } else {
    console.log(chalk.bold.yellow("\n  🚀 Firing immediately..."));
  }

  const stageStartMs = targetStart ? targetStart.getTime() : Date.now();
  const dispatchStart = performance.now();

  const fired: FiredTx[] = prepared.map(({ idx, address, blast }) => {
    const { txHash, responsePromise } = blastToAll(blast, endpoints);
    return { idx, address, txHash, responsePromise };
  });

  const dispatchMs = (performance.now() - dispatchStart).toFixed(2);
  const sinceStage = Math.max(0, Date.now() - stageStartMs);
  console.log(
    chalk.bold.green(`  DISPATCHED ${fired.length} tx(s) (${dispatchMs}ms, +${sinceStage}ms after stage)`)
  );
  for (const f of fired) {
    console.log(chalk.gray(`    [W${f.idx}] ${f.txHash}`));
  }

  // Dispatch only means "bytes written". Find out whether any endpoint actually
  // took the transaction before promising a receipt that may never exist.
  const settled = await Promise.all(
    fired.map(async (f) => ({ ...f, results: await f.responsePromise }))
  );

  const accepted = settled.filter(({ results }) =>
    results.some((r) => r.txHash !== null || (r.error ?? "").includes("already known"))
  );
  const rejected = settled.filter((s) => !accepted.includes(s));

  for (const { idx, results } of rejected) {
    const reasons = [...new Set(results.map((r) => r.error).filter(Boolean))];
    console.log(chalk.bold.red(`\n  ✗ [W${idx}] REJECTED by every RPC — never broadcast.`));
    for (const reason of reasons) console.log(chalk.red(`      ${reason}`));
    if (reasons.some((r) => (r ?? "").includes("less than block base fee"))) {
      console.log(chalk.yellow("      → Your max fee is under the chain's base fee. Raise it and re-run."));
    }
  }

  if (accepted.length === 0) {
    console.log(chalk.bold.red("\n===== NOTHING WAS BROADCAST — no receipts to wait for =====\n"));
    return;
  }

  // ── Settle with nonce-bump escalation ──
  console.log(chalk.gray("\n  Settling (bump if pending > 8s)..."));

  // Keep a map of per-wallet bump state so replacement uses the same nonce.
  const walletNonce = new Map<number, number>();
  prepared.forEach((p, i) => walletNonce.set(i, nonces[i]));
  const bumpFees = new Map<number, { maxFee: bigint; tip: bigint; bumps: number }>();
  prepared.forEach((p, i) => bumpFees.set(i, { maxFee: maxFeePerGas, tip: maxPriorityFee, bumps: 0 }));

  await Promise.all(
    accepted.map(async ({ idx, txHash, address }) => {
      const startTime = Date.now();
      let currentHash = txHash;

      while (Date.now() - startTime < SETTLE_TIMEOUT_MS) {
        const receipt = await waitForReceipt(currentHash, rpcUrls[0], 4_000);
        if (receipt) {
          const color = receipt.status === "SUCCESS" ? chalk.bold.green : chalk.bold.red;
          console.log(
            color(`  [W${idx}] Block: ${receipt.block} | Pos: ${receipt.position} | ${receipt.status} | Gas: ${receipt.gasUsed}`)
          );
          console.log(chalk.gray(`  [W${idx}] Track: ${explorerTx(chainId, currentHash)}`));
          return;
        }

        // Receipt not found yet. Check whether the tx is still in the mempool.
        const status = await probeTxStatus(currentHash, rpcUrls[0]);
        if (status === "mined") continue; // receipt just lagging
        if (status === "unknown") {
          // RPC hiccup — keep waiting, don't bump on a transient error.
          await new Promise((r) => setTimeout(r, 1_000));
          continue;
        }

        // Pending (or dropped). If dropped and we've exhausted bumps, fall through.
        const state = bumpFees.get(idx)!;
        if (status === "dropped" && state.bumps >= MAX_BUMPS) {
          console.log(chalk.yellow(`  [W${idx}] DROPPED from mempool after ${state.bumps} bumps — check: ${explorerTx(chainId, currentHash)}`));
          return;
        }

        if (state.bumps < MAX_BUMPS && Date.now() - startTime >= BUMP_AFTER_MS * (state.bumps + 1)) {
          // Re-sign with bumped fee, same nonce, and re-blast.
          const newMaxFee = (state.maxFee * BUMP_NUM) / BUMP_DEN;
          const newTip = (state.tip * BUMP_NUM) / BUMP_DEN > newMaxFee ? newMaxFee : (state.tip * BUMP_NUM) / BUMP_DEN;
          state.maxFee = newMaxFee;
          state.tip = newTip;
          state.bumps += 1;

          const rawTx = await wallets[idx].signTransaction({
            to: plan.to,
            data: plan.data,
            value: plan.value,
            nonce: walletNonce.get(idx)!,
            maxFeePerGas: newMaxFee,
            maxPriorityFeePerGas: newTip,
            gasLimit: gasLimit || 250_000,
            type: 2,
            chainId,
          });
          const { txHash: newHash } = blastToAll(prepareBlast(rawTx), endpoints);
          currentHash = newHash;
          const lastBumpState = state.bumps;
          // bump timer is anchored on startTime + bumpAfter × bump count
          console.log(
            chalk.yellow(`  [W${idx}] BUMP #${lastBumpState} → maxFee ${formatEther(newMaxFee)} gwei → ${newHash}`)
          );
        }

        await new Promise((r) => setTimeout(r, 1_000));
      }

      console.log(chalk.yellow(`  [W${idx}] SETTLE TIMEOUT — check: ${explorerTx(chainId, currentHash)}`));
    })
  );

  console.log(chalk.bold.white("\n===== LOCAL PUBLIC MINT COMPLETE ====="));
}
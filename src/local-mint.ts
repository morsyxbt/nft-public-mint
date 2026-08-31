// Public-mint execution with no OpenSea in the loop.
//
// Because the calldata is known ahead of time (see seadrop-public.ts), every
// transaction can be signed and serialised *before* the stage opens. At T-0 the
// only work left is writing bytes to sockets — no API poll, no signing, no
// encoding. That is strictly faster than the OpenSea path, which cannot sign
// until the API hands over calldata roughly a second after the stage starts.

import { performance } from "perf_hooks";
import { JsonRpcProvider, Wallet } from "ethers";
import { blastToAll, parseRpcEndpoints, prepareBlast, waitForReceipt, PreparedBlast } from "./rpc-blast";
import { warmConnections } from "./connection-warmer";
import { waitForMintTime } from "./timer";
import { explorerTx } from "./chains";
import { LocalMintPlan } from "./seadrop-public";
import { log } from "./logger";

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

export async function localPublicSnipe(opts: LocalSnipeOpts): Promise<void> {
  const {
    walletKeys, rpcUrls,
    maxFeePerGas, maxPriorityFee, gasLimit, targetStart, plan,
  } = opts;

  const provider = new JsonRpcProvider(rpcUrls[0]);
  const endpoints = parseRpcEndpoints(rpcUrls);
  const wallets = walletKeys.map((k) => new Wallet(k, provider));

  log("INFO", `SeaDrop: ${plan.to}`);
  log("INFO", `Calldata: ${(plan.data.length - 2) / 2} bytes`);

  // ── Warm sockets and pre-fetch everything the signature depends on ──
  await warmConnections(rpcUrls);

  const [nonces, network] = await Promise.all([
    Promise.all(wallets.map((w) => provider.getTransactionCount(w.address, "pending"))),
    provider.getNetwork(),
  ]);
  const chainId = network.chainId;
  log("INFO", `Nonces: [${nonces.join(", ")}] | chainId: ${chainId}`);

  // ── Sign everything now, well before the stage opens ──
  const signStart = performance.now();
  const prepared: { idx: number; address: string; blast: PreparedBlast }[] = [];

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
    prepared.push({ idx: i, address: wallets[i].address, blast: prepareBlast(rawTx) });
  }

  log("INFO", `${prepared.length} tx(s) signed in ${(performance.now() - signStart).toFixed(1)}ms`);

  // ── Wait for the stage, then blast pre-built bytes ──
  if (targetStart) {
    await waitForMintTime(targetStart, 0);
  } else {
    log("INFO", "Firing immediately.");
  }

  const stageStartMs = targetStart ? targetStart.getTime() : Date.now();
  const dispatchStart = performance.now();

  const fired = prepared.map(({ idx, blast }) => {
    const { txHash, responsePromise } = blastToAll(blast, endpoints);
    return { idx, txHash, responsePromise };
  });

  const dispatchMs = (performance.now() - dispatchStart).toFixed(2);
  const sinceStage = Math.max(0, Date.now() - stageStartMs);
  log("INFO", `Broadcast ${fired.length} tx(s) to ${endpoints.length} endpoint(s) in ${dispatchMs}ms (+${sinceStage}ms after stage)`);
  for (const f of fired) {
    log("INFO", `[W${f.idx}]: ${f.txHash}`);
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

  const allReasons: string[] = [];
  for (const { idx, results } of rejected) {
    const reasons = [...new Set(results.map((r) => r.error).filter(Boolean))] as string[];
    log("ERROR", `[W${idx}] REJECTED by every RPC — never broadcast.`);
    for (const reason of reasons) {
      log("ERROR", reason);
      allReasons.push(reason);
    }
    if (reasons.some((r) => r.includes("less than block base fee"))) {
      log("WARN", "Max fee is under the chain's base fee. Raise it and re-run.");
    }
  }

  if (accepted.length === 0) {
    const summary = allReasons[0] ? ` — ${allReasons[0]}` : "";
    throw new Error(`No transaction was accepted by any RPC${summary}`);
  }

  // ── Receipts (only for txs an endpoint actually accepted) ──
  log("INFO", `Confirming ${accepted.length} tx(s)...`);
  let confirmed = 0;
  await Promise.all(
    accepted.map(async ({ idx, txHash }) => {
      const receipt = await waitForReceipt(txHash, rpcUrls[0], 60_000);
      if (!receipt) {
        log("WARN", `[W${idx}] TIMEOUT — ${explorerTx(chainId, txHash)}`);
        return;
      }
      const success = receipt.status === "SUCCESS";
      const msg = `[W${idx}] Block ${receipt.block} | Gas ${receipt.gasUsed} | ${receipt.status} | ${explorerTx(chainId, txHash)}`;
      if (success) {
        confirmed++;
        log("INFO", msg);
      } else {
        log("ERROR", msg);
      }
    })
  );

  if (confirmed === fired.length) {
    log("INFO", `Mint complete — ${confirmed}/${fired.length} confirmed`);
  } else if (confirmed > 0) {
    const failedCount = fired.length - confirmed;
    const reason = allReasons[0] ? `: ${allReasons[0]}` : "";
    throw new Error(
      `Only ${confirmed}/${fired.length} minted. ${failedCount} wallet${failedCount > 1 ? "s" : ""} failed${reason}.`
    );
  } else {
    throw new Error(`Mint failed — 0/${fired.length} confirmed (reverted or timed out)`);
  }
}

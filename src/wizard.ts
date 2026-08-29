// Interactive public-mint wizard.
//
// Every transaction here is built from on-chain SeaDrop state — price, fee
// recipient and per-wallet cap all come from the contract — so no OpenSea
// account, token or API key is involved in the mint itself.
//
// Nothing is written to disk: pasted keys live in memory for the run only.

import chalk from "chalk";
import { JsonRpcProvider, Wallet, formatEther, getAddress, isAddress } from "ethers";
import { CHAINS, ChainProfile, resolveChain } from "./chains";
import { parseNftLink } from "./nft-link";
import { resolveSlug } from "./slug-resolver";
import {
  maskRpc,
  planRpcs,
  privateRpcsFromEnv,
  resolveRpcsForChain,
  toRpcUrl,
} from "./rpc-resolver";
import { parseRpcEndpoints } from "./rpc-blast";
import { buildLocalMintPlan } from "./seadrop-public";
import { localPublicSnipe } from "./local-mint";
import { parseFireTime, toIST } from "./time-format";
import { syncClock, nowMs } from "./clock";
import { log } from "./logger";
import { askChoice, askHidden, askNumber, askText, askYesNo, closePrompts } from "./prompt";

export async function runWizard(): Promise<void> {
  // Correct the machine clock against public time sources up front so every
  // countdown and the actual fire instant use true time, not a drifting clock.
  await syncClock();

  // ── 1. Private keys ───────────────────────────────────────────────────
  const walletKeys = await resolveWalletKeys();

  // ── 2. Chain ──────────────────────────────────────────────────────────
  let chainKey = await askChoice<string>(
    "Which chain?",
    CHAINS.map((c) => ({ label: c.name, value: c.key, hint: `chain id ${c.chainId}` })),
    Math.max(
      0,
      CHAINS.findIndex((c) => c.key === (process.env.CHAIN || "base").toLowerCase())
    )
  );

  // ── 3. Quantity ───────────────────────────────────────────────────────
  const quantity = await promptQuantity(walletKeys.length);

  // ── 4. NFT link ───────────────────────────────────────────────────────
  const target = await promptTarget(chainKey);
  const nftContract = target.contract;
  chainKey = target.chainKey;
  const chainProfile = resolveChain(chainKey)!;

  // ── 5. RPC endpoints ──────────────────────────────────────────────────
  const manualRpcs = await promptRpc(chainProfile);
  const { urls: candidateRpcs, source } = resolveRpcsForChain(chainKey, manualRpcs);
  log("INFO", `Source: ${source}`);
  log("INFO", `Checking ${candidateRpcs.length} endpoint(s)...`);

  const plan = await planRpcs(candidateRpcs, chainProfile.chainId);

  for (const bad of plan.dropped) {
    const wrong = resolveChain(bad.chainId);
    log("ERROR", `${labelOf(bad.url)} is chain ${bad.chainId}${wrong ? ` (${wrong.name})` : ""} — dropped`);
  }
  for (const ep of parseRpcEndpoints(plan.urls)) {
    const failure = plan.failures.find((f) => f.url === ep.url);
    if (failure) {
      const benign = /not allowed|does not exist|not supported|method not found/i.test(failure.message);
      if (benign) log("INFO", `${ep.label}  (send-only)`);
      else log("WARN", `${ep.label}  ${failure.message.slice(0, 90)}`);
    } else {
      log("INFO", `${ep.label}`);
    }
  }

  if (plan.urls.length === 0) {
    throw new Error(`No usable RPC endpoint for ${chainProfile.name}`);
  }
  if (!plan.verified) {
    log("WARN", `No endpoint confirmed chain id ${chainProfile.chainId}.`);
    if (!(await askYesNo("Continue anyway?", false))) {
      throw new Error("Aborted — could not verify the RPC chain");
    }
  } else {
    log("INFO", `Confirmed chain id ${chainProfile.chainId} (${chainProfile.name})`);
  }
  const rpcUrls = plan.urls;

  // ── 6. Read the public drop from chain ────────────────────────────────
  const mintPlan = await buildLocalMintPlan(rpcUrls[0], nftContract, quantity);
  if (!mintPlan) {
    throw new Error(
      `No SeaDrop public drop readable for ${nftContract} on ${chainProfile.name}.\n` +
        "  Either it isn't a SeaDrop collection, or it keeps its drop config on the token contract."
    );
  }

  const drop = mintPlan.drop;
  const startsAt = new Date(drop.startTime * 1000);
  const endsAt = new Date(drop.endTime * 1000);
  const live = nowMs() >= startsAt.getTime() && nowMs() < endsAt.getTime();

  log("INFO", "Built calldata from on-chain SeaDrop state");
  log("INFO", `Fee recipient: ${mintPlan.feeRecipient}`);
  log("INFO", `Price: ${formatEther(drop.mintPrice)} × ${quantity} = ${formatEther(mintPlan.value)} per wallet`);
  log("INFO", `Max per wallet: ${drop.maxTotalMintableByWallet || "unlimited"}`);
  log("INFO", `Window: ${toIST(startsAt)} → ${toIST(endsAt)} IST  ${live ? "live" : `opens in ${formatRemaining(startsAt.getTime() - nowMs())}`}`);

  if (drop.maxTotalMintableByWallet > 0 && quantity > drop.maxTotalMintableByWallet) {
    log("WARN", `This drop allows only ${drop.maxTotalMintableByWallet} per wallet — ${quantity} will revert.`);
  }
  if (nowMs() >= endsAt.getTime()) {
    log("WARN", "This public stage has already ended on-chain.");
  }

  // ── 7. Gas ────────────────────────────────────────────────────────────
  const provider = new JsonRpcProvider(rpcUrls[0]);
  const baseFeeGwei = await currentBaseFeeGwei(provider);
  if (baseFeeGwei !== null) {
    log("INFO", `Network base fee: ${baseFeeGwei.toFixed(6)} gwei`);
  }

  const envMaxFee = Number(process.env.MAX_FEE_PER_GAS || (chainKey === "ethereum" ? 80 : 2));
  const envPriority = Number(process.env.MAX_PRIORITY_FEE || (chainKey === "ethereum" ? 5 : 0.05));

  // A ceiling under the base fee is rejected outright by every node, so it must
  // not be enterable at all.
  let defaultMaxFee = envMaxFee;
  if (baseFeeGwei !== null) {
    const suggested = Math.ceil((baseFeeGwei * 2 + envPriority) * 1000) / 1000;
    if (envMaxFee < baseFeeGwei) defaultMaxFee = suggested;
    log("INFO", `Must be at least ${baseFeeGwei.toFixed(6)} gwei; ${suggested} gives room to spare.`);
  }

  const maxFeeGwei = await askNumber("Max fee per gas (gwei) — your ceiling", defaultMaxFee, {
    min: baseFeeGwei ?? 0,
  });

  // EIP-1559 caps the tip at the ceiling; ethers refuses to sign otherwise.
  const priorityDefault = Math.min(envPriority, maxFeeGwei);
  const priorityGwei = await askNumber("Priority fee / tip (gwei)", priorityDefault, {
    min: 0,
    max: maxFeeGwei,
  });

  const maxFeePerGas = gweiToWei(maxFeeGwei);
  const maxPriorityFee = gweiToWei(priorityGwei);
  const gasLimit = parseInt(process.env.GAS_LIMIT || "0", 10) || 250_000;

  // ── 8. Timing ─────────────────────────────────────────────────────────
  const { targetStart, timingLabel } = await promptTiming(drop.startTime);

  // ── 9. Balances + affordability ───────────────────────────────────────
  const wallets = walletKeys.map((k) => new Wallet(k));
  const balances = await Promise.all(
    wallets.map((w) => provider.getBalance(w.address).catch(() => null))
  );
  const symbol = chainProfile.nativeSymbol;

  // Nodes reserve gasLimit × maxFee + value upfront and reject if the balance
  // falls short, regardless of the far smaller amount actually spent.
  const required = BigInt(gasLimit) * maxFeePerGas + mintPlan.value;

  wallets.forEach((w, i) => {
    const bal = balances[i];
    const text = bal === null ? "balance unavailable" : `${Number(formatEther(bal)).toFixed(6)} ${symbol}`;
    const short = bal !== null && bal < required;
    const line = `  [W${i}] ${w.address}  ${text}`;
    if (short) log("WARN", `${line}  needs ${formatEther(required)} ${symbol}`);
    else log("INFO", `[W${i}]: ${w.address}  ${text}`);
  });

  const shortWallets = wallets.filter((_, i) => balances[i] !== null && (balances[i] as bigint) < required);
  if (shortWallets.length > 0) {
    log("INFO", `Nodes reserve gasLimit × maxFee${mintPlan.value > 0n ? " + mint price" : ""} = ${formatEther(required)} ${symbol} per wallet upfront.`);
    const poorest = balances
      .filter((b): b is bigint => b !== null)
      .reduce((a, b) => (a < b ? a : b));
    const affordable = Number((poorest - mintPlan.value) / BigInt(gasLimit)) / 1e9;
    if (affordable > 0) {
      log("WARN", `Fund the wallets, or re-run with a max fee at or below ${affordable.toFixed(4)} gwei.`);
    }
    if (shortWallets.length === wallets.length) {
      throw new Error("Every wallet is underfunded — nothing could be broadcast.");
    }
    log("WARN", "The remaining wallet(s) can still fire.");
  }

  // ── 10. Confirm ───────────────────────────────────────────────────────
  line("Chain", `${chainProfile.name} (${chainProfile.chainId})`);
  line("RPC", `${labelOf(rpcUrls[0])} + ${rpcUrls.length - 1} more`);
  line("Target", target.label);
  line("Contract", nftContract);
  line("Wallets", `${wallets.length}`);
  line("Quantity", `${quantity} per wallet → ${quantity * wallets.length} total`);
  line(
    "Mint cost",
    `${formatEther(mintPlan.value)} per wallet → ${formatEther(mintPlan.value * BigInt(wallets.length))} total (+ gas)`
  );
  line("Gas", `${maxFeeGwei} / ${priorityGwei} gwei · limit ${gasLimit}`);
  line("Timing", timingLabel);

  // Hand stdin back so readline never interleaves with the blast logging.
  closePrompts();

  await localPublicSnipe({
    nftContract,
    quantity,
    walletKeys,
    rpcUrls,
    maxFeePerGas,
    maxPriorityFee,
    gasLimit,
    targetStart,
    plan: mintPlan,
  });
}

// ── Steps ───────────────────────────────────────────────────────────────

async function promptKeys(): Promise<string[]> {
  const keys: string[] = [];
  const seen = new Set<string>();

  for (;;) {
    const raw = await askHidden(chalk.gray(`  › key ${keys.length + 1}: `));
    if (!raw) {
      if (keys.length === 0) {
        log("ERROR", "Need at least one key.");
        continue;
      }
      break;
    }

    const normalized = raw.startsWith("0x") ? raw : `0x${raw}`;
    let wallet: Wallet;
    try {
      wallet = new Wallet(normalized);
    } catch {
      log("ERROR", "Not a valid private key — try again.");
      continue;
    }

    if (seen.has(wallet.address.toLowerCase())) {
      log("WARN", `Duplicate of ${short(wallet.address)} — skipped.`);
      continue;
    }
    seen.add(wallet.address.toLowerCase());
    keys.push(normalized);
    log("INFO", `[W${keys.length - 1}]: ${wallet.address}`);
  }

  log("INFO", `${keys.length} wallet(s) loaded.`);
  return keys;
}

async function promptQuantity(walletCount: number): Promise<number> {
  const qty = await askNumber("NFTs per wallet", 1, { min: 1, max: 100 });
  if (walletCount > 1) {
    log("INFO", `Quantity: ${qty} × ${walletCount} wallets = ${qty * walletCount} total`);
  }
  return Math.floor(qty);
}

async function promptTarget(
  chainKey: string
): Promise<{ contract: string; label: string; chainKey: string }> {
  log("INFO", "Paste the OpenSea link (collection or item), a slug, or the contract address.");

  let activeChain = chainKey;

  for (;;) {
    const raw = await askText("NFT link");
    if (!raw) {
      log("ERROR", "Paste a link, slug, or address.");
      continue;
    }

    let parsed;
    try {
      parsed = parseNftLink(raw);
    } catch (err: any) {
      log("ERROR", `${err.message}`);
      continue;
    }

    if (parsed.chainHint && parsed.chainHint !== activeChain && resolveChain(parsed.chainHint)) {
      const hinted = resolveChain(parsed.chainHint)!;
      log("WARN", `This link points at ${hinted.name}, but you selected ${resolveChain(activeChain)!.name}.`);
      if (await askYesNo(`Switch to ${hinted.name}?`, true)) {
        activeChain = hinted.key;
        log("INFO", `Chain switched to ${hinted.name}`);
      }
    }

    if (parsed.kind === "address") {
      const normalized = normalizeAddress(parsed.value);
      if (!normalized) {
        log("ERROR", `"${parsed.value}" is not a 20-byte address.`);
        continue;
      }
      if (normalized.checksumWarning) {
        log("WARN", "Mixed-case address whose EIP-55 checksum doesn't match — likely a typo.");
        if (!(await askYesNo("Use it anyway?", false))) continue;
      }
      log("INFO", `Contract: ${normalized.address}`);
      return { contract: normalized.address, label: short(normalized.address), chainKey: activeChain };
    }

    // Slug → address is a plain OpenSea REST lookup, which often answers without
    // a key. Always try; a key only makes it reliable. The mint itself never
    // touches OpenSea either way.
    const apiKey = (process.env.OPENSEA_API_KEY || "").trim();

    try {
      log("INFO", `Resolving slug "${parsed.value}"${apiKey ? "" : " (no API key — may be refused)"}...`);
      const info = await resolveSlug(parsed.value, apiKey || undefined, activeChain);
      const resolved = normalizeAddress(info.contractAddress);
      if (!resolved) {
        log("ERROR", `Unusable address returned: ${info.contractAddress}`);
        continue;
      }
      log("INFO", `Contract: ${resolved.address}`);
      if (info.chain && resolveChain(info.chain) && info.chain !== activeChain) {
        log("WARN", `Listed on "${info.chain}", not "${activeChain}".`);
        if (await askYesNo(`Switch to ${resolveChain(info.chain)!.name}?`, true)) {
          activeChain = resolveChain(info.chain)!.key;
        }
      }
      return { contract: resolved.address, label: info.name || parsed.value, chainKey: activeChain };
    } catch (err: any) {
      log("ERROR", `${err.message}`);
      log("INFO", "    Paste the contract address (0x…) instead — that always works, no key needed.");
      log("INFO", "    Find it on the collection page under Details, or click any item: the address is in that URL.");
    }
  }
}

async function promptRpc(profile: ChainProfile): Promise<string[]> {
  const fromEnv = privateRpcsFromEnv(profile.key);
  if (fromEnv.length > 0) {
    return fromEnv;
  }
  log("WARN", `Nothing in .env for ${profile.name}. Blank = public nodes only.`);

  for (;;) {
    const raw = await askText(`RPC for ${profile.name}`);
    if (!raw) return fromEnv;

    const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
    const urls: string[] = [];
    let bad = false;
    for (const part of parts) {
      const url = toRpcUrl(part, profile.key);
      if (!url) {
        log("ERROR", `"${part}" is not a URL or a usable API key.`);
        bad = true;
        break;
      }
      urls.push(url);
    }
    if (bad || urls.length === 0) continue;

    for (const url of urls) log("INFO", `${maskRpc(url)}`);
    return urls;
  }
}

async function promptTiming(
  startTime: number
): Promise<{ targetStart: Date | null; timingLabel: string }> {
  const at = new Date(startTime * 1000);
  // Default = on-chain start in IST, parseable by the fire-time parser, so a
  // bare Enter waits for the stage. "now" fires immediately.
  const ist = new Date(at.getTime() + 330 * 60000);
  const def = `${ist.getUTCDate()}/${ist.getUTCMonth() + 1}/${ist.getUTCFullYear()} ${String(
    ist.getUTCHours()
  ).padStart(2, "0")}:${String(ist.getUTCMinutes()).padStart(2, "0")}`;

  for (;;) {
    const raw = await askText(
      `Fire time ('August 29 at 2:00 AM GMT+7' or 'now')`,
      def
    );
    const trimmed = raw.trim().toLowerCase();
    if (trimmed === "now") return { targetStart: null, timingLabel: "fire immediately" };
    try {
      const custom = parseFireTime(raw);
      if (custom.getTime() < startTime * 1000) {
        log("ERROR", `That is before the stage opens (${toIST(at)} IST) — it will revert.`);
        if (!(await askYesNo("Use it anyway?", false))) continue;
      }
      return { targetStart: custom, timingLabel: `custom — ${toIST(custom)} IST` };
    } catch (err: any) {
      log("ERROR", `${err.message}`);
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────


// Accept an address in any case — explorer copy-pastes arrive case-mangled and
// hard-failing is worse. A mixed-case string failing EIP-55 is the typo signal.
function normalizeAddress(raw: string): { address: string; checksumWarning: boolean } | null {
  const value = raw.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) return null;
  const body = value.slice(2);
  const mixedCase = /[a-f]/.test(body) && /[A-F]/.test(body);
  return {
    address: getAddress(value.toLowerCase()),
    checksumWarning: mixedCase && !isAddress(value),
  };
}

async function currentBaseFeeGwei(provider: JsonRpcProvider): Promise<number | null> {
  try {
    const fee = await provider.getFeeData();
    const wei = fee.gasPrice ?? fee.maxFeePerGas;
    return wei === null || wei === undefined ? null : Number(wei) / 1e9;
  } catch {
    return null;
  }
}

function gweiToWei(gwei: number): bigint {
  return BigInt(Math.round(gwei * 1e9));
}

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

function labelOf(url: string): string {
  return parseRpcEndpoints([url])[0].label;
}

function line(label: string, value: string): void {
  log("INFO", `${label}: ${value}`);
}

// ── JSON wallet loader ─────────────────────────────────────────────────

export interface HeadlessMintOpts {
  slug: string; // OpenSea collection slug (also accepts a url or 0x address)
  chainKey: string; // accepts aliases: eth | robin | base | ...
  quantity: number;
  fireTime: string | null; // "now", a date string, or null (= now)
}

// Non-interactive mint path used by the Telegram bot. Reuses the same on-chain
// plan building as runWizard but takes parameters instead of prompts. Wallets
// come from SECRET_WALLET and RPC from .env, exactly like the wizard.
export async function runHeadless(opts: HeadlessMintOpts): Promise<void> {
  await syncClock();
  if (!opts.slug || !opts.slug.trim()) {
    throw new Error("Missing mint target — pass a slug, OpenSea URL, or 0x contract address.");
  }
  const walletKeys = await resolveWalletKeys();

  const chainProfile = resolveChain(opts.chainKey);
  if (!chainProfile) throw new Error(`Unknown chain: ${opts.chainKey}`);
  const chainKey = chainProfile.key;

  // ── Resolve target (address or slug) ──
  const parsed = parseNftLink(opts.slug);
  let target: { contract: string; label: string; chainKey: string };
  if (parsed.kind === "address") {
    const addr = parsed.value.startsWith("0x") ? parsed.value : `0x${parsed.value}`;
    let contract: string;
    try {
      contract = getAddress(addr.toLowerCase());
    } catch {
      throw new Error(`Not a valid contract address: ${parsed.value}`);
    }
    target = { contract, label: short(contract), chainKey };
  } else {
    const apiKey = (process.env.OPENSEA_API_KEY || "").trim();
    const info = await resolveSlug(parsed.value, apiKey || undefined, chainKey);
    target = { contract: getAddress(info.contractAddress.toLowerCase()), label: info.name || parsed.value, chainKey };
  }
  const nftContract = target.contract;

  // ── RPC from .env ──
  const { urls: candidateRpcs } = resolveRpcsForChain(chainKey, []);
  const plan = await planRpcs(candidateRpcs, chainProfile.chainId);
  if (plan.urls.length === 0) throw new Error(`No usable RPC endpoint for ${chainProfile.name}`);
  const rpcUrls = plan.urls;

  // ── Drop ──
  const mintPlan = await buildLocalMintPlan(rpcUrls[0], nftContract, opts.quantity);
  if (!mintPlan) throw new Error(`No SeaDrop public drop readable for ${nftContract}`);

  // ── Gas from env (no prompts) ──
  const maxFeeGwei = Number(process.env.MAX_FEE_PER_GAS || (chainKey === "ethereum" ? 80 : 2));
  const priorityGwei = Number(process.env.MAX_PRIORITY_FEE || (chainKey === "ethereum" ? 5 : 0.05));
  const maxFeePerGas = gweiToWei(maxFeeGwei);
  const maxPriorityFee = gweiToWei(priorityGwei);
  const gasLimit = parseInt(process.env.GAS_LIMIT || "0", 10) || 250_000;

  // ── Timing ──
  let targetStart: Date | null = null;
  if (opts.fireTime && opts.fireTime.trim().toLowerCase() !== "now") {
    targetStart = parseFireTime(opts.fireTime);
  }

  log("INFO", `Target: ${target.label} (${nftContract}) on ${chainProfile.name}`);
  log("INFO", `Quantity: ${opts.quantity} per wallet → ${opts.quantity * walletKeys.length} total`);

  await localPublicSnipe({
    nftContract,
    quantity: opts.quantity,
    walletKeys,
    rpcUrls,
    maxFeePerGas,
    maxPriorityFee,
    gasLimit,
    targetStart,
    plan: mintPlan,
  });
}

async function resolveWalletKeys(): Promise<string[]> {
  const raw = (process.env.SECRET_WALLET || "").trim();
  if (!raw) {
    return await promptKeys();
  }

  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const keys: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < parts.length; i++) {
    const normalized = parts[i].startsWith("0x") ? parts[i] : `0x${parts[i]}`;
    let wallet: Wallet;
    try {
      wallet = new Wallet(normalized);
    } catch {
      throw new Error(`Invalid private key at position ${i + 1} in SECRET_WALLET`);
    }

    const addr = wallet.address.toLowerCase();
    if (seen.has(addr)) {
      log("WARN", `Duplicate ${short(wallet.address)} skipped`);
      continue;
    }
    seen.add(addr);
    keys.push(normalized);
    log("INFO", `[W${keys.length - 1}] ${wallet.address}`);
  }

  if (keys.length === 0) {
    throw new Error("No valid private keys found in SECRET_WALLET");
  }
  log("INFO", `${keys.length} wallet(s) loaded from SECRET_WALLET`);
  return keys;
}

// Telegram bot that triggers the headless mint path. No extra dependency —
// it talks to the Telegram HTTP API with the built-in fetch.
//
// Usage (chat message):
//   /mint <qty> <slug> [chain: eth|robin|base] [time: now|date]
//   /mint 1 goobs-nft robin now
//   /mint 2 cool-apes base August 29 at 2:00 AM GMT+7
//   /cancel <slug>
//
// Time is "now" or any date string parseFireTime understands.
// Scheduled times are shown in human-readable IST.
// Mints run concurrently (fire-and-forget). Every job is persisted to
// bot-state.json with the last seen Telegram update offset, so if the bot
// crashes or is restarted it resumes unfinished jobs and never re-reads an
// already-handled message — you don't have to resend anything.

import fs from "fs";
import path from "path";
import { log } from "./logger";
import { parseFireTime, toIST } from "./time-format";
import { runHeadless } from "./wizard";

const API = "https://api.telegram.org/bot";
const STATE_FILE = path.resolve(process.cwd(), "bot-state.json");

type JobStatus = "pending" | "running" | "done" | "failed" | "cancelled";

interface MintJob {
  updateId: number;
  chatId: number;
  slug: string;
  // Legacy state files stored the mint target as `targetUrl`. Kept so old
  // jobs still resume after a schema rename.
  targetUrl?: string;
  chainKey: string;
  quantity: number;
  fireTime: string;
  status: JobStatus;
  warned?: boolean;
  result?: string;
}

interface BotState {
  offset: number;
  jobs: Record<number, MintJob>;
}

interface Update {
  update_id: number;
  message?: {
    chat: { id: number };
    text?: string;
  };
}

function loadState(): BotState {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as BotState;
  } catch {
    return { offset: 0, jobs: {} };
  }
}

function saveState(state: BotState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function getToken(): string {
  const token = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  return token;
}

function allowedChats(): string[] {
  return (process.env.ALLOWED_CHAT_ID || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function api(token: string, method: string, body?: unknown): Promise<any> {
  const res = await fetch(`${API}${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function reply(
  token: string,
  chatId: number,
  text: string,
): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  };
  await api(token, "sendMessage", body);
}

const CHAIN_DISPLAY: Record<string, string> = { robin: "robinhood" };
const VALID_CHAINS = new Set(["eth", "robin", "rh", "base", "ethereum", "robinhood"]);
function isChain(token: string): boolean {
  return VALID_CHAINS.has(token.toLowerCase());
}
function chainName(chainKey: string): string {
  return CHAIN_DISPLAY[chainKey] ?? chainKey;
}

// Run a single job in the background and update its persisted status.
async function runJob(token: string, state: BotState, job: MintJob): Promise<void> {
  const slug = job.slug ?? job.targetUrl;
  if (!slug) {
    job.status = "failed";
    job.result = "Job is missing a mint target (slug/url/address). Discard and re-send /mint.";
    saveState(state);
    return;
  }
  if (job.status === "cancelled") return;
  job.status = "running";
  saveState(state);
  if (!job.warned && job.fireTime.trim().toLowerCase() !== "now") {
    try {
      const fireDate = parseFireTime(job.fireTime);
      const warnAt = new Date(fireDate.getTime() - 5 * 60 * 1000);
      const waitMs = warnAt.getTime() - Date.now();
      if (waitMs > 0) {
        await new Promise((r) => setTimeout(r, waitMs));
      }
      if ((job as any).status === "cancelled") return;
      const slug = job.slug ?? job.targetUrl;
      await reply(token, job.chatId, `Reminder: mint for <a href="https://opensea.io/collection/${slug}">${slug}</a> fires in ~5 minutes.`);
      job.warned = true;
      saveState(state);
    } catch (err: any) {
      log("WARN", `Warning schedule failed: ${err?.message ?? err}`);
    }
  }
  try {
    await runHeadless({
      slug,
      chainKey: job.chainKey,
      quantity: job.quantity,
      fireTime: job.fireTime,
    });
    if ((job as any).status === "cancelled") return;
    job.status = "done";
    job.result = "ok";
    await reply(token, job.chatId, "Mint complete.");
  } catch (err: any) {
    if ((job as any).status === "cancelled") return;
    job.status = "failed";
    job.result = err?.message ?? String(err);
    await reply(token, job.chatId, job.result ?? String(err));
  }
  saveState(state);
}

async function handleCancel(
  token: string,
  state: BotState,
  updateId: number,
  chatId: number,
  text: string
): Promise<void> {
  const parts = text.split(/\s+/);
  if (parts.length < 2) {
    await reply(token, chatId, "Usage: /cancel <slug>");
    return;
  }
  const slug = parts[1]?.trim();
  if (!slug) {
    await reply(token, chatId, "Usage: /cancel <slug>");
    return;
  }

  const cancelled: string[] = [];
  for (const job of Object.values(state.jobs)) {
    if (job.chatId !== chatId) continue;
    const jobSlug = job.slug ?? job.targetUrl;
    if (!jobSlug || jobSlug.toLowerCase() !== slug.toLowerCase()) continue;
    if (job.status === "pending" || job.status === "running") {
      job.status = "cancelled";
      job.result = "Cancelled by user";
      cancelled.push(`#${job.updateId}`);
    }
  }

  if (cancelled.length === 0) {
    await reply(token, chatId, `No active job found for "${slug}".`);
    return;
  }

  saveState(state);
  await reply(token, chatId, `Cancelled job(s) ${cancelled.join(", ")} for "${slug}".`);
}

async function handleMint(
  token: string,
  state: BotState,
  updateId: number,
  chatId: number,
  text: string
): Promise<void> {
  // Idempotent: if this exact message was already handled (or replayed after a
  // restart) the job already exists — don't start a second mint.
  if (state.jobs[updateId]) return;

  const parts = text.split(/\s+/);
  if (parts.length < 3) {
    await reply(token, chatId, "Usage: /mint <qty> <slug> [chain: eth|robin|base] [time: now|date]");
    return;
  }
  const [, qtyStr, slug] = parts;
  const chain = isChain(parts[3] ?? "") ? parts[3] : "robin";
  const rest = isChain(parts[3] ?? "") ? parts.slice(4) : parts.slice(3);
  const fireTime = rest.join(" ") || "now";
  const quantity = parseInt(qtyStr, 10);

  if (!Number.isInteger(quantity) || quantity < 1) {
    await reply(token, chatId, "Bad quantity — must be a positive integer.");
    return;
  }

  const job: MintJob = {
    updateId,
    chatId,
    slug,
    chainKey: chain,
    quantity,
    fireTime,
    status: "pending",
  };
  state.jobs[updateId] = job;
  saveState(state);

  const slugLink = `<a href="https://opensea.io/collection/${slug}">${slug}</a>`;
  const timeLabel = fireTime.trim().toLowerCase() === "now"
    ? ""
    : (() => {
        try {
          return ` (time: ${toIST(parseFireTime(fireTime))})`;
        } catch {
          return ` (time: ${fireTime})`;
        }
      })();
  await reply(
    token,
    chatId,
    `Minting ${quantity} ${slugLink} on ${chainName(chain)}${timeLabel}...`,
  );
  // Fire-and-forget: the loop keeps processing the next message immediately.
  void runJob(token, state, job);
}

export async function startBot(): Promise<void> {
  const token = getToken();
  const allowed = allowedChats();
  const state = loadState();

  log("INFO", "Telegram bot started");

  // Resume any job that was pending/running when the bot last died.
  for (const job of Object.values(state.jobs)) {
    if (job.status === "pending" || job.status === "running") {
      const slug = job.slug ?? job.targetUrl;
      log("INFO", `Resuming job ${job.updateId} (${slug ?? "?"}`);
      void runJob(token, state, job);
    }
  }

  while (true) {
    let updates: Update[] = [];
    try {
      const res = (await api(token, `getUpdates?offset=${state.offset}&timeout=30`)) as { result?: Update[] };
      updates = res.result ?? [];
    } catch (err: any) {
      log("WARN", `Telegram poll failed: ${err?.message ?? err}`);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }

    let maxOffset = state.offset;
    for (const u of updates) {
      if (u.update_id >= maxOffset) maxOffset = u.update_id + 1;
      const msg = u.message;
      if (!msg?.text) continue;

      const chatId = msg.chat.id;
      if (allowed.length > 0 && !allowed.includes(String(chatId))) {
        await reply(token, chatId, "Unauthorized.");
        continue;
      }

      if (msg.text.startsWith("/cancel")) {
        await handleCancel(token, state, u.update_id, chatId, msg.text);
      } else if (msg.text.startsWith("/mint")) {
        await handleMint(token, state, u.update_id, chatId, msg.text);
      } else if (msg.text.startsWith("/start")) {
        await reply(token, chatId, "Send: /mint <url> <chain: eth|robin|base> <qty> <time: now|date>");
      }
    }

    if (updates.length > 0) {
      state.offset = maxOffset;
      saveState(state);
    }
  }
}

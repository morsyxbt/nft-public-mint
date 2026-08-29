// Telegram bot that triggers the headless mint path. No extra dependency —
// it talks to the Telegram HTTP API with the built-in fetch.
//
// Usage (chat message):
//   /mint <nft-url> <chain> <qty> <time>
//   /mint https://opensea.io/item/.../0xABC eth 4 now
//   /mint https://opensea.io/items/foo/0xABC robin 2 August 29 at 2:00 AM GMT+7
//
// Chain accepts short aliases to avoid typos: eth | robin | base (full keys too).
// Time is "now" or any date string parseFireTime understands.
//
// Mints run concurrently (fire-and-forget). Every job is persisted to
// bot-state.json with the last seen Telegram update offset, so if the bot
// crashes or is restarted it resumes unfinished jobs and never re-reads an
// already-handled message — you don't have to resend anything.

import fs from "fs";
import path from "path";
import { log } from "./logger";
import { runHeadless } from "./wizard";

const API = "https://api.telegram.org/bot";
const STATE_FILE = path.resolve(process.cwd(), "bot-state.json");

type JobStatus = "pending" | "running" | "done" | "failed";

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

async function reply(token: string, chatId: number, text: string): Promise<void> {
  await api(token, "sendMessage", { chat_id: chatId, text });
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
  job.status = "running";
  saveState(state);
  try {
    await runHeadless({
      slug,
      chainKey: job.chainKey,
      quantity: job.quantity,
      fireTime: job.fireTime,
    });
    job.status = "done";
    job.result = "ok";
    await reply(token, job.chatId, "Mint complete.");
  } catch (err: any) {
    job.status = "failed";
    job.result = err?.message ?? String(err);
    await reply(token, job.chatId, job.result ?? String(err));
  }
  saveState(state);
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
  if (parts.length < 5) {
    await reply(token, chatId, "Usage: /mint <slug> <chain: eth|robin|base> <qty> <time: now|date>");
    return;
  }
  const [, slug, chain, qtyStr, ...rest] = parts;
  const fireTime = rest.join(" ");
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

  await reply(token, chatId, `Minting ${quantity} on ${chain} (time: ${fireTime})...`);
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

      if (msg.text.startsWith("/mint")) {
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

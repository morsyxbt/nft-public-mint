#!/usr/bin/env node

import path from "path";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

import { runWizard } from "./wizard";
import { startBot } from "./telegram";
import { closePrompts } from "./prompt";
import { log } from "./logger";

const HELP = `
NFT Minter

  Mints public SeaDrop stages. Calldata is built from on-chain state, so no
  OpenSea account or access token is required.

Usage
  npm start                run the interactive wizard
  npm start -- --telegram  run the Telegram bot (needs TELEGRAM_BOT_TOKEN)
  npm start -- --help      show this message

Wallets are loaded from wallets.json in the current folder if it exists.
Format: ["0xabc...", "0xdef..."]

Everything else is asked interactively: chain, quantity, NFT link, RPC,
gas and timing. Optional defaults can be set in .env (see .env.example).
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return;
  }
  try {
    if (args.includes("--telegram")) {
      await startBot();
      return;
    }
    await runWizard();
    closePrompts();
    process.exit(0);
  } catch (err: any) {
    closePrompts();
    log("ERROR", err.message);
    process.exit(1);
  }
}

void main();

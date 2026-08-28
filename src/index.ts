#!/usr/bin/env node

import path from "path";
import dotenv from "dotenv";
import chalk from "chalk";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

import { runWizard } from "./wizard";
import { closePrompts } from "./prompt";

const HELP = `
NFT Public Mint Sniper

  Mints public SeaDrop stages. Calldata is built from on-chain state, so no
  OpenSea account or access token is required.

Usage
  npm start              run the interactive wizard
  npm start -- --help    show this message

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
    await runWizard();
    closePrompts();
    process.exit(0);
  } catch (err: any) {
    closePrompts();
    console.error(chalk.red(`\n❌ ${err.message}\n`));
    process.exit(1);
  }
}

void main();

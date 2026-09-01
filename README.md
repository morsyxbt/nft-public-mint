# nft-minter

CLI sniper for public SeaDrop NFT mints. Builds calldata on-chain.

## Install

```bash
git clone https://github.com/morsyxbt/nft-minter.git
cd nft-minter
npm install
npm run build
```

## Run

```bash
npm start
```

Paste private keys (one per line, blank line to finish), pick chain, quantity, NFT link, RPC, gas settings, and timing. Fires immediately — no confirmation prompt.

Optional: pre-configure RPC in `.env` (copy from `.env.example`).

## Telegram bot

```bash
npm start -- --telegram
```

Set `TELEGRAM_BOT_TOKEN` and `ALLOWED_CHAT_ID` in `.env`. Send `/mint <qty> <slug> <chain> <time>`.

```
/mint 4 nft-slug
/mint 4 nft-slug eth now
/mint 2 nft-slug robin August 29 at 2:00 AM GMT+7
/mint 1 0x1234...abcd base now
```

## Supported chains

| Chain | ID |
|---|---|
| Ethereum | 1 |
| Base | 8453 |
| Robinhood Chain | 4663 |

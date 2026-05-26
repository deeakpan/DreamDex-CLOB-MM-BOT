# DreamDEX MM / CLOB Bot

This repo contains a live DreamDEX trading bot and a lower-level runner for interacting with the on-chain CLOB on Somnia.

The current mainnet bot is a single-process `ethers` bot built for the DreamDEX spot CLOB. It trades multiple `USDso` pairs, keeps one signer / nonce stream, uses WebSocket market data when available, falls back to RPC when needed, and tracks per-market cost basis so it does not immediately dump inventory below its last buy price.

## What this repo contains

- `scripts/dreamdex-bot.js`
  The main bot. This is the file that actually runs the multi-market strategy.
- `scripts/dreamdex-runner.js`
  A lower-level utility runner for direct book reads, simulations, and one-off order sends.
- `config/dreamdex.bot.mainnet.json`
  The current live mainnet bot config.
- `config/dreamdex.bot.settings.json`
  A general/default bot config, useful as a template.
- `config/dreamdex.settings.json`
  The lower-level runner config.
- `logs/`
  Runtime logs and bot state written automatically during operation.

## Fresh clone / copied workspace note

If you clone or copy this repo onto another machine, it is usually best to start with a clean `logs/` directory.

Why:

- the bot writes timestamped run logs there
- it also writes a persistent state file used to remember last buy prices per market
- if you reuse someone else's old `logs/`, the bot can load stale cost basis and behave as if it owns inventory from a prior session

Recommended cleanup before first live use:

```powershell
Remove-Item .\logs\* -Force
```

Especially remove:

- `logs/dreamdex-bot-mainnet.persistent-state.json`

That file is useful for continuing the same strategy across restarts, but you generally do not want to inherit it from an old machine or an old contest run.

## Current bot behavior

The current live bot is a cost-aware, taker-style multi-market bot for the DreamDEX CLOB.

It currently trades:

- `SOMI:USDso`
- `WETH:USDso`
- `WBTC:USDso`

High-level behavior:

- watches the live top of book using DreamDEX public WebSocket feeds
- falls back to RPC when no fresh WebSocket snapshot is available
- submits IOC orders when conditions are acceptable
- buys with `USDso`
- stores the last buy price per market
- only sells when the bid is above the stored buy price plus a configured minimum round-trip margin
- skips trades when the spread is wider than configured
- keeps all markets in one process so there are no nonce clashes between separate scripts

This is closer to a contest volume / managed execution bot than a passive maker quote bot, but it is still designed specifically for the DreamDEX CLOB and uses TOB / spread / tick logic directly from the on-chain market.

## Supported networks

### Mainnet

- Chain ID: `5031`
- RPCs:
  - `https://api.infra.mainnet.somnia.network`
  - `https://somnia.publicnode.com`
- REST: `https://api.dreamdex.io`
- WebSocket: `wss://api.dreamdex.io/v0/ws/public`

### Testnet

- Chain ID: `50312`
- RPC: `https://dream-rpc.somnia.network`
- REST: `https://stg.api.dreamdex.io`
- WebSocket: `wss://stg.api.dreamdex.io/v0/ws/public`

## Important docs mismatch

DreamDEX docs currently say `expireTimestampNs = 0` means "no expiry". Your on-chain checks showed that deployed pools reject `0` and simply return `(success=false, orderId=0)` without a revert reason.

Relevant docs:

- [Quick Start](https://docs.dreamdex.io/ld25g222WKDrLlJMcR41/welcome/quick-start)
- [Contracts / Functions](https://docs.dreamdex.io/ld25g222WKDrLlJMcR41/developers/contracts/functions)

This repo protects against that:

- if `expireTimestampNs` is omitted, it generates `now + 3600s`
- if `expireTimestampNs` is explicitly `0`, it throws before sending

## Setup

Dependencies are already in `package.json`:

- `ethers`
- `dotenv`
- `ws`

Install:

```powershell
npm install
```

Create a local `.env`:

```dotenv
PRIVATE_KEY=your_private_key_here
```

The scripts accept either:

- `0x...`
- or raw hex without `0x`

and normalize the key internally.

### Optional Supabase state backend

If you want the bot to remember cost basis across Railway restarts / redeploys, set:

```dotenv
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
SUPABASE_STATE_TABLE=dreamdex_bot_state
BOT_STATE_ID=mainnet-mm-bot
```

Only `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are required.

Defaults if not provided:

- table: `dreamdex_bot_state`
- bot id: `<network>:<walletAddress>`

The bot will:

- read the latest state from Supabase on startup
- write that state into the local persistent JSON file
- continue using local file + in-memory state while running
- push updated state back to Supabase after state-changing trades

That means you do not hit Supabase constantly on every internal read, but Railway still has a durable source of truth.

## Commands

### Main bot

Run default bot config:

```powershell
npm run dreamdex:bot
```

Run one cycle only:

```powershell
npm run dreamdex:bot:once
```

Run live mainnet bot:

```powershell
npm run dreamdex:bot:mainnet
```

On Railway / most Node hosts, `npm start` now runs the same live mainnet bot entrypoint:

```powershell
npm start
```

Run one live mainnet cycle:

```powershell
npm run dreamdex:bot:mainnet:once
```

Push the current local persistent bot state to Supabase:

```powershell
npm run dreamdex:state:push:mainnet
```

That command uses `config/dreamdex.bot.mainnet.json`, so it pushes:

- network: `mainnet`
- local file: `logs/dreamdex-bot-mainnet.persistent-state.json`

Use the default push command only if you intentionally want whatever network is set in `config/dreamdex.bot.settings.json`.

Right now, that default config is `testnet`, so this command targets testnet state:

```powershell
npm run dreamdex:state:push
```

### Lower-level runner

Default runner:

```powershell
npm run dreamdex:run
```

Runner on mainnet:

```powershell
npm run dreamdex:run:mainnet
```

Runner on testnet:

```powershell
npm run dreamdex:run:testnet
```

Direct invocation example:

```powershell
node scripts/dreamdex-runner.js --config config/dreamdex.settings.json --network testnet
```

## Current mainnet config

Current live file:

```text
config/dreamdex.bot.mainnet.json
```

It currently enables `takerVolume` for:

- `SOMI:USDso`
- `WETH:USDso`
- `WBTC:USDso`

With current per-market sizes:

- `SOMI:USDso`: `10 SOMI`
- `WETH:USDso`: `0.001 WETH`
- `WBTC:USDso`: `0.0001 WBTC`

These quantities were chosen to satisfy each market's live `minQuantity` / `lotSize`.

## What the bot logs mean

Examples you will see in the console:

- `IOC book SOMI:USDso: bid=... ask=... spreadBps=...`
  Snapshot of current top bid / ask.

- `IOC side WETH:USDso: bid`
  The bot decided the next action should be a buy.

- `IOC sent WBTC:USDso ask: price=... qty=...`
  A live IOC sell was actually broadcast.

- `IOC skipped SOMI:USDso: spreadBps=12 max=10`
  The market spread was too wide, so the bot skipped the trade.

- `IOC hold WETH:USDso: bid=... min=...`
  The bot has inventory, but the current bid is below the minimum profitable exit price.

- `Cost loaded WETH:USDso: lastBuy=...`
  The bot loaded cost basis from persistent state on startup.

- `Cost updated WETH:USDso: lastBuy=...`
  The bot bought again and updated stored cost basis.

- `Cost cleared WETH:USDso`
  Inventory is gone, so old cost basis was removed.

- `Approval sent ...`
  ERC-20 approval tx was sent for wallet-funded trading.

## Approval behavior

The bot now uses "approve once" behavior instead of approving tiny exact values every cycle.

Default behavior:

- if allowance is already high enough, do nothing
- if allowance is too low, approve a large allowance once
- then reuse that allowance for later trades

This reduces approval spam and wasted gas.

Optional config override:

- `bot.approvalAmount`

If set, the bot will approve that amount instead of using max allowance.

## Persistent state

The bot writes:

- per-run state:
  - `logs/dreamdex-bot-<network>-<timestamp>.state.json`
- persistent cross-restart state:
  - `logs/dreamdex-bot-mainnet.persistent-state.json`
  - `logs/dreamdex-bot-testnet.persistent-state.json`

Persistent state is used for:

- `lastInventoryBuyPrice`
- last taker-side memory
- last taker price / timing context

This is what lets the bot restart without forgetting its per-market cost basis.

### Supabase + local JSON flow

Current behavior with Supabase enabled:

1. On startup, the bot reads state from Supabase.
2. It writes that downloaded state into the local persistent JSON file.
3. During runtime, the bot uses in-memory state and the local JSON snapshot.
4. After state-changing trades, the bot updates:
   - the per-run state JSON
   - the local persistent JSON
   - the Supabase row

So in real words:

- Supabase is the durable cloud memory
- the local JSON file is the fast local cache
- the running process uses memory, not repeated Supabase reads

If Supabase is not configured, the bot simply falls back to local file state only.

## Supabase table

Recommended table:

```sql
create table if not exists public.dreamdex_bot_state (
  bot_id text primary key,
  network text not null,
  wallet_address text not null,
  state jsonb not null,
  updated_at timestamptz not null default now()
);
```

The bot stores one row per bot deployment / identity.

Default row key:

- `<network>:<walletAddress>`

You can override that with:

- `BOT_STATE_ID`

That is useful if you want multiple Railway services or environments using separate state rows.

## Syncing current state into Supabase

If you already have a good local persistent state file and want to upload it into Supabase, use:

```powershell
npm run dreamdex:state:push:mainnet
```

This reads the current local persistent JSON file and upserts it into Supabase.

Useful cases:

- first time moving the bot from local machine to Railway
- manually reseeding Supabase after clearing a project
- copying current local cost basis into the remote store

## Main config fields

### `defaults`

- `expireSecondsFromNow`
  Default order expiration when none is provided.
- `confirmations`
  How many confirmations to wait for after tx broadcast.
- `logDir`
  Where logs and state files are written.
- `dryRun`
  If `true`, the bot simulates behavior and logs intent without trading.

### `bot`

- `pollIntervalMs`
  Base polling cadence.
- `wsStaleAfterMs`
  When WebSocket data is considered stale.
- `wsReconnectDelayMs`
  Delay before reconnecting WebSocket.
- `wsPingEveryMs`
  Ping interval for feed health.
- `wsInitialDataTimeoutMs`
  How long to wait for first WS data before using RPC fallback.
- `nativeGasReserveWei`
  Native SOMI kept aside for gas instead of trading.
- `cancelAllOrdersOnStart`
  Cancel open orders for active markets on startup.
- `cancelManagedOrdersOnExit`
  Cleanup mode for active strategies on shutdown.
- `approvalAmount`
  Optional custom approval size for ERC-20 approvals.

### `strategies[]`

For current `takerVolume` markets:

- `type`
  Currently `takerVolume`.
- `market`
  Market symbol like `SOMI:USDso`.
- `quantity`
  Order size in raw token units.
- `crossTicks`
  How aggressively to cross beyond the opposite TOB.
- `maxSpreadBps`
  Maximum spread tolerated before skipping.
- `minRoundTripBps`
  Minimum margin above stored cost basis before selling inventory.
- `placeBid`
  Allow buy-side behavior.
- `placeAsk`
  Allow sell-side behavior.
- `autoFund`
  Whether the bot should deposit into vault automatically.
- `orderType`
  Current strategy uses `ioc`.
- `selfMatchingOption`
  Current strategy uses `cancelTaker`.
- `dryRun`
  Per-strategy dry-run override.

## Why some funds may be in wallet vs vault

The bot can use both wallet-funded and vault-funded paths depending on the market / side / available balances.

Common cases:

- wallet-funded IOC buy:
  Bot uses wallet `USDso` plus approval
- wallet-funded native sell:
  Bot can use native `SOMI` directly
- vault-funded sell:
  If base inventory is already in the DreamDEX vault, the bot can sell from vault

That is why your balances can be split across:

- wallet
- `SOMI:USDso` vault
- other pool vaults

## Lower-level runner

`scripts/dreamdex-runner.js` still exists for one-off operations:

- read books
- simulate orders
- send orders manually

It supports:

- `book`
- `simulateOrder`
- `sendOrder`

and can use:

- wallet funding
- vault funding

The runner is useful when you want to test a specific call without running the full bot.

## Built-in markets

The scripts know these built-in markets:

- Mainnet:
  - `SOMI:USDso`
  - `USDC.e:USDso`
  - `WBTC:USDso`
  - `WETH:USDso`
- Testnet:
  - `SOMI:USDso`
  - `WBTC:USDso`
  - `WETH:USDso`
  - `SOMI:SOMUSD`
  - `WBTC:SOMUSD`
  - `WETH:SOMUSD`

You can override or add markets through the top-level `markets` config object if DreamDEX adds more pools or you want to point to different addresses.

## Operational notes

- Treat this as a live trading bot when `dryRun = false`.
- DreamDEX spot is the current contest focus.
- `getBookLevels(...)` and TOB matter; all pricing is book-aware.
- Wallet funding is the intended path for IOC / FOK taker flow.
- Vault balances can remain parked in pools even when no strategy is active there.
- `SOMI:USDso` is a native-base market, so some paths use native token handling instead of ERC-20 base transfers.
- Builder values should remain zero / `address(0)` unless you intentionally integrate builder codes.

## Suggested operator workflow

1. Put `PRIVATE_KEY` in `.env`
2. Delete stale `logs/` if this is a fresh clone or copied workspace
3. Confirm the config you want
4. Run `npm run dreamdex:bot:mainnet:once` first
5. Check balances / logs
6. Run `npm run dreamdex:bot:mainnet` continuously when satisfied

## Safety reminder

This repo can send real on-chain transactions on DreamDEX mainnet.

Before running live:

- confirm `dryRun`
- confirm active markets
- confirm order sizes
- confirm vault balances and wallet balances
- confirm you are okay with IOC taker flow and current spread thresholds


# DreamDEX Mainnet — Fresh Test Report

| Field | Value |
|-------|-------|
| Participant wallet | `0xd14ADbA293e70B60b70dE2f643bb696A84330C3E` |
| Network | Somnia mainnet (chain `5031`) |
| Test start | June 2026 (fresh wallet, cleared local + Supabase state) |
| Active market | `SOMI:USDso` only |

---

## Executive summary

Fresh mainnet run with a new wallet and reset bot state. Core CLOB access works (WS book, RPC, vault deposits, vault-funded IOCs). The main integrator blocker we hit is that **`placeTakerOrderWithoutVault` reverts on every attempt** for this wallet/pool, while **`placeOrder` from vault balances succeeds**. We switched the volume mill to vault funding and confirmed a live IOC buy.

---

## Bot configuration (this run)

| Setting | Value |
|---------|-------|
| Strategy | Volume mill IOC ping-pong |
| `sizePerCycleUsd` | $22.00 |
| `maxInventoryImbalanceUsd` | $22.00 |
| `minRoundTripBps` | 2 (sell only when bid ≥ buy + 2 bps) |
| `quoteReserveUsd` | $80 (wallet USDso never spent below this) |
| `nativeBaseReserve` | 8 SOMI (never sold from wallet) |
| `nativeGasReserveWei` | 2 SOMI (gas buffer) |
| `fundingSource` | **`vault`** (not wallet) |
| Poll interval | 2s |
| State backend | Supabase (`BOT_STATE_ID=mainnet-mm-bot`) + local JSON |

**Pairs:** `SOMI:USDso` enabled. `WETH:USDso` and `WBTC:USDso` disabled.

---

## Findings

### F1. `placeTakerOrderWithoutVault` reverts; vault `placeOrder` works (High)

**Severity:** High — blocks wallet-only taker integrations  
**Status:** Reproduced 2026-06-24 on fresh wallet

**What we tested** (`SOMI:USDso` pool `0x035De7403eac6872787779CCA7CCF1b4CDb61379`):

| Path | Method | Result |
|------|--------|--------|
| Wallet IOC buy | `placeTakerOrderWithoutVault` (bid, 1–100 SOMI, at/near best ask) | **`staticCall` reverts** — opaque `require(false)`, no revert data |
| Wallet IOC sell | `placeTakerOrderWithoutVault` (ask + `{ value: quantity }`) | **Same revert** |
| Vault IOC buy | Deposit USDso → `placeOrder` (IOC) | **`success = true`**, order ID returned |
| Vault IOC sell | Deposit native SOMI → `placeOrder` (IOC) | **`success = true`**, order ID returned |

Wallet had ~$150 USDso, max allowance to pool, and ~50 SOMI native. Reverts were **not** balance-related.

**Bot symptom before fix:**

```text
Strategy error SOMI:USDso: execution reverted (no data present; likely require(false) occurred
```

**After switching to vault funding:**

```text
IOC sent SOMI:USDso bid: price=101600000000000000 qty=216530000000000000000
Cost updated SOMI:USDso: lastBuy=101600000000000000
```

**Workaround:** Fund pool vault from wallet (respecting reserves), then use `placeOrder` with `orderType = IOC (2)`.

**Ask:** Document when wallet taker path is supported vs vault-only; return named reverts instead of bare `require(false)`.

---

### F2. `expireTimestampNs = 0` is not “no expiry” (High)

**Severity:** High (correctness)  
**Status:** Confirmed on prior runs; still guarded in bot

Docs imply `0` means no expiration. Deployed pools reject it — `(success=false, orderId=0)` or revert.

**Our guard:**

```javascript
const expireTimestampNs = BigInt(Math.floor(Date.now() / 1000) + 3600) * 1_000_000_000n;
if (expireTimestampNs === 0n) throw new Error('expireTimestampNs = 0 is not allowed');
```

**Ask:** Align docs with on-chain behavior or implement documented no-expiry semantics.

---

### F3. Native SOMI vault balance uses pool base token, not `address(0)` (High)

**Severity:** High (funds appear missing in vault UI)

For `SOMI:USDso`, native vault balance is keyed by `markets[].base` (`0x28f34DeFd2b4CB48d9eE6d89f2Be4Bc601694c00`), not `address(0)`.

**Ask:** Document native sentinel in vault/withdraw docs.

---

### F4. REST orderbook URL (Medium)

**Works:**

```http
GET /v0/orderbooks?symbols=SOMI:USDso
```

**404:**

```http
GET /v0/markets/SOMI:USDso/orderbook
GET /v0/orderbooks/SOMI:USDso
```

Top of book from REST matched on-chain `getBookLevels(1)` when checked.

---

### F5. RPC reliability (Medium)

Default RPCs (`api.infra.mainnet.somnia.network`, `somnia.publicnode.com`) intermittently **timeout** from some networks. `somnia-rpc.publicnode.com` was more reliable in our tests.

**Config change:** 30s timeout, `somnia-rpc.publicnode.com` first in fallback list.

---

### F6. Fill observability — use simulation + balances (Medium)

Do not rely on events alone. We gate sends on `staticCall` and log `IOC sent` vs simulation rejection. Vault/wallet balance deltas are the source of truth for fills.

---

## Methods exercised (this run)

| Vector | Description |
|--------|-------------|
| Vault-funded volume mill | Deposit USDso/SOMI to vault per cycle → `placeOrder` IOC |
| Cost-aware sells | `lastInventoryBuyPrice` + `minRoundTripBps: 2` |
| Reserve caps | $80 USDso + 8 SOMI + 2 SOMI gas left in wallet |
| WS + RPC book | Public WS with RPC `getBookLevels` fallback |
| Supabase state | `dreamdex_bot_state` row `mainnet-mm-bot` |
| State reset | Cleared local logs + fresh persistent state for new wallet |

---

## Starting wallet snapshot (approx.)

| Asset | Amount |
|-------|--------|
| USDso (wallet) | ~$150 |
| SOMI (native) | ~50 |
| Vault USDso | ~$25 (from test deposits during debugging) |
| Vault SOMI | ~1 (from test deposits during debugging) |

---

## Appendix — Mainnet addresses

| Pair | SpotPool | StopRegistry |
|------|----------|--------------|
| SOMI:USDso | `0x035De7403eac6872787779CCA7CCF1b4CDb61379` | `0x68c8f6fb1EA19A28F25358Ff00b8Ed8E1216df30` |
| WETH:USDso | `0xa936da11B57b50A344e1293AAaE5232885ea2bDE` | `0x9653a7355849B7691802A6AA49fDe18eF5ba633d` |
| WBTC:USDso | `0x25bfF6B7B5E2243424F38E75de7ab03C0522a5EA` | `0xed32F048D6a47923D38eCeD868d6f8b0eB4852bd` |

**USDso (quote):** `0x00000022dA000002656c64D9eA6011ea952D008A`  
**SOMI base marker:** `0x28f34DeFd2b4CB48d9eE6d89f2Be4Bc601694c00`

Canonical source: `GET https://api.dreamdex.io/v0/markets`

---

## Appendix — Vault IOC snippet (working path)

```javascript
// 1. Deposit quote/base to vault (respect wallet reserves off-chain)
await pool.deposit(quoteToken, amount);
// native SOMI: await pool.depositNative({ value: amount });

// 2. IOC from vault
const expireTimestampNs = BigInt(Math.floor(Date.now() / 1000) + 3600) * 1_000_000_000n;
const [success, orderId] = await pool.placeOrder.staticCall(
  isBid, 0n, price, quantity, expireTimestampNs,
  2, // IOC
  0, ethers.ZeroAddress, 0n
);
if (!success) return;
await pool.placeOrder(isBid, 0n, price, quantity, expireTimestampNs, 2, 0, ethers.ZeroAddress, 0n);
```

---

## Recommendations

1. **Fix or document wallet taker path** (`placeTakerOrderWithoutVault`) vs vault requirement (F1).
2. Fix or document **`expireTimestampNs = 0`** (F2).
3. Document **native vault sentinel** for SOMI (F3).
4. Document **`GET /v0/orderbooks?symbols=`** (F4).
5. Improve **revert reasons** on failed orders (opaque `require(false)` today).

---

## Repo artifacts

| File | Purpose |
|------|---------|
| `scripts/dreamdex-bot.js` | Main bot (vault volume mill) |
| `config/dreamdex.bot.mainnet.json` | Live config |
| `scripts/dreamdex-reconcile-to-quote.js` | Flatten to USDso |
| `scripts/dreamdex-clear-state.js` | Reset Supabase + local state |

---

Report from **dreamdex-contest** • Wallet `0xd14ADbA293e70B60b70dE2f643bb696A84330C3E` • Somnia mainnet `5031`

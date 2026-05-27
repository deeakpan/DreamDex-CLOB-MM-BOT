#!/usr/bin/env node
/**
 * Compares stored `lastInventoryBuyPrice` vs current best bid (the IOC sell-now price)
 * for SOMI:USDso, WETH:USDso, WBTC:USDso.
 *
 * This answers: "is the bot selling at a loss?"
 * - With minRoundTripBps=0, it should only sell at/above stored basis (after tick rounding),
 *   unless stale-cost-basis reset triggers (which re-anchors internal basis to the new regime).
 */

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

const SPOT_POOL_ABI = [
  'function getBookLevels(bool isBid, uint64 numLevels) view returns (tuple(uint256 price, uint256 quantity)[] levels)',
  'function getPoolParams() view returns (address baseToken_, address quoteToken_, uint256 makerFeeBpsTimes1k_, uint256 takerFeeBpsTimes1k_, uint256 tickSize_, uint256 minQuantity_, uint256 lotSize_)',
];

function ceilDiv(a, b) {
  return (a + b - 1n) / b;
}

function alignToTick(value, tickSize, direction) {
  if (tickSize <= 0n) {
    return value;
  }
  if (direction === 'down') {
    return (value / tickSize) * tickSize;
  }
  return ceilDiv(value, tickSize) * tickSize;
}

function computeBps(numerator, denominator) {
  if (denominator === 0n) {
    return 0n;
  }
  return (numerator * 10_000n) / denominator;
}

function computeIocTargetPrice(sideLabel, bestBid, bestAsk, tickSize, crossTicks) {
  const ct = BigInt(crossTicks || 0);
  if (sideLabel === 'bid') {
    return alignToTick(bestAsk + tickSize * ct, tickSize, 'up');
  }
  const rawTarget = bestBid > tickSize * ct ? bestBid - tickSize * ct : bestBid;
  return alignToTick(rawTarget, tickSize, 'down');
}

async function createProvider() {
  const rpcUrls = ['https://api.infra.mainnet.somnia.network', 'https://somnia.publicnode.com'];
  let lastError = null;
  for (const url of rpcUrls) {
    try {
      const provider = new ethers.JsonRpcProvider(url, undefined, { staticNetwork: true });
      await Promise.race([
        provider.getBlockNumber(),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout for ${url}`)), 10_000)),
      ]);
      return provider;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error('No RPC available');
}

async function main() {
  const statePath = path.resolve('logs', 'dreamdex-bot-mainnet.persistent-state.json');
  if (!fs.existsSync(statePath)) {
    throw new Error(`Missing state file: ${statePath}`);
  }

  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const stratByMarket = {};
  for (const s of state.strategies) {
    stratByMarket[s.market] = s;
  }

  // Pool addresses in scripts/dreamdex-bot.js (mainnet default markets).
  const pools = {
    'SOMI:USDso': '0x035De7403eac6872787779CCA7CCF1b4CDb61379',
    'WETH:USDso': '0xa936da11B57b50A344e1293AAaE5232885ea2bDE',
    'WBTC:USDso': '0x25bfF6B7B5E2243424F38E75de7ab03C0522a5EA',
  };

  // Use current config behavior: minRoundTripBps=0 for all three markets.
  const minRoundTripBps = 0n;
  const crossTicks = 0n;

  const provider = await createProvider();

  const rows = [];
  for (const [market, poolAddr] of Object.entries(pools)) {
    const pool = new ethers.Contract(poolAddr, SPOT_POOL_ABI, provider);
    const { tickSize_ } = await pool.getPoolParams();
    const tickSize = BigInt(tickSize_);

    const bids = await pool.getBookLevels(true, 1);
    const asks = await pool.getBookLevels(false, 1);

    // ethers v6 may return either { levels: [...] } or the raw tuple array.
    const bidLevels = bids?.levels ? bids.levels : bids;
    const askLevels = asks?.levels ? asks.levels : asks;

    const bestBid =
      Array.isArray(bidLevels) && bidLevels.length
        ? BigInt(bidLevels[0].price ?? bidLevels[0][0])
        : 0n;
    const bestAsk =
      Array.isArray(askLevels) && askLevels.length
        ? BigInt(askLevels[0].price ?? askLevels[0][0])
        : 0n;

    const sellPrice = computeIocTargetPrice('ask', bestBid, bestAsk, tickSize, crossTicks); // IOC sell-now price

    const lastBuyStr = stratByMarket[market]?.lastInventoryBuyPrice ?? null;
    const lastBuy = lastBuyStr === null ? null : BigInt(lastBuyStr);

    // With minRoundTripBps=0, minimum sell is just the stored basis (tick-aligned up).
    const minimumSell = lastBuy === null ? null : alignToTick(lastBuy, tickSize, 'up');
    const canSell = minimumSell === null ? true : sellPrice >= minimumSell;

    const diffBps =
      minimumSell !== null && sellPrice < minimumSell
        ? computeBps(minimumSell - sellPrice, minimumSell)
        : null;

    rows.push({
      market,
      tickSize: tickSize.toString(),
      bestBid: bestBid.toString(),
      bestAsk: bestAsk.toString(),
      sellPrice: sellPrice.toString(),
      lastInventoryBuyPrice: lastBuy === null ? null : lastBuy.toString(),
      minimumSellPrice: minimumSell === null ? null : minimumSell.toString(),
      canSellByCostGuard: canSell,
      belowCostGuardByBps: diffBps === null ? null : diffBps.toString(),
      minRoundTripBps: minRoundTripBps.toString(),
    });
  }

  console.log(JSON.stringify({ statePath, rows }, null, 2));
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : String(e));
  process.exitCode = 1;
});


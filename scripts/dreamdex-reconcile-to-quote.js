#!/usr/bin/env node

/**
 * Full flatten to wallet USDso:
 *   1. Cancel open orders on each market pool
 *   2. Withdraw all vault balances (quote + base) to wallet
 *   3. IOC-sell wallet base into USDso (SOMI: keeps `somiReserve` native in wallet)
 *
 * Usage:
 *   node scripts/dreamdex-reconcile-to-quote.js --config config/dreamdex.bot.mainnet.json
 *   node scripts/dreamdex-reconcile-to-quote.js --config config/dreamdex.bot.mainnet.json --dry-run
 *   node scripts/dreamdex-reconcile-to-quote.js --skip-sell   # cancel + withdraw only
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });
const { ethers } = require('ethers');

const DEFAULT_MARKETS = {
  mainnet: {
    'SOMI:USDso': {
      symbol: 'SOMI:USDso',
      pool: '0x035De7403eac6872787779CCA7CCF1b4CDb61379',
      isNativeBase: true,
    },
    'WETH:USDso': {
      symbol: 'WETH:USDso',
      pool: '0xa936da11B57b50A344e1293AAaE5232885ea2bDE',
      isNativeBase: false,
    },
    'WBTC:USDso': {
      symbol: 'WBTC:USDso',
      pool: '0x25bfF6B7B5E2243424F38E75de7ab03C0522a5EA',
      isNativeBase: false,
    },
  },
};

const SPOT_POOL_ABI = [
  'function getBookLevels(bool isBid, uint64 numLevels) view returns (tuple(uint256 price, uint256 quantity)[] levels)',
  'function getPoolParams() view returns (address baseToken_, address quoteToken_, uint256 makerFeeBpsTimes1k_, uint256 takerFeeBpsTimes1k_, uint256 tickSize_, uint256 minQuantity_, uint256 lotSize_)',
  'function getWithdrawableBalance(address owner, address token) view returns (uint256)',
  'function getOwnOpenOrders() view returns (uint128[] memory)',
  'function cancelOrder(uint128 orderId)',
  'function withdraw(address token, uint256 amount)',
  'function withdrawNative(uint256 amount)',
  'function placeOrder(bool isBid, uint64 userData, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k) returns (bool success, uint128 orderId)',
  'function placeTakerOrderWithoutVault(bool isBid, uint64 userData, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k) payable returns (bool success, uint128 orderId)',
  'function convertToQuoteAtPriceCeil(uint256 baseQuantity, uint256 priceQuote) view returns (uint256)',
];

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function symbol() view returns (string)',
];

const ORDER_TYPES = { ioc: 2 };
const SELF_MATCHING = { cancelTaker: 0 };
const ZERO_ADDRESS = ethers.ZeroAddress;
const MAX_UINT256 = (1n << 256n) - 1n;

function parseCli(argv) {
  const result = {
    configPath: 'config/dreamdex.bot.mainnet.json',
    dryRun: false,
    skipSell: false,
    somiReserve: '8',
    crossBps: 5,
    markets: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--config') {
      result.configPath = argv[i + 1];
      i += 1;
    } else if (arg === '--dry-run') {
      result.dryRun = true;
    } else if (arg === '--skip-sell') {
      result.skipSell = true;
    } else if (arg === '--somi-reserve') {
      result.somiReserve = argv[i + 1];
      i += 1;
    } else if (arg === '--markets') {
      result.markets = argv[i + 1].split(',').map((s) => s.trim());
      i += 1;
    }
  }
  return result;
}

function normalizePrivateKey(input) {
  if (!input) return null;
  const trimmed = String(input).trim().replace(/^['"]|['"]$/g, '');
  if (!trimmed) return null;
  return trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
}

function alignToTick(value, tickSize, direction) {
  if (tickSize <= 0n) return value;
  if (direction === 'down') return (value / tickSize) * tickSize;
  return ((value + tickSize - 1n) / tickSize) * tickSize;
}

function alignToLot(value, lotSize) {
  if (lotSize <= 0n) return value;
  return (value / lotSize) * lotSize;
}

function sellCrossPrice(bestBid, tickSize, crossBps) {
  const raw = (bestBid * (10_000n - BigInt(crossBps))) / 10_000n;
  return alignToTick(raw, tickSize, 'down');
}

function fmt(amount, decimals, symbol) {
  return `${ethers.formatUnits(amount, decimals)} ${symbol}`;
}

async function createProvider(networkConfig) {
  const urls = networkConfig.rpcUrls || [networkConfig.rpcUrl];
  let lastError = null;
  for (const url of urls) {
    try {
      const provider = new ethers.JsonRpcProvider(url, networkConfig.chainId, { staticNetwork: true });
      await provider.getBlockNumber();
      return provider;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('No RPC available');
}

async function getMarketContext(provider, signer, networkName, symbol) {
  const market = DEFAULT_MARKETS[networkName][symbol];
  if (!market) throw new Error(`Unknown market: ${symbol}`);
  const poolRead = new ethers.Contract(market.pool, SPOT_POOL_ABI, provider);
  const poolWrite = poolRead.connect(signer);
  const params = await poolRead.getPoolParams();
  const baseToken = params[0];
  const quoteToken = params[1];
  const tickSize = params[4];
  const minQuantity = params[5];
  const lotSize = params[6];
  const baseTokenContract = new ethers.Contract(baseToken, ERC20_ABI, provider);
  const quoteTokenContract = new ethers.Contract(quoteToken, ERC20_ABI, provider);
  const [baseDecimals, quoteDecimals, baseSymbol, quoteSymbol] = await Promise.all([
    market.isNativeBase ? Promise.resolve(18) : baseTokenContract.decimals(),
    quoteTokenContract.decimals(),
    market.isNativeBase ? Promise.resolve('SOMI') : baseTokenContract.symbol(),
    quoteTokenContract.symbol(),
  ]);
  return {
    market,
    poolRead,
    poolWrite,
    baseToken,
    quoteToken,
    baseTokenContract,
    quoteTokenContract,
    tickSize,
    minQuantity,
    lotSize,
    baseDecimals,
    quoteDecimals,
    baseSymbol,
    quoteSymbol,
  };
}

async function getTopOfBook(poolRead) {
  const [bids, asks] = await Promise.all([
    poolRead.getBookLevels(true, 1),
    poolRead.getBookLevels(false, 1),
  ]);
  return {
    bestBid: bids[0] ? bids[0].price : 0n,
    bestAsk: asks[0] ? asks[0].price : 0n,
  };
}

async function cancelAllOrders(poolWrite, poolRead, symbol, dryRun) {
  const ids = await poolRead.getOwnOpenOrders();
  if (ids.length === 0) {
    return 0;
  }
  if (dryRun) {
    console.log(`  [dry-run] would cancel ${ids.length} order(s) on ${symbol}`);
    return ids.length;
  }
  for (const orderId of ids) {
    const tx = await poolWrite.cancelOrder(orderId);
    await tx.wait(1);
    console.log(`  cancelled order ${orderId} (${symbol})`);
  }
  return ids.length;
}

async function withdrawVault(ctx, { token, amount, label, isNativeBase, dryRun }) {
  if (amount <= 0n) {
    return false;
  }
  if (dryRun) {
    console.log(`  [dry-run] would withdraw ${label}: ${amount.toString()}`);
    return true;
  }
  let tx;
  if (isNativeBase && label.startsWith('base')) {
    tx = await ctx.poolWrite.withdrawNative(amount);
  } else {
    tx = await ctx.poolWrite.withdraw(token, amount);
  }
  const receipt = await tx.wait(1);
  console.log(`  withdrew ${label} tx=${receipt.hash}`);
  return true;
}

async function withdrawAllVaultBalances(mc, owner, dryRun) {
  const ctx = {
    poolRead: mc.poolRead,
    poolWrite: mc.poolWrite,
    market: mc.market,
  };
  const [quoteVault, baseVault] = await Promise.all([
    mc.poolRead.getWithdrawableBalance(owner, mc.quoteToken),
    mc.poolRead.getWithdrawableBalance(owner, mc.baseToken),
  ]);

  if (quoteVault > 0n) {
    await withdrawVault(ctx, {
      token: mc.quoteToken,
      amount: quoteVault,
      label: `quote ${fmt(quoteVault, mc.quoteDecimals, mc.quoteSymbol)}`,
      isNativeBase: false,
      dryRun,
    });
  }

  if (baseVault > 0n) {
    if (mc.market.isNativeBase) {
      await withdrawVault(ctx, {
        token: mc.baseToken,
        amount: baseVault,
        label: `base ${fmt(baseVault, mc.baseDecimals, mc.baseSymbol)}`,
        isNativeBase: true,
        dryRun,
      });
    } else {
      await withdrawVault(ctx, {
        token: mc.baseToken,
        amount: baseVault,
        label: `base ${fmt(baseVault, mc.baseDecimals, mc.baseSymbol)}`,
        isNativeBase: false,
        dryRun,
      });
    }
  }

  return { quoteVault, baseVault };
}

async function ensureApproval(signer, tokenContract, spender, amount, dryRun) {
  const owner = await signer.getAddress();
  const allowance = await tokenContract.allowance(owner, spender);
  if (allowance >= amount) return;
  if (dryRun) {
    console.log(`  [dry-run] would approve ${spender}`);
    return;
  }
  const tx = await tokenContract.connect(signer).approve(spender, MAX_UINT256);
  await tx.wait(1);
  console.log(`  approved ${spender}`);
}

function buildIocSellArgs(price, quantity) {
  const expireTimestampNs = BigInt(Math.floor(Date.now() / 1000) + 3600) * 1_000_000_000n;
  return [
    false,
    0n,
    price,
    quantity,
    expireTimestampNs,
    ORDER_TYPES.ioc,
    SELF_MATCHING.cancelTaker,
    ZERO_ADDRESS,
    0n,
  ];
}

async function sellWalletBase(ctx, { quantity, price, dryRun }) {
  if (quantity < ctx.minQuantity) {
    console.log(`  skip sell: qty ${quantity} below min ${ctx.minQuantity}`);
    return null;
  }
  const args = buildIocSellArgs(price, quantity);
  const overrides = ctx.market.isNativeBase ? { value: quantity } : {};

  if (!ctx.market.isNativeBase) {
    await ensureApproval(ctx.signer, ctx.baseTokenContract, ctx.market.pool, quantity, dryRun);
  }

  const ok = await ctx.poolWrite.placeTakerOrderWithoutVault.staticCall(...args, overrides);
  if (!ok[0]) {
    console.log(`  sell simulation rejected (qty=${quantity})`);
    return null;
  }
  if (dryRun) {
    console.log(`  [dry-run] would IOC sell ${quantity} @ ${price} from wallet`);
    return { dryRun: true };
  }
  const tx = await ctx.poolWrite.placeTakerOrderWithoutVault(...args, overrides);
  const receipt = await tx.wait(1);
  console.log(`  sold ${quantity} @ ${price} (wallet) tx=${receipt.hash}`);
  return receipt;
}

async function reconcileMarket(mc, signer, options) {
  const { symbol, somiReserveWei, dryRun, skipSell, crossBps } = options;
  console.log(`\n${symbol}`);
  const owner = await signer.getAddress();

  const cancelled = await cancelAllOrders(mc.poolWrite, mc.poolRead, symbol, dryRun);
  if (cancelled === 0) {
    console.log('  no open orders');
  }

  const { quoteVault, baseVault } = await withdrawAllVaultBalances(mc, owner, dryRun);
  if (quoteVault === 0n && baseVault === 0n) {
    console.log('  vault already empty');
  }

  if (skipSell) {
    return;
  }

  const top = await getTopOfBook(mc.poolRead);
  if (top.bestBid === 0n) {
    console.log('  skip sell: no bid');
    return;
  }

  const sellPrice = sellCrossPrice(top.bestBid, mc.tickSize, crossBps);
  const [nativeBalance, erc20Wallet] = await Promise.all([
    mc.market.isNativeBase ? signer.provider.getBalance(owner) : 0n,
    mc.market.isNativeBase ? 0n : mc.baseTokenContract.balanceOf(owner),
  ]);

  let walletQty = mc.market.isNativeBase ? nativeBalance : erc20Wallet;
  if (mc.market.isNativeBase && symbol === 'SOMI:USDso') {
    walletQty = walletQty > somiReserveWei ? walletQty - somiReserveWei : 0n;
  }
  walletQty = alignToLot(walletQty, mc.lotSize);

  if (walletQty >= mc.minQuantity) {
    await sellWalletBase(
      {
        market: mc.market,
        poolWrite: mc.poolWrite,
        baseTokenContract: mc.baseTokenContract,
        minQuantity: mc.minQuantity,
        signer,
      },
      { quantity: walletQty, price: sellPrice, dryRun }
    );
  } else {
    console.log(`  nothing to sell from wallet (qty=${walletQty})`);
  }
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  const configPath = path.resolve(cli.configPath);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const networkName = config.network || 'mainnet';
  const networkConfig = {
    chainId: 5031,
    ...((config.networks && config.networks[networkName]) || {}),
  };
  const privateKey = normalizePrivateKey(process.env[config.wallet?.privateKeyEnvVar || 'PRIVATE_KEY']);
  if (!privateKey) throw new Error('Missing PRIVATE_KEY');

  const provider = await createProvider(networkConfig);
  const signer = new ethers.Wallet(privateKey, provider);
  const somiReserveWei = ethers.parseUnits(cli.somiReserve, 18);

  const markets =
    cli.markets ||
    (config.strategies || [])
      .map((s) => s.market)
      .filter(Boolean);

  console.log(
    JSON.stringify(
      {
        wallet: await signer.getAddress(),
        network: networkName,
        markets,
        somiReserve: cli.somiReserve,
        dryRun: cli.dryRun,
        skipSell: cli.skipSell,
        steps: ['cancel_orders', 'withdraw_vault', cli.skipSell ? null : 'sell_wallet_base'].filter(Boolean),
      },
      null,
      2
    )
  );

  for (const symbol of markets) {
    const mc = await getMarketContext(provider, signer, networkName, symbol);
    await reconcileMarket(mc, signer, {
      symbol,
      somiReserveWei,
      dryRun: cli.dryRun,
      skipSell: cli.skipSell,
      crossBps: cli.crossBps,
    });
  }

  console.log('\nDone.');
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});

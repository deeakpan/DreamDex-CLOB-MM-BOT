#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath, quiet: true });
}

const { ethers } = require('ethers');

const SPOT_POOL_ABI = [
  'function getBookLevels(bool isBid, uint64 numLevels) view returns (tuple(uint256 price, uint256 quantity)[] levels)',
  'function getPoolParams() view returns (address baseToken_, address quoteToken_, uint256 makerFeeBpsTimes1k_, uint256 takerFeeBpsTimes1k_, uint256 tickSize_, uint256 minQuantity_, uint256 lotSize_)',
  'function getWithdrawableBalance(address owner, address token) view returns (uint256)',
  'function convertToQuoteAtPriceCeil(uint256 baseQuantity, uint256 priceQuote) view returns (uint256)',
];

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

const STATE_DIR = path.join(ROOT, '.state');
const ARTIFACT_PATH = path.join(ROOT, 'artifacts', 'delegation', 'DreamDexVolumeBatch7702.json');

function usage() {
  console.log(`Usage: node scripts/dreamdex-delegation.js [--config config/dreamdex.delegation.mainnet.json] <command> [options]

Commands:
  status              Wallet balances, book, saved implementation address
  deploy              Compile (if needed) and deploy implementation contract
  plan [--market SOMI:USDso] [--usd 5.00] [--funding auto|quote|native]
                      Show IOC prices/sizes and calldata without sending
  loop [--times N]      Continuous volume loop (default: run until out of funds / Ctrl+C)
  start                 Deploy if needed, then continuous native loop
  sweep [--market SOMI:USDso] [--impl 0x...]
                      EIP-7702 vault sweep helper

Funding:
  quote   Uses USDso already in wallet (default when balance is sufficient)
  native  STT-only: IOC sell STT for USDso, then buy+sell ping-pong in one tx
  auto    quote if enough USDso, else native on SOMI:USDso

Fund testnet wallet at https://testnet.somnia.network (STT is enough for native mode)
`);
}

function parseArgs(argv) {
  const args = {
    network: 'mainnet',
    configPath: null,
    command: null,
    market: null,
    usd: null,
    impl: null,
    crossBps: null,
    gasLimit: 6_000_000n,
    funding: 'auto',
    gasReserveStt: null,
    loopTimes: 0,
    loopIntervalMs: null,
  };

  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--config') {
      args.configPath = path.resolve(process.cwd(), argv[++i]);
    } else if (token === '--network') {
      args.network = argv[++i];
    } else if (token === '--market') {
      args.market = argv[++i];
    } else if (token === '--usd') {
      args.usd = argv[++i];
    } else if (token === '--impl') {
      args.impl = argv[++i];
    } else if (token === '--cross-bps') {
      args.crossBps = BigInt(argv[++i]);
    } else if (token === '--gas-limit') {
      args.gasLimit = BigInt(argv[++i]);
    } else if (token === '--funding') {
      args.funding = argv[++i];
    } else if (token === '--gas-reserve-stt' || token === '--gas-reserve-native') {
      args.gasReserveStt = argv[++i];
    } else if (token === '--times') {
      args.loopTimes = Number(argv[++i]);
    } else if (token === '--interval-ms') {
      args.loopIntervalMs = Number(argv[++i]);
    } else if (token.startsWith('-')) {
      throw new Error(`Unknown flag: ${token}`);
    } else {
      positionals.push(token);
    }
  }

  args.command = positionals[0] || null;
  return args;
}

function loadConfig(args) {
  const configPath =
    args.configPath || path.join(ROOT, 'config', `dreamdex.delegation.${args.network}.json`);
  if (!fs.existsSync(configPath)) {
    throw new Error(`Missing config: ${configPath}`);
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function loadArtifact() {
  if (!fs.existsSync(ARTIFACT_PATH)) {
    throw new Error('Artifact missing. Run: npm run dreamdex:delegation:compile');
  }
  return JSON.parse(fs.readFileSync(ARTIFACT_PATH, 'utf8'));
}

function statePath(networkName) {
  return path.join(STATE_DIR, `delegation-${networkName}.json`);
}

function loadState(networkName) {
  const file = statePath(networkName);
  if (!fs.existsSync(file)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveState(networkName, patch) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const next = { ...loadState(networkName), ...patch };
  fs.writeFileSync(statePath(networkName), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function requirePrivateKey() {
  const raw = process.env.PRIVATE_KEY;
  if (!raw || !String(raw).trim()) {
    throw new Error('PRIVATE_KEY missing. Set it in the repo .env file.');
  }
  return raw.startsWith('0x') ? raw : `0x${raw}`;
}

async function connectProvider(config) {
  let lastError = null;
  for (const rpcUrl of config.rpcUrls) {
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl, config.chainId, {
        staticNetwork: ethers.Network.from(config.chainId),
      });
      const block = await provider.getBlockNumber();
      return { provider, rpcUrl, block };
    } catch (error) {
      lastError = error;
      console.warn(`RPC failed ${rpcUrl}: ${error.shortMessage || error.message}`);
    }
  }
  throw lastError || new Error('No working RPC');
}

function alignToTick(value, tickSize, direction) {
  if (tickSize <= 0n) {
    return value;
  }
  if (direction === 'up') {
    return ((value + tickSize - 1n) / tickSize) * tickSize;
  }
  return (value / tickSize) * tickSize;
}

function alignToLot(value, lotSize, direction = 'down') {
  if (lotSize <= 0n) {
    return value;
  }
  if (direction === 'down') {
    return (value / lotSize) * lotSize;
  }
  return ((value + lotSize - 1n) / lotSize) * lotSize;
}

function computeIocCrossPrice(sideLabel, bestBid, bestAsk, tickSize, crossBps) {
  if (sideLabel === 'bid') {
    return alignToTick((bestAsk * (10_000n + crossBps)) / 10_000n, tickSize, 'up');
  }
  return alignToTick((bestBid * (10_000n - crossBps)) / 10_000n, tickSize, 'down');
}

async function estimateBaseQuantityForQuoteBudget(poolRead, quoteBudget, price, lotSize, minQuantity) {
  if (quoteBudget <= 0n || price <= 0n || minQuantity <= 0n) {
    return 0n;
  }

  const step = lotSize > 0n ? lotSize : minQuantity;
  const wad = 1_000_000_000_000_000_000n;

  let quantity = alignToLot((quoteBudget * wad) / price, lotSize, 'down');
  if (quantity < minQuantity) {
    quantity = alignToLot(minQuantity, lotSize, 'down');
  }

  while (quantity >= minQuantity) {
    const quoteNeeded = await poolRead.convertToQuoteAtPriceCeil(quantity, price);
    if (quoteNeeded <= quoteBudget) {
      break;
    }
    if (quantity <= step) {
      return 0n;
    }
    quantity -= step;
  }

  let best = 0n;
  let guard = 0;
  while (quantity >= minQuantity && guard < 2048) {
    guard += 1;
    const quoteNeeded = await poolRead.convertToQuoteAtPriceCeil(quantity, price);
    if (quoteNeeded > quoteBudget) {
      break;
    }
    best = quantity;
    quantity += step;
  }

  return best >= minQuantity ? best : 0n;
}

function buildExpireTimestampNs(secondsFromNow) {
  return BigInt(Math.floor(Date.now() / 1000) + secondsFromNow) * 1_000_000_000n;
}

async function loadMarketContext(provider, config, marketSymbol) {
  const market = config.markets[marketSymbol];
  if (!market) {
    throw new Error(`Unknown market ${marketSymbol}. Known: ${Object.keys(config.markets).join(', ')}`);
  }

  const poolRead = new ethers.Contract(market.pool, SPOT_POOL_ABI, provider);
  const params = await poolRead.getPoolParams();
  const baseToken = params[0];
  const quoteToken = params[1];
  const tickSize = params[4];
  const minQuantity = params[5];
  const lotSize = params[6];

  const quoteContract = new ethers.Contract(quoteToken, ERC20_ABI, provider);
  const [quoteDecimals, quoteSymbol] = await Promise.all([
    quoteContract.decimals(),
    quoteContract.symbol().catch(() => 'USDso'),
  ]);

  return {
    market,
    marketSymbol,
    poolRead,
    poolAddress: market.pool,
    baseToken,
    quoteToken,
    tickSize,
    minQuantity,
    lotSize,
    quoteDecimals,
    quoteSymbol,
    isNativeBase: market.isNativeBase === true,
  };
}

async function readTopOfBook(poolRead) {
  const [bids, asks] = await Promise.all([poolRead.getBookLevels(true, 1n), poolRead.getBookLevels(false, 1n)]);
  const bestBid = bids.length > 0 ? bids[0].price : 0n;
  const bestAsk = asks.length > 0 ? asks[0].price : 0n;
  return { bestBid, bestAsk };
}

async function buildRoundTripPlan(ctx, options) {
  const defaults = ctx.config.defaults || {};
  const crossBps = options.crossBps ?? BigInt(defaults.iocCrossBps ?? 5);
  const sizeUsd = options.usd ?? defaults.sizePerCycleUsd ?? '5.00';
  const quoteBudget = ethers.parseUnits(String(sizeUsd), ctx.market.quoteDecimals);
  const { bestBid, bestAsk } = await readTopOfBook(ctx.market.poolRead);

  if (bestBid === 0n || bestAsk === 0n) {
    throw new Error('Book has no bid/ask liquidity');
  }

  const buyPrice = computeIocCrossPrice('bid', bestBid, bestAsk, ctx.market.tickSize, crossBps);
  const sellPrice = computeIocCrossPrice('ask', bestBid, bestAsk, ctx.market.tickSize, crossBps);
  const quantity = alignToLot(
    await estimateBaseQuantityForQuoteBudget(
      ctx.market.poolRead,
      quoteBudget,
      buyPrice,
      ctx.market.lotSize,
      ctx.market.minQuantity
    ),
    ctx.market.lotSize
  );

  if (quantity < ctx.market.minQuantity) {
    throw new Error(`Quantity ${quantity} below pool minimum ${ctx.market.minQuantity}`);
  }

  const requiredQuote = await ctx.market.poolRead.convertToQuoteAtPriceCeil(quantity, buyPrice);
  const bufferBps = BigInt(defaults.quoteDepositBufferBps ?? 50);
  const quoteDeposit = (requiredQuote * (10_000n + bufferBps)) / 10_000n;
  const expireTimestampNs = buildExpireTimestampNs(defaults.expireSecondsFromNow ?? 3600);

  return {
    marketSymbol: ctx.market.marketSymbol,
    bestBid,
    bestAsk,
    buyPrice,
    sellPrice,
    quantity,
    requiredQuote,
    quoteDeposit,
    expireTimestampNs,
    crossBps,
    sizeUsd,
    fundingMode: 'quote',
    nativeSellAmount: null,
    txValue: 0n,
  };
}

function gasReserveWei(config, args) {
  const raw =
    args.gasReserveStt ??
    args.gasReserveNative ??
    config.defaults?.gasReserveStt ??
    config.defaults?.gasReserveNative ??
    (config.label === 'mainnet' ? '10' : '5');
  return ethers.parseEther(String(raw));
}

function nativeSymbol(config) {
  return config.label === 'mainnet' ? 'SOMI' : 'STT';
}

async function computeNativeSellAmount(poolRead, quantity, buyPrice, sellPrice, bufferBps, lotSize) {
  const requiredBuyQuote = await poolRead.convertToQuoteAtPriceCeil(quantity, buyPrice);
  const targetQuote = (requiredBuyQuote * (10_000n + bufferBps)) / 10_000n;
  const wad = 1_000_000_000_000_000_000n;
  const step = lotSize > 0n ? lotSize : quantity;
  let nativeSell = alignToLot((targetQuote * wad) / sellPrice, lotSize, 'up');
  if (nativeSell < quantity) {
    nativeSell = alignToLot(quantity, lotSize, 'up');
  }
  for (let guard = 0; guard < 64; guard += 1) {
    const proceeds = await poolRead.convertToQuoteAtPriceCeil(nativeSell, sellPrice);
    if (proceeds >= targetQuote) {
      return { nativeSellAmount: nativeSell, requiredBuyQuote, expectedSellProceeds: proceeds };
    }
    nativeSell += step;
  }
  throw new Error('Could not size native sell amount for buy funding');
}

async function resolveExecutionPlan(ctx, walletQuote, nativeBal) {
  const plan = await buildRoundTripPlan(ctx, ctx.args);
  const gasReserve = gasReserveWei(ctx.config, ctx.args);
  const fundingPref = String(ctx.args.funding || 'auto').toLowerCase();

  const canUseQuote = walletQuote >= plan.quoteDeposit;
  const nativeSizing = ctx.market.isNativeBase
    ? await computeNativeSellAmount(
        ctx.market.poolRead,
        plan.quantity,
        plan.buyPrice,
        plan.sellPrice,
        BigInt(ctx.config.defaults?.nativeSellBufferBps ?? 150),
        ctx.market.lotSize
      )
    : null;
  const canUseNative =
    ctx.market.isNativeBase &&
    nativeSizing &&
    nativeBal > gasReserve &&
    nativeBal - gasReserve >= nativeSizing.nativeSellAmount;

  let fundingMode = 'quote';
  if (fundingPref === 'native') {
    if (!canUseNative) {
      throw new Error('Native funding requested but wallet lacks STT (after gas reserve) for sell-to-fund sizing');
    }
    fundingMode = 'native';
  } else if (fundingPref === 'quote') {
    if (!canUseQuote) {
      throw new Error(
        `Quote funding requested but wallet USDso insufficient: have ${ethers.formatUnits(walletQuote, ctx.market.quoteDecimals)}, need ${ethers.formatUnits(plan.quoteDeposit, ctx.market.quoteDecimals)}`
      );
    }
    fundingMode = 'quote';
  } else if (canUseQuote) {
    fundingMode = 'quote';
  } else if (canUseNative) {
    fundingMode = 'native';
  } else {
    throw new Error(
      `Insufficient funds. USDso need ${ethers.formatUnits(plan.quoteDeposit, ctx.market.quoteDecimals)} (have ${ethers.formatUnits(walletQuote, ctx.market.quoteDecimals)}). ` +
        `STT native path needs ${ethers.formatUnits(nativeSizing.nativeSellAmount, 18)} + ${ethers.formatUnits(gasReserve, 18)} gas reserve (have ${ethers.formatEther(nativeBal)}).`
    );
  }

  if (fundingMode === 'native') {
    return {
      ...plan,
      fundingMode,
      nativeSellAmount: nativeSizing.nativeSellAmount,
      requiredBuyQuote: nativeSizing.requiredBuyQuote,
      expectedSellProceeds: nativeSizing.expectedSellProceeds,
      quoteDeposit: null,
      txValue: nativeSizing.nativeSellAmount,
      gasReserve,
    };
  }

  return {
    ...plan,
    fundingMode,
    quoteDeposit: plan.quoteDeposit,
    nativeSellAmount: null,
    txValue: 0n,
    gasReserve,
  };
}

function buildCalldata(artifact, ctx, plan) {
  if (plan.fundingMode === 'native') {
    return encode7702Call(artifact, 'atomicRoundTripFromNative', [
      ctx.market.poolAddress,
      ctx.market.quoteToken,
      ctx.market.baseToken,
      plan.nativeSellAmount,
      plan.buyPrice,
      plan.sellPrice,
      plan.quantity,
      plan.expireTimestampNs,
    ]);
  }
  return encode7702Call(artifact, 'atomicRoundTrip', [
    ctx.market.poolAddress,
    ctx.market.quoteToken,
    ctx.market.baseToken,
    plan.quoteDeposit,
    plan.buyPrice,
    plan.sellPrice,
    plan.quantity,
    plan.expireTimestampNs,
  ]);
}

function formatPlanForLog(plan, quoteDecimals) {
  const base = {
    market: plan.marketSymbol,
    fundingMode: plan.fundingMode,
    quantity: plan.quantity.toString(),
    buyPrice: plan.buyPrice.toString(),
    sellPrice: plan.sellPrice.toString(),
  };
  if (plan.fundingMode === 'native') {
    return {
      ...base,
      nativeSellAmount: plan.nativeSellAmount.toString(),
      txValueStt: ethers.formatEther(plan.txValue),
      expectedSellProceedsUsdso: ethers.formatUnits(plan.expectedSellProceeds, quoteDecimals),
      requiredBuyQuoteUsdso: ethers.formatUnits(plan.requiredBuyQuote, quoteDecimals),
    };
  }
  return {
    ...base,
    quoteDeposit: plan.quoteDeposit.toString(),
    quoteDepositUsdso: ethers.formatUnits(plan.quoteDeposit, quoteDecimals),
  };
}

function resolveImplementationAddress(args, state) {
  return args.impl || state.implementation || null;
}

async function printStatus(ctx) {
  const state = loadState(ctx.config.label);
  const wallet = ctx.wallet;
  const [nativeBal, quoteBal, quoteVault, baseVault] = await Promise.all([
    ctx.provider.getBalance(wallet.address),
    new ethers.Contract(ctx.market.quoteToken, ERC20_ABI, ctx.provider).balanceOf(wallet.address),
    ctx.market.poolRead.getWithdrawableBalance(wallet.address, ctx.market.quoteToken),
    ctx.market.poolRead.getWithdrawableBalance(wallet.address, ctx.market.baseToken),
  ]);
  const { bestBid, bestAsk } = await readTopOfBook(ctx.market.poolRead);

  console.log(
    JSON.stringify(
      {
        network: ctx.config.label,
        chainId: ctx.config.chainId,
        rpc: ctx.rpcUrl,
        block: ctx.block,
        wallet: wallet.address,
        market: ctx.market.marketSymbol,
        pool: ctx.market.poolAddress,
        quoteToken: ctx.market.quoteToken,
        baseToken: ctx.market.baseToken,
        balances: {
          native: ethers.formatEther(nativeBal),
          quoteWallet: ethers.formatUnits(quoteBal, ctx.market.quoteDecimals),
          quoteVault: ethers.formatUnits(quoteVault, ctx.market.quoteDecimals),
          baseVault: ethers.formatUnits(baseVault, 18),
        },
        book: {
          bestBid: ethers.formatUnits(bestBid, 18),
          bestAsk: ethers.formatUnits(bestAsk, 18),
        },
        implementation: resolveImplementationAddress({}, state),
        faucet: 'https://testnet.somnia.network',
      },
      null,
      2
    )
  );
}

async function deployImplementation(ctx) {
  const artifact = loadArtifact();
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, ctx.wallet);
  console.log('Deploying DreamDexVolumeBatch7702 implementation...');
  const contract = await factory.deploy();
  const receipt = await contract.deploymentTransaction().wait(1);
  const address = await contract.getAddress();
  saveState(ctx.config.label, {
    implementation: address,
    deployedAt: new Date().toISOString(),
    deployTx: receipt.hash,
  });
  console.log(`Implementation deployed: ${address}`);
  console.log(`Deploy tx: ${receipt.hash}`);
  return address;
}

function encode7702Call(artifact, functionName, values) {
  const iface = new ethers.Interface(artifact.abi);
  return iface.encodeFunctionData(functionName, values);
}

async function sendType4DelegatedTx(ctx, implementationAddress, data, label, txValue = 0n) {
  const auth = await ctx.wallet.authorize({ address: implementationAddress });
  console.log(`Sending EIP-7702 ${label} via type-4 tx...`);
  console.log(`  delegate -> ${implementationAddress}`);
  console.log(`  to       -> ${ctx.wallet.address} (self)`);
  if (txValue > 0n) {
    console.log(`  value    -> ${ethers.formatEther(txValue)} STT`);
  }

  const tx = await ctx.wallet.sendTransaction({
    type: 4,
    to: ctx.wallet.address,
    data,
    value: txValue,
    authorizationList: [auth],
    gasLimit: ctx.args.gasLimit,
  });
  console.log(`  tx hash  -> ${tx.hash}`);
  const receipt = await tx.wait(1);
  console.log(`  status   -> ${receipt.status === 1 ? 'success' : 'failed'}`);
  console.log(`  gasUsed  -> ${receipt.gasUsed.toString()}`);
  return receipt;
}

async function commandPlan(ctx) {
  const quoteContract = new ethers.Contract(ctx.market.quoteToken, ERC20_ABI, ctx.provider);
  const [walletQuote, nativeBal] = await Promise.all([
    quoteContract.balanceOf(ctx.wallet.address),
    ctx.provider.getBalance(ctx.wallet.address),
  ]);
  const plan = await resolveExecutionPlan(ctx, walletQuote, nativeBal);
  const artifact = loadArtifact();
  const data = buildCalldata(artifact, ctx, plan);

  console.log(
    JSON.stringify(
      {
        ...formatPlanForLog(plan, ctx.market.quoteDecimals),
        bestBid: plan.bestBid.toString(),
        bestAsk: plan.bestAsk.toString(),
        crossBps: plan.crossBps.toString(),
        sizeUsd: plan.sizeUsd,
        expireTimestampNs: plan.expireTimestampNs.toString(),
        calldata: data,
        gasReserveStt: ethers.formatEther(plan.gasReserve),
        note:
          plan.fundingMode === 'native'
            ? 'STT is IOC-sold on SOMI:USDso for USDso inside the same type-4 tx (no separate DEX)'
            : 'Uses wallet USDso directly',
      },
      null,
      2
    )
  );
}

async function commandExecute(ctx) {
  const state = loadState(ctx.config.label);
  const implementationAddress = resolveImplementationAddress(ctx.args, state);
  if (!implementationAddress) {
    throw new Error('No implementation address. Run deploy first or pass --impl 0x...');
  }

  const quoteContract = new ethers.Contract(ctx.market.quoteToken, ERC20_ABI, ctx.provider);
  const [walletQuote, nativeBal] = await Promise.all([
    quoteContract.balanceOf(ctx.wallet.address),
    ctx.provider.getBalance(ctx.wallet.address),
  ]);

  const gasReserve = gasReserveWei(ctx.config, ctx.args);
  const nativeLabel = nativeSymbol(ctx.config);
  if (nativeBal === 0n) {
    throw new Error(`Wallet has 0 ${nativeLabel} for gas.`);
  }
  if (nativeBal <= gasReserve) {
    throw new Error(
      `${nativeLabel} balance ${ethers.formatEther(nativeBal)} is at or below gas reserve ${ethers.formatEther(gasReserve)}`
    );
  }

  const plan = await resolveExecutionPlan(ctx, walletQuote, nativeBal);
  const artifact = loadArtifact();

  console.log('Round-trip plan:');
  console.log(JSON.stringify(formatPlanForLog(plan, ctx.market.quoteDecimals), null, 2));

  const data = buildCalldata(artifact, ctx, plan);
  const label = plan.fundingMode === 'native' ? 'atomicRoundTripFromNative' : 'atomicRoundTrip';
  const receipt = await sendType4DelegatedTx(ctx, implementationAddress, data, label, plan.txValue);
  saveState(ctx.config.label, {
    lastExecuteTx: receipt.hash,
    lastExecuteAt: new Date().toISOString(),
    lastFundingMode: plan.fundingMode,
  });
  return receipt;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isOutOfFundsError(message) {
  const text = String(message || '').toLowerCase();
  return (
    text.includes('insufficient funds') ||
    text.includes('gas reserve') ||
    text.includes('0 stt') ||
    text.includes('lack stt') ||
    text.includes('sell-to-fund sizing')
  );
}

async function ensureImplementation(ctx) {
  const state = loadState(ctx.config.label);
  const existing = resolveImplementationAddress(ctx.args, state);
  if (existing) {
    return existing;
  }
  if (!fs.existsSync(ARTIFACT_PATH)) {
    const { execFileSync } = require('child_process');
    execFileSync(process.execPath, [path.join(__dirname, 'dreamdex-delegation-compile.js')], { stdio: 'inherit' });
  }
  return deployImplementation(ctx);
}

async function commandLoop(ctx) {
  await ensureImplementation(ctx);

  const intervalMs = ctx.args.loopIntervalMs ?? ctx.config.defaults?.loopIntervalMs ?? 5000;
  const retryMs = Math.max(intervalMs, 10_000);
  const maxTimes = ctx.args.loopTimes > 0 ? ctx.args.loopTimes : null;
  let ok = 0;
  let fail = 0;
  let cycle = 0;

  console.log(
    `Continuous loop started | funding=${ctx.args.funding || 'auto'} | interval=${intervalMs}ms | wallet=${ctx.wallet.address}`
  );
  console.log('Press Ctrl+C to stop.\n');

  const stop = () => {
    console.log(`\nStopped after ${cycle} cycles: ${ok} succeeded, ${fail} failed`);
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  while (maxTimes === null || cycle < maxTimes) {
    cycle += 1;
    const label = maxTimes ? `${cycle}/${maxTimes}` : String(cycle);
    console.log(`--- cycle ${label} | ok=${ok} fail=${fail} ---`);

    try {
      const receipt = await commandExecute(ctx);
      if (receipt.status === 1) {
        ok += 1;
        await sleep(intervalMs);
      } else {
        fail += 1;
        console.warn('Tx mined with status != 1, retrying...');
        await sleep(retryMs);
      }
    } catch (error) {
      fail += 1;
      const msg = error.shortMessage || error.message || String(error);
      console.warn(`Cycle ${cycle} failed: ${msg}`);
      if (isOutOfFundsError(msg)) {
        console.log('Wallet cannot fund another cycle, stopping.');
        break;
      }
      await sleep(retryMs);
    }
  }

  console.log(`\nLoop finished: ${ok} succeeded, ${fail} failed`);
}

async function commandStart(ctx) {
  const networkDefault = ctx.config.defaults?.funding || (ctx.config.label === 'mainnet' ? 'quote' : 'native');
  ctx.args.funding = ctx.args.funding || networkDefault;
  console.log(`Start mode: network=${ctx.config.label} funding=${ctx.args.funding}`);
  await commandLoop(ctx);
}

async function commandSweep(ctx) {
  const state = loadState(ctx.config.label);
  const implementationAddress = resolveImplementationAddress(ctx.args, state);
  if (!implementationAddress) {
    throw new Error('No implementation address. Run deploy first or pass --impl 0x...');
  }

  const artifact = loadArtifact();
  const data = encode7702Call(artifact, 'sweepVault', [
    ctx.market.poolAddress,
    ctx.market.quoteToken,
    ctx.market.baseToken,
  ]);
  const receipt = await sendType4DelegatedTx(ctx, implementationAddress, data, 'sweepVault');
  saveState(ctx.config.label, { lastSweepTx: receipt.hash, lastSweepAt: new Date().toISOString() });
  return receipt;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.command || args.command === 'help' || args.command === '--help') {
    usage();
    process.exit(args.command ? 0 : 1);
  }

  const config = loadConfig(args);
  const { provider, rpcUrl, block } = await connectProvider(config);
  const wallet = new ethers.Wallet(requirePrivateKey(), provider);
  const marketSymbol = args.market || config.defaultMarket;
  const market = await loadMarketContext(provider, config, marketSymbol);

  const ctx = {
    config,
    provider,
    rpcUrl,
    block,
    wallet,
    market,
    args,
  };

  if (args.command === 'status') {
    await printStatus(ctx);
    return;
  }
  if (args.command === 'deploy') {
    if (!fs.existsSync(ARTIFACT_PATH)) {
      const { execFileSync } = require('child_process');
      execFileSync(process.execPath, [path.join(__dirname, 'dreamdex-delegation-compile.js')], { stdio: 'inherit' });
    }
    await deployImplementation(ctx);
    return;
  }
  if (args.command === 'plan') {
    await commandPlan(ctx);
    return;
  }
  if (args.command === 'execute' || args.command === 'run') {
    await commandExecute(ctx);
    return;
  }
  if (args.command === 'loop') {
    await commandLoop(ctx);
    return;
  }
  if (args.command === 'start') {
    await commandStart(ctx);
    return;
  }
  if (args.command === 'sweep') {
    await commandSweep(ctx);
    return;
  }

  throw new Error(`Unknown command: ${args.command}`);
}

main().catch((error) => {
  console.error(error.shortMessage || error.message || String(error));
  process.exit(1);
});

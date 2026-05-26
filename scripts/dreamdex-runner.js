#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });
const { ethers } = require('ethers');

const SPOT_POOL_ABI = [
  'function getBookLevels(bool isBid, uint64 numLevels) view returns (tuple(uint256 price, uint256 quantity)[] levels)',
  'function placeOrder(bool isBid, uint64 userData, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k) returns (bool success, uint128 orderId)',
  'function placeTakerOrderWithoutVault(bool isBid, uint64 userData, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k) payable returns (bool success, uint128 orderId)',
  'function getPoolParams() view returns (address baseToken_, address quoteToken_, uint256 makerFeeBpsTimes1k_, uint256 takerFeeBpsTimes1k_, uint256 tickSize_, uint256 minQuantity_, uint256 lotSize_)',
];

const DEFAULT_NETWORKS = {
  mainnet: {
    label: 'mainnet',
    chainId: 5031,
    rpcUrl: 'https://api.infra.mainnet.somnia.network',
    restUrl: 'https://api.dreamdex.io',
    wsUrl: 'wss://api.dreamdex.io/v0/ws/public',
  },
  testnet: {
    label: 'testnet',
    chainId: 50312,
    rpcUrl: 'https://dream-rpc.somnia.network',
    restUrl: 'https://stg.api.dreamdex.io',
    wsUrl: 'wss://stg.api.dreamdex.io/v0/ws/public',
  },
};

const DEFAULT_MARKETS = {
  mainnet: {
    'SOMI:USDso': {
      symbol: 'SOMI:USDso',
      pool: '0x035De7403eac6872787779CCA7CCF1b4CDb61379',
      stopRegistry: '0x68c8f6fb1EA19A28F25358Ff00b8Ed8E1216df30',
      isNativeBase: true,
    },
    'USDC.e:USDso': {
      symbol: 'USDC.e:USDso',
      pool: '0x47fD2f18426f67106DBaC82F6d21D446c5F2120b',
      stopRegistry: '0xD53E3F3b73513F2147377ef8f573f649cF60100c',
      isNativeBase: false,
    },
    'WBTC:USDso': {
      symbol: 'WBTC:USDso',
      pool: '0x25bfF6B7B5E2243424F38E75de7ab03C0522a5EA',
      stopRegistry: '0xed32F048D6a47923D38eCeD868d6f8b0eB4852bd',
      isNativeBase: false,
    },
    'WETH:USDso': {
      symbol: 'WETH:USDso',
      pool: '0xa936da11B57b50A344e1293AAaE5232885ea2bDE',
      stopRegistry: '0x9653a7355849B7691802A6AA49fDe18eF5ba633d',
      isNativeBase: false,
    },
  },
  testnet: {
    'SOMI:USDso': {
      symbol: 'SOMI:USDso',
      pool: '0x259fD6559214dd5aD3752322426eA9F9fABEFff4',
      stopRegistry: '0xEb97349Aa62A68507c0bE535eD88B0d028a47E1e',
      isNativeBase: true,
    },
    'WBTC:USDso': {
      symbol: 'WBTC:USDso',
      pool: '0x3605f28aA7C50e7441211e77Cb0762d49539326C',
      stopRegistry: '0x53d5B2b0791b3992a1F3b5e0b0277Ee2e08B7aaD',
      isNativeBase: false,
    },
    'WETH:USDso': {
      symbol: 'WETH:USDso',
      pool: '0xD180195da5459C7a0DEA188ed61216ec43682b50',
      stopRegistry: '0xf822D4Cb94902d667c9650e702aA5f096cc7598F',
      isNativeBase: false,
    },
  },
};

const ORDER_TYPES = {
  normal: 0,
  gtc: 0,
  fillorkill: 1,
  fok: 1,
  immediateorcancel: 2,
  ioc: 2,
  postonly: 3,
};

const SELF_MATCHING_OPTIONS = {
  canceltaker: 0,
  taker: 0,
  cancelmaker: 1,
  maker: 1,
};

const MAX_UINT64 = (1n << 64n) - 1n;
const ZERO_ADDRESS = ethers.ZeroAddress;

function parseCliArgs(argv) {
  const result = { configPath: null, networkOverride: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--config') {
      result.configPath = argv[i + 1];
      i += 1;
    } else if (arg === '--network') {
      result.networkOverride = argv[i + 1];
      i += 1;
    }
  }
  return result;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function mkdirp(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function toSerializable(value) {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map((entry) => toSerializable(entry));
  }
  if (value && typeof value === 'object') {
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = toSerializable(entry);
    }
    return output;
  }
  return value;
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(toSerializable(data), null, 2));
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeOrderType(input) {
  if (typeof input === 'number') {
    return input;
  }
  const normalized = String(input || 'ioc').toLowerCase();
  if (!(normalized in ORDER_TYPES)) {
    throw new Error(`Unsupported order type: ${input}`);
  }
  return ORDER_TYPES[normalized];
}

function normalizeSelfMatchingOption(input) {
  if (typeof input === 'number') {
    return input;
  }
  const normalized = String(input || 'cancelTaker').toLowerCase();
  if (!(normalized in SELF_MATCHING_OPTIONS)) {
    throw new Error(`Unsupported self-matching option: ${input}`);
  }
  return SELF_MATCHING_OPTIONS[normalized];
}

function parseBigIntValue(value, fieldName) {
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number') {
    return BigInt(value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return BigInt(value);
  }
  throw new Error(`Missing or invalid bigint field: ${fieldName}`);
}

function toUint64(value, fieldName) {
  if (value < 0n || value > MAX_UINT64) {
    throw new Error(`${fieldName} must fit in uint64`);
  }
  return value;
}

function buildFutureExpireTimestampNs(expireSecondsFromNow) {
  const seconds = BigInt(Math.floor(Date.now() / 1000) + expireSecondsFromNow);
  return seconds * 1_000_000_000n;
}

function resolveExpireTimestampNs(action, defaults) {
  if (action.expireTimestampNs !== undefined) {
    const explicit = parseBigIntValue(action.expireTimestampNs, 'expireTimestampNs');
    if (explicit === 0n) {
      throw new Error(
        'expireTimestampNs = 0 is rejected on deployed DreamDEX pools. Pass a future timestamp instead.'
      );
    }
    return toUint64(explicit, 'expireTimestampNs');
  }

  const secondsFromNow = Number(defaults.expireSecondsFromNow || 3600);
  return toUint64(buildFutureExpireTimestampNs(secondsFromNow), 'expireTimestampNs');
}

function resolveNetworkName(config, networkOverride) {
  const networkName = networkOverride || config.network;
  if (!networkName) {
    throw new Error('Missing network. Set `network` in config or pass --network.');
  }
  if (!DEFAULT_NETWORKS[networkName]) {
    throw new Error(`Unsupported network: ${networkName}`);
  }
  return networkName;
}

function resolveNetworkConfig(config, networkName) {
  const fileNetwork = (config.networks && config.networks[networkName]) || {};
  return {
    ...DEFAULT_NETWORKS[networkName],
    ...fileNetwork,
  };
}

function resolveMarket(config, networkName, symbol) {
  const defaultMarket = DEFAULT_MARKETS[networkName] && DEFAULT_MARKETS[networkName][symbol];
  const fileMarkets = (config.markets && config.markets[networkName]) || {};
  const fileMarket = fileMarkets[symbol] || {};
  const market = {
    ...(defaultMarket || {}),
    ...(fileMarket || {}),
  };

  if (!market.pool) {
    throw new Error(`Unknown market for ${networkName}: ${symbol}`);
  }

  return market;
}

function resolveWallet(config, provider) {
  const walletConfig = config.wallet || {};
  const envVar = walletConfig.privateKeyEnvVar || 'PRIVATE_KEY';
  const privateKey = normalizePrivateKey(walletConfig.privateKey || process.env[envVar]);
  if (!privateKey) {
    return null;
  }
  return new ethers.Wallet(privateKey, provider);
}

function normalizePrivateKey(input) {
  if (!input) {
    return null;
  }

  const trimmed = String(input).trim().replace(/^['"]|['"]$/g, '');
  if (trimmed === '') {
    return null;
  }

  return trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
}

function sideToIsBid(side) {
  const normalized = String(side || '').toLowerCase();
  if (normalized === 'buy' || normalized === 'bid' || normalized === 'true') {
    return true;
  }
  if (normalized === 'sell' || normalized === 'ask' || normalized === 'false') {
    return false;
  }
  throw new Error(`Unsupported side: ${side}`);
}

function getMethodName(action) {
  return action.fundingSource === 'vault' ? 'placeOrder' : 'placeTakerOrderWithoutVault';
}

function resolveOverrides(action, market, quantity) {
  if (action.valueWei !== undefined) {
    return { value: parseBigIntValue(action.valueWei, 'valueWei') };
  }

  if (action.fundingSource === 'wallet' && market.isNativeBase && sideToIsBid(action.side) === false) {
    return { value: quantity };
  }

  return {};
}

function buildOrderCall(action, defaults, market) {
  const isBid = sideToIsBid(action.side);
  const userData = action.userData !== undefined ? parseBigIntValue(action.userData, 'userData') : 0n;
  const price = parseBigIntValue(action.price, 'price');
  const quantity = parseBigIntValue(action.quantity, 'quantity');
  const expireTimestampNs = resolveExpireTimestampNs(action, defaults);
  const orderType = normalizeOrderType(action.orderType);
  const selfMatchingOption = normalizeSelfMatchingOption(action.selfMatchingOption);
  const builder = action.builder || ZERO_ADDRESS;
  const builderFeeBpsTimes1k =
    action.builderFeeBpsTimes1k !== undefined
      ? parseBigIntValue(action.builderFeeBpsTimes1k, 'builderFeeBpsTimes1k')
      : 0n;

  const args = [
    isBid,
    toUint64(userData, 'userData'),
    price,
    quantity,
    expireTimestampNs,
    orderType,
    selfMatchingOption,
    builder,
    builderFeeBpsTimes1k,
  ];

  const overrides = resolveOverrides(action, market, quantity);

  return {
    args,
    overrides,
    resolved: {
      fundingSource: action.fundingSource || 'wallet',
      isBid,
      userData: toUint64(userData, 'userData'),
      price,
      quantity,
      expireTimestampNs,
      orderType,
      selfMatchingOption,
      builder,
      builderFeeBpsTimes1k,
      value: overrides.value || 0n,
    },
  };
}

function formatLevels(levels) {
  return levels.map((level, index) => ({
    index,
    price: level.price,
    quantity: level.quantity,
  }));
}

function resultTupleToObject(result) {
  return {
    success: Boolean(result[0]),
    orderId: result[1],
  };
}

class ActivityLog {
  constructor(summary) {
    this.summary = summary;
    this.activities = [];
  }

  push(activity) {
    this.activities.push({
      at: nowIso(),
      ...activity,
    });
  }

  toJson() {
    return {
      ...this.summary,
      activities: this.activities,
    };
  }
}

async function ensureSigner(context, actionType) {
  if (!context.signer) {
    throw new Error(`${actionType} requires a wallet. Set ${context.privateKeyEnvVar} in your environment.`);
  }
  return context.signer;
}

async function runBookAction(action, context) {
  const market = resolveMarket(context.config, context.networkName, action.market);
  const contract = new ethers.Contract(market.pool, SPOT_POOL_ABI, context.provider);
  const isBidSide = String(action.side || 'bid').toLowerCase() !== 'ask';
  const numLevels = Number(action.numLevels || 5);
  const levels = await contract.getBookLevels(isBidSide, numLevels);

  const formatted = formatLevels(levels);
  context.log.push({
    action: action.type,
    status: 'ok',
    market: market.symbol,
    side: isBidSide ? 'bid' : 'ask',
    levels: formatted,
  });
}

async function simulateOrder(action, context, simulationOnly = true) {
  const signer = await ensureSigner(context, action.type);
  const market = resolveMarket(context.config, context.networkName, action.market);
  const contract = new ethers.Contract(market.pool, SPOT_POOL_ABI, signer);
  const methodName = getMethodName(action);
  const orderCall = buildOrderCall(action, context.defaults, market);
  const result = await contract[methodName].staticCall(...orderCall.args, orderCall.overrides);
  const parsedResult = resultTupleToObject(result);

  context.log.push({
    action: simulationOnly ? 'simulateOrder' : 'preflightSimulation',
    status: parsedResult.success ? 'ok' : 'failed',
    market: market.symbol,
    pool: market.pool,
    method: methodName,
    resolved: orderCall.resolved,
    result: parsedResult,
  });

  return {
    market,
    methodName,
    orderCall,
    result: parsedResult,
  };
}

async function sendOrder(action, context) {
  const signer = await ensureSigner(context, action.type);
  const market = resolveMarket(context.config, context.networkName, action.market);
  const contract = new ethers.Contract(market.pool, SPOT_POOL_ABI, signer);
  const methodName = getMethodName(action);

  let orderCall;
  if (action.requireSimulationSuccess !== false) {
    const simulation = await simulateOrder(action, context, false);
    if (!simulation.result.success) {
      throw new Error(
        `Preflight simulation returned success=false for ${market.symbol}. Refusing to broadcast.`
      );
    }
    orderCall = simulation.orderCall;
  } else {
    orderCall = buildOrderCall(action, context.defaults, market);
  }

  const tx = await contract[methodName](...orderCall.args, orderCall.overrides);
  const confirmations = Number(action.confirmations || context.defaults.confirmations || 1);
  const receipt = await tx.wait(confirmations);

  context.log.push({
    action: 'sendOrder',
    status: receipt.status === 1 ? 'ok' : 'failed',
    market: market.symbol,
    pool: market.pool,
    method: methodName,
    resolved: orderCall.resolved,
    txHash: tx.hash,
    blockNumber: receipt.blockNumber,
    statusCode: receipt.status,
    gasUsed: receipt.gasUsed,
    logsCount: receipt.logs.length,
  });
}

async function main() {
  const cli = parseCliArgs(process.argv.slice(2));
  const configPath = path.resolve(cli.configPath || 'config/dreamdex.settings.json');

  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const config = readJson(configPath);
  const networkName = resolveNetworkName(config, cli.networkOverride);
  const networkConfig = resolveNetworkConfig(config, networkName);
  const defaults = config.defaults || {};
  const provider = new ethers.JsonRpcProvider(networkConfig.rpcUrl);
  const signer = resolveWallet(config, provider);
  const privateKeyEnvVar = ((config.wallet || {}).privateKeyEnvVar || 'PRIVATE_KEY');
  const onChainNetwork = await provider.getNetwork();

  if (Number(onChainNetwork.chainId) !== Number(networkConfig.chainId)) {
    throw new Error(
      `RPC chain mismatch. Expected ${networkConfig.chainId}, got ${onChainNetwork.chainId.toString()}`
    );
  }

  const walletAddress = signer ? await signer.getAddress() : null;
  const log = new ActivityLog({
    startedAt: nowIso(),
    configPath,
    network: networkName,
    chainId: networkConfig.chainId,
    rpcUrl: networkConfig.rpcUrl,
    restUrl: networkConfig.restUrl,
    wsUrl: networkConfig.wsUrl,
    walletAddress,
  });

  const context = {
    config,
    defaults,
    networkName,
    networkConfig,
    provider,
    signer,
    log,
    privateKeyEnvVar,
  };

  const actions = Array.isArray(config.actions) ? config.actions : [];
  if (actions.length === 0) {
    throw new Error('No actions found in config.');
  }

  for (const action of actions) {
    if (action.enabled === false) {
      log.push({
        action: action.type || 'unknown',
        status: 'skipped',
        reason: 'enabled=false',
        market: action.market || null,
      });
      continue;
    }

    if (action.type === 'book') {
      await runBookAction(action, context);
      continue;
    }

    if (action.type === 'simulateOrder') {
      await simulateOrder(action, context, true);
      continue;
    }

    if (action.type === 'sendOrder') {
      await sendOrder(action, context);
      continue;
    }

    throw new Error(`Unsupported action type: ${action.type}`);
  }

  const logDir = path.resolve(defaults.logDir || 'logs');
  mkdirp(logDir);
  const fileName = `dreamdex-${networkName}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const logPath = path.join(logDir, fileName);
  writeJson(logPath, {
    ...log.toJson(),
    finishedAt: nowIso(),
  });

  console.log(`Run complete. Log written to ${logPath}`);
}

main().catch((error) => {
  const message = error && error.stack ? error.stack : String(error);
  console.error(message);
  process.exitCode = 1;
});

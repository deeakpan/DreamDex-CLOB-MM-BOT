#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });
const { ethers } = require('ethers');
const WebSocket = require('ws');
const {
  createStateStore,
  loadStateFromSupabase,
  readJsonFileIfExists,
  saveStateToSupabase,
} = require('./dreamdex-state-store');

const SPOT_POOL_ABI = [
  'function getBookLevels(bool isBid, uint64 numLevels) view returns (tuple(uint256 price, uint256 quantity)[] levels)',
  'function getPoolParams() view returns (address baseToken_, address quoteToken_, uint256 makerFeeBpsTimes1k_, uint256 takerFeeBpsTimes1k_, uint256 tickSize_, uint256 minQuantity_, uint256 lotSize_)',
  'function getWithdrawableBalance(address owner, address token) view returns (uint256)',
  'function getOwnOpenOrders() view returns (uint128[] memory)',
  'function getOrder(uint128 orderId) view returns (tuple(uint128 orderId, bool isBid, address owner, uint64 userData, uint256 price, uint256 fullQuantity, uint256 quantityRemaining, uint64 expireTimestampNs))',
  'function cancelOrder(uint128 orderId)',
  'function placeOrder(bool isBid, uint64 userData, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k) returns (bool success, uint128 orderId)',
  'function placeTakerOrderWithoutVault(bool isBid, uint64 userData, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k) payable returns (bool success, uint128 orderId)',
  'function convertToQuoteAtPriceCeil(uint256 baseQuantity, uint256 priceQuote) view returns (uint256)',
  'function getMidpointEmaState() view returns (uint256 emaValue, uint64 lastUpdateNs)',
  'function deposit(address token, uint256 amount)',
  'function depositNative() payable',
];

const STOP_REGISTRY_ABI = [
  'function createPendingOrder(((bool,address,uint64,uint256),uint8,uint256,uint8,uint256,address,uint96) orderWithTrigger) payable returns (uint128 pendingOrderId)',
  'function cancelPendingOrder(uint128 orderId)',
  'function somiPaymentPerOrder() view returns (uint256)',
  'function activeSubscriptionId() view returns (uint256)',
  'event PendingOrderCreated(uint128 indexed orderId, address indexed owner, bool isBid, uint256 quantity, uint256 triggerPrice, uint8 triggerOperator, uint8 orderType, address builder, uint96 builderFeeBpsTimes1k)',
  'event PendingOrderCancelled(uint128 indexed orderId)',
];

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

const DEFAULT_NETWORKS = {
  mainnet: {
    label: 'mainnet',
    chainId: 5031,
    rpcUrl: 'https://api.infra.mainnet.somnia.network',
    rpcUrls: ['https://api.infra.mainnet.somnia.network', 'https://somnia.publicnode.com'],
    restUrl: 'https://api.dreamdex.io',
    wsUrl: 'wss://api.dreamdex.io/v0/ws/public',
  },
  testnet: {
    label: 'testnet',
    chainId: 50312,
    rpcUrl: 'https://dream-rpc.somnia.network',
    rpcUrls: ['https://dream-rpc.somnia.network', 'https://api.infra.testnet.somnia.network'],
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
    'SOMI:SOMUSD': {
      symbol: 'SOMI:SOMUSD',
      pool: '0x2d2855DA6fd895c6AFe72b28D5aa1Cd1c19e4036',
      stopRegistry: '0xa4E5C446b5EDb501554dab7B53B79c6e4F9ADAF9',
      isNativeBase: true,
    },
    'WBTC:SOMUSD': {
      symbol: 'WBTC:SOMUSD',
      pool: '0xb1527802E7800034D6887b0a99a5Ad2683184b95',
      stopRegistry: '0x0777DBe3E4a1781F467A456aE589878556601457',
      isNativeBase: false,
    },
    'WETH:SOMUSD': {
      symbol: 'WETH:SOMUSD',
      pool: '0x38381D63418Ff752Dba93eE018e36a6814388FA7',
      stopRegistry: '0x1799D99cac17ABEAb9CA860Cf6F10A8949c876ab',
      isNativeBase: false,
    },
  },
};

const ORDER_TYPES = {
  normal: 0,
  gtc: 0,
  fok: 1,
  ioc: 2,
  postonly: 3,
  postOnly: 3,
};

const SELF_MATCHING_OPTIONS = {
  canceltaker: 0,
  cancelmaker: 1,
};

const STOP_PENDING_TYPES = {
  limit: 0,
  market: 1,
};

const STOP_OPERATORS = {
  gte: 0,
  lte: 1,
};

const ZERO_ADDRESS = ethers.ZeroAddress;
const MAX_UINT64 = (1n << 64n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;

function parseCliArgs(argv) {
  const result = { configPath: null, networkOverride: null, once: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--config') {
      result.configPath = argv[i + 1];
      i += 1;
    } else if (arg === '--network') {
      result.networkOverride = argv[i + 1];
      i += 1;
    } else if (arg === '--once') {
      result.once = true;
    }
  }
  return result;
}

function normalizePrivateKey(input) {
  if (!input) {
    return null;
  }
  const trimmed = String(input).trim().replace(/^['"]|['"]$/g, '');
  if (!trimmed) {
    return null;
  }
  return trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
}

async function createProvider(networkConfig) {
  const networkDetectionTimeoutMs = Number(networkConfig.networkDetectionTimeoutMs || 15000);
  const rpcUrls = Array.isArray(networkConfig.rpcUrls) && networkConfig.rpcUrls.length > 0
    ? networkConfig.rpcUrls
    : [networkConfig.rpcUrl];

  const errors = [];
  for (const url of rpcUrls) {
    const provider = new ethers.JsonRpcProvider(url);
    try {
      const network = await Promise.race([
        provider.getNetwork(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('network detection timeout')), networkDetectionTimeoutMs)
        ),
      ]);
      if (Number(network.chainId) !== Number(networkConfig.chainId)) {
        throw new Error(
          `chain mismatch: expected ${networkConfig.chainId}, got ${network.chainId.toString()}`
        );
      }
      return { provider, rpcUrl: url };
    } catch (error) {
      errors.push(`${url}: ${error && error.message ? error.message : String(error)}`);
    }
  }

  throw new Error(`Unable to connect to any RPC. ${errors.join(' | ')}`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function mkdirp(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
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

function appendJsonl(filePath, data) {
  fs.appendFileSync(filePath, `${JSON.stringify(toSerializable(data))}\n`);
}

function formatConsoleEvent(type, payload, filePath) {
  switch (type) {
    case 'botStarted':
      return `Bot started on ${payload.network} with wallet ${payload.walletAddress}. Logs: ${filePath}`;
    case 'wsConnected':
      return `WS connected for ${payload.symbols.join(', ')}`;
    case 'wsInitialData':
      return payload.received
        ? `Initial market data received for ${payload.symbols.join(', ')}`
        : `No initial WS snapshot yet; using RPC fallback for ${payload.symbols.join(', ')}`;
    case 'makerBookSnapshot':
      return `TOB ${payload.market}: bid=${payload.bestBid} ask=${payload.bestAsk} spreadBps=${payload.spreadBps} source=${payload.source}`;
    case 'vaultDepositSent':
      return `Vault funded ${payload.market}: ${payload.amount} token=${payload.token}`;
    case 'approvalSent':
      return `Approval sent ${payload.label}: ${payload.amount}`;
    case 'makerSides':
      return `Maker sides ${payload.market}: bid=${payload.placeBid} ask=${payload.placeAsk}`;
    case 'makerOrderPlaced':
      return `Order placed ${payload.market} ${payload.side}: price=${payload.targetPrice} qty=${payload.quantity}`;
    case 'takerBookSnapshot':
      return `IOC book ${payload.market}: bid=${payload.bestBid} ask=${payload.bestAsk} spreadBps=${payload.spreadBps}`;
    case 'takerDecision':
      return `IOC side ${payload.market}: ${payload.side}`;
    case 'takerOrderPlaced':
      return `IOC sent ${payload.market} ${payload.side}: price=${payload.targetPrice} qty=${payload.quantity}`;
    case 'takerSkippedWideSpread':
      return `IOC skipped ${payload.market}: spreadBps=${payload.spreadBps} max=${payload.maxSpreadBps}`;
    case 'takerSkippedBelowCost':
      return `IOC hold ${payload.market}: bid=${payload.sellPrice} min=${payload.minimumSellPrice}`;
    case 'makerSkippedBidInsufficientQuote':
      return `IOC skipped ${payload.market}: insufficient quote required=${payload.requiredQuote} wallet=${payload.quoteWallet ?? 'n/a'} vault=${payload.quoteVault ?? 'n/a'}`;
    case 'makerSkippedAskInsufficientBase':
      return `IOC skipped ${payload.market}: insufficient base required=${payload.requiredBase} available=${payload.availableBase ?? 'n/a'} wallet=${payload.baseWallet ?? 'n/a'} vault=${payload.baseVault ?? 'n/a'}`;
    case 'inventoryCostLoaded':
      return `Cost loaded ${payload.market}: lastBuy=${payload.lastInventoryBuyPrice}`;
    case 'inventoryCostUpdated':
      return `Cost updated ${payload.market}: lastBuy=${payload.lastInventoryBuyPrice}`;
    case 'inventoryCostCleared':
      return `Cost cleared ${payload.market}`;
    case 'supabaseStateLoaded':
      return `Supabase state loaded: ${payload.botId}`;
    case 'supabaseStateSaved':
      return `Supabase state saved: ${payload.botId}`;
    case 'supabaseStateLoadFailed':
      return `Supabase load failed: ${payload.message}`;
    case 'supabaseStateSaveFailed':
      return `Supabase save failed: ${payload.message}`;
    case 'startupOrderReset':
      return `Startup reset ${payload.market}: cancelled=${payload.cancelled}`;
    case 'orderCancelled':
      return `Order cancelled ${payload.market}: ${payload.orderId}`;
    case 'orderCancelFailed':
      return `Cancel failed ${payload.market}: ${payload.orderId}`;
    case 'strategyError':
      return `Strategy error ${payload.market}: ${payload.message}`;
    case 'botStopping':
      return `Bot stopping: ${payload.reason}`;
    case 'botStopped':
      return `Bot stopped. Logs: ${filePath}`;
    default:
      return null;
  }
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

function resolveNetworkName(config, networkOverride) {
  const networkName = networkOverride || config.network;
  if (!networkName || !DEFAULT_NETWORKS[networkName]) {
    throw new Error(`Unsupported network: ${networkName}`);
  }
  return networkName;
}

function resolveNetworkConfig(config, networkName) {
  return {
    ...DEFAULT_NETWORKS[networkName],
    ...((config.networks && config.networks[networkName]) || {}),
  };
}

function resolveWallet(config, provider) {
  const walletConfig = config.wallet || {};
  const envVar = walletConfig.privateKeyEnvVar || 'PRIVATE_KEY';
  const privateKey = normalizePrivateKey(walletConfig.privateKey || process.env[envVar]);
  if (!privateKey) {
    return null;
  }
  return new ethers.NonceManager(new ethers.Wallet(privateKey, provider));
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

function normalizeOrderType(input) {
  const normalized = String(input || 'postOnly');
  const key = normalized.toLowerCase();
  if (!(key in ORDER_TYPES)) {
    throw new Error(`Unsupported order type: ${input}`);
  }
  return ORDER_TYPES[key];
}

function normalizeSelfMatchingOption(input) {
  const normalized = String(input || 'cancelTaker').toLowerCase();
  if (!(normalized in SELF_MATCHING_OPTIONS)) {
    throw new Error(`Unsupported self-matching option: ${input}`);
  }
  return SELF_MATCHING_OPTIONS[normalized];
}

function normalizeStopPendingType(input) {
  const normalized = String(input || 'market').toLowerCase();
  if (!(normalized in STOP_PENDING_TYPES)) {
    throw new Error(`Unsupported stop pending order type: ${input}`);
  }
  return STOP_PENDING_TYPES[normalized];
}

function normalizeStopOperator(input, isBid) {
  if (input) {
    const normalized = String(input).toLowerCase();
    if (!(normalized in STOP_OPERATORS)) {
      throw new Error(`Unsupported stop operator: ${input}`);
    }
    return STOP_OPERATORS[normalized];
  }
  return isBid ? STOP_OPERATORS.gte : STOP_OPERATORS.lte;
}

function buildFutureExpireTimestampNs(secondsFromNow) {
  return BigInt(Math.floor(Date.now() / 1000) + secondsFromNow) * 1_000_000_000n;
}

function computeBps(numerator, denominator) {
  if (denominator === 0n) {
    return 0n;
  }
  return (numerator * 10_000n) / denominator;
}

function parsePercent(value, fieldName) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid percent for ${fieldName}: ${value}`);
  }
  return Math.floor(parsed);
}

function amountFromPercent(total, percent) {
  if (percent === null) {
    return null;
  }
  return (total * BigInt(percent)) / 100n;
}

function getMidpoint(bestBid, bestAsk) {
  return (bestBid + bestAsk) / 2n;
}

function differenceAbs(a, b) {
  return a >= b ? a - b : b - a;
}

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

function formatUnitsSafe(value, decimals) {
  try {
    return ethers.formatUnits(value, decimals);
  } catch {
    return value.toString();
  }
}

class TxQueue {
  constructor() {
    this.tail = Promise.resolve();
  }

  enqueue(label, task) {
    const run = this.tail.then(async () => task());
    this.tail = run.catch(() => undefined);
    return run;
  }
}

function createLogger(filePath) {
  return {
    event(type, payload) {
      appendJsonl(filePath, { at: nowIso(), type, ...payload });
      const consoleLine = formatConsoleEvent(type, payload, filePath);
      if (consoleLine) {
        console.log(consoleLine);
      }
    },
  };
}

function reviveNullableBigInt(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  return parseBigIntValue(value, 'persistedBigInt');
}

function markPersistentStateDirty(ctx) {
  ctx.persistentStateDirty = true;
}

class PublicMarketFeed {
  constructor(ctx, options) {
    this.ctx = ctx;
    this.wsUrl = options.wsUrl;
    this.symbolContexts = options.symbolContexts;
    this.staleAfterMs = Number(options.staleAfterMs || 45000);
    this.reconnectDelayMs = Number(options.reconnectDelayMs || 3000);
    this.pingEveryMs = Number(options.pingEveryMs || 25000);
    this.books = new Map();
    this.ws = null;
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.closed = false;
    this.connected = false;
    this.initialDataResolvers = [];
  }

  start() {
    this.connect();
  }

  stop() {
    this.closed = true;
    this.connected = false;
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      const socket = this.ws;
      this.ws = null;
      try {
        if (socket.readyState === WebSocket.CONNECTING) {
          socket.once('error', () => undefined);
          socket.terminate();
        } else if (
          socket.readyState === WebSocket.OPEN ||
          socket.readyState === WebSocket.CLOSING
        ) {
          socket.close();
        }
      } catch {
        // ignore close errors
      }
    }
  }

  connect() {
    if (this.closed || this.ws) {
      return;
    }

    this.ws = new WebSocket(this.wsUrl);

    this.ws.on('open', () => {
      this.connected = true;
      this.ctx.logger.event('wsConnected', {
        wsUrl: this.wsUrl,
        symbols: [...this.symbolContexts.keys()],
      });
      this.send({
        operation: 'subscribe',
        channel: 'orderbook',
        params: { symbols: [...this.symbolContexts.keys()] },
      });
      this.pingTimer = setInterval(() => {
        this.send({ operation: 'ping' });
      }, this.pingEveryMs);
    });

    this.ws.on('message', (data) => {
      try {
        this.handleMessage(String(data));
      } catch (error) {
        this.ctx.logger.event('wsMessageError', {
          message: error && error.message ? error.message : String(error),
        });
      }
    });

    this.ws.on('close', (code) => {
      this.connected = false;
      this.ctx.logger.event('wsClosed', { code });
      this.cleanupSocket();
      this.scheduleReconnect();
    });

    this.ws.on('error', (error) => {
      if (this.closed) {
        return;
      }
      this.ctx.logger.event('wsError', {
        message: error && error.message ? error.message : String(error),
      });
    });
  }

  cleanupSocket() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws = null;
    }
  }

  scheduleReconnect() {
    if (this.closed || this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelayMs);
  }

  send(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send(JSON.stringify(payload));
  }

  handleMessage(rawMessage) {
    const message = JSON.parse(rawMessage);

    if (message.operation === 'pong') {
      return;
    }

    if (message.channel === 'error') {
      this.ctx.logger.event('wsChannelError', {
        message: message.message || 'unknown websocket error',
      });
      return;
    }

    if (message.channel === 'orderbook' && (message.type === 'snapshot' || message.type === 'update')) {
      const marketContext = this.symbolContexts.get(message.symbol);
      if (!marketContext) {
        return;
      }
      const book = this.books.get(message.symbol) || {
        bids: new Map(),
        asks: new Map(),
        lastUpdateMs: 0,
        source: 'websocket',
      };

      if (message.type === 'snapshot') {
        book.bids.clear();
        book.asks.clear();
      }

      this.applyLevels(book.bids, message.bids || [], marketContext.quoteDecimals, marketContext.baseDecimals);
      this.applyLevels(book.asks, message.asks || [], marketContext.quoteDecimals, marketContext.baseDecimals);
      book.lastUpdateMs = Number(message.timestamp || Date.now());
      this.books.set(message.symbol, book);
      this.resolveInitialDataWaiters();

      this.ctx.logger.event('wsOrderbook', {
        symbol: message.symbol,
        type: message.type,
        bestBid: this.getBestLevel(book.bids, 'desc'),
        bestAsk: this.getBestLevel(book.asks, 'asc'),
        timestamp: book.lastUpdateMs,
      });
    }
  }

  applyLevels(targetMap, levels, quoteDecimals, baseDecimals) {
    for (const level of levels) {
      const price = ethers.parseUnits(level.price, quoteDecimals);
      const quantity = ethers.parseUnits(level.quantity, baseDecimals);
      const key = price.toString();
      if (quantity === 0n) {
        targetMap.delete(key);
      } else {
        targetMap.set(key, { price, quantity });
      }
    }
  }

  getBestLevel(levelMap, direction) {
    let best = null;
    for (const level of levelMap.values()) {
      if (!best) {
        best = level;
        continue;
      }
      if (direction === 'desc' && level.price > best.price) {
        best = level;
      }
      if (direction === 'asc' && level.price < best.price) {
        best = level;
      }
    }
    return best;
  }

  resolveInitialDataWaiters() {
    if (this.initialDataResolvers.length === 0) {
      return;
    }
    for (const resolver of this.initialDataResolvers.splice(0)) {
      resolver();
    }
  }

  hasFreshBook(symbol) {
    const book = this.books.get(symbol);
    return Boolean(book && Date.now() - book.lastUpdateMs <= this.staleAfterMs);
  }

  async waitForInitialData(symbols, timeoutMs) {
    const pendingSymbols = symbols.filter((symbol) => !this.hasFreshBook(symbol));
    if (pendingSymbols.length === 0) {
      return true;
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);

      const check = () => {
        if (pendingSymbols.every((symbol) => this.hasFreshBook(symbol))) {
          cleanup();
          resolve(true);
        }
      };

      const cleanup = () => {
        clearTimeout(timeout);
        const index = this.initialDataResolvers.indexOf(check);
        if (index >= 0) {
          this.initialDataResolvers.splice(index, 1);
        }
      };

      this.initialDataResolvers.push(check);
      check();
    });
  }

  getTopOfBook(symbol, depth = 1) {
    const book = this.books.get(symbol);
    if (!book) {
      return null;
    }

    const ageMs = Date.now() - book.lastUpdateMs;
    if (ageMs > this.staleAfterMs) {
      return null;
    }

    const bids = [...book.bids.values()].sort((a, b) => (a.price > b.price ? -1 : a.price < b.price ? 1 : 0)).slice(0, depth);
    const asks = [...book.asks.values()].sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0)).slice(0, depth);

    return {
      bids,
      asks,
      bestBid: bids[0] ? bids[0].price : 0n,
      bestAsk: asks[0] ? asks[0].price : 0n,
      source: 'websocket',
      ageMs,
      timestampMs: book.lastUpdateMs,
    };
  }
}

async function getMarketContext(ctx, symbol) {
  if (!ctx.marketCache[symbol]) {
    const market = resolveMarket(ctx.config, ctx.networkName, symbol);
    const poolRead = new ethers.Contract(market.pool, SPOT_POOL_ABI, ctx.provider);
    const poolOwnerRead = ctx.signer ? poolRead.connect(ctx.signer) : null;
    const params = await poolRead.getPoolParams();
    const baseToken = params[0];
    const quoteToken = params[1];
    const tickSize = params[4];
    const minQuantity = params[5];
    const lotSize = params[6];
    const baseTokenContract = new ethers.Contract(baseToken, ERC20_ABI, ctx.provider);
    const quoteTokenContract = new ethers.Contract(quoteToken, ERC20_ABI, ctx.provider);
    const [baseDecimals, quoteDecimals, baseSymbol, quoteSymbol] = await Promise.all([
      baseTokenContract.decimals().catch(() => 18),
      quoteTokenContract.decimals(),
      baseTokenContract.symbol().catch(() => market.symbol.split(':')[0]),
      quoteTokenContract.symbol().catch(() => market.symbol.split(':')[1]),
    ]);
    ctx.marketCache[symbol] = {
      ctx,
      market,
      poolRead,
      poolOwnerRead,
      poolWrite: poolOwnerRead,
      stopRead: market.stopRegistry ? new ethers.Contract(market.stopRegistry, STOP_REGISTRY_ABI, ctx.provider) : null,
      stopWrite:
        ctx.signer && market.stopRegistry
          ? new ethers.Contract(market.stopRegistry, STOP_REGISTRY_ABI, ctx.signer)
          : null,
      baseToken,
      quoteToken,
      tickSize,
      minQuantity,
      lotSize,
      baseTokenContract,
      quoteTokenContract,
      baseDecimals,
      quoteDecimals,
      baseSymbol,
      quoteSymbol,
    };
  }
  return ctx.marketCache[symbol];
}

async function getVaultBalances(ctx, marketContext) {
  const owner = ctx.walletAddress;
  const [baseVault, quoteVault] = await Promise.all([
    marketContext.poolRead.getWithdrawableBalance(owner, marketContext.baseToken),
    marketContext.poolRead.getWithdrawableBalance(owner, marketContext.quoteToken),
  ]);
  return { baseVault, quoteVault };
}

async function getLockedVaultBalances(marketContext, orders) {
  let lockedBase = 0n;
  let lockedQuote = 0n;

  const bidOrders = orders.filter((order) => order.isBid);
  const quoteLocks = await Promise.all(
    bidOrders.map((order) =>
      marketContext.poolRead.convertToQuoteAtPriceCeil(order.quantityRemaining, order.price)
    )
  );

  for (const order of orders) {
    if (!order.isBid) {
      lockedBase += order.quantityRemaining;
    }
  }
  for (const quoteAmount of quoteLocks) {
    lockedQuote += BigInt(quoteAmount);
  }

  return { lockedBase, lockedQuote };
}

async function getWalletBalances(ctx, marketContext) {
  const [quoteWallet, baseWalletToken] = await Promise.all([
    marketContext.quoteTokenContract.balanceOf(ctx.walletAddress),
    marketContext.market.isNativeBase
      ? Promise.resolve(0n)
      : marketContext.baseTokenContract.balanceOf(ctx.walletAddress),
  ]);

  let baseWallet = baseWalletToken;
  if (marketContext.market.isNativeBase) {
    const nativeBalance = await ctx.provider.getBalance(ctx.walletAddress);
    const reserve = parseBigIntValue(ctx.bot.nativeGasReserveWei || '0', 'nativeGasReserveWei');
    baseWallet = nativeBalance > reserve ? nativeBalance - reserve : 0n;
  }

  return {
    baseWallet,
    quoteWallet,
  };
}

async function ensureApproval(ctx, tokenContract, spender, requiredAmount, label) {
  const allowance = await tokenContract.allowance(ctx.walletAddress, spender);
  if (allowance >= requiredAmount) {
    return;
  }

  const configuredApprovalAmount =
    ctx.bot && ctx.bot.approvalAmount !== undefined
      ? parseBigIntValue(ctx.bot.approvalAmount, 'approvalAmount')
      : null;
  const approvalAmount =
    configuredApprovalAmount !== null && configuredApprovalAmount >= requiredAmount
      ? configuredApprovalAmount
      : (configuredApprovalAmount !== null ? requiredAmount : MAX_UINT256);

  const dryRun = ctx.currentStrategyDryRun ?? ctx.dryRun;
  if (dryRun) {
    ctx.logger.event('approvalDryRun', {
      label,
      spender,
      amount: approvalAmount,
    });
    return;
  }

  const tx = await sendQueuedTx(ctx, `approve-${label}`, async () => {
    const txResponse = await tokenContract.connect(ctx.signer).approve(spender, approvalAmount);
    const receipt = await txResponse.wait(ctx.confirmations);
    return { txResponse, receipt };
  });

  ctx.logger.event('approvalSent', {
    label,
    spender,
    amount: approvalAmount,
    txHash: tx.txResponse.hash,
    gasUsed: tx.receipt.gasUsed,
  });
}

async function depositToVault(ctx, marketContext, token, amount, isNative, reason) {
  if (amount <= 0n) {
    return;
  }

  const dryRun = ctx.currentStrategyDryRun ?? ctx.dryRun;
  if (dryRun) {
    ctx.logger.event('vaultDepositDryRun', {
      market: marketContext.market.symbol,
      token,
      amount,
      isNative,
      reason,
    });
    return;
  }

  const tx = await sendQueuedTx(ctx, `deposit-${marketContext.market.symbol}-${token}`, async () => {
    let txResponse;
    if (isNative) {
      txResponse = await marketContext.poolWrite.depositNative({ value: amount });
    } else {
      txResponse = await marketContext.poolWrite.deposit(token, amount);
    }
    const receipt = await txResponse.wait(ctx.confirmations);
    return { txResponse, receipt };
  });

  ctx.logger.event('vaultDepositSent', {
    market: marketContext.market.symbol,
    token,
    amount,
    isNative,
    reason,
    txHash: tx.txResponse.hash,
    gasUsed: tx.receipt.gasUsed,
  });
}

async function maybeAutoFundVault(ctx, marketContext, strategy, balances, walletBalances) {
  if (!strategy.autoFund) {
    return balances;
  }

  const updated = { ...balances };
  updated.syntheticFunding = false;
  const totalBase = updated.totalBaseVault + walletBalances.baseWallet;
  const totalQuote = updated.totalQuoteVault + walletBalances.quoteWallet;
  const targetBaseVault =
    strategy.targetBaseVault !== undefined
      ? parseBigIntValue(strategy.targetBaseVault, 'targetBaseVault')
      : amountFromPercent(totalBase, parsePercent(strategy.targetBaseVaultPercent, 'targetBaseVaultPercent')) || 0n;
  const targetQuoteVault =
    strategy.targetQuoteVault !== undefined
      ? parseBigIntValue(strategy.targetQuoteVault, 'targetQuoteVault')
      : amountFromPercent(totalQuote, parsePercent(strategy.targetQuoteVaultPercent, 'targetQuoteVaultPercent')) || 0n;
  const maxBaseFundPerCycle = parseBigIntValue(
    strategy.maxBaseFundPerCycle || targetBaseVault || '0',
    'maxBaseFundPerCycle'
  );
  const maxQuoteFundPerCycle = parseBigIntValue(
    strategy.maxQuoteFundPerCycle || targetQuoteVault || '0',
    'maxQuoteFundPerCycle'
  );

  if (targetBaseVault > updated.totalBaseVault) {
    const deficit = targetBaseVault - updated.totalBaseVault;
    const amount = [deficit, maxBaseFundPerCycle, walletBalances.baseWallet].reduce((min, value) =>
      value < min ? value : min
    );
    if (amount > 0n) {
      if (!marketContext.market.isNativeBase) {
        await ensureApproval(ctx, marketContext.baseTokenContract, marketContext.market.pool, amount, `${marketContext.market.symbol}-base`);
      }
      await depositToVault(
        ctx,
        marketContext,
        marketContext.baseToken,
        amount,
        marketContext.market.isNativeBase,
        'target-base-vault'
      );
      updated.baseVault += amount;
      updated.totalBaseVault += amount;
      walletBalances.baseWallet -= amount;
      if (ctx.currentStrategyDryRun ?? ctx.dryRun) {
        updated.syntheticFunding = true;
      }
    }
  }

  if (targetQuoteVault > updated.totalQuoteVault) {
    const deficit = targetQuoteVault - updated.totalQuoteVault;
    const amount = [deficit, maxQuoteFundPerCycle, walletBalances.quoteWallet].reduce((min, value) =>
      value < min ? value : min
    );
    if (amount > 0n) {
      await ensureApproval(ctx, marketContext.quoteTokenContract, marketContext.market.pool, amount, `${marketContext.market.symbol}-quote`);
      await depositToVault(
        ctx,
        marketContext,
        marketContext.quoteToken,
        amount,
        false,
        'target-quote-vault'
      );
      updated.quoteVault += amount;
      updated.totalQuoteVault += amount;
      walletBalances.quoteWallet -= amount;
      if (ctx.currentStrategyDryRun ?? ctx.dryRun) {
        updated.syntheticFunding = true;
      }
    }
  }

  return updated;
}

async function getTopOfBook(marketContext, depth = 1) {
  const wsBook = marketContext.ctx.marketFeed ? marketContext.ctx.marketFeed.getTopOfBook(marketContext.market.symbol, depth) : null;
  if (wsBook) {
    return wsBook;
  }
  const [bids, asks] = await Promise.all([
    marketContext.poolRead.getBookLevels(true, depth),
    marketContext.poolRead.getBookLevels(false, depth),
  ]);
  return {
    bids,
    asks,
    bestBid: bids[0] ? bids[0].price : 0n,
    bestAsk: asks[0] ? asks[0].price : 0n,
    source: 'rpc',
    ageMs: 0,
    timestampMs: Date.now(),
  };
}

function getOwnOrderReader(marketContext) {
  return marketContext.poolOwnerRead || marketContext.poolRead;
}

async function getOwnOpenOrderIds(marketContext) {
  return getOwnOrderReader(marketContext).getOwnOpenOrders();
}

function normalizeOrderRecord(order) {
  return {
    orderId: BigInt(order.orderId),
    isBid: Boolean(order.isBid),
    owner: order.owner,
    userData: BigInt(order.userData),
    price: BigInt(order.price),
    fullQuantity: BigInt(order.fullQuantity),
    quantityRemaining: BigInt(order.quantityRemaining),
    expireTimestampNs: BigInt(order.expireTimestampNs),
  };
}

async function getOwnOpenOrdersDetailed(marketContext) {
  const orderIds = await getOwnOpenOrderIds(marketContext);
  const orders = await Promise.all(orderIds.map((orderId) => marketContext.poolRead.getOrder(orderId)));
  return orders.map((order) => normalizeOrderRecord(order));
}

async function sendQueuedTx(ctx, label, task) {
  return ctx.txQueue.enqueue(label, task);
}

async function resolveWalletFundingOverrides(ctx, marketContext, sideLabel, quantity, targetPrice) {
  if (sideLabel === 'bid') {
    const requiredQuote = await marketContext.poolRead.convertToQuoteAtPriceCeil(quantity, targetPrice);
    await ensureApproval(
      ctx,
      marketContext.quoteTokenContract,
      marketContext.market.pool,
      requiredQuote,
      `${marketContext.market.symbol}-wallet-quote`
    );
    return {};
  }

  if (marketContext.market.isNativeBase) {
    return { value: quantity };
  }

  await ensureApproval(
    ctx,
    marketContext.baseTokenContract,
    marketContext.market.pool,
    quantity,
    `${marketContext.market.symbol}-wallet-base`
  );
  return {};
}

async function cancelOrder(ctx, marketContext, orderId, reason) {
  if (!marketContext.poolWrite) {
    throw new Error('cancelOrder requires a signer');
  }
  try {
    const tx = await sendQueuedTx(ctx, `cancel-${orderId.toString()}`, async () => {
      const txResponse = await marketContext.poolWrite.cancelOrder(orderId);
      const receipt = await txResponse.wait(ctx.confirmations);
      return { txResponse, receipt };
    });
    ctx.logger.event('orderCancelled', {
      market: marketContext.market.symbol,
      orderId,
      reason,
      txHash: tx.txResponse.hash,
      gasUsed: tx.receipt.gasUsed,
    });
    return true;
  } catch (error) {
    ctx.logger.event('orderCancelFailed', {
      market: marketContext.market.symbol,
      orderId,
      reason,
      message: error && error.message ? error.message : String(error),
    });
    return false;
  }
}

function getManagedOpenIds(state) {
  return [state.bidOrderId, state.askOrderId].filter(Boolean).map((value) => BigInt(value));
}

async function cancelManagedOrders(ctx, marketContext, state, reason) {
  const orderIds = getManagedOpenIds(state);
  for (const orderId of orderIds) {
    await cancelOrder(ctx, marketContext, orderId, reason);
  }
  state.bidOrderId = null;
  state.askOrderId = null;
  state.bidQuantityRemaining = null;
  state.askQuantityRemaining = null;
}

async function cancelAllOwnOrders(ctx, marketContext, reason) {
  const orderIds = await getOwnOpenOrderIds(marketContext);
  for (const orderId of orderIds) {
    await cancelOrder(ctx, marketContext, orderId, reason);
  }
}

function shouldRequote(existingId, existingPrice, targetPrice, lastPlacedAt, strategy, tickSize) {
  if (!existingId) {
    return true;
  }
  const requoteThresholdTicks = BigInt(strategy.requoteThresholdTicks || 1);
  const ttlMs = Number(strategy.quoteTtlMs || 45000);
  const priceMoved = differenceAbs(existingPrice || 0n, targetPrice) >= tickSize * requoteThresholdTicks;
  const expired = !lastPlacedAt || Date.now() - lastPlacedAt >= ttlMs;
  return priceMoved || expired;
}

function buildPlaceOrderArgs(ctx, strategy, targetPrice, quantity, isBid) {
  const userData = strategy.userData !== undefined ? parseBigIntValue(strategy.userData, 'userData') : 0n;
  const expireTimestampNs =
    strategy.expireTimestampNs !== undefined
      ? parseBigIntValue(strategy.expireTimestampNs, 'expireTimestampNs')
      : buildFutureExpireTimestampNs(ctx.expireSecondsFromNow);

  if (expireTimestampNs === 0n) {
    throw new Error('expireTimestampNs = 0 is not allowed');
  }

  return [
    isBid,
    toUint64(userData, 'userData'),
    targetPrice,
    quantity,
    toUint64(expireTimestampNs, 'expireTimestampNs'),
    normalizeOrderType(strategy.orderType || 'postOnly'),
    normalizeSelfMatchingOption(strategy.selfMatchingOption || 'cancelTaker'),
    ZERO_ADDRESS,
    0n,
  ];
}

async function placeMakerOrder(ctx, marketContext, strategy, state, sideLabel, targetPrice, quantity) {
  if (!marketContext.poolWrite) {
    throw new Error('placeMakerOrder requires a signer');
  }

  const isBid = sideLabel === 'bid';
  const args = buildPlaceOrderArgs(ctx, strategy, targetPrice, quantity, isBid);
  const beforeIds = new Set((await getOwnOpenOrderIds(marketContext)).map((value) => value.toString()));
  const simulation = await marketContext.poolWrite.placeOrder.staticCall(...args);

  if (!simulation[0]) {
    ctx.logger.event('makerSimulationRejected', {
      market: marketContext.market.symbol,
      side: sideLabel,
      targetPrice,
      quantity,
    });
    return null;
  }

  if (strategy.dryRun ?? ctx.dryRun) {
    ctx.logger.event('makerDryRunPlace', {
      market: marketContext.market.symbol,
      side: sideLabel,
      targetPrice,
      quantity,
    });
    return null;
  }

  const tx = await sendQueuedTx(ctx, `place-${marketContext.market.symbol}-${sideLabel}`, async () => {
    const txResponse = await marketContext.poolWrite.placeOrder(...args);
    const receipt = await txResponse.wait(ctx.confirmations);
    return { txResponse, receipt };
  });

  const afterIds = new Set((await getOwnOpenOrderIds(marketContext)).map((value) => value.toString()));
  const newIds = [...afterIds].filter((value) => !beforeIds.has(value));
  const orderId = newIds.length > 0 ? BigInt(newIds[0]) : BigInt(simulation[1]);

  if (sideLabel === 'bid') {
    state.bidOrderId = orderId;
    state.bidPrice = targetPrice;
    state.bidPlacedAt = Date.now();
    state.bidQuantityRemaining = quantity;
  } else {
    state.askOrderId = orderId;
    state.askPrice = targetPrice;
    state.askPlacedAt = Date.now();
    state.askQuantityRemaining = quantity;
  }

  ctx.logger.event('makerOrderPlaced', {
    market: marketContext.market.symbol,
    side: sideLabel,
    targetPrice,
    quantity,
    orderId,
    txHash: tx.txResponse.hash,
    gasUsed: tx.receipt.gasUsed,
  });

  return orderId;
}

function logSyntheticMakerPlacement(ctx, marketContext, sideLabel, targetPrice, quantity) {
  ctx.logger.event('makerWouldPlaceAfterFunding', {
    market: marketContext.market.symbol,
    side: sideLabel,
    targetPrice,
    quantity,
  });
}

function selectExistingOrderCandidate(orders, sideLabel, targetPrice) {
  const isBid = sideLabel === 'bid';
  const sideOrders = orders.filter((order) => order.isBid === isBid);
  if (sideOrders.length === 0) {
    return { adopted: null, extras: [] };
  }

  const sorted = [...sideOrders].sort((a, b) => {
    const distanceA = differenceAbs(a.price, targetPrice);
    const distanceB = differenceAbs(b.price, targetPrice);
    if (distanceA !== distanceB) {
      return distanceA < distanceB ? -1 : 1;
    }
    if (a.price !== b.price) {
      if (isBid) {
        return a.price > b.price ? -1 : 1;
      }
      return a.price < b.price ? -1 : 1;
    }
    return a.orderId < b.orderId ? -1 : 1;
  });

  return {
    adopted: sorted[0],
    extras: sorted.slice(1),
  };
}

function adoptOrderIntoState(state, sideLabel, order) {
  if (sideLabel === 'bid') {
    state.bidOrderId = order.orderId;
    state.bidPrice = order.price;
    state.bidPlacedAt = Date.now();
    state.bidQuantityRemaining = order.quantityRemaining;
  } else {
    state.askOrderId = order.orderId;
    state.askPrice = order.price;
    state.askPlacedAt = Date.now();
    state.askQuantityRemaining = order.quantityRemaining;
  }
}

function clearMakerSideState(state, sideLabel) {
  if (sideLabel === 'bid') {
    state.bidOrderId = null;
    state.bidPrice = null;
    state.bidPlacedAt = null;
    state.bidQuantityRemaining = null;
    return;
  }
  state.askOrderId = null;
  state.askPrice = null;
  state.askPlacedAt = null;
  state.askQuantityRemaining = null;
}

async function reconcileExistingMakerOrders(ctx, marketContext, strategy, state, bidTarget, askTarget, existingOrders) {
  const needsBid = strategy.placeBid !== false && !state.bidOrderId;
  const needsAsk = strategy.placeAsk === true && !state.askOrderId;
  if (!needsBid && !needsAsk) {
    return;
  }

  const orders = existingOrders || (await getOwnOpenOrdersDetailed(marketContext));
  if (orders.length === 0) {
    return;
  }

  const adoptedSummaries = [];

  if (needsBid) {
    const { adopted, extras } = selectExistingOrderCandidate(orders, 'bid', bidTarget);
    if (adopted) {
      adoptOrderIntoState(state, 'bid', adopted);
      adoptedSummaries.push({
        side: 'bid',
        orderId: adopted.orderId,
        price: adopted.price,
        quantityRemaining: adopted.quantityRemaining,
      });
    }
    if (extras.length > 0) {
      ctx.logger.event('makerExtraOrdersDetected', {
        market: marketContext.market.symbol,
        side: 'bid',
        orderIds: extras.map((order) => order.orderId),
      });
      if (!(strategy.dryRun ?? ctx.dryRun)) {
        for (const extra of extras) {
          await cancelOrder(ctx, marketContext, extra.orderId, 'reconcile-extra-bid');
        }
      }
    }
  }

  if (needsAsk) {
    const { adopted, extras } = selectExistingOrderCandidate(orders, 'ask', askTarget);
    if (adopted) {
      adoptOrderIntoState(state, 'ask', adopted);
      adoptedSummaries.push({
        side: 'ask',
        orderId: adopted.orderId,
        price: adopted.price,
        quantityRemaining: adopted.quantityRemaining,
      });
    }
    if (extras.length > 0) {
      ctx.logger.event('makerExtraOrdersDetected', {
        market: marketContext.market.symbol,
        side: 'ask',
        orderIds: extras.map((order) => order.orderId),
      });
      if (!(strategy.dryRun ?? ctx.dryRun)) {
        for (const extra of extras) {
          await cancelOrder(ctx, marketContext, extra.orderId, 'reconcile-extra-ask');
        }
      }
    }
  }

  for (const summary of adoptedSummaries) {
    ctx.logger.event('makerOrderAdopted', {
      market: marketContext.market.symbol,
      ...summary,
    });
  }
}

function computeTargetPrices(strategy, bestBid, bestAsk, tickSize) {
  const improveTicks = BigInt(strategy.improveTicks || 0);
  let bidTarget = bestBid;
  let askTarget = bestAsk;

  if (improveTicks > 0n) {
    const improvedBid = bestBid + tickSize * improveTicks;
    if (improvedBid < bestAsk) {
      bidTarget = improvedBid;
    }
    const improvedAsk = bestAsk - tickSize * improveTicks;
    if (improvedAsk > bestBid) {
      askTarget = improvedAsk;
    }
  }

  if (bidTarget >= askTarget && bestBid < bestAsk) {
    bidTarget = bestBid;
    askTarget = bestAsk;
  }

  return {
    bidTarget: alignToTick(bidTarget, tickSize, 'down'),
    askTarget: alignToTick(askTarget, tickSize, 'up'),
  };
}

function computeIocTargetPrice(sideLabel, bestBid, bestAsk, tickSize, crossTicks) {
  if (sideLabel === 'bid') {
    return alignToTick(bestAsk + tickSize * crossTicks, tickSize, 'up');
  }
  const rawTarget = bestBid > tickSize * crossTicks ? bestBid - tickSize * crossTicks : bestBid;
  return alignToTick(rawTarget, tickSize, 'down');
}

function computeMinimumSellPrice(entryPrice, minRoundTripBps, tickSize) {
  const basePrice = entryPrice || 0n;
  const markup = minRoundTripBps > 0n
    ? (basePrice * (10_000n + minRoundTripBps) + 9_999n) / 10_000n
    : basePrice;
  return alignToTick(markup, tickSize, 'up');
}

function selectTakerFunding(sideLabel, balances, walletBalances, requiredQuote) {
  if (sideLabel === 'ask') {
    if (balances.baseVault > 0n) {
      return {
        fundingSource: 'vault',
        availableQuantity: balances.baseVault,
      };
    }
    if (walletBalances.baseWallet > 0n) {
      return {
        fundingSource: 'wallet',
        availableQuantity: walletBalances.baseWallet,
      };
    }
    return null;
  }

  if (walletBalances.quoteWallet >= requiredQuote) {
    return {
      fundingSource: 'wallet',
      availableQuantity: walletBalances.quoteWallet,
    };
  }
  if (balances.quoteVault >= requiredQuote) {
    return {
      fundingSource: 'vault',
      availableQuantity: balances.quoteVault,
    };
  }
  return null;
}

function chooseMakerSides(strategy, balances, walletBalances) {
  let placeBid = strategy.placeBid !== false;
  let placeAsk = strategy.placeAsk === true;

  const preferBalancedInventory = strategy.preferBalancedInventory === true;
  if (!preferBalancedInventory) {
    return { placeBid, placeAsk };
  }

  const totalBase = balances.totalBaseVault + (walletBalances ? walletBalances.baseWallet : 0n);
  const totalQuote = balances.totalQuoteVault + (walletBalances ? walletBalances.quoteWallet : 0n);

  if (totalBase === 0n && totalQuote > 0n) {
    placeAsk = false;
    placeBid = true;
  } else if (totalQuote === 0n && totalBase > 0n) {
    placeBid = false;
    placeAsk = true;
  }

  const minQuoteToBid =
    strategy.minQuoteToBid !== undefined
      ? parseBigIntValue(strategy.minQuoteToBid, 'minQuoteToBid')
      : amountFromPercent(totalQuote, parsePercent(strategy.minQuoteToBidPercent, 'minQuoteToBidPercent')) || 0n;
  const minBaseToAsk =
    strategy.minBaseToAsk !== undefined
      ? parseBigIntValue(strategy.minBaseToAsk, 'minBaseToAsk')
      : amountFromPercent(totalBase, parsePercent(strategy.minBaseToAskPercent, 'minBaseToAskPercent')) || 0n;

  if (balances.totalQuoteVault < minQuoteToBid) {
    placeBid = false;
  }
  if (balances.totalBaseVault < minBaseToAsk) {
    placeAsk = false;
  }

  return { placeBid, placeAsk };
}

async function submitStrategyOrder(ctx, marketContext, strategy, sideLabel, targetPrice, quantity, options = {}) {
  if (!marketContext.poolWrite) {
    throw new Error('submitStrategyOrder requires a signer');
  }

  const isBid = sideLabel === 'bid';
  const fundingSource = options.fundingSource || 'vault';
  const methodName = fundingSource === 'wallet' ? 'placeTakerOrderWithoutVault' : 'placeOrder';
  const args = buildPlaceOrderArgs(ctx, strategy, targetPrice, quantity, isBid);
  const overrides =
    fundingSource === 'wallet'
      ? await resolveWalletFundingOverrides(ctx, marketContext, sideLabel, quantity, targetPrice)
      : {};
  const beforeIds =
    fundingSource === 'vault'
      ? new Set((await getOwnOpenOrderIds(marketContext)).map((value) => value.toString()))
      : new Set();
  const simulation = await marketContext.poolWrite[methodName].staticCall(...args, overrides);

  if (!simulation[0]) {
    return {
      success: false,
      simulation,
      orderId: BigInt(simulation[1]),
      tx: null,
    };
  }

  if (strategy.dryRun ?? ctx.dryRun) {
    return {
      success: true,
      simulation,
      orderId: BigInt(simulation[1]),
      tx: null,
      dryRun: true,
    };
  }

  const tx = await sendQueuedTx(ctx, `place-${marketContext.market.symbol}-${sideLabel}-${strategy.type || 'order'}`, async () => {
    const txResponse = await marketContext.poolWrite[methodName](...args, overrides);
    const receipt = await txResponse.wait(ctx.confirmations);
    return { txResponse, receipt };
  });

  const afterIds =
    fundingSource === 'vault'
      ? new Set((await getOwnOpenOrderIds(marketContext)).map((value) => value.toString()))
      : new Set();
  const newIds = fundingSource === 'vault' ? [...afterIds].filter((value) => !beforeIds.has(value)) : [];

  return {
    success: true,
    simulation,
    orderId: newIds.length > 0 ? BigInt(newIds[0]) : BigInt(simulation[1]),
    tx,
    dryRun: false,
  };
}

async function runMakerSpreadStrategy(ctx, strategy, state) {
  const marketContext = await getMarketContext(ctx, strategy.market);
  ctx.currentStrategyDryRun = strategy.dryRun ?? ctx.dryRun;
  const top = await getTopOfBook(marketContext, 3);

  if (top.bestBid === 0n || top.bestAsk === 0n) {
    ctx.logger.event('makerSkippedNoLiquidity', { market: strategy.market });
    return;
  }

  const midpoint = getMidpoint(top.bestBid, top.bestAsk);
  const spreadBps = computeBps(top.bestAsk - top.bestBid, midpoint);
  const minSpreadBps = BigInt(strategy.minSpreadBps || 1);
  const quantity = parseBigIntValue(strategy.quantity, 'quantity');
  const existingOrders = await getOwnOpenOrdersDetailed(marketContext);
  const openIds = new Set(existingOrders.map((value) => value.orderId.toString()));
  const walletBalances = await getWalletBalances(ctx, marketContext);
  const freeBalances = await getVaultBalances(ctx, marketContext);
  const lockedBalances = await getLockedVaultBalances(marketContext, existingOrders);
  let balances = {
    ...freeBalances,
    lockedBaseVault: lockedBalances.lockedBase,
    lockedQuoteVault: lockedBalances.lockedQuote,
    totalBaseVault: freeBalances.baseVault + lockedBalances.lockedBase,
    totalQuoteVault: freeBalances.quoteVault + lockedBalances.lockedQuote,
  };
  if (strategy.autoFund) {
    balances = await maybeAutoFundVault(ctx, marketContext, strategy, balances, walletBalances);
  }
  const { bidTarget, askTarget } = computeTargetPrices(strategy, top.bestBid, top.bestAsk, marketContext.tickSize);

  await reconcileExistingMakerOrders(ctx, marketContext, strategy, state, bidTarget, askTarget, existingOrders);

  if (state.bidOrderId && !openIds.has(state.bidOrderId.toString())) {
    ctx.logger.event('makerBidNoLongerOpen', { market: strategy.market, orderId: state.bidOrderId });
    clearMakerSideState(state, 'bid');
  }
  if (state.askOrderId && !openIds.has(state.askOrderId.toString())) {
    ctx.logger.event('makerAskNoLongerOpen', { market: strategy.market, orderId: state.askOrderId });
    clearMakerSideState(state, 'ask');
  }

  ctx.logger.event('makerBookSnapshot', {
    market: strategy.market,
    bestBid: top.bestBid,
    bestAsk: top.bestAsk,
    spreadBps,
    source: top.source || 'rpc',
    ageMs: top.ageMs || 0,
    baseVault: balances.baseVault,
    quoteVault: balances.quoteVault,
    lockedBaseVault: balances.lockedBaseVault,
    lockedQuoteVault: balances.lockedQuoteVault,
    totalBaseVault: balances.totalBaseVault,
    totalQuoteVault: balances.totalQuoteVault,
    baseWallet: walletBalances.baseWallet,
    quoteWallet: walletBalances.quoteWallet,
  });

  if (spreadBps < minSpreadBps) {
    if (strategy.cancelWhenSpreadTooTight) {
      if (strategy.managePoolExclusively) {
        if (!(strategy.dryRun ?? ctx.dryRun)) {
          await cancelAllOwnOrders(ctx, marketContext, 'spread-too-tight');
        }
      } else if (!(strategy.dryRun ?? ctx.dryRun)) {
        await cancelManagedOrders(ctx, marketContext, state, 'spread-too-tight');
      }
    }
    ctx.logger.event('makerSkippedTightSpread', {
      market: strategy.market,
      spreadBps,
      minSpreadBps,
    });
    return;
  }

  if (strategy.managePoolExclusively && (state.initialized !== true || Number(strategy.forceRefreshEveryCycles || 0) > 0)) {
    state.initialized = true;
  }

  const dryRun = strategy.dryRun ?? ctx.dryRun;
  const { placeBid, placeAsk } = chooseMakerSides(strategy, balances, walletBalances);
  ctx.logger.event('makerSides', {
    market: strategy.market,
    placeBid,
    placeAsk,
  });

  if (strategy.managePoolExclusively) {
    const needsExclusiveRefresh =
      shouldRequote(state.bidOrderId, state.bidPrice, bidTarget, state.bidPlacedAt, strategy, marketContext.tickSize) ||
      shouldRequote(state.askOrderId, state.askPrice, askTarget, state.askPlacedAt, strategy, marketContext.tickSize);
    if (needsExclusiveRefresh) {
      if (dryRun) {
        ctx.logger.event('makerDryRunCancelAll', { market: strategy.market, reason: 'exclusive-refresh' });
      } else {
        await cancelAllOwnOrders(ctx, marketContext, 'exclusive-refresh');
      }
      state.bidOrderId = null;
      state.askOrderId = null;
      state.bidPrice = null;
      state.askPrice = null;
      state.bidPlacedAt = null;
      state.askPlacedAt = null;
    }
  } else {
    if (state.bidOrderId && shouldRequote(state.bidOrderId, state.bidPrice, bidTarget, state.bidPlacedAt, strategy, marketContext.tickSize)) {
      if (dryRun) {
        ctx.logger.event('makerDryRunCancel', { market: strategy.market, side: 'bid', orderId: state.bidOrderId });
      } else {
        await cancelOrder(ctx, marketContext, state.bidOrderId, 'requote-bid');
      }
      clearMakerSideState(state, 'bid');
    }
    if (state.askOrderId && shouldRequote(state.askOrderId, state.askPrice, askTarget, state.askPlacedAt, strategy, marketContext.tickSize)) {
      if (dryRun) {
        ctx.logger.event('makerDryRunCancel', { market: strategy.market, side: 'ask', orderId: state.askOrderId });
      } else {
        await cancelOrder(ctx, marketContext, state.askOrderId, 'requote-ask');
      }
      clearMakerSideState(state, 'ask');
    }
  }

  if (placeBid && !state.bidOrderId) {
    const requiredQuote = await marketContext.poolRead.convertToQuoteAtPriceCeil(quantity, bidTarget);
    if (balances.quoteVault >= requiredQuote) {
      if (dryRun && balances.syntheticFunding) {
        logSyntheticMakerPlacement(ctx, marketContext, 'bid', bidTarget, quantity);
      } else {
        await placeMakerOrder(ctx, marketContext, strategy, state, 'bid', bidTarget, quantity);
      }
    } else {
      ctx.logger.event('makerSkippedBidInsufficientQuote', {
        market: strategy.market,
        requiredQuote,
        quoteWallet: walletBalances.quoteWallet,
        quoteVault: balances.quoteVault,
      });
    }
  }

  if (placeAsk && !state.askOrderId) {
    if (balances.baseVault >= quantity) {
      if (dryRun && balances.syntheticFunding) {
        logSyntheticMakerPlacement(ctx, marketContext, 'ask', askTarget, quantity);
      } else {
        await placeMakerOrder(ctx, marketContext, strategy, state, 'ask', askTarget, quantity);
      }
    } else {
      ctx.logger.event('makerSkippedAskInsufficientBase', {
        market: strategy.market,
        requiredBase: quantity,
        availableBase: balances.baseVault,
        baseWallet: walletBalances.baseWallet,
        baseVault: balances.baseVault,
      });
    }
  }
}

async function runTakerVolumeStrategy(ctx, strategy, state) {
  const marketContext = await getMarketContext(ctx, strategy.market);
  ctx.currentStrategyDryRun = strategy.dryRun ?? ctx.dryRun;
  const top = await getTopOfBook(marketContext, 3);

  if (top.bestBid === 0n || top.bestAsk === 0n) {
    ctx.logger.event('makerSkippedNoLiquidity', { market: strategy.market });
    return;
  }

  const midpoint = getMidpoint(top.bestBid, top.bestAsk);
  const spreadBps = computeBps(top.bestAsk - top.bestBid, midpoint);
  const maxSpreadBps = strategy.maxSpreadBps !== undefined ? BigInt(strategy.maxSpreadBps) : null;
  if (maxSpreadBps !== null && spreadBps > maxSpreadBps) {
    ctx.logger.event('takerSkippedWideSpread', {
      market: strategy.market,
      spreadBps,
      maxSpreadBps,
    });
    return;
  }

  const quantity = parseBigIntValue(strategy.quantity, 'quantity');
  const existingOrders = await getOwnOpenOrdersDetailed(marketContext);
  if (existingOrders.length > 0) {
    if (strategy.dryRun ?? ctx.dryRun) {
      ctx.logger.event('makerExtraOrdersDetected', {
        market: strategy.market,
        side: 'both',
        orderIds: existingOrders.map((order) => order.orderId),
      });
    } else {
      await cancelAllOwnOrders(ctx, marketContext, 'taker-volume-reset');
    }
  }

  const walletBalances = await getWalletBalances(ctx, marketContext);
  const freeBalances = await getVaultBalances(ctx, marketContext);
  let balances = {
    ...freeBalances,
    lockedBaseVault: 0n,
    lockedQuoteVault: 0n,
    totalBaseVault: freeBalances.baseVault,
    totalQuoteVault: freeBalances.quoteVault,
  };
  if (strategy.autoFund) {
    balances = await maybeAutoFundVault(ctx, marketContext, strategy, balances, walletBalances);
  }
  if (balances.baseVault + walletBalances.baseWallet === 0n && state.lastInventoryBuyPrice !== null) {
    state.lastInventoryBuyPrice = null;
    markPersistentStateDirty(ctx);
    ctx.logger.event('inventoryCostCleared', {
      market: strategy.market,
    });
  }

  ctx.logger.event('takerBookSnapshot', {
    market: strategy.market,
    bestBid: top.bestBid,
    bestAsk: top.bestAsk,
    spreadBps,
  });

  const crossTicks = BigInt(strategy.crossTicks || 0);
  const minRoundTripBps = BigInt(strategy.minRoundTripBps || 0);
  const buyPrice = computeIocTargetPrice('bid', top.bestBid, top.bestAsk, marketContext.tickSize, crossTicks);
  const sellPrice = computeIocTargetPrice('ask', top.bestBid, top.bestAsk, marketContext.tickSize, crossTicks);
  const requiredQuote = await marketContext.poolRead.convertToQuoteAtPriceCeil(quantity, buyPrice);
  const minimumSellPrice = state.lastInventoryBuyPrice
    ? computeMinimumSellPrice(state.lastInventoryBuyPrice, minRoundTripBps, marketContext.tickSize)
    : null;

  let sideLabel = null;
  let funding = null;
  const askFunding = selectTakerFunding('ask', balances, walletBalances, requiredQuote);
  const hasAskDustInventory =
    askFunding &&
    askFunding.availableQuantity > 0n &&
    askFunding.availableQuantity < marketContext.minQuantity;
  if (askFunding) {
    if (minimumSellPrice !== null && sellPrice < minimumSellPrice) {
      ctx.logger.event('takerSkippedBelowCost', {
        market: strategy.market,
        sellPrice,
        minimumSellPrice,
        lastInventoryBuyPrice: state.lastInventoryBuyPrice,
      });
      return;
    }
    if (!hasAskDustInventory) {
      sideLabel = 'ask';
      funding = askFunding;
    }
  }
  if (!sideLabel) {
    const bidFunding = selectTakerFunding('bid', balances, walletBalances, requiredQuote);
    if (bidFunding) {
      sideLabel = 'bid';
      funding = bidFunding;
    }
  }

  if (!sideLabel || !funding) {
    if (hasAskDustInventory) {
      ctx.logger.event('makerSkippedAskInsufficientBase', {
        market: strategy.market,
        requiredBase: marketContext.minQuantity,
        availableBase: askFunding.availableQuantity,
        baseWallet: walletBalances.baseWallet,
        baseVault: balances.baseVault,
      });
    } else {
      ctx.logger.event('makerSkippedBidInsufficientQuote', {
        market: strategy.market,
        requiredQuote,
        quoteWallet: walletBalances.quoteWallet,
        quoteVault: balances.quoteVault,
      });
    }
    return;
  }

  const orderQuantity =
    sideLabel === 'ask' && funding.availableQuantity < quantity
      ? funding.availableQuantity
      : quantity;
  if (orderQuantity < marketContext.minQuantity || orderQuantity <= 0n) {
    ctx.logger.event('makerSkippedAskInsufficientBase', {
      market: strategy.market,
      requiredBase: quantity,
      availableBase: orderQuantity,
      baseWallet: walletBalances.baseWallet,
      baseVault: balances.baseVault,
    });
    return;
  }

  const targetPrice = sideLabel === 'bid' ? buyPrice : sellPrice;
  const orderStrategy = {
    ...strategy,
    orderType: 'ioc',
  };

  ctx.logger.event('takerDecision', {
    market: strategy.market,
    side: sideLabel,
    quantity: orderQuantity,
    targetPrice,
    fundingSource: funding.fundingSource,
  });

  const order = await submitStrategyOrder(
    ctx,
    marketContext,
    orderStrategy,
    sideLabel,
    targetPrice,
    orderQuantity,
    { fundingSource: funding.fundingSource }
  );
  if (!order.success) {
    ctx.logger.event('makerSimulationRejected', {
      market: marketContext.market.symbol,
      side: sideLabel,
      targetPrice,
      quantity: orderQuantity,
    });
    return;
  }

  state.lastTakerSide = sideLabel;
  state.lastTakerPrice = targetPrice;
  state.lastTakerAt = Date.now();
  markPersistentStateDirty(ctx);
  if (sideLabel === 'bid') {
    state.lastInventoryBuyPrice = targetPrice;
    ctx.logger.event('inventoryCostUpdated', {
      market: strategy.market,
      lastInventoryBuyPrice: state.lastInventoryBuyPrice,
    });
  }

  if (order.dryRun) {
    ctx.logger.event('makerDryRunPlace', {
      market: marketContext.market.symbol,
      side: sideLabel,
      targetPrice,
      quantity: orderQuantity,
    });
    return;
  }

  ctx.logger.event('takerOrderPlaced', {
    market: marketContext.market.symbol,
    side: sideLabel,
    targetPrice,
    quantity: orderQuantity,
    fundingSource: funding.fundingSource,
    orderId: order.orderId,
    txHash: order.tx.txResponse.hash,
    gasUsed: order.tx.receipt.gasUsed,
  });
}

function buildStopTriggerPrice(markPrice, strategy, isBid) {
  const stopBps = BigInt(strategy.stopBps || 500);
  if (isBid) {
    return (markPrice * (10_000n + stopBps)) / 10_000n;
  }
  return (markPrice * (10_000n - stopBps)) / 10_000n;
}

function buildStopLimitPrice(triggerPrice, strategy, operator, tickSize) {
  const pendingType = normalizeStopPendingType(strategy.pendingOrderType || 'market');
  if (pendingType === STOP_PENDING_TYPES.market) {
    return 0n;
  }
  const limitBps = BigInt(strategy.limitBps || 0);
  if (operator === STOP_OPERATORS.lte) {
    return alignToTick((triggerPrice * (10_000n - limitBps)) / 10_000n, tickSize, 'down');
  }
  return alignToTick((triggerPrice * (10_000n + limitBps)) / 10_000n, tickSize, 'up');
}

async function createStopOrder(ctx, marketContext, strategy, state, quantity, markPrice) {
  if (!marketContext.stopWrite || !marketContext.stopRead) {
    throw new Error('Stop orders require a stop registry and signer');
  }

  const isBid = sideToIsBid(strategy.side || 'sell');
  const operator = normalizeStopOperator(strategy.triggerOperator, isBid);
  const pendingType = normalizeStopPendingType(strategy.pendingOrderType || 'market');
  const triggerPrice = buildStopTriggerPrice(markPrice, strategy, isBid);
  const limitPrice = buildStopLimitPrice(triggerPrice, strategy, operator, marketContext.tickSize);
  const somiPayment = await marketContext.stopRead.somiPaymentPerOrder();
  const subscriptionId = await marketContext.stopRead.activeSubscriptionId();

  if (subscriptionId === 0n) {
    ctx.logger.event('stopSkippedDormantRegistry', { market: strategy.market });
    return;
  }

  const structArg = [
    [isBid, ctx.walletAddress, 0n, quantity],
    pendingType,
    triggerPrice,
    operator,
    limitPrice,
    ZERO_ADDRESS,
    0n,
  ];

  const dryRun = strategy.dryRun ?? ctx.dryRun;
  if (dryRun) {
    ctx.logger.event('stopDryRunCreate', {
      market: strategy.market,
      quantity,
      triggerPrice,
      operator,
      pendingType,
      limitPrice,
      somiPayment,
    });
    return;
  }

  const tx = await sendQueuedTx(ctx, `stop-create-${strategy.market}`, async () => {
    const txResponse = await marketContext.stopWrite.createPendingOrder(structArg, { value: somiPayment });
    const receipt = await txResponse.wait(ctx.confirmations);
    return { txResponse, receipt };
  });

  const stopInterface = marketContext.stopWrite.interface;
  let pendingOrderId = null;
  for (const log of tx.receipt.logs) {
    try {
      const parsed = stopInterface.parseLog(log);
      if (parsed && parsed.name === 'PendingOrderCreated') {
        pendingOrderId = parsed.args.orderId;
        break;
      }
    } catch {
      // ignore unrelated logs
    }
  }

  state.stopPendingOrderId = pendingOrderId;
  state.stopCreatedAt = Date.now();
  state.stopTriggerPrice = triggerPrice;

  ctx.logger.event('stopCreated', {
    market: strategy.market,
    pendingOrderId,
    quantity,
    triggerPrice,
    txHash: tx.txResponse.hash,
    gasUsed: tx.receipt.gasUsed,
  });
}

async function cancelStopOrder(ctx, marketContext, state, reason) {
  if (!state.stopPendingOrderId || !marketContext.stopWrite) {
    return;
  }
  const dryRun = state.strategyDryRun ?? ctx.dryRun;
  if (dryRun) {
    ctx.logger.event('stopDryRunCancel', {
      market: marketContext.market.symbol,
      pendingOrderId: state.stopPendingOrderId,
      reason,
    });
    state.stopPendingOrderId = null;
    return;
  }

  const tx = await sendQueuedTx(ctx, `stop-cancel-${state.stopPendingOrderId.toString()}`, async () => {
    const txResponse = await marketContext.stopWrite.cancelPendingOrder(state.stopPendingOrderId);
    const receipt = await txResponse.wait(ctx.confirmations);
    return { txResponse, receipt };
  });

  ctx.logger.event('stopCancelled', {
    market: marketContext.market.symbol,
    pendingOrderId: state.stopPendingOrderId,
    reason,
    txHash: tx.txResponse.hash,
    gasUsed: tx.receipt.gasUsed,
  });
  state.stopPendingOrderId = null;
  state.stopTriggerPrice = null;
  state.stopCreatedAt = null;
}

async function runStopGuardStrategy(ctx, strategy, state) {
  const marketContext = await getMarketContext(ctx, strategy.market);
  const balances = await getVaultBalances(ctx, marketContext);
  const emaState = await marketContext.poolRead.getMidpointEmaState();
  const markPrice = emaState[0];
  const sideIsBid = sideToIsBid(strategy.side || 'sell');
  const watchedBalance = sideIsBid ? balances.quoteVault : balances.baseVault;
  const minimumBalance = parseBigIntValue(strategy.minimumVaultBalance || strategy.quantity, 'minimumVaultBalance');
  const quantity = parseBigIntValue(strategy.quantity, 'quantity');
  state.strategyDryRun = strategy.dryRun ?? ctx.dryRun;

  if (markPrice === 0n) {
    ctx.logger.event('stopSkippedNoMarkPrice', { market: strategy.market });
    return;
  }

  if (watchedBalance < minimumBalance) {
    if (state.stopPendingOrderId) {
      await cancelStopOrder(ctx, marketContext, state, 'insufficient-vault-balance');
    }
    ctx.logger.event('stopSkippedInsufficientBalance', {
      market: strategy.market,
      watchedBalance,
      minimumBalance,
    });
    return;
  }

  if (!state.stopPendingOrderId) {
    await createStopOrder(ctx, marketContext, strategy, state, quantity, markPrice);
    return;
  }

  const replaceEveryMs = Number(strategy.replaceEveryMs || 0);
  if (replaceEveryMs > 0 && state.stopCreatedAt && Date.now() - state.stopCreatedAt >= replaceEveryMs) {
    await cancelStopOrder(ctx, marketContext, state, 'scheduled-replace');
    await createStopOrder(ctx, marketContext, strategy, state, quantity, markPrice);
  }
}

async function maybeRunStrategy(ctx, strategy, state) {
  const now = Date.now();
  const pollEveryMs = Number(strategy.pollEveryMs || ctx.pollIntervalMs);
  if (state.lastRunAt && now - state.lastRunAt < pollEveryMs) {
    return;
  }
  state.lastRunAt = now;
  try {
    if (strategy.type === 'makerSpread') {
      await runMakerSpreadStrategy(ctx, strategy, state);
      return;
    }

    if (strategy.type === 'takerVolume') {
      await runTakerVolumeStrategy(ctx, strategy, state);
      return;
    }

    if (strategy.type === 'stopGuard') {
      await runStopGuardStrategy(ctx, strategy, state);
      return;
    }

    throw new Error(`Unsupported strategy type: ${strategy.type}`);
  } finally {
    ctx.currentStrategyDryRun = null;
  }
}

async function main() {
  const cli = parseCliArgs(process.argv.slice(2));
  const configPath = path.resolve(cli.configPath || 'config/dreamdex.bot.settings.json');

  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const config = readJson(configPath);
  const networkName = resolveNetworkName(config, cli.networkOverride);
  const networkConfig = resolveNetworkConfig(config, networkName);
  const { provider, rpcUrl: activeRpcUrl } = await createProvider(networkConfig);
  const signer = resolveWallet(config, provider);
  const privateKeyEnvVar = ((config.wallet || {}).privateKeyEnvVar || 'PRIVATE_KEY');

  if (!signer) {
    throw new Error(`Bot requires a wallet. Set ${privateKeyEnvVar} in your environment.`);
  }

  const onChainNetwork = await provider.getNetwork();
  if (Number(onChainNetwork.chainId) !== Number(networkConfig.chainId)) {
    throw new Error(
      `RPC chain mismatch. Expected ${networkConfig.chainId}, got ${onChainNetwork.chainId.toString()}`
    );
  }

  const walletAddress = await signer.getAddress();
  const defaults = config.defaults || {};
  const bot = config.bot || {};
  const pollIntervalMs = Number(bot.pollIntervalMs || defaults.pollIntervalMs || 15000);
  const confirmations = Number(defaults.confirmations || 1);
  const expireSecondsFromNow = Number(defaults.expireSecondsFromNow || 3600);
  const dryRun = Boolean(defaults.dryRun);
  const logDir = path.resolve(defaults.logDir || 'logs');
  mkdirp(logDir);
  const sessionName = `dreamdex-bot-${networkName}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const logPath = path.join(logDir, `${sessionName}.jsonl`);
  const statePath = path.join(logDir, `${sessionName}.state.json`);
  const persistentStatePath = path.resolve(
    bot.persistentStatePath || path.join(logDir, `dreamdex-bot-${networkName}.persistent-state.json`)
  );
  const stateStore = createStateStore(config, bot, networkName, walletAddress);
  const logger = createLogger(logPath);

  logger.event('botStarted', {
    configPath,
    network: networkName,
    chainId: networkConfig.chainId,
    rpcUrl: activeRpcUrl,
    rpcUrls: networkConfig.rpcUrls || [networkConfig.rpcUrl],
    walletAddress,
    dryRun,
    pollIntervalMs,
    runOnce: Boolean(bot.runOnce || cli.once),
  });

  const ctx = {
    config,
    bot,
    networkName,
    provider,
    signer,
    walletAddress,
    pollIntervalMs,
    confirmations,
    expireSecondsFromNow,
    dryRun,
    logger,
    logPath,
    statePath,
    persistentStatePath,
    stateStore,
    persistentStateDirty: false,
    txQueue: new TxQueue(),
    marketCache: {},
    marketFeed: null,
    currentStrategyDryRun: null,
  };

  const strategyEntries = (config.strategies || [])
    .filter((strategy) => strategy.enabled !== false)
    .map((strategy, index) => ({
      config: strategy,
      state: {
        id: `${strategy.type}:${strategy.market}:${index}`,
        market: strategy.market,
        type: strategy.type,
        lastRunAt: 0,
        bidOrderId: null,
        askOrderId: null,
        bidPrice: null,
        askPrice: null,
        bidPlacedAt: null,
        askPlacedAt: null,
        bidQuantityRemaining: null,
        askQuantityRemaining: null,
        lastTakerSide: null,
        lastTakerPrice: null,
        lastTakerAt: null,
        lastInventoryBuyPrice: null,
        stopPendingOrderId: null,
        stopTriggerPrice: null,
        stopCreatedAt: null,
      },
    }));

  if (strategyEntries.length === 0) {
    throw new Error('No enabled strategies found in config.');
  }

  let persistedState = null;
  if (stateStore.enabled) {
    try {
      persistedState = await loadStateFromSupabase(stateStore);
      if (persistedState) {
        fs.writeFileSync(persistentStatePath, JSON.stringify(persistedState, null, 2));
        logger.event('supabaseStateLoaded', {
          botId: stateStore.botId,
        });
      }
    } catch (error) {
      logger.event('supabaseStateLoadFailed', {
        message: error && error.message ? error.message : String(error),
      });
    }
  }
  if (!persistedState) {
    persistedState = readJsonFileIfExists(persistentStatePath);
  }
  const persistedStrategies = new Map(
    (((persistedState || {}).strategies) || []).map((entry) => [entry.id, entry])
  );
  for (const entry of strategyEntries) {
    const saved = persistedStrategies.get(entry.state.id);
    if (!saved) {
      continue;
    }
    entry.state.lastTakerSide = saved.lastTakerSide ?? entry.state.lastTakerSide;
    entry.state.lastTakerPrice = reviveNullableBigInt(saved.lastTakerPrice);
    entry.state.lastTakerAt = saved.lastTakerAt ?? entry.state.lastTakerAt;
    entry.state.lastInventoryBuyPrice = reviveNullableBigInt(saved.lastInventoryBuyPrice);
    if (entry.state.lastInventoryBuyPrice !== null) {
      logger.event('inventoryCostLoaded', {
        market: entry.config.market,
        lastInventoryBuyPrice: entry.state.lastInventoryBuyPrice,
      });
    }
  }

  const uniqueSymbols = [...new Set(strategyEntries.map((entry) => entry.config.market))];
  const symbolContexts = new Map();
  for (const symbol of uniqueSymbols) {
    const marketContext = await getMarketContext(ctx, symbol);
    symbolContexts.set(symbol, marketContext);
  }

  if (networkConfig.wsUrl && uniqueSymbols.length > 0) {
    ctx.marketFeed = new PublicMarketFeed(ctx, {
      wsUrl: networkConfig.wsUrl,
      symbolContexts,
      staleAfterMs: Number(bot.wsStaleAfterMs || 45000),
      reconnectDelayMs: Number(bot.wsReconnectDelayMs || 3000),
      pingEveryMs: Number(bot.wsPingEveryMs || 25000),
    });
    ctx.marketFeed.start();
    const receivedInitialData = await ctx.marketFeed.waitForInitialData(
      uniqueSymbols,
      Number(bot.wsInitialDataTimeoutMs || 4000)
    );
    logger.event('wsInitialData', {
      received: receivedInitialData,
      symbols: uniqueSymbols,
    });
  }

  if (bot.cancelAllOrdersOnStart) {
    const resetSymbols = [...new Set(
      strategyEntries
        .filter((entry) => entry.config.type === 'makerSpread' || entry.config.type === 'takerVolume')
        .map((entry) => entry.config.market)
    )];
    for (const symbol of resetSymbols) {
      const marketContext = await getMarketContext(ctx, symbol);
      const existingIds = await getOwnOpenOrderIds(marketContext);
      if ((existingIds || []).length === 0) {
        logger.event('startupOrderReset', { market: symbol, cancelled: 0 });
        continue;
      }
      await cancelAllOwnOrders(ctx, marketContext, 'startup-reset');
      logger.event('startupOrderReset', { market: symbol, cancelled: existingIds.length });
    }
  }

  for (const entry of strategyEntries) {
    if (entry.config.type !== 'makerSpread') {
      continue;
    }
    try {
      const marketContext = await getMarketContext(ctx, entry.config.market);
      const top = await getTopOfBook(marketContext, 3);
      if (top.bestBid === 0n || top.bestAsk === 0n) {
        continue;
      }
      const { bidTarget, askTarget } = computeTargetPrices(
        entry.config,
        top.bestBid,
        top.bestAsk,
        marketContext.tickSize
      );
      await reconcileExistingMakerOrders(ctx, marketContext, entry.config, entry.state, bidTarget, askTarget);
    } catch (error) {
      logger.event('startupReconcileError', {
        strategy: entry.config.type,
        market: entry.config.market,
        message: error && error.message ? error.message : String(error),
      });
    }
  }

  let stopping = false;
  const stopHandler = async () => {
    if (stopping) {
      return;
    }
    stopping = true;
    logger.event('botStopping', { reason: 'signal' });
  };

  process.on('SIGINT', stopHandler);
  process.on('SIGTERM', stopHandler);

  while (!stopping) {
    for (const entry of strategyEntries) {
      try {
        await maybeRunStrategy(ctx, entry.config, entry.state);
      } catch (error) {
        logger.event('strategyError', {
          strategy: entry.config.type,
          market: entry.config.market,
          message: error && error.message ? error.message : String(error),
        });
      }
    }

    const statePayload = toSerializable({
      updatedAt: nowIso(),
      network: networkName,
      walletAddress,
      strategies: strategyEntries.map((entry) => entry.state),
    });
    fs.writeFileSync(statePath, JSON.stringify(statePayload, null, 2));
    fs.writeFileSync(persistentStatePath, JSON.stringify(statePayload, null, 2));
    if (ctx.stateStore.enabled && ctx.persistentStateDirty) {
      try {
        await saveStateToSupabase(ctx.stateStore, statePayload);
        ctx.persistentStateDirty = false;
        logger.event('supabaseStateSaved', {
          botId: ctx.stateStore.botId,
        });
      } catch (error) {
        logger.event('supabaseStateSaveFailed', {
          message: error && error.message ? error.message : String(error),
        });
      }
    }

    if (bot.runOnce || cli.once) {
      break;
    }

    await sleep(pollIntervalMs);
  }

  if (bot.cancelManagedOrdersOnExit) {
    for (const entry of strategyEntries) {
      if (entry.config.type === 'makerSpread') {
        const marketContext = await getMarketContext(ctx, entry.config.market);
        if (entry.config.managePoolExclusively) {
          if (!(entry.config.dryRun ?? ctx.dryRun)) {
            await cancelAllOwnOrders(ctx, marketContext, 'shutdown');
          }
        } else {
          if (!(entry.config.dryRun ?? ctx.dryRun)) {
            await cancelManagedOrders(ctx, marketContext, entry.state, 'shutdown');
          }
        }
      }
      if (entry.config.type === 'stopGuard' && bot.cancelStopsOnExit) {
        const marketContext = await getMarketContext(ctx, entry.config.market);
        await cancelStopOrder(ctx, marketContext, entry.state, 'shutdown');
      }
    }
  }

  if (ctx.marketFeed) {
    ctx.marketFeed.stop();
  }

  logger.event('botStopped', { statePath });
  console.log(`Bot stopped. Logs: ${logPath}`);
}

main().catch((error) => {
  const message = error && error.stack ? error.stack : String(error);
  console.error(message);
  process.exitCode = 1;
});

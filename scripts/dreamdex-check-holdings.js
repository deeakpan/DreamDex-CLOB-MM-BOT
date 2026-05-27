#!/usr/bin/env node

// Usage:
//   node scripts/dreamdex-check-holdings.js <walletAddress1> <walletAddress2> ...
//
// This checks current wallet + vault free balances for SOMI:USDso using the
// on-chain CLOB pool contract. It does NOT read open orders for other owners
// because `getOwnOpenOrders()` is owner-msg.sender based.

const { ethers } = require('ethers');

const SPOT_POOL_ABI = [
  'function getPoolParams() view returns (address baseToken_, address quoteToken_, uint256 makerFeeBpsTimes1k_, uint256 takerFeeBpsTimes1k_, uint256 tickSize_, uint256 minQuantity_, uint256 lotSize_)',
  'function getWithdrawableBalance(address owner, address token) view returns (uint256)',
  'function getOwnOpenOrders() view returns (uint128[] memory)',
  'function getOrder(uint128 orderId) view returns (tuple(uint128 orderId, bool isBid, address owner, uint64 userData, uint256 price, uint256 fullQuantity, uint256 quantityRemaining, uint64 expireTimestampNs))',
  'function convertToQuoteAtPriceCeil(uint256 baseQuantity, uint256 priceQuote) view returns (uint256)',
];

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

const SOMI_USDSO_POOL = '0x035De7403eac6872787779CCA7CCF1b4CDb61379';

const rpcUrls = ['https://api.infra.mainnet.somnia.network', 'https://somnia.publicnode.com'];

async function createProvider() {
  let lastError = null;
  for (const url of rpcUrls) {
    try {
      const provider = new ethers.JsonRpcProvider(url, undefined, { staticNetwork: true });
      await Promise.race([
        provider.getBlockNumber(),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout for ${url}`)), 10000)),
      ]);
      return provider;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error('No RPC available');
}

function fmtUnits(x, decimals) {
  return ethers.formatUnits(BigInt(x), decimals);
}

async function checkAddress(provider, owner) {
  const poolRead = new ethers.Contract(SOMI_USDSO_POOL, SPOT_POOL_ABI, provider);
  const poolParams = await poolRead.getPoolParams();
  const baseToken = poolParams.baseToken_ ?? poolParams[0];
  const quoteToken = poolParams.quoteToken_ ?? poolParams[1];

  const quoteTokenContract = new ethers.Contract(quoteToken, ERC20_ABI, provider);
  const [quoteDecimals, quoteSymbol] = await Promise.all([
    quoteTokenContract.decimals(),
    quoteTokenContract.symbol(),
  ]);

  // getOwnOpenOrders() is msg.sender based, so we try to override `from` for eth_call.
  // If the RPC/provider doesn't support `from` overrides, this will throw.
  let orderIds = [];
  try {
    orderIds = await poolRead.getOwnOpenOrders({ from: owner });
  } catch (e) {
    orderIds = [];
  }

  // Order tuple type is defined in scripts/dreamdex-bot.js, but we only need a few fields.
  let lockedBase = 0n;
  let lockedQuote = 0n;
  if (orderIds.length > 0) {
    const ordersRaw = await Promise.all(
      orderIds.map((id) => poolRead.getOrder(id))
    );
    for (const order of ordersRaw) {
      const isBid = Boolean(order.isBid ?? order[1]);
      const price = BigInt(order.price ?? order[4]);
      const qtyRem = BigInt(order.quantityRemaining ?? order[6]);
      if (isBid) {
        lockedQuote += BigInt(await poolRead.convertToQuoteAtPriceCeil(qtyRem, price));
      } else {
        lockedBase += qtyRem;
      }
    }
  }

  const [baseVault, quoteVault, quoteWallet, baseWalletRaw] = await Promise.all([
    poolRead.getWithdrawableBalance(owner, baseToken),
    poolRead.getWithdrawableBalance(owner, quoteToken),
    quoteTokenContract.balanceOf(owner),
    // SOMI pool has native base, so wallet SOMI = native balance.
    provider.getBalance(owner),
  ]);

  // These are "raw totals" (no fee reserves subtraction).
  return {
    owner,
    SOMI: {
      walletNative: fmtUnits(baseWalletRaw, 18),
      vaultFree: fmtUnits(baseVault, 18),
      openOrderLocked: fmtUnits(lockedBase, 18),
      total: fmtUnits(BigInt(baseWalletRaw) + BigInt(baseVault) + lockedBase, 18),
    },
    USDso: {
      wallet: fmtUnits(quoteWallet, quoteDecimals),
      vaultFree: fmtUnits(quoteVault, quoteDecimals),
      openOrderLocked: fmtUnits(lockedQuote, quoteDecimals),
      total: fmtUnits(BigInt(quoteWallet) + BigInt(quoteVault) + lockedQuote, quoteDecimals),
      quoteSymbol,
      quoteDecimals: Number(quoteDecimals),
    },
  };
}

async function main() {
  const owners = process.argv.slice(2).filter(Boolean);
  if (owners.length === 0) {
    throw new Error('Provide at least one address.');
  }

  const provider = await createProvider();
  const results = [];
  for (const owner of owners) {
    results.push(await checkAddress(provider, owner));
  }
  console.log(JSON.stringify({ pool: SOMI_USDSO_POOL, results }, null, 2));
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : String(e));
  process.exitCode = 1;
});


#!/usr/bin/env node
/**
 * Wallet USDso flow audit via Transfer logs (1000-block chunks).
 * Usage: node scripts/dreamdex-wallet-audit.js [address]
 */

require('dotenv').config();
const { ethers } = require('ethers');

const DEFAULT_ADDR = '0x2C6F3B0ED6107A7B6e5bd09e31d9076ccbbA5609';
const USDso = '0x00000022dA000002656c64D9eA6011ea952D008A';
const POOLS = {
  SOMI: '0x035De7403eac6872787779CCA7CCF1b4CDb61379',
  WETH: '0xa936da11B57b50A344e1293AAaE5232885ea2bDE',
  WBTC: '0x25bfF6B7B5E2243424F38E75de7ab03C0522a5EA',
};
const RPCS = [
  'https://api.infra.mainnet.somnia.network',
  'https://somnia.publicnode.com',
];
const CHUNK = 999;

async function createProvider() {
  for (const url of RPCS) {
    try {
      const p = new ethers.JsonRpcProvider(url, 5031, { staticNetwork: true });
      await p.getBlockNumber();
      return p;
    } catch (_) {
      /* try next */
    }
  }
  throw new Error('No RPC');
}

async function fetchExplorerTokenTx(address) {
  const url = `https://explorer.somnia.network/api?module=account&action=tokentx&address=${address}&sort=asc&page=1&offset=10000`;
  for (let i = 0; i < 5; i += 1) {
    const res = await fetch(url);
    const json = await res.json();
    if (json.status === '1' && Array.isArray(json.result)) {
      return json.result;
    }
    if (String(json.message || '').includes('Too many')) {
      await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
      continue;
    }
    return { error: json.message || json.result, raw: json };
  }
  return { error: 'explorer rate limited' };
}

async function scanTransferLogs(provider, address, fromBlock, toBlock) {
  const topicTransfer = ethers.id('Transfer(address,address,uint256)');
  const pad = (a) => ethers.zeroPadValue(a, 32);
  const addrLower = address.toLowerCase();

  let inSum = 0n;
  let outSum = 0n;
  const externalIn = [];
  const poolIn = [];
  const poolOut = [];
  const poolSet = new Set(Object.values(POOLS).map((p) => p.toLowerCase()));

  for (let start = fromBlock; start <= toBlock; start += CHUNK) {
    const end = Math.min(start + CHUNK - 1, toBlock);
    const [logsIn, logsOut] = await Promise.all([
      provider.getLogs({
        address: USDso,
        topics: [topicTransfer, null, pad(address)],
        fromBlock: start,
        toBlock: end,
      }),
      provider.getLogs({
        address: USDso,
        topics: [topicTransfer, pad(address), null],
        fromBlock: start,
        toBlock: end,
      }),
    ]);

    for (const l of logsIn) {
      const val = BigInt(l.data);
      inSum += val;
      const fromAddr = ethers.getAddress('0x' + l.topics[1].slice(26));
      const row = {
        block: l.blockNumber,
        tx: l.transactionHash,
        from: fromAddr,
        amount: ethers.formatUnits(val, 18),
      };
      if (poolSet.has(fromAddr.toLowerCase())) {
        poolIn.push(row);
      } else {
        externalIn.push(row);
      }
    }
    for (const l of logsOut) {
      const val = BigInt(l.data);
      outSum += val;
      const toAddr = ethers.getAddress('0x' + l.topics[2].slice(26));
      poolOut.push({
        block: l.blockNumber,
        tx: l.transactionHash,
        to: toAddr,
        amount: ethers.formatUnits(val, 18),
      });
    }
  }

  return { inSum, outSum, externalIn, poolIn, poolOut, addrLower };
}

async function main() {
  const address = process.argv[2] || DEFAULT_ADDR;
  const provider = await createProvider();
  const latest = await provider.getBlockNumber();
  const nonce = await provider.getTransactionCount(address);

  // Scan last ~500k blocks first; extend if no external deposits found
  let fromBlock = Math.max(0, latest - 500_000);
  let scan = await scanTransferLogs(provider, address, fromBlock, latest);

  if (scan.externalIn.length === 0 && fromBlock > 0) {
    fromBlock = Math.max(0, latest - 2_000_000);
    scan = await scanTransferLogs(provider, address, fromBlock, latest);
  }

  const bal = await new ethers.Contract(USDso, ['function balanceOf(address) view returns (uint256)'], provider).balanceOf(
    address
  );
  const native = await provider.getBalance(address);

  const poolInSum = scan.poolIn.reduce((s, r) => s + parseFloat(r.amount), 0);
  const poolOutSum = scan.poolOut.reduce((s, r) => s + parseFloat(r.amount), 0);
  const extInSum = scan.externalIn.reduce((s, r) => s + parseFloat(r.amount), 0);

  const somiPool = new ethers.Contract(
    POOLS.SOMI,
    ['function getBookLevels(bool,uint64) view returns (tuple(uint256 price,uint256 quantity)[])'],
    provider
  );
  const bids = await somiPool.getBookLevels(true, 1);
  const somiPrice = bids[0] ? parseFloat(ethers.formatUnits(bids[0].price, 18)) : 0;
  const somiAmt = parseFloat(ethers.formatUnits(native, 18));

  const explorer = await fetchExplorerTokenTx(address);

  const report = {
    wallet: address,
    nonce,
    blockRange: { from: fromBlock, latest },
    current: {
      USDso: ethers.formatUnits(bal, 18),
      SOMI: ethers.formatUnits(native, 18),
      SOMI_at_mark: (somiAmt * somiPrice).toFixed(4),
      somiPrice,
    },
    usdsoFlow: {
      totalIn: ethers.formatUnits(scan.inSum, 18),
      totalOut: ethers.formatUnits(scan.outSum, 18),
      netFromLogs: ethers.formatUnits(scan.inSum - scan.outSum, 18),
      externalDepositsTotal: extInSum.toFixed(6),
      externalDepositCount: scan.externalIn.length,
      fromPoolTotal: poolInSum.toFixed(6),
      fromPoolCount: scan.poolIn.length,
      toPoolTotal: poolOutSum.toFixed(6),
      toPoolCount: scan.poolOut.length,
      roundTripFeesEst: (extInSum - parseFloat(ethers.formatUnits(bal, 18)) - somiAmt * somiPrice).toFixed(4),
    },
    externalDeposits: scan.externalIn,
    firstExternalDeposit: scan.externalIn[0] || null,
    lastExternalDeposit: scan.externalIn[scan.externalIn.length - 1] || null,
    largestExternalDeposits: [...scan.externalIn].sort((a, b) => parseFloat(b.amount) - parseFloat(a.amount)).slice(0, 10),
  };

  if (Array.isArray(explorer)) {
    const usdsoTx = explorer.filter((t) => t.contractAddress?.toLowerCase() === USDso.toLowerCase());
    const ext = usdsoTx.filter(
      (t) => t.to?.toLowerCase() === address.toLowerCase() && !Object.values(POOLS).map((p) => p.toLowerCase()).includes(t.from?.toLowerCase())
    );
    report.explorer = {
      usdsoTransferCount: usdsoTx.length,
      externalInboundCount: ext.length,
      externalInboundTotal: ext.reduce((s, t) => s + parseFloat(ethers.formatUnits(t.value, Number(t.tokenDecimal || 18))), 0).toFixed(6),
      externalInbound: ext.slice(0, 20).map((t) => ({
        time: t.timeStamp ? new Date(Number(t.timeStamp) * 1000).toISOString() : null,
        from: t.from,
        amount: ethers.formatUnits(t.value, Number(t.tokenDecimal || 18)),
        tx: t.hash,
      })),
    };
  } else {
    report.explorer = explorer;
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exitCode = 1;
});

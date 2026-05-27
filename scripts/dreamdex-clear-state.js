#!/usr/bin/env node

/**
 * Reset bot persistent state locally and in Supabase (clears cost basis / ping-pong memory).
 *
 * Usage:
 *   node scripts/dreamdex-clear-state.js --config config/dreamdex.bot.mainnet.json
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });
const { ethers } = require('ethers');
const {
  createStateStore,
  saveStateToSupabase,
} = require('./dreamdex-state-store');

function parseCli(argv) {
  const result = { configPath: 'config/dreamdex.bot.mainnet.json' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--config') {
      result.configPath = argv[i + 1];
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

function buildEmptyState(config, networkName, walletAddress) {
  const strategies = (config.strategies || [])
    .filter((s) => s.enabled !== false)
    .map((strategy, index) => ({
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
    }));

  return {
    updatedAt: new Date().toISOString(),
    network: networkName,
    walletAddress,
    strategies,
  };
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  const configPath = path.resolve(cli.configPath);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const networkName = config.network || 'mainnet';
  const defaults = config.defaults || {};
  const bot = config.bot || {};
  const privateKey = normalizePrivateKey(process.env[config.wallet?.privateKeyEnvVar || 'PRIVATE_KEY']);
  if (!privateKey) throw new Error('Missing PRIVATE_KEY');

  const walletAddress = new ethers.Wallet(privateKey).address;
  const logDir = path.resolve(defaults.logDir || 'logs');
  const persistentStatePath = path.resolve(
    bot.persistentStatePath || path.join(logDir, `dreamdex-bot-${networkName}.persistent-state.json`)
  );

  const payload = buildEmptyState(config, networkName, walletAddress);
  fs.mkdirSync(path.dirname(persistentStatePath), { recursive: true });
  fs.writeFileSync(persistentStatePath, JSON.stringify(payload, null, 2));

  const stateStore = createStateStore(config, bot, networkName, walletAddress);
  if (!stateStore.enabled) {
    throw new Error('Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  }

  await saveStateToSupabase(stateStore, payload);

  console.log(
    JSON.stringify(
      {
        status: 'cleared',
        botId: stateStore.botId,
        localStateFile: persistentStatePath,
        table: `${stateStore.schema}.${stateStore.table}`,
        strategyCount: payload.strategies.length,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});

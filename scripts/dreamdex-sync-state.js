#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });
const { ethers } = require('ethers');
const {
  createStateStore,
  readJsonFileIfExists,
  saveStateToSupabase,
} = require('./dreamdex-state-store');

function parseCliArgs(argv) {
  const result = { configPath: null, networkOverride: null, stateFile: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--config') {
      result.configPath = argv[i + 1];
      i += 1;
    } else if (arg === '--network') {
      result.networkOverride = argv[i + 1];
      i += 1;
    } else if (arg === '--state-file') {
      result.stateFile = argv[i + 1];
      i += 1;
    }
  }
  return result;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
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

function resolveNetworkName(config, networkOverride) {
  const networkName = networkOverride || config.network;
  if (!networkName) {
    throw new Error('Missing network. Set `network` in config or pass --network.');
  }
  return networkName;
}

function listPersistentStateFiles(logDir) {
  if (!fs.existsSync(logDir)) {
    return [];
  }
  return fs
    .readdirSync(logDir)
    .filter((name) => name.endsWith('.persistent-state.json'))
    .map((name) => path.join(logDir, name))
    .sort();
}

async function main() {
  const cli = parseCliArgs(process.argv.slice(2));
  const configPath = path.resolve(cli.configPath || 'config/dreamdex.bot.mainnet.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const config = readJson(configPath);
  const networkName = resolveNetworkName(config, cli.networkOverride);
  const defaults = config.defaults || {};
  const bot = config.bot || {};
  const walletConfig = config.wallet || {};
  const privateKeyEnvVar = walletConfig.privateKeyEnvVar || 'PRIVATE_KEY';
  const privateKey = normalizePrivateKey(walletConfig.privateKey || process.env[privateKeyEnvVar]);
  if (!privateKey) {
    throw new Error(`Missing private key. Set ${privateKeyEnvVar} in your environment.`);
  }

  const walletAddress = new ethers.Wallet(privateKey).address;
  const logDir = path.resolve(defaults.logDir || 'logs');
  const persistentStatePath = path.resolve(
    cli.stateFile ||
      bot.persistentStatePath ||
      path.join(logDir, `dreamdex-bot-${networkName}.persistent-state.json`)
  );
  const payload = readJsonFileIfExists(persistentStatePath);
  if (!payload) {
    const availableStateFiles = listPersistentStateFiles(logDir);
    const lines = [
      `State file not found for network "${networkName}": ${persistentStatePath}`,
      `Config used: ${configPath}`,
    ];

    if (availableStateFiles.length > 0) {
      lines.push('Available persistent state files:');
      for (const filePath of availableStateFiles) {
        lines.push(`- ${filePath}`);
      }
    }

    if (!cli.stateFile && networkName !== 'mainnet' && availableStateFiles.some((filePath) => filePath.includes('mainnet'))) {
      lines.push('Tip: your current saved bot state looks like mainnet state.');
      lines.push('Try: npm run dreamdex:state:push:mainnet');
    }

    if (!cli.stateFile) {
      lines.push('Or pass an explicit file path:');
      lines.push('node scripts/dreamdex-sync-state.js --config <config> --state-file <path-to-persistent-state.json>');
    }

    throw new Error(lines.join('\n'));
  }

  const stateStore = createStateStore(config, bot, networkName, walletAddress);
  if (!stateStore.enabled) {
    throw new Error('Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  }

  await saveStateToSupabase(stateStore, payload);

  console.log(
    JSON.stringify(
      {
        botId: stateStore.botId,
        network: networkName,
        walletAddress,
        stateFile: persistentStatePath,
        table: `${stateStore.schema}.${stateStore.table}`,
        status: 'ok',
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  const message = error && error.stack ? error.stack : String(error);
  console.error(message);
  process.exitCode = 1;
});

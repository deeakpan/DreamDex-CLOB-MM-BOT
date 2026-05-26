const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

function readJsonFileIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function resolveStateStoreConfig(config, bot, networkName, walletAddress) {
  const fileConfig = {
    ...((config && config.supabase) || {}),
    ...((bot && bot.supabase) || {}),
  };
  const url = fileConfig.url || process.env.SUPABASE_URL || null;
  const serviceRoleKey =
    fileConfig.serviceRoleKey ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_KEY ||
    null;
  const schema = fileConfig.schema || process.env.SUPABASE_SCHEMA || 'public';
  const table = fileConfig.table || process.env.SUPABASE_STATE_TABLE || 'dreamdex_bot_state';
  const botId = fileConfig.botId || process.env.BOT_STATE_ID || `${networkName}:${walletAddress.toLowerCase()}`;
  const enabled = Boolean(url && serviceRoleKey);

  return {
    enabled,
    url,
    serviceRoleKey,
    schema,
    table,
    botId,
    networkName,
    walletAddress,
  };
}

function createStateStore(config, bot, networkName, walletAddress) {
  const options = resolveStateStoreConfig(config, bot, networkName, walletAddress);
  if (!options.enabled) {
    return {
      ...options,
      client: null,
    };
  }

  return {
    ...options,
    client: createClient(options.url, options.serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    }),
  };
}

async function loadStateFromSupabase(stateStore) {
  if (!stateStore || !stateStore.enabled || !stateStore.client) {
    return null;
  }

  const { data, error } = await stateStore.client
    .schema(stateStore.schema)
    .from(stateStore.table)
    .select('state')
    .eq('bot_id', stateStore.botId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data ? data.state : null;
}

async function saveStateToSupabase(stateStore, payload) {
  if (!stateStore || !stateStore.enabled || !stateStore.client) {
    return false;
  }

  const { error } = await stateStore.client
    .schema(stateStore.schema)
    .from(stateStore.table)
    .upsert(
      {
        bot_id: stateStore.botId,
        network: stateStore.networkName,
        wallet_address: stateStore.walletAddress,
        state: payload,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'bot_id' }
    );

  if (error) {
    throw error;
  }

  return true;
}

module.exports = {
  createStateStore,
  loadStateFromSupabase,
  readJsonFileIfExists,
  resolveStateStoreConfig,
  saveStateToSupabase,
};

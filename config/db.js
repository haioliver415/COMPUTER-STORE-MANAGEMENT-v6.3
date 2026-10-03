const { Pool, types } = require('pg');
const { getDatabaseConfig, getPublicDatabaseConfig, saveDatabaseConfig, normalize } = require('./database-config');

types.setTypeParser(20, (val) => parseInt(val, 10));
types.setTypeParser(1700, (val) => parseFloat(val));

function createPool(cfg) {
  const pool = new Pool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    ssl: cfg.ssl ? { rejectUnauthorized: false } : false,
    max: cfg.max || 20,
    idleTimeoutMillis: cfg.idleTimeoutMillis || 30000,
    connectionTimeoutMillis: cfg.connectionTimeoutMillis || 5000
  });
  pool.on('error', (err) => console.error('PostgreSQL pool error:', err.message));
  return pool;
}

let activeConfig = getDatabaseConfig();
let activePool = createPool(activeConfig);

const pool = {
  query(...args) { return activePool.query(...args); },
  connect(...args) { return activePool.connect(...args); },
  end(...args) { return activePool.end(...args); },
  on(...args) { return activePool.on(...args); }
};

async function query(text, params) {
  try { return await activePool.query(text, params); }
  catch (err) { console.error('Query error:', err.message); throw err; }
}

async function testDatabaseConfig(input) {
  const cfg = normalize({ ...activeConfig, ...input, password: input && input.password === '' ? activeConfig.password : input.password });
  const probe = createPool({ ...cfg, max: 2, connectionTimeoutMillis: 5000 });
  try {
    const result = await probe.query('SELECT current_database() AS database, current_user AS username, inet_server_addr() AS server_ip, version() AS version');
    return { ok: true, config: cfg, server: result.rows[0] };
  } finally {
    await probe.end().catch(() => {});
  }
}

async function saveAndReconnectDatabase(input) {
  const candidate = normalize({ ...activeConfig, ...input, password: input && input.password === '' ? activeConfig.password : input.password });
  const probe = createPool({ ...candidate, max: 2, connectionTimeoutMillis: 5000 });
  try { await probe.query('SELECT 1'); }
  finally { await probe.end().catch(() => {}); }
  const saved = saveDatabaseConfig(candidate);
  const nextPool = createPool(saved);
  await nextPool.query('SELECT 1');
  const old = activePool;
  activePool = nextPool;
  activeConfig = saved;
  old.end().catch(() => {});
  return getPublicDatabaseConfig();
}

function currentDatabaseConfig() { return { ...activeConfig }; }

module.exports = { pool, query, testDatabaseConfig, saveAndReconnectDatabase, currentDatabaseConfig, getPublicDatabaseConfig };

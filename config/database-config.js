const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'database.json');
const DEFAULTS = {
  host: 'localhost',
  port: 5432,
  user: 'postgres',
  password: 'postgres',
  database: 'computer_store',
  ssl: false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
};

function readFileConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return {};
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    console.error('Database config warning:', err.message);
    return {};
  }
}

function normalize(input = {}) {
  const cfg = { ...DEFAULTS, ...input };
  cfg.host = String(cfg.host || 'localhost').trim();
  cfg.port = Math.max(1, Math.min(65535, Number(cfg.port) || 5432));
  cfg.user = String(cfg.user || 'postgres').trim();
  cfg.password = String(cfg.password == null ? '' : cfg.password);
  cfg.database = String(cfg.database || 'computer_store').trim();
  cfg.ssl = cfg.ssl === true || cfg.ssl === 'true' || cfg.ssl === 1 || cfg.ssl === '1';
  cfg.max = Math.max(2, Math.min(100, Number(cfg.max) || 20));
  cfg.idleTimeoutMillis = Math.max(1000, Number(cfg.idleTimeoutMillis) || 30000);
  cfg.connectionTimeoutMillis = Math.max(1000, Number(cfg.connectionTimeoutMillis) || 5000);
  return cfg;
}

function getDatabaseConfig() {
  const file = readFileConfig();
  return normalize({
    ...file,
    host: process.env.DB_HOST || file.host,
    port: process.env.DB_PORT || file.port,
    user: process.env.DB_USER || file.user,
    password: process.env.DB_PASS !== undefined ? process.env.DB_PASS : file.password,
    database: process.env.DB_NAME || file.database,
    ssl: process.env.DB_SSL !== undefined ? process.env.DB_SSL : file.ssl,
    max: process.env.DB_POOL_MAX || file.max
  });
}

function getPublicDatabaseConfig() {
  const cfg = getDatabaseConfig();
  return {
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    database: cfg.database,
    ssl: !!cfg.ssl,
    max: cfg.max,
    hasPassword: !!cfg.password,
    environmentOverride: !!(process.env.DB_HOST || process.env.DB_PORT || process.env.DB_USER || process.env.DB_PASS || process.env.DB_NAME || process.env.DB_SSL)
  };
}

function saveDatabaseConfig(input = {}) {
  const current = getDatabaseConfig();
  const cfg = normalize({
    ...current,
    host: input.host,
    port: input.port,
    user: input.user,
    password: input.password === undefined || input.password === '' ? current.password : input.password,
    database: input.database,
    ssl: input.ssl,
    max: input.max || current.max
  });
  const persisted = {
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    ssl: cfg.ssl,
    max: cfg.max
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(persisted, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(CONFIG_PATH, 0o600); } catch (_) {}
  return cfg;
}

module.exports = { CONFIG_PATH, DEFAULTS, getDatabaseConfig, getPublicDatabaseConfig, saveDatabaseConfig, normalize };

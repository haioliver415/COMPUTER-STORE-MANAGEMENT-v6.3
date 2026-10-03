const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const { pool } = require('./config/db');

const SALT_ROUNDS = 10;

async function applySchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'sql', 'database.sql'), 'utf8');
  const statements = sql.split(';').filter(s => s.trim());
  let applied = 0;
  for (const stmt of statements) {
    const cleaned = stmt.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('--') && !l.startsWith('/*')).join('\n').trim();
    if (!cleaned) continue;
    try { await pool.query(cleaned); applied++; }
    catch (e) {
      const msg = String(e.message || '');
      if (!/already exists|duplicate/i.test(msg)) console.log('SCHEMA SKIP:', msg.substring(0, 160));
    }
  }
  return applied;
}

async function ensureSystemDefaults() {
  const settingsCount = await pool.query('SELECT COUNT(*)::int AS count FROM settings');
  if (Number(settingsCount.rows[0].count) === 0) {
    await pool.query(`INSERT INTO settings
      (store_name,address,phone,currency_symbol,currency_code,second_currency_symbol,second_currency_code,exchange_rate,tax_rate,language)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      ['Computer Store', '', '', '$', 'USD', '៛', 'KHR', 4100, 0, 'en']);
  }

  const adminCount = await pool.query("SELECT COUNT(*)::int AS count FROM users WHERE role='admin'");
  if (Number(adminCount.rows[0].count) === 0) {
    const email = String(process.env.FIRST_ADMIN_EMAIL || 'admin@store.local').trim().toLowerCase();
    const password = String(process.env.FIRST_ADMIN_PASSWORD || 'admin123');
    const hash = bcrypt.hashSync(password, SALT_ROUNDS);
    await pool.query(`INSERT INTO users(name,email,password,role,is_active)
      VALUES($1,$2,$3,'admin',true) ON CONFLICT(email) DO NOTHING`, ['Administrator', email, hash]);
    console.log(`First admin ready: ${email}`);
  }
}

async function ensureLegacyInventoryCoverage() {
  const { createInventoryUnit } = require('./utils/inventory');
  const products = await pool.query('SELECT id,stock_qty FROM products WHERE is_active=true AND purged_at IS NULL ORDER BY id');
  for (const product of products.rows) {
    const tracked = await pool.query("SELECT COUNT(*)::int AS count FROM inventory_units WHERE product_id=$1 AND status='in_stock'", [product.id]);
    const missing = Math.max(0, Number(product.stock_qty || 0) - Number(tracked.rows[0].count || 0));
    for (let i = 0; i < missing; i++) {
      await createInventoryUnit(pool, {
        productId: product.id,
        sourceType: 'legacy',
        notes: 'Migrated from legacy stock quantity',
        movementType: 'legacy_opening'
      });
    }
  }
}

async function seedDatabase() {
  await pool.query('SELECT 1');
  const applied = await applySchema();
  await ensureSystemDefaults();
  await ensureLegacyInventoryCoverage();
  console.log('Database ready. Schema statements processed:', applied);
  return { ready: true };
}

async function testConnection() {
  const result = await pool.query('SELECT NOW() AS now,current_database() AS database,current_user AS username');
  console.log('PostgreSQL connected:', result.rows[0]);
  return result.rows[0];
}

if (require.main === module) {
  (async () => {
    await testConnection();
    await seedDatabase();
    console.log('\nFresh installs contain no sample products, customers, suppliers, sales, purchases or repairs.');
    console.log('If this was an empty database, default admin is admin@store.local / admin123 unless FIRST_ADMIN_* env values were set.');
    await pool.end();
  })().catch(e => {
    console.error('Setup failed:', e.message);
    process.exit(1);
  });
}

module.exports = { pool, seedDatabase, testConnection, applySchema, ensureSystemDefaults };

const express = require('express');
const router = express.Router();
const { pool, testDatabaseConfig, saveAndReconnectDatabase, getPublicDatabaseConfig } = require('../../config/db');
const { seedDatabase } = require('../../setup');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { ACCESS_KEYS, ACTION_KEYS, normalizeAccess, normalizePermissions } = require('../shared/permissions');
const { audit } = require('../../utils/inventory');
const fs = require('fs');
const path = require('path');
const os = require('os');
const multer = require('multer');

const restoreUpload = multer({ dest: os.tmpdir(), limits: { fileSize: 250 * 1024 * 1024 } });

const ACCESS_LABELS = {
  dashboard:'Dashboard', pos:'POS Sale', products:'Products', inventory:'Inventory & Stock', suppliers:'Purchases / Suppliers',
  customers:'Customers', repairs:'Repair Service', after_sales:'Warranty / After-Sales', reports:'Reports', settings:'Settings'
};
const ACTION_LABELS = {
  product_edit:'Edit products', product_delete:'Delete / restore products', inventory_adjust:'Stock adjustment', stock_count:'Physical stock count',
  purchase_manage:'Create / receive purchases', customer_manage:'Manage customers', sale_correction:'Return / exchange / correct sales',
  repair_manage:'Update repair workflow', repair_pricing:'Edit repair fee / parts price', report_export:'Export / print reports'
};

async function purgeExpiredDeletedProducts() {
  const sr = await pool.query('SELECT COALESCE(deleted_product_retention_days,30)::int AS days FROM settings ORDER BY id LIMIT 1');
  const days = Math.min(3650, Math.max(1, Number(sr.rows[0] && sr.rows[0].days) || 30));
  const r = await pool.query(`UPDATE products SET purged_at=NOW()
    WHERE is_active=false AND deleted_at IS NOT NULL AND purged_at IS NULL
      AND COALESCE(stock_qty,0)<=0
      AND deleted_at < NOW() - ($1::text || ' days')::interval RETURNING id`, [days]);
  return { days, purged:r.rowCount || 0 };
}

router.get('/', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const cleanup = await purgeExpiredDeletedProducts();
    const [settingsResult, usersResult, activityResult, deletedResult, archivedResult] = await Promise.all([
      pool.query('SELECT * FROM settings ORDER BY id LIMIT 1'),
      pool.query('SELECT id,name,email,role,is_active,access_json,permission_json FROM users ORDER BY name'),
      pool.query(`SELECT a.*,u.name AS user_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT 100`),
      pool.query(`SELECT p.id,p.name,p.product_code,p.model,p.stock_qty,p.deleted_at FROM products p WHERE p.is_active=false AND p.deleted_at IS NOT NULL AND p.purged_at IS NULL ORDER BY p.deleted_at DESC LIMIT 200`),
      pool.query(`SELECT COUNT(*)::int AS count FROM products WHERE is_active=false AND purged_at IS NOT NULL`)
    ]);
    const users = usersResult.rows.map(u => ({ ...u, access:normalizeAccess(u.access_json,u.role), permissions:normalizePermissions(u.permission_json,u.role) }));
    res.render('settings/index', {
      activePage:'settings', pageTitle:'Settings', user:req.session.user,
      settings:settingsResult.rows[0], users, activity:activityResult.rows,
      deletedProducts:deletedResult.rows, archivedCount:Number(archivedResult.rows[0].count)||0,
      accessKeys:ACCESS_KEYS, accessLabels:ACCESS_LABELS, actionKeys:ACTION_KEYS, actionLabels:ACTION_LABELS,
      cleanup, dbConfig:getPublicDatabaseConfig()
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error loading settings: '+err.message);
  }
});

router.post('/language', requireAuth, requireRole('admin'), async (req, res) => {
  try { await pool.query('UPDATE settings SET language=$1,updated_at=NOW() WHERE id=1',[req.body.language === 'km' ? 'km' : 'en']); }
  catch (err) { console.error(err); }
  res.redirect('/settings');
});

router.post('/update', requireAuth, requireRole('admin'), async (req, res) => {
  const { store_name,address,phone,currency_symbol,currency_code,second_currency_symbol,second_currency_code,exchange_rate,tax_rate,language }=req.body;
  try {
    await pool.query(`UPDATE settings SET store_name=$1,address=$2,phone=$3,currency_symbol=$4,currency_code=$5,second_currency_symbol=$6,second_currency_code=$7,exchange_rate=$8,tax_rate=$9,language=$10,updated_at=NOW() WHERE id=1`,
      [store_name,address,phone,currency_symbol,currency_code,second_currency_symbol,second_currency_code,parseFloat(exchange_rate)||4100,parseFloat(tax_rate)||0,language==='km'?'km':'en']);
  } catch (err) { console.error(err); }
  res.redirect('/settings');
});

router.post('/database/test', requireAuth, requireRole('admin'), async (req,res) => {
  try {
    const result = await testDatabaseConfig({
      host:req.body.host, port:req.body.port, user:req.body.user, password:req.body.password,
      database:req.body.database, ssl:req.body.ssl===true || req.body.ssl==='true' || req.body.ssl==='1'
    });
    res.json({success:true,server:result.server});
  } catch(err) { res.status(400).json({success:false,message:err.message}); }
});

router.post('/database/save', requireAuth, requireRole('admin'), async (req,res) => {
  try {
    const cfg = await saveAndReconnectDatabase({
      host:req.body.host, port:req.body.port, user:req.body.user, password:req.body.password,
      database:req.body.database, ssl:req.body.ssl===true || req.body.ssl==='true' || req.body.ssl==='1'
    });
    await seedDatabase();
    await new Promise(resolve => req.session.destroy(() => resolve()));
    res.clearCookie('connect.sid');
    res.json({success:true,config:cfg,message:'Database connection saved. Sign in again using a user from the selected database.'});
  } catch(err) { console.error(err); res.status(400).json({success:false,message:err.message}); }
});

router.post('/deleted-products/retention', requireAuth, requireRole('admin'), async (req,res) => {
  try {
    const days=Math.min(3650,Math.max(1,parseInt(req.body.days,10)||30));
    await pool.query('UPDATE settings SET deleted_product_retention_days=$1,updated_at=NOW() WHERE id=1',[days]);
    const cleanup=await purgeExpiredDeletedProducts();
    await audit(pool,req.session.user.id,'product_recycle_retention','settings',1,`retention=${days} days; archived=${cleanup.purged}`);
    res.redirect('/settings');
  } catch(err){console.error(err);res.redirect('/settings');}
});

router.post('/deleted-products/purge-now', requireAuth, requireRole('admin'), async (req,res) => {
  try { const result=await purgeExpiredDeletedProducts(); await audit(pool,req.session.user.id,'product_recycle_cleanup','settings',1,`archived=${result.purged}`); res.json({success:true,...result}); }
  catch(err){res.status(500).json({success:false,message:err.message});}
});

router.post('/user/:id/access', requireAuth, requireRole('admin'), async (req,res) => {
  try {
    const id=Number(req.params.id); if(!id) return res.status(400).json({success:false,message:'Invalid user.'});
    const target=(await pool.query('SELECT id,role,name FROM users WHERE id=$1',[id])).rows[0];
    if(!target) return res.status(404).json({success:false,message:'User not found.'});
    if(target.role==='admin') return res.status(400).json({success:false,message:'Admin accounts always have full access.'});
    const raw=Array.isArray(req.body.access)?req.body.access:[];
    const access=Array.from(new Set(raw.filter(k=>ACCESS_KEYS.includes(k)&&k!=='settings')));
    await pool.query('UPDATE users SET access_json=$1::jsonb,updated_at=NOW() WHERE id=$2',[JSON.stringify(access),id]);
    await audit(pool,req.session.user.id,'user_access_update','user',id,`${target.name}: ${access.join(',')||'no module access'}`);
    res.json({success:true,access});
  } catch(err){console.error(err);res.status(500).json({success:false,message:err.message});}
});

router.post('/user/:id/permissions', requireAuth, requireRole('admin'), async (req,res) => {
  try {
    const id=Number(req.params.id); if(!id) return res.status(400).json({success:false,message:'Invalid user.'});
    const target=(await pool.query('SELECT id,role,name FROM users WHERE id=$1',[id])).rows[0];
    if(!target) return res.status(404).json({success:false,message:'User not found.'});
    if(target.role==='admin') return res.status(400).json({success:false,message:'Admin accounts always have every permission.'});
    const raw=Array.isArray(req.body.permissions)?req.body.permissions:[];
    const permissions=Array.from(new Set(raw.filter(k=>ACTION_KEYS.includes(k))));
    await pool.query('UPDATE users SET permission_json=$1::jsonb,updated_at=NOW() WHERE id=$2',[JSON.stringify(permissions),id]);
    await audit(pool,req.session.user.id,'user_permission_update','user',id,`${target.name}: ${permissions.join(',')||'no action permissions'}`);
    res.json({success:true,permissions});
  } catch(err){console.error(err);res.status(500).json({success:false,message:err.message});}
});

function quoteIdent(name){return '"'+String(name).replace(/"/g,'""')+'"';}
function sqlLiteral(value){
  if(value===null||value===undefined)return'NULL';
  if(Buffer.isBuffer(value))return `'\\x${value.toString('hex')}'::bytea`;
  if(value instanceof Date)return `'${value.toISOString().replace(/'/g,"''")}'`;
  if(typeof value==='boolean')return value?'TRUE':'FALSE';
  if(typeof value==='number')return Number.isFinite(value)?String(value):'NULL';
  if(typeof value==='object')value=JSON.stringify(value);
  return `'${String(value).replace(/'/g,"''")}'`;
}

async function buildBackupSql() {
  const tablesResult=await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
  const tables=tablesResult.rows.map(r=>r.tablename);
  const schemaSql=fs.readFileSync(path.join(__dirname,'..','..','sql','database.sql'),'utf8');
  let sql=`-- Computer Store Management System V6.3 Backup\n-- Generated: ${new Date().toISOString()}\n-- Full schema + data backup.\n\n`+schemaSql+'\n\n';
  if(tables.length) sql+='TRUNCATE TABLE '+tables.map(quoteIdent).join(', ')+' RESTART IDENTITY CASCADE;\n\n';
  const preferredOrder=['users','categories','suppliers','customers','settings','products','sales','purchases','repairs','sale_items','purchase_items','repair_invoices','stock_adjustments','inventory_units','purchase_receipts','purchase_receipt_items','supplier_payments','customer_payments','sale_returns','sale_return_items','stock_counts','stock_count_items','inventory_movements','warranty_claims','sales_corrections','repair_events','audit_logs'];
  const ordered=preferredOrder.filter(t=>tables.includes(t)).concat(tables.filter(t=>!preferredOrder.includes(t)));
  for(const t of ordered){
    const columnsResult=await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,[t]);
    const dataResult=await pool.query(`SELECT * FROM ${quoteIdent(t)} ORDER BY 1`);
    if(!dataResult.rows.length)continue;
    const cols=columnsResult.rows.map(c=>c.column_name); sql+=`-- Data: ${t}\n`;
    for(const row of dataResult.rows) sql+=`INSERT INTO ${quoteIdent(t)} (${cols.map(quoteIdent).join(', ')}) VALUES (${cols.map(c=>sqlLiteral(row[c])).join(', ')});\n`;
    sql+='\n';
  }
  sql+='-- Reset serial sequences\n';
  for(const t of tables){
    const seqResult=await pool.query("SELECT pg_get_serial_sequence($1,'id') AS seq",[t]);
    if(seqResult.rows[0]&&seqResult.rows[0].seq) sql+=`SELECT setval(${sqlLiteral(seqResult.rows[0].seq)}, COALESCE((SELECT MAX(id) FROM ${quoteIdent(t)}),1), COALESCE((SELECT MAX(id) FROM ${quoteIdent(t)}),0)>0);\n`;
  }
  return sql;
}

router.get('/backup', requireAuth, requireRole('admin'), async (req,res) => {
  try {
    const sql=await buildBackupSql();
    const stamp=new Date().toISOString().replace(/[:.]/g,'-');
    res.setHeader('Content-Type','application/sql; charset=utf-8');
    res.setHeader('Content-Disposition',`attachment; filename="computer_store_v6_3_backup_${stamp}.sql"`);
    res.send(sql);
  } catch(err){console.error(err);res.status(500).send('Backup failed: '+err.message);}
});

router.post('/restore', requireAuth, requireRole('admin'), restoreUpload.single('backup_file'), async (req,res) => {
  let tmp=req.file&&req.file.path;
  try {
    if(!req.file) throw new Error('Choose a .sql backup file first.');
    if(path.extname(req.file.originalname).toLowerCase()!=='.sql') throw new Error('Only .sql backup files are accepted.');
    if(String(req.body.confirm_text||'').trim().toUpperCase()!=='RESTORE') throw new Error('Type RESTORE to confirm.');
    let sql=fs.readFileSync(tmp,'utf8');
    if(!/Computer Store Management System V\d/i.test(sql) || !/CREATE TABLE IF NOT EXISTS users/i.test(sql)) throw new Error('This file is not a recognized Computer Store database backup.');
    // Older backups used session_replication_role, which requires superuser privileges.
    // V6.3 restores in dependency order, so these lines are not needed.
    sql=sql.replace(/SET\s+session_replication_role\s*=\s*(replica|origin)\s*;/gi,'');

    const backupDir=path.join(__dirname,'..','..','backups'); fs.mkdirSync(backupDir,{recursive:true});
    const safety=await buildBackupSql();
    const safetyPath=path.join(backupDir,'pre-restore-'+new Date().toISOString().replace(/[:.]/g,'-')+'.sql');
    fs.writeFileSync(safetyPath,safety,'utf8');

    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
    } catch(err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }

    await seedDatabase();
    await new Promise(resolve => req.session.destroy(() => resolve()));
    res.clearCookie('connect.sid');
    res.json({success:true,message:'Restore completed. A safety backup was created before restore. Please sign in again.'});
  } catch(err){console.error('Restore failed:',err);res.status(400).json({success:false,message:err.message});}
  finally{if(tmp)fs.unlink(tmp,()=>{});}
});

module.exports = router;

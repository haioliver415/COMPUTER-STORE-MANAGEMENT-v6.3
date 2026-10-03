const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const methodOverride = require('method-override');
const path = require('path');
const os = require('os');
const expressLayouts = require('express-ejs-layouts');
const { pool, testDatabaseConfig, saveAndReconnectDatabase, getPublicDatabaseConfig } = require('./config/db');
const authRoutes = require('./modules/auth/routes');
const dashboardRoutes = require('./modules/dashboard/routes');
const posRoutes = require('./modules/pos/routes');
const productRoutes = require('./modules/products/routes');
const supplierRoutes = require('./modules/suppliers/routes');
const customerRoutes = require('./modules/customers/routes');
const repairRoutes = require('./modules/repairs/routes');
const reportRoutes = require('./modules/reports/routes');
const settingsRoutes = require('./modules/settings/routes');
const inventoryRoutes = require('./modules/inventory/routes');
const afterSalesRoutes = require('./modules/after-sales/routes');
const { seedDatabase } = require('./setup');
const { translator } = require('./modules/shared/i18n');
const { roleHome, hasAccess, hasPermission } = require('./modules/shared/permissions');
const { requireAccess, requireAuth } = require('./middleware/auth');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = String(process.env.APP_HOST || '0.0.0.0');
let dbReady = false;
let dbStartError = '';

app.use(expressLayouts);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('layout', 'layouts/app');
app.use(bodyParser.urlencoded({ extended: false, limit:'5mb' }));
app.use(bodyParser.json({ limit:'5mb' }));
app.use(methodOverride('_method'));
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-this-session-secret-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' }
}));
app.use(express.static(path.join(__dirname, 'public')));

app.use(async (req, res, next) => {
  let settings = {
    currency_symbol: '$', currency_code: 'USD', second_currency_symbol: '៛', second_currency_code: 'KHR',
    exchange_rate: 4100, tax_rate: 0, language: 'en', store_name:'Computer Store'
  };
  if (dbReady) {
    try {
      const r = await pool.query('SELECT * FROM settings ORDER BY id LIMIT 1');
      if (r.rows[0]) settings = { ...settings, ...r.rows[0] };
    } catch (_) {}
  }
  res.locals.settings = settings;
  res.locals.lang = settings.language === 'km' ? 'km' : 'en';
  res.locals.t = translator(res.locals.lang);
  const rsym = settings.second_currency_symbol || '៛';
  const rate = Number(settings.exchange_rate) || 4100;
  res.locals.fmtUSD = (n, d) => '$' + (Number(n)||0).toLocaleString('en-US',{minimumFractionDigits:d===undefined?2:d,maximumFractionDigits:d===undefined?2:d});
  res.locals.fmtRIEL = (n) => rsym + Math.round((Number(n)||0)*rate).toLocaleString('en-US');
  res.locals.money = res.locals.fmtUSD;
  res.locals.hasAccess = (key) => hasAccess(req.session && req.session.user, key);
  res.locals.hasPermission = (key) => hasPermission(req.session && req.session.user, key);
  next();
});

function setupAccessAllowed(req) {
  return !dbReady || (req.session && req.session.user && req.session.user.role === 'admin');
}

app.get('/database-setup', (req,res) => {
  if (!setupAccessAllowed(req)) return res.redirect('/auth/login');
  res.render('database-setup', { layout:false, dbConfig:getPublicDatabaseConfig(), dbReady, dbError:dbStartError });
});

app.post('/database-setup/test', async (req,res) => {
  if (!setupAccessAllowed(req)) return res.status(403).json({success:false,message:'Admin access required.'});
  try {
    const result=await testDatabaseConfig({host:req.body.host,port:req.body.port,user:req.body.user,password:req.body.password,database:req.body.database,ssl:req.body.ssl===true||req.body.ssl==='true'||req.body.ssl==='1'});
    res.json({success:true,server:result.server});
  } catch(err){res.status(400).json({success:false,message:err.message});}
});

app.post('/database-setup/save', async (req,res) => {
  if (!setupAccessAllowed(req)) return res.status(403).json({success:false,message:'Admin access required.'});
  try {
    await saveAndReconnectDatabase({host:req.body.host,port:req.body.port,user:req.body.user,password:req.body.password,database:req.body.database,ssl:req.body.ssl===true||req.body.ssl==='true'||req.body.ssl==='1'});
    await seedDatabase(); dbReady=true; dbStartError='';
    res.json({success:true,message:'Database connected and schema is ready.',redirect:'/auth/login'});
  } catch(err){dbReady=false;dbStartError=err.message;res.status(400).json({success:false,message:err.message});}
});

app.use((req,res,next) => {
  if (dbReady || req.path.startsWith('/database-setup') || req.path.startsWith('/css/') || req.path.startsWith('/js/') || req.path.startsWith('/vendor/')) return next();
  if (req.path.startsWith('/api/')) return res.status(503).json({success:false,message:'Database is not connected.'});
  return res.redirect('/database-setup');
});

// Shared product lookup used by Inventory, Purchases and After-Sales pickers.
app.get('/api/product-search', requireAuth, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim(); const like = `%${q}%`; const params = q ? [like] : [];
    const where = q ? `AND (p.name ILIKE $1 OR COALESCE(p.product_code,'') ILIKE $1 OR COALESCE(p.barcode,'') ILIKE $1 OR COALESCE(p.brand,'') ILIKE $1 OR COALESCE(p.model,'') ILIKE $1 OR EXISTS (SELECT 1 FROM inventory_units ix WHERE ix.product_id=p.id AND (COALESCE(ix.internal_code,'') ILIKE $1 OR COALESCE(ix.serial_number,'') ILIKE $1)))` : '';
    const rows = (await pool.query(`SELECT p.id,p.name,p.product_code,p.barcode,p.brand,p.model,p.stock_qty,p.min_stock,p.buy_price,p.sell_price,COALESCE(p.tracking_mode,'optional') AS tracking_mode,
      mu.internal_code AS matched_unit_code,mu.serial_number AS matched_serial,mu.status AS matched_unit_status
      FROM products p LEFT JOIN LATERAL (SELECT iu.internal_code,iu.serial_number,iu.status FROM inventory_units iu WHERE iu.product_id=p.id ${q ? `AND (COALESCE(iu.internal_code,'') ILIKE $1 OR COALESCE(iu.serial_number,'') ILIKE $1)` : ''} ORDER BY (iu.status='in_stock') DESC,iu.updated_at DESC,iu.id DESC LIMIT 1) mu ON true
      WHERE p.is_active=true AND p.purged_at IS NULL ${where} ORDER BY p.name LIMIT ${q ? 120 : 2000}`, params)).rows;
    res.json({ success:true, products:rows });
  } catch (err) { console.error(err); res.status(500).json({ success:false, message:'Product search failed.' }); }
});

app.get('/api/supplier-search', requireAuth, async (req, res) => {
  try { const q=String(req.query.q||'').trim();const params=[];let where='WHERE is_active=true';if(q){params.push('%'+q+'%');where+=` AND (name ILIKE $1 OR COALESCE(phone,'') ILIKE $1 OR COALESCE(email,'') ILIKE $1)`;}const rows=(await pool.query(`SELECT id,name,phone,email,address FROM suppliers ${where} ORDER BY name LIMIT 1000`,params)).rows;res.json({success:true,suppliers:rows}); }
  catch(err){console.error(err);res.status(500).json({success:false,message:'Supplier search failed.'});}
});

app.use('/auth', authRoutes);
app.use('/dashboard', requireAccess('dashboard'), dashboardRoutes);
app.use('/pos', requireAccess('pos'), posRoutes);
app.use('/products', requireAccess('products'), productRoutes);
app.use('/suppliers', requireAccess('suppliers'), supplierRoutes);
app.use('/customers', requireAccess('customers'), customerRoutes);
app.use('/repairs', requireAccess('repairs'), repairRoutes);
app.use('/reports', requireAccess('reports'), reportRoutes);
app.use('/settings', requireAccess('settings'), settingsRoutes);
app.use('/inventory', requireAccess('inventory'), inventoryRoutes);
app.use('/after-sales', requireAccess('after_sales'), afterSalesRoutes);
app.get('/', (req, res) => req.session.user ? res.redirect(roleHome(req.session.user.role, req.session.user.access)) : res.redirect('/auth/login'));

let maintenanceTimer;
async function runMaintenance() {
  if (!dbReady) return;
  try {
    const r=await pool.query('SELECT COALESCE(deleted_product_retention_days,30)::int AS days FROM settings ORDER BY id LIMIT 1');
    const days=Math.min(3650,Math.max(1,Number(r.rows[0]&&r.rows[0].days)||30));
    await pool.query(`UPDATE products SET purged_at=NOW() WHERE is_active=false AND COALESCE(stock_qty,0)<=0 AND deleted_at IS NOT NULL AND purged_at IS NULL AND deleted_at < NOW() - ($1::text || ' days')::interval`,[days]);
  } catch(err){console.error('Maintenance warning:',err.message);}
}

function localNetworkAddresses() {
  const out=[]; const nets=os.networkInterfaces();
  Object.values(nets).flat().forEach(n=>{if(n&&n.family==='IPv4'&&!n.internal)out.push(n.address);});
  return out;
}

let server;
async function startServer() {
  if (server && server.listening) return server;
  try { await seedDatabase(); dbReady=true; dbStartError=''; }
  catch(err){ dbReady=false; dbStartError=err.message; console.error('Database not ready:',err.message); }
  await runMaintenance();
  if(!maintenanceTimer){maintenanceTimer=setInterval(runMaintenance,6*60*60*1000);if(maintenanceTimer.unref)maintenanceTimer.unref();}
  await new Promise((resolve,reject)=>{server=app.listen(PORT,HOST,resolve);server.once('error',reject);});
  console.log(`Computer Store Management System V6.3 running on ${HOST}:${PORT}`);
  console.log(`Local: http://127.0.0.1:${PORT}`);
  localNetworkAddresses().forEach(ip=>console.log(`LAN:   http://${ip}:${PORT}`));
  if(!dbReady) console.log(`Open http://127.0.0.1:${PORT}/database-setup to configure PostgreSQL.`);
  return server;
}

if (require.main === module) startServer().catch(err=>{console.error('STARTUP FAILED:',err);process.exit(1);});

module.exports = { app, startServer, getDatabaseState:()=>({ready:dbReady,error:dbStartError}) };

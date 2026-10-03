const express = require('express');
const ExcelJS = require('exceljs');
const router = express.Router();
const { pool } = require('../../config/db');
const { requireAuth, requireRole, requirePermission } = require('../../middleware/auth');

const pageAccess = requireRole('admin', 'manager', 'stock');
const manageOnly = requireRole('admin', 'manager');
const stockColumns = {
  no: ['No.', '__row_no'], product_code: ['Product Code', 'product_code'], name: ['Product Name', 'name'],
  model: ['Model', 'model'], category: ['Category', 'category_name'], tracking: ['Tracking', 'tracking_mode'], system_qty: ['System Qty', 'stock_qty'],
  min_stock: ['Min Stock', 'min_stock'], status: ['Status', 'stock_status'], own: ['Own Stock', 'own_stock'],
  dealer: ['Dealer Stock', 'dealer_stock'], legacy: ['Legacy Stock', 'legacy_stock'], damaged: ['Damaged', 'damaged_stock'], lost: ['Lost', 'lost_stock'], buy_price: ['Buy Price', 'buy_price'], sell_price: ['Sell Price', 'sell_price']
};
const salesColumns = { sale_code:['Sale Code','sale_code'], date:['Date','created_at'], customer:['Customer','customer_name'], cashier:['Cashier','cashier_name'], subtotal:['Subtotal','subtotal'], discount:['Discount','discount'], tax:['Tax','tax'], total:['Total','total'], payment:['Payment','payment_method'], status:['Status','status'] };
const repairColumns = { ticket:['Ticket','ticket_code'], date:['Date','created_at'], customer:['Customer','customer_name'], phone:['Phone','customer_phone'], device:['Device','device_type'], model:['Model','device_model'], status:['Status','status'], technician:['Technician','tech_name'], estimated:['Estimated Cost','estimated_cost'], actual:['Actual Cost','actual_cost'] };

function stockColumnMapFor(role) {
  if (role === 'stock') { const safe = { ...stockColumns }; delete safe.buy_price; delete safe.sell_price; return safe; }
  return stockColumns;
}
function picked(req, map) {
  const raw = String(req.query.columns || '').split(',').filter(Boolean);
  const keys = raw.filter(k => map[k]);
  return (keys.length ? keys : Object.keys(map)).map(k => ({ key:k, label:map[k][0], field:map[k][1] }));
}
async function stockRows() {
  const r = await pool.query(`SELECT p.product_code,p.name,p.model,c.name AS category_name,COALESCE(p.tracking_mode,'optional') AS tracking_mode,p.stock_qty,p.min_stock,p.buy_price,p.sell_price,
    CASE WHEN p.stock_qty<=0 THEN 'OUT STOCK' WHEN p.stock_qty<=p.min_stock THEN 'LOW' ELSE 'OK' END AS stock_status,
    COUNT(iu.id) FILTER(WHERE iu.status='in_stock' AND iu.source_type='own')::int AS own_stock,
    COUNT(iu.id) FILTER(WHERE iu.status='in_stock' AND iu.source_type='dealer')::int AS dealer_stock,
    COUNT(iu.id) FILTER(WHERE iu.status='in_stock' AND iu.source_type='legacy')::int AS legacy_stock,
    COUNT(iu.id) FILTER(WHERE iu.status='damaged')::int AS damaged_stock,
    COUNT(iu.id) FILTER(WHERE iu.status='lost')::int AS lost_stock
    FROM products p JOIN categories c ON c.id=p.category_id LEFT JOIN inventory_units iu ON iu.product_id=p.id
    WHERE p.is_active=true GROUP BY p.id,c.name ORDER BY c.name,p.name`);
  return r.rows;
}
async function saleRows() { return (await pool.query(`SELECT s.*,COALESCE(c.name,'USER') AS customer_name,u.name AS cashier_name FROM sales s LEFT JOIN customers c ON c.id=s.customer_id LEFT JOIN users u ON u.id=s.user_id ORDER BY s.created_at DESC`)).rows; }
async function repairRows() { return (await pool.query(`SELECT r.*,COALESCE(c.name,r.customer_name,'Walk-in User') AS customer_name,COALESCE(c.phone,r.customer_phone) AS customer_phone,u.name AS tech_name FROM repairs r LEFT JOIN customers c ON c.id=r.customer_id LEFT JOIN users u ON u.id=r.assigned_technician_id ORDER BY r.created_at DESC`)).rows; }
function denyNonStockExport(req, res, next) {
  if (req.session.user.role === 'stock' && req.params.type !== 'stock') return res.status(403).send('Stock role can export Stock Report only.');
  next();
}

router.get('/', requireAuth, pageAccess, async (req, res) => {
  try {
    const stock = await stockRows();
    const repairs = ['admin','manager'].includes(req.session.user.role) ? await repairRows() : [];
    res.render('reports/index', { activePage:'reports', pageTitle:res.locals.t('reports'), user:req.session.user, stock, repairs, stockColumnOptions:stockColumnMapFor(req.session.user.role) });
  } catch (err) { console.error(err); res.status(500).send('Error loading reports'); }
});
router.get('/api/sales', requireAuth, manageOnly, async (req, res) => {
  try {
    let where='WHERE 1=1', params=[]; const period=req.query.period;
    if(req.query.start_date){params.push(req.query.start_date);where+=` AND s.created_at::date >= $${params.length}::date`;}
    if(req.query.end_date){params.push(req.query.end_date);where+=` AND s.created_at::date <= $${params.length}::date`;}
    if(!req.query.start_date&&!req.query.end_date){if(period==='today')where+=" AND s.created_at::date=CURRENT_DATE";else if(period==='week')where+=" AND s.created_at>=date_trunc('week',CURRENT_DATE)";else if(period==='month')where+=" AND s.created_at>=date_trunc('month',CURRENT_DATE)";}
    const rows=(await pool.query(`SELECT s.*,COALESCE(c.name,'USER') customer_name FROM sales s LEFT JOIN customers c ON c.id=s.customer_id ${where} ORDER BY s.created_at DESC`,params)).rows;
    const profit=(await pool.query(`SELECT COALESCE(SUM((si.unit_price-p.buy_price)*GREATEST(0,si.quantity-COALESCE(si.returned_quantity,0))),0) AS profit FROM sale_items si JOIN sales s ON s.id=si.sale_id JOIN products p ON p.id=si.product_id ${where}`,params)).rows[0].profit;
    res.json({sales:rows,profit});
  } catch(err){console.error(err);res.status(500).json({error:err.message});}
});
router.get('/api/best-products', requireAuth, manageOnly, async (req,res)=>{const r=await pool.query(`SELECT p.name,SUM(GREATEST(0,si.quantity-COALESCE(si.returned_quantity,0)))::int AS total_qty,SUM(si.subtotal) AS total_revenue FROM sale_items si JOIN products p ON p.id=si.product_id GROUP BY p.id ORDER BY total_qty DESC LIMIT 10`);res.json(r.rows);});
router.get('/api/stock-report', requireAuth, pageAccess, async (req,res)=>res.json(await stockRows()));
router.get('/api/repair-report', requireAuth, manageOnly, async (req,res)=>res.json(await repairRows()));
router.get('/stock-audit/print', requireAuth, pageAccess, requirePermission('report_export'), async (req,res)=>{const columns=picked(req,stockColumnMapFor(req.session.user.role)),rows=await stockRows();res.render('reports/stock-audit-print',{layout:false,settings:res.locals.settings,columns,rows});});
router.get('/export/:type', requireAuth, pageAccess, requirePermission('report_export'), denyNonStockExport, async (req,res)=>{
  try{
    let map,rows;if(req.params.type==='stock'){map=stockColumnMapFor(req.session.user.role);rows=await stockRows();}else if(req.params.type==='repairs'){map=repairColumns;rows=await repairRows();}else{map=salesColumns;rows=await saleRows();}
    const cols=picked(req,map);const esc=v=>'"'+String(v??'').replace(/"/g,'""')+'"';let csv='\ufeff'+cols.map(c=>esc(c.label)).join(',')+'\n';
    rows.forEach((row,index)=>{csv+=cols.map(c=>{const v=c.field==='__row_no'?index+1:row[c.field];return esc(v instanceof Date?v.toISOString():v);}).join(',')+'\n';});
    res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition',`attachment; filename="${req.params.type}-report.csv"`);res.send(csv);
  }catch(err){res.status(500).send(err.message);}
});
router.get('/export-excel/:type', requireAuth, pageAccess, requirePermission('report_export'), denyNonStockExport, async (req,res)=>{
  try{
    let map,rows;if(req.params.type==='stock'){map=stockColumnMapFor(req.session.user.role);rows=await stockRows();}else if(req.params.type==='repairs'){map=repairColumns;rows=await repairRows();}else{map=salesColumns;rows=await saleRows();}
    const cols=picked(req,map);const wb=new ExcelJS.Workbook(),ws=wb.addWorksheet('Report');ws.columns=cols.map(c=>({header:c.label,key:c.key,width:Math.max(12,c.label.length+4)}));
    rows.forEach((row,index)=>{const out={};cols.forEach(c=>out[c.key]=c.field==='__row_no'?index+1:row[c.field]);const r=ws.addRow(out);r.height=18;r.alignment={vertical:'middle',wrapText:false};});ws.getRow(1).font={bold:true};ws.getRow(1).height=20;ws.getRow(1).alignment={vertical:'middle',wrapText:false};ws.views=[{state:'frozen',ySplit:1}];
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.setHeader('Content-Disposition',`attachment; filename="${req.params.type}-report.xlsx"`);await wb.xlsx.write(res);res.end();
  }catch(err){console.error(err);res.status(500).send(err.message);}
});
module.exports=router;

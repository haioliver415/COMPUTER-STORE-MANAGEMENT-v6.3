const express = require('express');
const router = express.Router();
const { pool } = require('../../config/db');
const { requireAuth, requireRole, requirePermission } = require('../../middleware/auth');
const { makeCode, createInventoryUnit, ensureProductCoverage, audit } = require('../../utils/inventory');

function dateText(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}
function addMonths(value, months) {
  if (!value || !months || Number(months) <= 0) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  d.setMonth(d.getMonth() + Number(months));
  return d.toISOString().slice(0, 10);
}
function warrantyInfo(endValue, fallbackStart, fallbackMonths, applicable = true) {
  if (!applicable) return { status: 'not_applicable', end: null, remaining_days: null };
  const end = dateText(endValue) || addMonths(fallbackStart, fallbackMonths);
  if (!end) return { status: 'none', end: null, remaining_days: null };
  const today = new Date(); today.setHours(0,0,0,0);
  const endDate = new Date(end + 'T00:00:00');
  const remaining = Math.ceil((endDate - today) / 86400000);
  return { status: remaining >= 0 ? 'valid' : 'expired', end, remaining_days: remaining };
}
function warrantyStatus(soldAt, months, warrantyEnd) { return warrantyInfo(warrantyEnd, soldAt, months).status; }
function dealerStatus(sourceType, endDate) { return warrantyInfo(endDate, null, 0, sourceType === 'dealer').status; }

router.get('/', requireAuth, requireRole('admin', 'manager', 'stock'), async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const saleDate = String(req.query.sale_date || '').trim();
    const saleMonth = String(req.query.sale_month || '').trim();
    const saleYear = String(req.query.sale_year || '').trim();
    const receivedDate = String(req.query.received_date || '').trim();
    const params = [];
    let where = ' WHERE 1=1 ';
    if (q) {
      params.push(`%${q}%`);
      const n = params.length;
      where += ` AND (COALESCE(iu.serial_number,'') ILIKE $${n} OR iu.internal_code ILIKE $${n}
        OR COALESCE(p.product_code,'') ILIKE $${n} OR p.name ILIKE $${n} OR COALESCE(p.model,'') ILIKE $${n}
        OR COALESCE(p.brand,'') ILIKE $${n} OR COALESCE(sa.sale_code,'') ILIKE $${n}
        OR COALESCE(c.phone,'') ILIKE $${n} OR COALESCE(c.name,'') ILIKE $${n}
        OR COALESCE(s.name,'') ILIKE $${n} OR COALESCE(mv.reference,'') ILIKE $${n})`;
    }
    if (saleDate) { params.push(saleDate); where += ` AND COALESCE(iu.sold_at,sa.created_at)::date=$${params.length}::date`; }
    if (saleMonth) { params.push(saleMonth); where += ` AND TO_CHAR(COALESCE(iu.sold_at,sa.created_at),'YYYY-MM')=$${params.length}`; }
    if (saleYear) { params.push(saleYear); where += ` AND EXTRACT(YEAR FROM COALESCE(iu.sold_at,sa.created_at))=$${params.length}::int`; }
    if (receivedDate) { params.push(receivedDate); where += ` AND iu.received_at::date=$${params.length}::date`; }

    const result = await pool.query(`
      SELECT iu.*, p.name AS product_name, p.product_code, p.model, p.brand, p.warranty_months,
             s.name AS supplier_name, sa.sale_code, sa.created_at AS sale_date,
             c.id AS customer_id, c.name AS customer_name, c.phone AS customer_phone,
             si.id AS sale_item_id, si.unit_price, mv.reference AS purchase_reference
      FROM inventory_units iu
      JOIN products p ON p.id=iu.product_id
      LEFT JOIN suppliers s ON s.id=iu.supplier_id
      LEFT JOIN sales sa ON sa.id=iu.last_sale_id
      LEFT JOIN sale_items si ON si.id=iu.last_sale_item_id
      LEFT JOIN customers c ON c.id=sa.customer_id
      LEFT JOIN LATERAL (
        SELECT im.reference FROM inventory_movements im
        WHERE im.inventory_unit_id=iu.id AND im.movement_type IN ('dealer_purchase','receive','opening_stock','legacy_opening')
        ORDER BY im.created_at ASC LIMIT 1
      ) mv ON true
      ${where}
      ORDER BY COALESCE(iu.sold_at,iu.received_at) DESC NULLS LAST, iu.updated_at DESC LIMIT 250`, params);

    const warrantyRows = result.rows.map(r => {
      const store = warrantyInfo(r.customer_warranty_end, r.sale_date, r.warranty_months, Boolean(r.last_sale_id));
      const dealer = warrantyInfo(r.dealer_warranty_end, null, 0, r.source_type === 'dealer');
      return {
        ...r,
        store_warranty_status: store.status,
        store_warranty_end: store.end,
        store_remaining_days: store.remaining_days,
        dealer_warranty_status: dealer.status,
        dealer_warranty_end_text: dealer.end,
        dealer_remaining_days: dealer.remaining_days
      };
    });

    let saleItems = [], claims = [], products = [];
    if (['admin','manager'].includes(req.session.user.role)) {
      const [salesResult, claimsResult, productsResult] = await Promise.all([
        pool.query(`SELECT s.id AS sale_id, s.sale_code, s.created_at, s.total, s.status, c.name AS customer_name, c.phone,
          si.id AS sale_item_id, si.product_id, si.quantity, si.returned_quantity, si.unit_price, si.line_type,
          p.name AS product_name FROM sales s JOIN sale_items si ON si.sale_id=s.id JOIN products p ON p.id=si.product_id
          LEFT JOIN customers c ON c.id=s.customer_id ORDER BY s.created_at DESC, si.id DESC LIMIT 120`),
        pool.query(`SELECT wc.*, iu.internal_code, iu.serial_number, p.name AS product_name, s.name AS supplier_name,
          sa.sale_code, c.name AS customer_name FROM warranty_claims wc JOIN inventory_units iu ON iu.id=wc.inventory_unit_id
          JOIN products p ON p.id=iu.product_id LEFT JOIN suppliers s ON s.id=iu.supplier_id
          LEFT JOIN sales sa ON sa.id=wc.sale_id LEFT JOIN customers c ON c.id=wc.customer_id ORDER BY wc.created_at DESC LIMIT 80`),
        pool.query(`SELECT id, name, stock_qty FROM products WHERE is_active=true ORDER BY name`)
      ]);
      saleItems = salesResult.rows; claims = claimsResult.rows; products = productsResult.rows;
    }
    res.render('after-sales/index', {
      activePage: 'after-sales', pageTitle: 'Warranty & After-Sales', user: req.session.user,
      q, saleDate, saleMonth, saleYear, receivedDate, warrantyRows, saleItems, claims, products,
      success: req.query.success || '', errorMessage: req.query.error || ''
    });
  } catch (err) { console.error(err); res.status(500).send('Error loading after-sales'); }
});

router.post('/claim', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  const client = await pool.connect();
  try {
    const unitId = Number(req.body.inventory_unit_id);
    const issue = String(req.body.issue_description || '').trim();
    const requestedAction = req.body.requested_action || 'check';
    if (!issue) throw new Error('Issue description is required.');
    await client.query('BEGIN');
    const unitResult = await client.query(`SELECT iu.*, p.warranty_months, sa.customer_id, sa.created_at AS sale_date
      FROM inventory_units iu JOIN products p ON p.id=iu.product_id LEFT JOIN sales sa ON sa.id=iu.last_sale_id
      WHERE iu.id=$1 FOR UPDATE`, [unitId]);
    if (!unitResult.rows.length) throw new Error('Stock unit not found.');
    const unit = unitResult.rows[0];
    if (!unit.last_sale_id) throw new Error('This unit has no recorded sale yet.');
    if (unit.status !== 'sold') throw new Error(`This unit is currently ${unit.status}; it is not marked as being with a customer.`);
    const activeClaim = await client.query(`SELECT id, claim_code FROM warranty_claims WHERE inventory_unit_id=$1 AND status NOT IN ('closed','rejected','replaced') ORDER BY created_at DESC LIMIT 1`, [unit.id]);
    if (activeClaim.rows.length) throw new Error(`Active warranty claim already exists: ${activeClaim.rows[0].claim_code}`);
    const storeStatus = warrantyStatus(unit.sale_date, unit.warranty_months, unit.customer_warranty_end);
    const dealerWarrantyStatus = dealerStatus(unit.source_type, unit.dealer_warranty_end);
    const claimCode = makeCode('WRN');
    const result = await client.query(`INSERT INTO warranty_claims
      (claim_code, inventory_unit_id, sale_id, sale_item_id, customer_id, issue_description, requested_action,
       store_warranty_status, dealer_warranty_status, status, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'open',$10) RETURNING id`,
      [claimCode, unit.id, unit.last_sale_id, unit.last_sale_item_id, unit.customer_id || null, issue, requestedAction, storeStatus, dealerWarrantyStatus, req.session.user.id]);
    await client.query(`UPDATE inventory_units SET status='warranty_hold', updated_at=NOW() WHERE id=$1`, [unit.id]);
    await client.query(`INSERT INTO inventory_movements (inventory_unit_id, product_id, movement_type, sale_id, sale_item_id, reference, notes, user_id)
      VALUES ($1,$2,'warranty_receive',$3,$4,$5,$6,$7)`, [unit.id, unit.product_id, unit.last_sale_id, unit.last_sale_item_id, claimCode, issue, req.session.user.id]);
    await audit(client, req.session.user.id, 'warranty_claim_create', 'warranty_claim', result.rows[0].id, claimCode);
    await client.query('COMMIT');
    res.redirect('/after-sales?success=' + encodeURIComponent(`Warranty claim ${claimCode} created.`));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.redirect('/after-sales?error=' + encodeURIComponent(err.message));
  } finally { client.release(); }
});

router.post('/claim/:id/resolve', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  const client = await pool.connect();
  try {
    const claimId = Number(req.params.id);
    const resolution = req.body.resolution;
    const replacementProductId = Number(req.body.replacement_product_id) || null;
    const notes = req.body.notes || null;
    await client.query('BEGIN');
    const claimResult = await client.query(`SELECT wc.*, iu.product_id, iu.status AS unit_status, iu.last_sale_id, iu.last_sale_item_id, iu.customer_warranty_end
      FROM warranty_claims wc JOIN inventory_units iu ON iu.id=wc.inventory_unit_id WHERE wc.id=$1 FOR UPDATE`, [claimId]);
    if (!claimResult.rows.length) throw new Error('Claim not found.');
    const claim = claimResult.rows[0];
    if (['closed','rejected','replaced'].includes(claim.status)) throw new Error('Claim is already completed.');

    let claimStatus = 'closed';
    let replacementUnitId = null;
    if (resolution === 'send_to_dealer') {
      claimStatus = 'dealer_service';
      await client.query(`UPDATE inventory_units SET status='dealer_service', updated_at=NOW() WHERE id=$1`, [claim.inventory_unit_id]);
    } else if (resolution === 'repaired_return') {
      await client.query(`UPDATE inventory_units SET status='sold', updated_at=NOW() WHERE id=$1`, [claim.inventory_unit_id]);
    } else if (resolution === 'reject') {
      claimStatus = 'rejected';
      await client.query(`UPDATE inventory_units SET status='sold', updated_at=NOW() WHERE id=$1`, [claim.inventory_unit_id]);
    } else if (resolution === 'replace') {
      const newProductId = replacementProductId || claim.product_id;
      const pResult = await client.query('SELECT id, name, stock_qty FROM products WHERE id=$1 AND is_active=true FOR UPDATE', [newProductId]);
      if (!pResult.rows.length || Number(pResult.rows[0].stock_qty) < 1) throw new Error('Replacement product is out of stock.');
      await ensureProductCoverage(client, newProductId, Number(pResult.rows[0].stock_qty), req.session.user.id);
      const unitResult = await client.query(`SELECT * FROM inventory_units WHERE product_id=$1 AND status='in_stock'
        ORDER BY CASE source_type WHEN 'own' THEN 0 WHEN 'dealer' THEN 1 ELSE 2 END, received_at, id LIMIT 1 FOR UPDATE`, [newProductId]);
      if (!unitResult.rows.length) throw new Error('No replacement stock unit available.');
      const replacement = unitResult.rows[0];
      const saleItemResult = await client.query(`INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, subtotal, line_type, parent_sale_item_id)
        VALUES ($1,$2,1,0,0,'warranty_replacement',$3) RETURNING id`, [claim.sale_id, newProductId, claim.sale_item_id]);
      const newSaleItemId = saleItemResult.rows[0].id;
      await client.query(`UPDATE inventory_units SET status='sold', last_sale_id=$1, last_sale_item_id=$2, sold_at=NOW(), customer_warranty_end=$3, updated_at=NOW() WHERE id=$4`, [claim.sale_id, newSaleItemId, claim.customer_warranty_end || null, replacement.id]);
      await client.query('UPDATE products SET stock_qty=stock_qty-1, updated_at=NOW() WHERE id=$1', [newProductId]);
      await client.query(`UPDATE inventory_units SET status=$1, updated_at=NOW() WHERE id=$2`, [claim.dealer_warranty_status === 'valid' ? 'dealer_return' : 'warranty_returned', claim.inventory_unit_id]);
      await client.query(`UPDATE sale_items SET returned_quantity=LEAST(quantity, COALESCE(returned_quantity,0)+1) WHERE id=$1`, [claim.sale_item_id]);
      await client.query(`INSERT INTO inventory_movements (inventory_unit_id, product_id, movement_type, sale_id, sale_item_id, reference, notes, user_id)
        VALUES ($1,$2,'warranty_replacement_out',$3,$4,$5,$6,$7)`, [replacement.id, newProductId, claim.sale_id, newSaleItemId, claim.claim_code, notes, req.session.user.id]);
      replacementUnitId = replacement.id;
      claimStatus = 'replaced';
    } else {
      throw new Error('Invalid resolution.');
    }

    await client.query(`UPDATE warranty_claims SET status=$1, resolution=$2, replacement_unit_id=$3, notes=$4,
      updated_at=NOW(), closed_at=CASE WHEN $1 IN ('closed','rejected','replaced') THEN NOW() ELSE NULL END WHERE id=$5`,
      [claimStatus, resolution, replacementUnitId, notes, claimId]);
    await audit(client, req.session.user.id, 'warranty_claim_resolve', 'warranty_claim', claimId, `${resolution} -> ${claimStatus}`);
    await client.query('COMMIT');
    res.redirect('/after-sales?success=' + encodeURIComponent('Warranty claim updated.'));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.redirect('/after-sales?error=' + encodeURIComponent(err.message));
  } finally { client.release(); }
});


router.get('/sale-item/:id/units', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const line = await pool.query(`SELECT si.id,si.product_id,si.quantity,si.returned_quantity,p.name AS product_name,p.product_code,COALESCE(p.tracking_mode,'optional') AS tracking_mode
      FROM sale_items si JOIN products p ON p.id=si.product_id WHERE si.id=$1`, [req.params.id]);
    if (!line.rows.length) return res.status(404).json({ success:false, error:'Sale item not found.' });
    const units = await pool.query(`SELECT id,internal_code,serial_number,status FROM inventory_units WHERE last_sale_item_id=$1 AND status='sold' ORDER BY sold_at,id`, [req.params.id]);
    res.json({ success:true, line:line.rows[0], units:units.rows });
  } catch (err) { res.status(500).json({ success:false, error:err.message }); }
});

router.get('/product/:id/available-units', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const p = await pool.query(`SELECT id,name,product_code,stock_qty,COALESCE(tracking_mode,'optional') AS tracking_mode,sell_price FROM products WHERE id=$1 AND is_active=true`, [req.params.id]);
    if (!p.rows.length) return res.status(404).json({ success:false,error:'Product not found.' });
    const units = await pool.query(`SELECT id,internal_code,serial_number,source_type FROM inventory_units WHERE product_id=$1 AND status='in_stock' ORDER BY received_at NULLS FIRST,id LIMIT 500`, [req.params.id]);
    res.json({ success:true, product:p.rows[0], units:units.rows });
  } catch (err) { res.status(500).json({ success:false,error:err.message }); }
});

router.post('/return-sale', requireAuth, requireRole('admin', 'manager'), requirePermission('sale_correction'), async (req, res) => {
  const client = await pool.connect();
  try {
    const saleItemId=Number(req.body.sale_item_id), qty=Math.max(1,parseInt(req.body.quantity,10)||1), condition=['good','damaged','inspection'].includes(req.body.condition)?req.body.condition:'good';
    const reason=String(req.body.reason||'').trim(); let selected=[]; try{selected=JSON.parse(String(req.body.unit_ids_json||'[]'))}catch(_){} selected=Array.isArray(selected)?selected.map(Number).filter(Number.isInteger):[];
    if(!reason) throw new Error('Return reason is required.');
    await client.query('BEGIN');
    const lr=await client.query(`SELECT si.*,s.status AS sale_status,s.payment_method,s.customer_id,s.total AS sale_total,p.name AS product_name,COALESCE(p.tracking_mode,'optional') AS tracking_mode
      FROM sale_items si JOIN sales s ON s.id=si.sale_id JOIN products p ON p.id=si.product_id WHERE si.id=$1 FOR UPDATE`,[saleItemId]);
    if(!lr.rows.length)throw new Error('Sale item not found.'); const line=lr.rows[0],available=Number(line.quantity)-Number(line.returned_quantity||0); if(qty>available)throw new Error(`Only ${available} unit(s) can be returned.`);
    if(line.tracking_mode==='required'&&selected.length!==qty)throw new Error('Select the exact Serial / Unit for every returned unit.'); if(selected.length&&selected.length!==qty)throw new Error('Selected Unit count must match return quantity.');
    let ur;if(selected.length)ur=await client.query(`SELECT * FROM inventory_units WHERE last_sale_item_id=$1 AND status='sold' AND id=ANY($2::int[]) ORDER BY id FOR UPDATE`,[saleItemId,selected]);else ur=await client.query(`SELECT * FROM inventory_units WHERE last_sale_item_id=$1 AND status='sold' ORDER BY sold_at,id LIMIT $2 FOR UPDATE`,[saleItemId,qty]); if(ur.rows.length!==qty)throw new Error('Could not find all sold units for this return.');
    const returnCode=makeCode('RTN'),refund=Math.max(0,Math.min(Number(req.body.refund_amount)||Number(line.unit_price)*qty,Number(line.unit_price)*qty));
    const sr=await client.query(`INSERT INTO sale_returns(return_code,sale_id,return_type,refund_amount,reason,created_by) VALUES($1,$2,'return_refund',$3,$4,$5) RETURNING id`,[returnCode,line.sale_id,refund,reason,req.session.user.id]);
    let backToStock=0;
    for(const unit of ur.rows){const newStatus=condition==='good'?'in_stock':condition==='damaged'?'damaged':'inspection';await client.query(`UPDATE inventory_units SET status=$1,updated_at=NOW() WHERE id=$2`,[newStatus,unit.id]);await client.query(`INSERT INTO inventory_movements(inventory_unit_id,product_id,movement_type,quantity,sale_id,sale_item_id,reference,notes,user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[unit.id,line.product_id,condition==='good'?'sale_return':'sale_return_'+condition,condition==='good'?1:0,line.sale_id,saleItemId,returnCode,reason,req.session.user.id]);await client.query(`INSERT INTO sale_return_items(sale_return_id,sale_item_id,inventory_unit_id,quantity,condition,old_unit_price) VALUES($1,$2,$3,1,$4,$5)`,[sr.rows[0].id,saleItemId,unit.id,condition,line.unit_price]);if(condition==='good')backToStock++;}
    if(backToStock)await client.query('UPDATE products SET stock_qty=stock_qty+$1,updated_at=NOW() WHERE id=$2',[backToStock,line.product_id]); await client.query('UPDATE sale_items SET returned_quantity=COALESCE(returned_quantity,0)+$1 WHERE id=$2',[qty,saleItemId]);
    const rem=await client.query(`SELECT COALESCE(SUM(quantity-returned_quantity),0)::int AS remaining FROM sale_items WHERE sale_id=$1 AND line_type='sale'`,[line.sale_id]); const newStatus=Number(rem.rows[0].remaining)===0?'returned':'partially_returned'; await client.query('UPDATE sales SET total=GREATEST(0,total-$1),status=$2 WHERE id=$3',[refund,newStatus,line.sale_id]); if(line.payment_method==='credit'&&line.customer_id)await client.query('UPDATE customers SET due_balance=GREATEST(0,due_balance-$1) WHERE id=$2',[refund,line.customer_id]);
    await audit(client,req.session.user.id,'sale_return','sale_return',sr.rows[0].id,`${returnCode}; qty=${qty}; condition=${condition}; refund=${refund.toFixed(2)}`); await client.query('COMMIT'); res.redirect('/after-sales?success='+encodeURIComponent(`Return ${returnCode} saved. Refund $${refund.toFixed(2)}.`));
  } catch(err){await client.query('ROLLBACK');console.error(err);res.redirect('/after-sales?error='+encodeURIComponent(err.message));} finally{client.release();}
});

router.post('/void-sale/:id', requireAuth, requireRole('admin', 'manager'), requirePermission('sale_correction'), async (req, res) => {
  const client=await pool.connect();
  try{const saleId=Number(req.params.id),reason=String(req.body.reason||'').trim();if(!reason)throw new Error('Void reason is required.');await client.query('BEGIN');const sr=await client.query('SELECT * FROM sales WHERE id=$1 FOR UPDATE',[saleId]);if(!sr.rows.length)throw new Error('Sale not found.');const sale=sr.rows[0];if(['cancelled','returned'].includes(sale.status))throw new Error('Sale is already closed.');const lines=await client.query(`SELECT si.*,p.name FROM sale_items si JOIN products p ON p.id=si.product_id WHERE si.sale_id=$1 AND si.line_type='sale' ORDER BY si.id FOR UPDATE`,[saleId]);if(lines.rows.some(x=>Number(x.returned_quantity||0)>0))throw new Error('Cannot void a sale that already has returns. Use Return/Correction instead.');const returnCode=makeCode('VOID');const ret=await client.query(`INSERT INTO sale_returns(return_code,sale_id,return_type,refund_amount,reason,created_by) VALUES($1,$2,'void',$3,$4,$5) RETURNING id`,[returnCode,saleId,Number(sale.paid_amount)||0,reason,req.session.user.id]);for(const line of lines.rows){const units=await client.query(`SELECT * FROM inventory_units WHERE last_sale_item_id=$1 AND status='sold' FOR UPDATE`,[line.id]);for(const unit of units.rows){await client.query(`UPDATE inventory_units SET status='in_stock',updated_at=NOW() WHERE id=$1`,[unit.id]);await client.query(`INSERT INTO inventory_movements(inventory_unit_id,product_id,movement_type,quantity,sale_id,sale_item_id,reference,notes,user_id) VALUES($1,$2,'sale_void',1,$3,$4,$5,$6,$7)`,[unit.id,line.product_id,saleId,line.id,returnCode,reason,req.session.user.id]);await client.query(`INSERT INTO sale_return_items(sale_return_id,sale_item_id,inventory_unit_id,quantity,condition,old_unit_price) VALUES($1,$2,$3,1,'good',$4)`,[ret.rows[0].id,line.id,unit.id,line.unit_price]);}await client.query('UPDATE products SET stock_qty=stock_qty+$1,updated_at=NOW() WHERE id=$2',[line.quantity,line.product_id]);await client.query('UPDATE sale_items SET returned_quantity=quantity WHERE id=$1',[line.id]);}if(sale.payment_method==='credit'&&sale.customer_id){const duePart=Math.max(0,Number(sale.total)-Number(sale.paid_amount));if(duePart)await client.query('UPDATE customers SET due_balance=GREATEST(0,due_balance-$1) WHERE id=$2',[duePart,sale.customer_id]);}await client.query(`UPDATE sales SET status='cancelled',notes=COALESCE(notes,'')||$1 WHERE id=$2`,[`\nVOID ${returnCode}: ${reason}`,saleId]);await audit(client,req.session.user.id,'sale_void','sale',saleId,`${returnCode}; ${reason}`);await client.query('COMMIT');res.redirect('/after-sales?success='+encodeURIComponent(`Sale voided: ${returnCode}`));}catch(err){await client.query('ROLLBACK');res.redirect('/after-sales?error='+encodeURIComponent(err.message));}finally{client.release();}
});

router.post('/correct-sale', requireAuth, requireRole('admin', 'manager'), requirePermission('sale_correction'), async (req, res) => {
  const client = await pool.connect();
  try {
    const saleItemId = Number(req.body.sale_item_id);
    const qty = Math.max(1, parseInt(req.body.quantity, 10) || 1);
    const correctionType = req.body.correction_type === 'wrong_item_replace' ? 'wrong_item_replace' : 'wrong_item_return';
    const replacementProductId = Number(req.body.replacement_product_id) || null;
    const reason = String(req.body.reason || '').trim();
    let returnedUnitIds=[]; try{returnedUnitIds=JSON.parse(String(req.body.return_unit_ids_json||'[]'))}catch(_){} returnedUnitIds=Array.isArray(returnedUnitIds)?returnedUnitIds.map(Number).filter(Number.isInteger):[];
    let replacementUnitIds=[]; try{replacementUnitIds=JSON.parse(String(req.body.replacement_unit_ids_json||'[]'))}catch(_){} replacementUnitIds=Array.isArray(replacementUnitIds)?replacementUnitIds.map(Number).filter(Number.isInteger):[];
    if (!reason) throw new Error('Correction reason is required.');
    if (correctionType === 'wrong_item_replace' && !replacementProductId) throw new Error('Select a replacement product.');

    await client.query('BEGIN');
    const lineResult = await client.query(`SELECT si.*, s.total AS sale_total, s.payment_method, s.customer_id, s.created_at AS sale_date, COALESCE(p.tracking_mode,'optional') AS tracking_mode FROM sale_items si JOIN sales s ON s.id=si.sale_id JOIN products p ON p.id=si.product_id WHERE si.id=$1 FOR UPDATE`, [saleItemId]);
    if (!lineResult.rows.length) throw new Error('Sale item not found.');
    const line = lineResult.rows[0];
    const availableToReturn = Number(line.quantity) - Number(line.returned_quantity || 0);
    if (qty > availableToReturn) throw new Error(`Only ${availableToReturn} unit(s) can be corrected.`);

    if (line.tracking_mode === 'required' && returnedUnitIds.length !== qty) throw new Error('Select the exact Serial / Unit being corrected.');
    if (returnedUnitIds.length && returnedUnitIds.length !== qty) throw new Error('Selected return Unit count must match quantity.');
    const soldUnits = returnedUnitIds.length
      ? await client.query(`SELECT * FROM inventory_units WHERE last_sale_item_id=$1 AND status='sold' AND id=ANY($2::int[]) ORDER BY sold_at,id FOR UPDATE`, [saleItemId, returnedUnitIds])
      : await client.query(`SELECT * FROM inventory_units WHERE last_sale_item_id=$1 AND status='sold' ORDER BY sold_at, id LIMIT $2 FOR UPDATE`, [saleItemId, qty]);
    if (returnedUnitIds.length && soldUnits.rows.length !== qty) throw new Error('One or more selected sold units are not available for correction.');
    let returnedUnits = soldUnits.rows;
    while (returnedUnits.length < qty) {
      const unit = await createInventoryUnit(client, {
        productId: line.product_id, sourceType: 'legacy', status: 'in_stock', userId: req.session.user.id,
        notes: 'Legacy sale return created during correction', movementType: 'legacy_return'
      });
      returnedUnits.push(unit);
    }
    for (const unit of soldUnits.rows) {
      await client.query(`UPDATE inventory_units SET status='in_stock', updated_at=NOW() WHERE id=$1`, [unit.id]);
      await client.query(`INSERT INTO inventory_movements (inventory_unit_id, product_id, movement_type, sale_id, sale_item_id, reference, notes, user_id)
        VALUES ($1,$2,'sale_correction_return',$3,$4,$5,$6,$7)`, [unit.id, line.product_id, line.sale_id, saleItemId, 'Wrong item correction', reason, req.session.user.id]);
    }
    await client.query('UPDATE products SET stock_qty=stock_qty+$1, updated_at=NOW() WHERE id=$2', [qty, line.product_id]);
    await client.query('UPDATE sale_items SET returned_quantity=COALESCE(returned_quantity,0)+$1 WHERE id=$2', [qty, saleItemId]);

    let replacementSaleItemId = null;
    let difference = -(Number(line.unit_price) * qty);
    if (correctionType === 'wrong_item_replace') {
      const pResult = await client.query('SELECT * FROM products WHERE id=$1 AND is_active=true FOR UPDATE', [replacementProductId]);
      if (!pResult.rows.length || Number(pResult.rows[0].stock_qty) < qty) throw new Error('Not enough replacement stock.');
      await ensureProductCoverage(client, replacementProductId, Number(pResult.rows[0].stock_qty), req.session.user.id);
      if ((pResult.rows[0].tracking_mode || 'optional') === 'required' && replacementUnitIds.length !== qty) throw new Error('Select the exact replacement Serial / Unit.');
      if (replacementUnitIds.length && replacementUnitIds.length !== qty) throw new Error('Selected replacement Unit count must match quantity.');
      const replUnits = replacementUnitIds.length
        ? await client.query(`SELECT * FROM inventory_units WHERE product_id=$1 AND status='in_stock' AND id=ANY($2::int[]) ORDER BY received_at,id FOR UPDATE`, [replacementProductId,replacementUnitIds])
        : await client.query(`SELECT * FROM inventory_units WHERE product_id=$1 AND status='in_stock' ORDER BY CASE source_type WHEN 'own' THEN 0 WHEN 'dealer' THEN 1 ELSE 2 END, received_at, id LIMIT $2 FOR UPDATE`, [replacementProductId,qty]);
      if (replUnits.rows.length < qty) throw new Error('Replacement stock tracking is incomplete or selected units are no longer available.');
      const unitPrice = Number(pResult.rows[0].sell_price);
      const newLine = await client.query(`INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, subtotal, line_type, parent_sale_item_id)
        VALUES ($1,$2,$3,$4,$5,'correction_replacement',$6) RETURNING id`, [line.sale_id, replacementProductId, qty, unitPrice, unitPrice * qty, saleItemId]);
      replacementSaleItemId = newLine.rows[0].id;
      let replacementWarrantyEnd = null;
      if (Number(pResult.rows[0].warranty_months) > 0) {
        const d = new Date(line.sale_date); d.setMonth(d.getMonth() + Number(pResult.rows[0].warranty_months)); replacementWarrantyEnd = d.toISOString().slice(0,10);
      }
      for (const unit of replUnits.rows) {
        await client.query(`UPDATE inventory_units SET status='sold', last_sale_id=$1, last_sale_item_id=$2, sold_at=NOW(), customer_warranty_end=$3, updated_at=NOW() WHERE id=$4`, [line.sale_id, replacementSaleItemId, replacementWarrantyEnd, unit.id]);
        await client.query(`INSERT INTO inventory_movements (inventory_unit_id, product_id, movement_type, sale_id, sale_item_id, reference, notes, user_id)
          VALUES ($1,$2,'sale_correction_replace',$3,$4,$5,$6,$7)`, [unit.id, replacementProductId, line.sale_id, replacementSaleItemId, 'Wrong item correction', reason, req.session.user.id]);
      }
      await client.query('UPDATE products SET stock_qty=stock_qty-$1, updated_at=NOW() WHERE id=$2', [qty, replacementProductId]);
      difference = (unitPrice - Number(line.unit_price)) * qty;
    }

    await client.query('UPDATE sales SET total=GREATEST(0,total+$1), status=$2 WHERE id=$3', [difference, correctionType === 'wrong_item_return' ? 'partially_returned' : 'corrected', line.sale_id]);
    if (line.payment_method === 'credit' && line.customer_id) {
      await client.query('UPDATE customers SET due_balance=GREATEST(0,due_balance+$1) WHERE id=$2', [difference, line.customer_id]);
    }
    const code = makeCode('COR');
    const corr = await client.query(`INSERT INTO sales_corrections
      (correction_code, sale_id, original_sale_item_id, replacement_sale_item_id, correction_type, quantity, reason, amount_difference, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [code, line.sale_id, saleItemId, replacementSaleItemId, correctionType, qty, reason, difference, req.session.user.id]);
    await audit(client, req.session.user.id, 'sale_correction', 'sales_correction', corr.rows[0].id, `${code}: ${reason}`);
    await client.query('COMMIT');
    res.redirect('/after-sales?success=' + encodeURIComponent(`Correction ${code} saved. Price difference: $${difference.toFixed(2)}`));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.redirect('/after-sales?error=' + encodeURIComponent(err.message));
  } finally { client.release(); }
});

module.exports = router;

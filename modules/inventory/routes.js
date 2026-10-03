const express = require('express');
const router = express.Router();
const { pool } = require('../../config/db');
const { requireAuth, requireRole, requirePermission } = require('../../middleware/auth');
const { parseSerials, createInventoryUnit, audit, makeCode } = require('../../utils/inventory');

const pageAccess = requireRole('admin', 'manager', 'stock');
const stockWork = requireRole('admin', 'manager', 'stock');
const manage = requireRole('admin', 'manager');
const validSources = ['own', 'dealer', 'legacy'];
const validTracking = ['quantity', 'optional', 'required'];

function trackingMode(product) {
  return validTracking.includes(product && product.tracking_mode) ? product.tracking_mode : 'optional';
}

async function assertSerialRules(client, product, qty, serials, excludeUnitId = null) {
  const mode = trackingMode(product);
  const normalized = serials.map(v => String(v || '').trim()).filter(Boolean);
  const upper = normalized.map(v => v.toUpperCase());
  if (new Set(upper).size !== upper.length) throw new Error('Duplicate Serial Number entered.');
  if (mode === 'quantity' && normalized.length) throw new Error(`${product.name}: this product is Quantity only and does not use Serial Numbers.`);
  if (mode === 'required' && normalized.length !== qty) throw new Error(`${product.name}: Serial Required needs one Serial Number for every unit (${qty}).`);
  if (normalized.length > qty) throw new Error(`${product.name}: Serial count cannot be greater than quantity.`);
  if (upper.length) {
    const params = [upper];
    let sql = `SELECT id, serial_number FROM inventory_units WHERE UPPER(serial_number)=ANY($1::text[])`;
    if (excludeUnitId) { params.push(excludeUnitId); sql += ` AND id<>$2`; }
    sql += ' LIMIT 1';
    const existing = await client.query(sql, params);
    if (existing.rows.length) throw new Error(`Serial Number already exists: ${existing.rows[0].serial_number}`);
  }
  return normalized;
}

router.get('/', requireAuth, pageAccess, async (req, res) => {
  try {
    const [productsResult, suppliersResult, unitsResult, historyResult, summaryResult, exceptionResult, todayResult, countsResult] = await Promise.all([
      pool.query(`SELECT p.id, p.name, p.product_code, p.barcode, p.brand, p.model, p.stock_qty, p.min_stock, p.buy_price, p.warranty_months,
        COALESCE(p.tracking_mode,'optional') AS tracking_mode,
        COUNT(iu.id) FILTER (WHERE iu.status='in_stock' AND iu.source_type='own')::int AS own_stock,
        COUNT(iu.id) FILTER (WHERE iu.status='in_stock' AND iu.source_type='dealer')::int AS dealer_stock,
        COUNT(iu.id) FILTER (WHERE iu.status='in_stock' AND iu.source_type='legacy')::int AS legacy_stock,
        COUNT(iu.id) FILTER (WHERE iu.status='in_stock')::int AS tracked_stock,
        COUNT(iu.id) FILTER (WHERE iu.status='damaged')::int AS damaged_stock,
        COUNT(iu.id) FILTER (WHERE iu.status='lost')::int AS lost_stock
        FROM products p LEFT JOIN inventory_units iu ON iu.product_id=p.id
        WHERE p.is_active=true GROUP BY p.id ORDER BY p.name`),
      pool.query('SELECT id,name,phone,email FROM suppliers WHERE is_active=true ORDER BY name'),
      pool.query(`SELECT iu.*, p.name AS product_name, p.product_code, COALESCE(p.tracking_mode,'optional') AS tracking_mode, s.name AS supplier_name
        FROM inventory_units iu JOIN products p ON p.id=iu.product_id
        LEFT JOIN suppliers s ON s.id=iu.supplier_id
        ORDER BY iu.created_at DESC LIMIT 300`),
      pool.query(`SELECT im.*, p.name AS product_name, p.product_code, iu.internal_code, iu.serial_number, u.name AS user_name
        FROM inventory_movements im JOIN products p ON p.id=im.product_id
        LEFT JOIN inventory_units iu ON iu.id=im.inventory_unit_id
        LEFT JOIN users u ON u.id=im.user_id ORDER BY im.created_at DESC LIMIT 150`),
      pool.query(`SELECT COUNT(*)::int AS product_count,
        COALESCE(SUM(stock_qty),0)::int AS total_stock,
        COUNT(*) FILTER (WHERE stock_qty>0 AND stock_qty<=min_stock)::int AS low_stock,
        COUNT(*) FILTER (WHERE stock_qty<=0)::int AS out_stock,
        COALESCE(SUM(stock_qty * buy_price),0)::numeric AS stock_value
        FROM products WHERE is_active=true`),
      pool.query(`SELECT
        COUNT(*) FILTER (WHERE status='damaged')::int AS damaged,
        COUNT(*) FILTER (WHERE status='lost')::int AS lost
        FROM inventory_units`),
      pool.query(`SELECT
        COUNT(*) FILTER (WHERE movement_type IN ('receive','dealer_purchase','opening_stock','legacy_opening','adjustment_add','sale_correction_return','legacy_return','sale_return','sale_void','stock_count_add'))::int AS stock_in,
        COUNT(*) FILTER (WHERE movement_type IN ('sale','adjustment_remove','adjustment_damaged','adjustment_lost','warranty_replacement_out','sale_correction_replace','stock_count_remove'))::int AS stock_out
        FROM inventory_movements WHERE created_at::date=CURRENT_DATE`),
      pool.query(`SELECT sc.*,u.name AS created_by_name,uc.name AS confirmed_by_name,
        COUNT(sci.id)::int AS item_count,COUNT(sci.id) FILTER (WHERE COALESCE(sci.difference,0)<>0)::int AS difference_count
        FROM stock_counts sc LEFT JOIN users u ON u.id=sc.created_by LEFT JOIN users uc ON uc.id=sc.confirmed_by
        LEFT JOIN stock_count_items sci ON sci.stock_count_id=sc.id GROUP BY sc.id,u.name,uc.name ORDER BY sc.created_at DESC LIMIT 30`)
    ]);
    const summary = { ...summaryResult.rows[0], ...exceptionResult.rows[0], today_in: todayResult.rows[0].stock_in, today_out: todayResult.rows[0].stock_out };
    res.render('inventory/index', {
      activePage: 'inventory', pageTitle: 'Inventory & Stock', user: req.session.user,
      products: productsResult.rows, suppliers: suppliersResult.rows,
      units: unitsResult.rows, history: historyResult.rows, summary, counts: countsResult.rows,
      success: req.query.success || '', errorMessage: req.query.error || ''
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error loading inventory and stock');
  }
});

router.post('/receive', requireAuth, stockWork, requirePermission('inventory_adjust'), async (req, res) => {
  const client = await pool.connect();
  try {
    const productId = Number(req.body.product_id);
    const qty = Math.max(1, parseInt(req.body.quantity, 10) || 1);
    const sourceType = req.body.source_type === 'dealer' ? 'dealer' : 'own';
    const supplierId = sourceType === 'dealer' ? (Number(req.body.supplier_id) || null) : null;
    const costPrice = Math.max(0, Number(req.body.cost_price) || 0);
    const rawSerials = parseSerials(req.body.serial_numbers);
    const dealerWarrantyMonths = Math.max(0, parseInt(req.body.dealer_warranty_months, 10) || 0);
    const notes = String(req.body.notes || '').trim() || null;
    const reference = String(req.body.reference || '').trim() || 'Manual stock receive';
    if (sourceType === 'dealer' && !supplierId) throw new Error('Dealer stock requires a Dealer / Supplier.');

    await client.query('BEGIN');
    const productResult = await client.query('SELECT id, name, tracking_mode FROM products WHERE id=$1 AND is_active=true FOR UPDATE', [productId]);
    if (!productResult.rows.length) throw new Error('Product not found.');
    const product = productResult.rows[0];
    const serials = await assertSerialRules(client, product, qty, rawSerials);

    let dealerWarrantyEnd = null;
    if (sourceType === 'dealer' && dealerWarrantyMonths > 0) {
      const d = new Date();
      d.setMonth(d.getMonth() + dealerWarrantyMonths);
      dealerWarrantyEnd = d.toISOString().slice(0, 10);
    }

    for (let i = 0; i < qty; i++) {
      await createInventoryUnit(client, {
        productId,
        serialNumber: serials[i] || null,
        sourceType,
        supplierId,
        costPrice,
        dealerWarrantyEnd,
        notes,
        userId: req.session.user.id,
        reference,
        movementType: 'receive'
      });
    }
    await client.query('UPDATE products SET stock_qty=stock_qty+$1, buy_price=CASE WHEN $2>0 THEN $2 ELSE buy_price END, updated_at=NOW() WHERE id=$3', [qty, costPrice, productId]);
    await audit(client, req.session.user.id, 'stock_receive', 'product', productId, `${qty} unit(s), source=${sourceType}, tracking=${trackingMode(product)}, reference=${reference}`);
    await client.query('COMMIT');
    res.redirect('/inventory?success=' + encodeURIComponent(`Received ${qty} unit(s) into stock.`));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.redirect('/inventory?error=' + encodeURIComponent(err.message));
  } finally {
    client.release();
  }
});

router.post('/adjust', requireAuth, manage, requirePermission('inventory_adjust'), async (req, res) => {
  const client = await pool.connect();
  try {
    const productId = Number(req.body.product_id);
    const qty = Math.max(1, parseInt(req.body.quantity, 10) || 1);
    const type = ['add', 'remove', 'damaged', 'lost'].includes(req.body.adjustment_type) ? req.body.adjustment_type : null;
    const reason = String(req.body.reason || '').trim();
    const reference = String(req.body.reference || '').trim() || 'Stock adjustment';
    const serials = parseSerials(req.body.serial_numbers);
    const unitRefs = parseSerials(req.body.unit_refs).map(v => v.toUpperCase());
    if (!type) throw new Error('Select an adjustment type.');
    if (!reason) throw new Error('Adjustment reason is required.');

    await client.query('BEGIN');
    const productResult = await client.query('SELECT id,name,stock_qty,tracking_mode,buy_price FROM products WHERE id=$1 AND is_active=true FOR UPDATE', [productId]);
    if (!productResult.rows.length) throw new Error('Product not found.');
    const product = productResult.rows[0];

    if (type === 'add') {
      const checkedSerials = await assertSerialRules(client, product, qty, serials);
      for (let i = 0; i < qty; i++) {
        await createInventoryUnit(client, {
          productId,
          serialNumber: checkedSerials[i] || null,
          sourceType: 'own',
          costPrice: Number(product.buy_price) || 0,
          notes: reason,
          userId: req.session.user.id,
          reference,
          movementType: 'adjustment_add'
        });
      }
      await client.query('UPDATE products SET stock_qty=stock_qty+$1, updated_at=NOW() WHERE id=$2', [qty, productId]);
      await client.query(`INSERT INTO stock_adjustments (product_id,adjustment_type,quantity,reason,reference,user_id) VALUES ($1,'add',$2,$3,$4,$5)`, [productId, qty, reason, reference, req.session.user.id]);
    } else {
      if (Number(product.stock_qty) < qty) throw new Error(`${product.name}: only ${product.stock_qty} unit(s) are available.`);
      if (trackingMode(product) === 'required' && unitRefs.length !== qty) {
        throw new Error(`${product.name}: enter the Serial Number or Unit Code for every unit being removed/damaged/lost.`);
      }
      if (unitRefs.length && unitRefs.length !== qty) throw new Error('The number of Unit/Serial references must match Quantity.');

      let unitsResult;
      if (unitRefs.length) {
        unitsResult = await client.query(`SELECT * FROM inventory_units
          WHERE product_id=$1 AND status='in_stock'
          AND (UPPER(COALESCE(serial_number,''))=ANY($2::text[]) OR UPPER(internal_code)=ANY($2::text[]))
          ORDER BY received_at NULLS FIRST,id FOR UPDATE`, [productId, unitRefs]);
        if (unitsResult.rows.length !== qty) throw new Error(`Could not find all ${qty} requested in-stock Unit/Serial codes for this product.`);
      } else {
        unitsResult = await client.query(`SELECT * FROM inventory_units WHERE product_id=$1 AND status='in_stock'
          ORDER BY received_at NULLS FIRST,id LIMIT $2 FOR UPDATE`, [productId, qty]);
        if (unitsResult.rows.length < qty) throw new Error(`${product.name}: stock tracking is incomplete.`);
      }

      const status = type === 'damaged' ? 'damaged' : type === 'lost' ? 'lost' : 'adjusted_out';
      const movementType = type === 'damaged' ? 'adjustment_damaged' : type === 'lost' ? 'adjustment_lost' : 'adjustment_remove';
      for (const unit of unitsResult.rows) {
        await client.query('UPDATE inventory_units SET status=$1, notes=COALESCE(notes,\'\') || $2, updated_at=NOW() WHERE id=$3', [status, `\nAdjustment: ${reason}`, unit.id]);
        await client.query(`INSERT INTO inventory_movements (inventory_unit_id,product_id,movement_type,quantity,reference,notes,user_id)
          VALUES ($1,$2,$3,-1,$4,$5,$6)`, [unit.id, productId, movementType, reference, reason, req.session.user.id]);
      }
      await client.query('UPDATE products SET stock_qty=stock_qty-$1, updated_at=NOW() WHERE id=$2', [qty, productId]);
      await client.query(`INSERT INTO stock_adjustments (product_id,adjustment_type,quantity,reason,reference,user_id) VALUES ($1,$2,$3,$4,$5,$6)`, [productId, type, -qty, reason, reference, req.session.user.id]);
    }

    await audit(client, req.session.user.id, 'stock_adjustment', 'product', productId, `${type} ${qty}; ${reason}; ${reference}`);
    await client.query('COMMIT');
    res.redirect('/inventory?success=' + encodeURIComponent(`Stock adjustment saved: ${type} ${qty} unit(s).`));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.redirect('/inventory?error=' + encodeURIComponent(err.message));
  } finally { client.release(); }
});

router.post('/unit/:id/update', requireAuth, manage, requirePermission('inventory_adjust'), async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    const serial = String(req.body.serial_number || '').trim() || null;
    const notes = String(req.body.notes || '').trim() || null;
    const sourceType = validSources.includes(req.body.source_type) ? req.body.source_type : 'own';
    const supplierId = sourceType === 'dealer' ? (Number(req.body.supplier_id) || null) : null;
    const dealerWarrantyEnd = sourceType === 'dealer' ? (req.body.dealer_warranty_end || null) : null;
    if (sourceType === 'dealer' && !supplierId) throw new Error('Dealer stock requires a Dealer / Supplier.');

    await client.query('BEGIN');
    const current = await client.query(`SELECT iu.*,p.name AS product_name,p.tracking_mode FROM inventory_units iu JOIN products p ON p.id=iu.product_id WHERE iu.id=$1 FOR UPDATE`, [id]);
    if (!current.rows.length) throw new Error('Stock unit not found.');
    const unit = current.rows[0];
    await assertSerialRules(client, { name: unit.product_name, tracking_mode: unit.tracking_mode }, 1, serial ? [serial] : [], id);

    await client.query(
      `UPDATE inventory_units SET serial_number=$1, source_type=$2, supplier_id=$3, dealer_warranty_end=$4, notes=$5, updated_at=NOW() WHERE id=$6`,
      [serial, sourceType, supplierId, dealerWarrantyEnd, notes, id]
    );
    await audit(client, req.session.user.id, 'stock_unit_update', 'inventory_unit', id, 'Updated serial/source/dealer warranty/notes');
    await client.query('COMMIT');
    res.redirect('/inventory?success=' + encodeURIComponent('Stock unit updated.'));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.redirect('/inventory?error=' + encodeURIComponent(err.message));
  } finally {
    client.release();
  }
});

router.post('/reclassify', requireAuth, manage, requirePermission('inventory_adjust'), async (req, res) => {
  const client = await pool.connect();
  try {
    const productId = Number(req.body.product_id);
    const qty = Math.max(1, parseInt(req.body.quantity, 10) || 1);
    const sourceType = req.body.source_type === 'dealer' ? 'dealer' : 'own';
    const supplierId = sourceType === 'dealer' ? (Number(req.body.supplier_id) || null) : null;
    const warrantyMonths = Math.max(0, parseInt(req.body.dealer_warranty_months, 10) || 0);
    if (sourceType === 'dealer' && !supplierId) throw new Error('Dealer stock requires a Dealer / Supplier.');
    let warrantyEnd = null;
    if (sourceType === 'dealer' && warrantyMonths > 0) {
      const d = new Date(); d.setMonth(d.getMonth() + warrantyMonths); warrantyEnd = d.toISOString().slice(0,10);
    }
    await client.query('BEGIN');
    const units = await client.query(`SELECT id FROM inventory_units WHERE product_id=$1 AND status='in_stock' AND source_type='legacy' ORDER BY id LIMIT $2 FOR UPDATE`, [productId, qty]);
    if (units.rows.length < qty) throw new Error(`Only ${units.rows.length} legacy unit(s) are available to classify.`);
    for (const unit of units.rows) {
      await client.query(`UPDATE inventory_units SET source_type=$1,supplier_id=$2,dealer_warranty_end=$3,updated_at=NOW() WHERE id=$4`, [sourceType, supplierId, warrantyEnd, unit.id]);
      await client.query(`INSERT INTO inventory_movements (inventory_unit_id,product_id,movement_type,reference,notes,user_id) VALUES ($1,$2,'reclassify','V1 stock classification',$3,$4)`, [unit.id, productId, `legacy -> ${sourceType}`, req.session.user.id]);
    }
    await audit(client, req.session.user.id, 'stock_reclassify', 'product', productId, `${qty} unit(s) legacy -> ${sourceType}`);
    await client.query('COMMIT');
    res.redirect('/inventory?success=' + encodeURIComponent(`Classified ${qty} unit(s) as ${sourceType} stock.`));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.redirect('/inventory?error=' + encodeURIComponent(err.message));
  } finally { client.release(); }
});



// V6 physical stock count. Draft first, then manager confirms differences.
router.post('/count/create', requireAuth, manage, requirePermission('stock_count'), async (req, res) => {
  const client = await pool.connect();
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    const notes = String(req.body.notes || '').trim() || null;
    if (!items.length) throw new Error('Enter at least one physical count.');
    await client.query('BEGIN');
    const code = makeCode('CNT');
    const cr = await client.query(`INSERT INTO stock_counts(count_code,status,notes,created_by) VALUES($1,'draft',$2,$3) RETURNING id`, [code, notes, req.session.user.id]);
    let saved = 0;
    for (const raw of items) {
      const productId = Number(raw.product_id);
      if (!productId || raw.actual_qty === '' || raw.actual_qty === null || raw.actual_qty === undefined) continue;
      const actual = Math.max(0, parseInt(raw.actual_qty, 10) || 0);
      const pr = await client.query('SELECT id,stock_qty FROM products WHERE id=$1 AND is_active=true FOR UPDATE', [productId]);
      if (!pr.rows.length) continue;
      const systemQty = Number(pr.rows[0].stock_qty) || 0;
      await client.query(`INSERT INTO stock_count_items(stock_count_id,product_id,system_qty,actual_qty,difference) VALUES($1,$2,$3,$4,$5)`, [cr.rows[0].id, productId, systemQty, actual, actual-systemQty]);
      saved++;
    }
    if (!saved) throw new Error('Enter at least one physical count value.');
    await audit(client, req.session.user.id, 'stock_count_draft', 'stock_count', cr.rows[0].id, `${code}; ${saved} item(s)`);
    await client.query('COMMIT');
    res.json({ success:true, id:cr.rows[0].id, count_code:code });
  } catch (err) { await client.query('ROLLBACK'); res.status(400).json({ success:false,error:err.message }); }
  finally { client.release(); }
});

router.get('/count/:id', requireAuth, pageAccess, async (req, res) => {
  try {
    const count = await pool.query(`SELECT sc.*,u.name AS created_by_name,uc.name AS confirmed_by_name FROM stock_counts sc LEFT JOIN users u ON u.id=sc.created_by LEFT JOIN users uc ON uc.id=sc.confirmed_by WHERE sc.id=$1`, [req.params.id]);
    if (!count.rows.length) return res.status(404).json({ success:false,error:'Stock count not found.' });
    const items = await pool.query(`SELECT sci.*,p.name AS product_name,p.product_code,p.tracking_mode FROM stock_count_items sci JOIN products p ON p.id=sci.product_id WHERE sci.stock_count_id=$1 ORDER BY p.name`, [req.params.id]);
    res.json({ success:true,count:count.rows[0],items:items.rows });
  } catch (err) { res.status(500).json({ success:false,error:err.message }); }
});

router.post('/count/:id/confirm', requireAuth, manage, requirePermission('stock_count'), async (req, res) => {
  const client = await pool.connect();
  try {
    const countId = Number(req.params.id);
    await client.query('BEGIN');
    const cr = await client.query(`SELECT * FROM stock_counts WHERE id=$1 FOR UPDATE`, [countId]);
    if (!cr.rows.length) throw new Error('Stock count not found.');
    const count = cr.rows[0]; if (count.status !== 'draft') throw new Error('This stock count is already completed.');
    const items = await client.query(`SELECT sci.*,p.name AS product_name,p.tracking_mode,p.buy_price FROM stock_count_items sci JOIN products p ON p.id=sci.product_id WHERE sci.stock_count_id=$1 ORDER BY sci.id FOR UPDATE OF sci`, [countId]);
    // Safety: serial-required differences need exact unit identity and must be handled in Adjustment.
    const blocked = items.rows.filter(x => Number(x.difference) !== 0 && (x.tracking_mode || 'optional') === 'required');
    if (blocked.length) throw new Error(`Cannot auto-apply count difference for Serial Required product: ${blocked[0].product_name}. Use Stock Adjustment and select exact Serial / Unit.`);
    for (const item of items.rows) {
      const diff = Number(item.difference) || 0; if (!diff) continue;
      const pr = await client.query('SELECT id,stock_qty FROM products WHERE id=$1 FOR UPDATE', [item.product_id]);
      const liveQty = Number(pr.rows[0].stock_qty) || 0;
      if (liveQty !== Number(item.system_qty)) throw new Error(`${item.product_name}: stock changed after this count was created (${item.system_qty} -> ${liveQty}). Create a new count.`);
      if (diff > 0) {
        for (let i=0;i<diff;i++) await createInventoryUnit(client,{productId:item.product_id,sourceType:'own',costPrice:Number(item.buy_price)||0,userId:req.session.user.id,reference:count.count_code,notes:'Physical stock count increase',movementType:'stock_count_add'});
        await client.query('UPDATE products SET stock_qty=stock_qty+$1,updated_at=NOW() WHERE id=$2',[diff,item.product_id]);
        await client.query(`INSERT INTO stock_adjustments(product_id,adjustment_type,quantity,reason,reference,user_id) VALUES($1,'add',$2,'Physical stock count',$3,$4)`,[item.product_id,diff,count.count_code,req.session.user.id]);
      } else {
        const removeQty=Math.abs(diff); if(liveQty<removeQty)throw new Error(`${item.product_name}: not enough live stock to apply count.`);
        const units=await client.query(`SELECT * FROM inventory_units WHERE product_id=$1 AND status='in_stock' ORDER BY received_at NULLS FIRST,id LIMIT $2 FOR UPDATE`,[item.product_id,removeQty]); if(units.rows.length<removeQty)throw new Error(`${item.product_name}: unit tracking is incomplete.`);
        for(const unit of units.rows){await client.query(`UPDATE inventory_units SET status='adjusted_out',updated_at=NOW() WHERE id=$1`,[unit.id]);await client.query(`INSERT INTO inventory_movements(inventory_unit_id,product_id,movement_type,quantity,reference,notes,user_id) VALUES($1,$2,'stock_count_remove',-1,$3,'Physical stock count decrease',$4)`,[unit.id,item.product_id,count.count_code,req.session.user.id]);}
        await client.query('UPDATE products SET stock_qty=stock_qty-$1,updated_at=NOW() WHERE id=$2',[removeQty,item.product_id]);
        await client.query(`INSERT INTO stock_adjustments(product_id,adjustment_type,quantity,reason,reference,user_id) VALUES($1,'remove',$2,'Physical stock count',$3,$4)`,[item.product_id,-removeQty,count.count_code,req.session.user.id]);
      }
    }
    await client.query(`UPDATE stock_counts SET status='confirmed',confirmed_by=$1,confirmed_at=NOW() WHERE id=$2`,[req.session.user.id,countId]);
    await audit(client,req.session.user.id,'stock_count_confirm','stock_count',countId,count.count_code); await client.query('COMMIT'); res.json({success:true,count_code:count.count_code});
  } catch(err){await client.query('ROLLBACK');res.status(400).json({success:false,error:err.message});}finally{client.release();}
});

router.post('/count/:id/cancel', requireAuth, manage, requirePermission('stock_count'), async(req,res)=>{
  try{const r=await pool.query(`UPDATE stock_counts SET status='cancelled' WHERE id=$1 AND status='draft' RETURNING count_code`,[req.params.id]);if(!r.rows.length)return res.status(400).json({success:false,error:'Count is not a draft.'});res.json({success:true});}catch(err){res.status(500).json({success:false,error:err.message});}
});

module.exports = router;

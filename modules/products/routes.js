const express = require('express');
const router = express.Router();
const { pool } = require('../../config/db');
const { requireAuth, requireRole, requirePermission } = require('../../middleware/auth');
const { upload } = require('../../middleware/upload');
const { createInventoryUnit, audit, makeCode } = require('../../utils/inventory');

const manage = requireRole('admin', 'manager');
function cleanCode(v) { return String(v || '').trim().toUpperCase(); }
function normalizeTrackingMode(v) { return ['quantity','optional','required'].includes(v) ? v : 'optional'; }
function parseSerialJson(value) {
  try {
    const raw = JSON.parse(String(value || '[]'));
    if (!Array.isArray(raw)) return [];
    return raw.map(v => String(v || '').trim()).filter(Boolean);
  } catch (_) { return []; }
}
async function uniqueProductCode(client) {
  for (let i = 0; i < 10; i++) {
    const code = makeCode('PRD');
    const found = await client.query('SELECT id FROM products WHERE UPPER(product_code)=UPPER($1) LIMIT 1', [code]);
    if (!found.rows.length) return code;
  }
  throw new Error('Could not generate a unique Product Code.');
}

router.get('/', requireAuth, manage, async (req, res) => {
  try {
    const [productsResult, categoriesResult] = await Promise.all([
      pool.query(`SELECT p.*, c.name AS category_name,
        COUNT(iu.id) FILTER (WHERE iu.serial_number IS NOT NULL AND BTRIM(iu.serial_number)<>'')::int AS serial_count,
        COUNT(iu.id)::int AS unit_count
        FROM products p JOIN categories c ON p.category_id=c.id
        LEFT JOIN inventory_units iu ON iu.product_id=p.id
        WHERE p.is_active=true AND p.purged_at IS NULL GROUP BY p.id,c.name ORDER BY p.id DESC`),
      pool.query('SELECT * FROM categories WHERE is_active=true ORDER BY name')
    ]);
    res.render('products/index', {
      activePage: 'products', pageTitle: res.locals.t('products'), user: req.session.user,
      products: productsResult.rows, categories: categoriesResult.rows,
      errorMessage: req.query.error || '', success: req.query.success || ''
    });
  } catch (err) { console.error(err); res.status(500).send('Error loading products'); }
});

// Shared searchable product lookup used by Inventory, Purchases and After-Sales.
// Matches product name/code/barcode plus any tracked Unit Code or factory Serial Number.
router.get('/api/search', requireAuth, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const showAll = String(req.query.show_all || '') === '1';
    const like = `%${q}%`;
    const params = q ? [like] : [];
    const where = q ? `AND (
      p.name ILIKE $1 OR COALESCE(p.product_code,'') ILIKE $1 OR COALESCE(p.barcode,'') ILIKE $1
      OR COALESCE(p.brand,'') ILIKE $1 OR COALESCE(p.model,'') ILIKE $1
      OR EXISTS (SELECT 1 FROM inventory_units ix WHERE ix.product_id=p.id
        AND (COALESCE(ix.internal_code,'') ILIKE $1 OR COALESCE(ix.serial_number,'') ILIKE $1))
    )` : '';
    const result = await pool.query(`
      SELECT p.id,p.name,p.product_code,p.barcode,p.brand,p.model,p.stock_qty,p.min_stock,
             p.buy_price,p.sell_price,COALESCE(p.tracking_mode,'optional') AS tracking_mode,
             mu.internal_code AS matched_unit_code,mu.serial_number AS matched_serial,mu.status AS matched_unit_status
      FROM products p
      LEFT JOIN LATERAL (
        SELECT iu.internal_code,iu.serial_number,iu.status
        FROM inventory_units iu
        WHERE iu.product_id=p.id
          ${q ? `AND (COALESCE(iu.internal_code,'') ILIKE $1 OR COALESCE(iu.serial_number,'') ILIKE $1)` : ''}
        ORDER BY (iu.status='in_stock') DESC,iu.updated_at DESC,iu.id DESC LIMIT 1
      ) mu ON true
      WHERE p.is_active=true AND p.purged_at IS NULL ${where}
      ORDER BY CASE WHEN ${q ? `LOWER(COALESCE(p.product_code,''))=LOWER($1)` : 'false'} THEN 0 ELSE 1 END,p.name
      LIMIT ${showAll ? 300 : 80}`, params);
    res.json({ success:true, products:result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success:false, message:'Product search failed.' });
  }
});

router.get('/generate-code', requireAuth, manage, async (req, res) => {
  try { res.json({ success: true, code: await uniqueProductCode(pool) }); }
  catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get('/:id/serials', requireAuth, manage, async (req, res) => {
  try {
    const p = await pool.query('SELECT id,name,product_code,model FROM products WHERE id=$1 AND is_active=true', [req.params.id]);
    if (!p.rows.length) return res.status(404).json({ success: false, message: 'Product not found.' });
    const units = await pool.query(`SELECT iu.id,iu.internal_code,iu.serial_number,iu.status,iu.received_at,iu.sold_at,s.name AS supplier_name
      FROM inventory_units iu LEFT JOIN suppliers s ON s.id=iu.supplier_id
      WHERE iu.product_id=$1 ORDER BY iu.created_at DESC,iu.id DESC LIMIT 300`, [req.params.id]);
    res.json({ success: true, product: p.rows[0], units: units.rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get('/edit/:id', requireAuth, manage, requirePermission('product_edit'), async (req, res) => {
  try {
    const [product, categories, units] = await Promise.all([
      pool.query('SELECT * FROM products WHERE id=$1 AND is_active=true', [req.params.id]),
      pool.query('SELECT * FROM categories WHERE is_active=true ORDER BY name'),
      pool.query(`SELECT id,internal_code,serial_number,status FROM inventory_units WHERE product_id=$1 AND status='in_stock' ORDER BY received_at NULLS FIRST,id`, [req.params.id])
    ]);
    if (!product.rows.length) return res.status(404).send('Product not found');
    res.render('products/edit', { activePage: 'products', pageTitle: 'Edit Product', user: req.session.user, products: product.rows, categories: categories.rows, units: units.rows });
  } catch (err) { console.error(err); res.status(500).send('Error loading edit page'); }
});

router.post('/create', requireAuth, manage, requirePermission('product_edit'), upload.single('image'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { name, category_id, brand, model, buy_price, sell_price, stock_qty, min_stock, warranty_months } = req.body;
    const trackingMode = normalizeTrackingMode(req.body.tracking_mode);
    const barcode = String(req.body.barcode || '').trim() || null;
    const image = req.file ? req.file.filename : null;
    const openingQty = Math.max(0, parseInt(stock_qty, 10) || 0);
    const serials = parseSerialJson(req.body.serial_numbers_json);
    if (serials.length > openingQty) throw new Error('Serial rows cannot be greater than Opening Stock.');
    if (trackingMode === 'quantity' && serials.length) throw new Error('This product is Quantity only. Do not enter Serial Numbers.');
    if (trackingMode === 'required' && serials.length !== openingQty) throw new Error('Serial Required products need one Serial Number for every Opening Stock unit.');
    const uniqueInputSerials = new Set(serials.map(s => s.toUpperCase()));
    if (uniqueInputSerials.size !== serials.length) throw new Error('Duplicate Serial Number found in the form.');

    await client.query('BEGIN');
    let productCode = cleanCode(req.body.product_code);
    if (!productCode) productCode = await uniqueProductCode(client);
    const duplicate = await client.query('SELECT id FROM products WHERE UPPER(product_code)=UPPER($1) LIMIT 1', [productCode]);
    if (duplicate.rows.length) throw new Error('Product Code already exists. Generate or enter another code.');
    if (barcode) {
      const dupBarcode = await client.query('SELECT id FROM products WHERE barcode=$1 LIMIT 1', [barcode]);
      if (dupBarcode.rows.length) throw new Error('Barcode already exists. Scan or enter another barcode.');
    }
    if (serials.length) {
      const existingSerial = await client.query('SELECT serial_number FROM inventory_units WHERE UPPER(serial_number)=ANY($1::text[]) LIMIT 1', [serials.map(s => s.toUpperCase())]);
      if (existingSerial.rows.length) throw new Error(`Serial Number already exists: ${existingSerial.rows[0].serial_number}`);
    }
    const result = await client.query(`INSERT INTO products
      (name,category_id,brand,model,product_code,tracking_mode,barcode,buy_price,sell_price,stock_qty,min_stock,warranty_months,image)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [name, category_id, brand || null, model || null, productCode, trackingMode, barcode, Number(buy_price) || 0, Number(sell_price) || 0,
        openingQty, Math.max(0, parseInt(min_stock, 10) || 0), Math.max(0, parseInt(warranty_months, 10) || 0), image]);
    for (let i = 0; i < openingQty; i++) {
      await createInventoryUnit(client, {
        productId: result.rows[0].id, serialNumber: serials[i] || null, sourceType: 'own',
        costPrice: Number(buy_price) || 0, userId: req.session.user.id,
        notes: 'Opening stock from product creation', movementType: 'opening_stock'
      });
    }
    await audit(client, req.session.user.id, 'product_create', 'product', result.rows[0].id,
      `${productCode}; tracking=${trackingMode}; model=${model || '-'}; opening stock ${openingQty}; serials ${serials.length}`);
    await client.query('COMMIT');
    res.redirect('/products?success=' + encodeURIComponent('Product added. Model is stored once; serials are tracked per unit.'));
  } catch (err) {
    await client.query('ROLLBACK'); console.error(err);
    res.redirect('/products?error=' + encodeURIComponent(err.message));
  } finally { client.release(); }
});

router.post('/update/:id', requireAuth, manage, requirePermission('product_edit'), upload.single('image'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { name, category_id, brand, model, buy_price, sell_price, min_stock, warranty_months } = req.body;
    const trackingMode = normalizeTrackingMode(req.body.tracking_mode);
    const barcode = String(req.body.barcode || '').trim() || null;
    let serialUpdates = [];
    try { const raw = JSON.parse(String(req.body.serial_updates_json || '[]')); if (Array.isArray(raw)) serialUpdates = raw; } catch (_) {}
    let productCode = cleanCode(req.body.product_code);
    await client.query('BEGIN');
    const existing = await client.query('SELECT * FROM products WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!existing.rows.length) throw new Error('Product not found.');
    if (!productCode) productCode = await uniqueProductCode(client);
    const dup = await client.query('SELECT id FROM products WHERE UPPER(product_code)=UPPER($1) AND id<>$2 LIMIT 1', [productCode, req.params.id]);
    if (dup.rows.length) throw new Error('Product Code already exists.');
    if (barcode) {
      const dupBarcode = await client.query('SELECT id FROM products WHERE barcode=$1 AND id<>$2 LIMIT 1', [barcode, req.params.id]);
      if (dupBarcode.rows.length) throw new Error('Barcode already exists.');
    }
    const old = existing.rows[0];
    const image = req.file ? req.file.filename : old.image;
    // Apply only explicitly changed, non-empty serial fields. Empty edit fields are intentionally skipped.
    if (trackingMode === 'quantity' && serialUpdates.length) throw new Error('Quantity-only products do not use Serial Numbers.');
    const normalizedUpdates = [];
    for (const u of serialUpdates) {
      const id = Number(u && u.id);
      const serial = String(u && u.serial || '').trim();
      if (!id || !serial) continue;
      const owned = await client.query(`SELECT id,serial_number FROM inventory_units WHERE id=$1 AND product_id=$2 AND status='in_stock' FOR UPDATE`, [id, req.params.id]);
      if (!owned.rows.length) throw new Error('One serial row no longer belongs to available stock. Reload the page.');
      normalizedUpdates.push({ id, serial });
    }
    const upper = normalizedUpdates.map(x => x.serial.toUpperCase());
    if (new Set(upper).size !== upper.length) throw new Error('Duplicate Serial Number in the edit form.');
    if (upper.length) {
      const ids = normalizedUpdates.map(x => x.id);
      const conflict = await client.query(`SELECT id,serial_number FROM inventory_units WHERE UPPER(serial_number)=ANY($1::text[]) AND NOT (id=ANY($2::int[])) LIMIT 1`, [upper, ids]);
      if (conflict.rows.length) throw new Error(`Serial Number already exists: ${conflict.rows[0].serial_number}`);
      // Two-phase update allows swapping serials between in-stock units without unique-index collisions.
      await client.query(`UPDATE inventory_units SET serial_number=NULL,updated_at=NOW() WHERE id=ANY($1::int[])`, [ids]);
      for (const u of normalizedUpdates) await client.query('UPDATE inventory_units SET serial_number=$1,updated_at=NOW() WHERE id=$2', [u.serial, u.id]);
    }
    if (trackingMode === 'required') {
      const missing = await client.query(`SELECT COUNT(*)::int AS count FROM inventory_units WHERE product_id=$1 AND status='in_stock' AND (serial_number IS NULL OR BTRIM(serial_number)='')`, [req.params.id]);
      if (missing.rows[0].count > 0) throw new Error(`Serial Required needs a Serial Number for every in-stock unit. ${missing.rows[0].count} unit(s) are still blank.`);
    }
    // Stock quantity is intentionally not edited here.
    await client.query(`UPDATE products SET name=$1,category_id=$2,brand=$3,model=$4,product_code=$5,tracking_mode=$6,barcode=$7,
      buy_price=$8,sell_price=$9,min_stock=$10,warranty_months=$11,image=$12,updated_at=NOW() WHERE id=$13`,
      [name, category_id, brand || null, model || null, productCode, trackingMode, barcode, Number(buy_price) || 0, Number(sell_price) || 0,
        Math.max(0, parseInt(min_stock, 10) || 0), Math.max(0, parseInt(warranty_months, 10) || 0), image, req.params.id]);
    await audit(client, req.session.user.id, 'product_update', 'product', old.id, `${productCode}; tracking=${trackingMode}; master data updated; serial edits=${normalizedUpdates.length}; stock unchanged (${old.stock_qty})`);
    await client.query('COMMIT');
    res.redirect('/products?success=' + encodeURIComponent('Product updated. Stock/Serial quantity was not changed.'));
  } catch (err) {
    await client.query('ROLLBACK'); console.error(err);
    res.redirect('/products?error=' + encodeURIComponent(err.message));
  } finally { client.release(); }
});

router.post('/delete/:id', requireAuth, manage, requirePermission('product_delete'), async (req, res) => {
  try {
    const p = await pool.query('SELECT id,name,stock_qty FROM products WHERE id=$1 AND is_active=true', [req.params.id]);
    if (!p.rows.length) return res.status(404).json({ success:false, message:'Product not found.' });
    await pool.query('UPDATE products SET deleted_at=NOW(),purged_at=NULL,is_active=false WHERE id=$1', [req.params.id]);
    await audit(pool, req.session.user.id, 'product_delete_to_recycle', 'product', Number(req.params.id), `Moved to Recycle Bin; stock preserved=${Number(p.rows[0].stock_qty)||0}`);
    res.json({ success:true, stock_preserved:Number(p.rows[0].stock_qty)||0 });
  } catch (err) { console.error(err); res.status(500).json({ success: false, message: err.message }); }
});
router.post('/restore/:id', requireAuth, manage, requirePermission('product_delete'), async (req, res) => {
  try {
    const r = await pool.query('UPDATE products SET deleted_at=NULL,purged_at=NULL,is_active=true WHERE id=$1 AND purged_at IS NULL RETURNING id', [req.params.id]);
    if (!r.rows.length) return res.status(410).json({ success:false, message:'Restore period has expired for this product.' });
    await audit(pool, req.session.user.id, 'product_restore', 'product', Number(req.params.id), 'Restored from Recycle Bin');
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ success:false, message:err.message }); }
});

router.post('/category/create', requireAuth, manage, requirePermission('product_edit'), async (req, res) => {
  try { await pool.query('INSERT INTO categories(name,description) VALUES($1,$2)', [String(req.body.name || '').trim(), req.body.description || null]); res.redirect('/products?success=' + encodeURIComponent('Category added.')); }
  catch (err) { res.redirect('/products?error=' + encodeURIComponent(err.message)); }
});
router.post('/category/update/:id', requireAuth, manage, requirePermission('product_edit'), async (req, res) => {
  try { await pool.query('UPDATE categories SET name=$1,description=$2 WHERE id=$3', [String(req.body.name || '').trim(), req.body.description || null, req.params.id]); res.redirect('/products?success=' + encodeURIComponent('Category updated.')); }
  catch (err) { res.redirect('/products?error=' + encodeURIComponent(err.message)); }
});
router.post('/category/delete/:id', requireAuth, manage, requirePermission('product_edit'), async (req, res) => {
  try {
    const count = await pool.query('SELECT COUNT(*)::int AS count FROM products WHERE category_id=$1 AND is_active=true', [req.params.id]);
    if (count.rows[0].count > 0) return res.status(400).json({ success: false, message: `Category has ${count.rows[0].count} active product(s). Move them first.` });
    await pool.query('UPDATE categories SET deleted_at=NOW(),is_active=false WHERE id=$1', [req.params.id]); res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});
router.post('/category/restore/:id', requireAuth, manage, requirePermission('product_edit'), async (req, res) => { await pool.query('UPDATE categories SET deleted_at=NULL,is_active=true WHERE id=$1', [req.params.id]); res.json({ success: true }); });
router.get('/low-stock', requireAuth, manage, async (req, res) => { const r = await pool.query('SELECT * FROM products WHERE is_active=true AND stock_qty<=min_stock ORDER BY stock_qty'); res.json(r.rows); });

module.exports = router;

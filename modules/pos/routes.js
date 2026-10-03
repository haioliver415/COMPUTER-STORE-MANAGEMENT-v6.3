const express = require('express');
const router = express.Router();
const { pool } = require('../../config/db');
const { requireAuth, requireRole, generateSaleCode } = require('../../middleware/auth');
const { ensureProductCoverage, audit } = require('../../utils/inventory');

const posRoles = requireRole('admin', 'manager', 'cashier');
const productStockSql = `SELECT p.*, c.name AS category_name
  FROM products p JOIN categories c ON p.category_id=c.id
  WHERE p.is_active=true`;

router.get('/', requireAuth, posRoles, async (req, res) => {
  try {
    const [productsResult, settingsResult, customersResult, categoriesResult] = await Promise.all([
      pool.query(`${productStockSql} ORDER BY p.name LIMIT 300`),
      pool.query('SELECT * FROM settings ORDER BY id LIMIT 1'),
      pool.query('SELECT id, name, phone, email, due_balance FROM customers WHERE is_active=true ORDER BY name LIMIT 500'),
      pool.query('SELECT * FROM categories WHERE is_active=true ORDER BY name')
    ]);
    res.render('pos/index', {
      activePage: 'pos', pageTitle: res.locals.t('pos'), user: req.session.user,
      products: productsResult.rows, customers: customersResult.rows,
      settings: settingsResult.rows[0], categories: categoriesResult.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error loading POS');
  }
});


router.get('/customers/search', requireAuth, posRoles, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const params = [];
    let where = 'WHERE is_active=true';
    if (q) {
      params.push('%' + q + '%');
      where += ` AND (name ILIKE $1 OR COALESCE(phone,'') ILIKE $1 OR COALESCE(email,'') ILIKE $1)`;
    }
    const rows = (await pool.query(`SELECT id,name,phone,email,due_balance FROM customers ${where} ORDER BY name LIMIT 500`, params)).rows;
    res.json({ success:true, customers:rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success:false, error:err.message });
  }
});

router.get('/categories', requireAuth, posRoles, async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM categories WHERE is_active=true ORDER BY name')).rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/search', requireAuth, posRoles, async (req, res) => {
  try {
    const q = String(req.query.q || '');
    const catId = Number(req.query.category_id) || null;
    let sql = `${productStockSql} AND (p.name ILIKE $1 OR COALESCE(p.barcode,'') ILIKE $1 OR COALESCE(p.product_code,'') ILIKE $1 OR COALESCE(p.model,'') ILIKE $1 OR EXISTS (SELECT 1 FROM inventory_units iu WHERE iu.product_id=p.id AND iu.status='in_stock' AND (COALESCE(iu.serial_number,'') ILIKE $1 OR iu.internal_code ILIKE $1)))`;
    const params = [`%${q}%`];
    if (catId) { params.push(catId); sql += ` AND p.category_id=$${params.length}`; }
    sql += ' ORDER BY p.name LIMIT 100';
    res.json((await pool.query(sql, params)).rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/units/:productId', requireAuth, posRoles, async (req, res) => {
  try {
    const productId = Number(req.params.productId);
    const product = await pool.query(`SELECT id,name,product_code,COALESCE(tracking_mode,'optional') AS tracking_mode,stock_qty FROM products WHERE id=$1 AND is_active=true`, [productId]);
    if (!product.rows.length) return res.status(404).json({ success: false, error: 'Product not found.' });
    const units = await pool.query(`SELECT id,internal_code,serial_number,source_type,received_at FROM inventory_units
      WHERE product_id=$1 AND status='in_stock' ORDER BY received_at NULLS FIRST,id LIMIT 500`, [productId]);
    res.json({ success: true, product: product.rows[0], units: units.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/sale', requireAuth, posRoles, async (req, res) => {
  const client = await pool.connect();
  try {
    const incomingItems = Array.isArray(req.body.items) ? req.body.items : [];
    if (!incomingItems.length) throw new Error('Cart is empty.');
    const customerId = Number(req.body.customer_id) || null;
    const discountType = req.body.discount_type === 'percent' ? 'percent' : 'fixed';
    const discountInput = Math.max(0, Number(req.body.discount) || 0);
    const taxRate = Math.max(0, Number(req.body.tax) || 0);
    const paidAmount = Math.max(0, Number(req.body.paid_amount) || 0);
    const paymentMethod = String(req.body.payment_method || 'cash');
    const notes = req.body.notes || null;

    await client.query('BEGIN');
    const validated = [];
    let subtotal = 0;
    for (const item of incomingItems) {
      const productId = Number(item.product_id);
      const quantity = parseInt(item.quantity, 10);
      if (!productId || !Number.isInteger(quantity) || quantity <= 0) throw new Error('Invalid sale item.');
      const result = await client.query('SELECT * FROM products WHERE id=$1 AND is_active=true FOR UPDATE', [productId]);
      if (!result.rows.length) throw new Error('A product in the cart no longer exists.');
      const product = result.rows[0];
      if (Number(product.stock_qty) < quantity) throw new Error(`${product.name}: only ${product.stock_qty} unit(s) available.`);
      await ensureProductCoverage(client, productId, Number(product.stock_qty), req.session.user.id);
      const unitIds = Array.isArray(item.unit_ids) ? item.unit_ids.map(Number).filter(Number.isInteger) : [];
      if (new Set(unitIds).size !== unitIds.length) throw new Error(`${product.name}: duplicate Unit selection.`);
      if (unitIds.length && unitIds.length !== quantity) throw new Error(`${product.name}: selected Unit count must match quantity.`);
      if ((product.tracking_mode || 'optional') === 'required' && unitIds.length !== quantity) throw new Error(`${product.name}: select the exact Serial / Unit for every unit sold.`);
      const unitPrice = Number(product.sell_price);
      const lineSubtotal = unitPrice * quantity;
      subtotal += lineSubtotal;
      validated.push({ product, productId, quantity, unitPrice, lineSubtotal, unitIds });
    }

    const discountAmount = discountType === 'percent' ? subtotal * discountInput / 100 : Math.min(discountInput, subtotal);
    const taxAmount = Math.max(0, (subtotal - discountAmount) * taxRate / 100);
    const totalAmount = Math.max(0, subtotal - discountAmount + taxAmount);
    if (paymentMethod === 'credit' && !customerId) throw new Error('Credit sale requires a customer account.');
    const actualPaid = paymentMethod === 'credit' ? Math.min(paidAmount, totalAmount) : (paidAmount || totalAmount);
    const changeAmount = Math.max(0, actualPaid - totalAmount);
    const dueAmount = Math.max(0, totalAmount - actualPaid);
    const saleCode = generateSaleCode();
    const saleResult = await client.query(`INSERT INTO sales
      (sale_code,user_id,customer_id,subtotal,discount,discount_type,tax,total,paid_amount,change_amount,payment_method,status,notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'completed',$12) RETURNING id`,
      [saleCode, req.session.user.id, customerId, subtotal, discountAmount, discountType, taxAmount, totalAmount, actualPaid, changeAmount, paymentMethod, notes]);
    const saleId = saleResult.rows[0].id;

    const soldUnits = [];
    for (const item of validated) {
      const saleItemResult = await client.query(`INSERT INTO sale_items (sale_id,product_id,quantity,unit_price,subtotal,line_type)
        VALUES ($1,$2,$3,$4,$5,'sale') RETURNING id`, [saleId, item.productId, item.quantity, item.unitPrice, item.lineSubtotal]);
      const saleItemId = saleItemResult.rows[0].id;
      // POS never asks the cashier to choose a stock source. The system allocates
      // the oldest available tracked unit automatically and keeps the source on that unit.
      let unitsResult;
      if (item.unitIds.length) {
        unitsResult = await client.query(`SELECT * FROM inventory_units
          WHERE product_id=$1 AND status='in_stock' AND id=ANY($2::int[])
          ORDER BY received_at NULLS FIRST,id FOR UPDATE`, [item.productId, item.unitIds]);
        if (unitsResult.rows.length !== item.quantity) throw new Error(`${item.product.name}: one or more selected Serial / Units are no longer available.`);
        if ((item.product.tracking_mode || 'optional') === 'required' && unitsResult.rows.some(u => !u.serial_number || !String(u.serial_number).trim())) throw new Error(`${item.product.name}: a selected unit is missing its required Serial Number.`);
      } else {
        unitsResult = await client.query(`SELECT * FROM inventory_units
          WHERE product_id=$1 AND status='in_stock'
          ORDER BY received_at NULLS FIRST, id
          LIMIT $2 FOR UPDATE`, [item.productId, item.quantity]);
        if (unitsResult.rows.length < item.quantity) throw new Error(`${item.product.name}: stock tracking is incomplete.`);
      }
      for (const unit of unitsResult.rows) {
        let customerWarrantyEnd = null;
        if (Number(item.product.warranty_months) > 0) {
          const d = new Date();
          d.setMonth(d.getMonth() + Number(item.product.warranty_months));
          customerWarrantyEnd = d.toISOString().slice(0, 10);
        }
        await client.query(`UPDATE inventory_units SET status='sold', last_sale_id=$1, last_sale_item_id=$2,
          sold_at=NOW(), customer_warranty_end=$3, updated_at=NOW() WHERE id=$4`,
          [saleId, saleItemId, customerWarrantyEnd, unit.id]);
        await client.query(`INSERT INTO inventory_movements (inventory_unit_id,product_id,movement_type,quantity,sale_id,sale_item_id,reference,user_id)
          VALUES ($1,$2,'sale',-1,$3,$4,$5,$6)`, [unit.id, item.productId, saleId, saleItemId, saleCode, req.session.user.id]);
        soldUnits.push({ product: item.product.name, internal_code: unit.internal_code, serial_number: unit.serial_number });
      }
      await client.query('UPDATE products SET stock_qty=stock_qty-$1, updated_at=NOW() WHERE id=$2', [item.quantity, item.productId]);
    }

    if (customerId && dueAmount > 0) {
      await client.query('UPDATE customers SET due_balance=due_balance+$1 WHERE id=$2', [dueAmount, customerId]);
    }
    await audit(client, req.session.user.id, 'sale_complete', 'sale', saleId,
      `${saleCode}, ${validated.length} line(s), total=${totalAmount.toFixed(2)}, due=${dueAmount.toFixed(2)}`);
    await client.query('COMMIT');
    res.json({ success: true, sale_id: saleId, sale_code: saleCode, total: totalAmount, units: soldUnits });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(400).json({ success: false, error: err.message });
  } finally { client.release(); }
});

router.get('/receipt/:id', requireAuth, posRoles, async (req, res) => {
  try {
    const saleResult = await pool.query(`SELECT s.*, u.name AS cashier_name,
      COALESCE(c.name,'USER') AS customer_name, c.phone AS customer_phone
      FROM sales s LEFT JOIN users u ON s.user_id=u.id LEFT JOIN customers c ON s.customer_id=c.id WHERE s.id=$1`, [req.params.id]);
    const itemsResult = await pool.query(`SELECT si.*, p.name AS product_name, p.product_code, p.model
      FROM sale_items si JOIN products p ON si.product_id=p.id WHERE si.sale_id=$1 ORDER BY si.id`, [req.params.id]);
    const unitsResult = await pool.query(`SELECT iu.last_sale_item_id, iu.serial_number, iu.internal_code
      FROM inventory_units iu WHERE iu.last_sale_id=$1 ORDER BY iu.id`, [req.params.id]);
    if (!saleResult.rows.length) return res.status(404).send('Sale not found');
    const unitsByItem = {};
    unitsResult.rows.forEach(u => {
      const k = String(u.last_sale_item_id || '');
      if (!unitsByItem[k]) unitsByItem[k] = [];
      unitsByItem[k].push(u.serial_number || u.internal_code);
    });
    res.render('pos/receipt', {
      layout: false, sale: saleResult.rows[0], items: itemsResult.rows,
      unitsByItem, settings: res.locals.settings, autoPrint: req.query.print === '1'
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error loading receipt');
  }
});

module.exports = router;

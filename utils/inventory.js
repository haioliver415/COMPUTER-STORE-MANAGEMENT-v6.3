const crypto = require('crypto');

function makeCode(prefix = 'STK') {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function parseSerials(value) {
  if (!value) return [];
  return String(value)
    .split(/[\n,;]+/)
    .map(v => v.trim())
    .filter(Boolean);
}

async function createInventoryUnit(client, options) {
  const {
    productId, serialNumber = null, sourceType = 'own', supplierId = null,
    costPrice = 0, dealerWarrantyEnd = null, notes = null, userId = null,
    status = 'in_stock', reference = null, movementType = 'receive'
  } = options;

  const internalCode = makeCode('STK');
  const result = await client.query(
    `INSERT INTO inventory_units
      (internal_code, product_id, serial_number, source_type, supplier_id, cost_price, dealer_warranty_end, status, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [internalCode, productId, serialNumber || null, sourceType, supplierId || null, Number(costPrice) || 0, dealerWarrantyEnd || null, status, notes || null, userId || null]
  );
  const unit = result.rows[0];
  await client.query(
    `INSERT INTO inventory_movements (inventory_unit_id, product_id, movement_type, quantity, reference, notes, user_id)
     VALUES ($1,$2,$3,1,$4,$5,$6)`,
    [unit.id, productId, movementType, reference, notes || null, userId || null]
  );
  return unit;
}

async function ensureProductCoverage(client, productId, desiredQty, userId = null) {
  const countResult = await client.query(
    `SELECT COUNT(*)::int AS count FROM inventory_units WHERE product_id=$1 AND status='in_stock'`,
    [productId]
  );
  const tracked = countResult.rows[0].count;
  const missing = Math.max(0, Number(desiredQty) - tracked);
  for (let i = 0; i < missing; i++) {
    await createInventoryUnit(client, {
      productId,
      sourceType: 'legacy',
      notes: 'Auto-created from legacy stock quantity',
      userId,
      movementType: 'legacy_opening'
    });
  }
  return missing;
}

async function audit(client, userId, action, entityType, entityId, details) {
  await client.query(
    `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details) VALUES ($1,$2,$3,$4,$5)`,
    [userId || null, action, entityType || null, entityId || null, details || null]
  );
}

module.exports = { makeCode, parseSerials, createInventoryUnit, ensureProductCoverage, audit };

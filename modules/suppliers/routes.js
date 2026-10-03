const express = require('express');
const router = express.Router();
const { pool } = require('../../config/db');
const { requireAuth, requireRole, requirePermission, generatePurchaseCode } = require('../../middleware/auth');
const { parseSerials, createInventoryUnit, audit, makeCode } = require('../../utils/inventory');

const manage = requireRole('admin', 'manager');

router.get('/', requireAuth, manage, async (req, res) => {
  try {
    const suppliersResult = await pool.query(`SELECT s.*,
      COALESCE(SUM(p.due_amount) FILTER (WHERE COALESCE(p.order_status,'received')<>'cancelled'),0) AS due_balance,
      COUNT(p.id)::int AS purchase_count
      FROM suppliers s LEFT JOIN purchases p ON p.supplier_id=s.id
      WHERE s.is_active=true GROUP BY s.id ORDER BY s.name`);
    res.render('suppliers/index', { activePage: 'suppliers', pageTitle: 'Suppliers', user: req.session.user, suppliers: suppliersResult.rows });
  } catch (err) { console.error(err); res.status(500).send('Error loading suppliers'); }
});

router.get('/api/search', requireAuth, manage, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const params = [];
    let where = 'WHERE is_active=true';
    if (q) {
      params.push('%' + q + '%');
      where += ` AND (name ILIKE $1 OR COALESCE(phone,'') ILIKE $1 OR COALESCE(email,'') ILIKE $1)`;
    }
    const rows = (await pool.query(`SELECT id,name,phone,email,address FROM suppliers ${where} ORDER BY name LIMIT 500`, params)).rows;
    res.json({ success:true, suppliers:rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success:false, error:err.message });
  }
});

router.post('/create', requireAuth, manage, requirePermission('purchase_manage'), async (req, res) => { const { name, phone, email, address } = req.body; await pool.query('INSERT INTO suppliers (name,phone,email,address) VALUES ($1,$2,$3,$4)', [name,phone,email,address]); res.redirect('/suppliers'); });
router.post('/update/:id', requireAuth, manage, requirePermission('purchase_manage'), async (req, res) => { const { name, phone, email, address } = req.body; await pool.query('UPDATE suppliers SET name=$1,phone=$2,email=$3,address=$4 WHERE id=$5', [name,phone,email,address,req.params.id]); res.redirect('/suppliers'); });
router.post('/delete/:id', requireAuth, manage, requirePermission('purchase_manage'), async (req, res) => { await pool.query('UPDATE suppliers SET is_active=false WHERE id=$1', [req.params.id]); res.redirect('/suppliers'); });

router.get('/purchases', requireAuth, manage, async (req, res) => {
  try {
    const [purchasesResult, suppliersResult, productsResult, paymentsResult] = await Promise.all([
      pool.query(`SELECT p.*,s.name AS supplier_name,u.name AS user_name,
        COALESCE(SUM(pi.quantity),0)::int AS ordered_units,COALESCE(SUM(pi.received_qty),0)::int AS received_units
        FROM purchases p LEFT JOIN suppliers s ON p.supplier_id=s.id LEFT JOIN users u ON p.user_id=u.id
        LEFT JOIN purchase_items pi ON pi.purchase_id=p.id GROUP BY p.id,s.name,u.name ORDER BY p.created_at DESC LIMIT 200`),
      pool.query('SELECT id,name,phone,email FROM suppliers WHERE is_active=true ORDER BY name'),
      pool.query("SELECT id,name,product_code,barcode,buy_price,stock_qty,COALESCE(tracking_mode,'optional') AS tracking_mode FROM products WHERE is_active=true ORDER BY name"),
      pool.query(`SELECT sp.*,s.name AS supplier_name,p.purchase_code,u.name AS user_name FROM supplier_payments sp
        JOIN suppliers s ON s.id=sp.supplier_id LEFT JOIN purchases p ON p.id=sp.purchase_id LEFT JOIN users u ON u.id=sp.user_id
        ORDER BY sp.created_at DESC LIMIT 80`)
    ]);
    res.render('purchases/index', { activePage:'purchases',pageTitle:'Purchases',user:req.session.user,purchases:purchasesResult.rows,suppliers:suppliersResult.rows,products:productsResult.rows,payments:paymentsResult.rows,success:req.query.success||'',errorMessage:req.query.error||'' });
  } catch (err) { console.error(err); res.status(500).send('Error loading purchases'); }
});

// V6: creating a purchase creates an order only. Stock changes only when Receive is confirmed.
router.post('/purchase', requireAuth, manage, requirePermission('purchase_manage'), async (req, res) => {
  const client = await pool.connect();
  try {
    const supplierId = Number(req.body.supplier_id); const items = Array.isArray(req.body.items) ? req.body.items : [];
    const taxAmt = Math.max(0,Number(req.body.tax)||0); const paidAmount = Math.max(0,Number(req.body.paid_amount)||0);
    const notes = String(req.body.notes||'').trim()||null;
    if(!supplierId) throw new Error('Select a dealer/supplier.'); if(!items.length) throw new Error('Add at least one purchase item.');
    await client.query('BEGIN');
    const supplier = await client.query('SELECT id,name FROM suppliers WHERE id=$1 AND is_active=true',[supplierId]); if(!supplier.rows.length) throw new Error('Dealer/supplier not found.');
    let subtotal=0; const normalized=[];
    for(const raw of items){
      const productId=Number(raw.product_id),qty=Math.max(1,parseInt(raw.quantity,10)||1),buyPrice=Math.max(0,Number(raw.buy_price)||0),warrantyMonths=Math.max(0,parseInt(raw.dealer_warranty_months,10)||0);
      const product=await client.query(`SELECT id,name FROM products WHERE id=$1 AND is_active=true`,[productId]); if(!product.rows.length) throw new Error('A selected product no longer exists.');
      subtotal+=qty*buyPrice; normalized.push({productId,qty,buyPrice,warrantyMonths});
    }
    const totalAmt=subtotal+taxAmt,actualPaid=Math.min(paidAmount,totalAmt),dueAmt=Math.max(0,totalAmt-actualPaid),paymentStatus=dueAmt<=0?'paid':actualPaid>0?'partial':'due';
    const purchaseCode=generatePurchaseCode();
    const pr=await client.query(`INSERT INTO purchases(purchase_code,supplier_id,user_id,subtotal,tax,total,paid_amount,due_amount,payment_status,notes,order_status,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ordered',NOW()) RETURNING id`,[purchaseCode,supplierId,req.session.user.id,subtotal,taxAmt,totalAmt,actualPaid,dueAmt,paymentStatus,notes]);
    const purchaseId=pr.rows[0].id;
    for(const item of normalized) await client.query(`INSERT INTO purchase_items(purchase_id,product_id,quantity,buy_price,subtotal,received_qty,dealer_warranty_months) VALUES($1,$2,$3,$4,$5,0,$6)`,[purchaseId,item.productId,item.qty,item.buyPrice,item.qty*item.buyPrice,item.warrantyMonths]);
    if(actualPaid>0) await client.query(`INSERT INTO supplier_payments(payment_code,supplier_id,purchase_id,amount,payment_method,reference,notes,user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[makeCode('SPY'),supplierId,purchaseId,actualPaid,String(req.body.payment_method||'cash'),purchaseCode,'Initial purchase payment',req.session.user.id]);
    await audit(client,req.session.user.id,'purchase_order_create','purchase',purchaseId,`${purchaseCode}; ordered; total=${totalAmt.toFixed(2)}`);
    await client.query('COMMIT'); res.json({success:true,purchase_code:purchaseCode,total:totalAmt});
  } catch(err){await client.query('ROLLBACK');console.error(err);res.status(400).json({success:false,error:err.message});} finally{client.release();}
});

router.get('/purchase/:id', requireAuth, manage, async(req,res)=>{
  try{
    const [p,items,payments,receipts]=await Promise.all([
      pool.query(`SELECT p.*,s.name AS supplier_name FROM purchases p JOIN suppliers s ON s.id=p.supplier_id WHERE p.id=$1`,[req.params.id]),
      pool.query(`SELECT pi.*,p.name AS product_name,p.product_code,COALESCE(p.tracking_mode,'optional') AS tracking_mode FROM purchase_items pi JOIN products p ON p.id=pi.product_id WHERE pi.purchase_id=$1 ORDER BY pi.id`,[req.params.id]),
      pool.query(`SELECT sp.*,u.name AS user_name FROM supplier_payments sp LEFT JOIN users u ON u.id=sp.user_id WHERE sp.purchase_id=$1 ORDER BY sp.created_at DESC`,[req.params.id]),
      pool.query(`SELECT pr.*,u.name AS user_name FROM purchase_receipts pr LEFT JOIN users u ON u.id=pr.user_id WHERE pr.purchase_id=$1 ORDER BY pr.created_at DESC`,[req.params.id])
    ]);
    if(!p.rows.length)return res.status(404).json({success:false,error:'Purchase not found.'});
    res.json({success:true,purchase:p.rows[0],items:items.rows,payments:payments.rows,receipts:receipts.rows});
  }catch(err){res.status(500).json({success:false,error:err.message});}
});

router.post('/purchase/:id/receive', requireAuth, manage, requirePermission('purchase_manage'), async(req,res)=>{
  const client=await pool.connect();
  try{
    const purchaseId=Number(req.params.id),items=Array.isArray(req.body.items)?req.body.items:[],notes=String(req.body.notes||'').trim()||null;
    if(!items.length)throw new Error('Select at least one quantity to receive.');
    await client.query('BEGIN');
    const pr=await client.query(`SELECT p.*,s.name AS supplier_name FROM purchases p JOIN suppliers s ON s.id=p.supplier_id WHERE p.id=$1 FOR UPDATE`,[purchaseId]);
    if(!pr.rows.length)throw new Error('Purchase not found.'); const purchase=pr.rows[0]; if(purchase.order_status==='cancelled')throw new Error('Purchase is cancelled.');
    const receiptCode=makeCode('RCV'); const rr=await client.query(`INSERT INTO purchase_receipts(receipt_code,purchase_id,user_id,notes) VALUES($1,$2,$3,$4) RETURNING id`,[receiptCode,purchaseId,req.session.user.id,notes]);
    let receivedAnything=false; const allSerials=new Set();
    for(const raw of items){
      const itemId=Number(raw.purchase_item_id),qty=Math.max(0,parseInt(raw.quantity,10)||0); if(!qty)continue;
      const ir=await client.query(`SELECT pi.*,p.name AS product_name,p.tracking_mode FROM purchase_items pi JOIN products p ON p.id=pi.product_id WHERE pi.id=$1 AND pi.purchase_id=$2 FOR UPDATE`,[itemId,purchaseId]);
      if(!ir.rows.length)throw new Error('Purchase item not found.'); const item=ir.rows[0],remaining=Number(item.quantity)-Number(item.received_qty||0); if(qty>remaining)throw new Error(`${item.product_name}: only ${remaining} unit(s) remain to receive.`);
      const serials=parseSerials(raw.serial_numbers),upper=serials.map(x=>x.toUpperCase()); if(new Set(upper).size!==upper.length)throw new Error(`${item.product_name}: duplicate serial entered.`);
      for(const s of upper){if(allSerials.has(s))throw new Error(`Serial repeated in this receiving: ${s}`);allSerials.add(s)}
      const mode=item.tracking_mode||'optional'; if(mode==='quantity'&&serials.length)throw new Error(`${item.product_name}: Quantity-only products do not use serials.`); if(mode==='required'&&serials.length!==qty)throw new Error(`${item.product_name}: enter exactly ${qty} serial(s).`); if(serials.length>qty)throw new Error(`${item.product_name}: serial count exceeds receive quantity.`);
      if(upper.length){const ex=await client.query('SELECT serial_number FROM inventory_units WHERE UPPER(serial_number)=ANY($1::text[]) LIMIT 1',[upper]);if(ex.rows.length)throw new Error(`Serial already exists: ${ex.rows[0].serial_number}`)}
      let warrantyEnd=null;if(Number(item.dealer_warranty_months)>0){const d=new Date();d.setMonth(d.getMonth()+Number(item.dealer_warranty_months));warrantyEnd=d.toISOString().slice(0,10)}
      for(let i=0;i<qty;i++) await createInventoryUnit(client,{productId:item.product_id,serialNumber:serials[i]||null,sourceType:'dealer',supplierId:purchase.supplier_id,costPrice:Number(item.buy_price)||0,dealerWarrantyEnd:warrantyEnd,notes:`Purchase ${purchase.purchase_code}; receive ${receiptCode}`,userId:req.session.user.id,reference:purchase.purchase_code,movementType:'dealer_purchase'});
      await client.query('UPDATE products SET stock_qty=stock_qty+$1,buy_price=$2,updated_at=NOW() WHERE id=$3',[qty,item.buy_price,item.product_id]);
      await client.query('UPDATE purchase_items SET received_qty=COALESCE(received_qty,0)+$1 WHERE id=$2',[qty,itemId]);
      await client.query(`INSERT INTO purchase_receipt_items(receipt_id,purchase_item_id,quantity,serial_numbers) VALUES($1,$2,$3,$4)`,[rr.rows[0].id,itemId,qty,serials.join('\n')||null]); receivedAnything=true;
    }
    if(!receivedAnything)throw new Error('Enter a receive quantity greater than zero.');
    const remain=await client.query(`SELECT COALESCE(SUM(quantity-received_qty),0)::int AS remaining FROM purchase_items WHERE purchase_id=$1`,[purchaseId]);
    const status=Number(remain.rows[0].remaining)===0?'received':'partial_received';
    await client.query(`UPDATE purchases SET order_status=$1,received_at=CASE WHEN $1='received' THEN NOW() ELSE received_at END,updated_at=NOW() WHERE id=$2`,[status,purchaseId]);
    await audit(client,req.session.user.id,'purchase_receive','purchase',purchaseId,`${receiptCode}; status=${status}`); await client.query('COMMIT');
    res.json({success:true,receipt_code:receiptCode,status});
  }catch(err){await client.query('ROLLBACK');console.error(err);res.status(400).json({success:false,error:err.message});}finally{client.release();}
});

router.post('/purchase/:id/pay', requireAuth, manage, requirePermission('purchase_manage'), async(req,res)=>{
  const client=await pool.connect();
  try{
    const purchaseId=Number(req.params.id),amount=Math.max(0,Number(req.body.amount)||0),method=String(req.body.payment_method||'cash'),reference=String(req.body.reference||'').trim()||null,notes=String(req.body.notes||'').trim()||null;
    if(amount<=0)throw new Error('Payment amount must be greater than zero.'); await client.query('BEGIN');
    const pr=await client.query('SELECT * FROM purchases WHERE id=$1 FOR UPDATE',[purchaseId]); if(!pr.rows.length)throw new Error('Purchase not found.'); const p=pr.rows[0]; if(amount>Number(p.due_amount)+0.0001)throw new Error(`Payment cannot exceed due amount $${Number(p.due_amount).toFixed(2)}.`);
    const code=makeCode('SPY'); await client.query(`INSERT INTO supplier_payments(payment_code,supplier_id,purchase_id,amount,payment_method,reference,notes,user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[code,p.supplier_id,purchaseId,amount,method,reference,notes,req.session.user.id]);
    const newPaid=Number(p.paid_amount)+amount,newDue=Math.max(0,Number(p.total)-newPaid),status=newDue<=0?'paid':'partial'; await client.query('UPDATE purchases SET paid_amount=$1,due_amount=$2,payment_status=$3,updated_at=NOW() WHERE id=$4',[newPaid,newDue,status,purchaseId]);
    await audit(client,req.session.user.id,'supplier_payment','purchase',purchaseId,`${code}; amount=${amount.toFixed(2)}`); await client.query('COMMIT'); res.json({success:true,payment_code:code,due_amount:newDue});
  }catch(err){await client.query('ROLLBACK');res.status(400).json({success:false,error:err.message});}finally{client.release();}
});

module.exports=router;

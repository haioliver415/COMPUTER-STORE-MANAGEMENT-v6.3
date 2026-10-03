const express=require('express');
const router=express.Router();
const {pool}=require('../../config/db');
const {requireAuth,requireRole}=require('../../middleware/auth');
const {makeCode,audit}=require('../../utils/inventory');

router.get('/',requireAuth,requireRole('admin','manager'),async(req,res)=>{
  try{
    const r=await pool.query(`SELECT c.*,
      COUNT(DISTINCT s.id)::int AS purchase_count,
      COALESCE(SUM(CASE WHEN s.status<>'cancelled' THEN s.total ELSE 0 END),0) AS lifetime_spend,
      MAX(s.created_at) AS last_purchase
      FROM customers c LEFT JOIN sales s ON s.customer_id=c.id
      WHERE c.is_active=true GROUP BY c.id ORDER BY c.name`);
    const payments=await pool.query(`SELECT cp.*,c.name AS customer_name,s.sale_code,u.name AS user_name FROM customer_payments cp JOIN customers c ON c.id=cp.customer_id LEFT JOIN sales s ON s.id=cp.sale_id LEFT JOIN users u ON u.id=cp.user_id ORDER BY cp.created_at DESC LIMIT 80`);
    res.render('customers/index',{activePage:'customers',pageTitle:'Customers',user:req.session.user,customers:r.rows,payments:payments.rows,success:req.query.success||'',errorMessage:req.query.error||''});
  }catch(err){console.error(err);res.status(500).send('Error loading customers');}
});
router.post('/create',requireAuth,requireRole('admin','manager'),async(req,res)=>{const{name,phone,email,address}=req.body;await pool.query('INSERT INTO customers(name,phone,email,address) VALUES($1,$2,$3,$4)',[name,phone||null,email||null,address||null]);res.redirect('/customers');});
router.post('/update/:id',requireAuth,requireRole('admin','manager'),async(req,res)=>{const{name,phone,email,address}=req.body;await pool.query('UPDATE customers SET name=$1,phone=$2,email=$3,address=$4 WHERE id=$5',[name,phone||null,email||null,address||null,req.params.id]);res.redirect('/customers');});
router.post('/pay/:id',requireAuth,requireRole('admin','manager'),async(req,res)=>{
  const client=await pool.connect();
  try{const amount=Math.max(0,Number(req.body.amount)||0),method=String(req.body.payment_method||'cash'),reference=String(req.body.reference||'').trim()||null,notes=String(req.body.notes||'').trim()||null;if(amount<=0)throw new Error('Payment amount must be greater than zero.');await client.query('BEGIN');const cr=await client.query('SELECT * FROM customers WHERE id=$1 AND is_active=true FOR UPDATE',[req.params.id]);if(!cr.rows.length)throw new Error('Customer not found.');const c=cr.rows[0];if(amount>Number(c.due_balance)+0.0001)throw new Error(`Payment cannot exceed due balance $${Number(c.due_balance).toFixed(2)}.`);const code=makeCode('CPY');await client.query(`INSERT INTO customer_payments(payment_code,customer_id,amount,payment_method,reference,notes,user_id) VALUES($1,$2,$3,$4,$5,$6,$7)`,[code,c.id,amount,method,reference,notes,req.session.user.id]);await client.query('UPDATE customers SET due_balance=GREATEST(0,due_balance-$1) WHERE id=$2',[amount,c.id]);await audit(client,req.session.user.id,'customer_payment','customer',c.id,`${code}; amount=${amount.toFixed(2)}`);await client.query('COMMIT');res.redirect('/customers?success='+encodeURIComponent(`Payment ${code} saved.`));}catch(err){await client.query('ROLLBACK');res.redirect('/customers?error='+encodeURIComponent(err.message));}finally{client.release();}
});
router.get('/history/:id',requireAuth,requireRole('admin','manager'),async(req,res)=>{
  try{
    const [customer,sales,items]=await Promise.all([
      pool.query('SELECT * FROM customers WHERE id=$1',[req.params.id]),
      pool.query(`SELECT s.*,u.name AS cashier_name FROM sales s LEFT JOIN users u ON u.id=s.user_id WHERE s.customer_id=$1 ORDER BY s.created_at DESC`,[req.params.id]),
      pool.query(`SELECT s.id AS sale_id,s.sale_code,s.created_at,si.quantity,si.unit_price,si.subtotal,si.line_type,p.name AS product_name,p.product_code
        FROM sales s JOIN sale_items si ON si.sale_id=s.id JOIN products p ON p.id=si.product_id WHERE s.customer_id=$1 ORDER BY s.created_at DESC,si.id`,[req.params.id])
    ]);
    if(!customer.rows.length)return res.status(404).json({error:'Customer not found'});
    res.json({customer:customer.rows[0],sales:sales.rows,items:items.rows});
  }catch(err){console.error(err);res.status(500).json({error:err.message});}
});
router.get('/report/:id',requireAuth,requireRole('admin','manager'),async(req,res)=>{
  try{
    const [customer,sales,items]=await Promise.all([
      pool.query('SELECT * FROM customers WHERE id=$1',[req.params.id]),
      pool.query(`SELECT s.*,u.name AS cashier_name FROM sales s LEFT JOIN users u ON u.id=s.user_id WHERE s.customer_id=$1 ORDER BY s.created_at DESC`,[req.params.id]),
      pool.query(`SELECT s.id AS sale_id,s.sale_code,s.created_at,si.quantity,si.unit_price,si.subtotal,si.line_type,p.name AS product_name,p.product_code
        FROM sales s JOIN sale_items si ON si.sale_id=s.id JOIN products p ON p.id=si.product_id WHERE s.customer_id=$1 ORDER BY s.created_at DESC,si.id`,[req.params.id])
    ]);
    if(!customer.rows.length)return res.status(404).send('Customer not found');
    res.render('customers/report',{activePage:'customers',pageTitle:'Customer Purchase Report',user:req.session.user,customer:customer.rows[0],sales:sales.rows,items:items.rows});
  }catch(err){console.error(err);res.status(500).send('Error loading customer report');}
});
module.exports=router;

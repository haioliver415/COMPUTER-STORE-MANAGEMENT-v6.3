const express=require('express');
const crypto=require('crypto');
const router=express.Router();
const {pool}=require('../../config/db');
const {requireAuth,requireRole,requirePermission,generateTicketCode}=require('../../middleware/auth');
const {hasPermission}=require('../shared/permissions');
const {audit}=require('../../utils/inventory');

function invoiceCode(){return 'INV-'+Date.now().toString(36).toUpperCase()+'-'+crypto.randomBytes(2).toString('hex').toUpperCase();}
function moneyNum(v){return Math.max(0,Number(v)||0);}
async function logEvent(client,repairId,type,details,userId){await client.query('INSERT INTO repair_events(repair_id,event_type,details,user_id) VALUES($1,$2,$3,$4)',[repairId,type,details||null,userId||null]);}
async function ensureInvoice(client,repairId,serviceFee,partsCost,notes){
  const total=moneyNum(serviceFee)+moneyNum(partsCost);
  const old=await client.query('SELECT * FROM repair_invoices WHERE repair_id=$1 ORDER BY generated_at DESC LIMIT 1',[repairId]);
  if(old.rows.length){
    await client.query('UPDATE repair_invoices SET service_fee=$1,parts_cost=$2,total_cost=$3,notes=COALESCE($4,notes) WHERE id=$5',[moneyNum(serviceFee),moneyNum(partsCost),total,notes||null,old.rows[0].id]);
    return old.rows[0].invoice_code;
  }
  const code=invoiceCode();
  await client.query('INSERT INTO repair_invoices(repair_id,invoice_code,service_fee,parts_cost,total_cost,status,notes) VALUES($1,$2,$3,$4,$5,$6,$7)',[repairId,code,moneyNum(serviceFee),moneyNum(partsCost),total,'pending',notes||null]);
  return code;
}

router.get('/',requireAuth,requireRole('admin','manager','technician'),async(req,res)=>{
  try{
    const status=String(req.query.status||''),search=String(req.query.search||'');
    let sql=`SELECT r.*,COALESCE(c.name,r.customer_name,'Walk-in User') AS display_customer_name,COALESCE(c.phone,r.customer_phone) AS display_customer_phone,u.name AS tech_name,ri.invoice_code,ri.status AS invoice_status
      FROM repairs r LEFT JOIN customers c ON c.id=r.customer_id LEFT JOIN users u ON u.id=r.assigned_technician_id
      LEFT JOIN LATERAL (SELECT * FROM repair_invoices x WHERE x.repair_id=r.id ORDER BY x.generated_at DESC LIMIT 1) ri ON true WHERE 1=1`;
    const params=[];
    if(status){params.push(status);sql+=` AND r.status=$${params.length}`;}
    if(search){params.push('%'+search+'%');sql+=` AND (r.ticket_code ILIKE $${params.length} OR COALESCE(c.phone,r.customer_phone,'') ILIKE $${params.length} OR COALESCE(c.name,r.customer_name,'') ILIKE $${params.length} OR COALESCE(r.device_model,'') ILIKE $${params.length})`;}
    sql+=' ORDER BY r.created_at DESC LIMIT 300';
    const [repairs,techs]=await Promise.all([pool.query(sql,params),pool.query("SELECT id,name FROM users WHERE role='technician' AND is_active=true ORDER BY name")]);
    res.render('repairs/index',{activePage:'repairs',pageTitle:'Repair Service',user:req.session.user,repairs:repairs.rows,technicians:techs.rows,status,search,canPrice:hasPermission(req.session.user,'repair_pricing'),canManage:hasPermission(req.session.user,'repair_manage')});
  }catch(err){console.error(err);res.status(500).send('Error loading repairs');}
});

router.get('/customer-suggestions',requireAuth,requireRole('admin','manager','technician'),async(req,res)=>{
  const q=String(req.query.q||'').trim();if(q.length<1)return res.json([]);
  const r=await pool.query(`SELECT id,name,phone,email FROM customers WHERE is_active=true AND (name ILIKE $1 OR COALESCE(phone,'') ILIKE $1 OR COALESCE(email,'') ILIKE $1) ORDER BY CASE WHEN phone=$2 THEN 0 ELSE 1 END,name LIMIT 12`,['%'+q+'%',q]);res.json(r.rows);
});

router.post('/create',requireAuth,requireRole('admin','manager','technician'),requirePermission('repair_manage'),async(req,res)=>{
  const client=await pool.connect();
  try{
    const customerId=Number(req.body.customer_id)||null;let customerName=String(req.body.customer_name||'').trim(),customerPhone=String(req.body.customer_phone||'').trim();
    if(customerId){const c=await client.query('SELECT name,phone FROM customers WHERE id=$1 AND is_active=true',[customerId]);if(c.rows.length){customerName=c.rows[0].name;customerPhone=c.rows[0].phone||customerPhone;}}
    if(!customerName)customerName='Walk-in User';
    const canPrice=hasPermission(req.session.user,'repair_pricing');
    const serviceFee=canPrice?moneyNum(req.body.service_fee):0,partsCost=canPrice?moneyNum(req.body.parts_cost):0,total=serviceFee+partsCost;
    const code=generateTicketCode();await client.query('BEGIN');
    const r=await client.query(`INSERT INTO repairs(ticket_code,customer_id,customer_name,customer_phone,device_type,device_model,issue_description,estimated_cost,actual_cost,service_fee,parts_cost,received_items,status,created_by,assigned_technician_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,0,$9,$10,$11,'received',$12,$13) RETURNING *`,
      [code,customerId,customerName,customerPhone||null,req.body.device_type,req.body.device_model||null,String(req.body.issue_description||'').trim(),total,serviceFee,partsCost,req.body.received_items||null,req.session.user.id,req.session.user.role==='technician'?req.session.user.id:null]);
    await logEvent(client,r.rows[0].id,'created',`Repair ticket received; estimate ${total.toFixed(2)} (fee ${serviceFee.toFixed(2)} + parts ${partsCost.toFixed(2)})`,req.session.user.id);
    await audit(client,req.session.user.id,'repair_create','repair',r.rows[0].id,code);await client.query('COMMIT');
    if(req.get('accept')&&req.get('accept').includes('application/json'))return res.json({success:true,repair:{...r.rows[0],customer_name:customerName,customer_phone:customerPhone}});
    res.redirect('/repairs/details/'+r.rows[0].id);
  }catch(err){await client.query('ROLLBACK');console.error(err);if(req.get('accept')&&req.get('accept').includes('application/json'))return res.status(400).json({success:false,error:err.message});res.status(500).send('Error creating repair: '+err.message);}finally{client.release();}
});

router.get('/details/:id',requireAuth,requireRole('admin','manager','technician'),async(req,res)=>{
  try{
    const [r,techs,invoice,events]=await Promise.all([
      pool.query(`SELECT r.*,COALESCE(c.name,r.customer_name,'Walk-in User') AS customer_name,COALESCE(c.phone,r.customer_phone) AS customer_phone,u.name AS tech_name FROM repairs r LEFT JOIN customers c ON c.id=r.customer_id LEFT JOIN users u ON u.id=r.assigned_technician_id WHERE r.id=$1`,[req.params.id]),
      pool.query("SELECT id,name FROM users WHERE role='technician' AND is_active=true ORDER BY name"),
      pool.query('SELECT * FROM repair_invoices WHERE repair_id=$1 ORDER BY generated_at DESC LIMIT 1',[req.params.id]),
      pool.query('SELECT e.*,u.name AS user_name FROM repair_events e LEFT JOIN users u ON u.id=e.user_id WHERE e.repair_id=$1 ORDER BY e.created_at DESC',[req.params.id])
    ]);
    if(!r.rows.length)return res.status(404).send('Repair not found');
    res.render('repairs/details',{activePage:'repairs',pageTitle:'Repair Ticket',user:req.session.user,repairs:r.rows[0],technicians:techs.rows,invoice:invoice.rows[0]||null,events:events.rows,canPrice:hasPermission(req.session.user,'repair_pricing'),canManage:hasPermission(req.session.user,'repair_manage')});
  }catch(err){console.error(err);res.status(500).send('Error loading repair');}
});

router.post('/update/:id',requireAuth,requireRole('admin','manager','technician'),requirePermission('repair_manage'),async(req,res)=>{
  const client=await pool.connect();
  try{
    await client.query('BEGIN');const current=await client.query('SELECT * FROM repairs WHERE id=$1 FOR UPDATE',[req.params.id]);if(!current.rows.length)throw new Error('Repair not found');
    const row=current.rows[0],status=req.body.status||row.status,techId=Number(req.body.assigned_technician_id)||(req.session.user.role==='technician'?req.session.user.id:row.assigned_technician_id),notes=req.body.notes||row.notes||null;
    const canPrice=hasPermission(req.session.user,'repair_pricing');
    const serviceFee=canPrice?moneyNum(req.body.service_fee):moneyNum(row.service_fee),partsCost=canPrice?moneyNum(req.body.parts_cost):moneyNum(row.parts_cost),actual=serviceFee+partsCost;
    await client.query(`UPDATE repairs SET status=$1,assigned_technician_id=$2,service_fee=$3,parts_cost=$4,actual_cost=$5,notes=$6,updated_at=NOW(),delivered_at=CASE WHEN $1='delivered' THEN NOW() ELSE delivered_at END WHERE id=$7`,[status,techId||null,serviceFee,partsCost,actual,notes,req.params.id]);
    await logEvent(client,req.params.id,'updated',`Status: ${status}; Service fee: ${serviceFee.toFixed(2)}; Parts: ${partsCost.toFixed(2)}; Total: ${actual.toFixed(2)}`,req.session.user.id);
    if(['ready','finished','delivered'].includes(status))await ensureInvoice(client,req.params.id,serviceFee,partsCost,notes);
    await audit(client,req.session.user.id,'repair_update','repair',Number(req.params.id),`status=${status}; total=${actual}`);await client.query('COMMIT');res.redirect('/repairs/details/'+req.params.id);
  }catch(err){await client.query('ROLLBACK');console.error(err);res.status(400).send(err.message);}finally{client.release();}
});

router.post('/finish/:id',requireAuth,requireRole('admin','manager','technician'),requirePermission('repair_manage'),async(req,res)=>{
  const client=await pool.connect();
  try{
    await client.query('BEGIN');const r=await client.query('SELECT * FROM repairs WHERE id=$1 FOR UPDATE',[req.params.id]);if(!r.rows.length)throw new Error('Repair not found');
    const row=r.rows[0],canPrice=hasPermission(req.session.user,'repair_pricing');
    const serviceFee=canPrice&&req.body.service_fee!==undefined?moneyNum(req.body.service_fee):moneyNum(row.service_fee),partsCost=canPrice&&req.body.parts_cost!==undefined?moneyNum(req.body.parts_cost):moneyNum(row.parts_cost),total=serviceFee+partsCost;
    await client.query("UPDATE repairs SET status='finished',service_fee=$1,parts_cost=$2,actual_cost=$3,updated_at=NOW() WHERE id=$4",[serviceFee,partsCost,total,req.params.id]);
    const inv=await ensureInvoice(client,req.params.id,serviceFee,partsCost,'Repair finished');
    await logEvent(client,req.params.id,'finished',`Repair finished; fee ${serviceFee.toFixed(2)} + parts ${partsCost.toFixed(2)} = ${total.toFixed(2)}; invoice ${inv}`,req.session.user.id);
    await client.query('COMMIT');res.json({success:true,invoice_code:inv,total});
  }catch(err){await client.query('ROLLBACK');res.status(400).json({success:false,error:err.message});}finally{client.release();}
});

router.get('/print/:id',requireAuth,requireRole('admin','manager','technician'),async(req,res)=>{
  try{
    const [r,invoice]=await Promise.all([pool.query(`SELECT r.*,COALESCE(c.name,r.customer_name,'Walk-in User') AS customer_name,COALESCE(c.phone,r.customer_phone) AS customer_phone,u.name AS tech_name FROM repairs r LEFT JOIN customers c ON c.id=r.customer_id LEFT JOIN users u ON u.id=r.assigned_technician_id WHERE r.id=$1`,[req.params.id]),pool.query('SELECT * FROM repair_invoices WHERE repair_id=$1 ORDER BY generated_at DESC LIMIT 1',[req.params.id])]);
    if(!r.rows.length)return res.status(404).send('Repair not found');
    await pool.query('INSERT INTO repair_events(repair_id,event_type,details,user_id) VALUES($1,$2,$3,$4)',[req.params.id,'printed','Repair slip printed',req.session.user.id]);
    res.render('repairs/print',{layout:false,repairs:r.rows[0],invoice:invoice.rows[0]||null,settings:res.locals.settings,money:res.locals.money});
  }catch(err){res.status(500).send(err.message);}
});

module.exports=router;

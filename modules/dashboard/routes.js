const express = require('express');
const router = express.Router();
const { pool } = require('../../config/db');
const { requireAuth } = require('../../middleware/auth');
const { roleHome } = require('../shared/permissions');
const moment = require('moment');

router.get('/', requireAuth, async (req, res) => {
  if (!['admin','manager'].includes(req.session.user.role)) return res.redirect(roleHome(req.session.user.role));
  try {
    const today = moment().format('YYYY-MM-DD');
    const monthStart = moment().startOf('month').format('YYYY-MM-DD');
    const [todaySalesResult, monthSalesResult, totalProductsResult, lowStockResult, pendingRepairsResult, recentSalesResult, pendingRepairsResult2] = await Promise.all([
      pool.query('SELECT COALESCE(SUM(total), 0) as total_sales, COUNT(*) as sale_count FROM sales WHERE created_at::date = $1', [today]),
      pool.query('SELECT COALESCE(SUM(total), 0) as total_sales, COUNT(*) as sale_count FROM sales WHERE created_at >= $1', [monthStart]),
      pool.query('SELECT COUNT(*) as count FROM products WHERE is_active = true'),
      pool.query('SELECT COUNT(*) as count FROM products WHERE stock_qty <= min_stock AND is_active = true'),
      pool.query("SELECT COUNT(*) as count FROM repairs WHERE status NOT IN ('delivered','finished')"),
      pool.query(`SELECT s.*, u.name as cashier_name, c.name as customer_name FROM sales s LEFT JOIN users u ON s.user_id = u.id LEFT JOIN customers c ON s.customer_id = c.id ORDER BY s.created_at DESC LIMIT 5`),
      pool.query(`SELECT r.*, COALESCE(c.name,r.customer_name) as customer_name, u.name as tech_name FROM repairs r LEFT JOIN customers c ON r.customer_id = c.id LEFT JOIN users u ON r.assigned_technician_id = u.id WHERE r.status NOT IN ('delivered','finished') ORDER BY r.created_at DESC LIMIT 5`)
    ]);
    res.render('dashboard/index', { user:req.session.user, activePage:'dashboard', pageTitle:'Dashboard', todaySales:todaySalesResult.rows[0], monthSales:monthSalesResult.rows[0], totalProducts:{count:totalProductsResult.rows[0].count}, lowStock:{count:lowStockResult.rows[0].count}, pendingRepairs:{count:pendingRepairsResult.rows[0].count}, recentSales:recentSalesResult.rows, pendingRepairsList:pendingRepairsResult2.rows, moment });
  } catch (err) { console.error(err); res.status(500).send('Error loading dashboard'); }
});
module.exports = router;

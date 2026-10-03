const bcrypt = require('bcryptjs');
const { pool } = require('../config/db');
const { hasAccess, hasPermission, normalizeAccess, normalizePermissions } = require('../modules/shared/permissions');

const SALT_ROUNDS = 10;

async function hashPassword(password) { return await bcrypt.hash(password, SALT_ROUNDS); }
async function comparePassword(password, hash) { return await bcrypt.compare(password, hash); }

function generateSaleCode() { const now=new Date();const date=now.toISOString().slice(0,10).replace(/-/g,'');const rand=Math.floor(Math.random()*9000+1000);return `SALE-${date}-${rand}`; }
function generatePurchaseCode() { const now=new Date();const date=now.toISOString().slice(0,10).replace(/-/g,'');const rand=Math.floor(Math.random()*9000+1000);return `PUR-${date}-${rand}`; }
function generateTicketCode() { const now=new Date();const date=now.toISOString().slice(0,10).replace(/-/g,'');const rand=Math.floor(Math.random()*9000+1000);return `RPL-${date}-${rand}`; }

async function refreshSessionUser(req, res) {
  if (!req.session.user) return false;
  if (req._authRefreshed) return true;
  const r = await pool.query('SELECT id,name,email,role,is_active,access_json,permission_json FROM users WHERE id=$1 LIMIT 1', [req.session.user.id]);
  const u = r.rows[0];
  if (!u || !u.is_active) {
    await new Promise(resolve => req.session.destroy(() => resolve()));
    res.clearCookie('connect.sid');
    return false;
  }
  req.session.user = { id:u.id, name:u.name, email:u.email, role:u.role, access:normalizeAccess(u.access_json,u.role), access_json:u.access_json, permissions:normalizePermissions(u.permission_json,u.role), permission_json:u.permission_json };
  req._authRefreshed = true;
  return true;
}

async function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/auth/login');
  try {
    if (!(await refreshSessionUser(req,res))) return res.redirect('/auth/login');
    return next();
  } catch (err) {
    console.error('Auth refresh failed:', err.message);
    return res.status(500).send('Authentication check failed.');
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect('/auth/login');
    if (!roles.includes(req.session.user.role)) {
      return res.status(403).render('errors/403', { user:req.session.user, activePage:'', pageTitle:'Access Denied', error:null });
    }
    next();
  };
}

function requireAccess(key) {
  return async (req, res, next) => {
    if (!req.session.user) return res.redirect('/auth/login');
    try {
      if (!(await refreshSessionUser(req,res))) return res.redirect('/auth/login');
      if (!hasAccess(req.session.user, key)) {
        return res.status(403).render('errors/403', { user:req.session.user, activePage:'', pageTitle:'Access Disabled', error:null });
      }
      next();
    } catch (err) {
      console.error('Access refresh failed:', err.message);
      res.status(500).send('Access check failed.');
    }
  };
}


function requirePermission(key) {
  return async (req, res, next) => {
    if (!req.session.user) return res.redirect('/auth/login');
    try {
      if (!(await refreshSessionUser(req,res))) return res.redirect('/auth/login');
      if (!hasPermission(req.session.user, key)) {
        return res.status(403).render('errors/403', { user:req.session.user, activePage:'', pageTitle:'Permission Disabled', error:null });
      }
      next();
    } catch (err) {
      console.error('Permission refresh failed:', err.message);
      res.status(500).send('Permission check failed.');
    }
  };
}

module.exports = { hashPassword, comparePassword, generateSaleCode, generatePurchaseCode, generateTicketCode, requireAuth, requireRole, requireAccess, requirePermission };

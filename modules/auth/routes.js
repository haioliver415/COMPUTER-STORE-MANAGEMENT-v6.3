const express = require('express');
const router = express.Router();
const { pool } = require('../../config/db');
const { requireAuth, requireRole, hashPassword, comparePassword } = require('../../middleware/auth');
const { audit } = require('../../utils/inventory');
const { roleHome, normalizeAccess, normalizePermissions } = require('../shared/permissions');

router.get('/login', async (req, res) => {
  if (req.session.user) return res.redirect(roleHome(req.session.user.role, req.session.user.access));
  res.render('auth/login', { layout: 'layouts/login', pageTitle: 'Login', error: null });
});

router.post('/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  try {
    const result = await pool.query('SELECT * FROM users WHERE LOWER(email) = $1 AND is_active = true', [email]);
    const user = result.rows[0];
    if (!user || !(await comparePassword(password, user.password))) {
      return res.render('auth/login', { layout: 'layouts/login', pageTitle: 'Login', error: 'Invalid email or password' });
    }
    req.session.regenerate((err) => {
      if (err) return res.render('auth/login', { layout: 'layouts/login', pageTitle: 'Login', error: 'Unable to create login session' });
      const access = normalizeAccess(user.access_json, user.role);
      const permissions = normalizePermissions(user.permission_json, user.role);
      req.session.user = { id:user.id,name:user.name,email:user.email,role:user.role,access,access_json:user.access_json,permissions,permission_json:user.permission_json };
      req.session.save(async (saveErr) => {
        if (saveErr) return res.render('auth/login', { layout: 'layouts/login', pageTitle: 'Login', error: 'Unable to save login session' });
        try { await audit(pool, user.id, 'login', 'user', user.id, 'User signed in'); } catch (_) {}
        res.redirect(roleHome(user.role, access));
      });
    });
  } catch (err) {
    console.error(err);
    res.render('auth/login', { layout: 'layouts/login', pageTitle: 'Login', error: 'Server error' });
  }
});

router.get('/register', requireAuth, requireRole('admin'), async (req, res) => {
  res.render('auth/register', { layout: 'layouts/login', pageTitle: 'Register', user: req.session.user });
});

router.post('/register', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    const allowed = ['admin','manager','cashier','technician','stock'];
    if (!allowed.includes(role)) return res.status(400).send('Invalid role');
    const hashed = await hashPassword(password);
    await pool.query('INSERT INTO users (name, email, password, role) VALUES ($1, $2, $3, $4)', [name, String(email).trim().toLowerCase(), hashed, role]);
    res.redirect('/settings');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error creating user');
  }
});

router.post('/toggle/:id', requireAuth, requireRole('admin'), async (req, res) => {
  if (Number(req.params.id) === Number(req.session.user.id)) return res.redirect('/settings');
  await pool.query('UPDATE users SET is_active = NOT is_active WHERE id = $1', [req.params.id]);
  res.redirect('/settings');
});


router.get('/no-access', requireAuth, (req,res) => {
  res.status(403).render('errors/403', { user:req.session.user, activePage:'', pageTitle:'No Module Access', error:null });
});

function logout(req, res) {
  const userId = req.session && req.session.user ? req.session.user.id : null;
  if (userId) audit(pool, userId, 'logout', 'user', userId, 'User signed out').catch(() => {});
  req.session.destroy((err) => {
    if (err) console.error('Logout error:', err);
    res.clearCookie('connect.sid');
    res.redirect('/auth/login');
  });
}
router.post('/logout', requireAuth, logout);
router.get('/logout', requireAuth, logout);
module.exports = router;

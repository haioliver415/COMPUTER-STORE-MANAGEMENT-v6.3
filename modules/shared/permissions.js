const ACCESS_KEYS = ['dashboard','pos','products','inventory','suppliers','customers','repairs','after_sales','reports','settings'];
const ACTION_KEYS = [
  'product_edit','product_delete','inventory_adjust','stock_count','purchase_manage',
  'customer_manage','sale_correction','repair_manage','repair_pricing','report_export'
];

function defaultAccessForRole(role) {
  if (role === 'admin') return ACCESS_KEYS.slice();
  if (role === 'manager') return ['dashboard','pos','products','inventory','suppliers','customers','repairs','after_sales','reports'];
  if (role === 'cashier') return ['pos','customers'];
  if (role === 'technician') return ['repairs'];
  if (role === 'stock') return ['inventory','suppliers','after_sales','reports'];
  return [];
}

function defaultPermissionsForRole(role) {
  if (role === 'admin') return ACTION_KEYS.slice();
  if (role === 'manager') return ACTION_KEYS.slice();
  if (role === 'cashier') return ['customer_manage'];
  if (role === 'technician') return ['repair_manage'];
  if (role === 'stock') return ['inventory_adjust','stock_count','purchase_manage','report_export'];
  return [];
}

function parseArray(value) {
  let raw = value;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch (_) { raw = null; } }
  return Array.isArray(raw) ? raw : null;
}

function normalizeAccess(value, role) {
  if (role === 'admin') return ACCESS_KEYS.slice();
  const raw = parseArray(value);
  if (!raw) return defaultAccessForRole(role);
  return Array.from(new Set(raw.filter(k => ACCESS_KEYS.includes(k))));
}

function normalizePermissions(value, role) {
  if (role === 'admin') return ACTION_KEYS.slice();
  const raw = parseArray(value);
  if (!raw) return defaultPermissionsForRole(role);
  return Array.from(new Set(raw.filter(k => ACTION_KEYS.includes(k))));
}

function hasAccess(user, key) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return normalizeAccess(user.access_json || user.access, user.role).includes(key);
}

function hasPermission(user, key) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return normalizePermissions(user.permission_json || user.permissions, user.role).includes(key);
}

function roleHome(role, access) {
  const user = { role, access };
  const preferred = role === 'cashier' ? ['pos','customers'] : role === 'technician' ? ['repairs'] : role === 'stock' ? ['inventory','suppliers','reports','after_sales'] : ['dashboard','pos','products','inventory','reports'];
  const found = preferred.find(k => hasAccess(user, k));
  const map = { dashboard:'/dashboard', pos:'/pos', products:'/products', inventory:'/inventory', suppliers:'/suppliers', customers:'/customers', repairs:'/repairs', after_sales:'/after-sales', reports:'/reports', settings:'/settings' };
  return map[found] || '/auth/no-access';
}

function canManage(role) { return role === 'admin' || role === 'manager'; }

module.exports = { ACCESS_KEYS, ACTION_KEYS, defaultAccessForRole, defaultPermissionsForRole, normalizeAccess, normalizePermissions, hasAccess, hasPermission, roleHome, canManage };

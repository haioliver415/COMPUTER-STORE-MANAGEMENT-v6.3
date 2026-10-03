-- =============================================
-- COMPUTER STORE MANAGEMENT SYSTEM DATABASE (PostgreSQL)
-- Schema only. Seed data is handled by setup.js
-- =============================================

-- Table: users
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(100) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'cashier',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Table: categories
CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  deleted_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE categories ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP NULL;

-- Table: products
CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  category_id INTEGER NOT NULL,
  brand VARCHAR(100),
  model VARCHAR(100),
  barcode VARCHAR(50) UNIQUE,
  buy_price DECIMAL(10,2) DEFAULT 0.00,
  sell_price DECIMAL(10,2) NOT NULL,
  stock_qty INTEGER DEFAULT 0,
  min_stock INTEGER DEFAULT 5,
  warranty_months INTEGER DEFAULT 0,
  image VARCHAR(255),
  is_active BOOLEAN DEFAULT true,
  deleted_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
);

-- Table: suppliers
CREATE TABLE IF NOT EXISTS suppliers (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  phone VARCHAR(20),
  email VARCHAR(100),
  address TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Table: customers
CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  phone VARCHAR(20),
  email VARCHAR(100),
  due_balance DECIMAL(10,2) DEFAULT 0.00,
  address TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Table: sales
CREATE TABLE IF NOT EXISTS sales (
  id SERIAL PRIMARY KEY,
  sale_code VARCHAR(50) UNIQUE NOT NULL,
  user_id INTEGER NOT NULL,
  customer_id INTEGER,
  subtotal DECIMAL(10,2) DEFAULT 0.00,
  discount DECIMAL(10,2) DEFAULT 0.00,
  discount_type VARCHAR(10) DEFAULT 'fixed',
  tax DECIMAL(10,2) DEFAULT 0.00,
  total DECIMAL(10,2) NOT NULL,
  paid_amount DECIMAL(10,2) DEFAULT 0.00,
  change_amount DECIMAL(10,2) DEFAULT 0.00,
  payment_method VARCHAR(20) DEFAULT 'cash',
  status VARCHAR(20) DEFAULT 'completed',
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);

-- Table: sale_items
CREATE TABLE IF NOT EXISTS sale_items (
  id SERIAL PRIMARY KEY,
  sale_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  unit_price DECIMAL(10,2) NOT NULL,
  subtotal DECIMAL(10,2) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id)
);

-- Table: purchases
CREATE TABLE IF NOT EXISTS purchases (
  id SERIAL PRIMARY KEY,
  purchase_code VARCHAR(50) UNIQUE NOT NULL,
  supplier_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  subtotal DECIMAL(10,2) DEFAULT 0.00,
  tax DECIMAL(10,2) DEFAULT 0.00,
  total DECIMAL(10,2) NOT NULL,
  paid_amount DECIMAL(10,2) DEFAULT 0.00,
  due_amount DECIMAL(10,2) DEFAULT 0.00,
  payment_status VARCHAR(20) DEFAULT 'due',
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Table: purchase_items
CREATE TABLE IF NOT EXISTS purchase_items (
  id SERIAL PRIMARY KEY,
  purchase_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  buy_price DECIMAL(10,2) NOT NULL,
  subtotal DECIMAL(10,2) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (purchase_id) REFERENCES purchases(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id)
);

-- Table: repairs
CREATE TABLE IF NOT EXISTS repairs (
  id SERIAL PRIMARY KEY,
  ticket_code VARCHAR(50) UNIQUE NOT NULL,
  customer_id INTEGER NOT NULL,
  device_type VARCHAR(20) NOT NULL,
  device_model VARCHAR(100),
  issue_description TEXT NOT NULL,
  estimated_cost DECIMAL(10,2) DEFAULT 0.00,
  actual_cost DECIMAL(10,2) DEFAULT 0.00,
  status VARCHAR(20) DEFAULT 'received',
  assigned_technician_id INTEGER,
  delivered_at TIMESTAMP NULL,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  FOREIGN KEY (assigned_technician_id) REFERENCES users(id)
);

-- Table: repair invoices
CREATE TABLE IF NOT EXISTS repair_invoices (
  id SERIAL PRIMARY KEY,
  repair_id INTEGER NOT NULL,
  invoice_code VARCHAR(50) UNIQUE NOT NULL,
  total_cost DECIMAL(10,2) DEFAULT 0.00,
  status VARCHAR(20) DEFAULT 'pending',
  notes TEXT,
  generated_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (repair_id) REFERENCES repairs(id) ON DELETE CASCADE
);

-- Table: stock_adjustments
CREATE TABLE IF NOT EXISTS stock_adjustments (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL,
  adjustment_type VARCHAR(20) NOT NULL,
  quantity INTEGER NOT NULL,
  reason TEXT,
  reference VARCHAR(100),
  user_id INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (product_id) REFERENCES products(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Table: settings
CREATE TABLE IF NOT EXISTS settings (
  id SERIAL PRIMARY KEY,
  store_name VARCHAR(200) DEFAULT 'Computer Store',
  logo VARCHAR(255),
  address TEXT,
  phone VARCHAR(20),
  currency_symbol VARCHAR(10) DEFAULT '$',
  currency_code VARCHAR(10) DEFAULT 'USD',
  second_currency_symbol VARCHAR(10) DEFAULT '៛',
  second_currency_code VARCHAR(10) DEFAULT 'KHR',
  exchange_rate DECIMAL(12,2) DEFAULT 4100.00,
  tax_rate DECIMAL(5,2) DEFAULT 10.00,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Existing installs: add new currency columns if missing (idempotent)
ALTER TABLE settings ADD COLUMN IF NOT EXISTS currency_code VARCHAR(10) DEFAULT 'USD';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS second_currency_symbol VARCHAR(10) DEFAULT '៛';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS second_currency_code VARCHAR(10) DEFAULT 'KHR';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS exchange_rate DECIMAL(12,2) DEFAULT 4100.00;

-- Migrate the initial settings row to USD + Khmer Riel (runs once)
UPDATE settings
SET currency_symbol='$', currency_code='USD',
    second_currency_symbol='៛', second_currency_code='KHR',
    exchange_rate=4100.00, tax_rate=10.00
WHERE currency_code IS NULL OR currency_code = '';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
CREATE INDEX IF NOT EXISTS idx_sales_user_id ON sales(user_id);
CREATE INDEX IF NOT EXISTS idx_sales_created_at ON sales(created_at);
CREATE INDEX IF NOT EXISTS idx_repairs_status ON repairs(status);
CREATE INDEX IF NOT EXISTS idx_repairs_customer_id ON repairs(customer_id);

-- =============================================
-- V2: TRACEABLE STOCK / WARRANTY / AFTER-SALES
-- =============================================

ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS returned_quantity INTEGER DEFAULT 0;
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS line_type VARCHAR(30) DEFAULT 'sale';
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS parent_sale_item_id INTEGER NULL;

CREATE TABLE IF NOT EXISTS inventory_units (
  id SERIAL PRIMARY KEY,
  internal_code VARCHAR(80) UNIQUE NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id),
  serial_number VARCHAR(150) UNIQUE,
  source_type VARCHAR(20) NOT NULL DEFAULT 'own',
  supplier_id INTEGER REFERENCES suppliers(id),
  cost_price DECIMAL(10,2) DEFAULT 0.00,
  received_at TIMESTAMP DEFAULT NOW(),
  dealer_warranty_end DATE NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'in_stock',
  last_sale_id INTEGER REFERENCES sales(id),
  last_sale_item_id INTEGER REFERENCES sale_items(id),
  sold_at TIMESTAMP NULL,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inventory_movements (
  id SERIAL PRIMARY KEY,
  inventory_unit_id INTEGER REFERENCES inventory_units(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  movement_type VARCHAR(40) NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  sale_id INTEGER REFERENCES sales(id),
  sale_item_id INTEGER REFERENCES sale_items(id),
  reference VARCHAR(120),
  notes TEXT,
  user_id INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS warranty_claims (
  id SERIAL PRIMARY KEY,
  claim_code VARCHAR(60) UNIQUE NOT NULL,
  inventory_unit_id INTEGER NOT NULL REFERENCES inventory_units(id),
  sale_id INTEGER REFERENCES sales(id),
  sale_item_id INTEGER REFERENCES sale_items(id),
  customer_id INTEGER REFERENCES customers(id),
  issue_description TEXT NOT NULL,
  requested_action VARCHAR(30) DEFAULT 'check',
  store_warranty_status VARCHAR(20) DEFAULT 'unknown',
  dealer_warranty_status VARCHAR(20) DEFAULT 'unknown',
  status VARCHAR(30) DEFAULT 'open',
  resolution VARCHAR(40),
  replacement_unit_id INTEGER REFERENCES inventory_units(id),
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  closed_at TIMESTAMP NULL
);

CREATE TABLE IF NOT EXISTS sales_corrections (
  id SERIAL PRIMARY KEY,
  correction_code VARCHAR(60) UNIQUE NOT NULL,
  sale_id INTEGER NOT NULL REFERENCES sales(id),
  original_sale_item_id INTEGER NOT NULL REFERENCES sale_items(id),
  replacement_sale_item_id INTEGER REFERENCES sale_items(id),
  correction_type VARCHAR(30) NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  reason TEXT NOT NULL,
  amount_difference DECIMAL(10,2) DEFAULT 0.00,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  action VARCHAR(80) NOT NULL,
  entity_type VARCHAR(50),
  entity_id INTEGER,
  details TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inventory_units_product_status ON inventory_units(product_id, status);
CREATE INDEX IF NOT EXISTS idx_inventory_units_serial ON inventory_units(serial_number);
CREATE INDEX IF NOT EXISTS idx_inventory_units_last_sale ON inventory_units(last_sale_id);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_unit ON inventory_movements(inventory_unit_id, created_at);
CREATE INDEX IF NOT EXISTS idx_warranty_claims_status ON warranty_claims(status, created_at);
CREATE INDEX IF NOT EXISTS idx_sales_corrections_sale ON sales_corrections(sale_id, created_at);
ALTER TABLE inventory_units ADD COLUMN IF NOT EXISTS customer_warranty_end DATE NULL;

-- =============================================
-- V3: UI LANGUAGE, PRODUCT CODE, REPAIR INTAKE
-- =============================================
ALTER TABLE settings ADD COLUMN IF NOT EXISTS language VARCHAR(5) DEFAULT 'en';
UPDATE settings SET language='en' WHERE language IS NULL OR language NOT IN ('en','km');

ALTER TABLE products ADD COLUMN IF NOT EXISTS product_code VARCHAR(80);
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_product_code_unique ON products(product_code) WHERE product_code IS NOT NULL;

-- V5: per-product stock identity rules. Every unit still receives an internal Unit Code.
-- quantity = no factory serials, optional = serials allowed, required = every unit must have a serial.
ALTER TABLE products ADD COLUMN IF NOT EXISTS tracking_mode VARCHAR(20) DEFAULT 'optional';
UPDATE products SET tracking_mode='optional' WHERE tracking_mode IS NULL OR tracking_mode NOT IN ('quantity','optional','required');

ALTER TABLE repairs ALTER COLUMN customer_id DROP NOT NULL;
ALTER TABLE repairs ADD COLUMN IF NOT EXISTS customer_name VARCHAR(120);
ALTER TABLE repairs ADD COLUMN IF NOT EXISTS customer_phone VARCHAR(30);
ALTER TABLE repairs ADD COLUMN IF NOT EXISTS received_items TEXT;
ALTER TABLE repairs ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id);

CREATE TABLE IF NOT EXISTS repair_events (
  id SERIAL PRIMARY KEY,
  repair_id INTEGER NOT NULL REFERENCES repairs(id) ON DELETE CASCADE,
  event_type VARCHAR(40) NOT NULL,
  details TEXT,
  user_id INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_repair_events_repair ON repair_events(repair_id, created_at);

-- =============================================
-- V6: ORDER/RECEIVE, PAYMENT LEDGERS, RETURNS, STOCK COUNT
-- =============================================

-- Purchase is now an order first. Existing V5 rows keep 'received' so old stock is not received twice.
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS order_status VARCHAR(20) DEFAULT 'received';
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS received_at TIMESTAMP NULL;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS received_qty INTEGER DEFAULT 0;
ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS dealer_warranty_months INTEGER DEFAULT 0;
UPDATE purchase_items pi SET received_qty=pi.quantity
WHERE COALESCE(pi.received_qty,0)=0
  AND EXISTS (SELECT 1 FROM purchases p WHERE p.id=pi.purchase_id AND COALESCE(p.order_status,'received')='received');

CREATE TABLE IF NOT EXISTS purchase_receipts (
  id SERIAL PRIMARY KEY,
  receipt_code VARCHAR(60) UNIQUE NOT NULL,
  purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS purchase_receipt_items (
  id SERIAL PRIMARY KEY,
  receipt_id INTEGER NOT NULL REFERENCES purchase_receipts(id) ON DELETE CASCADE,
  purchase_item_id INTEGER NOT NULL REFERENCES purchase_items(id),
  quantity INTEGER NOT NULL,
  serial_numbers TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS supplier_payments (
  id SERIAL PRIMARY KEY,
  payment_code VARCHAR(60) UNIQUE NOT NULL,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  purchase_id INTEGER REFERENCES purchases(id),
  amount DECIMAL(10,2) NOT NULL,
  payment_method VARCHAR(30) DEFAULT 'cash',
  reference VARCHAR(120),
  notes TEXT,
  user_id INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_supplier_payments_supplier ON supplier_payments(supplier_id,created_at);
CREATE INDEX IF NOT EXISTS idx_supplier_payments_purchase ON supplier_payments(purchase_id,created_at);

CREATE TABLE IF NOT EXISTS customer_payments (
  id SERIAL PRIMARY KEY,
  payment_code VARCHAR(60) UNIQUE NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  sale_id INTEGER REFERENCES sales(id),
  amount DECIMAL(10,2) NOT NULL,
  payment_method VARCHAR(30) DEFAULT 'cash',
  reference VARCHAR(120),
  notes TEXT,
  user_id INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_customer_payments_customer ON customer_payments(customer_id,created_at);

CREATE TABLE IF NOT EXISTS sale_returns (
  id SERIAL PRIMARY KEY,
  return_code VARCHAR(60) UNIQUE NOT NULL,
  sale_id INTEGER NOT NULL REFERENCES sales(id),
  return_type VARCHAR(30) NOT NULL,
  refund_amount DECIMAL(10,2) DEFAULT 0.00,
  additional_payment DECIMAL(10,2) DEFAULT 0.00,
  reason TEXT NOT NULL,
  status VARCHAR(20) DEFAULT 'completed',
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS sale_return_items (
  id SERIAL PRIMARY KEY,
  sale_return_id INTEGER NOT NULL REFERENCES sale_returns(id) ON DELETE CASCADE,
  sale_item_id INTEGER NOT NULL REFERENCES sale_items(id),
  inventory_unit_id INTEGER REFERENCES inventory_units(id),
  quantity INTEGER NOT NULL DEFAULT 1,
  condition VARCHAR(30) DEFAULT 'good',
  replacement_product_id INTEGER REFERENCES products(id),
  replacement_unit_id INTEGER REFERENCES inventory_units(id),
  old_unit_price DECIMAL(10,2) DEFAULT 0,
  new_unit_price DECIMAL(10,2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sale_returns_sale ON sale_returns(sale_id,created_at);

CREATE TABLE IF NOT EXISTS stock_counts (
  id SERIAL PRIMARY KEY,
  count_code VARCHAR(60) UNIQUE NOT NULL,
  status VARCHAR(20) DEFAULT 'draft',
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  confirmed_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  confirmed_at TIMESTAMP NULL
);
CREATE TABLE IF NOT EXISTS stock_count_items (
  id SERIAL PRIMARY KEY,
  stock_count_id INTEGER NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  system_qty INTEGER NOT NULL,
  actual_qty INTEGER,
  difference INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(stock_count_id,product_id)
);
CREATE INDEX IF NOT EXISTS idx_stock_count_items_count ON stock_count_items(stock_count_id);

-- =============================================
-- V6.2: RECYCLE BIN, USER ACCESS, SEARCH OPTIMIZATION
-- =============================================
ALTER TABLE products ADD COLUMN IF NOT EXISTS purged_at TIMESTAMP NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS access_json JSONB NULL;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS deleted_product_retention_days INTEGER DEFAULT 30;

CREATE INDEX IF NOT EXISTS idx_products_active_name ON products(is_active, name);
CREATE INDEX IF NOT EXISTS idx_products_active_code ON products(is_active, product_code);
CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
CREATE INDEX IF NOT EXISTS idx_inventory_units_product_status ON inventory_units(product_id, status);
CREATE INDEX IF NOT EXISTS idx_inventory_units_internal_code ON inventory_units(internal_code);
CREATE INDEX IF NOT EXISTS idx_inventory_units_serial ON inventory_units(serial_number);
CREATE INDEX IF NOT EXISTS idx_customers_active_name ON customers(is_active, name);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
CREATE INDEX IF NOT EXISTS idx_suppliers_active_name ON suppliers(is_active, name);
CREATE INDEX IF NOT EXISTS idx_suppliers_phone ON suppliers(phone);

-- =============================================
-- V6.3: MULTI-PC, GRANULAR ACCESS, REPAIR PRICING
-- =============================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS permission_json JSONB NULL;
ALTER TABLE repairs ADD COLUMN IF NOT EXISTS service_fee DECIMAL(10,2) DEFAULT 0.00;
ALTER TABLE repairs ADD COLUMN IF NOT EXISTS parts_cost DECIMAL(10,2) DEFAULT 0.00;
ALTER TABLE repair_invoices ADD COLUMN IF NOT EXISTS service_fee DECIMAL(10,2) DEFAULT 0.00;
ALTER TABLE repair_invoices ADD COLUMN IF NOT EXISTS parts_cost DECIMAL(10,2) DEFAULT 0.00;

CREATE INDEX IF NOT EXISTS idx_users_active_role ON users(is_active, role);
CREATE INDEX IF NOT EXISTS idx_repairs_status_created ON repairs(status, created_at);
UPDATE repairs SET service_fee=COALESCE(NULLIF(actual_cost,0),estimated_cost,0), parts_cost=0
WHERE COALESCE(service_fee,0)=0 AND COALESCE(parts_cost,0)=0 AND COALESCE(NULLIF(actual_cost,0),estimated_cost,0)>0;
UPDATE repair_invoices SET service_fee=COALESCE(total_cost,0), parts_cost=0
WHERE COALESCE(service_fee,0)=0 AND COALESCE(parts_cost,0)=0 AND COALESCE(total_cost,0)>0;

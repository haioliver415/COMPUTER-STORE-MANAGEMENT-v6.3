# V6.3 Module Structure

Runtime routes are grouped by feature under `modules/`:

- `auth` – login, users and sessions
- `dashboard` – business dashboard
- `pos` – sales and checkout
- `products` – product master, serial/unit rules and recycle-bin delete
- `customers` – customer records and balances
- `suppliers` – suppliers, purchase orders, receiving and supplier payments
- `inventory` – stock overview, adjustments, unit tracking and physical count
- `after-sales` – warranty, returns, exchange, sale correction and void
- `repairs` – repair intake, service fee, parts cost, status and invoice
- `reports` – stock, sales and repair reports/exports
- `settings` – store settings, PostgreSQL connection, backup/restore, users and permissions
- `shared` – translations and permission definitions

Supporting folders:

- `config/` – PostgreSQL connection loader. Local `database.json` is intentionally Git-ignored.
- `middleware/` – authentication, permissions and uploads.
- `utils/` – stock/inventory transaction helpers.
- `sql/` – idempotent PostgreSQL schema/migrations.
- `views/` – EJS UI grouped by feature.
- `public/` – local CSS/JS/Bootstrap assets for offline UI.
- `scripts/` – dependency bootstrap scripts only.

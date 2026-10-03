# PostgreSQL Multi-PC Setup (V6.3)

The application can be used on one PC or many PCs with the same PostgreSQL database.

## Recommended layout

- PostgreSQL server: one always-on PC/server, for example `192.168.1.10`.
- Database: `computer_store`.
- App PCs: configure **Settings -> PostgreSQL / Multi-PC** with the same server IP, port, database, username and password.
- Each PC may run the Electron app locally. All transactions are stored in the same PostgreSQL database.
- Or run `npm run server` on one PC and open `http://SERVER-IP:3000` from other PCs on the LAN.

## PostgreSQL server requirements

1. Create the database and login in PostgreSQL.
2. Allow PostgreSQL to listen on the LAN interface (`listen_addresses`).
3. Add the LAN subnet to `pg_hba.conf` using password authentication (`scram-sha-256` recommended).
4. Allow inbound TCP port 5432 through the server firewall only for the trusted LAN.
5. Restart PostgreSQL after changing its network configuration.

Example SQL run by a PostgreSQL administrator:

```sql
CREATE USER computer_store_user WITH PASSWORD 'use-a-strong-password';
CREATE DATABASE computer_store OWNER computer_store_user;
```

Do not commit `config/database.json`; it may contain the database password. The project `.gitignore` excludes it.

## First run

Run `npm start`. If dependencies are missing, V6.3 installs them automatically. If PostgreSQL cannot be reached, the app opens the Database Setup screen instead of closing. Enter the connection, test it, then save.

A brand-new empty database contains **no sample products, customers, suppliers, sales, purchases or repairs**. The system only creates the schema, base settings and one first admin if no admin exists.

Default first admin (unless FIRST_ADMIN_* environment values are set):

- Email: `admin@store.local`
- Password: `admin123`

Change this account/password before production use.

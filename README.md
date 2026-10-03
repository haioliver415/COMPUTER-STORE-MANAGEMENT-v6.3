# Computer Store Management System V6.3

Electron + Express + EJS + PostgreSQL inventory/POS/repair management system.

## Start

```bash
npm start
```

`npm start` checks dependencies and runs `npm install` automatically if required.

For browser/LAN server mode:

```bash
npm run server
```

The server listens on port 3000 and, by default, on all network interfaces. See `DATABASE_MULTI_PC.md` for shared PostgreSQL setup.

## Database

V6.3 uses PostgreSQL only. Connection values can be set in the Database Setup screen or Settings. Local credentials are stored in `config/database.json`, which is excluded from Git.

If the configured database cannot be reached, the application stays open and presents the Database Setup screen.

Fresh databases contain no demo/sample business data. Existing database data is kept; startup only applies idempotent schema migrations and required system defaults.

## Backup / Restore

Admin -> Settings -> Database Backup & Restore.

- Backup downloads schema + data as `.sql`.
- Restore requires an uploaded CSMS `.sql` backup and the confirmation word `RESTORE`.
- A safety backup is written to `backups/` before restore.

## Security before production

- Change the default first-admin password.
- Set a strong `SESSION_SECRET`.
- Create a dedicated PostgreSQL login instead of using the `postgres` superuser.
- Restrict PostgreSQL and port 3000 to your trusted LAN/firewall.
- Keep `config/database.json` out of Git.

See `V6.3_TEST_CHECKLIST.txt` before deployment.

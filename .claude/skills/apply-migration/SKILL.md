---
name: apply-migration
description: Apply a Postgres DDL migration (CREATE/ALTER TABLE, RPC functions, anything in supabase/migrations/*.sql) to the self-hosted VPS database. Use when a change needs DDL — Kong/PostgREST (the normal data path) CANNOT run DDL. Apply it yourself; do not just print SSH commands for the user.
---

# Apply a DB migration

**Key fact:** runtime data lives on a **self-hosted Supabase/Postgres on your VPS**, NOT Supabase
cloud. The cloud ref (`SUPABASE_PROJECT_REF`) is edge-functions-only.

- `.env`'s `SUPABASE_URL` is the **Kong gateway** — fine for data CRUD via supabase-js, but
  **cannot run DDL** (`CREATE TABLE`, `ALTER`, `CREATE FUNCTION`/RPC). DDL must hit Postgres directly.

## Two paths (pick one)

### 1. Migration runner from your laptop (tracked, re-runnable)
```bash
DATABASE_URL="postgresql://postgres:PASS@<VPS_IP>:<POSTGRES_PORT>/iadb" \
  node scripts/apply-migrations.mjs
```
- The DB name is **`iadb`** (not `postgres`).
- `PASS` and `POSTGRES_PORT` come from your VPS `.env` / DevOps — never hardcode them in a
  committed file.
- The runner tracks applied migrations, so re-runs are safe.

### 2. SSH + psql (one-off, bypasses tracking)
SSH to your Postgres LXC/container and:
```bash
docker exec -i supabase-db psql -U postgres -d iadb < migration.sql
```

## Rules
- **Apply it yourself** via the tooling — don't just print SSH commands for the user.
- Credentials come from `.env` / DevOps; **never commit a password**.
- After applying, verify the object exists (`\d table`, or a probe query via Kong).
- After applying any RPC, run `NOTIFY pgrst, 'reload schema'` so PostgREST picks it up immediately.
- Note in a report or commit message which migration was applied and when, if it's load-bearing.

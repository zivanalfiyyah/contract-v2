// One-time migration: copy an existing SQLite app.db into the Postgres
// database configured via DATABASE_URL. Run once when moving an existing
// installation from the old SQLite backend to the new Postgres one:
//
//   npx tsx migrate-to-postgres.ts
//
// Safe to re-run: it wipes and re-inserts every row into Postgres each time
// (idempotent), so a failed/interrupted run can just be re-run from
// scratch. It does NOT touch or delete app.db — the SQLite file is only
// read, never written.
import Database from "better-sqlite3";
import { Pool } from "pg";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";

dotenv.config();

const DB_PATH = path.join(process.cwd(), "app.db");
const DATABASE_URL = process.env.DATABASE_URL;

interface ColSpec { table: string; key: string; }
const COLLECTIONS: ColSpec[] = [
  { table: "tenants", key: "id" },
  { table: "users", key: "id" },
  { table: "clauses", key: "id" },
  { table: "variables", key: "key" },
  { table: "templates", key: "id" },
  { table: "contracts", key: "id" },
  { table: "versions", key: "id" },
  { table: "audits", key: "id" },
  { table: "notifications", key: "id" },
  { table: "employees", key: "id" },
  { table: "vendors", key: "id" },
  { table: "clause_comments", key: "id" },
  { table: "push_subscriptions", key: "id" },
  { table: "sub_folders", key: "id" },
];

async function main() {
  if (!DATABASE_URL) {
    console.error("DATABASE_URL is not set (check .env). Aborting.");
    process.exit(1);
  }
  if (!fs.existsSync(DB_PATH)) {
    console.error(`No app.db found at ${DB_PATH} — nothing to migrate.`);
    process.exit(1);
  }

  const sqlite = new Database(DB_PATH, { readonly: true });
  const pool = new Pool({ connectionString: DATABASE_URL, max: 5 });

  console.log("Connecting to Postgres and creating schema...");
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, data JSONB NOT NULL, seq BIGSERIAL);
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, data JSONB NOT NULL, seq BIGSERIAL);
      CREATE TABLE IF NOT EXISTS clauses (id TEXT PRIMARY KEY, data JSONB NOT NULL, seq BIGSERIAL);
      CREATE TABLE IF NOT EXISTS variables (key TEXT PRIMARY KEY, data JSONB NOT NULL, seq BIGSERIAL);
      CREATE TABLE IF NOT EXISTS templates (id TEXT PRIMARY KEY, data JSONB NOT NULL, seq BIGSERIAL);
      CREATE TABLE IF NOT EXISTS contracts (id TEXT PRIMARY KEY, data JSONB NOT NULL, seq BIGSERIAL);
      CREATE TABLE IF NOT EXISTS versions (id TEXT PRIMARY KEY, data JSONB NOT NULL, seq BIGSERIAL);
      CREATE TABLE IF NOT EXISTS audits (id TEXT PRIMARY KEY, data JSONB NOT NULL, seq BIGSERIAL);
      CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, data JSONB NOT NULL, seq BIGSERIAL);
      CREATE TABLE IF NOT EXISTS employees (id TEXT PRIMARY KEY, data JSONB NOT NULL, seq BIGSERIAL);
      CREATE TABLE IF NOT EXISTS vendors (id TEXT PRIMARY KEY, data JSONB NOT NULL, seq BIGSERIAL);
      CREATE TABLE IF NOT EXISTS clause_comments (id TEXT PRIMARY KEY, data JSONB NOT NULL, seq BIGSERIAL);
      CREATE TABLE IF NOT EXISTS push_subscriptions (id TEXT PRIMARY KEY, data JSONB NOT NULL, seq BIGSERIAL);
      CREATE TABLE IF NOT EXISTS sub_folders (id TEXT PRIMARY KEY, data JSONB NOT NULL, seq BIGSERIAL);
      CREATE TABLE IF NOT EXISTS categories (
        "tenantId" TEXT NOT NULL, name TEXT NOT NULL, sort_order INTEGER NOT NULL,
        PRIMARY KEY ("tenantId", name)
      );
      CREATE TABLE IF NOT EXISTS settings ("tenantId" TEXT PRIMARY KEY, data JSONB NOT NULL);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users ((data->>'email'));
      CREATE INDEX IF NOT EXISTS idx_users_tenant ON users ((data->>'tenantId'));
      CREATE INDEX IF NOT EXISTS idx_clauses_tenant ON clauses ((data->>'tenantId'));
      CREATE INDEX IF NOT EXISTS idx_templates_tenant ON templates ((data->>'tenantId'));
      CREATE INDEX IF NOT EXISTS idx_contracts_tenant ON contracts ((data->>'tenantId'));
      CREATE INDEX IF NOT EXISTS idx_contracts_status ON contracts ((data->>'status'));
      CREATE INDEX IF NOT EXISTS idx_contracts_enddate ON contracts ((data->>'endDate'));
      CREATE INDEX IF NOT EXISTS idx_versions_contract ON versions ((data->>'contractId'));
      CREATE INDEX IF NOT EXISTS idx_audits_tenant ON audits ((data->>'tenantId'));
      CREATE INDEX IF NOT EXISTS idx_clause_comments_contract ON clause_comments ((data->>'contractId'));
      CREATE INDEX IF NOT EXISTS idx_clause_comments_tenant ON clause_comments ((data->>'tenantId'));
      CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions ((data->>'userId'));
      CREATE INDEX IF NOT EXISTS idx_subfolders_tenant_category ON sub_folders ((data->>'tenantId'), (data->>'category'));
    `);
  } finally {
    client.release();
  }

  const summary: Record<string, number> = {};

  for (const spec of COLLECTIONS) {
    const rows = sqlite.prepare(`SELECT "${spec.key}" AS id, data FROM ${spec.table} ORDER BY rowid ASC`).all() as { id: string; data: string }[];
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`DELETE FROM ${spec.table}`); // idempotent re-run
      for (const row of rows) {
        await c.query(
          `INSERT INTO ${spec.table} ("${spec.key}", data) VALUES ($1, $2::jsonb)`,
          [row.id, row.data],
        );
      }
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    } finally {
      c.release();
    }
    summary[spec.table] = rows.length;
    console.log(`  ${spec.table}: ${rows.length} rows`);
  }

  // categories
  const catRows = sqlite.prepare(`SELECT tenantId, name, sort_order FROM categories ORDER BY tenantId, sort_order ASC`).all() as { tenantId: string; name: string; sort_order: number }[];
  {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("DELETE FROM categories");
      for (const r of catRows) {
        await c.query(`INSERT INTO categories ("tenantId", name, sort_order) VALUES ($1, $2, $3)`, [r.tenantId, r.name, r.sort_order]);
      }
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    } finally {
      c.release();
    }
  }
  console.log(`  categories: ${catRows.length} rows`);

  // settings
  const settingsRows = sqlite.prepare(`SELECT tenantId, data FROM settings`).all() as { tenantId: string; data: string }[];
  {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("DELETE FROM settings");
      for (const r of settingsRows) {
        await c.query(`INSERT INTO settings ("tenantId", data) VALUES ($1, $2::jsonb)`, [r.tenantId, r.data]);
      }
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    } finally {
      c.release();
    }
  }
  console.log(`  settings: ${settingsRows.length} rows`);

  // meta
  const metaRows = sqlite.prepare(`SELECT k, v FROM meta`).all() as { k: string; v: string }[];
  {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      for (const r of metaRows) {
        await c.query(
          `INSERT INTO meta (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = excluded.v`,
          [r.k, r.v],
        );
      }
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    } finally {
      c.release();
    }
  }
  console.log(`  meta: ${metaRows.length} rows`);

  sqlite.close();
  await pool.end();

  console.log("\nMigration complete. Row counts copied to Postgres:");
  console.log(JSON.stringify({ ...summary, categories: catRows.length, settings: settingsRows.length, meta: metaRows.length }, null, 2));
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});

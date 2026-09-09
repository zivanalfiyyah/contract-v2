import { Pool, PoolClient } from "pg";
import bcrypt from "bcryptjs";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { logger } from "./logger.js";

// ES module imports execute before the importing module's own top-level code
// (server.ts's `dotenv.config()` runs too late for this file), so this must
// load its own .env — otherwise process.env.DATABASE_URL always reads as
// unset here even when a real one is configured. Same issue/fix as auth.ts.
dotenv.config();

// Postgres persistence layer — multi-tenant, with an in-memory cache and
// row-level incremental writes. This replaced the original SQLite (WAL
// mode, single-file) backend so the app can run against multiple server
// instances / survive redeploys on platforms with ephemeral disks.
//
//  - Whole dataset lives in memory (contract metadata is small); loadDB()
//    serves from cache without touching the network. A single Node process
//    stays coherent because every write updates `cache` synchronously.
//  - saveDB() is called synchronously everywhere in server.ts (it never
//    awaits the result), so it can't itself be async without changing ~100
//    call sites. Instead it updates the in-memory cache immediately (so a
//    loadDB() right after a saveDB() in the same request sees fresh data,
//    same guarantee as before) and queues the actual Postgres write onto a
//    serialized promise chain that runs in the background. This trades a
//    small durability window (a crash between saveDB() and the queued write
//    landing could lose that last write) for zero changes to business
//    logic — acceptable for this app's scale; errors are logged loudly
//    rather than swallowed.
//  - Every business record carries a tenantId; categories & settings are
//    stored per tenant. Endpoints (server.ts) scope reads/writes by the
//    logged-in user's tenant.

export const DEFAULT_TENANT_ID = "t-01";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    "[db] DATABASE_URL is required (Postgres connection string). " +
      "Example: postgresql://user:pass@host/dbname?sslmode=require",
  );
}

// Exported so the Smart DCS module (normalized tables + transactional invariants)
// can run direct parameterized/transactional queries. The loadDB()/saveDB()
// JSONB-blob abstraction is deliberately NOT used by DCS — its ISO guarantees
// (single-effective version, atomic supersession, scope-isolated numbering)
// require real relational constraints and transactions on this same pool.
export const pool = new Pool({ connectionString: DATABASE_URL, max: 10 });
pool.on("error", (err) => {
  // Fires for idle-client errors (e.g. the server closing a connection) —
  // must be handled or an unhandled 'error' event crashes the whole process.
  logger.error({ err }, "Unexpected Postgres pool error on an idle client");
});

const LEGACY_JSON_PATH = path.join(process.cwd(), "database.json");

interface ColSpec { table: string; key: string; prop: string; }
const COLLECTIONS: ColSpec[] = [
  { table: "tenants", key: "id", prop: "tenants" },
  { table: "users", key: "id", prop: "users" },
  { table: "clauses", key: "id", prop: "clauses" },
  { table: "variables", key: "key", prop: "variables" },
  { table: "templates", key: "id", prop: "templates" },
  { table: "contracts", key: "id", prop: "contracts" },
  { table: "versions", key: "id", prop: "versions" },
  { table: "audits", key: "id", prop: "audits" },
  { table: "notifications", key: "id", prop: "notifications" },
  { table: "employees", key: "id", prop: "employees" },
  { table: "vendors", key: "id", prop: "vendors" },
  { table: "clause_comments", key: "id", prop: "clauseComments" },
  { table: "push_subscriptions", key: "id", prop: "pushSubscriptions" },
  { table: "sub_folders", key: "id", prop: "subFolders" },
  { table: "internal_docs", key: "id", prop: "internalDocs" },
  // Counter penomoran kontrak yang persisten & tahan-hapus (satu record per
  // scope: "<tenant>|<category>|<docType>|<year>"). Terpisah dari koleksi
  // contracts supaya menghapus kontrak tidak menggeser nomor berikutnya.
  { table: "number_counters", key: "id", prop: "numberCounters" },
  // Anggaran per kategori/departemen/tahun — dibandingkan dengan total nilai
  // kontrak aktual di panel Anggaran vs Nilai Kontrak.
  { table: "budgets", key: "id", prop: "budgets" },
];

// --- Schema bootstrap ---------------------------------------------------
async function bootstrapSchema(client: PoolClient) {
  // Every collection table gets a `seq BIGSERIAL` so hydration can order
  // rows by insertion order — matching SQLite's implicit `rowid` ordering
  // that the original backend relied on (list order matters in the UI for
  // things like the clause library and employee/vendor lists, which are
  // rendered in array order with no explicit re-sort).
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
    CREATE TABLE IF NOT EXISTS internal_docs (id TEXT PRIMARY KEY, data JSONB NOT NULL, seq BIGSERIAL);
    CREATE TABLE IF NOT EXISTS number_counters (id TEXT PRIMARY KEY, data JSONB NOT NULL, seq BIGSERIAL);
    CREATE TABLE IF NOT EXISTS budgets (id TEXT PRIMARY KEY, data JSONB NOT NULL, seq BIGSERIAL);
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
    DROP INDEX IF EXISTS idx_contracts_signtoken; -- sisa fitur TTD eksternal yang sudah dihapus
    CREATE INDEX IF NOT EXISTS idx_versions_contract ON versions ((data->>'contractId'));
    CREATE INDEX IF NOT EXISTS idx_audits_tenant ON audits ((data->>'tenantId'));
    CREATE INDEX IF NOT EXISTS idx_clause_comments_contract ON clause_comments ((data->>'contractId'));
    CREATE INDEX IF NOT EXISTS idx_clause_comments_tenant ON clause_comments ((data->>'tenantId'));
    CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions ((data->>'userId'));
    CREATE INDEX IF NOT EXISTS idx_subfolders_tenant_category ON sub_folders ((data->>'tenantId'), (data->>'category'));
    CREATE INDEX IF NOT EXISTS idx_internal_docs_tenant ON internal_docs ((data->>'tenantId'));
    CREATE INDEX IF NOT EXISTS idx_budgets_tenant ON budgets ((data->>'tenantId'));
  `);
}

// --- In-memory cache + row-level diff tracking --------------------------
const rowCache = new Map<string, Map<string, string>>();
let categoriesSnapshot = "";
let settingsSnapshot = new Map<string, string>();
let cache: any | null = null;
let writeChain: Promise<void> = Promise.resolve();

async function hydrateFromPostgres(): Promise<any> {
  const data: any = { categoriesByTenant: {}, settingsByTenant: {} };
  for (const spec of COLLECTIONS) {
    const { rows } = await pool.query(`SELECT "${spec.key}" AS id, data FROM ${spec.table} ORDER BY seq ASC`);
    data[spec.prop] = rows.map((r) => r.data);
    rowCache.set(spec.table, new Map(rows.map((r) => [String(r.id), JSON.stringify(r.data)])));
  }

  const catRows = (await pool.query(`SELECT "tenantId", name FROM categories ORDER BY "tenantId", sort_order ASC`)).rows;
  for (const r of catRows) {
    (data.categoriesByTenant[r.tenantId] ||= []).push(r.name);
  }
  categoriesSnapshot = JSON.stringify(data.categoriesByTenant);

  const settingsRows = (await pool.query(`SELECT "tenantId", data FROM settings`)).rows;
  settingsSnapshot = new Map();
  for (const r of settingsRows) {
    data.settingsByTenant[r.tenantId] = r.data;
    settingsSnapshot.set(r.tenantId, JSON.stringify(r.data));
  }

  const newestFirst = (field: string) => (a: any, b: any) =>
    String(b[field] || "").localeCompare(String(a[field] || ""));
  data.audits.sort(newestFirst("timestamp"));
  data.notifications.sort(newestFirst("createdAt"));
  return data;
}

async function persistCollection(client: PoolClient, spec: ColSpec, items: any[]) {
  const prev = rowCache.get(spec.table) ?? new Map<string, string>();
  const next = new Map<string, string>();
  for (const item of items) {
    const id = String(item[spec.key]);
    const json = JSON.stringify(item);
    next.set(id, json);
    if (prev.get(id) !== json) {
      await client.query(
        `INSERT INTO ${spec.table} ("${spec.key}", data) VALUES ($1, $2::jsonb)
         ON CONFLICT ("${spec.key}") DO UPDATE SET data = excluded.data`,
        [id, json],
      );
    }
    prev.delete(id);
  }
  for (const removedId of prev.keys()) {
    await client.query(`DELETE FROM ${spec.table} WHERE "${spec.key}" = $1`, [removedId]);
  }
  rowCache.set(spec.table, next);
}

async function persistToPostgres(data: any) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const spec of COLLECTIONS) {
      await persistCollection(client, spec, data[spec.prop] || []);
    }

    const catJson = JSON.stringify(data.categoriesByTenant || {});
    if (catJson !== categoriesSnapshot) {
      await client.query("DELETE FROM categories");
      for (const [tid, names] of Object.entries(data.categoriesByTenant || {})) {
        let i = 0;
        for (const name of names as string[]) {
          await client.query(
            `INSERT INTO categories ("tenantId", name, sort_order) VALUES ($1, $2, $3)`,
            [tid, name, i++],
          );
        }
      }
      categoriesSnapshot = catJson;
    }

    const nextSettings = new Map<string, string>();
    for (const [tid, obj] of Object.entries(data.settingsByTenant || {})) {
      const json = JSON.stringify(obj);
      nextSettings.set(tid, json);
      if (settingsSnapshot.get(tid) !== json) {
        await client.query(
          `INSERT INTO settings ("tenantId", data) VALUES ($1, $2::jsonb)
           ON CONFLICT ("tenantId") DO UPDATE SET data = excluded.data`,
          [tid, json],
        );
      }
      settingsSnapshot.delete(tid);
    }
    for (const removedTid of settingsSnapshot.keys()) {
      await client.query(`DELETE FROM settings WHERE "tenantId" = $1`, [removedTid]);
    }
    settingsSnapshot = nextSettings;

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export function loadDB() {
  if (!cache) throw new Error("[db] loadDB() called before initDB() finished hydrating — this is a bootstrap ordering bug.");
  return cache;
}

export function saveDB(data: any) {
  cache = data;
  // Serialize writes so concurrent saveDB() calls persist in the order they
  // were made, and one failed write doesn't break every write after it.
  writeChain = writeChain
    .then(() => persistToPostgres(data))
    .catch((err) => {
      logger.error({ err }, "Postgres persistence failed for a saveDB() call — in-memory state may now be ahead of the database until the next successful write");
    });
}

// Exposed only for graceful shutdown / the standalone migration script.
export async function flushPendingWrites(): Promise<void> {
  await writeChain;
}

async function getMeta(k: string): Promise<string | null> {
  const { rows } = await pool.query(`SELECT v FROM meta WHERE k = $1`, [k]);
  return rows[0]?.v ?? null;
}
async function setMeta(k: string, v: string) {
  await pool.query(
    `INSERT INTO meta (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = excluded.v`,
    [k, v],
  );
}

// Default users seeded for every install / migration. Passwords are the
// documented defaults that operators MUST change after first login.
export function makeDefaultUsers(): any[] {
  const now = new Date().toISOString();
  const mk = (id: string, tenantId: string, name: string, email: string, role: string, pw: string) => ({
    id, tenantId, name, email, role, active: true, createdAt: now,
    passwordHash: bcrypt.hashSync(pw, 10),
  });
  return [
    // Operator sistem (lintas perusahaan)
    mk("usr-super", DEFAULT_TENANT_ID, "Super Admin", "superadmin@clm.app", "super_admin", "SuperAdmin#2026"),
    // Perusahaan default (PT Semesta Digital Terpadu)
    mk("usr-admin", DEFAULT_TENANT_ID, "Admin Perusahaan", "admin@semesta.co", "admin", "Admin#2026"),
    mk("usr-legal", DEFAULT_TENANT_ID, "Siti Rahma", "legal@semesta.co", "legal", "Legal#2026"),
    mk("usr-manager", DEFAULT_TENANT_ID, "Budi Santoso", "manager@semesta.co", "manager", "Manager#2026"),
    mk("usr-staff", DEFAULT_TENANT_ID, "Ahmad GA", "staff@semesta.co", "staff", "Staff#2026"),
  ];
}

function defaultTenantRecord(): any {
  return { id: DEFAULT_TENANT_ID, name: "PT Semesta Digital Terpadu", branch: "Jakarta Pusat", active: true, createdAt: new Date().toISOString() };
}

/**
 * Initializes the database on startup:
 *  - already has data → hydrate cache from Postgres as-is
 *  - empty Postgres → seed business defaults (seedFn) + default tenant & users
 *    (optionally importing an even older legacy database.json, same as the
 *    original SQLite bootstrap did)
 * seedFn() must return business data with clauseCategories + settings flat
 * for the default tenant (they are wrapped per-tenant here).
 */
export async function initDB(seedFn: () => any) {
  const client = await pool.connect();
  try {
    await bootstrapSchema(client);
  } finally {
    client.release();
  }

  const { rows } = await pool.query(`SELECT COUNT(*)::int AS c FROM tenants`);
  if (rows[0].c > 0) {
    cache = await hydrateFromPostgres();
    await setMeta("schema_version", "2");
    logger.info("Loaded existing Postgres database");
    return;
  }

  // Fresh install: optionally import an even older legacy database.json.
  let seed: any;
  if (fs.existsSync(LEGACY_JSON_PATH)) {
    try {
      seed = JSON.parse(fs.readFileSync(LEGACY_JSON_PATH, "utf-8"));
      logger.info("Imported legacy database.json for fresh multi-tenant seed");
    } catch { seed = seedFn(); }
  } else {
    seed = seedFn();
  }

  for (const key of ["clauses", "variables", "templates", "contracts", "versions", "audits", "notifications", "employees", "vendors", "clauseComments", "pushSubscriptions", "internalDocs"]) {
    for (const item of seed[key] || []) if (!item.tenantId) item.tenantId = DEFAULT_TENANT_ID;
  }
  seed.tenants = [defaultTenantRecord()];
  seed.users = makeDefaultUsers();
  seed.categoriesByTenant = { [DEFAULT_TENANT_ID]: seed.clauseCategories || [] };
  seed.settingsByTenant = { [DEFAULT_TENANT_ID]: seed.settings || {} };
  delete seed.clauseCategories;
  delete seed.settings;

  cache = seed;
  await persistToPostgres(seed);
  await setMeta("schema_version", "2");
  logger.info("Seeded new multi-tenant Postgres database");
}

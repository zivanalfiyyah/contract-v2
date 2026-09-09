import dotenv from "dotenv";
dotenv.config();
import { pool } from "../db";
import { initDcsSchema } from "../dcs/schema";
import { createDcsClause, listDcsClauses, updateDcsClause, deactivateDcsClause } from "../dcs/repo";

const TENANT = "t-dcs-clause-test-" + Date.now();
let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

async function cleanup() {
  await pool.query(`DELETE FROM dcs_clauses WHERE tenant_id = $1`, [TENANT]);
}

async function main() {
  await initDcsSchema(pool);

  const c1 = await createDcsClause(pool, { tenantId: TENANT, title: "Definisi Cuti", content: "Cuti adalah...", category: "HRD", applicableDocTypeCodes: ["SOP", "POL"], isMandatory: true, tags: ["cuti"], createdBy: "u1" });
  check("clause created with correct fields", c1.title === "Definisi Cuti" && c1.isMandatory === true && c1.applicableDocTypeCodes.length === 2);

  const c2 = await createDcsClause(pool, { tenantId: TENANT, title: "Klausul Umum", content: "Berlaku untuk semua...", category: "General", createdBy: "u1" });
  check("clause with no scoping applies to all types (empty array)", c2.applicableDocTypeCodes.length === 0);

  const forSop = await listDcsClauses(pool, TENANT, { docTypeCode: "SOP" });
  check("SOP-scoped query returns both the SOP-scoped clause and the unscoped one", forSop.length === 2, `got ${forSop.length}`);

  const forMemo = await listDcsClauses(pool, TENANT, { docTypeCode: "MEMO" });
  check("MEMO-scoped query excludes the SOP/POL-only clause but includes unscoped", forMemo.length === 1 && forMemo[0].id === c2.id, `got ${forMemo.map(c => c.title)}`);

  const updated = await updateDcsClause(pool, TENANT, c1.id, { title: "Definisi Cuti Tahunan" });
  check("update persists", updated?.title === "Definisi Cuti Tahunan");

  await deactivateDcsClause(pool, TENANT, c1.id);
  const afterDeactivate = await listDcsClauses(pool, TENANT);
  check("deactivated clause no longer listed", afterDeactivate.length === 1 && afterDeactivate[0].id === c2.id);

  // Tenant isolation
  const otherTenant = await listDcsClauses(pool, "t-some-other-tenant");
  check("different tenant sees none of these clauses", otherTenant.length === 0);

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
}

main()
  .then(cleanup)
  .then(() => pool.end())
  .then(() => process.exit(fail === 0 ? 0 : 1))
  .catch(async (err) => { console.error("TEST CRASHED:", err); await cleanup().catch(() => {}); await pool.end(); process.exit(1); });

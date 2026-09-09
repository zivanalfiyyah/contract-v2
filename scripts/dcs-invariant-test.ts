/**
 * Integration test for the Smart DCS ISO invariants, run against the REAL
 * (Neon) database. Uses a throwaway tenant id so it never touches real data,
 * and cleans up after itself. Run: npx tsx scripts/dcs-invariant-test.ts
 */
import dotenv from "dotenv";
dotenv.config();
import { pool } from "../db";
import { initDcsSchema } from "../dcs/schema";
import { ensureTenantDefaults, createDocumentWithFirstVersion, createNextVersion, setVersionStatus, attachCleanFile } from "../dcs/repo";
import { promoteVersionToEffective } from "../dcs/obsolete-engine";

const TENANT = "t-dcs-test-" + Date.now();
let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

async function cleanup() {
  // Children cascade from dcs_documents; also clear rules/types/sequences.
  await pool.query(`DELETE FROM dcs_documents WHERE tenant_id = $1`, [TENANT]);
  await pool.query(`DELETE FROM dcs_number_sequences WHERE tenant_id = $1`, [TENANT]);
  await pool.query(`DELETE FROM dcs_numbering_rules WHERE tenant_id = $1`, [TENANT]);
  await pool.query(`DELETE FROM dcs_document_types WHERE tenant_id = $1`, [TENANT]);
}

async function main() {
  await initDcsSchema(pool);
  await ensureTenantDefaults(pool, TENANT);

  // --- 1. Numbering + scope isolation ---
  const d1 = await createDocumentWithFirstVersion(pool, { tenantId: TENANT, docTypeCode: "SOP", department: "HRD", title: "SOP A", ownerUserId: "u1", createdBy: "u1" });
  const d2 = await createDocumentWithFirstVersion(pool, { tenantId: TENANT, docTypeCode: "SOP", department: "HRD", title: "SOP B", ownerUserId: "u1", createdBy: "u1" });
  const year = new Date().getFullYear();
  check("numbering mask renders", d1.documentNumber === `SOP/HRD/${year}/0001`, `got ${d1.documentNumber}`);
  check("sequence increments within same scope", d2.documentNumber === `SOP/HRD/${year}/0002`, `got ${d2.documentNumber}`);

  const d3 = await createDocumentWithFirstVersion(pool, { tenantId: TENANT, docTypeCode: "SOP", department: "GA", title: "SOP C", ownerUserId: "u1", createdBy: "u1" });
  check("scope isolation resets counter for new department", d3.documentNumber === `SOP/GA/${year}/0001`, `got ${d3.documentNumber}`);

  const d4 = await createDocumentWithFirstVersion(pool, { tenantId: TENANT, docTypeCode: "IK", department: "HRD", title: "IK A", ownerUserId: "u1", createdBy: "u1" });
  check("scope isolation resets counter for new doc type", d4.documentNumber === `IK/HRD/${year}/0001`, `got ${d4.documentNumber}`);

  // --- 2. Version numbering: revisi vs terbitan ---
  const rev = await createNextVersion(pool, { tenantId: TENANT, documentId: d1.documentId, bump: "revisi", createdBy: "u1" });
  check("revisi bumps minor", rev.major_version === 1 && rev.minor_version === 1, `got T${rev.major_version} R${rev.minor_version}`);
  const terb = await createNextVersion(pool, { tenantId: TENANT, documentId: d1.documentId, bump: "terbitan", createdBy: "u1" });
  check("terbitan bumps major AND resets minor to 0", terb.major_version === 2 && terb.minor_version === 0, `got T${terb.major_version} R${terb.minor_version}`);

  // --- 3. State machine guards ---
  let illegalBlocked = false;
  try { await setVersionStatus(pool, { tenantId: TENANT, versionId: d1.versionId, to: "effective" }); }
  catch { illegalBlocked = true; }
  check("illegal transition draft→effective is blocked", illegalBlocked);

  // --- 4. Auto-Obsolete engine (atomic) ---
  // Promote v1.0 to effective (draft→under_review→approved→effective).
  await setVersionStatus(pool, { tenantId: TENANT, versionId: d1.versionId, to: "under_review" });
  await setVersionStatus(pool, { tenantId: TENANT, versionId: d1.versionId, to: "approved" });
  const p1 = await promoteVersionToEffective(pool, { tenantId: TENANT, documentId: d1.documentId, targetVersionId: d1.versionId, actorId: "u1" });
  check("first version becomes effective", !!p1.effectiveAt);
  check("no prior version to supersede on first promotion", p1.supersededVersionId === null);

  // Promote the terbitan (v2.0) — must auto-supersede v1.0 atomically.
  await setVersionStatus(pool, { tenantId: TENANT, versionId: terb.id, to: "under_review" });
  await setVersionStatus(pool, { tenantId: TENANT, versionId: terb.id, to: "approved" });
  const p2 = await promoteVersionToEffective(pool, { tenantId: TENANT, documentId: d1.documentId, targetVersionId: terb.id, actorId: "u1" });
  check("promoting new version auto-supersedes the old effective one", p2.supersededVersionId === d1.versionId, `got ${p2.supersededVersionId}`);

  // Verify exactly ONE effective version now, and the old one is superseded.
  const eff = await pool.query(`SELECT id, status FROM dcs_document_versions WHERE document_id = $1 AND status = 'effective'`, [d1.documentId]);
  check("exactly one effective version remains", eff.rowCount === 1 && eff.rows[0].id === terb.id);
  const old = await pool.query(`SELECT status, superseded_at, effective_at FROM dcs_document_versions WHERE id = $1`, [d1.versionId]);
  check("old version is now superseded", old.rows[0].status === "superseded");

  // The "exact millisecond" boundary: old.superseded_at == new.effective_at.
  const neu = await pool.query(`SELECT effective_at FROM dcs_document_versions WHERE id = $1`, [terb.id]);
  check("supersession timestamp equals new effective timestamp (atomic cutover)",
    new Date(old.rows[0].superseded_at).getTime() === new Date(neu.rows[0].effective_at).getTime(),
    `old.superseded_at=${old.rows[0].superseded_at} new.effective_at=${neu.rows[0].effective_at}`);

  // --- 5. Partial unique index backstop (raw insert of 2nd effective must fail) ---
  let indexBlocked = false;
  try {
    await pool.query(
      `INSERT INTO dcs_document_versions (tenant_id, document_id, major_version, minor_version, status, created_by)
       VALUES ($1,$2, 9, 9, 'effective', 'u1')`, [TENANT, d1.documentId]);
  } catch { indexBlocked = true; }
  check("DB physically rejects a second effective version (partial unique index)", indexBlocked);

  // --- 6. attachCleanFile + sha ---
  await attachCleanFile(pool, { tenantId: TENANT, versionId: terb.id, s3Key: "dcs-test.pdf", sha256: "a".repeat(64), sizeBytes: 100, mimeType: "application/pdf" });
  const file = await pool.query(`SELECT clean_file_sha256 FROM dcs_document_versions WHERE id = $1`, [terb.id]);
  check("clean file metadata attaches", file.rows[0].clean_file_sha256 === "a".repeat(64));

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
}

main()
  .then(cleanup)
  .then(() => pool.end())
  .then(() => process.exit(fail === 0 ? 0 : 1))
  .catch(async (err) => { console.error("TEST CRASHED:", err); await cleanup().catch(() => {}); await pool.end(); process.exit(1); });

import type { Pool, PoolClient } from "pg";
import { withTransaction } from "./db-tx.js";
import { generateDocumentNumber, previewDocumentNumber, releaseSequence, type NumberingRule } from "./numbering.js";
import { nextVersionNumber, type VersionBump, type VersionStatus } from "./state-machine.js";
import { loadDB } from "../db.js";

export interface DocTypeSection { heading: string; content: string }
// roleName: nama jabatan spesifik (mis. "HED Manager"), TERPISAH dari role
// (gerbang izin platform kasar) — cermin SignatureColumn di dcs/pdf-compose.ts
// (deklarasi terpisah dgn sengaja, lihat komentar "DB-independent" di file
// itu — bukan diimpor lintas modul, tapi harus tetap sinkron strukturnya).
// assignedUserId: penunjukan penandatangan SPESIFIK per-dokumen (bukan
// per-jenis-dokumen) — disimpan hanya di snapshot compose sebuah versi, tidak
// pernah di template jenis dokumen. Kosong = jatuh ke gerbang berbasis `role`
// (perilaku lama, mundur-kompatibel). Terisi = HANYA user itu (atau admin)
// yang boleh menandatangani kolom ini. Kolom pertama (Penyusun) otomatis
// diisi id pembuat dokumen.
export interface SignatureColumn { label: string; role: string; roleName?: string; assignedUserId?: string }

// Default ISO 9001 signature sheet: the standard Indonesian company document
// approval row (Dibuat / Diperiksa / Disetujui). `role` matches against the
// approving user's platform role to auto-place their signature in the right
// column; falls back to filling columns left-to-right if no role matches.
const DEFAULT_SIGNATURE_COLUMNS: SignatureColumn[] = [
  { label: "Penyusun", role: "staff" },
  { label: "Mengetahui", role: "manager" },
  { label: "Menyetujui", role: "legal" },
];

interface DefaultDocType {
  code: string; name: string; defaultSections: DocTypeSection[];
  signatureGroups: { heading?: string; columns: SignatureColumn[] }[];
  layoutStyle: "standard" | "memo" | "kebijakan"; letterhead: boolean;
}

// Default ISO document classes + numbering rule seeded per tenant on first use,
// so the module is functional out of the box (DRY: one bootstrap, not per-call).
// Each type carries its own default section TEMPLATE, signature layout, and
// letterhead/style preset — this is what makes "Buat SOP" and "Buat Memo"
// produce genuinely differently structured drafts instead of one blank form.
// The 3 curated layoutStyles + grouped signatures below are deliberately
// modeled on real example documents (SOP/IK = standard trailing 3-column
// sheet; POL = single-signer letterhead policy; MEMO = letterhead with
// grouped "Penyusun:"/"Mengetahui:" 2x2 signature bands) rather than an
// abstract generic layout engine.
const DEFAULT_DOC_TYPES: DefaultDocType[] = [
  {
    code: "SOP", name: "Standard Operating Procedure",
    defaultSections: [
      { heading: "1. Definisi", content: "" },
      { heading: "2. Ketentuan Umum", content: "" },
      { heading: "3. Prosedur / Langkah Kerja", content: "" },
      { heading: "4. Referensi", content: "" },
    ],
    signatureGroups: [{ columns: DEFAULT_SIGNATURE_COLUMNS }],
    layoutStyle: "standard", letterhead: false,
  },
  {
    code: "IK", name: "Instruksi Kerja",
    defaultSections: [
      { heading: "1. Tujuan Instruksi", content: "" },
      { heading: "2. Alat & Bahan", content: "" },
      { heading: "3. Langkah-Langkah", content: "" },
      { heading: "4. Keselamatan Kerja (K3)", content: "" },
    ],
    signatureGroups: [{ columns: DEFAULT_SIGNATURE_COLUMNS }],
    layoutStyle: "standard", letterhead: false,
  },
  {
    code: "POL", name: "Kebijakan / Policy",
    defaultSections: [
      { heading: "1. Latar Belakang", content: "" },
      { heading: "2. Pernyataan Kebijakan", content: "" },
      { heading: "3. Ketentuan & Sanksi", content: "" },
    ],
    signatureGroups: [{ columns: [{ label: "Disetujui oleh", role: "admin" }] }],
    layoutStyle: "kebijakan", letterhead: true,
  },
  {
    code: "MEMO", name: "Internal Memo",
    defaultSections: [{ heading: "Isi Memo", content: "" }],
    signatureGroups: [
      { heading: "Penyusun:", columns: [{ label: "Manager HED", role: "manager" }, { label: "Manager FAT", role: "manager" }] },
      { heading: "Mengetahui:", columns: [{ label: "CAO", role: "legal" }, { label: "CEO", role: "admin" }] },
    ],
    layoutStyle: "memo", letterhead: true,
  },
  {
    code: "STD", name: "Standarisasi",
    defaultSections: [
      { heading: "1. Ruang Lingkup", content: "" },
      { heading: "2. Definisi & Istilah", content: "" },
      { heading: "3. Persyaratan / Kriteria Standar", content: "" },
      { heading: "4. Metode Verifikasi & Pemantauan", content: "" },
      { heading: "5. Referensi Standar", content: "" },
    ],
    signatureGroups: [{ columns: DEFAULT_SIGNATURE_COLUMNS }],
    layoutStyle: "standard", letterhead: false,
  },
];
const DEFAULT_MASK = "{DocType}/{Department}/{Year}/{Sequence:4}";

export async function ensureTenantDefaults(pool: Pool, tenantId: string): Promise<void> {
  await withTransaction(pool, async (client) => {
    for (const dt of DEFAULT_DOC_TYPES) {
      const flatColumns = dt.signatureGroups.flatMap((g) => g.columns);
      const metadata = {
        defaultSections: dt.defaultSections, signatureGroups: dt.signatureGroups,
        signatureColumns: flatColumns, layoutStyle: dt.layoutStyle, letterhead: dt.letterhead,
        defaultLanes: flatColumns.map((c) => c.label), defaultClauseIds: [],
      };
      await client.query(
        `INSERT INTO dcs_document_types (tenant_id, code, name, metadata)
           VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, code) DO NOTHING`,
        [tenantId, dt.code, dt.name, JSON.stringify(metadata)],
      );
      // Backfill the new layoutStyle/letterhead/signatureGroups/defaultLanes
      // keys onto rows seeded by an earlier version of this bootstrap, but
      // ONLY if they haven't been set yet (by this backfill or by a user's
      // own edit) — never clobber a real customization. Existing
      // defaultSections/signatureColumns a user already tailored are left
      // untouched; rowToDocType()'s own back-compat synthesis covers any
      // tenant that never runs this backfill at all.
      await client.query(
        `UPDATE dcs_document_types
            SET metadata = metadata || $3::jsonb, updated_at = now()
          WHERE tenant_id = $1 AND code = $2 AND NOT (metadata ? 'layoutStyle')`,
        [tenantId, dt.code, JSON.stringify({
          signatureGroups: dt.signatureGroups, layoutStyle: dt.layoutStyle, letterhead: dt.letterhead,
          defaultLanes: flatColumns.map((c) => c.label),
        })],
      );
    }
    const existing = await client.query(
      `SELECT id FROM dcs_numbering_rules WHERE tenant_id = $1 AND is_active = TRUE LIMIT 1`,
      [tenantId],
    );
    if (existing.rowCount === 0) {
      await client.query(
        `INSERT INTO dcs_numbering_rules (tenant_id, name, mask, scope_tokens)
           VALUES ($1, 'Default ISO Rule', $2, '["DocType","Department","Year"]'::jsonb)`,
        [tenantId, DEFAULT_MASK],
      );
    }
  });
}

// A signature "band" on the Lembar Pengesahan — an optional heading (e.g.
// "Penyusun:", "Mengetahui:") over a row of columns. Multiple groups let a
// doc type print grouped signers (Internal Memo: 2 groups x 2 columns = 4
// signers) instead of the single flat row the original design assumed.
export interface SignatureGroup { heading?: string; columns: SignatureColumn[] }

// Shared by routes.ts and pdf-compose.ts so the flat approval-matching order
// (used by sign-approve) and the grouped rendering order (used by the PDF
// drawing code) can never disagree about which column is "next".
export function flattenSignatureGroups(groups: SignatureGroup[]): SignatureColumn[] {
  return groups.flatMap((g) => g.columns);
}

// Resolusi kolom TTD dari metadata compose sebuah versi — replika PERSIS dari
// fallback 3-tingkat yang menentukan siapa berikutnya wajib TTD di
// sign-approve (routes.ts): signatureGroups → signatureColumns dibungkus 1
// grup → default satu kolom generik. Dipakai bareng oleh sign-approve
// (menentukan giliran) dan getApprovalRoster (menampilkan siapa masih
// menunggu) — HARUS tetap identik supaya roster tidak pernah berbeda dari
// giliran TTD yang sesungguhnya berlaku.
export function resolveSignatureColumns(compose: Record<string, unknown> | null): SignatureColumn[] {
  const c = compose as { signatureGroups?: SignatureGroup[]; signatureColumns?: SignatureColumn[] } | null;
  const groups: SignatureGroup[] = Array.isArray(c?.signatureGroups) && c!.signatureGroups!.length > 0
    ? c!.signatureGroups!
    : Array.isArray(c?.signatureColumns) && c!.signatureColumns!.length > 0
      ? [{ columns: c!.signatureColumns! }]
      : [{ columns: [{ label: "Disetujui oleh", role: "" }] }];
  return flattenSignatureGroups(groups);
}

export type DocTypeLayoutStyle = "standard" | "memo" | "kebijakan";

export type DocTypeHeaderStyle = "iso" | "simple";

export interface DocTypeRow {
  id: string; code: string; name: string; description: string | null;
  defaultSections: DocTypeSection[];
  signatureColumns: SignatureColumn[];   // derived flat view = signatureGroups.flatMap(g => g.columns) — kept so sign-approve's role-matching never has to change
  signatureGroups: SignatureGroup[];     // source of truth for rendering
  layoutStyle: DocTypeLayoutStyle;
  letterhead: boolean;
  defaultLanes: string[];                // seeds the flow-builder's swimlane actor list
  defaultClauseIds: string[];
  headerStyle: DocTypeHeaderStyle;       // "iso" = kop kotak metadata formal (Page X Of Y); "simple" = header minimalis
  documentLevel: string;                 // "Tingkat Dokumen" untuk header ISO (mis. "Internal")
  processOwner: string;                  // "Pemilik Proses" untuk header ISO (kosong = pakai departemen)
}

function rowToDocType(r: any): DocTypeRow {
  const meta = r.metadata || {};
  const signatureColumnsFlat: SignatureColumn[] = Array.isArray(meta.signatureColumns) && meta.signatureColumns.length > 0
    ? meta.signatureColumns : DEFAULT_SIGNATURE_COLUMNS;
  // Self-healing back-compat: metadata written before signatureGroups existed
  // (or with it empty) is wrapped into one implicit group — visually
  // identical to the old flat single-row sheet, no backfill migration needed.
  const signatureGroups: SignatureGroup[] = Array.isArray(meta.signatureGroups) && meta.signatureGroups.length > 0
    ? meta.signatureGroups : [{ columns: signatureColumnsFlat }];
  const flatFromGroups = signatureGroups.flatMap((g) => g.columns);
  return {
    id: r.id, code: r.code, name: r.name, description: r.description,
    defaultSections: Array.isArray(meta.defaultSections) ? meta.defaultSections : [],
    signatureColumns: flatFromGroups.length > 0 ? flatFromGroups : DEFAULT_SIGNATURE_COLUMNS,
    signatureGroups,
    layoutStyle: (["standard", "memo", "kebijakan"] as const).includes(meta.layoutStyle) ? meta.layoutStyle : "standard",
    letterhead: !!meta.letterhead,
    defaultLanes: Array.isArray(meta.defaultLanes) && meta.defaultLanes.length > 0 ? meta.defaultLanes : flatFromGroups.map((c) => c.label),
    defaultClauseIds: Array.isArray(meta.defaultClauseIds) ? meta.defaultClauseIds : [],
    // Default headerStyle: dokumen Memo = simple, selainnya = iso (kop formal).
    // Self-heal untuk metadata lama yang belum punya key ini.
    headerStyle: meta.headerStyle === "simple" || meta.headerStyle === "iso"
      ? meta.headerStyle
      : (meta.layoutStyle === "memo" ? "simple" : "iso"),
    documentLevel: typeof meta.documentLevel === "string" && meta.documentLevel.trim() ? meta.documentLevel : "Internal",
    processOwner: typeof meta.processOwner === "string" ? meta.processOwner : "",
  };
}

export async function listDocTypes(pool: Pool, tenantId: string): Promise<DocTypeRow[]> {
  const { rows } = await pool.query(
    `SELECT id, code, name, description, metadata FROM dcs_document_types WHERE tenant_id = $1 AND is_active = TRUE ORDER BY created_at ASC`,
    [tenantId],
  );
  return rows.map(rowToDocType);
}

interface DocTypeMutableFields {
  name?: string; description?: string; defaultSections?: DocTypeSection[];
  signatureColumns?: SignatureColumn[]; // legacy flat input — wrapped into one group if signatureGroups isn't supplied
  signatureGroups?: SignatureGroup[];
  layoutStyle?: DocTypeLayoutStyle; letterhead?: boolean;
  defaultLanes?: string[]; defaultClauseIds?: string[];
  headerStyle?: DocTypeHeaderStyle; documentLevel?: string; processOwner?: string;
}

function buildMetadata(patch: DocTypeMutableFields, existing: any = {}): Record<string, unknown> {
  const signatureGroups = patch.signatureGroups
    ?? (patch.signatureColumns ? [{ columns: patch.signatureColumns }] : existing.signatureGroups)
    ?? (existing.signatureColumns ? [{ columns: existing.signatureColumns }] : [{ columns: DEFAULT_SIGNATURE_COLUMNS }]);
  const layoutStyle = patch.layoutStyle ?? existing.layoutStyle ?? "standard";
  return {
    defaultSections: patch.defaultSections ?? existing.defaultSections ?? [],
    signatureGroups,
    signatureColumns: signatureGroups.flatMap((g: SignatureGroup) => g.columns), // kept in sync for any external reader still expecting the flat key
    layoutStyle,
    letterhead: patch.letterhead ?? existing.letterhead ?? false,
    defaultLanes: patch.defaultLanes ?? existing.defaultLanes ?? [],
    defaultClauseIds: patch.defaultClauseIds ?? existing.defaultClauseIds ?? [],
    headerStyle: patch.headerStyle ?? existing.headerStyle ?? (layoutStyle === "memo" ? "simple" : "iso"),
    documentLevel: patch.documentLevel ?? existing.documentLevel ?? "Internal",
    processOwner: patch.processOwner ?? existing.processOwner ?? "",
  };
}

/**
 * Creates a new document class (e.g. "Standarisasi Mutu") with its own section
 * template, grouped signature layout, and letterhead/lane defaults — this is
 * the "jenis dokumen dinamis" the fixed SOP/IK/POL/MEMO set doesn't cover.
 * `code` becomes the {DocType} token in generated control numbers.
 */
export async function createDocType(
  pool: Pool,
  p: { tenantId: string; code: string; name: string; description?: string } & DocTypeMutableFields,
): Promise<DocTypeRow> {
  const { rows } = await pool.query(
    `INSERT INTO dcs_document_types (tenant_id, code, name, description, metadata)
       VALUES ($1,$2,$3,$4,$5)
     RETURNING id, code, name, description, metadata`,
    [p.tenantId, p.code.toUpperCase().replace(/[^A-Z0-9]/g, ""), p.name, p.description ?? null,
     JSON.stringify(buildMetadata(p))],
  );
  return rowToDocType(rows[0]);
}

export async function updateDocType(
  pool: Pool,
  tenantId: string, id: string,
  patch: { name?: string; description?: string } & DocTypeMutableFields,
): Promise<DocTypeRow | null> {
  const current = await pool.query(`SELECT id, code, name, description, metadata FROM dcs_document_types WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  if (current.rowCount === 0) return null;
  const nextMeta = buildMetadata(patch, current.rows[0].metadata || {});
  const { rows } = await pool.query(
    `UPDATE dcs_document_types SET name = COALESCE($1, name), description = COALESCE($2, description), metadata = $3, updated_at = now()
      WHERE id = $4 AND tenant_id = $5
    RETURNING id, code, name, description, metadata`,
    [patch.name ?? null, patch.description ?? null, JSON.stringify(nextMeta), id, tenantId],
  );
  return rowToDocType(rows[0]);
}

export async function deactivateDocType(pool: Pool, tenantId: string, id: string): Promise<void> {
  await pool.query(`UPDATE dcs_document_types SET is_active = FALSE, updated_at = now() WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
}

export async function getDocTypeByCode(pool: Pool, tenantId: string, code: string): Promise<DocTypeRow | null> {
  const { rows } = await pool.query(
    `SELECT id, code, name, description, metadata FROM dcs_document_types WHERE tenant_id = $1 AND code = $2`,
    [tenantId, code],
  );
  return rows[0] ? rowToDocType(rows[0]) : null;
}

// docTypeId terisi → coba pakai rule override jenis dokumen itu dulu, jatuh
// ke rule default tenant (doc_type_id IS NULL) kalau belum ada override.
// docTypeId kosong → langsung ambil default tenant (perilaku lama).
async function activeRule(client: PoolClient, tenantId: string, docTypeId?: string | null): Promise<NumberingRule> {
  const { rows } = await client.query(
    `SELECT id, tenant_id, mask, scope_tokens
       FROM dcs_numbering_rules
      WHERE tenant_id = $1 AND is_active = TRUE AND (doc_type_id = $2 OR doc_type_id IS NULL)
      ORDER BY doc_type_id NULLS LAST LIMIT 1`,
    [tenantId, docTypeId ?? null],
  );
  if (rows.length === 0) throw new Error("No active numbering rule for tenant — call ensureTenantDefaults first");
  const r = rows[0];
  return { id: r.id, tenantId: r.tenant_id, mask: r.mask, scopeTokens: r.scope_tokens };
}

export interface NumberingRuleView extends NumberingRule { isOverride: boolean }

// Tiap jenis dokumen bisa punya rule sendiri (doc_type_id override), atau
// mewarisi rule default tenant (doc_type_id IS NULL) — inilah yang membuat
// "beda jenis dokumen, beda penamaan & no urut" bisa dikonfigurasi per jenis
// tanpa memaksa semua jenis dokumen memakai satu format yang sama.
// isOverride memberi tahu UI apakah nilai ini hasil kustomisasi jenis ini
// atau masih warisan default, supaya toggle "pakai default vs custom" akurat
// tanpa query terpisah. Pool-based (bukan PoolClient) supaya bisa dipanggil
// langsung dari route handler tanpa transaksi, sama seperti listDocTypes dkk.
export async function getActiveNumberingRule(pool: Pool, tenantId: string, docTypeId?: string | null): Promise<NumberingRuleView> {
  const { rows } = await pool.query(
    `SELECT id, tenant_id, mask, scope_tokens, doc_type_id
       FROM dcs_numbering_rules
      WHERE tenant_id = $1 AND is_active = TRUE AND (doc_type_id = $2 OR doc_type_id IS NULL)
      ORDER BY doc_type_id NULLS LAST LIMIT 1`,
    [tenantId, docTypeId ?? null],
  );
  if (rows.length === 0) throw new Error("No active numbering rule for tenant — call ensureTenantDefaults first");
  const r = rows[0];
  return { id: r.id, tenantId: r.tenant_id, mask: r.mask, scopeTokens: r.scope_tokens, isOverride: r.doc_type_id != null };
}

// docTypeId kosong menyunting rule default tenant (perilaku lama, tidak
// berubah). docTypeId terisi meng-upsert rule override milik jenis dokumen
// itu — insert kalau belum ada, update mask-nya kalau sudah. Index parsial
// uq_dcs_numbering_rule_doctype (schema.ts) menjamin maksimal 1 baris
// override per jenis dokumen, jadi ON CONFLICT ini atomik & race-safe.
// scope_tokens override selalu ikut default (["DocType","Department","Year"])
// — sengaja tidak diekspos ke pengguna, cukup mask yang dikustomisasi supaya
// alurnya tetap simple.
export async function updateActiveNumberingRule(
  pool: Pool,
  tenantId: string,
  patch: { mask?: string },
  docTypeId?: string | null,
): Promise<NumberingRuleView> {
  if (docTypeId) {
    const { rows } = await pool.query(
      `INSERT INTO dcs_numbering_rules (tenant_id, name, mask, scope_tokens, doc_type_id)
            VALUES ($1, 'Override', $2, '["DocType","Department","Year"]'::jsonb, $3)
       ON CONFLICT (tenant_id, doc_type_id) WHERE doc_type_id IS NOT NULL
         DO UPDATE SET mask = EXCLUDED.mask, updated_at = now()
       RETURNING id, tenant_id, mask, scope_tokens`,
      [tenantId, patch.mask ?? "", docTypeId],
    );
    const r = rows[0];
    return { id: r.id, tenantId: r.tenant_id, mask: r.mask, scopeTokens: r.scope_tokens, isOverride: true };
  }
  const { rows } = await pool.query(
    `UPDATE dcs_numbering_rules
        SET mask = COALESCE($2, mask), updated_at = now()
      WHERE tenant_id = $1 AND is_active = TRUE AND doc_type_id IS NULL
      RETURNING id, tenant_id, mask, scope_tokens`,
    [tenantId, patch.mask ?? null],
  );
  if (rows.length === 0) throw new Error("No active numbering rule for tenant — call ensureTenantDefaults first");
  const r = rows[0];
  return { id: r.id, tenantId: r.tenant_id, mask: r.mask, scopeTokens: r.scope_tokens, isOverride: false };
}

// Mengembalikan jenis dokumen ke format nomor default tenant (hapus baris
// override-nya). Aman dipanggil walau belum ada override — DELETE 0-baris
// bukan error, cuma no-op. Tidak pernah bisa menghapus rule default (selalu
// doc_type_id IS NULL) karena parameter docTypeId di sini wajib terisi.
export async function removeNumberingRuleOverride(pool: Pool, tenantId: string, docTypeId: string): Promise<void> {
  await pool.query(
    `DELETE FROM dcs_numbering_rules WHERE tenant_id = $1 AND doc_type_id = $2`,
    [tenantId, docTypeId],
  );
}

export interface CreateDocumentInput {
  tenantId: string;
  docTypeCode: string;     // 'SOP'
  department: string;      // 'HRD' — used both as department_id and the {Department} token
  title: string;
  ownerUserId: string;
  createdBy: string;
  // Default 1/0 (a genuinely new document). Overridable so a paper SOP that's
  // already at, say, Revisi 3 can be entered into the system starting at the
  // number it already carries in the real world, instead of confusingly
  // restarting at 1.0 — the uq_dcs_version_triplet constraint still protects
  // against duplicates (a brand-new document's first row can never collide,
  // since no other version of it exists yet).
  initialMajor?: number;
  initialMinor?: number;
  metadata?: Record<string, unknown>;
  // Dokumen UNGGAH PDF murni: nomor diisi BEBAS (dari penerbit/vendor), bukan
  // auto-generate — dan TIDAK mereserve sequence. Kosong = auto seperti biasa.
  manualNumber?: string;
}

// Pratinjau nomor dokumen — dipanggil dari form buat dokumen SEBELUM submit
// (locked-but-visible, sama seperti generate-number di modul Kontrak) memakai
// TOKEN yang identik dgn createDocumentWithFirstVersion di bawah supaya
// preview & nomor final konsisten. Pool-based (read-only, tanpa transaksi) —
// tidak pernah menaikkan counter, lihat komentar peekNextSequence.
export async function previewDocumentNumberForType(
  pool: Pool, tenantId: string, docTypeCode: string, department: string,
): Promise<{ documentNumber: string }> {
  const dt = await getDocTypeByCode(pool, tenantId, docTypeCode);
  if (!dt) throw new Error(`Unknown document type: ${docTypeCode}`);
  const rule = await getActiveNumberingRule(pool, tenantId, dt.id);
  const now = new Date();
  const { documentNumber } = await previewDocumentNumber(pool, rule, {
    DocType: docTypeCode, Department: department,
    Year: now.getFullYear(), Month: now.getMonth() + 1, Day: now.getDate(),
  });
  return { documentNumber };
}

/**
 * Creates a controlled document + its Terbitan 1 Revisi 0 draft in one
 * transaction, generating the control number from the active numbering rule.
 * The number and both rows commit atomically — a failure leaves no orphan.
 */
export async function createDocumentWithFirstVersion(pool: Pool, input: CreateDocumentInput) {
  return withTransaction(pool, async (client) => {
    const dt = await client.query(
      `SELECT id, code FROM dcs_document_types WHERE tenant_id = $1 AND code = $2 AND is_active = TRUE`,
      [input.tenantId, input.docTypeCode],
    );
    if (dt.rowCount === 0) throw new Error(`Unknown document type: ${input.docTypeCode}`);
    const docTypeId = dt.rows[0].id;

    // Nomor: bebas (manual, unggah PDF) ATAU auto-generate dari rule aktif.
    // Manual TIDAK mereserve sequence, jadi urutan dokumen sistem tetap rapi.
    const manual = (input.manualNumber || "").trim();
    let documentNumber: string;
    // Jejak counter — hanya terisi untuk nomor AUTO. Nomor manual tidak pernah
    // mengambil dari counter kita, jadi tidak ada yang bisa dilepas.
    let numberSeq: number | null = null;
    let numberRuleId: string | null = null;
    let numberScopeHash: string | null = null;
    if (manual) {
      documentNumber = manual.slice(0, 80);
    } else {
      const rule = await activeRule(client, input.tenantId, docTypeId);
      const now = new Date();
      const gen = await generateDocumentNumber(client, rule, {
        DocType: input.docTypeCode,
        Department: input.department,
        Year: now.getFullYear(),
        Month: now.getMonth() + 1, // aktifkan token {Month} / {MonthRoman} pada mask DCS
        Day: now.getDate(),
      });
      documentNumber = gen.documentNumber;
      numberSeq = gen.sequence;
      numberRuleId = gen.ruleId;
      numberScopeHash = gen.scopeHash;
    }

    const doc = await client.query(
      `INSERT INTO dcs_documents
         (tenant_id, document_number, doc_type_id, department_id, title, owner_user_id, created_by, metadata,
          number_seq, number_rule_id, number_scope_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id, document_number`,
      [input.tenantId, documentNumber, docTypeId, input.department, input.title,
       input.ownerUserId, input.createdBy, JSON.stringify(input.metadata ?? {}),
       numberSeq, numberRuleId, numberScopeHash],
    );
    const documentId = doc.rows[0].id;

    const ver = await client.query(
      `INSERT INTO dcs_document_versions
         (tenant_id, document_id, major_version, minor_version, status, created_by)
       VALUES ($1,$2,$3,$4,'draft',$5)
       RETURNING id`,
      [input.tenantId, documentId, input.initialMajor ?? 1, input.initialMinor ?? 0, input.createdBy],
    );

    return { documentId, versionId: ver.rows[0].id, documentNumber };
  });
}

/**
 * Creates the next version off the newest existing one.
 *   revisi   → same Terbitan, Revisi + 1
 *   terbitan → Terbitan + 1, Revisi reset to 0
 */
export async function createNextVersion(
  pool: Pool,
  params: {
    tenantId: string; documentId: string; bump: VersionBump; createdBy: string; changeSummary?: string;
    // Manual override for both — a user retyping the Terbitan/Revisi number
    // instead of taking the auto-computed next one (e.g. lining up with a
    // paper trail). uq_dcs_version_triplet catches a collision; we translate
    // that into ErrVersionNumberConflict instead of a raw Postgres error.
    overrideMajor?: number; overrideMinor?: number;
  },
) {
  return withTransaction(pool, async (client) => {
    const newest = await client.query<{ major_version: number; minor_version: number }>(
      `SELECT major_version, minor_version FROM dcs_document_versions
        WHERE document_id = $1 AND tenant_id = $2
        ORDER BY major_version DESC, minor_version DESC LIMIT 1`,
      [params.documentId, params.tenantId],
    );
    if (newest.rowCount === 0) throw new Error("Document has no versions");
    const hasOverride = typeof params.overrideMajor === "number" && typeof params.overrideMinor === "number";
    const next = hasOverride
      ? { major: params.overrideMajor as number, minor: params.overrideMinor as number }
      : nextVersionNumber(
          { major: newest.rows[0].major_version, minor: newest.rows[0].minor_version },
          params.bump,
        );
    try {
      const ver = await client.query(
        `INSERT INTO dcs_document_versions
           (tenant_id, document_id, major_version, minor_version, status, change_summary, created_by)
         VALUES ($1,$2,$3,$4,'draft',$5,$6)
         RETURNING id, major_version, minor_version`,
        [params.tenantId, params.documentId, next.major, next.minor, params.changeSummary ?? null, params.createdBy],
      );
      return ver.rows[0];
    } catch (err: any) {
      if (err?.code === "23505") {
        throw new Error(`ErrVersionNumberConflict: Terbitan ${next.major} Revisi ${next.minor} sudah dipakai untuk dokumen ini. Pilih nomor lain.`);
      }
      throw err;
    }
  });
}

/** Transition a version's status (guarded by the state machine). */
export async function setVersionStatus(
  pool: Pool,
  params: { tenantId: string; versionId: string; to: VersionStatus },
) {
  const { assertTransition } = await import("./state-machine.js");
  return withTransaction(pool, async (client) => {
    const cur = await client.query<{ status: VersionStatus }>(
      `SELECT status FROM dcs_document_versions WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [params.versionId, params.tenantId],
    );
    if (cur.rowCount === 0) throw new Error("Version not found");
    assertTransition(cur.rows[0].status, params.to);
    await client.query(
      `UPDATE dcs_document_versions SET status = $1, updated_at = now() WHERE id = $2 AND tenant_id = $3`,
      [params.to, params.versionId, params.tenantId],
    );
    return { from: cur.rows[0].status, to: params.to };
  });
}

/**
 * Menarik (menonaktifkan) versi Effective tanpa pengganti — dokumen menjadi
 * OBSOLETE permanen. Beda dari promoteVersionToEffective (yang meng-obsolete
 * versi lama KARENA ada versi baru): di sini tidak ada versi baru, sekadar
 * penarikan. Set status=superseded + superseded_at, dan kosongkan
 * current_version_id dokumen (dokumen tak lagi punya versi berlaku). Transisi
 * effective→superseded sudah legal di state-machine, tapi setVersionStatus
 * generik tidak menyetel superseded_at / current_version_id, makanya perlu
 * fungsi khusus ini.
 */
export async function withdrawEffectiveVersion(
  pool: Pool,
  params: { tenantId: string; documentId: string; versionId: string; actorId: string },
) {
  return withTransaction(pool, async (client) => {
    const doc = await client.query(
      `SELECT id FROM dcs_documents WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [params.documentId, params.tenantId],
    );
    if (doc.rowCount === 0) throw new Error(`Document ${params.documentId} not found`);

    const upd = await client.query<{ id: string }>(
      `UPDATE dcs_document_versions
          SET status = 'superseded', superseded_at = now(), updated_at = now()
        WHERE id = $1 AND document_id = $2 AND tenant_id = $3 AND status = 'effective'
        RETURNING id`,
      [params.versionId, params.documentId, params.tenantId],
    );
    if (upd.rowCount === 0) {
      throw new Error("Hanya dokumen berstatus Effective yang bisa dinonaktifkan.");
    }

    await client.query(
      `UPDATE dcs_documents SET current_version_id = NULL, updated_at = now()
        WHERE id = $1 AND tenant_id = $2`,
      [params.documentId, params.tenantId],
    );

    return { documentId: params.documentId, withdrawnVersionId: params.versionId };
  });
}

/** Structured compose content (purpose/scope/sections/flow) is stored in the
 * version's existing `metadata` JSONB column — no schema change needed — so a
 * document composed in-app can be reopened and edited before submission, and
 * a new revision can start from the previous version's content. */
export async function saveComposeMetadata(pool: Pool, tenantId: string, versionId: string, compose: Record<string, unknown>) {
  await pool.query(
    `UPDATE dcs_document_versions SET metadata = jsonb_set(metadata, '{compose}', $1::jsonb), updated_at = now()
      WHERE id = $2 AND tenant_id = $3`,
    [JSON.stringify(compose), versionId, tenantId],
  );
}

export async function getComposeMetadata(pool: Pool, tenantId: string, versionId: string): Promise<Record<string, unknown> | null> {
  const { rows } = await pool.query(
    `SELECT metadata->'compose' AS compose FROM dcs_document_versions WHERE id = $1 AND tenant_id = $2`,
    [versionId, tenantId],
  );
  return rows[0]?.compose ?? null;
}

export async function getVersionCore(pool: Pool, tenantId: string, versionId: string) {
  const { rows } = await pool.query(
    `SELECT v.id, v.document_id, v.status, v.major_version, v.minor_version, d.document_number, d.title, dt.code AS doc_type_code, d.department_id
       FROM dcs_document_versions v
       JOIN dcs_documents d ON d.id = v.document_id
       JOIN dcs_document_types dt ON dt.id = d.doc_type_id
      WHERE v.id = $1 AND v.tenant_id = $2`,
    [versionId, tenantId],
  );
  return rows[0] ?? null;
}

export async function attachCleanFile(
  pool: Pool,
  params: { tenantId: string; versionId: string; s3Key: string; sha256: string; sizeBytes: number; mimeType: string },
) {
  await pool.query(
    `UPDATE dcs_document_versions
        SET clean_file_s3_key = $1, clean_file_sha256 = $2, file_size_bytes = $3, mime_type = $4, updated_at = now()
      WHERE id = $5 AND tenant_id = $6`,
    [params.s3Key, params.sha256, params.sizeBytes, params.mimeType, params.versionId, params.tenantId],
  );
}

/**
 * Lepas nomor dokumen DCS supaya dipakai dokumen berikutnya (dokumen batal
 * terbit). Nomornya dikosongkan dari dokumen, dokumennya sendiri TIDAK dihapus
 * — sesuai prinsip ISO 9001 di modul ini (dokumen di-supersede, bukan dihapus).
 *
 * Pengaman sengaja lebih ketat daripada sisi kontrak, karena dokumen terkontrol
 * yang sudah beredar/ditandatangani tidak boleh bernomor sama dengan dokumen
 * lain: hanya boleh kalau SELURUH versi masih `draft`, BELUM ADA satu pun tanda
 * tangan, dan nomornya memang berasal dari counter kita (bukan nomor manual
 * hasil unggahan).
 */
export type ReleaseNumberResult =
  | { ok: true; releasedNumber: string }
  | { ok: false; reason: string };

export async function releaseDocumentNumber(
  pool: Pool,
  params: { tenantId: string; documentId: string },
): Promise<ReleaseNumberResult> {
  return withTransaction<ReleaseNumberResult>(pool, async (client) => {
    const doc = await client.query<{
      document_number: string; number_seq: string | null; number_rule_id: string | null; number_scope_hash: string | null;
    }>(
      `SELECT document_number, number_seq, number_rule_id, number_scope_hash
         FROM dcs_documents WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [params.documentId, params.tenantId],
    );
    if (doc.rowCount === 0) return { ok: false as const, reason: "Dokumen tidak ditemukan." };
    const d = doc.rows[0];
    if (!d.number_seq || !d.number_rule_id || !d.number_scope_hash) {
      return { ok: false as const, reason: "Nomor dokumen ini bukan dari penomoran otomatis (nomor bebas / dokumen lama sebelum fitur ini), jadi tidak ada yang bisa dilepas." };
    }
    const vs = await client.query<{ status: string; n: string }>(
      `SELECT status, COUNT(*)::text AS n FROM dcs_document_versions
        WHERE document_id = $1 AND tenant_id = $2 GROUP BY status`,
      [params.documentId, params.tenantId],
    );
    const beyondDraft = vs.rows.filter((r) => r.status !== "draft");
    if (beyondDraft.length > 0) {
      return { ok: false as const, reason: `Nomor hanya bisa dilepas selama dokumen masih sepenuhnya draft. Ada versi berstatus: ${beyondDraft.map((r) => r.status).join(", ")}.` };
    }
    const sig = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM dcs_approvals a
         JOIN dcs_document_versions v ON v.id = a.version_id
        WHERE v.document_id = $1 AND v.tenant_id = $2`,
      [params.documentId, params.tenantId],
    );
    if (Number(sig.rows[0]?.n || 0) > 0) {
      return { ok: false as const, reason: "Dokumen ini sudah memiliki tanda tangan, jadi nomornya berpotensi sudah beredar dan tidak boleh dipakai ulang." };
    }

    await releaseSequence(client, {
      tenantId: params.tenantId,
      ruleId: d.number_rule_id,
      scopeHash: d.number_scope_hash,
      seq: Number(d.number_seq),
    });
    await client.query(
      `UPDATE dcs_documents
          SET document_number = $3, number_seq = NULL, number_rule_id = NULL, number_scope_hash = NULL
        WHERE id = $1 AND tenant_id = $2`,
      // Nomor dikosongkan tapi harus tetap unik (uq_dcs_document_number) —
      // pakai penanda yang jelas terbaca sebagai "belum bernomor".
      [params.documentId, params.tenantId, `(nomor dilepas) ${params.documentId.slice(0, 8)}`],
    );
    return { ok: true as const, releasedNumber: d.document_number };
  });
}

/** English reference copy of the version's ID master — a linked artifact, not
 * an independently approved version (see dcs_document_versions.translated_*). */
export async function attachTranslatedFile(
  pool: Pool,
  params: { tenantId: string; versionId: string; s3Key: string; sha256: string; lang: string },
) {
  await pool.query(
    `UPDATE dcs_document_versions
        SET translated_file_s3_key = $1, translated_file_sha256 = $2, translated_lang = $3, translated_at = now(), updated_at = now()
      WHERE id = $4 AND tenant_id = $5`,
    [params.s3Key, params.sha256, params.lang, params.versionId, params.tenantId],
  );
}

export interface DocumentListRow {
  id: string;
  documentNumber: string;
  title: string;
  docTypeCode: string;
  department: string;
  // Folder Arsip Dokumen (modul Kontrak) tujuan dokumen ini SETELAH full
  // sign — dipilih sekali di awal saat dokumen dibuat (lihat routes.ts
  // POST /documents), disimpan di dcs_documents.metadata. Kosong = dokumen
  // ini tidak otomatis muncul di folder Arsip mana pun (perilaku lama,
  // tetap berlaku untuk dokumen yang sudah ada sebelum field ini ditambah).
  archiveCategory?: string;
  archiveSubFolderId?: string;
  versions: Array<{
    id: string; major: number; minor: number; status: VersionStatus;
    effectiveAt: string | null; supersededAt: string | null; changeSummary: string | null;
    hasFile: boolean; reviewDueAt: string | null; reviewReminderDays: number;
    hasTranslatedFile: boolean;
    // Tanggal berlaku TERJADWAL (rilis manual/terjadwal) — hanya berarti selagi
    // status 'approved'; begitu diberlakukan, dikosongkan (lihat obsolete-engine).
    scheduledEffectiveAt: string | null;
  }>;
}

/** One document with all its versions — the shape the frontend virtual tree consumes. */
export async function getDocumentWithVersions(pool: Pool, tenantId: string, documentId: string): Promise<DocumentListRow | null> {
  const doc = await pool.query(
    `SELECT d.id, d.document_number, d.title, dt.code AS doc_type_code, d.department_id, d.metadata
       FROM dcs_documents d JOIN dcs_document_types dt ON dt.id = d.doc_type_id
      WHERE d.id = $1 AND d.tenant_id = $2`,
    [documentId, tenantId],
  );
  if (doc.rowCount === 0) return null;
  const versions = await pool.query(
    `SELECT id, major_version, minor_version, status, effective_at, superseded_at, change_summary, review_due_at, metadata,
            (clean_file_s3_key IS NOT NULL) AS has_file, (translated_file_s3_key IS NOT NULL) AS has_translated_file
       FROM dcs_document_versions
      WHERE document_id = $1 AND tenant_id = $2
      ORDER BY major_version DESC, minor_version DESC`,
    [documentId, tenantId],
  );
  const d = doc.rows[0];
  return {
    id: d.id, documentNumber: d.document_number, title: d.title,
    docTypeCode: d.doc_type_code, department: d.department_id,
    archiveCategory: d.metadata?.archiveCategory || undefined,
    archiveSubFolderId: d.metadata?.archiveSubFolderId || undefined,
    versions: versions.rows.map((v) => ({
      id: v.id, major: v.major_version, minor: v.minor_version, status: v.status,
      effectiveAt: v.effective_at, supersededAt: v.superseded_at, changeSummary: v.change_summary,
      hasFile: v.has_file, reviewDueAt: v.review_due_at,
      reviewReminderDays: Number(v.metadata?.reviewReminderDays) || 30,
      hasTranslatedFile: v.has_translated_file,
      scheduledEffectiveAt: v.metadata?.scheduledEffectiveAt || null,
    })),
  };
}

/** All documents for a tenant (list view), with a lightweight version summary. */
export async function listDocuments(pool: Pool, tenantId: string): Promise<DocumentListRow[]> {
  const docs = await pool.query(
    `SELECT d.id FROM dcs_documents d WHERE d.tenant_id = $1 ORDER BY d.created_at DESC`,
    [tenantId],
  );
  const out: DocumentListRow[] = [];
  for (const row of docs.rows) {
    const full = await getDocumentWithVersions(pool, tenantId, row.id);
    if (full) out.push(full);
  }
  return out;
}

/** Count of approval rows already stamped on a version (for signature stacking). */
export async function countApprovals(pool: Pool, tenantId: string, versionId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM dcs_approvals WHERE tenant_id = $1 AND version_id = $2`,
    [tenantId, versionId],
  );
  return rows[0].n;
}

/** Records an approval + its signature/integrity metadata. */
export async function recordApproval(
  pool: Pool,
  p: { tenantId: string; versionId: string; stepOrder: number; approverUserId: string; approverRole: string;
       signedContentSha256: string; signatureImageKey?: string; anchor: Record<string, unknown> },
) {
  await pool.query(
    `INSERT INTO dcs_approvals
       (tenant_id, version_id, step_order, approver_user_id, approver_role, decision, decided_at,
        signed_content_sha256, signature_image_s3_key, signature_algorithm, signature_anchor)
     VALUES ($1,$2,$3,$4,$5,'approved', now(), $6, $7, 'SHA256-STAMP', $8)`,
    [p.tenantId, p.versionId, p.stepOrder, p.approverUserId, p.approverRole,
     p.signedContentSha256, p.signatureImageKey ?? null, JSON.stringify(p.anchor)],
  );
}

export async function getApprovals(pool: Pool, tenantId: string, versionId: string) {
  const { rows } = await pool.query(
    `SELECT approver_user_id, approver_role, decision, decided_at, signed_content_sha256
       FROM dcs_approvals WHERE tenant_id = $1 AND version_id = $2 ORDER BY step_order ASC`,
    [tenantId, versionId],
  );
  return rows.map((r) => ({
    approverUserId: r.approver_user_id, approverRole: r.approver_role, decision: r.decision,
    decidedAt: r.decided_at, signedContentSha256: r.signed_content_sha256,
  }));
}

export interface ApprovalRosterEntry {
  order: number;
  label: string;
  role: string;
  status: "approved" | "pending";
  approverUserId?: string;
  approverRole?: string;
  decidedAt?: string;
  // Penandatangan yang DITUNJUK untuk kolom ini (kalau ada) — supaya UI bisa
  // menampilkan "menunggu [nama]" bahkan sebelum orangnya TTD.
  assignedUserId?: string;
}

// Gabungan kolom TTD yang DIKONFIGURASI (dari compose metadata) dengan
// approval yang SUDAH TERJADI (dari dcs_approvals) — dihitung saat baca,
// TIDAK ada baris 'pending' yang ditulis ke DB. dcs_approvals selama ini
// cuma pernah diisi SETELAH seseorang TTD (lihat recordApproval), jadi tanpa
// penggabungan ini tidak ada cara menampilkan "kolom N masih menunggu siapa"
// sebelum orangnya benar-benar TTD.
export async function getApprovalRoster(pool: Pool, tenantId: string, versionId: string): Promise<ApprovalRosterEntry[]> {
  const compose = await getComposeMetadata(pool, tenantId, versionId);
  const columns = resolveSignatureColumns(compose);
  const approvals = await getApprovals(pool, tenantId, versionId);
  return columns.map((col, i) => {
    const a = approvals[i];
    return a
      ? { order: i + 1, label: col.label, role: col.role, status: "approved" as const, approverUserId: a.approverUserId, approverRole: a.approverRole, decidedAt: a.decidedAt, assignedUserId: col.assignedUserId }
      : { order: i + 1, label: col.label, role: col.role, status: "pending" as const, assignedUserId: col.assignedUserId };
  });
}

export async function getReceipts(pool: Pool, tenantId: string, versionId: string) {
  const { rows } = await pool.query(
    `SELECT user_id, status, read_at, acknowledged_at FROM dcs_read_receipts
      WHERE tenant_id = $1 AND version_id = $2 ORDER BY updated_at DESC`,
    [tenantId, versionId],
  );
  return rows.map((r) => ({ userId: r.user_id, status: r.status, readAt: r.read_at, acknowledgedAt: r.acknowledged_at }));
}

/**
 * Distributes a version to a set of users: one distribution rule + a pending
 * read obligation per user (idempotent — re-distributing doesn't reset a user
 * who already read/acknowledged).
 */
export async function distributeVersion(
  pool: Pool,
  p: { tenantId: string; versionId: string; distributedBy: string; userIds: string[]; mandatory: boolean },
) {
  return withTransaction(pool, async (client) => {
    const dist = await client.query(
      `INSERT INTO dcs_distributions (tenant_id, version_id, target_scope, target_value, is_mandatory, distributed_by)
       VALUES ($1,$2,'user',$3,$4,$5) RETURNING id`,
      [p.tenantId, p.versionId, `${p.userIds.length} user`, p.mandatory, p.distributedBy],
    );
    const distId = dist.rows[0].id;
    for (const uid of p.userIds) {
      await client.query(
        `INSERT INTO dcs_read_receipts (tenant_id, version_id, distribution_id, user_id, status)
           VALUES ($1,$2,$3,$4,'pending')
         ON CONFLICT (version_id, user_id) DO UPDATE SET distribution_id = EXCLUDED.distribution_id, updated_at = now()`,
        [p.tenantId, p.versionId, distId, uid],
      );
    }
    return { distributionId: distId, count: p.userIds.length };
  });
}

/**
 * Sets/clears when a controlled document is next due for review (ISO periodic
 * review, distinct from a contract's expiry). `reviewReminderDays` (how many
 * days ahead to start nagging, mirrors Contract.reminderDaysBefore) has no
 * dedicated column — stored in metadata alongside compose content, same
 * pattern as saveComposeMetadata, no schema change needed.
 */
export async function setReviewSchedule(
  pool: Pool,
  p: { tenantId: string; versionId: string; reviewDueAt: string | null; reviewReminderDays: number },
) {
  await pool.query(
    `UPDATE dcs_document_versions
        SET review_due_at = $1, metadata = jsonb_set(metadata, '{reviewReminderDays}', $2::jsonb), updated_at = now()
      WHERE id = $3 AND tenant_id = $4`,
    [p.reviewDueAt, JSON.stringify(p.reviewReminderDays), p.versionId, p.tenantId],
  );
}

// ---------------------------------------------------------------------------
// Rilis manual / terjadwal (dokumen internal): dokumen yang sudah full-approval
// TIDAK otomatis berlaku. Document Control memberlakukannya sekarang (manual)
// atau menjadwalkan tanggal berlaku (terjadwal). Tanggal terjadwal disimpan di
// metadata.scheduledEffectiveAt (pola sama seperti setReviewSchedule — tanpa
// migrasi skema), hanya bermakna selagi status 'approved'.
// ---------------------------------------------------------------------------

/** Jadwalkan tanggal berlaku sebuah versi yang sudah 'approved'. Menolak kalau
 * versi belum penuh disetujui (status != approved) — gerbang yang sama dengan
 * memberlakukan langsung, hanya ditunda ke tanggal yang dipilih. */
export async function scheduleVersionRelease(
  pool: Pool,
  p: { tenantId: string; versionId: string; effectiveAt: string },
): Promise<void> {
  const { rows } = await pool.query(
    `UPDATE dcs_document_versions
        SET metadata = jsonb_set(metadata, '{scheduledEffectiveAt}', $1::jsonb), updated_at = now()
      WHERE id = $2 AND tenant_id = $3 AND status = 'approved'
      RETURNING id`,
    [JSON.stringify(p.effectiveAt), p.versionId, p.tenantId],
  );
  if (rows.length === 0) {
    throw new Error("Hanya dokumen yang sudah disetujui penuh (status Approved) yang bisa dijadwalkan berlaku.");
  }
}

/** Batalkan jadwal berlaku (kembali menunggu rilis manual). */
export async function cancelVersionRelease(
  pool: Pool,
  p: { tenantId: string; versionId: string },
): Promise<void> {
  await pool.query(
    `UPDATE dcs_document_versions
        SET metadata = metadata - 'scheduledEffectiveAt', updated_at = now()
      WHERE id = $1 AND tenant_id = $2 AND status = 'approved'`,
    [p.versionId, p.tenantId],
  );
}

export interface DueRelease {
  versionId: string; documentId: string; tenantId: string;
  documentNumber: string; title: string; ownerUserId: string; scheduledEffectiveAt: string;
}

/** Cross-tenant scan for 'approved' versions whose scheduled release date has
 * arrived — the cron (reminders.ts) promotes each to effective. Mirrors the
 * review-due scan's shape. */
export async function listVersionsDueForRelease(pool: Pool): Promise<DueRelease[]> {
  const { rows } = await pool.query(
    `SELECT v.id, v.document_id, v.tenant_id, v.metadata->>'scheduledEffectiveAt' AS sched,
            d.document_number, d.title, d.owner_user_id
       FROM dcs_document_versions v JOIN dcs_documents d ON d.id = v.document_id
      WHERE v.status = 'approved'
        AND v.metadata ? 'scheduledEffectiveAt'
        AND (v.metadata->>'scheduledEffectiveAt')::timestamptz <= now()`,
  );
  return rows.map((r) => ({
    versionId: r.id, documentId: r.document_id, tenantId: r.tenant_id,
    documentNumber: r.document_number, title: r.title, ownerUserId: r.owner_user_id,
    scheduledEffectiveAt: r.sched,
  }));
}

export interface DueVersion {
  versionId: string; tenantId: string; documentNumber: string; title: string;
  reviewDueAt: string; reviewReminderDays: number; lastReminderDate: string | null;
}

/**
 * Cross-tenant scan for effective versions whose review date needs a nudge —
 * mirrors reminders.ts's contract scan (same "one query, filter in JS, dedupe
 * by calendar date" shape) but reads dcs_document_versions instead of the
 * JSONB contracts collection.
 */
export async function listVersionsDueForReview(pool: Pool): Promise<DueVersion[]> {
  const { rows } = await pool.query(
    `SELECT v.id, v.tenant_id, v.review_due_at, v.metadata, d.document_number, d.title
       FROM dcs_document_versions v JOIN dcs_documents d ON d.id = v.document_id
      WHERE v.status = 'effective' AND v.review_due_at IS NOT NULL`,
  );
  return rows.map((r) => ({
    versionId: r.id, tenantId: r.tenant_id, documentNumber: r.document_number, title: r.title,
    reviewDueAt: r.review_due_at, reviewReminderDays: Number(r.metadata?.reviewReminderDays) || 30,
    lastReminderDate: r.metadata?.lastReminderDate ?? null,
  }));
}

export async function markReviewReminderSent(pool: Pool, versionId: string, dateStr: string) {
  await pool.query(
    `UPDATE dcs_document_versions SET metadata = jsonb_set(metadata, '{lastReminderDate}', $1::jsonb), updated_at = now() WHERE id = $2`,
    [JSON.stringify(dateStr), versionId],
  );
}

/** Records that a user accessed/read a version — feeds the read-ack ledger. */
export async function recordReadReceipt(
  pool: Pool,
  params: { tenantId: string; versionId: string; userId: string; ip?: string; ua?: string; acknowledge?: boolean },
) {
  await pool.query(
    `INSERT INTO dcs_read_receipts (tenant_id, version_id, user_id, status, read_at, acknowledged_at, ip_address, user_agent)
       VALUES ($1,$2,$3,$4, now(), $5, $6, $7)
     ON CONFLICT (version_id, user_id) DO UPDATE
       SET status = CASE WHEN dcs_read_receipts.status = 'acknowledged'
                         THEN 'acknowledged'::dcs_receipt_status ELSE EXCLUDED.status END,
           read_at = COALESCE(dcs_read_receipts.read_at, EXCLUDED.read_at),
           acknowledged_at = COALESCE(dcs_read_receipts.acknowledged_at, EXCLUDED.acknowledged_at),
           updated_at = now()`,
    [
      params.tenantId, params.versionId, params.userId,
      params.acknowledge ? "acknowledged" : "read",
      params.acknowledge ? new Date().toISOString() : null,
      params.ip ?? null, params.ua ?? null,
    ],
  );
}

// ---------------------------------------------------------------------------
// Company branding (for letterhead composing) — read synchronously from the
// SAME in-memory cache the platform's settings save endpoint writes through
// (loadDB()/saveDB() in ../db), not a separate SQL query. This is the exact
// import already used by dcs/reminders.ts with zero circular-import issue
// (db.ts imports nothing from dcs/ or server.ts), and it means there is no
// staleness window: a just-saved logo/company name is visible immediately.
// ---------------------------------------------------------------------------
export interface CompanyBranding {
  companyName: string; companyAddress: string;
  companyLogoKey: string | null; companyLogoMimeType: string | null;
  // Paragraf kerahasiaan/hak cipta dicetak di dokumen compose DCS — kosong =
  // tidak dicetak. Kata-katanya beda-beda per perusahaan jadi tidak ada
  // default hardcoded; diedit di panel pengaturan tenant yang sama dgn
  // companyName/companyAddress/logo.
  confidentialityNotice: string;
}

export function getCompanyBranding(tenantId: string): CompanyBranding {
  const db = loadDB();
  const raw = (db as any).settingsByTenant?.[tenantId] || {};
  return {
    companyName: raw.companyName || "",
    companyAddress: raw.companyAddress || "",
    companyLogoKey: raw.companyLogoKey || null,
    companyLogoMimeType: raw.companyLogoMimeType || null,
    confidentialityNotice: raw.confidentialityNotice || "",
  };
}

// Margin halaman untuk compose PDF, dibaca dari settings tenant (mm) dan
// dikonversi ke points (1 mm = 2.8346 pt). Fallback 56pt (~19.8mm) = perilaku
// lama bila belum dikonfigurasi. Dibaca dari cache in-memory yang sama dengan
// getCompanyBranding — tanpa staleness window.
const MM_TO_PT = 2.834645669;
export interface DcsPageMargins { top: number; right: number; bottom: number; left: number }
export function getDcsPageMargins(tenantId: string): DcsPageMargins {
  const db = loadDB();
  const raw = (db as any).settingsByTenant?.[tenantId]?.dcsPageMargins || {};
  const toPt = (mm: unknown, fallback: number) => {
    const n = Number(mm);
    return Number.isFinite(n) && n > 0 ? n * MM_TO_PT : fallback;
  };
  return {
    top: toPt(raw.top, 56),
    right: toPt(raw.right, 56),
    bottom: toPt(raw.bottom, 56),
    left: toPt(raw.left, 56),
  };
}

// ---------------------------------------------------------------------------
// Klausul library (dcs_clauses) — reusable content blocks, analogous to the
// Contract module's Clause collection. A real table (not JSONB on a doc
// type) because a clause must be shareable across MULTIPLE document types.
// ---------------------------------------------------------------------------
export interface DcsClauseRow {
  id: string; title: string; content: string; category: string;
  applicableDocTypeCodes: string[]; isMandatory: boolean; tags: string[];
}

function rowToDcsClause(r: any): DcsClauseRow {
  return {
    id: r.id, title: r.title, content: r.content, category: r.category,
    applicableDocTypeCodes: r.applicable_doc_type_codes || [],
    isMandatory: r.is_mandatory, tags: Array.isArray(r.tags) ? r.tags : [],
  };
}

export async function listDcsClauses(pool: Pool, tenantId: string, opts?: { docTypeCode?: string }): Promise<DcsClauseRow[]> {
  const { rows } = await pool.query(
    `SELECT id, title, content, category, applicable_doc_type_codes, is_mandatory, tags
       FROM dcs_clauses
      WHERE tenant_id = $1 AND is_active = TRUE
        AND ($2::text IS NULL OR applicable_doc_type_codes = '{}' OR $2 = ANY(applicable_doc_type_codes))
      ORDER BY category ASC, created_at ASC`,
    [tenantId, opts?.docTypeCode ?? null],
  );
  return rows.map(rowToDcsClause);
}

export async function getDcsClausesByIds(pool: Pool, tenantId: string, ids: string[]): Promise<DcsClauseRow[]> {
  if (ids.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT id, title, content, category, applicable_doc_type_codes, is_mandatory, tags
       FROM dcs_clauses WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
    [tenantId, ids],
  );
  return rows.map(rowToDcsClause);
}

export async function createDcsClause(
  pool: Pool,
  p: { tenantId: string; title: string; content: string; category?: string; applicableDocTypeCodes?: string[]; isMandatory?: boolean; tags?: string[]; createdBy: string },
): Promise<DcsClauseRow> {
  const { rows } = await pool.query(
    `INSERT INTO dcs_clauses (tenant_id, title, content, category, applicable_doc_type_codes, is_mandatory, tags, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id, title, content, category, applicable_doc_type_codes, is_mandatory, tags`,
    [p.tenantId, p.title, p.content, p.category || "General", p.applicableDocTypeCodes || [], !!p.isMandatory, JSON.stringify(p.tags || []), p.createdBy],
  );
  return rowToDcsClause(rows[0]);
}

export async function updateDcsClause(
  pool: Pool, tenantId: string, id: string,
  patch: { title?: string; content?: string; category?: string; applicableDocTypeCodes?: string[]; isMandatory?: boolean; tags?: string[] },
): Promise<DcsClauseRow | null> {
  const { rows } = await pool.query(
    `UPDATE dcs_clauses SET
        title = COALESCE($1, title), content = COALESCE($2, content), category = COALESCE($3, category),
        applicable_doc_type_codes = COALESCE($4, applicable_doc_type_codes),
        is_mandatory = COALESCE($5, is_mandatory), tags = COALESCE($6, tags), updated_at = now()
      WHERE id = $7 AND tenant_id = $8
    RETURNING id, title, content, category, applicable_doc_type_codes, is_mandatory, tags`,
    [patch.title ?? null, patch.content ?? null, patch.category ?? null, patch.applicableDocTypeCodes ?? null,
     patch.isMandatory ?? null, patch.tags ? JSON.stringify(patch.tags) : null, id, tenantId],
  );
  return rows[0] ? rowToDcsClause(rows[0]) : null;
}

export async function deactivateDcsClause(pool: Pool, tenantId: string, id: string): Promise<void> {
  await pool.query(`UPDATE dcs_clauses SET is_active = FALSE, updated_at = now() WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
}

// ---------------------------------------------------------------------------
// Review annotations (komentar/highlight gaya Word) + putaran review.
// Reviewer/approver menandai bagian dokumen yang belum sesuai SEBELUM
// menandatangani; penyusun memperbaiki lalu menandai komentar "selesai" (OK)
// dan mengajukan ulang. Lihat dcs_review_comments di schema.ts.
// ---------------------------------------------------------------------------
export interface ReviewCommentAnchor {
  // field: bagian konten yang ditandai. "section" wajib sertakan sectionIndex.
  field?: "purpose" | "scope" | "section" | "flow" | "general";
  sectionIndex?: number;
  sectionHeading?: string;
  quote?: string; // teks yang di-highlight (opsional)
}
export interface ReviewComment {
  id: string; authorUserId: string; authorName: string; authorRole: string;
  anchor: ReviewCommentAnchor; body: string; status: "open" | "resolved";
  reviewRound: number; resolvedBy?: string; resolvedByName?: string; resolvedAt?: string;
  createdAt: string;
}

function rowToReviewComment(r: any): ReviewComment {
  return {
    id: r.id, authorUserId: r.author_user_id, authorName: r.author_name, authorRole: r.author_role,
    anchor: r.anchor || {}, body: r.body, status: r.status, reviewRound: r.review_round,
    resolvedBy: r.resolved_by || undefined, resolvedByName: r.resolved_by_name || undefined,
    resolvedAt: r.resolved_at || undefined, createdAt: r.created_at,
  };
}

// Putaran review disimpan di metadata versi (default 1), naik tiap kali sebuah
// versi dikembalikan ke penyusun (request-changes). Komentar yang dibuat
// membawa nomor putaran saat itu — jadi thread bisa dikelompokkan per putaran.
export async function getVersionReviewRound(pool: Pool, tenantId: string, versionId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COALESCE((metadata->>'reviewRound')::int, 1) AS r FROM dcs_document_versions WHERE id = $1 AND tenant_id = $2`,
    [versionId, tenantId],
  );
  return rows[0]?.r ?? 1;
}

export async function bumpVersionReviewRound(pool: Pool, tenantId: string, versionId: string): Promise<number> {
  const { rows } = await pool.query(
    `UPDATE dcs_document_versions
        SET metadata = jsonb_set(metadata, '{reviewRound}', to_jsonb(COALESCE((metadata->>'reviewRound')::int, 1) + 1)), updated_at = now()
      WHERE id = $1 AND tenant_id = $2
    RETURNING (metadata->>'reviewRound')::int AS r`,
    [versionId, tenantId],
  );
  return rows[0]?.r ?? 1;
}

export async function addReviewComment(
  pool: Pool,
  p: { tenantId: string; versionId: string; authorUserId: string; authorName: string; authorRole: string; anchor: ReviewCommentAnchor; body: string; reviewRound: number },
): Promise<ReviewComment> {
  const { rows } = await pool.query(
    `INSERT INTO dcs_review_comments (tenant_id, version_id, author_user_id, author_name, author_role, anchor, body, review_round)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [p.tenantId, p.versionId, p.authorUserId, p.authorName, p.authorRole, JSON.stringify(p.anchor || {}), p.body, p.reviewRound],
  );
  return rowToReviewComment(rows[0]);
}

export async function listReviewComments(pool: Pool, tenantId: string, versionId: string): Promise<ReviewComment[]> {
  const { rows } = await pool.query(
    `SELECT * FROM dcs_review_comments WHERE tenant_id = $1 AND version_id = $2 ORDER BY created_at ASC`,
    [tenantId, versionId],
  );
  return rows.map(rowToReviewComment);
}

export async function countOpenComments(pool: Pool, tenantId: string, versionId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM dcs_review_comments WHERE tenant_id = $1 AND version_id = $2 AND status = 'open'`,
    [tenantId, versionId],
  );
  return rows[0].n;
}

// Penyusun menandai komentar "selesai/OK". Hanya mengubah baris yang masih
// 'open' (idempotent — klik dua kali tidak menimpa data penyelesai pertama).
export async function resolveReviewComment(
  pool: Pool, tenantId: string, commentId: string, resolver: { id: string; name: string },
): Promise<ReviewComment | null> {
  const { rows } = await pool.query(
    `UPDATE dcs_review_comments
        SET status = 'resolved', resolved_by = $1, resolved_by_name = $2, resolved_at = now(), updated_at = now()
      WHERE id = $3 AND tenant_id = $4 AND status = 'open'
    RETURNING *`,
    [resolver.id, resolver.name, commentId, tenantId],
  );
  return rows[0] ? rowToReviewComment(rows[0]) : null;
}

// Menghapus semua approval (tanda tangan) sebuah versi — dipakai saat dokumen
// dikembalikan ke penyusun: isi akan berubah sehingga tanda tangan pada konten
// lama tidak lagi sah, jadi rantai TTD di-reset dan diulang dari awal setelah
// perbaikan (integritas ISO: TTD selalu atas konten final yang disetujui).
export async function clearApprovals(pool: Pool, tenantId: string, versionId: string): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM dcs_approvals WHERE tenant_id = $1 AND version_id = $2`,
    [tenantId, versionId],
  );
  return rowCount ?? 0;
}

// Dipakai route untuk mengecek versi + siapa pemiliknya (penyusun) saat gating
// resolve/request-changes, tanpa menarik seluruh dokumen.
export async function getVersionOwner(pool: Pool, tenantId: string, versionId: string): Promise<{ ownerUserId: string; documentId: string; status: VersionStatus; documentNumber: string; title: string } | null> {
  const { rows } = await pool.query(
    `SELECT d.owner_user_id, d.id AS document_id, v.status, d.document_number, d.title
       FROM dcs_document_versions v JOIN dcs_documents d ON d.id = v.document_id
      WHERE v.id = $1 AND v.tenant_id = $2`,
    [versionId, tenantId],
  );
  return rows[0] ? { ownerUserId: rows[0].owner_user_id, documentId: rows[0].document_id, status: rows[0].status, documentNumber: rows[0].document_number, title: rows[0].title } : null;
}

// ============================================================================
// REVIEW EKSTERNAL VIA TOKEN (pihak eksternal / auditor tanpa akun) — mirror
// dari fitur external-review Kontrak (server.ts), disimpan di
// dcs_document_versions.metadata->'externalReview' (kolom JSONB yang sudah
// ada, tanpa migrasi skema). Hanya untuk versi yang MASIH disusun/direview
// (draft/under_review) — versi approved/effective sudah final, tak perlu lagi.
export interface DcsExternalApproval { name: string; approvedAt: string; note?: string }
export interface DcsExternalReviewState { token?: string; expiresAt?: string | null; locked?: boolean; approvals?: DcsExternalApproval[] }

export async function enableDcsExternalReview(
  pool: Pool, p: { tenantId: string; versionId: string; token: string; expiresAt: string | null },
): Promise<void> {
  const { rowCount } = await pool.query(
    `UPDATE dcs_document_versions
        SET metadata = jsonb_set(metadata, '{externalReview}', $1::jsonb), updated_at = now()
      WHERE id = $2 AND tenant_id = $3 AND status IN ('draft','under_review')`,
    [JSON.stringify({ token: p.token, expiresAt: p.expiresAt, locked: false, approvals: [] }), p.versionId, p.tenantId],
  );
  if (rowCount === 0) throw new Error("Versi tidak ditemukan, atau statusnya tidak mendukung review eksternal (hanya Draft/Under Review).");
}

export async function disableDcsExternalReview(pool: Pool, p: { tenantId: string; versionId: string }): Promise<void> {
  await pool.query(
    `UPDATE dcs_document_versions SET metadata = metadata - 'externalReview', updated_at = now() WHERE id = $1 AND tenant_id = $2`,
    [p.versionId, p.tenantId],
  );
}

// Resolusi token → versi + dokumen (helper publik). null kalau token tak
// ada/salah/kadaluarsa — sama seperti resolveExternalReview versi Kontrak.
export async function resolveDcsExternalReview(pool: Pool, token: string): Promise<{
  versionId: string; tenantId: string; documentId: string; documentNumber: string; title: string;
  docTypeCode: string; department: string; major: number; minor: number; state: DcsExternalReviewState;
} | null> {
  if (!token) return null;
  const { rows } = await pool.query(
    `SELECT v.id AS version_id, v.tenant_id, v.metadata, v.major_version, v.minor_version,
            d.id AS document_id, d.document_number, d.title, d.department_id, dt.code AS doc_type_code
       FROM dcs_document_versions v
       JOIN dcs_documents d ON d.id = v.document_id
       JOIN dcs_document_types dt ON dt.id = d.doc_type_id
      WHERE v.metadata->'externalReview'->>'token' = $1`,
    [token],
  );
  const r = rows[0];
  if (!r) return null;
  const state: DcsExternalReviewState = r.metadata?.externalReview || {};
  if (state.expiresAt && new Date(state.expiresAt) < new Date()) return null;
  return {
    versionId: r.version_id, tenantId: r.tenant_id, documentId: r.document_id, documentNumber: r.document_number,
    title: r.title, docTypeCode: r.doc_type_code, department: r.department_id,
    major: r.major_version, minor: r.minor_version, state,
  };
}

/**
 * Versi ini punya link review eksternal AKTIF? Dipakai endpoint /unlock
 * (dipanggil admin via versionId, BUKAN via token publik) sebagai guard —
 * tanpanya `jsonb_set(metadata, '{externalReview,locked}', ...)` pada versi
 * yang metadata->'externalReview'-nya NULL gagal SENYAP (jsonb_set tidak
 * membuat parent key yang hilang di path bertingkat), jadi endpoint balas
 * 200 sukses padahal tidak ada apa pun yang berubah — dibuktikan lewat
 * pengujian nyata: HTTP 200 tapi metadata tetap tidak punya externalReview.
 * Endpoint publik (/approve, /comments) sudah aman karena selalu masuk lewat
 * resolveDcsExternalReview() dulu, yang mensyaratkan token itu sendiri ada.
 */
export async function hasDcsExternalReviewToken(pool: Pool, tenantId: string, versionId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT (metadata->'externalReview'->>'token') IS NOT NULL AS ada
       FROM dcs_document_versions WHERE id = $1 AND tenant_id = $2`,
    [versionId, tenantId],
  );
  return !!rows[0]?.ada;
}

export async function setDcsExternalReviewLock(pool: Pool, p: { tenantId: string; versionId: string; locked: boolean }): Promise<void> {
  await pool.query(
    `UPDATE dcs_document_versions
        SET metadata = jsonb_set(metadata, '{externalReview,locked}', $1::jsonb), updated_at = now()
      WHERE id = $2 AND tenant_id = $3`,
    [JSON.stringify(p.locked), p.versionId, p.tenantId],
  );
}

export async function addDcsExternalApproval(pool: Pool, p: { tenantId: string; versionId: string; approval: DcsExternalApproval }): Promise<void> {
  await pool.query(
    `UPDATE dcs_document_versions
        SET metadata = jsonb_set(
              metadata, '{externalReview,approvals}',
              COALESCE(metadata->'externalReview'->'approvals', '[]'::jsonb) || $1::jsonb
            ),
            updated_at = now()
      WHERE id = $2 AND tenant_id = $3`,
    [JSON.stringify([p.approval]), p.versionId, p.tenantId],
  );
}

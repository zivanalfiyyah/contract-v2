import express, { type Response } from "express";
import multer from "multer";
import type { Pool } from "pg";
import { requireAuth, requireRole, tenantOf, type AuthedRequest } from "../auth.js";
import { storeFile, deleteFile, fetchFile } from "../storage.js";
import { logger } from "../logger.js";
import { loadDB, saveDB } from "../db.js";
import { sendPushToUser } from "../push.js";
import { ai, parseAiJson, aiErrorResponse } from "../ai-client.js";
import { initDcsSchema } from "./schema.js";
import {
  ensureTenantDefaults, createDocumentWithFirstVersion, createNextVersion,
  setVersionStatus, attachCleanFile, attachTranslatedFile, getDocumentWithVersions, listDocuments, recordReadReceipt,
  countApprovals, recordApproval, getApprovals, getApprovalRoster, resolveSignatureColumns, getReceipts, distributeVersion,
  saveComposeMetadata, getComposeMetadata, getVersionCore,
  listDocTypes, createDocType, updateDocType, deactivateDocType, getDocTypeByCode,
  getActiveNumberingRule, updateActiveNumberingRule, removeNumberingRuleOverride, withdrawEffectiveVersion, previewDocumentNumberForType,
  setReviewSchedule, getCompanyBranding, getDcsPageMargins, releaseDocumentNumber,
  scheduleVersionRelease, cancelVersionRelease,
  listDcsClauses, createDcsClause, updateDcsClause, deactivateDcsClause,
  addReviewComment, listReviewComments, resolveReviewComment, countOpenComments,
  clearApprovals, getVersionReviewRound, bumpVersionReviewRound, getVersionOwner,
  type SignatureColumn, type SignatureGroup, type DocTypeSection, type ReviewCommentAnchor,
} from "./repo.js";
import { validateMask } from "../numbering-utils.js";
import { promoteVersionToEffective } from "./obsolete-engine.js";
import { fetchAndVerifyCleanPdf, sha256, IntegrityError } from "./pdf-io.js";
import { applyReactiveWatermark } from "./pdf-watermark.js";
import { injectSignatures } from "./pdf-signature.js";
import { composeDocumentPdf, fillSignatureColumn, type ComposeFlowStep, type ComposeSection } from "./pdf-compose.js";
import type { VersionStatus } from "./state-machine";

// Batas 10MB, selaras dengan multer utama di server.ts (MulterError ditangani
// oleh error handler global app-level, jadi >10MB balas 400 yang rapi & sama).
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Map upstream/engine errors to clean HTTP responses (DRY — one place).
function fail(res: Response, err: any, fallback: string) {
  const msg = String(err?.message || "");
  if (msg.includes("Illegal DCS state transition")) return res.status(409).json({ error: msg });
  if (msg.startsWith("ErrVersionNumberConflict: ")) return res.status(409).json({ error: msg.slice("ErrVersionNumberConflict: ".length) });
  if (msg.includes("Unknown document type") || msg.includes("no versions")) return res.status(400).json({ error: msg });
  logger.error({ err }, fallback);
  return res.status(500).json({ error: fallback });
}

// "Siapa yang wajib menandatangani kolom ini?" — kolom TTD DCS berbasis ROLE
// platform (bukan user tertentu, lihat SignatureColumn di repo.ts), jadi
// "notifikasi ke yang dituju" berarti semua anggota tenant aktif dengan role
// tsb, bukan satu individu bernama. admin/super_admin sengaja TIDAK ikut di-
// notifikasi di sini walau mereka boleh menandatangani kolom apa pun sebagai
// override — mencegah admin di-spam tiap dokumen mana pun butuh TTD.
function usersWithRole(db: any, tenantId: string, role: string): { id: string; name: string }[] {
  return ((db.users as any[]) || []).filter((u) => u.tenantId === tenantId && u.active && u.role === role);
}

// Siapa yang harus di-notifikasi / boleh menandatangani sebuah kolom TTD:
// kalau kolomnya DITUNJUK ke orang spesifik (assignedUserId), cuma dia; kalau
// tidak, jatuh ke semua pemegang role (perilaku lama). Menjaga notifikasi
// tetap sinkron dengan gerbang sign-approve yang memakai logika sama.
function recipientsForColumn(db: any, tenantId: string, column: { role?: string; assignedUserId?: string }): { id: string; name: string }[] {
  if (column.assignedUserId) {
    const u = ((db.users as any[]) || []).find((x) => x.id === column.assignedUserId && x.tenantId === tenantId && x.active);
    return u ? [{ id: u.id, name: u.name }] : [];
  }
  return column.role ? usersWithRole(db, tenantId, column.role) : [];
}

// In-app notification bell (db.notifications) — replika ringan dari pushNotif
// di server.ts (module DCS tidak bisa import dari server.ts karena arahnya
// terbalik: server.ts yang me-mount router ini).
function pushDcsNotif(db: any, tenantId: string, entry: { title: string; message: string; type: "info" | "warning" | "success" | "danger"; dcsDocumentId: string }) {
  if (!db.notifications) db.notifications = [];
  db.notifications.unshift({
    id: "not-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
    tenantId, createdAt: new Date().toISOString(), read: false, ...entry,
  });
}

type LetterheadInput = { companyName: string; companyAddress: string; logo?: { bytes: Buffer; mimeType: string } };

/** Resolves the curated letterhead preset for a doc type into what
 * composeDocumentPdf expects — shared by /compose and /translate so both
 * produce a consistently-branded master. Logo fetch failure degrades to a
 * text-only letterhead rather than failing the whole compose. */
async function resolveLetterhead(tenantId: string, wantsLetterhead: boolean): Promise<LetterheadInput | undefined> {
  if (!wantsLetterhead) return undefined;
  const branding = getCompanyBranding(tenantId);
  const letterhead: LetterheadInput = { companyName: branding.companyName, companyAddress: branding.companyAddress };
  if (branding.companyLogoKey && branding.companyLogoMimeType) {
    try {
      letterhead.logo = { bytes: await fetchFile(branding.companyLogoKey), mimeType: branding.companyLogoMimeType };
    } catch (err) {
      logger.warn({ err, tenantId }, "Company logo fetch failed for letterhead — composing without it");
    }
  }
  return letterhead;
}

export function createDcsRouter(pool: Pool): express.Router {
  const router = express.Router();

  // Every route ensures this tenant has its default doc types + numbering rule.
  router.use(requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      await ensureTenantDefaults(pool, tenantOf(req));
      next();
    } catch (err) {
      fail(res, err, "Gagal menyiapkan modul DCS untuk tenant ini.");
    }
  });

  // Document classes (SOP/IK/Kebijakan/Memo/...) are dynamic per tenant, each
  // carrying its own default section template and signature-column layout —
  // this is what lets "Buat SOP" and "Buat Kebijakan" produce differently
  // structured drafts, and lets a tenant add classes beyond the ISO defaults
  // (e.g. "Standarisasi Mutu") without a code change.
  router.get("/doc-types", async (req: AuthedRequest, res) => {
    try { res.json(await listDocTypes(pool, tenantOf(req))); }
    catch (err) { fail(res, err, "Gagal memuat jenis dokumen."); }
  });

  router.post("/doc-types", requireRole("admin", "legal"), async (req: AuthedRequest, res) => {
    try {
      const { code, name, description, defaultSections, signatureColumns, signatureGroups, layoutStyle, letterhead, defaultLanes, defaultClauseIds, headerStyle, documentLevel, processOwner } = req.body;
      if (!code || !name) return res.status(400).json({ error: "Kode dan nama jenis dokumen wajib diisi" });
      const dt = await createDocType(pool, {
        tenantId: tenantOf(req), code, name, description,
        defaultSections: Array.isArray(defaultSections) ? defaultSections as DocTypeSection[] : [],
        signatureColumns: Array.isArray(signatureColumns) && signatureColumns.length > 0 ? signatureColumns as SignatureColumn[] : undefined,
        signatureGroups: Array.isArray(signatureGroups) && signatureGroups.length > 0 ? signatureGroups as SignatureGroup[] : undefined,
        layoutStyle: ["standard", "memo", "kebijakan"].includes(layoutStyle) ? layoutStyle : undefined,
        letterhead: typeof letterhead === "boolean" ? letterhead : undefined,
        defaultLanes: Array.isArray(defaultLanes) ? defaultLanes : undefined,
        defaultClauseIds: Array.isArray(defaultClauseIds) ? defaultClauseIds : undefined,
        headerStyle: headerStyle === "iso" || headerStyle === "simple" ? headerStyle : undefined,
        documentLevel: typeof documentLevel === "string" ? documentLevel : undefined,
        processOwner: typeof processOwner === "string" ? processOwner : undefined,
      });
      res.json({ success: true, docType: dt });
    } catch (err: any) {
      if (String(err?.message || "").includes("duplicate key")) return res.status(409).json({ error: "Kode jenis dokumen sudah dipakai." });
      fail(res, err, "Gagal membuat jenis dokumen.");
    }
  });

  router.put("/doc-types/:id", requireRole("admin", "legal"), async (req: AuthedRequest, res) => {
    try {
      const dt = await updateDocType(pool, tenantOf(req), req.params.id, req.body);
      if (!dt) return res.status(404).json({ error: "Jenis dokumen tidak ditemukan" });
      res.json({ success: true, docType: dt });
    } catch (err) { fail(res, err, "Gagal memperbarui jenis dokumen."); }
  });

  router.delete("/doc-types/:id", requireRole("admin", "legal"), async (req: AuthedRequest, res) => {
    try { await deactivateDocType(pool, tenantOf(req), req.params.id); res.json({ success: true }); }
    catch (err) { fail(res, err, "Gagal menonaktifkan jenis dokumen."); }
  });

  // Nomor dokumen: tenant punya satu rule default (auto-seeded oleh
  // ensureTenantDefaults), dan tiap jenis dokumen boleh punya rule override
  // sendiri (?docTypeId=...) — beda jenis dokumen jadi bisa beda penamaan
  // DAN beda counter sekaligus, tanpa mengisi ulang jenis dokumen yang belum
  // dikustomisasi (otomatis jatuh ke default lewat getActiveNumberingRule).
  const DCS_MASK_TOKENS = ["DocType", "Department", "Year", "Month", "MonthRoman", "Day"];

  router.get("/numbering-rule", async (req: AuthedRequest, res) => {
    try {
      const docTypeId = typeof req.query.docTypeId === "string" ? req.query.docTypeId : undefined;
      res.json(await getActiveNumberingRule(pool, tenantOf(req), docTypeId));
    } catch (err) { fail(res, err, "Gagal memuat format nomor dokumen."); }
  });

  router.put("/numbering-rule", requireRole("admin", "legal"), async (req: AuthedRequest, res) => {
    const errMsg = validateMask(req.body.mask, DCS_MASK_TOKENS);
    if (errMsg) return res.status(400).json({ error: errMsg });
    try {
      const docTypeId = typeof req.body.docTypeId === "string" ? req.body.docTypeId : undefined;
      const rule = await updateActiveNumberingRule(pool, tenantOf(req), { mask: req.body.mask }, docTypeId);
      res.json({ success: true, rule });
    } catch (err) { fail(res, err, "Gagal memperbarui format nomor dokumen."); }
  });

  router.delete("/numbering-rule", requireRole("admin", "legal"), async (req: AuthedRequest, res) => {
    const docTypeId = typeof req.query.docTypeId === "string" ? req.query.docTypeId : undefined;
    if (!docTypeId) return res.status(400).json({ error: "docTypeId wajib diisi untuk mengembalikan ke format default." });
    try {
      await removeNumberingRuleOverride(pool, tenantOf(req), docTypeId);
      res.json({ success: true, rule: await getActiveNumberingRule(pool, tenantOf(req), docTypeId) });
    } catch (err) { fail(res, err, "Gagal mengembalikan format nomor ke default."); }
  });

  // Pratinjau nomor dokumen di form "Buat Dokumen" — locked-but-visible SEBELUM
  // submit, sama seperti /api/contracts/generate-number di modul Kontrak.
  // Read-only (previewDocumentNumberForType TIDAK menaikkan counter).
  router.get("/preview-number", async (req: AuthedRequest, res) => {
    const docTypeCode = typeof req.query.docTypeCode === "string" ? req.query.docTypeCode : "";
    const department = typeof req.query.department === "string" ? req.query.department : "";
    if (!docTypeCode) return res.status(400).json({ error: "docTypeCode wajib diisi." });
    try {
      res.json(await previewDocumentNumberForType(pool, tenantOf(req), docTypeCode, department));
    } catch (err) { fail(res, err, "Gagal menghitung pratinjau nomor dokumen."); }
  });

  // Klausul library — reusable content blocks shareable across MULTIPLE
  // document types (unlike defaultSections, which are per-type stubs). The
  // "pilih klausul" step of the creation wizard reads from here.
  router.get("/clauses", async (req: AuthedRequest, res) => {
    try {
      const docTypeCode = typeof req.query.docTypeCode === "string" ? req.query.docTypeCode : undefined;
      res.json(await listDcsClauses(pool, tenantOf(req), { docTypeCode }));
    } catch (err) { fail(res, err, "Gagal memuat daftar klausul."); }
  });

  router.post("/clauses", requireRole("admin", "legal"), async (req: AuthedRequest, res) => {
    try {
      const { title, content, category, applicableDocTypeCodes, isMandatory, tags } = req.body;
      if (!title || !content) return res.status(400).json({ error: "Judul dan isi klausul wajib diisi" });
      const clause = await createDcsClause(pool, {
        tenantId: tenantOf(req), title, content, category,
        applicableDocTypeCodes: Array.isArray(applicableDocTypeCodes) ? applicableDocTypeCodes : [],
        isMandatory: !!isMandatory, tags: Array.isArray(tags) ? tags : [], createdBy: req.user!.id,
      });
      res.json({ success: true, clause });
    } catch (err) { fail(res, err, "Gagal membuat klausul."); }
  });

  router.put("/clauses/:id", requireRole("admin", "legal"), async (req: AuthedRequest, res) => {
    try {
      const clause = await updateDcsClause(pool, tenantOf(req), req.params.id, req.body);
      if (!clause) return res.status(404).json({ error: "Klausul tidak ditemukan" });
      res.json({ success: true, clause });
    } catch (err) { fail(res, err, "Gagal memperbarui klausul."); }
  });

  router.delete("/clauses/:id", requireRole("admin", "legal"), async (req: AuthedRequest, res) => {
    try { await deactivateDcsClause(pool, tenantOf(req), req.params.id); res.json({ success: true }); }
    catch (err) { fail(res, err, "Gagal menonaktifkan klausul."); }
  });

  // List all controlled documents (with versions) for the virtual tree.
  router.get("/documents", async (req: AuthedRequest, res) => {
    try {
      res.json(await listDocuments(pool, tenantOf(req)));
    } catch (err) { fail(res, err, "Gagal memuat daftar dokumen."); }
  });

  router.get("/documents/:id", async (req: AuthedRequest, res) => {
    try {
      const doc = await getDocumentWithVersions(pool, tenantOf(req), req.params.id);
      if (!doc) return res.status(404).json({ error: "Dokumen tidak ditemukan" });
      res.json(doc);
    } catch (err) { fail(res, err, "Gagal memuat dokumen."); }
  });

  // Create a controlled document + its Terbitan 1 Revisi 0 draft (or a
  // manually-chosen starting number — see initialMajor/initialMinor below).
  router.post("/documents", requireRole("admin", "staff", "legal", "manager"), async (req: AuthedRequest, res) => {
    try {
      const { docTypeCode, department, title, ownerUserId, metadata } = req.body;
      if (!docTypeCode || !department || !title) {
        return res.status(400).json({ error: "docTypeCode, department, dan title wajib diisi" });
      }
      // Opsional: nomor Terbitan/Revisi awal boleh diisi manual (mis. migrasi
      // SOP kertas yang sudah di Revisi 3) — kosong/tidak valid = default 1/0.
      const initialMajor = Number.isInteger(Number(req.body.initialMajor)) && Number(req.body.initialMajor) >= 1
        ? Number(req.body.initialMajor) : undefined;
      const initialMinor = Number.isInteger(Number(req.body.initialMinor)) && Number(req.body.initialMinor) >= 0
        ? Number(req.body.initialMinor) : undefined;
      const result = await createDocumentWithFirstVersion(pool, {
        tenantId: tenantOf(req), docTypeCode, department, title,
        ownerUserId: ownerUserId || req.user!.id, createdBy: req.user!.id, metadata,
        initialMajor, initialMinor,
        manualNumber: typeof req.body.manualNumber === "string" ? req.body.manualNumber : undefined,
      });
      res.json({ success: true, ...result });
    } catch (err) { fail(res, err, "Gagal membuat dokumen."); }
  });

  // New version (revisi = minor+1, terbitan = major+1 & minor reset to 0) —
  // or a manually typed major/minor override; a collision with an existing
  // Terbitan/Revisi on this document comes back as a clean 409 (see fail()).
  router.post("/documents/:id/versions", requireRole("admin", "staff", "legal", "manager"), async (req: AuthedRequest, res) => {
    try {
      const bump = req.body.bump === "terbitan" ? "terbitan" : "revisi";
      const overrideMajor = Number.isInteger(Number(req.body.major)) && Number(req.body.major) >= 1
        ? Number(req.body.major) : undefined;
      const overrideMinor = Number.isInteger(Number(req.body.minor)) && Number(req.body.minor) >= 0
        ? Number(req.body.minor) : undefined;
      const v = await createNextVersion(pool, {
        tenantId: tenantOf(req), documentId: req.params.id, bump,
        createdBy: req.user!.id, changeSummary: req.body.changeSummary,
        overrideMajor, overrideMinor,
      });
      res.json({ success: true, version: v });
    } catch (err) { fail(res, err, "Gagal membuat versi baru."); }
  });

  // Lepas nomor dokumen supaya dipakai dokumen berikutnya (batal terbit).
  // Dokumennya TIDAK dihapus — modul ini menganut supersede-never-delete.
  router.post("/documents/:id/release-number", requireRole("admin", "legal", "manager"), async (req: AuthedRequest, res) => {
    try {
      const result = await releaseDocumentNumber(pool, { tenantId: tenantOf(req), documentId: req.params.id });
      if (result.ok === true) return res.json({ success: true, releasedNumber: result.releasedNumber });
      return res.status(400).json({ error: result.reason });
    } catch (err) { fail(res, err, "Gagal melepas nomor dokumen."); }
  });

  // Upload the clean master PDF for a version (stored clean + hashed).
  router.post("/versions/:vid/file", requireRole("admin", "staff", "legal", "manager"), upload.single("file"), async (req: AuthedRequest, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "Tidak ada berkas" });
      const key = `dcs-${Date.now()}-${req.file.originalname.replace(/[^\w.\-]/g, "_")}`;
      const stored = await storeFile(req.file.buffer, key, req.file.mimetype);
      await attachCleanFile(pool, {
        tenantId: tenantOf(req), versionId: req.params.vid,
        s3Key: stored.key, sha256: sha256(req.file.buffer),
        sizeBytes: req.file.size, mimeType: req.file.mimetype,
      });
      res.json({ success: true });
    } catch (err) { fail(res, err, "Gagal mengunggah berkas."); }
  });

  // Compose a structured draft (purpose/scope/sections + flow diagram) in-app
  // instead of uploading a finished PDF — the natural way to author an SOP/IK/
  // Kebijakan/Memo per ISO 9001, rather than requiring a pre-made file. Renders
  // a PDF via pdf-compose and feeds it into the SAME clean-file pipeline as an
  // upload (hash, store, attach), so everything downstream (approval, sign,
  // watermark) is identical either way. The structured content is preserved in
  // metadata so it can be reopened/edited or carried into the next revision.
  router.post("/versions/:vid/compose", requireRole("admin", "staff", "legal", "manager"), upload.single("flowImage"), async (req: AuthedRequest, res) => {
    try {
      const tid = tenantOf(req);
      const version = await getVersionCore(pool, tid, req.params.vid);
      if (!version) return res.status(404).json({ error: "Versi tidak ditemukan" });
      if (version.status !== "draft") return res.status(409).json({ error: "Konten hanya bisa disusun/diubah selagi versi berstatus Draft." });

      const purpose: string = req.body.purpose || "";
      const scope: string = req.body.scope || "";
      let sections: ComposeSection[] = [];
      try { sections = JSON.parse(req.body.sections || "[]"); } catch { return res.status(400).json({ error: "Format sections tidak valid" }); }
      const flowMode: string = req.body.flowMode || "none";
      let flowSteps: ComposeFlowStep[] = [];
      if (flowMode === "builder") {
        try { flowSteps = JSON.parse(req.body.flowSteps || "[]"); } catch { return res.status(400).json({ error: "Format diagram alir tidak valid" }); }
      }
      let flowLanes: string[] = [];
      try { flowLanes = req.body.flowLanes ? JSON.parse(req.body.flowLanes) : []; } catch { return res.status(400).json({ error: "Format lane diagram alir tidak valid" }); }
      // "diagram" (grafis/swimlane, default) | "table" (gaya Working
      // Instruction — Diagram Alir | Instruksi Kerja | PIC, lihat
      // drawFlowDiagramTable) — sama persis data flowSteps, cuma beda gaya
      // render, jadi user tidak perlu isi ulang.
      const flowDisplayStyle: "diagram" | "table" = req.body.flowDisplayStyle === "table" ? "table" : "diagram";
      let appendix: Array<{ label: string; url: string }> = [];
      try { appendix = req.body.appendix ? JSON.parse(req.body.appendix) : []; } catch { return res.status(400).json({ error: "Format lampiran tidak valid" }); }
      let clauseIds: string[] = [];
      try { clauseIds = req.body.clauseIds ? JSON.parse(req.body.clauseIds) : []; } catch { return res.status(400).json({ error: "Format daftar klausul tidak valid" }); }
      const languageMode: "single" | "multi" = req.body.languageMode === "multi" ? "multi" : "single";

      const flow = flowMode === "builder" && flowSteps.length > 0
        ? { mode: "builder" as const, steps: flowSteps, lanes: flowLanes.length > 0 ? flowLanes : undefined, displayStyle: flowDisplayStyle }
        : flowMode === "image" && req.file
          ? { mode: "image" as const, image: req.file.buffer, mimeType: req.file.mimetype }
          : { mode: "none" as const };

      // Signature layout + letterhead are snapshotted from the doc type's
      // template at compose time — later changes to the template don't
      // retroactively change an already-drafted/approved document.
      const docType = await getDocTypeByCode(pool, tid, version.doc_type_code);
      const baseGroups: SignatureGroup[] = docType?.signatureGroups?.length ? docType.signatureGroups : [{ columns: [{ label: "Disetujui oleh", role: "admin" }] }];

      // Penunjukan penandatangan per-dokumen: array id user berdasar INDEKS
      // KOLOM DATAR (urutan flattenSignatureGroups). Kolom pertama (Penyusun)
      // otomatis ke pemilik dokumen kalau tidak diisi eksplisit. Kolom yang
      // tidak ditunjuk siapa pun tetap jatuh ke gerbang berbasis role (lama).
      let signatureAssignments: string[] = [];
      try { signatureAssignments = req.body.signatureAssignments ? JSON.parse(req.body.signatureAssignments) : []; }
      catch { return res.status(400).json({ error: "Format penunjukan penandatangan tidak valid" }); }
      const ownerRow = await pool.query(`SELECT owner_user_id FROM dcs_documents WHERE id = $1 AND tenant_id = $2`, [version.document_id, tid]);
      const ownerUserId: string | undefined = ownerRow.rows[0]?.owner_user_id || undefined;
      let flatIdx = 0;
      const enrichedBase: SignatureGroup[] = baseGroups.map((g) => ({
        ...g,
        columns: g.columns.map((col) => {
          const assigned = signatureAssignments[flatIdx] || (flatIdx === 0 ? ownerUserId : "");
          flatIdx++;
          return assigned ? { ...col, assignedUserId: assigned } : { ...col };
        }),
      }));

      // Reviewer TAMBAHAN per-dokumen (tombol "+ Tambah Reviewer") — di luar
      // kolom template. Dilampirkan sebagai grup terpisah di Lembar Pengesahan
      // dan ikut alur TTD (sign-approve mengiterasi semua kolom datar). Tiap
      // reviewer wajib punya label; role/assignedUserId opsional.
      let extraReviewers: Array<{ label: string; role?: string; assignedUserId?: string }> = [];
      try { extraReviewers = req.body.extraReviewers ? JSON.parse(req.body.extraReviewers) : []; }
      catch { return res.status(400).json({ error: "Format reviewer tambahan tidak valid" }); }
      const extraColumns: SignatureColumn[] = extraReviewers
        .filter((r) => r && typeof r.label === "string" && r.label.trim())
        .map((r) => ({
          label: r.label.trim(),
          role: typeof r.role === "string" ? r.role : "",
          ...(r.assignedUserId ? { assignedUserId: r.assignedUserId } : {}),
        }));
      const signatureGroups: SignatureGroup[] = extraColumns.length > 0
        ? [...enrichedBase, { heading: "Reviewer Tambahan:", columns: extraColumns }]
        : enrichedBase;

      // Header ISO butuh kop → paksa letterhead tersedia bila headerStyle iso,
      // walau flag letterhead doc-type false (kop kotak ISO memang selalu ada).
      const headerStyle = docType?.headerStyle ?? "iso";
      const letterhead = await resolveLetterhead(tid, headerStyle === "iso" || !!docType?.letterhead);
      const margins = getDcsPageMargins(tid);
      const branding = getCompanyBranding(tid);

      // Revision history is auto-populated from real version rows — no new
      // user input, satisfies the "Riwayat Perubahan" table real SOPs carry.
      const fullDoc = await getDocumentWithVersions(pool, tid, version.document_id);
      const revisionHistory = (fullDoc?.versions ?? [])
        .filter((v) => v.id !== req.params.vid || v.status !== "draft") // a version's own still-being-drafted row has no meaningful effective date yet
        .map((v) => ({ major: v.major, minor: v.minor, changeSummary: v.changeSummary, effectiveAt: v.effectiveAt, createdAt: v.effectiveAt || new Date().toISOString() }))
        .reverse();

      const issued = revisionHistory.find((v) => v.effectiveAt)?.effectiveAt;
      const { bytes, signatureSheetPageIndex, sigLayout, headerLayout } = await composeDocumentPdf({
        documentNumber: version.document_number, title: version.title,
        docTypeCode: version.doc_type_code, department: version.department_id,
        major: version.major_version, minor: version.minor_version,
        purpose, scope, sections, flow, letterhead, signatureGroups,
        // Selalu diteruskan (bisa array kosong) — drawRevisionHistoryTable
        // menangani array kosong dgn kerangka kosong siap-isi, bukan diam-
        // diam absen sampai revisi ke-2 (lihat perbaikan di pdf-compose.ts).
        revisionHistory,
        appendix: appendix.length > 0 ? appendix : undefined,
        margins,
        headerStyle,
        docTypeName: docType?.name || version.doc_type_code,
        documentLevel: docType?.documentLevel,
        processOwner: docType?.processOwner || version.department_id,
        language: languageMode === "multi" ? "Indonesia / English" : "Indonesia",
        issuedDate: issued ? new Date(issued).toLocaleDateString("id-ID") : "-",
        statusLabel: "Draft",
        confidentialityNotice: branding.confidentialityNotice || undefined,
      });
      const buf = Buffer.from(bytes);
      const key = `dcs-compose-${Date.now()}-${req.params.vid}.pdf`;
      const stored = await storeFile(buf, key, "application/pdf");
      await attachCleanFile(pool, { tenantId: tid, versionId: req.params.vid, s3Key: stored.key, sha256: sha256(buf), sizeBytes: buf.length, mimeType: "application/pdf" });
      await saveComposeMetadata(pool, tid, req.params.vid, {
        purpose, scope, sections, flowMode,
        flowSteps: flowMode === "builder" ? flowSteps : [],
        flowLanes, flowDisplayStyle, hasFlowImage: flowMode === "image" && !!req.file,
        signatureColumns: signatureGroups.flatMap((g) => g.columns), signatureGroups, signatureSheetPageIndex, sigLayout, headerLayout,
        appendix, clauseIds, languageMode,
      });

      res.json({ success: true, signatureGroups, languageMode });
    } catch (err) { fail(res, err, "Gagal menyusun dokumen."); }
  });

  router.get("/versions/:vid/compose", async (req: AuthedRequest, res) => {
    try {
      const compose = await getComposeMetadata(pool, tenantOf(req), req.params.vid);
      res.json(compose || null);
    } catch (err) { fail(res, err, "Gagal memuat konten dokumen."); }
  });

  // Produces an English reference copy of a composed version via AI
  // translation — a linked artifact (dcs_document_versions.translated_*),
  // NOT an independently approved/signed version (see plan decision #2:
  // two separate versions, auto-translated, not one interleaved bilingual
  // PDF). Only documents composed in-app have structured content to
  // translate; plain uploads have no source of truth to translate FROM.
  router.post("/versions/:vid/translate", requireRole("admin", "staff", "legal", "manager"), async (req: AuthedRequest, res) => {
    try {
      const tid = tenantOf(req);
      const version = await getVersionCore(pool, tid, req.params.vid);
      if (!version) return res.status(404).json({ error: "Versi tidak ditemukan" });
      const compose = await getComposeMetadata(pool, tid, req.params.vid) as any;
      if (!compose) return res.status(409).json({ error: "Hanya dokumen yang disusun di sistem (bukan unggahan) yang bisa diterjemahkan otomatis." });

      const sourceContent = {
        title: version.title, purpose: compose.purpose || "", scope: compose.scope || "",
        sections: Array.isArray(compose.sections) ? compose.sections : [],
      };
      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: `Anda adalah Penerjemah Tersumpah (Sworn Translator) spesialis dokumen kontrol mutu ISO 9001 (SOP/Instruksi Kerja/Kebijakan/Memo) dari Bahasa Indonesia ke Bahasa Inggris.
        Terjemahkan seluruh isi dokumen berikut ke Bahasa Inggris secara formal dan presisi, pertahankan struktur JSON-nya persis (jumlah dan urutan "sections" harus sama).

        === DOKUMEN SUMBER (JSON) ===
        ${JSON.stringify(sourceContent)}
        === AKHIR DOKUMEN ===

        Balas HANYA dengan JSON berbentuk persis seperti sumber:
        { "title": "...", "purpose": "...", "scope": "...", "sections": [ { "heading": "...", "content": "..." } ] }`,
        config: { responseMimeType: "application/json" },
      });
      const translated = parseAiJson(response.text);

      const docType = await getDocTypeByCode(pool, tid, version.doc_type_code);
      const headerStyle = docType?.headerStyle ?? "iso";
      const letterhead = await resolveLetterhead(tid, headerStyle === "iso" || !!docType?.letterhead);
      const margins = getDcsPageMargins(tid);
      const flowSteps: ComposeFlowStep[] = Array.isArray(compose.flowSteps) ? compose.flowSteps : [];
      const flowLanes: string[] = Array.isArray(compose.flowLanes) ? compose.flowLanes : [];

      const { bytes } = await composeDocumentPdf({
        documentNumber: version.document_number, title: translated.title || version.title,
        docTypeCode: version.doc_type_code, department: version.department_id,
        major: version.major_version, minor: version.minor_version,
        purpose: translated.purpose || "", scope: translated.scope || "",
        sections: Array.isArray(translated.sections) ? translated.sections : [],
        flow: flowSteps.length > 0 ? { mode: "builder", steps: flowSteps, lanes: flowLanes.length > 0 ? flowLanes : undefined } : { mode: "none" },
        letterhead,
        margins,
        headerStyle,
        docTypeName: docType?.name || version.doc_type_code,
        documentLevel: docType?.documentLevel,
        processOwner: docType?.processOwner || version.department_id,
        language: "English",
        statusLabel: "Reference (EN)",
        // Deliberately no signatureGroups/revisionHistory/appendix — this is
        // a reference translation, not a separately-approved controlled copy.
      });
      const buf = Buffer.from(bytes);
      const key = `dcs-translated-${Date.now()}-${req.params.vid}.pdf`;
      const stored = await storeFile(buf, key, "application/pdf");
      await attachTranslatedFile(pool, { tenantId: tid, versionId: req.params.vid, s3Key: stored.key, sha256: sha256(buf), lang: "en" });

      res.json({ success: true, lang: "en" });
    } catch (err) {
      logger.error({ err }, "DCS translate failed");
      aiErrorResponse(res, err, "Gagal menerjemahkan dokumen.");
    }
  });

  // Sets/clears when this document is next due for periodic review — the ISO
  // "dokumen kadaluarsa" reminder, independent of Terbitan/Revisi state.
  // Callable at any lifecycle stage (a schedule set on a draft carries
  // forward once it's effective; can also be adjusted afterward).
  router.put("/versions/:vid/review-schedule", requireRole("admin", "staff", "legal", "manager"), async (req: AuthedRequest, res) => {
    try {
      const reviewDueAt: string | null = req.body.reviewDueAt || null;
      const reviewReminderDays = Number(req.body.reviewReminderDays) || 30;
      await setReviewSchedule(pool, { tenantId: tenantOf(req), versionId: req.params.vid, reviewDueAt, reviewReminderDays });
      res.json({ success: true });
    } catch (err) { fail(res, err, "Gagal menyimpan jadwal tinjau ulang."); }
  });

  // Generic guarded status transition (submit for review, send back to draft).
  // Deliberately open to any authenticated user rather than gated to
  // admin/legal/manager: the person composing a draft is often "staff", and
  // they must be able to submit their own work for review. The state machine
  // (assertTransition) is what actually keeps this safe — an illegal jump
  // like draft -> effective is rejected regardless of who calls this.
  router.post("/versions/:vid/transition", async (req: AuthedRequest, res) => {
    try {
      const tid = tenantOf(req);
      const to = req.body.to as VersionStatus;
      const result = await setVersionStatus(pool, { tenantId: tid, versionId: req.params.vid, to });

      // Baru masuk antrean TTD — beri tahu pemegang role kolom pertama supaya
      // "tidak ada notifikasi untuk ttd" tidak lagi terjadi: giliran pertama
      // harus tahu draft ini sudah menunggu mereka, bukan cuma terlihat kalau
      // kebetulan membuka daftar dokumen.
      if (to === "under_review") {
        const version = await getVersionCore(pool, tid, req.params.vid);
        const compose = await getComposeMetadata(pool, tid, req.params.vid) as any;
        const firstColumn = resolveSignatureColumns(compose)[0];
        if (version && firstColumn) {
          const db = loadDB();
          const recipients = recipientsForColumn(db, tid, firstColumn);
          if (recipients.length > 0) {
            pushDcsNotif(db, tid, {
              title: "Dokumen Menunggu Tanda Tangan",
              message: `${version.document_number} — "${version.title}" diajukan untuk tanda tangan kolom "${firstColumn.label}".`,
              type: "info", dcsDocumentId: version.document_id,
            });
            saveDB(db);
            for (const u of recipients) {
              sendPushToUser(u.id, {
                title: "Menunggu Tanda Tangan Anda",
                body: `${version.document_number} ("${version.title}") menunggu tanda tangan Anda sebagai ${firstColumn.label}.`,
                url: `/?dcsDocument=${version.document_id}`,
                tag: `dcs-${version.document_id}`,
              }).catch((err) => logger.warn({ err }, "Push for DCS submit-review failed"));
            }
          }
        }
      }

      res.json({ success: true, ...result });
    } catch (err) { fail(res, err, "Gagal mengubah status versi."); }
  });

  // Sign & approve ONE column of the document's signature sheet. A composed
  // document (see /compose) prints a "Lembar Pengesahan" with N configurable
  // columns (e.g. Dibuat oleh / Diperiksa oleh / Disetujui oleh); each column
  // must be signed in order by a user matching that column's role before the
  // version can move under_review → approved — this is the "kolom TTD custom"
  // requirement: the number of required signers and who's allowed to sign
  // which slot is entirely driven by the doc type's template, not hardcoded.
  // Plain uploaded PDFs (no compose metadata) fall back to a single generic
  // signature stamped in a fixed spot, matching the old one-shot behavior.
  router.post("/versions/:vid/sign-approve", async (req: AuthedRequest, res) => {
    try {
      const tid = tenantOf(req);
      const { rows } = await pool.query(
        `SELECT v.status, v.document_id, v.clean_file_s3_key, v.clean_file_sha256,
                d.document_number, d.title, d.owner_user_id
           FROM dcs_document_versions v JOIN dcs_documents d ON d.id = v.document_id
          WHERE v.id = $1 AND v.tenant_id = $2`,
        [req.params.vid, tid],
      );
      if (rows.length === 0) return res.status(404).json({ error: "Versi tidak ditemukan" });
      const v = rows[0];
      if (v.status !== "under_review") return res.status(409).json({ error: "Hanya versi berstatus 'Under Review' yang bisa ditandatangani." });
      if (!v.clean_file_s3_key) return res.status(409).json({ error: "Versi ini belum memiliki berkas PDF untuk ditandatangani." });

      const compose = await getComposeMetadata(pool, tid, req.params.vid) as any;
      const columns: SignatureColumn[] = resolveSignatureColumns(compose);
      const groups: SignatureGroup[] = Array.isArray(compose?.signatureGroups) && compose.signatureGroups.length > 0
        ? compose.signatureGroups
        : [{ columns }];
      const pageIndex: number | null = typeof compose?.signatureSheetPageIndex === "number" ? compose.signatureSheetPageIndex : null;
      // Geometri sig sheet yang dipersist saat compose — WAJIB dipakai agar
      // teks TTD jatuh tepat di kotak yang digambar (margin/header bisa custom).
      // Dokumen lama tanpa sigLayout → fillSignatureColumn pakai default lama.
      const sigLayout = compose?.sigLayout && typeof compose.sigLayout === "object" ? compose.sigLayout : undefined;

      const already = await countApprovals(pool, tid, req.params.vid);
      if (already >= columns.length) {
        return res.status(409).json({ error: "Semua kolom tanda tangan pada dokumen ini sudah terisi." });
      }
      const columnIndex = already;
      const column = columns[columnIndex];
      const userRole = req.user!.role;
      const isAdminOverride = userRole === "admin" || userRole === "super_admin";
      if (column.assignedUserId) {
        // Kolom ini ditunjuk ke orang SPESIFIK — hanya dia (atau admin) yang
        // boleh tanda tangan, tidak cukup sekadar punya role yang cocok.
        if (req.user!.id !== column.assignedUserId && !isAdminOverride) {
          return res.status(403).json({ error: `Kolom "${column.label}" ditunjuk untuk penandatangan tertentu — bukan giliran/hak Anda menandatanganinya.` });
        }
      } else if (column.role && userRole !== column.role && !isAdminOverride) {
        return res.status(403).json({ error: `Kolom "${column.label}" memerlukan role "${column.role}" — Anda login sebagai "${userRole}".` });
      }

      const clean = await fetchAndVerifyCleanPdf(v.clean_file_s3_key, v.clean_file_sha256);
      const dateStr = new Date().toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });

      const signed = compose?.signatureColumns || compose?.signatureGroups
        ? Buffer.from(await fillSignatureColumn(clean, groups, pageIndex, columnIndex, req.user!.name, req.user!.role, dateStr, sigLayout))
        : Buffer.from(await injectSignatures(clean, [{
            signerName: req.user!.name, signerRole: req.user!.role,
            approvedAt: new Date().toISOString().slice(0, 10),
            signatureImagePng: null,
            anchor: { page: -1, x: 60, y: 60, w: 170, h: 46 },
          }]));

      const newHash = sha256(signed);
      const newKey = `dcs-signed-${Date.now()}-${req.params.vid}.pdf`;
      const stored = await storeFile(signed, newKey, "application/pdf");
      await attachCleanFile(pool, { tenantId: tid, versionId: req.params.vid, s3Key: stored.key, sha256: newHash, sizeBytes: signed.length, mimeType: "application/pdf" });
      await deleteFile(v.clean_file_s3_key); // remove the pre-signature master (avoid orphan)

      await recordApproval(pool, {
        tenantId: tid, versionId: req.params.vid, stepOrder: columnIndex + 1,
        approverUserId: req.user!.id, approverRole: req.user!.role,
        signedContentSha256: newHash, anchor: { columnIndex, columnLabel: column.label },
      });

      const filled = columnIndex + 1;
      const complete = filled >= columns.length;
      const promoted = false; // rilis TIDAK lagi otomatis — lihat catatan di bawah
      if (complete) {
        await setVersionStatus(pool, { tenantId: tid, versionId: req.params.vid, to: "approved" });
        // RILIS MANUAL/TERJADWAL (dokumen internal): TTD terakhir menuntaskan
        // persetujuan (status 'approved') tapi TIDAK langsung memberlakukan.
        // Document Control memilih memberlakukan sekarang (POST make-effective)
        // atau menjadwalkan tanggal berlaku — sesuai permintaan "tanggal release
        // manual atau terjadwal walau sudah full approval". Cron (reminders.ts)
        // yang mengaktifkan rilis terjadwal saat tanggalnya tiba.
        // Lembar Pengesahan lengkap — beri tahu pembuat dokumen bahwa dokumen
        // siap diberlakukan (bukan diam-diam berubah status).
        if (v.owner_user_id) {
          const db = loadDB();
          pushDcsNotif(db, tid, {
            title: "Dokumen Siap Diberlakukan",
            message: `${v.document_number} — "${v.title}" selesai ditandatangani semua kolom (terakhir: ${req.user!.name}). Menunggu diberlakukan (manual/terjadwal).`,
            type: "success", dcsDocumentId: v.document_id,
          });
          saveDB(db);
          sendPushToUser(v.owner_user_id, {
            title: "Dokumen Siap Diberlakukan",
            body: `"${v.title}" (${v.document_number}) selesai ditandatangani — tinggal diberlakukan sekarang atau dijadwalkan.`,
            url: `/?dcsDocument=${v.document_id}`,
            tag: `dcs-${v.document_id}`,
          }).catch((err) => logger.warn({ err }, "Push for DCS fully-signed failed"));
        }
      } else {
        // Belum lengkap — kolom berikutnya kini menunggu, beri tahu pemegang
        // role-nya (ini persis "notifikasi untuk ttd kepada yang dituju" yang
        // sebelumnya tidak ada sama sekali di modul DCS).
        const nextColumn = columns[columnIndex + 1];
        if (nextColumn) {
          const db = loadDB();
          const recipients = recipientsForColumn(db, tid, nextColumn);
          if (recipients.length > 0) {
            pushDcsNotif(db, tid, {
              title: "Dokumen Menunggu Tanda Tangan",
              message: `${v.document_number} — kolom "${nextColumn.label}" menunggu tanda tangan, setelah ${req.user!.name} menandatangani "${column.label}".`,
              type: "info", dcsDocumentId: v.document_id,
            });
            saveDB(db);
            for (const u of recipients) {
              sendPushToUser(u.id, {
                title: "Menunggu Tanda Tangan Anda",
                body: `${v.document_number} ("${v.title}") menunggu tanda tangan Anda sebagai ${nextColumn.label}.`,
                url: `/?dcsDocument=${v.document_id}`,
                tag: `dcs-${v.document_id}`,
              }).catch((err) => logger.warn({ err }, "Push for DCS next signer failed"));
            }
          }
        }
      }

      res.json({ success: true, columnLabel: column.label, filled, total: columns.length, complete, promoted, integritySha256: newHash });
    } catch (err) {
      if (err instanceof IntegrityError) return res.status(409).json({ error: "Integritas berkas gagal diverifikasi sebelum tanda tangan — dibatalkan." });
      fail(res, err, "Gagal menandatangani & menyetujui versi.");
    }
  });

  router.get("/versions/:vid/approvals", async (req: AuthedRequest, res) => {
    try { res.json(await getApprovals(pool, tenantOf(req), req.params.vid)); }
    catch (err) { fail(res, err, "Gagal memuat data persetujuan."); }
  });

  // Roster per-kolom TTD: gabungan kolom yang dikonfigurasi + approval yang
  // sudah terjadi, jadi kelihatan "kolom mana masih menunggu siapa" — bukan
  // cuma daftar TTD yang sudah selesai seperti /approvals di atas.
  router.get("/versions/:vid/approval-roster", async (req: AuthedRequest, res) => {
    try { res.json(await getApprovalRoster(pool, tenantOf(req), req.params.vid)); }
    catch (err) { fail(res, err, "Gagal memuat roster persetujuan."); }
  });

  // ---- Review annotations (komentar/highlight gaya Word) + loop revisi ----
  // Alur: reviewer/approver menandai bagian yang belum sesuai (komentar,
  // opsional dengan highlight bagian tertentu) SEBELUM tanda tangan. Bila belum
  // sesuai → "Minta Revisi" mengembalikan dokumen ke penyusun (draft) dan
  // mereset tanda tangan. Penyusun memperbaiki, menandai komentar "selesai",
  // lalu mengajukan ulang. Bila sudah sesuai → reviewer tanda tangan (approve)
  // dan lanjut ke reviewer berikutnya, hingga semua kolom lengkap.

  // Validasi anchor komentar (bagian mana yang ditandai). Semua opsional —
  // komentar tanpa anchor dianggap "umum" (general).
  function sanitizeAnchor(raw: any): ReviewCommentAnchor {
    if (!raw || typeof raw !== "object") return { field: "general" };
    const field = ["purpose", "scope", "section", "flow", "general"].includes(raw.field) ? raw.field : "general";
    const a: ReviewCommentAnchor = { field };
    if (field === "section" && Number.isInteger(Number(raw.sectionIndex))) a.sectionIndex = Number(raw.sectionIndex);
    if (typeof raw.sectionHeading === "string") a.sectionHeading = raw.sectionHeading.slice(0, 200);
    if (typeof raw.quote === "string" && raw.quote.trim()) a.quote = raw.quote.slice(0, 500);
    return a;
  }

  router.get("/versions/:vid/comments", async (req: AuthedRequest, res) => {
    try { res.json(await listReviewComments(pool, tenantOf(req), req.params.vid)); }
    catch (err) { fail(res, err, "Gagal memuat komentar review."); }
  });

  // Tambah satu komentar/anotasi. Terbuka untuk pengguna tenant mana pun selama
  // dokumen masih dalam alur penyusunan/review (draft atau under_review) —
  // reviewer menandai, penyusun boleh membalas/mencatat. Tidak mengubah status.
  router.post("/versions/:vid/comments", async (req: AuthedRequest, res) => {
    try {
      const tid = tenantOf(req);
      const body: string = String(req.body?.body || "").trim();
      if (!body) return res.status(400).json({ error: "Isi komentar tidak boleh kosong." });
      const ver = await getVersionOwner(pool, tid, req.params.vid);
      if (!ver) return res.status(404).json({ error: "Versi tidak ditemukan" });
      if (ver.status !== "draft" && ver.status !== "under_review") {
        return res.status(409).json({ error: "Komentar review hanya bisa ditambahkan selama dokumen berstatus Draft atau Under Review." });
      }
      const round = await getVersionReviewRound(pool, tid, req.params.vid);
      const comment = await addReviewComment(pool, {
        tenantId: tid, versionId: req.params.vid,
        authorUserId: req.user!.id, authorName: req.user!.name, authorRole: req.user!.role,
        anchor: sanitizeAnchor(req.body?.anchor), body: body.slice(0, 4000), reviewRound: round,
      });

      // Beri tahu penyusun (pemilik) bila komentator BUKAN dia — supaya tahu ada
      // catatan baru di dokumennya, walau belum sampai "Minta Revisi".
      if (ver.ownerUserId && ver.ownerUserId !== req.user!.id) {
        const db = loadDB();
        pushDcsNotif(db, tid, {
          title: "Komentar Baru pada Dokumen",
          message: `${ver.documentNumber} — ${req.user!.name} menandai bagian yang perlu diperhatikan: "${body.slice(0, 80)}${body.length > 80 ? "…" : ""}"`,
          type: "info", dcsDocumentId: ver.documentId,
        });
        saveDB(db);
        sendPushToUser(ver.ownerUserId, {
          title: "Komentar Review Baru",
          body: `${req.user!.name} memberi catatan pada "${ver.title}" (${ver.documentNumber}).`,
          url: `/?dcsDocument=${ver.documentId}`, tag: `dcs-${ver.documentId}`,
        }).catch((err) => logger.warn({ err }, "Push for DCS new comment failed"));
      }
      res.json({ success: true, comment });
    } catch (err) { fail(res, err, "Gagal menambah komentar review."); }
  });

  // Penyusun menandai sebuah komentar "selesai/OK" setelah memperbaikinya.
  // Hanya pemilik dokumen (penyusun) atau admin yang boleh.
  router.post("/versions/:vid/comments/:cid/resolve", async (req: AuthedRequest, res) => {
    try {
      const tid = tenantOf(req);
      const ver = await getVersionOwner(pool, tid, req.params.vid);
      if (!ver) return res.status(404).json({ error: "Versi tidak ditemukan" });
      const isAdmin = req.user!.role === "admin" || req.user!.role === "super_admin";
      if (req.user!.id !== ver.ownerUserId && !isAdmin) {
        return res.status(403).json({ error: "Hanya penyusun dokumen yang bisa menandai komentar selesai." });
      }
      const resolved = await resolveReviewComment(pool, tid, req.params.cid, { id: req.user!.id, name: req.user!.name });
      if (!resolved) return res.status(404).json({ error: "Komentar tidak ditemukan atau sudah ditandai selesai." });
      const openLeft = await countOpenComments(pool, tid, req.params.vid);
      res.json({ success: true, comment: resolved, openLeft });
    } catch (err) { fail(res, err, "Gagal menandai komentar selesai."); }
  });

  // "Minta Revisi": reviewer yang sedang giliran mengembalikan dokumen ke
  // penyusun. Mereset semua tanda tangan (konten akan berubah → TTD lama tidak
  // sah lagi), menaikkan putaran review, transisi under_review → draft, dan
  // memberi tahu penyusun. Gerbang izin PERSIS seperti sign-approve: hanya
  // penandatangan kolom yang sedang giliran (assigned/role) atau admin.
  router.post("/versions/:vid/request-changes", async (req: AuthedRequest, res) => {
    try {
      const tid = tenantOf(req);
      const ver = await getVersionOwner(pool, tid, req.params.vid);
      if (!ver) return res.status(404).json({ error: "Versi tidak ditemukan" });
      if (ver.status !== "under_review") {
        return res.status(409).json({ error: "Hanya dokumen berstatus Under Review yang bisa diminta revisi." });
      }
      const note: string = String(req.body?.body || "").trim();
      if (!note) return res.status(400).json({ error: "Sertakan alasan/catatan revisi agar penyusun tahu yang harus diperbaiki." });

      const compose = await getComposeMetadata(pool, tid, req.params.vid) as any;
      const columns = resolveSignatureColumns(compose);
      const already = await countApprovals(pool, tid, req.params.vid);
      const currentColumn = columns[already];
      const userRole = req.user!.role;
      const isAdminOverride = userRole === "admin" || userRole === "super_admin";
      if (currentColumn) {
        if (currentColumn.assignedUserId) {
          if (req.user!.id !== currentColumn.assignedUserId && !isAdminOverride) {
            return res.status(403).json({ error: `Kolom "${currentColumn.label}" ditunjuk untuk reviewer tertentu — bukan giliran/hak Anda meminta revisi.` });
          }
        } else if (currentColumn.role && userRole !== currentColumn.role && !isAdminOverride) {
          return res.status(403).json({ error: `Meminta revisi pada kolom "${currentColumn.label}" memerlukan role "${currentColumn.role}".` });
        }
      }

      // 1) simpan catatan revisi sbg komentar (round saat ini)
      const round = await getVersionReviewRound(pool, tid, req.params.vid);
      const comment = await addReviewComment(pool, {
        tenantId: tid, versionId: req.params.vid,
        authorUserId: req.user!.id, authorName: req.user!.name, authorRole: req.user!.role,
        anchor: sanitizeAnchor(req.body?.anchor), body: note.slice(0, 4000), reviewRound: round,
      });
      // 2) reset tanda tangan + naikkan putaran
      const cleared = await clearApprovals(pool, tid, req.params.vid);
      await bumpVersionReviewRound(pool, tid, req.params.vid);
      // 3) kembalikan ke draft (dijaga state-machine: under_review → draft legal)
      await setVersionStatus(pool, { tenantId: tid, versionId: req.params.vid, to: "draft" });

      // 4) beri tahu penyusun
      if (ver.ownerUserId) {
        const db = loadDB();
        pushDcsNotif(db, tid, {
          title: "Dokumen Dikembalikan untuk Revisi",
          message: `${ver.documentNumber} — "${ver.title}" diminta revisi oleh ${req.user!.name}${currentColumn ? ` (${currentColumn.label})` : ""}: "${note.slice(0, 100)}${note.length > 100 ? "…" : ""}". Semua tanda tangan direset; perbaiki lalu ajukan ulang.`,
          type: "warning", dcsDocumentId: ver.documentId,
        });
        saveDB(db);
        sendPushToUser(ver.ownerUserId, {
          title: "Dokumen Diminta Revisi",
          body: `${req.user!.name} meminta perbaikan pada "${ver.title}" (${ver.documentNumber}).`,
          url: `/?dcsDocument=${ver.documentId}`, tag: `dcs-${ver.documentId}`,
        }).catch((err) => logger.warn({ err }, "Push for DCS request-changes failed"));
      }
      res.json({ success: true, comment, signaturesReset: cleared, returnedTo: "draft" });
    } catch (err) { fail(res, err, "Gagal meminta revisi dokumen."); }
  });

  router.get("/versions/:vid/receipts", async (req: AuthedRequest, res) => {
    try { res.json(await getReceipts(pool, tenantOf(req), req.params.vid)); }
    catch (err) { fail(res, err, "Gagal memuat tanda terima."); }
  });

  // Distribute a version to a set of users (creates pending read obligations).
  router.post("/versions/:vid/distribute", requireRole("admin", "legal", "manager"), async (req: AuthedRequest, res) => {
    try {
      const userIds: string[] = Array.isArray(req.body?.userIds) ? req.body.userIds : [];
      if (userIds.length === 0) return res.status(400).json({ error: "Pilih minimal satu penerima" });
      const result = await distributeVersion(pool, {
        tenantId: tenantOf(req), versionId: req.params.vid, distributedBy: req.user!.id,
        userIds, mandatory: req.body?.mandatory !== false,
      });
      res.json({ success: true, ...result });
    } catch (err) { fail(res, err, "Gagal mendistribusikan dokumen."); }
  });

  // Memberlakukan dokumen internal — MANUAL atau TERJADWAL (dokumen full-approval
  // tidak otomatis berlaku, lihat sign-approve). Body opsional `effectiveAt`:
  //   • kosong / tanggal ≤ sekarang → berlakukan SEKARANG (promote → effective,
  //     versi effective lama otomatis superseded/UNCONTROLLED).
  //   • tanggal > sekarang → JADWALKAN (status tetap 'approved', tanggal disimpan;
  //     cron reminders.ts mengaktifkannya saat tiba).
  router.post("/documents/:id/versions/:vid/make-effective", requireRole("admin", "legal", "manager"), async (req: AuthedRequest, res) => {
    try {
      const tid = tenantOf(req);
      const rawWhen = typeof req.body?.effectiveAt === "string" ? req.body.effectiveAt.trim() : "";
      const when = rawWhen ? new Date(rawWhen) : null;
      if (rawWhen && isNaN(when!.getTime())) return res.status(400).json({ error: "Tanggal berlaku tidak valid." });

      // Terjadwal ke masa depan (beri toleransi 1 menit agar "sekarang" tidak
      // salah-jadwal karena beda detik) → simpan jadwal, jangan promote.
      if (when && when.getTime() > Date.now() + 60_000) {
        try {
          await scheduleVersionRelease(pool, { tenantId: tid, versionId: req.params.vid, effectiveAt: when.toISOString() });
        } catch (err: any) {
          // Guard "hanya versi Approved yang bisa dijadwalkan" → 409 dengan pesan jelas, bukan 500.
          return res.status(409).json({ error: String(err?.message || "Gagal menjadwalkan rilis.") });
        }
        const db = loadDB();
        pushDcsNotif(db, tid, {
          title: "Rilis Dokumen Dijadwalkan",
          message: `Dokumen dijadwalkan berlaku otomatis pada ${when.toLocaleDateString("id-ID")}.`,
          type: "info", dcsDocumentId: req.params.id,
        });
        saveDB(db);
        return res.json({ success: true, scheduled: true, effectiveAt: when.toISOString() });
      }

      // Sekarang → promote (tanggal berlaku = tanggal yang diminta bila ada, else now()).
      const result = await promoteVersionToEffective(pool, {
        tenantId: tid, documentId: req.params.id,
        targetVersionId: req.params.vid, actorId: req.user!.id,
        effectiveAt: when ? when.toISOString() : null,
      });
      res.json({ success: true, scheduled: false, ...result });
    } catch (err) { fail(res, err, "Gagal memberlakukan versi."); }
  });

  // Batalkan jadwal rilis — kembali menunggu rilis manual (status tetap approved).
  router.post("/documents/:id/versions/:vid/cancel-release", requireRole("admin", "legal", "manager"), async (req: AuthedRequest, res) => {
    try {
      await cancelVersionRelease(pool, { tenantId: tenantOf(req), versionId: req.params.vid });
      res.json({ success: true });
    } catch (err) { fail(res, err, "Gagal membatalkan jadwal rilis."); }
  });

  // Nonaktifkan (tarik) dokumen Effective tanpa pengganti → OBSOLETE permanen.
  // Watermark otomatis menjadi UNCONTROLLED karena status jadi superseded.
  router.post("/documents/:id/versions/:vid/withdraw", requireRole("admin", "legal", "manager"), async (req: AuthedRequest, res) => {
    try {
      const result = await withdrawEffectiveVersion(pool, {
        tenantId: tenantOf(req), documentId: req.params.id,
        versionId: req.params.vid, actorId: req.user!.id,
      });
      res.json({ success: true, ...result });
    } catch (err) { fail(res, err, "Gagal menonaktifkan dokumen."); }
  });

  // Smart viewer endpoint: fetch clean master → verify integrity → stamp the
  // reactive watermark in-memory → stream. Records the read receipt.
  router.get("/versions/:vid/view", async (req: AuthedRequest, res) => {
    try {
      const tid = tenantOf(req);
      const { rows } = await pool.query(
        `SELECT v.status, v.major_version, v.minor_version, v.clean_file_s3_key, v.clean_file_sha256,
                v.translated_file_s3_key, v.translated_file_sha256, v.review_due_at, v.effective_at,
                v.metadata->'compose'->'headerLayout' AS header_layout, d.document_number
           FROM dcs_document_versions v JOIN dcs_documents d ON d.id = v.document_id
          WHERE v.id = $1 AND v.tenant_id = $2`,
        [req.params.vid, tid],
      );
      if (rows.length === 0) return res.status(404).json({ error: "Versi tidak ditemukan" });
      const v = rows[0];
      const wantsEnglish = req.query.lang === "en";
      if (wantsEnglish && !v.translated_file_s3_key) {
        return res.status(404).json({ error: "Versi bahasa Inggris belum tersedia untuk dokumen ini." });
      }
      const fileKey = wantsEnglish ? v.translated_file_s3_key : v.clean_file_s3_key;
      const fileHash = wantsEnglish ? v.translated_file_sha256 : v.clean_file_sha256;
      if (!fileKey) return res.status(409).json({ error: "Versi ini belum memiliki berkas PDF" });

      const clean = await fetchAndVerifyCleanPdf(fileKey, fileHash);
      const expired = v.status === "effective" && !!v.review_due_at && new Date(v.review_due_at) < new Date();
      // "Tanggal Diterbitkan" reaktif = tanggal efektif versi ini (kalau sudah
      // efektif); "-" selama masih draft/review. Sel kop diisi reaktif memakai
      // header_layout yang dipersist saat compose (null utk dok lama/non-ISO →
      // kop tidak diisi ulang, perilaku lama).
      const stamped = await applyReactiveWatermark(clean, {
        status: v.status,
        viewerName: req.user!.name,
        accessedAt: new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC",
        documentNumber: v.document_number,
        major: v.major_version, minor: v.minor_version,
        expired,
        headerLayout: v.header_layout || null,
        issuedDate: v.effective_at ? new Date(v.effective_at).toLocaleDateString("id-ID") : "-",
      });

      await recordReadReceipt(pool, {
        tenantId: tid, versionId: req.params.vid, userId: req.user!.id,
        ip: req.ip, ua: req.get("user-agent") ?? undefined,
      });

      const buf = Buffer.from(stamped);
      // ?download=1 forces a real Save-As instead of the in-browser viewer —
      // Content-Disposition governs this more reliably across browsers than
      // relying on the frontend <a download> attribute against a PDF URL.
      const disposition = req.query.download === "1" ? "attachment" : "inline";
      const safeFileName = v.document_number.replace(/\//g, "-") + (wantsEnglish ? "-EN" : "");
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Length", buf.length);
      res.setHeader("Content-Disposition", `${disposition}; filename="${safeFileName}.pdf"`);
      res.setHeader("Cache-Control", "no-store, private");
      res.setHeader("X-DCS-Copy-Status", v.status);
      res.end(buf);
    } catch (err) {
      if (err instanceof IntegrityError) {
        return res.status(409).json({ error: "Integritas dokumen gagal diverifikasi — akses diblokir. Hubungi Document Control." });
      }
      fail(res, err, "Gagal menampilkan dokumen.");
    }
  });

  // Explicit acknowledgement (ISO read-and-understood).
  router.post("/versions/:vid/acknowledge", async (req: AuthedRequest, res) => {
    try {
      await recordReadReceipt(pool, {
        tenantId: tenantOf(req), versionId: req.params.vid, userId: req.user!.id,
        ip: req.ip, ua: req.get("user-agent") ?? undefined, acknowledge: true,
      });
      res.json({ success: true });
    } catch (err) { fail(res, err, "Gagal menyimpan konfirmasi baca."); }
  });

  return router;
}

export async function initDcs(pool: Pool): Promise<void> {
  await initDcsSchema(pool);
}

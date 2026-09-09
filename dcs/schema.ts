import type { Pool } from "pg";

// Smart DCS (Document Control System) — normalized schema, run once at startup.
// Idempotent: every statement is IF NOT EXISTS / CREATE OR REPLACE / guarded
// DO-block, so booting against an existing DB is a no-op.
//
// ID TYPE DECISION (integration reality, not the abstract blueprint):
// DCS's OWN primary keys are UUID (we generate them). But every reference to a
// PLATFORM entity — tenant, user, department — is TEXT, because this platform
// uses string ids ('t-01', 'usr-legal') and has no departments table (dept is a
// code). Declaring those UUID (as the Phase 1 draft did) would fail on insert.
const DDL = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE OR REPLACE FUNCTION dcs_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TYPE dcs_version_status AS ENUM ('draft','under_review','approved','effective','superseded');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE dcs_approval_decision AS ENUM ('pending','approved','rejected','delegated');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE dcs_target_scope AS ENUM ('role','department','location','user');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE dcs_receipt_status AS ENUM ('pending','read','acknowledged');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS dcs_document_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_dcs_doctype_code UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS dcs_numbering_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mask TEXT NOT NULL,
  scope_tokens JSONB NOT NULL DEFAULT '["DocType","Department","Year"]'::jsonb,
  doc_type_id UUID REFERENCES dcs_document_types(id) ON DELETE SET NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one override rule per (tenant, doc type) — lets a doc type opt into
-- its own mask (different naming AND an independently-scoped counter, since
-- the counter keys off rule_id) while doc types without a row here simply
-- fall back to the tenant's default rule (doc_type_id IS NULL, unaffected by
-- this index since partial indexes ignore excluded rows).
CREATE UNIQUE INDEX IF NOT EXISTS uq_dcs_numbering_rule_doctype
  ON dcs_numbering_rules (tenant_id, doc_type_id) WHERE doc_type_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS dcs_number_sequences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  rule_id UUID NOT NULL REFERENCES dcs_numbering_rules(id) ON DELETE CASCADE,
  scope_hash TEXT NOT NULL,
  scope_values JSONB NOT NULL DEFAULT '{}'::jsonb,
  current_seq BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_dcs_seq_scope UNIQUE (tenant_id, rule_id, scope_hash)
);

CREATE TABLE IF NOT EXISTS dcs_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  document_number TEXT NOT NULL,
  doc_type_id UUID NOT NULL REFERENCES dcs_document_types(id) ON DELETE RESTRICT,
  department_id TEXT NOT NULL,
  title TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  current_version_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_dcs_document_number UNIQUE (tenant_id, document_number)
);

CREATE TABLE IF NOT EXISTS dcs_document_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  document_id UUID NOT NULL REFERENCES dcs_documents(id) ON DELETE CASCADE,
  major_version INT NOT NULL DEFAULT 1,
  minor_version INT NOT NULL DEFAULT 0,
  status dcs_version_status NOT NULL DEFAULT 'draft',
  clean_file_s3_key TEXT,
  clean_file_sha256 CHAR(64),
  file_size_bytes BIGINT,
  mime_type TEXT DEFAULT 'application/pdf',
  change_summary TEXT,
  effective_at TIMESTAMPTZ,
  superseded_at TIMESTAMPTZ,
  review_due_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_dcs_version_triplet UNIQUE (document_id, major_version, minor_version),
  CONSTRAINT ck_dcs_version_numbers CHECK (major_version >= 1 AND minor_version >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dcs_one_effective_per_doc
  ON dcs_document_versions (document_id) WHERE status = 'effective';

-- English reference copy of a version's ID master, produced on demand via AI
-- translation. Not independently approved/signed — a linked artifact of the
-- same row, mirroring the existing clean_file_s3_key/clean_file_sha256 pair
-- so it reuses the same fetch/verify/watermark/stream pipeline unchanged.
-- Pelepasan nomor: kolam nomor yang dikembalikan karena dokumennya batal
-- terbit, dipakai ulang lebih dulu sebelum counter naik (tidak meninggalkan
-- lubang di urutan). Jejak counter disimpan di dokumennya (rule + scope_hash +
-- seq) supaya pelepasan menyasar baris counter yang PERSIS benar — kalau
-- di-derive ulang saat pelepasan, dokumen yang dibuat Desember lalu dilepas
-- Januari akan jatuh ke scope tahun yang salah.
ALTER TABLE dcs_number_sequences ADD COLUMN IF NOT EXISTS released BIGINT[] NOT NULL DEFAULT '{}';
ALTER TABLE dcs_documents ADD COLUMN IF NOT EXISTS number_seq BIGINT;
ALTER TABLE dcs_documents ADD COLUMN IF NOT EXISTS number_rule_id UUID;
ALTER TABLE dcs_documents ADD COLUMN IF NOT EXISTS number_scope_hash TEXT;

ALTER TABLE dcs_document_versions ADD COLUMN IF NOT EXISTS translated_file_s3_key TEXT;
ALTER TABLE dcs_document_versions ADD COLUMN IF NOT EXISTS translated_file_sha256 CHAR(64);
ALTER TABLE dcs_document_versions ADD COLUMN IF NOT EXISTS translated_lang TEXT;
ALTER TABLE dcs_document_versions ADD COLUMN IF NOT EXISTS translated_at TIMESTAMPTZ;

DO $$ BEGIN
  ALTER TABLE dcs_documents
    ADD CONSTRAINT fk_dcs_documents_current_version
    FOREIGN KEY (current_version_id) REFERENCES dcs_document_versions(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS dcs_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  version_id UUID NOT NULL REFERENCES dcs_document_versions(id) ON DELETE CASCADE,
  step_order INT NOT NULL,
  approver_user_id TEXT NOT NULL,
  approver_role TEXT NOT NULL,
  decision dcs_approval_decision NOT NULL DEFAULT 'pending',
  decided_at TIMESTAMPTZ,
  comment TEXT,
  signature_image_s3_key TEXT,
  signed_content_sha256 CHAR(64),
  signature_algorithm TEXT,
  signature_value TEXT,
  signer_public_key_ref TEXT,
  signature_anchor JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_dcs_approval_step UNIQUE (version_id, step_order)
);

CREATE TABLE IF NOT EXISTS dcs_distributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  version_id UUID NOT NULL REFERENCES dcs_document_versions(id) ON DELETE CASCADE,
  target_scope dcs_target_scope NOT NULL,
  target_ref TEXT,
  target_value TEXT,
  is_mandatory BOOLEAN NOT NULL DEFAULT TRUE,
  distributed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  distributed_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_dcs_target_present CHECK (target_ref IS NOT NULL OR target_value IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS dcs_read_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  version_id UUID NOT NULL REFERENCES dcs_document_versions(id) ON DELETE CASCADE,
  distribution_id UUID REFERENCES dcs_distributions(id) ON DELETE SET NULL,
  user_id TEXT NOT NULL,
  status dcs_receipt_status NOT NULL DEFAULT 'pending',
  read_at TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_dcs_receipt_user_version UNIQUE (version_id, user_id)
);

-- Reusable content blocks ("klausul"), analogous to the Contract module's
-- clauses collection: a separate table (not JSONB on a doc type) because a
-- clause must be shareable across MULTIPLE document types and independently
-- searchable/categorized, which nesting under one type's metadata can't do.
CREATE TABLE IF NOT EXISTS dcs_clauses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'General',
  applicable_doc_type_codes TEXT[] NOT NULL DEFAULT '{}', -- empty = usable by all types
  is_mandatory BOOLEAN NOT NULL DEFAULT FALSE,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dcs_clauses_tenant_category ON dcs_clauses (tenant_id, category);

CREATE INDEX IF NOT EXISTS idx_dcs_documents_tenant ON dcs_documents (tenant_id);
CREATE INDEX IF NOT EXISTS idx_dcs_documents_type_dept ON dcs_documents (tenant_id, doc_type_id, department_id);
CREATE INDEX IF NOT EXISTS idx_dcs_documents_number_trgm ON dcs_documents USING gin (document_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_dcs_documents_title_trgm ON dcs_documents USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_dcs_versions_document ON dcs_document_versions (document_id, major_version DESC, minor_version DESC);
CREATE INDEX IF NOT EXISTS idx_dcs_versions_status ON dcs_document_versions (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_dcs_versions_review_due ON dcs_document_versions (review_due_at) WHERE status = 'effective' AND review_due_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dcs_approvals_pending ON dcs_approvals (approver_user_id, decision) WHERE decision = 'pending';
CREATE INDEX IF NOT EXISTS idx_dcs_distributions_version ON dcs_distributions (version_id);
CREATE INDEX IF NOT EXISTS idx_dcs_receipts_version_status ON dcs_read_receipts (version_id, status);
CREATE INDEX IF NOT EXISTS idx_dcs_sequences_lookup ON dcs_number_sequences (tenant_id, rule_id, scope_hash);

-- Review annotations ("komentar/highlight" gaya Microsoft Word): seorang
-- approver/reviewer menandai bagian dokumen yang belum sesuai SEBELUM
-- menandatangani. Hanya penyusun yang boleh mengedit isi; reviewer hanya
-- berkomentar. Komentar bertahan lintas putaran review (review_round) sebagai
-- benang riwayat, jadi terlihat perbaikan dari revisi ke revisi. anchor
-- menautkan komentar ke bagian konten terstruktur (purpose/scope/section[i])
-- plus kutipan teks yang di-highlight — padanan robust untuk "highlight di
-- Word" pada dokumen yang disusun dari section terstruktur (bukan PDF bebas).
CREATE TABLE IF NOT EXISTS dcs_review_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  version_id UUID NOT NULL REFERENCES dcs_document_versions(id) ON DELETE CASCADE,
  author_user_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  author_role TEXT NOT NULL,
  anchor JSONB NOT NULL DEFAULT '{}'::jsonb,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',          -- open | resolved
  review_round INT NOT NULL DEFAULT 1,
  resolved_by TEXT,
  resolved_by_name TEXT,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dcs_review_comments_version ON dcs_review_comments (version_id, created_at);
CREATE INDEX IF NOT EXISTS idx_dcs_review_comments_open ON dcs_review_comments (version_id, status) WHERE status = 'open';
`;

export async function initDcsSchema(pool: Pool): Promise<void> {
  await pool.query(DDL);
}

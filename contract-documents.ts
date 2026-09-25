import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import type { Contract, ContractVersion, DocumentSource, StoredDocumentFormat, StoredDocumentRef } from "./src/types";
import { fetchFile } from "./storage.js";

// ---------------------------------------------------------------------------
// Helper dokumen kontrak hasil "Upload Dokumen" (documentSource = "upload").
// Dipisah dari server.ts supaya logika sumber dokumen/versi berkas bisa diuji
// & dibaca tanpa menelusuri 6000+ baris route.
// ---------------------------------------------------------------------------

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const DOC_MIME = "application/msword";

/**
 * Sumber dokumen kontrak. Data lama tidak punya field documentSource —
 * diturunkan dari creationMode yang sudah ada sejak awal, jadi kontrak
 * "Buat dari Template" lama tetap "template" dan tidak berubah perilaku.
 */
export function resolveDocumentSource(c: Pick<Contract, "documentSource" | "creationMode">): DocumentSource {
  if (c.documentSource === "upload" || c.documentSource === "template") return c.documentSource;
  return c.creationMode === "upload" ? "upload" : "template";
}

/** Deteksi format dari isi berkas (magic bytes), bukan cuma dari nama/mime klien. */
export function sniffFormat(buf: Buffer, fileName = ""): StoredDocumentFormat | null {
  if (buf.length < 4) return null;
  const ext = path.extname(fileName).toLowerCase();
  if (buf.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    // Zip — .docx adalah zip berisi word/document.xml. Cek sederhana nama
    // entri (ada di central directory sebagai teks polos).
    return buf.includes(Buffer.from("word/document.xml")) || ext === ".docx" ? "docx" : null;
  }
  if (buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) return "doc"; // OLE2 (Word 97-2003)
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image"; // JPEG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image"; // PNG
  return null;
}

export function mimeForFormat(format: StoredDocumentFormat, fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  switch (format) {
    case "pdf": return "application/pdf";
    case "docx": return DOCX_MIME;
    case "doc": return DOC_MIME;
    case "image": return ext === ".png" ? "image/png" : "image/jpeg";
    default: return "application/octet-stream";
  }
}

export function extForFormat(format: StoredDocumentFormat, fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  switch (format) {
    case "pdf": return ".pdf";
    case "docx": return ".docx";
    case "doc": return ".doc";
    case "image": return ext === ".png" ? ".png" : ".jpg";
    default: return ext || ".bin";
  }
}

export function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Nama berkas aman untuk disimpan sebagai metadata (tanpa path/karakter kontrol). */
export function cleanFileName(name: unknown, fallback = "dokumen"): string {
  const base = path.basename(String(name || "")).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (base || fallback).slice(0, 180);
}

export function buildDocumentRef(
  buf: Buffer,
  stored: { url: string; key: string },
  fileName: string,
  format: StoredDocumentFormat,
  uploadedBy?: string,
): StoredDocumentRef {
  return {
    key: stored.key,
    url: stored.url,
    fileName,
    mimeType: mimeForFormat(format, fileName),
    format,
    size: buf.length,
    sha256: sha256Hex(buf),
    uploadedAt: new Date().toISOString(),
    uploadedBy,
  };
}

/**
 * Kontrak upload LAMA (sebelum originalDocument ada) hanya punya
 * masterPdfUrl. Bangun referensi seadanya dari URL itu supaya workspace
 * tetap bisa menampilkan berkasnya. Hanya dipakai kalau belum pernah
 * diaktivasi — setelah aktivasi masterPdfUrl berisi bukti TTD, bukan
 * berkas upload asli.
 */
export function legacyDocumentRef(c: Contract): StoredDocumentRef | undefined {
  if (!c.masterPdfUrl || c.activationProofKey) return undefined;
  let key: string;
  try {
    key = path.basename(c.masterPdfUrl.startsWith("/") ? c.masterPdfUrl : new URL(c.masterPdfUrl).pathname);
  } catch {
    return undefined;
  }
  const ext = path.extname(key).toLowerCase();
  const format: StoredDocumentFormat =
    ext === ".pdf" ? "pdf" : ext === ".docx" ? "docx" : ext === ".doc" ? "doc" : [".jpg", ".jpeg", ".png"].includes(ext) ? "image" : "other";
  return {
    key, url: c.masterPdfUrl, fileName: key, mimeType: mimeForFormat(format, key), format,
    size: 0, sha256: "", uploadedAt: c.createdAt,
  };
}

export function documentVersionsOf(versions: ContractVersion[], contractId: string): ContractVersion[] {
  return versions
    .filter((v) => v.contractId === contractId && v.kind === "document")
    .sort((a, b) => a.version - b.version);
}

/** Baca berkas dari storage — lokal (/uploads/...) atau cloud via key. */
export async function readStoredDocument(ref: StoredDocumentRef, uploadDir: string): Promise<Buffer> {
  if (ref.url.startsWith("/uploads/")) {
    const localPath = path.join(uploadDir, path.basename(ref.url));
    if (!fs.existsSync(localPath)) throw Object.assign(new Error("Berkas tidak ditemukan di server."), { status: 404 });
    return fs.readFileSync(localPath);
  }
  return fetchFile(ref.key);
}

/** Header Content-Disposition yang aman untuk nama berkas non-ASCII. */
export function contentDisposition(kind: "inline" | "attachment", fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

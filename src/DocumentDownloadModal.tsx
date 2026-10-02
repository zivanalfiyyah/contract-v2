// ---------------------------------------------------------------------------
// Pop-up pilihan format unduhan (Word / PDF) untuk dokumen kontrak hasil
// Upload Dokumen. Dipakai oleh dua tempat:
//  - Tombol "Download Dokumen" di toolbar atas (App.tsx)
//  - Tombol "Download" di kartu Dokumen Kontrak (UploadedDocumentWorkspace.tsx)
//
// Prinsip: pop-up ini TIDAK mengubah versi/isi dokumen. Isi yang diunduh
// selalu versi yang sedang aktif/ditampilkan — hanya FORMAT unduhannya yang
// dipilih di sini:
//  - Word  : berkas .docx/.doc yang tersimpan diunduh apa adanya (tanpa
//            konversi).
//  - PDF   : jika sumbernya sudah PDF, diunduh apa adanya. Jika sumbernya
//            .docx, dikonversi ke PDF di server saat itu juga — berkas .docx
//            yang tersimpan tidak berubah. Konversi ini SELALU tersedia
//            (100% npm, gratis, open source): LibreOffice dipakai kalau
//            terpasang (hasil identik tata letak asli); kalau tidak, server
//            otomatis pakai fallback mammoth + pdf-lib (isi teks lengkap,
//            tata letak disederhanakan). Tidak ada instalasi wajib apa pun.
//
// Opsi yang benar-benar tidak mungkin untuk format sumber saat ini (mis. PDF
// untuk berkas gambar) tetap dinonaktifkan dengan keterangan singkat.
// ---------------------------------------------------------------------------
import React from "react";
import { FileText, FileType2, X } from "lucide-react";

export type SourceDocFormat = "pdf" | "docx" | "doc" | "image" | "other" | undefined;

/**
 * Bangun URL unduhan dokumen kontrak untuk format yang dipilih pengguna.
 * `version` boleh "current" (versi aktif) atau nomor versi tertentu.
 */
export function buildDocumentDownloadUrl(
  contractId: string,
  version: number | "current",
  asFormat: "word" | "pdf",
): string {
  const base = `/api/contracts/${contractId}/document?version=${version}&download=1`;
  return asFormat === "pdf" ? `${base}&format=pdf` : base;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Format berkas sumber pada versi yang sedang dipilih untuk diunduh. */
  sourceFormat: SourceDocFormat;
  /**
   * true = server punya LibreOffice, jadi PDF dari .docx akan identik tata
   * letak aslinya. false = PDF tetap bisa diunduh (fallback mammoth+pdf-lib,
   * 100% npm, tanpa instalasi apa pun), hanya tata letaknya disederhanakan
   * jadi teks polos. Dipakai untuk pesan info, BUKAN untuk menonaktifkan PDF.
   */
  officeToPdfAvailable: boolean;
  onPick: (format: "word" | "pdf") => void;
}

export default function DocumentDownloadModal({
  open, onClose, sourceFormat, officeToPdfAvailable, onPick,
}: Props) {
  if (!open) return null;

  const wordEnabled = sourceFormat === "docx" || sourceFormat === "doc";
  // PDF utk sumber .docx SELALU aktif — server otomatis pakai LibreOffice
  // (identik) atau fallback mammoth+pdf-lib (teks polos, tanpa instalasi).
  // .doc lama masih perlu LibreOffice krn fallback hanya membaca .docx.
  const pdfEnabled =
    sourceFormat === "pdf" || sourceFormat === "docx" || (sourceFormat === "doc" && officeToPdfAvailable);
  const pdfSimplified = sourceFormat === "docx" && !officeToPdfAvailable;

  const wordTip = !wordEnabled
    ? "Tidak tersedia untuk berkas ini. Berkas sumbernya PDF — gunakan \"Edit seperti Word\" di riwayat versi bila perlu versi Word."
    : undefined;
  const pdfTip = !pdfEnabled
    ? "Konversi ke PDF untuk berkas Word 97-2003 (.doc) ini belum didukung. Konversi ke .docx dulu (tombol \"Edit Dokumen\"), lalu unduh PDF dari versi itu."
    : (pdfSimplified
        ? "LibreOffice belum terpasang di server, jadi PDF dibuat dgn tata letak sederhana (teks lengkap, tanpa tabel/gambar/format asli)."
        : undefined);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-fadeIn"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Pilih format unduhan dokumen"
    >
      <div
        className="w-full max-w-sm bg-slate-950 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-slate-800 bg-slate-900/50 flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-100">Pilih Format Unduhan</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-100 font-bold cursor-pointer" aria-label="Tutup">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4 space-y-3">
          <p className="text-[11px] text-slate-400">Isi yang diunduh mengikuti versi dokumen yang sedang aktif/ditampilkan.</p>
          <div className="flex flex-col gap-2">
            <button
              type="button"
              disabled={!wordEnabled}
              title={wordTip}
              onClick={() => wordEnabled && onPick("word")}
              className="flex items-center gap-2.5 px-4 py-3 rounded-xl border border-slate-800 bg-slate-900 hover:border-indigo-500/50 hover:bg-slate-900/80 text-slate-200 text-sm font-semibold cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-slate-800 transition"
            >
              <FileType2 className="w-4 h-4 text-sky-400" /> Word (.docx)
            </button>
            <button
              type="button"
              disabled={!pdfEnabled}
              title={pdfTip}
              onClick={() => pdfEnabled && onPick("pdf")}
              className="flex items-center gap-2.5 px-4 py-3 rounded-xl border border-slate-800 bg-slate-900 hover:border-indigo-500/50 hover:bg-slate-900/80 text-slate-200 text-sm font-semibold cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-slate-800 transition"
            >
              <FileText className="w-4 h-4 text-rose-400" /> PDF
              {pdfSimplified && <span className="ml-auto text-[10px] font-normal text-amber-300/90">tata letak sederhana</span>}
            </button>
          </div>
          {pdfSimplified && (
            <p className="text-[10px] text-amber-300/90">LibreOffice belum terpasang di server — PDF berisi teks lengkap tapi tata letaknya disederhanakan (tanpa tabel/gambar/format asli). Pasang LibreOffice di server untuk hasil yang identik dengan aslinya.</p>
          )}
        </div>
      </div>
    </div>
  );
}

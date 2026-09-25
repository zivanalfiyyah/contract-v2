// ---------------------------------------------------------------------------
// Document Workspace — khusus kontrak hasil "Upload Dokumen"
// (documentSource === "upload").
//
// Prinsip: berkas yang diunggah user ADALAH dokumen kontrak utama. Workspace
// ini menampilkan berkas itu apa adanya (layout asli), bisa diedit langsung,
// dan menyimpan setiap perubahan sebagai VERSI BARU — original (versi 0)
// tidak pernah ditimpa. Kontrak "Buat dari Template" tetap memakai editor
// template existing di App.tsx; komponen ini tidak dirender untuk mereka.
//
//  - PDF  : halaman dirender pdf.js (identik dgn PDF asli). SEMUA teks asli di
//           PDF bisa diklik & diketik langsung di posisinya; Save mengubah
//           objek teks di dalam PDF itu sendiri (server, PDFium — lihat
//           pdf-text-edit.ts), bukan gambar/overlay. Plus: tambah teks baru &
//           hapus area (redaksi sungguhan).
//  - DOCX : dirender docx-preview (kop/header, logo, tabel, footer, page
//           break). Editor: ketik langsung, Enter = paragraf baru, Backspace/
//           Delete gabung paragraf, tebal/miring/garis bawah, perataan,
//           tambah/hapus baris tabel. Save menulis perubahan ke XML berkas
//           .docx ASLI (src/docx-patch.ts), part lain disalin apa adanya.
//  - DOC  : dikonversi ke .docx (LibreOffice di server) utk pratinjau & edit;
//           .doc asli tetap tersimpan.
// ---------------------------------------------------------------------------
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Download, Edit3, FileText, History, Loader2, RotateCcw, Save, Type, Upload, X,
  Square, Trash2, AlertTriangle, Lock, ZoomIn, ZoomOut, CheckCircle, Bold, Italic,
  Underline, AlignLeft, AlignCenter, AlignRight, AlignJustify, TableRowsSplit, Rows3, TextCursorInput,
} from "lucide-react";
import type { Contract, ContractVersion, StoredDocumentRef } from "./types";
import {
  loadDocx, bindRenderedParagraphs, renderedChars, renderedAlign, applyPlan, serializeDocx,
  addTableRowAfter, removeTableRow, type ParagraphBinding, type DocxEditPlan, type NewParagraph,
} from "./docx-patch";

type ToastFn = (message: string, type?: "success" | "info" | "warning") => void;
type ConfirmFn = (body: string, opts?: { title?: string; confirmLabel?: string; danger?: boolean }) => Promise<boolean>;

interface Props {
  contract: Contract;
  canEdit: boolean; // kontrak Draft
  canDownload: boolean; // approval matriks selesai (kebijakan unduh existing)
  onContractUpdated: (c: Contract) => void;
  showToast: ToastFn;
  askConfirm: ConfirmFn;
}

interface VersionsResponse {
  currentVersion: number;
  versions: ContractVersion[];
  capabilities?: { docConversion: boolean; pdfTextEdit: boolean };
}

type BuildResult =
  | { kind: "file"; blob: Blob; changes: number }
  | { kind: "pdf-edit"; body: { edits: unknown[]; addTexts: unknown[]; covers: unknown[] }; changes: number };
interface EditorHandle { buildEdited(): Promise<BuildResult> }

function formatLabel(ref?: StoredDocumentRef) {
  switch (ref?.format) {
    case "pdf": return "PDF";
    case "docx": return "Word (.docx)";
    case "doc": return "Word 97-2003 (.doc)";
    case "image": return "Gambar";
    default: return "Berkas";
  }
}

function versionLabel(v: ContractVersion, current: number) {
  const base = v.isOriginal ? "Original" : `Versi ${v.version}`;
  return v.version === current ? `${base} (aktif)` : base;
}

const METHOD_LABEL: Record<string, string> = {
  original: "Unggahan awal",
  "docx-inline": "Diedit di workspace (Word)",
  "pdf-text": "Diedit di workspace (PDF)",
  "pdf-overlay": "Anotasi di workspace (PDF)",
  "revision-upload": "Unggah revisi / kembalikan",
  converted: "Konversi .doc → .docx",
};

function nameForVersion(original: string, version: number, ext: string) {
  const base = original.replace(/\.[^.]+$/, "").replace(/\s*\(v\d+\)$/, "");
  return `${base} (v${version})${ext}`;
}

export default function UploadedDocumentWorkspace({ contract, canEdit, canDownload, onContractUpdated, showToast, askConfirm }: Props) {
  const [versions, setVersions] = useState<ContractVersion[]>([]);
  const [currentVersion, setCurrentVersion] = useState(0);
  const [caps, setCaps] = useState<VersionsResponse["capabilities"]>();
  const [viewVersion, setViewVersion] = useState<number | null>(null);
  const [fileBuf, setFileBuf] = useState<ArrayBuffer | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editMode, setEditMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [comment, setComment] = useState("");
  const [showHistory, setShowHistory] = useState(true);
  const [pendingEdit, setPendingEdit] = useState(false);
  const revisionInputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<EditorHandle>(null);

  const shownVersion = viewVersion ?? currentVersion;
  const shown = versions.find((v) => v.version === shownVersion);
  const shownFile = shown?.file;
  const isViewingCurrent = shownVersion === currentVersion;
  const docAsDocx = shownFile?.format === "doc" && !!caps?.docConversion;
  const viewKind = docAsDocx ? "docx" : shownFile?.format;
  const canEditShown = canEdit && isViewingCurrent && !!shownFile && (shownFile.format === "pdf" || shownFile.format === "docx" || docAsDocx);

  const refreshVersions = useCallback(async () => {
    const r = await fetch(`/api/contracts/${contract.id}/document-versions`);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Gagal memuat versi dokumen");
    const data: VersionsResponse = await r.json();
    setVersions(data.versions);
    setCurrentVersion(data.currentVersion);
    setCaps(data.capabilities);
    return data;
  }, [contract.id]);

  useEffect(() => {
    setViewVersion(null);
    setEditMode(false);
    setDirty(false);
    refreshVersions().catch((e) => { setLoadError(e.message); setLoading(false); });
  }, [contract.id, refreshVersions]);

  // Unduh berkas versi yang sedang ditampilkan (.doc -> pratinjau .docx).
  useEffect(() => {
    if (!versions.length || !shownFile) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setFileBuf(null);
    fetch(`/api/contracts/${contract.id}/document?version=${shownVersion}${docAsDocx ? "&as=docx" : ""}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Gagal membuka dokumen (HTTP ${r.status})`);
        return r.arrayBuffer();
      })
      .then((buf) => { if (!cancelled) setFileBuf(buf); })
      .catch((e) => { if (!cancelled) setLoadError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [contract.id, shownVersion, versions.length, docAsDocx, shownFile?.key]);

  // Setelah konversi .doc selesai & versi .docx baru termuat -> masuk mode edit.
  useEffect(() => {
    if (pendingEdit && fileBuf && shownFile?.format === "docx") { setPendingEdit(false); setEditMode(true); }
  }, [pendingEdit, fileBuf, shownFile?.format]);

  const markDirty = useCallback(() => setDirty(true), []);

  const confirmDiscard = async () => {
    if (!editMode || !dirty) return true;
    return askConfirm("Perubahan yang belum disimpan akan dibuang. Lanjutkan?", { title: "Buang Perubahan", confirmLabel: "Buang", danger: true });
  };

  const handleCancel = async () => {
    if (!(await confirmDiscard())) return;
    setEditMode(false);
    setDirty(false);
    setComment("");
    setFileBuf((b) => (b ? b.slice(0) : b)); // render ulang dari berkas, buang editan
  };

  const afterNewVersion = async (data: any) => {
    onContractUpdated(data.contract);
    await refreshVersions();
    setViewVersion(null);
    return data.version as ContractVersion;
  };

  const postJson = async (url: string, body: unknown) => {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.success) throw new Error(data.error || "Permintaan gagal");
    return data;
  };

  const uploadVersion = async (blob: Blob, fileName: string, editMethod: string, note: string) => {
    const fd = new FormData();
    fd.append("file", blob, fileName);
    fd.append("comment", note);
    fd.append("baseVersion", String(currentVersion));
    fd.append("editMethod", editMethod);
    const r = await fetch(`/api/contracts/${contract.id}/document-versions`, { method: "POST", body: fd });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.success) throw new Error(data.error || "Gagal menyimpan versi baru");
    return afterNewVersion(data);
  };

  const startEdit = async () => {
    if (shownFile?.format === "doc") {
      // .doc tidak bisa diedit langsung -> jadikan .docx sbg versi baru dulu.
      setSaving(true);
      try {
        const data = await postJson(`/api/contracts/${contract.id}/document-versions/convert`, {});
        await afterNewVersion(data);
        setPendingEdit(true);
        showToast(`Dikonversi ke .docx sebagai Versi ${data.version.version} — berkas .doc asli tetap tersimpan.`, "success");
      } catch (e: any) {
        showToast(e.message, "warning");
      } finally { setSaving(false); }
      return;
    }
    setEditMode(true);
    setDirty(false);
  };

  const handleSave = async () => {
    if (!shownFile || !fileBuf || !editorRef.current) return;
    setSaving(true);
    try {
      const result = await editorRef.current.buildEdited();
      if (result.changes === 0) {
        showToast("Tidak ada perubahan untuk disimpan.", "info");
        return;
      }
      const note = comment.trim();
      let ver: ContractVersion;
      if (result.kind === "pdf-edit") {
        const data = await postJson(`/api/contracts/${contract.id}/document-versions/pdf-edit`, { ...result.body, baseVersion: currentVersion, comment: note });
        ver = await afterNewVersion(data);
        if (data.fallbackLines) {
          showToast(`${data.fallbackLines} baris memakai font standar yang paling mirip karena huruf barunya tidak tersedia di font asli PDF.`, "info");
        }
      } else {
        const nextNum = versions.length ? Math.max(...versions.map((v) => v.version)) + 1 : 1;
        ver = await uploadVersion(
          result.blob,
          nameForVersion(versions.find((v) => v.isOriginal)?.file?.fileName || shownFile.fileName, nextNum, ".docx"),
          "docx-inline",
          note || `${result.changes} perubahan dari ${shown?.isOriginal ? "original" : `versi ${shownVersion}`}`,
        );
      }
      setEditMode(false);
      setDirty(false);
      setComment("");
      showToast(`Tersimpan sebagai Versi ${ver.version}. Original tetap utuh.`, "success");
    } catch (e: any) {
      showToast(e.message || "Gagal menyimpan", "warning");
    } finally {
      setSaving(false);
    }
  };

  const handleRevisionFile = async (file: File | null) => {
    if (!file) return;
    if (!(await confirmDiscard())) return;
    setSaving(true);
    try {
      const ver = await uploadVersion(file, file.name, "revision-upload", comment.trim() || `Revisi diunggah: ${file.name}`);
      setEditMode(false);
      setDirty(false);
      setComment("");
      showToast(`Revisi tersimpan sebagai Versi ${ver.version}.`, "success");
    } catch (e: any) {
      showToast(e.message || "Gagal mengunggah revisi", "warning");
    } finally {
      setSaving(false);
      if (revisionInputRef.current) revisionInputRef.current.value = "";
    }
  };

  const handleRestore = async (v: ContractVersion) => {
    const ok = await askConfirm(
      `Jadikan isi ${v.isOriginal ? "Original" : `Versi ${v.version}`} sebagai versi aktif? Ini membuat versi BARU — riwayat versi lain tetap tersimpan.`,
      { title: "Kembalikan Versi", confirmLabel: "Kembalikan" },
    );
    if (!ok) return;
    try {
      const data = await postJson(`/api/contracts/${contract.id}/document-versions/${v.version}/restore`, {});
      await afterNewVersion(data);
      showToast(`Isi ${v.isOriginal ? "Original" : `Versi ${v.version}`} kini aktif sebagai Versi ${data.version.version}.`, "success");
    } catch (e: any) {
      showToast(e.message, "warning");
    }
  };

  const selectVersion = async (n: number) => {
    if (n === shownVersion) return;
    if (!(await confirmDiscard())) return;
    setEditMode(false);
    setDirty(false);
    setViewVersion(n === currentVersion ? null : n);
  };

  const downloadHref = `/api/contracts/${contract.id}/document?version=${shownVersion}&download=1`;

  return (
    <div className="xl:col-span-12 bg-slate-950 rounded-2xl border border-slate-800 p-6 space-y-4 shadow-2xl" data-testid="uploaded-document-workspace">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-slate-850">
        <div className="min-w-0">
          <h3 className="font-bold text-sm tracking-wide flex items-center gap-1.5 text-slate-300">
            <FileText className="text-indigo-400 w-4 h-4" />
            DOKUMEN KONTRAK (UPLOAD) — LAYOUT ASLI
          </h3>
          <p className="text-[11px] text-slate-500 mt-0.5 truncate" data-testid="document-meta">
            {shownFile ? <>{shownFile.fileName} · {formatLabel(shownFile)}{shownFile.size ? ` · ${(shownFile.size / 1024).toFixed(0)} KB` : ""}</> : "—"}
            {shown && <> · <span className={isViewingCurrent ? "text-emerald-400" : "text-amber-400"}>{versionLabel(shown, currentVersion)}</span></>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={shownVersion}
            onChange={(e) => selectVersion(Number(e.target.value))}
            className="bg-slate-900 border border-slate-800 rounded-lg text-[11px] text-slate-200 px-2 py-1.5"
            title="Pilih versi dokumen yang ditampilkan"
            aria-label="Versi dokumen"
          >
            {[...versions].reverse().map((v) => (
              <option key={v.id} value={v.version}>{versionLabel(v, currentVersion)}</option>
            ))}
          </select>
          {!editMode && canEditShown && (
            <button type="button" onClick={startEdit} disabled={saving || loading}
              className="px-3 py-1.5 text-[11px] font-bold rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white flex items-center gap-1.5 cursor-pointer disabled:opacity-50">
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Edit3 className="w-3.5 h-3.5" />} Edit Dokumen
            </button>
          )}
          {editMode && (
            <>
              <input
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Catatan versi (opsional)"
                className="bg-slate-900 border border-slate-800 rounded-lg text-[11px] text-slate-200 px-2 py-1.5 w-48"
              />
              <button type="button" onClick={handleSave} disabled={saving}
                className="px-3 py-1.5 text-[11px] font-bold rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white flex items-center gap-1.5 disabled:opacity-50 cursor-pointer">
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save (versi baru)
              </button>
              <button type="button" onClick={handleCancel} disabled={saving}
                className="px-3 py-1.5 text-[11px] font-bold rounded-lg border bg-slate-900 border-slate-800 text-slate-300 hover:border-rose-500/50 flex items-center gap-1.5 cursor-pointer">
                <X className="w-3.5 h-3.5" /> Cancel
              </button>
            </>
          )}
          {canEdit && isViewingCurrent && !editMode && (
            <>
              <input ref={revisionInputRef} type="file" accept=".pdf,.docx,.doc,.jpg,.jpeg,.png" className="hidden"
                onChange={(e) => handleRevisionFile(e.target.files?.[0] || null)} />
              <button type="button" onClick={() => revisionInputRef.current?.click()} disabled={saving}
                title="Edit di Word/aplikasi lain lalu unggah hasilnya — disimpan sebagai versi baru."
                className="px-3 py-1.5 text-[11px] font-bold rounded-lg border bg-slate-900 border-slate-800 text-slate-300 hover:border-indigo-500/50 flex items-center gap-1.5 cursor-pointer">
                <Upload className="w-3.5 h-3.5" /> Unggah Revisi
              </button>
            </>
          )}
          {canEdit && !isViewingCurrent && shown && (
            <button type="button" onClick={() => handleRestore(shown)}
              className="px-3 py-1.5 text-[11px] font-bold rounded-lg border bg-amber-500/10 border-amber-500/30 text-amber-300 flex items-center gap-1.5 cursor-pointer">
              <RotateCcw className="w-3.5 h-3.5" /> Jadikan Versi Aktif
            </button>
          )}
          {canDownload ? (
            <a href={downloadHref} className="px-3 py-1.5 text-[11px] font-bold rounded-lg border bg-slate-900 border-slate-800 text-slate-200 hover:border-indigo-500/50 flex items-center gap-1.5">
              <Download className="w-3.5 h-3.5" /> Download
            </a>
          ) : (
            <span title="Tersedia setelah approval matriks selesai (status FullyApproved ke atas) — kebijakan unduh yang sama dengan Export PDF."
              className="px-3 py-1.5 text-[11px] font-bold rounded-lg border bg-slate-900 border-slate-850 text-slate-600 flex items-center gap-1.5 cursor-not-allowed">
              <Lock className="w-3.5 h-3.5" /> Download
            </span>
          )}
          <button type="button" onClick={() => setShowHistory((v) => !v)}
            className={`px-3 py-1.5 text-[11px] font-bold rounded-lg border flex items-center gap-1.5 cursor-pointer ${showHistory ? "bg-indigo-600 border-indigo-500 text-white" : "bg-slate-900 border-slate-800 text-slate-300"}`}>
            <History className="w-3.5 h-3.5" /> Versi ({versions.length})
          </button>
        </div>
      </div>

      {!canEdit && (
        <p className="text-[11px] text-slate-500 flex items-center gap-1.5"><Lock className="w-3 h-3" /> Status {contract.status}: dokumen terkunci dari perubahan (hanya bisa diubah saat Draft).</p>
      )}
      {!isViewingCurrent && (
        <p className="text-[11px] text-amber-300/90 flex items-center gap-1.5"><AlertTriangle className="w-3 h-3" /> Anda melihat versi lama (read-only). Versi aktif: {currentVersion === 0 ? "Original" : `Versi ${currentVersion}`}.</p>
      )}
      {docAsDocx && !editMode && (
        <p className="text-[11px] text-sky-300/90">Berkas Word 97-2003 (.doc) ditampilkan lewat konversi ke .docx. Klik "Edit Dokumen" untuk membuat versi .docx yang bisa diedit — berkas .doc asli tetap tersimpan.</p>
      )}

      <div className={`grid gap-4 ${showHistory ? "xl:grid-cols-[1fr_280px]" : "grid-cols-1"}`}>
        {/* Viewer / editor */}
        <div className="bg-slate-800/60 rounded-xl border border-slate-850 overflow-auto max-h-[80vh] min-h-[320px] relative" data-testid="document-viewer">
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center text-slate-400 text-xs gap-2"><Loader2 className="w-4 h-4 animate-spin" /> {docAsDocx ? "Mengonversi & memuat dokumen…" : "Memuat dokumen…"}</div>
          )}
          {loadError && !loading && (
            <div className="p-6 text-xs text-rose-300 flex items-start gap-2"><AlertTriangle className="w-4 h-4 shrink-0" /> {loadError}</div>
          )}
          {!loading && !loadError && fileBuf && shownFile && (
            viewKind === "pdf" ? (
              <PdfDocumentView ref={editorRef} key={`${shownVersion}`} contractId={contract.id} version={shownVersion} data={fileBuf} editMode={editMode} onDirty={markDirty} />
            ) : viewKind === "docx" ? (
              <DocxDocumentView ref={editorRef} key={`${shownVersion}-${shownFile.format}`} data={fileBuf} editMode={editMode && shownFile.format === "docx"} onDirty={markDirty} />
            ) : viewKind === "image" ? (
              <div className="p-4 flex justify-center"><ImageView data={fileBuf} mime={shownFile.mimeType} /></div>
            ) : (
              <div className="p-8 text-center text-xs text-slate-300 space-y-2">
                <FileText className="w-8 h-8 mx-auto text-slate-500" />
                <p>Berkas {formatLabel(shownFile)} belum bisa dipratinjau karena konverter dokumen (LibreOffice) belum terpasang di server.</p>
                <p className="text-slate-500">Pasang LibreOffice di server (atau set <code>LIBREOFFICE_PATH</code>) lalu muat ulang — dokumen .doc akan otomatis bisa dipratinjau & diedit. Berkas asli tetap tersimpan utuh.</p>
              </div>
            )
          )}
        </div>

        {/* Riwayat versi */}
        {showHistory && (
          <aside className="bg-slate-900 rounded-xl border border-slate-800 p-3 space-y-2 max-h-[80vh] overflow-y-auto" data-testid="document-versions">
            <h4 className="text-[11px] font-bold text-slate-300 flex items-center gap-1.5"><History className="w-3.5 h-3.5 text-indigo-400" /> Riwayat Versi Dokumen</h4>
            <p className="text-[10px] text-slate-500">Original tidak pernah ditimpa. Setiap Save membuat versi baru.</p>
            {[...versions].reverse().map((v) => (
              <div key={v.id} role="button" tabIndex={0} onClick={() => selectVersion(v.version)}
                onKeyDown={(e) => { if (e.key === "Enter") selectVersion(v.version); }}
                className={`w-full text-left p-2 rounded-lg border transition cursor-pointer ${v.version === shownVersion ? "border-indigo-500/60 bg-indigo-500/10" : "border-slate-800 bg-slate-950 hover:border-slate-700"}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-bold text-slate-200">{v.isOriginal ? "Original" : `Versi ${v.version}`}</span>
                  {v.version === currentVersion && <span className="text-[9px] font-bold uppercase text-emerald-400 flex items-center gap-0.5"><CheckCircle className="w-3 h-3" /> aktif</span>}
                </div>
                <p className="text-[10px] text-slate-400 truncate">{v.file?.fileName}</p>
                <p className="text-[10px] text-slate-500">{new Date(v.updatedAt).toLocaleString("id-ID")}{v.updatedBy ? ` · ${v.updatedBy}` : ""}</p>
                <p className="text-[10px] text-slate-500">{METHOD_LABEL[v.editMethod || ""] || ""}{typeof v.basedOnVersion === "number" ? ` · dari ${v.basedOnVersion === 0 ? "original" : `v${v.basedOnVersion}`}` : ""}</p>
                {v.comment && <p className="text-[10px] text-slate-400 italic mt-0.5">"{v.comment}"</p>}
                {v.sourceFile && canDownload && (
                  <a href={`/api/contracts/${contract.id}/document?version=${v.version}&source=1&download=1`} onClick={(e) => e.stopPropagation()}
                    className="text-[10px] text-indigo-400 hover:text-indigo-300 underline">Unduh berkas asli ({v.sourceFile.fileName})</a>
                )}
              </div>
            ))}
          </aside>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Gambar
// ---------------------------------------------------------------------------
function ImageView({ data, mime }: { data: ArrayBuffer; mime: string }) {
  const url = useMemo(() => URL.createObjectURL(new Blob([data], { type: mime })), [data, mime]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return <img src={url} alt="Dokumen kontrak" className="max-w-full bg-white shadow-lg" />;
}

// Tombol toolbar: onMouseDown preventDefault supaya seleksi di dokumen tidak hilang.
function TBtn({ onClick, title, children, disabled }: { onClick: () => void; title: string; children: React.ReactNode; disabled?: boolean }) {
  return (
    <button type="button" title={title} aria-label={title} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={onClick}
      className="h-7 min-w-[28px] px-1.5 rounded-md text-slate-300 hover:bg-indigo-500/15 hover:text-indigo-300 flex items-center justify-center gap-1 text-[11px] font-semibold disabled:opacity-40 cursor-pointer">
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// DOCX editor
// ---------------------------------------------------------------------------
const HOST_SEL = "[data-docx-host]";

function hostOfSelection(root: HTMLElement | null): HTMLElement | null {
  const sel = window.getSelection();
  const n = sel?.anchorNode;
  const el = n ? (n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement) : null;
  const host = el?.closest(HOST_SEL) as HTMLElement | null;
  return host && root?.contains(host) ? host : null;
}

function caretIsAt(host: HTMLElement, edge: "start" | "end"): boolean {
  const sel = window.getSelection();
  if (!sel || !sel.isCollapsed || !sel.anchorNode) return false;
  const r = document.createRange();
  if (edge === "start") { r.setStart(host, 0); r.setEnd(sel.anchorNode, sel.anchorOffset); }
  else { r.setStart(sel.anchorNode, sel.anchorOffset); r.setEnd(host, host.childNodes.length); }
  const frag = r.cloneContents();
  // <br> penjaga di akhir paragraf tidak dihitung sbg isi.
  const brs = frag.querySelectorAll("br").length;
  return (frag.textContent || "").replace(/​/g, "") === "" && (edge === "end" ? brs <= 1 : brs === 0) && !frag.querySelector("img");
}

function placeCaret(node: Node, offset: number) {
  const sel = window.getSelection();
  if (!sel) return;
  const r = document.createRange();
  r.setStart(node, offset);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}

function stripTrailingGuard(t: { text: string; attrs: number[] }, original?: string) {
  if (t.text.endsWith("\n") && !(original ?? "").endsWith("\n")) return { text: t.text.slice(0, -1), attrs: t.attrs.slice(0, -1) };
  return t;
}

const DocxDocumentView = React.forwardRef<EditorHandle, { data: ArrayBuffer; editMode: boolean; onDirty: () => void }>(
  function DocxDocumentView({ data, editMode, onDirty }, ref) {
    const bodyRef = useRef<HTMLDivElement>(null);
    const styleRef = useRef<HTMLDivElement>(null);
    const bindingsRef = useRef<ParagraphBinding[]>([]);
    const structuralOps = useRef(0);
    // Berkas kerja: berubah saat operasi struktur (tambah/hapus baris tabel).
    const [working, setWorking] = useState<ArrayBuffer>(data);
    const [renderError, setRenderError] = useState<string | null>(null);
    const [rendered, setRendered] = useState(0);
    const [bindStats, setBindStats] = useState<{ bound: number; total: number } | null>(null);
    const [busy, setBusy] = useState(false);
    const onDirtyRef = useRef(onDirty);
    onDirtyRef.current = onDirty;

    useEffect(() => { setWorking(data); structuralOps.current = 0; }, [data]);
    useEffect(() => { if (!editMode) { setWorking(data); structuralOps.current = 0; } }, [editMode, data]);

    useEffect(() => {
      let cancelled = false;
      (async () => {
        try {
          const { renderAsync } = await import("docx-preview");
          if (!bodyRef.current || !styleRef.current) return;
          bodyRef.current.innerHTML = "";
          styleRef.current.innerHTML = "";
          await renderAsync(working.slice(0), bodyRef.current, styleRef.current, {
            className: "docx", inWrapper: true, ignoreWidth: false, ignoreHeight: false, breakPages: true,
            renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true,
            useBase64URL: true, experimental: true,
          });
          if (!cancelled) setRendered((n) => n + 1);
        } catch (e: any) {
          console.error(e);
          if (!cancelled) setRenderError("Gagal merender dokumen Word ini. Berkas asli tetap tersimpan — silakan unduh untuk membukanya.");
        }
      })();
      return () => { cancelled = true; };
    }, [working]);

    // Pasang host editable pada paragraf yang terikat ke XML.
    const attachHost = useCallback((el: HTMLElement, cleanups: (() => void)[]) => {
      el.setAttribute("contenteditable", "true");
      el.setAttribute("spellcheck", "false");
      el.classList.add("docx-editable-p");
      el.querySelectorAll(".docx-tab-stop, img, svg").forEach((n) => (n as HTMLElement).setAttribute("contenteditable", "false"));
      const root = bodyRef.current!;
      const hosts = () => Array.from(root.querySelectorAll(HOST_SEL)) as HTMLElement[];
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key === "Enter" && ev.shiftKey) { ev.preventDefault(); document.execCommand("insertLineBreak"); return; }
        if (ev.key === "Enter") {
          // Paragraf baru: pecah paragraf di posisi kursor (format span ikut).
          ev.preventDefault();
          const sel = window.getSelection();
          if (!sel || !sel.rangeCount) return;
          const r = sel.getRangeAt(0);
          if (!r.collapsed) r.deleteContents();
          const tail = document.createRange();
          tail.setStart(r.startContainer, r.startOffset);
          tail.setEnd(el, el.childNodes.length);
          const frag = tail.extractContents();
          const np = document.createElement("p");
          np.className = el.className;
          const st = el.getAttribute("style");
          if (st) np.setAttribute("style", st);
          np.setAttribute("data-docx-host", "n");
          np.appendChild(frag);
          if (!np.textContent) np.innerHTML = "<br>";
          if (!el.textContent && !el.querySelector("br")) el.innerHTML = "<br>";
          el.parentNode!.insertBefore(np, el.nextSibling);
          attachHost(np, cleanups);
          np.focus();
          placeCaret(np, 0);
          onDirtyRef.current();
          return;
        }
        if ((ev.key === "Backspace" && caretIsAt(el, "start")) || (ev.key === "Delete" && caretIsAt(el, "end"))) {
          const list = hosts();
          const i = list.indexOf(el);
          const [into, from] = ev.key === "Backspace" ? [list[i - 1], el] : [el, list[i + 1]];
          if (!into || !from || into.parentElement !== from.parentElement) return;
          ev.preventDefault();
          // Buang <br> penjaga di ujung paragraf tujuan sebelum digabung.
          const last = into.lastChild;
          if (last && last.nodeName === "BR") into.removeChild(last);
          const joinAt = into.childNodes.length;
          while (from.firstChild) into.appendChild(from.firstChild);
          from.remove();
          into.focus();
          placeCaret(into, Math.min(joinAt, into.childNodes.length));
          onDirtyRef.current();
        }
      };
      const onPaste = (ev: ClipboardEvent) => {
        ev.preventDefault();
        const text = (ev.clipboardData?.getData("text/plain") || "").replace(/\r\n?/g, "\n");
        text.split("\n").forEach((line, i) => {
          if (i > 0) document.execCommand("insertLineBreak");
          if (line) document.execCommand("insertText", false, line);
        });
      };
      const onInput = () => onDirtyRef.current();
      el.addEventListener("keydown", onKey);
      el.addEventListener("paste", onPaste);
      el.addEventListener("input", onInput);
      cleanups.push(() => {
        el.removeEventListener("keydown", onKey);
        el.removeEventListener("paste", onPaste);
        el.removeEventListener("input", onInput);
        el.removeAttribute("contenteditable");
        el.classList.remove("docx-editable-p");
      });
    }, []);

    useEffect(() => {
      const root = bodyRef.current;
      if (!root || !rendered) return;
      if (!editMode) { bindingsRef.current = []; setBindStats(null); return; }
      let cancelled = false;
      const cleanups: (() => void)[] = [];
      (async () => {
        const model = await loadDocx(working.slice(0));
        if (cancelled) return;
        const binds = bindRenderedParagraphs(root, model);
        bindingsRef.current = binds;
        setBindStats({ bound: binds.length, total: model.paragraphs.length });
        for (const b of binds) {
          b.el.setAttribute("data-docx-host", "b");
          b.el.setAttribute("data-pidx", String(b.index));
          attachHost(b.el, cleanups);
        }
      })().catch((e) => console.error("Gagal menyiapkan edit DOCX", e));
      return () => { cancelled = true; cleanups.forEach((f) => f()); };
    }, [editMode, rendered, working, attachHost]);

    // Rencana edit dari keadaan DOM saat ini (relatif terhadap berkas kerja).
    const collectPlan = useCallback((): DocxEditPlan => {
      const root = bodyRef.current!;
      const byIndex = new Map<number, ParagraphBinding>(bindingsRef.current.map((b) => [b.index, b] as [number, ParagraphBinding]));
      const plan: DocxEditPlan = { edits: [], deleted: [], inserts: [] };
      const seen = new Set<number>();
      let lastBound = -1;
      let before: NewParagraph[] = [];
      let group: DocxEditPlan["inserts"][number] | null = null;
      for (const el of Array.from(root.querySelectorAll(HOST_SEL)) as HTMLElement[]) {
        if (el.getAttribute("data-docx-host") === "b") {
          const idx = Number(el.getAttribute("data-pidx"));
          const b = byIndex.get(idx);
          if (!b) continue;
          seen.add(idx);
          if (before.length) {
            plan.inserts.push({ afterIndex: -1, anchorIndex: idx, baseAttr: b.attrs[0] ?? 0, paragraphs: before });
            before = [];
          }
          lastBound = idx;
          group = null;
          const now = stripTrailingGuard(renderedChars(el), b.original);
          const align = el.style.textAlign || "";
          const alignChanged = !!align && renderedAlign(el) !== b.align;
          if (now.text !== b.original || now.attrs.some((a, k) => a !== b.attrs[k]) || alignChanged) {
            plan.edits.push({ index: idx, oldText: b.original, newText: now.text, oldAttrs: b.attrs, newAttrs: now.attrs, oldAlign: b.align, newAlign: alignChanged ? renderedAlign(el) : b.align });
          }
        } else {
          const c = stripTrailingGuard(renderedChars(el));
          const np: NewParagraph = { text: c.text, attrs: c.attrs, align: el.style.textAlign ? renderedAlign(el) : undefined };
          if (lastBound === -1) before.push(np);
          else {
            if (!group) {
              const a = byIndex.get(lastBound)!;
              group = { afterIndex: lastBound, anchorIndex: lastBound, baseAttr: a.attrs[a.attrs.length - 1] ?? 0, paragraphs: [] };
              plan.inserts.push(group);
            }
            group.paragraphs.push(np);
          }
        }
      }
      for (const b of bindingsRef.current) if (!seen.has(b.index)) plan.deleted.push(b.index);
      return plan;
    }, []);

    const planSize = (p: DocxEditPlan) => p.edits.length + p.deleted.length + p.inserts.reduce((n, g) => n + g.paragraphs.length, 0);

    const buildWorking = useCallback(async (extra?: (model: Awaited<ReturnType<typeof loadDocx>>, target?: Element) => boolean, targetIdx?: number) => {
      const plan = collectPlan();
      const model = await loadDocx(working.slice(0));
      const target = targetIdx !== undefined ? model.paragraphs[targetIdx] : undefined;
      applyPlan(model, plan);
      const ok = extra ? extra(model, target) : true;
      return { buf: await serializeDocx(model), plan, ok };
    }, [collectPlan, working]);

    React.useImperativeHandle(ref, () => ({
      async buildEdited() {
        const { buf, plan } = await buildWorking();
        const changes = planSize(plan) + structuralOps.current;
        return { kind: "file" as const, blob: new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), changes };
      },
    }), [buildWorking]);

    const exec = (cmd: string) => {
      if (!hostOfSelection(bodyRef.current)) return;
      try { document.execCommand("styleWithCSS", false, "true"); } catch { /* noop */ }
      document.execCommand(cmd);
      onDirtyRef.current();
    };
    const align = (v: string) => {
      const h = hostOfSelection(bodyRef.current);
      if (!h) return;
      h.style.textAlign = v;
      onDirtyRef.current();
    };
    const rowOp = async (op: "add" | "remove") => {
      const h = hostOfSelection(bodyRef.current);
      if (!h || h.getAttribute("data-docx-host") !== "b" || !h.closest("td")) return;
      setBusy(true);
      try {
        const idx = Number(h.getAttribute("data-pidx"));
        const { buf, ok } = await buildWorking((_m, target) => (op === "add" ? addTableRowAfter(target) : removeTableRow(target)), idx);
        if (!ok) return;
        structuralOps.current++;
        onDirtyRef.current();
        setWorking(buf);
      } finally { setBusy(false); }
    };

    return (
      <div className="docx-workspace">
        <style>{`
          .docx-workspace .docx-wrapper { background: transparent; padding: 24px 12px; }
          .docx-workspace .docx-wrapper > section.docx { box-shadow: 0 4px 18px rgba(0,0,0,.35); margin-bottom: 24px; }
          .docx-workspace .docx-editable-p { outline: 1px dashed transparent; border-radius: 2px; cursor: text; }
          .docx-workspace .docx-editable-p:hover { outline-color: rgba(99,102,241,.45); }
          .docx-workspace .docx-editable-p:focus { outline: 2px solid rgba(99,102,241,.8); background: rgba(99,102,241,.05); }
        `}</style>
        {editMode && (
          <div className="sticky top-0 z-20 flex flex-wrap items-center gap-1 px-3 py-1.5 bg-slate-900/95 border-b border-slate-800" data-testid="docx-toolbar">
            <TBtn title="Tebal (Ctrl+B)" onClick={() => exec("bold")}><Bold className="w-3.5 h-3.5" /></TBtn>
            <TBtn title="Miring (Ctrl+I)" onClick={() => exec("italic")}><Italic className="w-3.5 h-3.5" /></TBtn>
            <TBtn title="Garis bawah (Ctrl+U)" onClick={() => exec("underline")}><Underline className="w-3.5 h-3.5" /></TBtn>
            <span className="w-px h-5 bg-slate-700 mx-1" />
            <TBtn title="Rata kiri" onClick={() => align("left")}><AlignLeft className="w-3.5 h-3.5" /></TBtn>
            <TBtn title="Rata tengah" onClick={() => align("center")}><AlignCenter className="w-3.5 h-3.5" /></TBtn>
            <TBtn title="Rata kanan" onClick={() => align("right")}><AlignRight className="w-3.5 h-3.5" /></TBtn>
            <TBtn title="Rata kiri-kanan" onClick={() => align("justify")}><AlignJustify className="w-3.5 h-3.5" /></TBtn>
            <span className="w-px h-5 bg-slate-700 mx-1" />
            <TBtn title="Tambah baris tabel di bawah baris ini" disabled={busy} onClick={() => rowOp("add")}><Rows3 className="w-3.5 h-3.5" /> Baris</TBtn>
            <TBtn title="Hapus baris tabel ini" disabled={busy} onClick={() => rowOp("remove")}><TableRowsSplit className="w-3.5 h-3.5" /> Hapus baris</TBtn>
            <span className="text-[10px] text-slate-500 ml-2">Enter = paragraf baru · Shift+Enter = baris baru · Backspace di awal paragraf = gabung</span>
          </div>
        )}
        {bindStats && bindStats.bound < bindStats.total && (
          <p className="mx-3 mt-3 text-[10px] text-amber-300/90 bg-amber-500/10 border border-amber-500/30 rounded-lg p-2">
            {bindStats.total - bindStats.bound} paragraf (mis. kop/header, footer, atau berisi simbol/field khusus) dikunci agar format aslinya tidak rusak — ubah lewat "Unggah Revisi" bila perlu.
          </p>
        )}
        {renderError && <p className="p-4 text-xs text-rose-300">{renderError}</p>}
        <div ref={styleRef} />
        <div ref={bodyRef} />
      </div>
    );
  },
);

// ---------------------------------------------------------------------------
// PDF editor
// ---------------------------------------------------------------------------
interface PdfLine {
  id: string; text: string; x: number; y: number; w: number; h: number; baseline: number;
  fontSize: number; family: "serif" | "sans" | "mono"; bold: boolean; italic: boolean; color: string;
}
interface PdfPageLayout { index: number; width: number; height: number; editable: boolean; reason?: string; lines: PdfLine[] }

type PdfItem =
  | { id: string; kind: "text"; page: number; x: number; y: number; text: string; size: number }
  | { id: string; kind: "cover"; page: number; x: number; y: number; w: number; h: number };

const FAMILY_CSS: Record<PdfLine["family"], string> = {
  serif: '"Times New Roman", Times, "Liberation Serif", serif',
  sans: 'Arial, Helvetica, "Liberation Sans", sans-serif',
  mono: '"Courier New", Courier, monospace',
};

const PdfDocumentView = React.forwardRef<EditorHandle, { contractId: string; version: number; data: ArrayBuffer; editMode: boolean; onDirty: () => void }>(
  function PdfDocumentView({ contractId, version, data, editMode, onDirty }, ref) {
    const [pages, setPages] = useState<{ width: number; height: number }[]>([]);
    const [layout, setLayout] = useState<PdfPageLayout[] | null>(null);
    const [layoutError, setLayoutError] = useState<string | null>(null);
    const [zoom, setZoom] = useState(1.25);
    const [error, setError] = useState<string | null>(null);
    const [tool, setTool] = useState<"text" | "add" | "cover">("text");
    const [items, setItems] = useState<PdfItem[]>([]);
    const [edited, setEdited] = useState<Record<string, string>>({});
    const [fontSize, setFontSize] = useState(11);
    const docRef = useRef<any>(null);
    const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);
    const lineRefs = useRef<Map<string, HTMLDivElement>>(new Map());
    const drawStart = useRef<{ page: number; x: number; y: number } | null>(null);
    const [draft, setDraft] = useState<{ page: number; x: number; y: number; w: number; h: number } | null>(null);

    useEffect(() => { if (!editMode) { setItems([]); setEdited({}); setTool("text"); } }, [editMode]);

    useEffect(() => {
      let cancelled = false;
      (async () => {
        try {
          // Build "legacy" pdf.js: build modern v6 memakai API JS sangat baru
          // (Map.getOrInsertComputed) yang belum ada di banyak browser kantor
          // -> halaman kosong. Legacy build menyertakan polyfill-nya.
          const pdfjsLib: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
          pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.mjs", import.meta.url).toString();
          const doc = await pdfjsLib.getDocument({ data: new Uint8Array(data.slice(0)) }).promise;
          if (cancelled) return;
          docRef.current = doc;
          const infos: { width: number; height: number }[] = [];
          for (let i = 1; i <= doc.numPages; i++) {
            const vp = (await doc.getPage(i)).getViewport({ scale: 1 });
            infos.push({ width: vp.width, height: vp.height });
          }
          if (!cancelled) setPages(infos);
        } catch (e: any) {
          console.error(e);
          if (!cancelled) setError("Gagal membuka PDF (mungkin rusak atau terkunci password). Berkas asli tetap tersimpan — silakan unduh.");
        }
      })();
      return () => { cancelled = true; };
    }, [data]);

    // Tata letak teks (baris yang bisa diedit) dari server — dimuat saat edit.
    useEffect(() => {
      if (!editMode || layout) return;
      let cancelled = false;
      setLayoutError(null);
      fetch(`/api/contracts/${contractId}/document/pdf-layout?version=${version}`)
        .then(async (r) => {
          const d = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(d.error || "Gagal membaca teks PDF");
          return d;
        })
        .then((d) => { if (!cancelled) setLayout(d.pages); })
        .catch((e) => { if (!cancelled) setLayoutError(e.message); });
      return () => { cancelled = true; };
    }, [editMode, layout, contractId, version]);

    useEffect(() => {
      const doc = docRef.current;
      if (!doc || !pages.length) return;
      let cancelled = false;
      const tasks: any[] = [];
      (async () => {
        const dpr = window.devicePixelRatio || 1;
        for (let i = 0; i < pages.length; i++) {
          if (cancelled) return;
          const canvas = canvasRefs.current[i];
          if (!canvas) continue;
          const page = await doc.getPage(i + 1);
          const vp = page.getViewport({ scale: zoom * dpr });
          canvas.width = Math.floor(vp.width);
          canvas.height = Math.floor(vp.height);
          const ctx = canvas.getContext("2d");
          if (!ctx) continue;
          const task = page.render({ canvas, canvasContext: ctx, viewport: vp });
          tasks.push(task);
          await task.promise.catch(() => {});
        }
      })();
      return () => { cancelled = true; tasks.forEach((t) => t.cancel?.()); };
    }, [pages, zoom]);

    const toPdf = (e: React.PointerEvent, el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      return { x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom };
    };

    const onPagePointerDown = (e: React.PointerEvent<HTMLDivElement>, page: number) => {
      if (!editMode || e.target !== e.currentTarget) return;
      const p = toPdf(e, e.currentTarget);
      if (tool === "add") {
        e.preventDefault(); // cegah fokus pindah ke body sebelum textarea baru fokus
        const id = `t${Date.now()}`;
        setItems((xs) => [...xs, { id, kind: "text", page, x: p.x, y: p.y - fontSize * 0.6, text: "", size: fontSize }]);
        onDirty();
      } else if (tool === "cover") {
        drawStart.current = { page, ...p };
        setDraft({ page, x: p.x, y: p.y, w: 0, h: 0 });
        e.currentTarget.setPointerCapture(e.pointerId);
      }
    };
    const onPagePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
      const s = drawStart.current;
      if (!s) return;
      const p = toPdf(e, e.currentTarget);
      setDraft({ page: s.page, x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) });
    };
    const onPagePointerUp = () => {
      const d = draft;
      drawStart.current = null;
      setDraft(null);
      if (d && d.w > 3 && d.h > 3) {
        setItems((xs) => [...xs, { id: `c${Date.now()}`, kind: "cover", ...d }]);
        onDirty();
      }
    };

    const startMove = (e: React.PointerEvent, id: string) => {
      e.preventDefault();
      e.stopPropagation();
      const sx = e.clientX, sy = e.clientY;
      const orig = items.find((i) => i.id === id);
      if (!orig) return;
      const move = (ev: PointerEvent) => {
        const dx = (ev.clientX - sx) / zoom, dy = (ev.clientY - sy) / zoom;
        setItems((xs) => xs.map((i) => (i.id === id ? { ...i, x: orig.x + dx, y: orig.y + dy } : i)));
      };
      const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); onDirty(); };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    };

    React.useImperativeHandle(ref, () => ({
      async buildEdited() {
        const allLines = new Map<string, PdfLine>((layout || []).flatMap((p) => p.lines).map((l) => [l.id, l] as [string, PdfLine]));
        const edits = Object.entries(edited)
          .filter(([id, t]) => allLines.get(id) && allLines.get(id)!.text !== t)
          .map(([id, t]) => ({ lineId: id, oldText: allLines.get(id)!.text, newText: t }));
        const addTexts = items.filter((i): i is Extract<PdfItem, { kind: "text" }> => i.kind === "text" && !!i.text.trim())
          .map(({ page, x, y, text, size }) => ({ page, x, y, text, size }));
        const covers = items.filter((i): i is Extract<PdfItem, { kind: "cover" }> => i.kind === "cover")
          .map(({ page, x, y, w, h }) => ({ page, x, y, w, h }));
        return { kind: "pdf-edit" as const, body: { edits, addTexts, covers }, changes: edits.length + addTexts.length + covers.length };
      },
    }), [edited, items, layout]);

    if (error) return <p className="p-4 text-xs text-rose-300">{error}</p>;
    const textLines = layout?.reduce((n, p) => n + p.lines.length, 0) ?? 0;

    return (
      <div>
        <style>{`
          .pdf-line { position: absolute; white-space: pre; outline: 1px dashed transparent; border-radius: 1px; color: transparent; caret-color: #111; cursor: text; }
          .pdf-line:hover { outline-color: rgba(99,102,241,.55); background: rgba(99,102,241,.06); }
          .pdf-line.active, .pdf-line:focus { background: #fff; outline: 1px solid rgba(99,102,241,.8); z-index: 2; }
          .pdf-line.active { color: var(--line-color); }
          .pdf-line:focus { color: var(--line-color); }
        `}</style>
        <div className="sticky top-0 z-20 flex flex-wrap items-center gap-2 px-3 py-2 bg-slate-900/95 border-b border-slate-800">
          <button type="button" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))} className="p-1 text-slate-300 hover:text-white" title="Perkecil"><ZoomOut className="w-4 h-4" /></button>
          <span className="text-[11px] text-slate-400 w-10 text-center">{Math.round(zoom * 100)}%</span>
          <button type="button" onClick={() => setZoom((z) => Math.min(3, +(z + 0.25).toFixed(2)))} className="p-1 text-slate-300 hover:text-white" title="Perbesar"><ZoomIn className="w-4 h-4" /></button>
          <span className="text-[11px] text-slate-500">{pages.length} halaman</span>
          {editMode && (
            <div className="flex items-center gap-1 ml-auto" data-testid="pdf-toolbar">
              {([
                ["text", TextCursorInput, "Edit teks"],
                ["add", Type, "Tambah teks"],
                ["cover", Square, "Hapus area"],
              ] as const).map(([k, Icon, label]) => (
                <button key={k} type="button" onClick={() => setTool(k)}
                  className={`px-2 py-1 rounded-md text-[11px] font-semibold flex items-center gap-1 cursor-pointer ${tool === k ? "bg-indigo-600 text-white" : "text-slate-300 hover:bg-slate-800"}`}>
                  <Icon className="w-3.5 h-3.5" /> {label}
                </button>
              ))}
              {tool === "add" && (
                <select value={fontSize} onChange={(e) => setFontSize(Number(e.target.value))} className="bg-slate-950 border border-slate-800 rounded text-[11px] text-slate-200 px-1 py-0.5" title="Ukuran teks baru">
                  {[8, 9, 10, 11, 12, 14, 16, 18, 24].map((n) => <option key={n} value={n}>{n} pt</option>)}
                </select>
              )}
            </div>
          )}
        </div>
        {editMode && (
          <p className="px-3 pt-2 text-[10px] text-indigo-300/90">
            {!layout && !layoutError && "Membaca teks PDF…"}
            {layoutError && <span className="text-rose-300">{layoutError}</span>}
            {layout && (textLines === 0
              ? "PDF ini tidak berisi teks yang bisa diedit (kemungkinan hasil scan/gambar). Gunakan Tambah teks / Hapus area, atau Unggah Revisi."
              : tool === "text"
                ? "Klik teks mana pun di halaman lalu ketik untuk mengubahnya — teks disimpan sebagai teks PDF asli di posisi & ukuran yang sama. Satu kotak = satu baris; teks tidak otomatis pindah ke baris berikutnya."
                : tool === "add" ? "Klik di halaman untuk menambah teks baru."
                  : "Tarik kotak untuk MENGHAPUS isi area itu dari PDF (teks di bawahnya benar-benar dihapus, bukan cuma ditutup).")}
          </p>
        )}
        <div className="flex flex-col items-center gap-5 py-5">
          {pages.map((p, i) => {
            const pl = layout?.[i];
            return (
              <div key={i} className="relative shadow-lg bg-white" style={{ width: p.width * zoom, height: p.height * zoom }} data-page={i + 1}>
                <canvas ref={(el) => { canvasRefs.current[i] = el; }} style={{ width: p.width * zoom, height: p.height * zoom, display: "block" }} />
                <div
                  className="absolute inset-0"
                  style={{ cursor: editMode ? (tool === "add" ? "text" : tool === "cover" ? "crosshair" : "default") : "default" }}
                  onPointerDown={(e) => onPagePointerDown(e, i)}
                  onPointerMove={onPagePointerMove}
                  onPointerUp={onPagePointerUp}
                >
                  {editMode && pl?.editable && pl.lines.map((l) => {
                    const changed = edited[l.id] !== undefined && edited[l.id] !== l.text;
                    const size = l.fontSize * zoom;
                    return (
                      <div
                        key={l.id}
                        ref={(el) => { if (el) lineRefs.current.set(l.id, el); else lineRefs.current.delete(l.id); }}
                        data-line-id={l.id}
                        className={`pdf-line${changed ? " active" : ""}`}
                        contentEditable={tool === "text" ? ("plaintext-only" as any) : false}
                        suppressContentEditableWarning
                        spellCheck={false}
                        onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }}
                        onInput={(e) => {
                          const t = (e.currentTarget.textContent || "").replace(/\n/g, " ");
                          setEdited((m) => ({ ...m, [l.id]: t }));
                          onDirty();
                        }}
                        style={{
                          left: l.x * zoom - 1,
                          top: (l.baseline - l.fontSize * 0.92) * zoom,
                          minWidth: l.w * zoom + 2,
                          height: l.fontSize * 1.18 * zoom,
                          lineHeight: `${l.fontSize * 1.18 * zoom}px`,
                          fontSize: size,
                          fontFamily: FAMILY_CSS[l.family],
                          fontWeight: l.bold ? 700 : 400,
                          fontStyle: l.italic ? "italic" : "normal",
                          ["--line-color" as any]: l.color,
                          pointerEvents: tool === "text" ? "auto" : "none",
                        }}
                      >{l.text}</div>
                    );
                  })}
                  {items.filter((it) => it.page === i).map((it) => (
                    <div key={it.id} data-item={it.id} className="absolute group"
                      style={{
                        left: it.x * zoom, top: it.y * zoom, zIndex: 3,
                        ...(it.kind === "cover" ? { width: it.w * zoom, height: it.h * zoom, background: "#fff", outline: "1px dashed rgba(244,63,94,.8)", pointerEvents: tool === "add" ? "none" : "auto" } : {}),
                      }}>
                      {it.kind === "text" && (
                        <textarea
                          autoFocus={!it.text}
                          value={it.text}
                          rows={Math.max(1, it.text.split("\n").length)}
                          onChange={(e) => { const v = e.target.value; setItems((xs) => xs.map((x) => (x.id === it.id ? { ...x, text: v } : x))); onDirty(); }}
                          placeholder="Ketik…"
                          className="bg-white/80 outline outline-1 outline-dashed outline-indigo-400/70 focus:outline-indigo-500 resize text-black p-0.5"
                          style={{ fontFamily: "Helvetica, Arial, sans-serif", fontSize: it.size * zoom, lineHeight: 1.2, minWidth: 60 * zoom, width: Math.max(60, it.text.split("\n").reduce((m, l) => Math.max(m, l.length), 0) * it.size * 0.55 + 12) * zoom }}
                        />
                      )}
                      <div className="absolute -top-5 left-0 hidden group-hover:flex gap-1">
                        <span onPointerDown={(e) => startMove(e, it.id)} className="px-1 bg-indigo-600 text-white text-[9px] rounded cursor-move select-none">geser</span>
                        <button type="button" onClick={() => setItems((xs) => xs.filter((x) => x.id !== it.id))} className="px-1 bg-rose-600 text-white rounded" title="Hapus"><Trash2 className="w-3 h-3" /></button>
                      </div>
                    </div>
                  ))}
                  {draft && draft.page === i && (
                    <div className="absolute border border-dashed border-rose-500 bg-white/70" style={{ left: draft.x * zoom, top: draft.y * zoom, width: draft.w * zoom, height: draft.h * zoom }} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  },
);

// ---------------------------------------------------------------------------
// Markup dokumen upload (.docx) — padanan "Track Changes + Comment" di Word.
//
//  - Pengulas menyorot teks di dokumen ASLI (layout tidak diubah sama sekali),
//    lalu memilih: ✎ Komentar, ✂ Coret (usul hapus), atau ⇄ Ganti (usul teks
//    pengganti). Tanda muncul langsung di dokumen: komentar = sorot kuning,
//    coret/ganti = teks dicoret merah (+ teks pengganti hijau bergaris bawah).
//  - Markup TIDAK mengubah berkas. Berkas baru hanya terbentuk saat usulan
//    DITERIMA (acceptDocxMarkup): teksnya diterapkan ke paragraf .docx lewat
//    mesin edit yang sama dgn workspace (docx-patch) dan disimpan sebagai
//    VERSI BARU — original & versi lama tetap utuh. Ditolak = dokumen tak berubah.
//  - Dipakai Mode Tinjau internal dan halaman review eksternal (tamu hanya bisa
//    membuat markup; terima/tolak khusus internal).
//  - Hanya .docx asli. PDF/.doc tetap tampil baca-saja (komentar umum).
// ---------------------------------------------------------------------------
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Loader2 } from "lucide-react";
import {
  loadDocx, bindRenderedParagraphs, paragraphText, replaceTextRange, serializeDocx, normChars,
  type ParagraphBinding,
} from "./docx-patch";
import { ReadOnlyDocumentView, type ReadOnlyDocFormat } from "./UploadedDocumentWorkspace";

export type MarkupKind = "comment" | "strike" | "replace";

/** Satu markup yang akan digambar di dokumen (turunan dari ClauseComment). */
export interface MarkupItem {
  id: string;
  kind: MarkupKind;
  resolved: boolean;
  status?: string; // pending | accepted | rejected
  paraIndex?: number;
  start?: number;
  end?: number;
  quote?: string;
  replacement?: string;
}

/** Hasil pemilihan teks oleh pengulas, sebelum jadi komentar. */
export interface MarkupSeed {
  kind: MarkupKind;
  quote: string;
  start: number;
  end: number;
  paraIndex: number;
}

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const INS_ATTR = "data-mk-ins";

// ---- Teks & offset di DOM hasil render ------------------------------------
// Offset dihitung atas teks node-teks paragraf, mengabaikan teks sisipan
// (usulan pengganti) yang kita gambar sendiri.

function textNodesOf(el: HTMLElement): Text[] {
  const out: Text[] = [];
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) { out.push(n as Text); return; }
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    if ((n as HTMLElement).hasAttribute(INS_ATTR)) return;
    n.childNodes.forEach(walk);
  };
  el.childNodes.forEach(walk);
  return out;
}

function paraText(el: HTMLElement): string {
  return textNodesOf(el).map((t) => t.data).join("");
}

function offsetIn(el: HTMLElement, node: Node, offset: number): number {
  const r = document.createRange();
  r.selectNodeContents(el);
  try { r.setEnd(node, offset); } catch { return 0; }
  const frag = r.cloneContents();
  frag.querySelectorAll(`[${INS_ATTR}]`).forEach((x) => x.remove());
  return (frag.textContent || "").length;
}

/** Bungkus teks [start,end) paragraf dengan <span data-mk=id>. */
function wrapRange(el: HTMLElement, start: number, end: number, id: string, css: string): HTMLElement[] {
  const spans: HTMLElement[] = [];
  let acc = 0;
  for (const t of textNodesOf(el)) {
    const len = t.data.length;
    const ns = acc, ne = acc + len;
    acc = ne;
    const s = Math.max(start, ns), e = Math.min(end, ne);
    if (e <= s) continue;
    let node: Text = t;
    if (s > ns) node = node.splitText(s - ns);
    if (e < ne) node.splitText(e - s);
    const span = document.createElement("span");
    span.setAttribute("data-mk", id);
    span.style.cssText = css;
    node.parentNode!.insertBefore(span, node);
    span.appendChild(node);
    spans.push(span);
  }
  return spans;
}

function clearMarks(root: HTMLElement) {
  root.querySelectorAll(`[${INS_ATTR}]`).forEach((n) => n.remove());
  const parents = new Set<Node>();
  Array.from(root.querySelectorAll("span[data-mk]")).forEach((sp) => {
    const parent = sp.parentNode;
    if (!parent) return;
    while (sp.firstChild) parent.insertBefore(sp.firstChild, sp);
    parent.removeChild(sp);
    parents.add(parent);
  });
  parents.forEach((p) => p.normalize());
}

/** Cari posisi teks markup di paragraf: pakai offset tersimpan bila masih cocok, kalau tidak cari kutipan terdekat. */
function locateInDom(full: string, item: MarkupItem): { start: number; end: number } | null {
  const q = item.quote || "";
  if (!q) return null;
  if (typeof item.start === "number" && full.slice(item.start, item.start + q.length) === q) {
    return { start: item.start, end: item.start + q.length };
  }
  let best: number | null = null;
  let from = 0;
  for (;;) {
    const i = full.indexOf(q, from);
    if (i < 0) break;
    if (best === null || Math.abs(i - (item.start ?? 0)) < Math.abs(best - (item.start ?? 0))) best = i;
    from = i + 1;
  }
  return best === null ? null : { start: best, end: best + q.length };
}

const MARK_CSS: Record<MarkupKind, string> = {
  comment: "background:rgba(251,191,36,.5);border-radius:2px;cursor:pointer;",
  strike: "background:rgba(244,63,94,.16);text-decoration:line-through;text-decoration-color:#e11d48;border-bottom:2px solid #f43f5e;cursor:pointer;",
  replace: "background:rgba(244,63,94,.16);text-decoration:line-through;text-decoration-color:#e11d48;border-bottom:2px solid #f43f5e;cursor:pointer;",
};
const INS_CSS = "background:rgba(16,185,129,.22);color:#047857;text-decoration:underline;margin-left:2px;padding:0 2px;border-radius:2px;cursor:pointer;";

// ---- Penerapan usulan ke berkas .docx --------------------------------------

function escapeRegExp(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** Posisi kutipan di teks (setelah normalisasi), memilih yang terdekat dgn petunjuk offset. */
export function locateQuote(text: string, quote: string, hint: number): { start: number; end: number } | null {
  const parts = normChars(quote).trim().split(/\s+/).filter(Boolean).map(escapeRegExp);
  if (!parts.length) return null;
  const re = new RegExp(parts.join("\\s+"), "g");
  let best: { start: number; end: number } | null = null;
  let bestD = Infinity;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const d = Math.abs(m.index - hint);
    if (d < bestD) { best = { start: m.index, end: m.index + m[0].length }; bestD = d; }
    if (m[0].length === 0) re.lastIndex++;
  }
  return best;
}

/**
 * Terapkan satu usulan (ganti/hapus) ke berkas .docx dan kembalikan berkas baru.
 * Hanya teks di rentang yang berubah; format run lain tidak disentuh.
 */
export async function applyMarkupToDocx(
  buf: ArrayBuffer,
  m: { paraIndex: number; quote: string; start: number; replacement: string },
): Promise<ArrayBuffer> {
  const model = await loadDocx(buf.slice(0));
  const p = model.paragraphs[m.paraIndex];
  if (!p) throw new Error("Paragraf yang ditandai tidak ditemukan pada versi dokumen saat ini.");
  // Teks MENTAH paragraf (koordinat yang sama dgn segmen XML), bukan yang dinormalisasi.
  const raw = paragraphText(p);
  const loc = locateQuote(raw, m.quote, m.start);
  if (!loc) throw new Error("Teks yang ditandai sudah berubah di versi dokumen terbaru, jadi usulan tidak bisa diterapkan otomatis.");
  let { end } = loc;
  // Hapus murni: jangan sisakan dobel spasi.
  if (!m.replacement && raw[loc.start - 1] === " " && raw[end] === " ") end += 1;
  replaceTextRange(model.xml, p, loc.start, end, m.replacement);
  return serializeDocx(model);
}

function nameForVersion(original: string, version: number) {
  const base = original.replace(/\.[^.]+$/, "").replace(/\s*\(v\d+\)$/, "");
  return `${base} (v${version}).docx`;
}

/**
 * Terima usulan: terapkan ke berkas .docx aktif lalu simpan sebagai VERSI BARU.
 * Melempar Error berpesan jelas bila tidak bisa (bukan .docx, bukan Draft, teks berubah).
 */
export async function acceptDocxMarkup(
  contractId: string,
  m: { paraIndex: number; quote: string; start: number; replacement: string },
  note: string,
): Promise<{ version: number }> {
  const vr = await fetch(`/api/contracts/${contractId}/document-versions`);
  const vd = await vr.json().catch(() => ({}));
  if (!vr.ok) throw new Error(vd.error || "Gagal memuat versi dokumen.");
  const cur: number = vd.currentVersion;
  const versions: any[] = vd.versions || [];
  const v = versions.find((x) => x.version === cur);
  if (!v?.file) throw new Error("Berkas dokumen belum tersedia.");
  if (v.file.format !== "docx") throw new Error("Usulan hanya bisa diterapkan otomatis pada dokumen Word (.docx).");
  const dr = await fetch(`/api/contracts/${contractId}/document?version=${cur}`);
  if (!dr.ok) throw new Error((await dr.json().catch(() => ({}))).error || "Gagal membuka berkas dokumen.");
  const out = await applyMarkupToDocx(await dr.arrayBuffer(), m);
  const next = versions.length ? Math.max(...versions.map((x) => x.version)) + 1 : 1;
  const original = versions.find((x) => x.isOriginal)?.file?.fileName || v.file.fileName;
  const fd = new FormData();
  fd.append("file", new Blob([out], { type: DOCX_MIME }), nameForVersion(original, next));
  fd.append("comment", note);
  fd.append("baseVersion", String(cur));
  fd.append("editMethod", "docx-inline");
  const r = await fetch(`/api/contracts/${contractId}/document-versions`, { method: "POST", body: fd });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.success) throw new Error(data.error || "Gagal menyimpan versi baru.");
  return { version: data.version?.version ?? next };
}

// ---- Viewer .docx + markup -------------------------------------------------

export function DocxMarkupView({
  src, items, activeId, onActiveChange, onStartDraft, canMark = true, reloadKey, onNotify,
}: {
  src: string;
  items: MarkupItem[];
  activeId: string | null;
  onActiveChange: (id: string | null) => void;
  onStartDraft: (seed: MarkupSeed) => void;
  canMark?: boolean;
  reloadKey?: number | string;
  onNotify?: (msg: string) => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const styleRef = useRef<HTMLDivElement>(null);
  const bindingsRef = useRef<ParagraphBinding[]>([]);
  const [buf, setBuf] = useState<ArrayBuffer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(0);
  const [toolbar, setToolbar] = useState<{ x: number; y: number; seed: Omit<MarkupSeed, "kind"> } | null>(null);

  // 1) Ambil berkas
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null); setBuf(null);
    fetch(src)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Gagal membuka dokumen (HTTP ${r.status})`);
        return r.arrayBuffer();
      })
      .then((b) => { if (!cancelled) setBuf(b); })
      .catch((e) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [src, reloadKey]);

  // 2) Render layout asli + petakan paragraf render <-> paragraf XML
  useEffect(() => {
    if (!buf) return;
    let cancelled = false;
    (async () => {
      try {
        const { renderAsync } = await import("docx-preview");
        if (!bodyRef.current || !styleRef.current) return;
        bodyRef.current.innerHTML = "";
        styleRef.current.innerHTML = "";
        await renderAsync(buf.slice(0), bodyRef.current, styleRef.current, {
          className: "docx", inWrapper: true, ignoreWidth: false, ignoreHeight: false, breakPages: true,
          renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true,
          useBase64URL: true, experimental: true,
        });
        const model = await loadDocx(buf.slice(0));
        if (cancelled || !bodyRef.current) return;
        bindingsRef.current = bindRenderedParagraphs(bodyRef.current, model);
        setReady((n) => n + 1);
      } catch (e: any) {
        console.error(e);
        if (!cancelled) setError("Gagal merender dokumen Word ini.");
      }
    })();
    return () => { cancelled = true; };
  }, [buf]);

  // 3) Gambar markup di atas dokumen (dibersihkan & digambar ulang tiap perubahan)
  const paintKey = useMemo(
    () => items.map((i) => `${i.id}:${i.kind}:${i.status || ""}:${i.resolved ? 1 : 0}:${i.paraIndex}:${i.start}:${i.quote}:${i.replacement || ""}`).join("|") + `#${activeId}`,
    [items, activeId],
  );
  useEffect(() => {
    const root = bodyRef.current;
    if (!root || !ready) return;
    clearMarks(root);
    for (const it of items) {
      if (it.paraIndex == null || !it.quote) continue;
      if (it.status === "accepted" || it.status === "rejected") continue; // sudah diputuskan: tak digambar
      const b = bindingsRef.current.find((x) => x.index === it.paraIndex);
      if (!b) continue;
      const loc = locateInDom(paraText(b.el), it);
      if (!loc) continue;
      const active = it.id === activeId ? "outline:2px solid #6366f1;outline-offset:1px;" : "";
      const dim = it.resolved ? "opacity:.45;" : "";
      const spans = wrapRange(b.el, loc.start, loc.end, it.id, MARK_CSS[it.kind] + active + dim);
      if (it.kind === "replace" && it.replacement && spans.length) {
        const ins = document.createElement("span");
        ins.setAttribute(INS_ATTR, "1");
        ins.setAttribute("data-mk", it.id);
        ins.setAttribute("contenteditable", "false");
        ins.style.cssText = INS_CSS + active + dim;
        ins.textContent = it.replacement;
        spans[spans.length - 1].after(ins);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, paintKey]);

  // 4) Pilih teks -> toolbar
  const handleMouseUp = () => {
    if (!canMark) return;
    window.setTimeout(() => {
      const body = bodyRef.current;
      const sel = window.getSelection();
      if (!body || !sel || sel.rangeCount === 0 || sel.isCollapsed) return;
      const range = sel.getRangeAt(0);
      if (!body.contains(range.commonAncestorContainer)) return;
      const bs = bindingsRef.current;
      const findB = (n: Node) => bs.find((b) => b.el.contains(n));
      const bStart = findB(range.startContainer);
      const bEnd = findB(range.endContainer);
      if (!bStart || !bEnd) { onNotify?.("Bagian ini (mis. kop/footer) tidak bisa diberi markup."); return; }
      if (bStart !== bEnd) { onNotify?.("Pilih teks dalam satu paragraf saja."); return; }
      const el = bStart.el;
      const full = paraText(el);
      let s = offsetIn(el, range.startContainer, range.startOffset);
      let e = offsetIn(el, range.endContainer, range.endOffset);
      while (s < e && /\s/.test(full[s])) s++;
      while (e > s && /\s/.test(full[e - 1])) e--;
      if (e <= s) return;
      const rect = range.getBoundingClientRect();
      setToolbar({ x: rect.left + rect.width / 2, y: rect.top, seed: { quote: full.slice(s, e), start: s, end: e, paraIndex: bStart.index } });
    }, 0);
  };

  const startDraft = (kind: MarkupKind) => {
    if (!toolbar) return;
    onStartDraft({ ...toolbar.seed, kind });
    window.getSelection()?.removeAllRanges();
    setToolbar(null);
  };

  const handleClick = (e: React.MouseEvent) => {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const m = (e.target as HTMLElement).closest?.("[data-mk]");
    if (m) onActiveChange(m.getAttribute("data-mk"));
  };

  return (
    <div
      className="bg-slate-800/60 rounded-xl border border-slate-850 overflow-auto max-h-[78vh] min-h-[320px] relative"
      data-testid="document-viewer-markup"
      onMouseDown={() => setToolbar(null)}
      onMouseUp={handleMouseUp}
      onClick={handleClick}
      onScroll={() => setToolbar(null)}
    >
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center text-slate-400 text-xs gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Memuat dokumen…</div>
      )}
      {error && !loading && (
        <div className="p-6 text-xs text-rose-300 flex items-start gap-2"><AlertTriangle className="w-4 h-4 shrink-0" /> {error}</div>
      )}
      <div ref={styleRef} />
      <div ref={bodyRef} />
      {toolbar && createPortal(
        <div
          className="fixed z-[90] -translate-x-1/2 -translate-y-full -mt-2 flex items-center gap-1 rounded-lg bg-slate-900 border border-slate-700 shadow-2xl p-1"
          style={{ left: toolbar.x, top: toolbar.y }}
          // Toolbar dirender lewat portal, tapi event React TETAP naik ke container
          // (pohon React, bukan DOM). Tanpa stopPropagation, mousedown di tombol
          // memicu onMouseDown container -> setToolbar(null) -> toolbar lenyap
          // sebelum "click" terjadi, sehingga tombol tampak tidak berfungsi.
          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onMouseUp={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <button onClick={() => startDraft("comment")} className="px-2 py-1 text-[11px] font-semibold text-amber-300 hover:bg-slate-800 rounded cursor-pointer whitespace-nowrap">✎ Komentar</button>
          <button onClick={() => startDraft("strike")} className="px-2 py-1 text-[11px] font-semibold text-rose-300 hover:bg-slate-800 rounded cursor-pointer whitespace-nowrap">✂ Coret</button>
          <button onClick={() => startDraft("replace")} className="px-2 py-1 text-[11px] font-semibold text-emerald-300 hover:bg-slate-800 rounded cursor-pointer whitespace-nowrap">⇄ Ganti</button>
        </div>,
        document.body,
      )}
    </div>
  );
}

// ---- Pembungkus Mode Tinjau internal --------------------------------------

/** Berkas versi AKTIF kontrak upload + markup. Bukan .docx -> tampil baca-saja. */
export function ContractDocumentMarkup({
  contractId, reloadKey, items, activeId, onActiveChange, onStartDraft, onNotify,
}: {
  contractId: string;
  reloadKey?: number | string;
  items: MarkupItem[];
  activeId: string | null;
  onActiveChange: (id: string | null) => void;
  onStartDraft: (seed: MarkupSeed) => void;
  onNotify?: (msg: string) => void;
}) {
  const [info, setInfo] = useState<{ src: string; format: ReadOnlyDocFormat; markup: boolean; mime?: string; name: string; version: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setInfo(null); setError(null);
    fetch(`/api/contracts/${contractId}/document-versions`)
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || "Gagal memuat dokumen");
        return d as any;
      })
      .then((d) => {
        if (cancelled) return;
        const v = d.versions.find((x: any) => x.version === d.currentVersion) || d.versions[d.versions.length - 1];
        if (!v?.file) { setError("Berkas dokumen belum tersedia."); return; }
        const f = v.file.format;
        const asDocx = f === "doc" && !!d.capabilities?.docConversion;
        const format: ReadOnlyDocFormat = f === "pdf" ? "pdf" : f === "docx" || asDocx ? "docx" : f === "image" ? "image" : "unsupported";
        setInfo({
          src: `/api/contracts/${contractId}/document?version=${v.version}${asDocx ? "&as=docx" : ""}`,
          format, markup: f === "docx", mime: v.file.mimeType, name: v.file.fileName, version: v.version,
        });
      })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [contractId, reloadKey]);

  if (error) return <div className="p-6 text-xs text-rose-300 bg-slate-900/60 border border-slate-800 rounded-xl flex items-start gap-2"><AlertTriangle className="w-4 h-4 shrink-0" /> {error}</div>;
  if (!info) return <div className="p-10 text-xs text-slate-400 flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Memuat dokumen…</div>;
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-slate-500 truncate">
        Berkas: <b className="text-slate-300">{info.name}</b> (versi {info.version}, aktif) — ditampilkan apa adanya.
        {info.markup ? " Sorot teks untuk memberi markup." : " Markup per kalimat tersedia untuk dokumen Word (.docx); untuk format ini gunakan komentar umum."}
      </p>
      {info.markup ? (
        <DocxMarkupView src={info.src} items={items} activeId={activeId} onActiveChange={onActiveChange} onStartDraft={onStartDraft} reloadKey={reloadKey} onNotify={onNotify} />
      ) : (
        <ReadOnlyDocumentView src={info.src} format={info.format} mimeType={info.mime} />
      )}
    </div>
  );
}

// Diekspor hanya untuk pengujian unit fungsi DOM (tidak dipakai komponen lain).
export const __markupDom = { textNodesOf, paraText, offsetIn, wrapRange, clearMarks, locateInDom };

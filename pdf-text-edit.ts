// ---------------------------------------------------------------------------
// Edit TEKS ASLI di dalam PDF (bukan overlay/gambar) — dipakai Document
// Workspace untuk kontrak hasil Upload Dokumen.
//
// Mesin: PDFium (engine PDF milik Chrome) versi WebAssembly (@embedpdf/pdfium,
// MIT), dijalankan di server. PDFium bisa membaca objek teks di content
// stream, mengubah isinya, menghapus objek, lalu menulis ulang content stream
// halaman — jadi hasil edit adalah teks PDF sungguhan (bisa dicari/disalin),
// bukan gambar dan bukan teks yang sekadar ditutup kotak putih.
//
// Alur:
//   1. extractPdfLayout(): objek teks tiap halaman dikelompokkan jadi "baris"
//      (baseline sama & berdekatan). Klien menampilkan tiap baris sebagai
//      kotak yang bisa diketik tepat di posisinya di atas render halaman.
//   2. applyPdfEdits(): untuk tiap baris yang berubah, diff karakter lama vs
//      baru dipetakan ke objek teks yang terkena. Objek diubah teksnya:
//        - pakai FONT ASLI (tertanam di PDF) bila semua karakter baru memang
//          tersedia di font itu -> tampilan identik;
//        - bila tidak (subset font tidak punya glyph-nya), objek diganti
//          font standar PDF yang paling mirip (Times/Helvetica/Courier,
//          tebal/miring mengikuti aslinya) pada posisi, ukuran & warna sama.
//      Objek sesudahnya di baris yang sama digeser mengikuti selisih lebar,
//      supaya tidak bertumpuk.
//   3. "Tutup" = redaksi sungguhan (teks di area itu DIHAPUS dari PDF) + blok
//      putih; "Teks baru" = objek teks baru.
//
// Batasan yang jujur: PDF tidak punya aliran paragraf, jadi teks yang jauh
// lebih panjang tidak otomatis turun ke baris berikutnya (tetap satu baris).
// Halaman berotasi & teks miring/di dalam Form XObject tidak diedit (dikunci).
// ---------------------------------------------------------------------------
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { init, type WrappedPdfiumModule } from "@embedpdf/pdfium";
import { diffChars } from "diff";

// Build produksi (esbuild -> CJS) punya `require`; dev (tsx ESM) tidak.
function resolveWasm(): string {
  try {
    const req = typeof require !== "undefined" ? require : createRequire(import.meta.url);
    return req.resolve("@embedpdf/pdfium/pdfium.wasm");
  } catch {
    return path.join(process.cwd(), "node_modules", "@embedpdf", "pdfium", "dist", "pdfium.wasm");
  }
}

let pdfiumPromise: Promise<WrappedPdfiumModule> | null = null;
function getPdfium(): Promise<WrappedPdfiumModule> {
  if (!pdfiumPromise) {
    pdfiumPromise = (async () => {
      const wasmPath = resolveWasm();
      const wasmBinary = fs.readFileSync(wasmPath);
      const m = await init({ wasmBinary: wasmBinary.buffer.slice(wasmBinary.byteOffset, wasmBinary.byteOffset + wasmBinary.byteLength) } as any);
      m.PDFiumExt_Init();
      return m;
    })();
    pdfiumPromise.catch(() => { pdfiumPromise = null; });
  }
  return pdfiumPromise;
}

// Semua akses PDFium dilakukan berurutan (modul wasm single-threaded & state
// global) — antrikan supaya dua request bersamaan tidak saling tumpang.
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

const FPDF_PAGEOBJ_TEXT = 1;

export interface PdfTextSegment { start: number; end: number; bold: boolean; italic: boolean }
export interface PdfTextLine {
  id: string;
  text: string;
  // Kotak baris dalam point, origin kiri-atas halaman (sama dgn pdf.js scale 1)
  x: number; y: number; w: number; h: number;
  baseline: number; // jarak baseline dari atas halaman
  fontSize: number;
  family: "serif" | "sans" | "mono";
  bold: boolean;
  italic: boolean;
  color: string; // #rrggbb
  segments: PdfTextSegment[];
}
export interface PdfPageLayout {
  index: number;
  width: number;
  height: number;
  editable: boolean;
  reason?: string;
  lines: PdfTextLine[];
}

export interface PdfLineEdit { lineId: string; oldText: string; newText: string }
export interface PdfAddText { page: number; x: number; y: number; text: string; size: number }
export interface PdfCover { page: number; x: number; y: number; w: number; h: number }
export interface PdfEditRequest { edits: PdfLineEdit[]; addTexts?: PdfAddText[]; covers?: PdfCover[] }

// --- helper memori wasm -----------------------------------------------------
type M = WrappedPdfiumModule;
function heap(m: M): Uint8Array { return (m.pdfium as any).HEAPU8; }
function malloc(m: M, n: number) { return m.pdfium.wasmExports.malloc(n); }
function free(m: M, p: number) { if (p) m.pdfium.wasmExports.free(p); }
function f32(m: M, p: number) { return m.pdfium.getValue(p, "float"); }

function withFloats<T>(m: M, n: number, fn: (ptr: number) => T): T {
  const p = malloc(m, 4 * n);
  try { return fn(p); } finally { free(m, p); }
}

function utf16Ptr(m: M, s: string): number {
  const bytes = (s.length + 1) * 2;
  const p = malloc(m, bytes);
  m.pdfium.stringToUTF16(s, p, bytes);
  return p;
}

interface OpenDoc { doc: number; dataPtr: number }
function openDoc(m: M, buf: Buffer): OpenDoc {
  const dataPtr = malloc(m, buf.length);
  heap(m).set(buf, dataPtr);
  const doc = m.FPDF_LoadMemDocument(dataPtr, buf.length, "");
  if (!doc) {
    free(m, dataPtr);
    const err = m.FPDF_GetLastError();
    throw Object.assign(new Error(err === 4 ? "PDF dilindungi password — tidak bisa diedit." : "PDF tidak bisa dibuka (rusak atau format tidak didukung)."), { status: 400 });
  }
  return { doc, dataPtr };
}
function closeDoc(m: M, d: OpenDoc) {
  m.FPDF_CloseDocument(d.doc);
  free(m, d.dataPtr);
}

function saveDoc(m: M, doc: number): Buffer {
  const writer = m.PDFiumExt_OpenFileWriter();
  try {
    if (!m.PDFiumExt_SaveAsCopy(doc, writer)) throw new Error("Gagal menyimpan PDF hasil edit.");
    const size = m.PDFiumExt_GetFileWriterSize(writer);
    const p = malloc(m, size);
    try {
      m.PDFiumExt_GetFileWriterData(writer, p, size);
      return Buffer.from(heap(m).slice(p, p + size));
    } finally { free(m, p); }
  } finally { m.PDFiumExt_CloseFileWriter(writer); }
}

// --- baca objek teks ---------------------------------------------------------
interface TextObj {
  obj: number;
  font: number;
  text: string;
  size: number; // ukuran efektif (point)
  rawSize: number; // ukuran di text space (param Tf)
  matrix: [number, number, number, number, number, number];
  left: number; bottom: number; right: number; top: number;
  bold: boolean; italic: boolean;
  family: "serif" | "sans" | "mono";
  fontName: string;
  color: [number, number, number, number];
}

function objText(m: M, obj: number, textPage: number): string {
  const need = m.FPDFTextObj_GetText(obj, textPage, 0, 0);
  if (need <= 2) return "";
  const p = malloc(m, need);
  try {
    m.FPDFTextObj_GetText(obj, textPage, p, need);
    return m.pdfium.UTF16ToString(p);
  } finally { free(m, p); }
}

function fontInfo(m: M, font: number) {
  let name = "";
  const need = m.FPDFFont_GetBaseFontName(font, 0, 0);
  if (need > 1) {
    const p = malloc(m, need);
    try { m.FPDFFont_GetBaseFontName(font, p, need); name = m.pdfium.UTF8ToString(p); } finally { free(m, p); }
  }
  const clean = name.replace(/^[A-Z]{6}\+/, "");
  const weight = m.FPDFFont_GetWeight(font);
  const angle = withFloats(m, 1, (p) => (m.FPDFFont_GetItalicAngle(font, p) ? m.pdfium.getValue(p, "i32") : 0));
  const flags = m.FPDFFont_GetFlags(font);
  const lower = clean.toLowerCase();
  const bold = weight >= 600 || /bold|black|heavy|semibold|demi/.test(lower);
  const italic = angle !== 0 || /italic|oblique/.test(lower);
  const mono = (flags & 1) !== 0 || /courier|mono|consol/.test(lower);
  const serif = !mono && ((flags & 2) !== 0 || /times|serif|roman|georgia|cambria|garamond|book|minion|palatino/.test(lower)) && !/sans|arial|helvet|calibri|verdana|tahoma|segoe/.test(lower);
  return { name: clean, bold, italic, family: (mono ? "mono" : serif ? "serif" : "sans") as TextObj["family"] };
}

function readTextObjects(m: M, page: number, textPage: number, fontCache: Map<number, ReturnType<typeof fontInfo>>): TextObj[] {
  const out: TextObj[] = [];
  const n = m.FPDFPage_CountObjects(page);
  for (let i = 0; i < n; i++) {
    const obj = m.FPDFPage_GetObject(page, i);
    if (!obj || m.FPDFPageObj_GetType(obj) !== FPDF_PAGEOBJ_TEXT) continue;
    // Teks tak terlihat (mis. lapisan OCR) tidak ditampilkan sbg baris edit.
    if (m.FPDFTextObj_GetTextRenderMode(obj) === 3) continue;
    const text = objText(m, obj, textPage);
    if (!text) continue;
    const matrix = withFloats(m, 6, (p) => {
      if (!m.FPDFPageObj_GetMatrix(obj, p)) return null;
      return [0, 1, 2, 3, 4, 5].map((k) => f32(m, p + 4 * k)) as TextObj["matrix"];
    });
    if (!matrix) continue;
    const rawSize = withFloats(m, 1, (p) => (m.FPDFTextObj_GetFontSize(obj, p) ? f32(m, p) : 0));
    const bounds = withFloats(m, 4, (p) => {
      // GetBounds(obj, &left, &bottom, &right, &top)
      if (!m.FPDFPageObj_GetBounds(obj, p, p + 4, p + 8, p + 12)) return null;
      return [f32(m, p), f32(m, p + 4), f32(m, p + 8), f32(m, p + 12)];
    });
    if (!bounds) continue;
    const font = m.FPDFTextObj_GetFont(obj);
    let fi = fontCache.get(font);
    if (!fi) { fi = fontInfo(m, font); fontCache.set(font, fi); }
    const color = withFloats(m, 4, (p) => {
      const ok = m.FPDFPageObj_GetFillColor(obj, p, p + 4, p + 8, p + 12);
      const g = (k: number) => m.pdfium.getValue(p + 4 * k, "i32") >>> 0;
      return (ok ? [g(0), g(1), g(2), g(3)] : [0, 0, 0, 255]) as TextObj["color"];
    });
    const [a, b, c, d] = matrix;
    const scale = Math.sqrt(Math.abs(a * d - b * c)) || 1;
    out.push({
      obj, font, text, rawSize, size: rawSize * scale, matrix,
      left: bounds[0], bottom: bounds[1], right: bounds[2], top: bounds[3],
      bold: fi.bold, italic: fi.italic, family: fi.family, fontName: fi.name, color,
    });
  }
  return out;
}

interface Line { objs: TextObj[]; text: string; ranges: { start: number; end: number }[] }

/** Kelompokkan objek teks jadi baris (baseline sama, jarak horizontal wajar). */
function groupLines(objs: TextObj[]): { lines: Line[]; skipped: number } {
  let skipped = 0;
  const flat = objs.filter((o) => {
    const [a, b, c] = o.matrix;
    const horizontal = Math.abs(b) < 1e-3 * Math.abs(a) && Math.abs(c) < 1e-3 * Math.abs(a) && a > 0;
    if (!horizontal) skipped++;
    return horizontal && o.size > 0;
  });
  flat.sort((p, q) => (Math.abs(q.matrix[5] - p.matrix[5]) > 0.5 ? q.matrix[5] - p.matrix[5] : p.left - q.left));
  const lines: Line[] = [];
  let cur: TextObj[] = [];
  const flush = () => { if (cur.length) { lines.push(buildLine(cur)); cur = []; } };
  for (const o of flat) {
    const last = cur[cur.length - 1];
    if (last) {
      const sameBaseline = Math.abs(o.matrix[5] - last.matrix[5]) <= Math.max(0.35 * Math.min(o.size, last.size), 0.8);
      const gap = o.left - last.right;
      const close = gap <= 2.2 * Math.max(o.size, last.size) && gap >= -0.5 * last.size;
      if (!(sameBaseline && close)) flush();
    }
    cur.push(o);
  }
  flush();
  return { lines, skipped };
}

function buildLine(objs: TextObj[]): Line {
  let text = "";
  const ranges: Line["ranges"] = [];
  objs.forEach((o, i) => {
    if (i > 0) {
      const prev = objs[i - 1];
      const gap = o.left - prev.right;
      if (gap > 0.18 * Math.min(o.size, prev.size) && !/\s$/.test(text) && !/^\s/.test(o.text)) text += " ";
    }
    ranges.push({ start: text.length, end: text.length + o.text.length });
    text += o.text;
  });
  return { objs, text, ranges };
}

interface PageCtx { page: number; textPage: number; width: number; height: number; cropLeft: number; cropTop: number; rotation: number }
function openPage(m: M, doc: number, i: number): PageCtx {
  const page = m.FPDF_LoadPage(doc, i);
  const textPage = m.FPDFText_LoadPage(page);
  const width = m.FPDF_GetPageWidthF(page);
  const height = m.FPDF_GetPageHeightF(page);
  const box = withFloats(m, 4, (p) => {
    // GetCropBox(page, &left, &bottom, &right, &top); fallback MediaBox
    if (m.FPDFPage_GetCropBox(page, p, p + 4, p + 8, p + 12) || m.FPDFPage_GetMediaBox(page, p, p + 4, p + 8, p + 12)) {
      return [f32(m, p), f32(m, p + 4), f32(m, p + 8), f32(m, p + 12)];
    }
    return [0, 0, width, height];
  });
  return { page, textPage, width, height, cropLeft: Math.min(box[0], box[2]), cropTop: Math.max(box[1], box[3]), rotation: m.FPDFPage_GetRotation(page) };
}
function closePage(m: M, pc: PageCtx) {
  m.FPDFText_ClosePage(pc.textPage);
  m.FPDF_ClosePage(pc.page);
}

const hex = (c: TextObj["color"]) => "#" + c.slice(0, 3).map((v) => v.toString(16).padStart(2, "0")).join("");

function layoutOfPage(i: number, pc: PageCtx, objs: TextObj[]): { layout: PdfPageLayout; lines: Line[] } {
  if (pc.rotation !== 0) {
    return { layout: { index: i, width: pc.width, height: pc.height, editable: false, reason: "Halaman berotasi — teks dikunci.", lines: [] }, lines: [] };
  }
  const { lines } = groupLines(objs);
  const out: PdfTextLine[] = lines.map((ln, k) => {
    const left = Math.min(...ln.objs.map((o) => o.left));
    const right = Math.max(...ln.objs.map((o) => o.right));
    const top = Math.max(...ln.objs.map((o) => o.top));
    const bottom = Math.min(...ln.objs.map((o) => o.bottom));
    const first = ln.objs[0];
    const size = Math.max(...ln.objs.map((o) => o.size));
    return {
      id: `${i}:${k}`,
      text: ln.text,
      x: left - pc.cropLeft,
      y: pc.cropTop - top,
      w: right - left,
      h: top - bottom,
      baseline: pc.cropTop - first.matrix[5],
      fontSize: size,
      family: first.family,
      bold: first.bold,
      italic: first.italic,
      color: hex(first.color),
      segments: ln.objs.map((o, j) => ({ start: ln.ranges[j].start, end: ln.ranges[j].end, bold: o.bold, italic: o.italic })),
    };
  });
  return { layout: { index: i, width: pc.width, height: pc.height, editable: true, lines: out }, lines };
}

export function extractPdfLayout(buf: Buffer): Promise<{ pages: PdfPageLayout[]; textObjects: number }> {
  return serialized(async () => {
    const m = await getPdfium();
    const d = openDoc(m, buf);
    try {
      const n = m.FPDF_GetPageCount(d.doc);
      const fontCache = new Map();
      const pages: PdfPageLayout[] = [];
      let total = 0;
      for (let i = 0; i < n; i++) {
        const pc = openPage(m, d.doc, i);
        try {
          const objs = readTextObjects(m, pc.page, pc.textPage, fontCache);
          total += objs.length;
          pages.push(layoutOfPage(i, pc, objs).layout);
        } finally { closePage(m, pc); }
      }
      return { pages, textObjects: total };
    } finally { closeDoc(m, d); }
  });
}

// --- terapkan edit -------------------------------------------------------------

const STD_FONTS: Record<TextObj["family"], [string, string, string, string]> = {
  serif: ["Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic"],
  sans: ["Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique"],
  mono: ["Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique"],
};
function stdFontName(o: Pick<TextObj, "family" | "bold" | "italic">) {
  return STD_FONTS[o.family][(o.bold ? 1 : 0) + (o.italic ? 2 : 0)];
}
// Font standar PDF hanya mendukung WinAnsi (Latin-1 + beberapa tanda baca).
const WIN_ANSI_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
function winAnsiSafe(s: string) {
  return Array.from(s).every((ch) => { const c = ch.codePointAt(0)!; return (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WIN_ANSI_EXTRA.includes(ch); });
}

function setMatrix(m: M, obj: number, mt: TextObj["matrix"]) {
  withFloats(m, 6, (p) => {
    mt.forEach((v, k) => m.pdfium.setValue(p + 4 * k, v, "float"));
    m.FPDFPageObj_SetMatrix(obj, p);
  });
}
function objRight(m: M, obj: number): number {
  return withFloats(m, 4, (p) => (m.FPDFPageObj_GetBounds(obj, p, p + 4, p + 8, p + 12) ? f32(m, p + 8) : 0));
}

/**
 * Ganti teks satu objek. Return objek (bisa handle baru) + tepi kanan baru.
 * Font asli dipakai bila semua karakter tersedia; kalau tidak, font standar.
 */
function replaceObjText(m: M, doc: number, page: number, o: TextObj, newText: string, fontChars: Map<number, Set<string>>): { obj: number; usedFallback: boolean } {
  const avail = fontChars.get(o.font);
  const canReuse = !!avail && Array.from(newText).every((ch) => avail.has(ch));
  if (canReuse) {
    const p = utf16Ptr(m, newText);
    try {
      if (m.FPDFText_SetText(o.obj, p)) return { obj: o.obj, usedFallback: false };
    } finally { free(m, p); }
  }
  if (!winAnsiSafe(newText)) {
    throw Object.assign(new Error(`Karakter pada "${newText.slice(0, 40)}" tidak didukung font PDF ini. Gunakan karakter Latin standar atau Unggah Revisi.`), { status: 400 });
  }
  const nobj = m.FPDFPageObj_NewTextObj(doc, stdFontName(o), o.rawSize || o.size);
  if (!nobj) throw new Error("Gagal membuat objek teks baru.");
  const p = utf16Ptr(m, newText);
  try { m.FPDFText_SetText(nobj, p); } finally { free(m, p); }
  setMatrix(m, nobj, o.matrix);
  const [r, g, b, a] = o.color;
  m.FPDFPageObj_SetFillColor(nobj, r, g, b, a);
  m.FPDFPage_InsertObject(page, nobj);
  m.FPDFPage_RemoveObject(page, o.obj);
  m.FPDFPageObj_Destroy(o.obj);
  return { obj: nobj, usedFallback: true };
}

function applyLineEdit(m: M, doc: number, page: number, line: Line, newText: string, fontChars: Map<number, Set<string>>, centerX?: number, marginLeft?: number): { fallback: boolean } {
  const origLeft = Math.min(...line.objs.map((o) => o.left));
  const origRight = Math.max(...line.objs.map((o) => o.right));
  // Baris yang tadinya rata-tengah (judul, kop) dijaga tetap di tengah.
  // Baris rata kiri/justify yang kebetulan selebar area teks juga "di tengah"
  // secara geometris — dibedakan lewat tepi kirinya yang menempel margin.
  const wasCentered = centerX !== undefined && Math.abs((origLeft + origRight) / 2 - centerX) <= 2
    && !(marginLeft !== undefined && Math.abs(origLeft - marginLeft) <= 2);
  const alive = line.objs.map(() => true);
  // Hunks perubahan dalam koordinat teks baris lama.
  type Hunk = { start: number; end: number; ins: string };
  const hunks: Hunk[] = [];
  let pos = 0;
  for (const part of diffChars(line.text, newText)) {
    if (part.added) {
      const last = hunks[hunks.length - 1];
      if (last && last.end === pos) last.ins += part.value;
      else hunks.push({ start: pos, end: pos, ins: part.value });
    } else if (part.removed) {
      const last = hunks[hunks.length - 1];
      if (last && last.end === pos) last.end += part.value.length;
      else hunks.push({ start: pos, end: pos + part.value.length, ins: "" });
      pos += part.value.length;
    } else pos += part.value.length;
  }
  if (!hunks.length) return { fallback: false };

  // Objek pemilik posisi: posisi di celah/ujung ikut objek di KIRI-nya
  // (mengetik di akhir kata melanjutkan format kata itu, seperti Word).
  const ownerAt = (p: number, isEnd: boolean) => {
    for (let k = 0; k < line.ranges.length; k++) {
      const r = line.ranges[k];
      const next = line.ranges[k + 1];
      if (isEnd ? p <= r.end : p < r.end) return k;
      if (next && p < next.start) return k; // di separator
    }
    return line.ranges.length - 1;
  };
  // Tiap hunk -> rentang objek [k1..k2]; gabungkan yang beririsan.
  type Group = { k1: number; k2: number; hunks: Hunk[] };
  const groups: Group[] = [];
  for (const h of hunks) {
    const k1 = ownerAt(h.start, h.start === h.end);
    const k2 = h.end > h.start ? ownerAt(h.end, true) : k1;
    const g = groups[groups.length - 1];
    if (g && k1 <= g.k2) { g.k2 = Math.max(g.k2, k2); g.hunks.push(h); }
    else groups.push({ k1, k2, hunks: [h] });
  }

  let fallback = false;
  // Proses dari kanan ke kiri supaya pergeseran objek sesudahnya benar.
  for (const g of groups.reverse()) {
    const spanStart = line.ranges[g.k1].start;
    const spanEnd = line.ranges[g.k2].end;
    let seg = line.text.slice(spanStart, spanEnd);
    for (const h of [...g.hunks].sort((a, b) => b.start - a.start)) {
      const s = Math.max(h.start, spanStart) - spanStart;
      const e = Math.min(Math.max(h.end, h.start), spanEnd) - spanStart;
      seg = seg.slice(0, s) + h.ins + seg.slice(Math.max(s, e));
    }
    const target = line.objs[g.k1];
    const oldRight = line.objs[g.k2].right;
    // Objek lain dalam grup dilebur ke objek pertama.
    for (let k = g.k1 + 1; k <= g.k2; k++) {
      m.FPDFPage_RemoveObject(page, line.objs[k].obj);
      m.FPDFPageObj_Destroy(line.objs[k].obj);
      alive[k] = false;
    }
    let newRight = target.left;
    if (seg.length === 0) {
      m.FPDFPage_RemoveObject(page, target.obj);
      m.FPDFPageObj_Destroy(target.obj);
      alive[g.k1] = false;
    } else {
      const r = replaceObjText(m, doc, page, target, seg, fontChars);
      fallback = fallback || r.usedFallback;
      target.obj = r.obj;
      newRight = objRight(m, r.obj);
      target.right = newRight;
    }
    // Geser objek sesudahnya di baris ini sebesar selisih lebar.
    const delta = newRight - oldRight;
    if (Math.abs(delta) > 0.01) {
      for (let k = g.k2 + 1; k < line.objs.length; k++) {
        m.FPDFPageObj_Transform(line.objs[k].obj, 1, 0, 0, 1, delta, 0);
        line.objs[k].left += delta;
        line.objs[k].right += delta;
      }
    }
  }
  if (wasCentered) {
    const live = line.objs.filter((_, k) => alive[k]);
    if (live.length) {
      const nl = Math.min(...live.map((o) => o.left));
      const nr = Math.max(...live.map((o) => o.right));
      const shift = (origLeft + origRight) / 2 - (nl + nr) / 2;
      if (Math.abs(shift) > 0.01) for (const o of live) m.FPDFPageObj_Transform(o.obj, 1, 0, 0, 1, shift, 0);
    }
  }
  return { fallback };
}

export interface PdfEditResult { pdf: Buffer; changedLines: number; fallbackLines: number; added: number; covered: number }

export function applyPdfEdits(buf: Buffer, req: PdfEditRequest): Promise<PdfEditResult> {
  return serialized(async () => {
    const m = await getPdfium();
    const d = openDoc(m, buf);
    try {
      const n = m.FPDF_GetPageCount(d.doc);
      const byPage = new Map<number, { edits: PdfLineEdit[]; adds: PdfAddText[]; covers: PdfCover[] }>();
      const bucket = (p: number) => {
        if (!Number.isInteger(p) || p < 0 || p >= n) throw Object.assign(new Error(`Halaman ${p + 1} tidak ada.`), { status: 400 });
        let b = byPage.get(p);
        if (!b) { b = { edits: [], adds: [], covers: [] }; byPage.set(p, b); }
        return b;
      };
      for (const e of req.edits || []) bucket(Number(String(e.lineId).split(":")[0])).edits.push(e);
      for (const a of req.addTexts || []) bucket(a.page).adds.push(a);
      for (const c of req.covers || []) bucket(c.page).covers.push(c);

      // Peta karakter yang tersedia per font (seluruh dokumen) — penentu
      // apakah font asli (subset) bisa dipakai utk teks baru.
      const fontCache = new Map();
      const fontChars = new Map<number, Set<string>>();
      for (let i = 0; i < n; i++) {
        const pc = openPage(m, d.doc, i);
        try {
          for (const o of readTextObjects(m, pc.page, pc.textPage, fontCache)) {
            let s = fontChars.get(o.font);
            if (!s) { s = new Set(); fontChars.set(o.font, s); }
            for (const ch of o.text) s.add(ch);
          }
        } finally { closePage(m, pc); }
      }

      let changedLines = 0, fallbackLines = 0, added = 0, covered = 0;
      for (const [pi, work] of byPage) {
        const pc = openPage(m, d.doc, pi);
        try {
          const objs = readTextObjects(m, pc.page, pc.textPage, fontCache);
          const { layout, lines } = layoutOfPage(pi, pc, objs);
          if (!layout.editable && work.edits.length) throw Object.assign(new Error(layout.reason || "Halaman tidak bisa diedit."), { status: 400 });
          // Margin kiri halaman = tepi kiri yang paling sering dipakai baris.
          const lefts = new Map<number, number>();
          for (const ln of lines) { const l = Math.round(ln.objs[0].left); lefts.set(l, (lefts.get(l) || 0) + 1); }
          const marginLeft = [...lefts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
          for (const e of work.edits) {
            const k = Number(String(e.lineId).split(":")[1]);
            const line = lines[k];
            if (!line || line.text !== e.oldText) {
              throw Object.assign(new Error("Isi PDF berbeda dari yang sedang diedit (mungkin versi sudah berubah). Muat ulang lalu ulangi."), { status: 409 });
            }
            if (/[\r\n]/.test(e.newText)) throw Object.assign(new Error("Satu baris PDF tidak boleh berisi baris baru."), { status: 400 });
            const r = applyLineEdit(m, d.doc, pc.page, line, e.newText, fontChars, pc.cropLeft + pc.width / 2, marginLeft);
            changedLines++;
            if (r.fallback) fallbackLines++;
          }
          // Tulis dulu hasil edit teks ke content stream SEBELUM redaksi —
          // redaksi mem-parse ulang halaman & bisa membuang perubahan objek
          // yang belum ditulis (ketemu saat pengujian).
          if (work.edits.length && !m.FPDFPage_GenerateContent(pc.page)) throw new Error("Gagal menulis ulang isi halaman PDF.");
          // Tutup = REDAKSI: teks di area dihapus sungguhan, lalu blok putih.
          for (const c of work.covers) {
            const left = pc.cropLeft + c.x, right = left + c.w;
            const top = pc.cropTop - c.y, bottom = top - c.h;
            withFloats(m, 4, (p) => {
              // FS_RECTF { left, top, right, bottom }
              [left, top, right, bottom].forEach((v, k) => m.pdfium.setValue(p + 4 * k, v, "float"));
              m.EPDFText_RedactInRect(pc.page, p, true, false);
            });
            const rect = m.FPDFPageObj_CreateNewRect(left, bottom, c.w, c.h);
            m.FPDFPageObj_SetFillColor(rect, 255, 255, 255, 255);
            m.FPDFPath_SetDrawMode(rect, 1 /* FPDF_FILLMODE_ALTERNATE */, false);
            m.FPDFPage_InsertObject(pc.page, rect);
            covered++;
          }
          for (const a of work.adds) {
            const lines2 = String(a.text || "").replace(/\r/g, "").split("\n");
            const size = Math.min(72, Math.max(4, Number(a.size) || 11));
            lines2.forEach((txt, li) => {
              if (!txt) return;
              if (!winAnsiSafe(txt)) throw Object.assign(new Error("Teks baru berisi karakter yang tidak didukung font standar PDF."), { status: 400 });
              const o = m.FPDFPageObj_NewTextObj(d.doc, "Helvetica", size);
              const p = utf16Ptr(m, txt);
              try { m.FPDFText_SetText(o, p); } finally { free(m, p); }
              const baseY = pc.cropTop - a.y - size - li * size * 1.2;
              m.FPDFPageObj_Transform(o, 1, 0, 0, 1, pc.cropLeft + a.x + 2, baseY);
              m.FPDFPageObj_SetFillColor(o, 0, 0, 0, 255);
              m.FPDFPage_InsertObject(pc.page, o);
            });
            added++;
          }
          if (!m.FPDFPage_GenerateContent(pc.page)) throw new Error("Gagal menulis ulang isi halaman PDF.");
        } finally { closePage(m, pc); }
      }
      return { pdf: saveDoc(m, d.doc), changedLines, fallbackLines, added, covered };
    } finally { closeDoc(m, d); }
  });
}

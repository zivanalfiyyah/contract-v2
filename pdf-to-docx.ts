// ---------------------------------------------------------------------------
// Konversi PDF -> Word (.docx) supaya dokumen hasil Upload bisa diedit
// "seperti Word" (teks turun baris otomatis, Enter = paragraf baru, isi di
// bawahnya ikut bergeser) — tanpa Python / layanan luar.
//
// Kenapa perlu: PDF tidak menyimpan paragraf. Isinya baris-baris teks yang
// masing-masing ditaruh di koordinat tetap, jadi editor PDF (pdf-text-edit.ts)
// hanya bisa mengedit per baris — baris yang ditambah kata memanjang ke kanan.
//
// Cara kerja:
//   1. extractPdfForConversion() (pdf-text-edit.ts, PDFium) membaca baris
//      teks (posisi, ukuran, tebal/miring, warna) + garis/kotak + gambar.
//   2. Baris sebaris (baseline sama) dijadikan satu "row". Row berurutan
//      digabung jadi PARAGRAF bila: ukuran huruf sama, jaraknya = jarak
//      baris normal, baris sebelumnya penuh sampai margin kanan, posisi kiri
//      konsisten, dan bukan awal butir daftar/judul baru.
//   3. Tiap paragraf diberi perataan (kiri / tengah / kanan / rata kiri-
//      kanan), indentasi, jarak sebelum paragraf & jarak baris dari posisi
//      aslinya. Kotak berwarna -> shading paragraf; garis horizontal ->
//      garis bawah paragraf; gambar -> gambar inline; teks yang berulang di
//      atas/bawah tiap halaman -> header/footer (nomor halaman jadi field).
//   4. Disusun jadi .docx standar (JSZip): hanya paragraf & run biasa —
//      tanpa kotak teks melayang — supaya editor Word di workspace
//      (docx-patch.ts) bisa memasangkan & mengedit semua paragrafnya.
//
// Batasan: PDF hasil scan (isinya gambar) ditolak dengan pesan jelas; tabel
// bergaris menjadi baris ber-tab (garis tabel tidak ikut); tata letak dua
// kolom/objek bertumpuk bisa bergeser. PDF asli TIDAK pernah diubah —
// hasilnya disimpan sebagai versi baru.
// ---------------------------------------------------------------------------
import JSZip from "jszip";
import zlib from "zlib";
import {
  extractPdfForConversion,
  type PdfConversionPage, type PdfTextLine, type PdfGraphicRect, type PdfGraphicImage,
} from "./pdf-text-edit.js";

// --- util ---------------------------------------------------------------------
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tw = (pt: number) => Math.max(0, Math.round(pt * 20)); // point -> twip
const median = (a: number[]) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const percentile = (a: number[], p: number) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))]; };

const FONT_NAME: Record<PdfTextLine["family"], string> = { serif: "Times New Roman", sans: "Arial", mono: "Courier New" };

// --- PNG encoder minimal (gambar/logo dari PDF) -----------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr), pngChunk("IDAT", zlib.deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- model antara ----------------------------------------------------------------
interface Row {
  page: number;
  items: PdfTextLine[]; // urut kiri -> kanan
  x: number; right: number; top: number; bottom: number; baseline: number;
  size: number;
  text: string;
  allBold: boolean;
}
interface Run { text: string; bold: boolean; italic: boolean; size: number; family: PdfTextLine["family"]; color: string; br?: boolean; tab?: boolean; field?: "PAGE" | "NUMPAGES" }
interface Para {
  kind: "text" | "image" | "table";
  page: number; // halaman baris PERTAMA
  lastPage: number; // halaman baris TERAKHIR (paragraf bisa terpotong ke halaman berikut)
  rows: Row[];
  image?: PdfGraphicImage & { rid?: string; idx?: number };
  table?: Table;
  box?: PdfGraphicRect;
  align: "left" | "center" | "right" | "both";
  indLeft: number; indRight: number; firstLine: number; // point (firstLine < 0 = hanging)
  tabs: number[]; // posisi tab (point dari margin kiri)
  before: number; lineExact: number; // point
  bottomRule?: { color: string; width: number; space: number };
  pageBreakBefore?: boolean;
  firstTop: number; lastBottom: number; firstBaseline: number; lastBaseline: number;
}

const LIST_MARKER = /^(\(?\d{1,3}[.)]|\(?[a-zA-Z][.)]|\([ivxIVX]{1,4}\)|[ivx]{1,4}[.)]|[•·▪◦●■\-–—*])\s/;

function isWhiteish(hex: string | null): boolean {
  if (!hex) return true;
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return v.every((c) => c >= 245);
}

function rowsOfPage(page: PdfConversionPage): Row[] {
  const lines = [...page.lines].filter((l) => l.text.trim()).sort((a, b) => a.baseline - b.baseline || a.x - b.x);
  const rows: Row[] = [];
  for (const l of lines) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(l.baseline - last.baseline) <= Math.max(0.35 * Math.min(l.fontSize, last.size), 1)) {
      last.items.push(l);
    } else {
      rows.push({ page: page.index, items: [l], x: 0, right: 0, top: 0, bottom: 0, baseline: l.baseline, size: 0, text: "", allBold: false });
    }
  }
  rows.forEach(finalizeRow);
  return rows;
}

function finalizeRow(r: Row) {
  r.items.sort((a, b) => a.x - b.x);
  r.x = Math.min(...r.items.map((i) => i.x));
  r.right = Math.max(...r.items.map((i) => i.x + i.w));
  r.top = Math.min(...r.items.map((i) => i.y));
  r.bottom = Math.max(...r.items.map((i) => i.y + i.h));
  r.size = Math.max(...r.items.map((i) => i.fontSize));
  r.text = r.items.map((i) => i.text).join("\t");
  r.allBold = r.items.every((i) => i.segments.length ? i.segments.every((s) => s.bold) : i.bold);
}

// --- tabel bergaris ---------------------------------------------------------------
interface Table {
  page: number;
  x: number; top: number; bottom: number;
  colXs: number[]; // batas kolom (n+1)
  rowYs: number[]; // batas baris (m+1)
  cells: PdfTextLine[][][]; // [baris][kolom] -> baris teks di sel itu
  color: string; width: number;
}

/**
 * Kenali tabel dari garis tipis: >= 2 garis mendatar dengan lebar sama +
 * >= 2 garis tegak di antaranya = kisi tabel. Tabel tanpa garis tegak tidak
 * dikenali (isinya tetap jadi baris ber-tab).
 */
function detectTables(page: PdfConversionPage): { tables: Table[]; used: Set<PdfGraphicRect> } {
  const ink = (r: PdfGraphicRect) => !isWhiteish(r.stroke) || !isWhiteish(r.fill);
  const H = page.rects.filter((r) => r.h <= 3 && r.w >= 20 && ink(r)).sort((a, b) => a.y - b.y);
  const V = page.rects.filter((r) => r.w <= 3 && r.h >= 6 && ink(r));
  const used = new Set<PdfGraphicRect>();
  const tables: Table[] = [];
  const merge = (vals: number[]) => {
    const out: number[] = [];
    for (const v of [...vals].sort((a, b) => a - b)) if (!out.length || v - out[out.length - 1] > 3) out.push(v);
    return out;
  };
  for (const h0 of H) {
    if (used.has(h0)) continue;
    const same = H.filter((h) => !used.has(h) && Math.abs(h.x - h0.x) <= 4 && Math.abs(h.x + h.w - (h0.x + h0.w)) <= 4);
    // pecah bila ada jeda vertikal besar (dua tabel berbeda dgn lebar sama)
    let group: PdfGraphicRect[] = [];
    const groups: PdfGraphicRect[][] = [];
    for (const h of same) {
      if (group.length && h.y - group[group.length - 1].y > 160) { groups.push(group); group = []; }
      group.push(h);
    }
    if (group.length) groups.push(group);
    for (const g of groups) {
      const ys = merge(g.map((h) => h.y + h.h / 2));
      if (ys.length < 2) continue;
      const top = ys[0], bottom = ys[ys.length - 1];
      const left = Math.min(...g.map((h) => h.x)), right = Math.max(...g.map((h) => h.x + h.w));
      const vs = V.filter((v) => v.x + v.w / 2 >= left - 4 && v.x + v.w / 2 <= right + 4 && v.y >= top - 4 && v.y + v.h <= bottom + 4);
      const xs = merge([left, right, ...vs.map((v) => v.x + v.w / 2)]);
      if (vs.length < 2 || xs.length < 2) continue;
      g.forEach((h) => used.add(h));
      vs.forEach((v) => used.add(v));
      const first = g[0];
      tables.push({
        page: page.index, x: xs[0], top, bottom, colXs: xs, rowYs: ys,
        cells: Array.from({ length: ys.length - 1 }, () => Array.from({ length: xs.length - 1 }, () => [] as PdfTextLine[])),
        color: !isWhiteish(first.stroke) ? first.stroke! : first.fill!, width: Math.max(0.25, first.strokeWidth || first.h || 0.5),
      });
    }
  }
  return { tables, used };
}

/** Run-run (tebal/miring per potongan) dari satu baris teks PDF. */
function runsOfLine(l: PdfTextLine): Run[] {
  const base = { size: l.fontSize, family: l.family, color: l.color };
  if (!l.segments.length) return [{ text: l.text, bold: l.bold, italic: l.italic, ...base }];
  const runs: Run[] = [];
  let pos = 0;
  const push = (text: string, bold: boolean, italic: boolean) => {
    if (!text) return;
    const last = runs[runs.length - 1];
    if (last && last.bold === bold && last.italic === italic) last.text += text;
    else runs.push({ text, bold, italic, ...base });
  };
  let prev = { bold: l.bold, italic: l.italic };
  for (const s of l.segments) {
    if (s.start > pos) push(l.text.slice(pos, s.start), prev.bold, prev.italic); // spasi sisipan antar objek
    push(l.text.slice(s.start, s.end), s.bold, s.italic);
    prev = { bold: s.bold, italic: s.italic };
    pos = s.end;
  }
  if (pos < l.text.length) push(l.text.slice(pos), prev.bold, prev.italic);
  return runs;
}

/** Nomor halaman di header/footer -> field PAGE / NUMPAGES. */
function runsWithPageFields(r: Row, pageNo: number, total: number): Run[] {
  const out: Run[] = [];
  r.items.forEach((it, k) => {
    if (k > 0) out.push({ text: "", tab: true, bold: false, italic: false, size: it.fontSize, family: it.family, color: it.color });
    for (const run of runsOfLine(it)) {
      const parts = run.text.split(/(\d+)/);
      for (const part of parts) {
        if (!part) continue;
        const n = /^\d+$/.test(part) ? Number(part) : NaN;
        if (n === pageNo) out.push({ ...run, text: String(n), field: "PAGE" });
        else if (n === total && total !== pageNo) out.push({ ...run, text: String(n), field: "NUMPAGES" });
        else out.push({ ...run, text: part });
      }
    }
  });
  return out;
}

// --- analisis dokumen -------------------------------------------------------------
export interface ConversionStats { pages: number; paragraphs: number; tables: number; images: number; boxes: number; rules: number; headerFooter: boolean }

export async function convertPdfToDocx(pdf: Buffer): Promise<{ docx: Buffer; stats: ConversionStats }> {
  const { pages } = await extractPdfForConversion(pdf);
  if (!pages.length) throw Object.assign(new Error("PDF tidak memiliki halaman."), { status: 400 });
  if (pages.some((p) => !p.editable)) {
    throw Object.assign(new Error("PDF ini memiliki halaman berotasi — belum bisa diubah ke Word. Gunakan \"Unggah Revisi\" dengan berkas Word-nya."), { status: 422 });
  }
  const totalChars = pages.reduce((n, p) => n + p.lines.reduce((m, l) => m + l.text.trim().length, 0), 0);
  if (totalChars < 20) {
    throw Object.assign(new Error("PDF ini tampaknya hasil scan (isinya gambar, bukan teks), jadi tidak bisa diubah menjadi Word yang bisa diedit. Gunakan \"Unggah Revisi\" dengan berkas Word-nya, atau edit per baris."), { status: 422 });
  }

  const pageW = pages[0].width, pageH = pages[0].height;
  const total = pages.length;
  const pageRows = pages.map(rowsOfPage);

  // Header/footer: row di pita atas/bawah halaman yang berulang di >= 2 halaman.
  const norm = (s: string) => s.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().toLowerCase();
  const band = (r: Row, which: "top" | "bottom") => (which === "top" ? r.bottom < pageH * 0.1 : r.top > pageH * 0.9);
  const repeated = (which: "top" | "bottom") => {
    if (total < 2) return new Set<string>();
    const counts = new Map<string, number>();
    pageRows.forEach((rows) => {
      const seen = new Set(rows.filter((r) => band(r, which)).map((r) => norm(r.text)));
      seen.forEach((k) => counts.set(k, (counts.get(k) || 0) + 1));
    });
    return new Set([...counts].filter(([, c]) => c >= Math.max(2, Math.ceil(total * 0.6))).map(([k]) => k));
  };
  const headKeys = repeated("top"), footKeys = repeated("bottom");
  const headerRows: Row[] = [], footerRows: Row[] = [];
  const bodyRows = pageRows.map((rows, pi) => rows.filter((r) => {
    if (band(r, "top") && headKeys.has(norm(r.text))) { if (pi === 0) headerRows.push(r); return false; }
    if (band(r, "bottom") && footKeys.has(norm(r.text))) { if (pi === 0) footerRows.push(r); return false; }
    return true;
  }));
  // Tabel bergaris: isi selnya diambil dari aliran baris biasa.
  const tablesByPage = pages.map(detectTables);
  bodyRows.forEach((rows, pi) => {
    const { tables } = tablesByPage[pi];
    if (!tables.length) return;
    for (const r of rows) {
      r.items = r.items.filter((it) => {
        const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
        const t = tables.find((tb) => cy >= tb.top && cy <= tb.bottom && cx >= tb.colXs[0] && cx <= tb.colXs[tb.colXs.length - 1]);
        if (!t) return true;
        const ri = Math.max(0, t.rowYs.findIndex((y, k) => cy >= y && cy < (t.rowYs[k + 1] ?? Infinity)));
        const ci = Math.max(0, t.colXs.findIndex((x, k) => cx >= x && cx < (t.colXs[k + 1] ?? Infinity)));
        t.cells[Math.min(ri, t.cells.length - 1)][Math.min(ci, t.cells[0].length - 1)].push(it);
        return false;
      });
      if (r.items.length) finalizeRow(r);
    }
    bodyRows[pi] = rows.filter((r) => r.items.length);
  });
  const allBody = bodyRows.flat();
  if (!allBody.length) throw Object.assign(new Error("Tidak ada teks isi yang bisa dikonversi."), { status: 422 });

  // Batas area tulis (margin) dari posisi teks.
  const wide = allBody.filter((r) => r.right - r.x > pageW * 0.4);
  const L = wide.length ? percentile(wide.map((r) => r.x), 0.1) : Math.min(...allBody.map((r) => r.x));
  const R = Math.max(L + 50, percentile((wide.length ? wide : allBody).map((r) => r.right), 0.9));
  const C = (L + R) / 2;
  const bodyW = R - L;

  // Jarak baris "normal" per ukuran huruf (median jarak baseline berurutan).
  const pitchBySize = new Map<number, number[]>();
  bodyRows.forEach((rows) => rows.forEach((r, i) => {
    const n = rows[i + 1];
    if (!n || Math.abs(n.size - r.size) > 0.6) return;
    const d = n.baseline - r.baseline;
    if (d > 0.9 * r.size && d < 1.8 * r.size) {
      const k = Math.round(r.size * 2) / 2;
      pitchBySize.set(k, [...(pitchBySize.get(k) || []), d]);
    }
  }));
  const pitchOf = (size: number) => {
    const k = Math.round(size * 2) / 2;
    const arr = pitchBySize.get(k);
    return arr && arr.length ? median(arr) : size * 1.2;
  };

  // Grafik: kotak berwarna, garis horizontal, gambar.
  const pageArea = pageW * pageH;
  const boxesByPage = pages.map((p) => p.rects.filter((r) =>
    r.w > 30 && r.h > 8 && r.w * r.h < pageArea * 0.85 && (!isWhiteish(r.fill) || (r.stroke && !isWhiteish(r.stroke)))));
  const rulesByPage = pages.map((p, pi) => p.rects.filter((r) =>
    !tablesByPage[pi].used.has(r) && r.h <= 3 && r.w >= bodyW * 0.3 && (!isWhiteish(r.fill) || !isWhiteish(r.stroke))));
  const imagesByPage = pages.map((p) => p.images.filter((im) =>
    im.rgba && im.w > 8 && im.h > 8 && im.w * im.h < pageArea * 0.8));

  const boxOf = (r: Row) => boxesByPage[r.page].find((b) => {
    const mid = (r.top + r.bottom) / 2;
    return mid >= b.y - 1 && mid <= b.y + b.h + 1 && r.x >= b.x - 3 && r.right <= b.x + b.w + 3;
  });

  // --- gabung row -> paragraf (aliran lintas halaman) -------------------------------
  type Item = { kind: "row"; row: Row } | { kind: "image"; page: number; img: PdfGraphicImage } | { kind: "table"; page: number; table: Table };
  const stream: Item[] = [];
  bodyRows.forEach((rows, pi) => {
    const items: (Item & { y: number })[] = [
      ...rows.map((row) => ({ kind: "row" as const, row, y: row.top })),
      ...imagesByPage[pi].map((img) => ({ kind: "image" as const, page: pi, img, y: img.y })),
      ...tablesByPage[pi].tables.map((table) => ({ kind: "table" as const, page: pi, table, y: table.top })),
    ];
    items.sort((a, b) => a.y - b.y);
    stream.push(...items);
  });

  const fullWidth = (r: Row) => r.right >= R - Math.max(bodyW * 0.07, 2.5 * r.size);
  // Rata tengah = ada ruang kosong di KIRI dan KANAN yang kira-kira sama.
  // (Baris penuh yang sedikit menjorok — mis. butir daftar — bukan tengah.)
  const centered = (r: Row) => {
    const gapL = r.x - L, gapR = R - r.right;
    return gapL > 12 && gapR > 12 && Math.abs(gapL - gapR) <= Math.max(6, bodyW * 0.04);
  };

  const paras: Para[] = [];
  let prevItem: Item | null = null;
  for (const it of stream) {
    if (it.kind === "table") {
      const t = it.table;
      paras.push({
        kind: "table", page: it.page, lastPage: it.page, rows: [], table: t,
        align: "left", indLeft: 0, indRight: 0, firstLine: 0, tabs: [], before: 0, lineExact: 0,
        firstTop: t.top, lastBottom: t.bottom, firstBaseline: t.bottom, lastBaseline: t.bottom,
      });
      prevItem = it;
      continue;
    }
    if (it.kind === "image") {
      const im = it.img;
      const cx = im.x + im.w / 2;
      paras.push({
        kind: "image", page: it.page, lastPage: it.page, rows: [], image: im,
        align: Math.abs(cx - C) < bodyW * 0.08 ? "center" : im.x + im.w >= R - 6 && im.x > C ? "right" : "left",
        indLeft: 0, indRight: 0, firstLine: 0, tabs: [], before: 0, lineExact: 0,
        firstTop: im.y, lastBottom: im.y + im.h, firstBaseline: im.y + im.h, lastBaseline: im.y + im.h,
      });
      prevItem = it;
      continue;
    }
    const r = it.row;
    const cur = paras[paras.length - 1];
    let join = false;
    if (cur && cur.kind === "text" && prevItem?.kind === "row") {
      const p = cur.rows[cur.rows.length - 1];
      const samePage = p.page === r.page;
      const pageTurn = !samePage && r.page === p.page + 1 && bodyRows[r.page][0] === r && bodyRows[p.page][bodyRows[p.page].length - 1] === p;
      const pitch = r.baseline - p.baseline;
      const lineOk = samePage ? pitch > 0 && pitch <= pitchOf(r.size) * 1.18 + 0.6 : pageTurn;
      const leftOk = cur.rows.length >= 2
        ? Math.abs(r.x - cur.rows[1].x) <= 3
        : r.x <= p.x + 3 || (LIST_MARKER.test(p.text) && r.x > p.x && r.x - p.x < 45);
      join = p.items.length === 1 && r.items.length === 1
        && Math.abs(r.size - p.size) <= 0.6
        && boxOf(r) === cur.box
        && lineOk && leftOk
        && fullWidth(p) && !centered(p)
        && !(p.allBold && !r.allBold)
        && !LIST_MARKER.test(r.text);
    }
    if (join) {
      cur.rows.push(r);
      cur.lastPage = r.page;
      cur.lastBottom = r.bottom;
      cur.lastBaseline = r.baseline;
    } else {
      paras.push({
        kind: "text", page: r.page, lastPage: r.page, rows: [r], box: boxOf(r),
        align: "left", indLeft: 0, indRight: 0, firstLine: 0, tabs: [], before: 0, lineExact: 0,
        firstTop: r.top, lastBottom: r.bottom, firstBaseline: r.baseline, lastBaseline: r.baseline,
      });
    }
    prevItem = it;
  }

  // --- perataan, indentasi, spasi ------------------------------------------------
  for (const p of paras) {
    if (p.kind !== "text") continue;
    const rows = p.rows;
    const first = rows[0];
    if (first.items.length > 1) {
      p.align = "left";
      p.indLeft = Math.max(0, first.x - L);
      p.tabs = first.items.slice(1).map((i) => Math.max(0, i.x - L));
    } else if (rows.every(centered)) {
      p.align = "center";
    } else if (rows.length === 1 && Math.abs(first.right - R) <= 3 && first.x - L > bodyW * 0.3) {
      p.align = "right";
    } else {
      const body = rows.slice(0, -1);
      p.align = rows.length >= 2 && body.every((r) => r.right >= R - 3) ? "both" : "left";
      const contX = rows.length >= 2 ? rows[1].x : first.x;
      p.indLeft = Math.max(0, contX - L);
      p.firstLine = first.x - contX;
    }
    if (p.box) {
      // Teks di dalam kotak: indentasi mengikuti tepi kotak (+ ruang dalam).
      p.indLeft = Math.max(p.indLeft, p.box.x - L + 4);
      p.indRight = Math.max(0, R - (p.box.x + p.box.w) + 4);
    }
    const pitches = rows.slice(1).map((r, i) => r.baseline - rows[i].baseline).filter((d) => d > 0);
    p.lineExact = pitches.length ? median(pitches) : pitchOf(first.size);
  }

  // Jarak sebelum paragraf & pindah halaman.
  const lastBottomOnPage = bodyRows.map((rows) => (rows.length ? Math.max(...rows.map((r) => r.bottom)) : 0));
  const bottomLimit = Math.max(...lastBottomOnPage);
  for (let i = 0; i < paras.length; i++) {
    const p = paras[i], prev = paras[i - 1];
    if (!prev) continue;
    if (p.page !== prev.lastPage) {
      // Halaman sebelumnya jauh dari penuh -> memang sengaja halaman baru.
      if (lastBottomOnPage[prev.lastPage] < bottomLimit - pageH * 0.25) p.pageBreakBefore = true;
      continue;
    }
    if (p.kind !== "text" || prev.kind !== "text") {
      p.before = Math.max(0, p.firstTop - prev.lastBottom);
    } else {
      const lineH = p.lineExact || pitchOf(p.rows[0].size);
      p.before = Math.max(0, p.firstBaseline - prev.lastBaseline - lineH);
    }
  }

  // Garis tepi kotak (border paragraf) menambah tinggi: ruang dalam 4pt +
  // tebal garis di atas & bawah kotak. Kurangi dari jarak aslinya supaya
  // posisi teks sesudahnya tidak bergeser turun.
  for (let i = 0; i < paras.length; i++) {
    const p = paras[i], prev = paras[i - 1];
    const bordered = (q?: Para) => !!(q?.box && q.box.stroke && !isWhiteish(q.box.stroke));
    const pad = (q: Para) => 4 + (q.box!.strokeWidth || 0.75);
    if (bordered(p) && prev?.box !== p.box) p.before = Math.max(0, p.before - pad(p));
    if (prev && bordered(prev) && prev.box !== p.box && p.page === prev.lastPage) p.before = Math.max(0, p.before - pad(prev));
  }

  // Garis horizontal -> garis bawah paragraf tepat di atasnya.
  let ruleCount = 0;
  rulesByPage.forEach((rules, pi) => {
    for (const rule of rules) {
      const above = paras.filter((p) => p.lastPage === pi && p.lastBottom <= rule.y + 1).pop();
      if (!above || rule.y - above.lastBottom > 30) continue;
      const color = !isWhiteish(rule.fill) ? rule.fill! : rule.stroke!;
      const space = Math.min(31, Math.max(1, rule.y - above.lastBottom));
      above.bottomRule = { color, width: Math.max(rule.h, rule.strokeWidth || 0.5), space };
      const next = paras[paras.indexOf(above) + 1];
      if (next && next.page === pi) next.before = Math.max(0, next.before - space - above.bottomRule.width);
      ruleCount++;
    }
  });

  // --- margin halaman ----------------------------------------------------------------
  const firstTops = bodyRows.map((rows) => rows[0]).filter(Boolean) as Row[];
  const topMargin = Math.max(18, Math.min(...firstTops.map((r) => r.baseline - pitchOf(r.size) * 0.8)));
  const bottomMargin = Math.max(18, pageH - bottomLimit - 6);
  const leftMargin = Math.max(18, L);
  const rightMargin = Math.max(18, pageW - R);

  // Font & ukuran dominan -> gaya default dokumen (run cukup menulis bedanya).
  const weight = new Map<string, number>();
  allBody.forEach((r) => r.items.forEach((i) => {
    const k = `${i.family}|${Math.round(i.fontSize * 2) / 2}`;
    weight.set(k, (weight.get(k) || 0) + i.text.length);
  }));
  const [defFamily, defSizeStr] = ([...weight].sort((a, b) => b[1] - a[1])[0]?.[0] || "sans|11").split("|");
  const def = { family: defFamily as PdfTextLine["family"], size: Number(defSizeStr) };

  // --- XML ----------------------------------------------------------------------------
  const media: { name: string; data: Buffer; rid: string }[] = [];
  const rels: string[] = [
    `<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
    `<Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>`,
  ];

  const rPr = (run: Run) => {
    const parts: string[] = [];
    if (run.family !== def.family) { const f = esc(FONT_NAME[run.family]); parts.push(`<w:rFonts w:ascii="${f}" w:hAnsi="${f}" w:cs="${f}"/>`); }
    if (run.bold) parts.push("<w:b/><w:bCs/>");
    if (run.italic) parts.push("<w:i/><w:iCs/>");
    if (run.color && run.color.toLowerCase() !== "#000000") parts.push(`<w:color w:val="${run.color.slice(1).toUpperCase()}"/>`);
    const hp = Math.round(run.size * 2);
    if (hp !== Math.round(def.size * 2)) parts.push(`<w:sz w:val="${hp}"/><w:szCs w:val="${hp}"/>`);
    return parts.length ? `<w:rPr>${parts.join("")}</w:rPr>` : "";
  };
  const runXml = (run: Run) => {
    if (run.tab) return `<w:r>${rPr(run)}<w:tab/></w:r>`;
    if (run.br) return `<w:r>${rPr(run)}<w:br/></w:r>`;
    if (run.field) {
      return `<w:r>${rPr(run)}<w:fldChar w:fldCharType="begin"/></w:r><w:r>${rPr(run)}<w:instrText xml:space="preserve"> ${run.field} </w:instrText></w:r>`
        + `<w:r>${rPr(run)}<w:fldChar w:fldCharType="separate"/></w:r><w:r>${rPr(run)}<w:t>${esc(run.text)}</w:t></w:r><w:r>${rPr(run)}<w:fldChar w:fldCharType="end"/></w:r>`;
    }
    return `<w:r>${rPr(run)}<w:t xml:space="preserve">${esc(run.text)}</w:t></w:r>`;
  };

  const paraRuns = (p: Para): Run[] => {
    const runs: Run[] = [];
    p.rows.forEach((r, ri) => {
      if (ri > 0) {
        const prevText = runs.length ? runs[runs.length - 1].text : "";
        // Sambung baris: pakai spasi, kecuali baris sebelumnya diakhiri "-"
        // (mis. "Masing-" + "masing") atau sudah berakhir spasi.
        if (!/[\s-]$/.test(prevText)) {
          const last = runs[runs.length - 1];
          if (last && !last.tab && !last.field) last.text += " ";
        }
      }
      r.items.forEach((it, k) => {
        if (k > 0) runs.push({ text: "", tab: true, bold: false, italic: false, size: it.fontSize, family: it.family, color: it.color });
        for (const run of runsOfLine(it)) {
          const last = runs[runs.length - 1];
          if (last && !last.tab && !last.field && last.bold === run.bold && last.italic === run.italic && last.size === run.size && last.family === run.family && last.color === run.color) last.text += run.text;
          else runs.push({ ...run });
        }
      });
    });
    // Spasi ganda (PDF sering menaruh spasi di akhir objek teks SEKALIGUS di
    // awal objek berikutnya) -> satu spasi, termasuk yang melintasi batas run.
    let prevEndsSpace = false;
    for (const run of runs) {
      if (run.tab || run.field) { prevEndsSpace = false; continue; }
      run.text = run.text.replace(/ {2,}/g, " ");
      if (prevEndsSpace) run.text = run.text.replace(/^ +/, "");
      if (run.text) prevEndsSpace = run.text.endsWith(" ");
    }
    return runs.filter((r) => r.tab || r.field || r.text);
  };

  const pPr = (p: Para, extra = "") => {
    const parts: string[] = [];
    if (p.pageBreakBefore) parts.push("<w:pageBreakBefore/>");
    const borders: string[] = [];
    if (p.box && p.box.stroke && !isWhiteish(p.box.stroke)) {
      const c = p.box.stroke.slice(1).toUpperCase();
      const sz = Math.min(24, Math.max(4, Math.round((p.box.strokeWidth || 0.75) * 8)));
      borders.push(...["top", "left", "bottom", "right"].map((s) => `<w:${s} w:val="single" w:sz="${sz}" w:space="4" w:color="${c}"/>`));
    } else if (p.bottomRule) {
      const sz = Math.min(24, Math.max(2, Math.round(p.bottomRule.width * 8)));
      borders.push(`<w:bottom w:val="single" w:sz="${sz}" w:space="${Math.round(p.bottomRule.space)}" w:color="${p.bottomRule.color.slice(1).toUpperCase()}"/>`);
    }
    if (borders.length) parts.push(`<w:pBdr>${borders.join("")}</w:pBdr>`);
    if (p.box && p.box.fill && !isWhiteish(p.box.fill)) parts.push(`<w:shd w:val="clear" w:color="auto" w:fill="${p.box.fill.slice(1).toUpperCase()}"/>`);
    if (p.tabs.length) parts.push(`<w:tabs>${p.tabs.map((t) => `<w:tab w:val="left" w:pos="${tw(t)}"/>`).join("")}</w:tabs>`);
    // Jarak baris "exact" = jarak baseline aslinya. Bukan "atLeast": docx-preview
    // (penampil di workspace) membacanya sbg "100% + nilai" -> jarak jadi 2x,
    // sedangkan "exact" dibaca sama oleh Word, LibreOffice & docx-preview.
    const line = p.kind === "text" ? `w:line="${tw(p.lineExact)}" w:lineRule="exact"` : `w:line="240" w:lineRule="auto"`;
    parts.push(`<w:spacing w:before="${tw(p.before)}" w:after="0" ${line}/>`);
    const ind: string[] = [];
    if (p.indLeft > 0.5) ind.push(`w:left="${tw(p.indLeft)}"`);
    if (p.indRight > 0.5) ind.push(`w:right="${tw(p.indRight)}"`);
    if (p.firstLine > 0.5) ind.push(`w:firstLine="${tw(p.firstLine)}"`);
    if (p.firstLine < -0.5) ind.push(`w:hanging="${tw(-p.firstLine)}"`);
    if (ind.length && p.align !== "center") parts.push(`<w:ind ${ind.join(" ")}/>`);
    else if (p.box && p.align === "center") parts.push(`<w:ind w:left="${tw(p.indLeft)}" w:right="${tw(p.indRight)}"/>`);
    parts.push(`<w:jc w:val="${p.align}"/>`);
    return `<w:pPr>${parts.join("")}${extra}</w:pPr>`;
  };

  let imgCount = 0;
  const imageXml = (p: Para) => {
    const im = p.image!;
    imgCount++;
    const rid = `rIdImg${imgCount}`;
    const name = `image${imgCount}.png`;
    media.push({ name, data: encodePng(im.width, im.height, im.rgba!), rid });
    rels.push(`<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${name}"/>`);
    const cx = Math.round(im.w * 12700), cy = Math.round(im.h * 12700);
    return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${imgCount}" name="Gambar ${imgCount}"/>`
      + `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">`
      + `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${imgCount}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr>`
      + `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
      + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>`
      + `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  };

  // Tabel -> <w:tbl> dengan garis & lebar kolom sesuai aslinya.
  const tableXml = (t: Table) => {
    const widths = t.colXs.slice(1).map((x, i) => x - t.colXs[i]);
    const c = t.color.slice(1).toUpperCase();
    const sz = Math.min(24, Math.max(2, Math.round(t.width * 8)));
    const b = (side: string) => `<w:${side} w:val="single" w:sz="${sz}" w:space="0" w:color="${c}"/>`;
    // Jarak teks ke garis kiri sel (median dari sel yang berisi).
    const insets: number[] = [];
    t.cells.forEach((row) => row.forEach((cell, ci) => { if (cell.length) insets.push(Math.min(...cell.map((l) => l.x)) - t.colXs[ci]); }));
    const inset = Math.min(15, Math.max(1, insets.length ? median(insets) : 5.4));
    const cellParas = (cell: PdfTextLine[], ci: number) => {
      if (!cell.length) return `<w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr></w:p>`;
      const cx0 = t.colXs[ci] + inset, cx1 = t.colXs[ci + 1] - inset;
      // Baris sel: gabung yang sebaris, lalu sambung baris yang penuh (teks terbungkus).
      const lines = [...cell].sort((a, b) => a.baseline - b.baseline || a.x - b.x);
      const groups: PdfTextLine[][] = [];
      for (const l of lines) {
        const g = groups[groups.length - 1];
        if (g && Math.abs(g[0].baseline - l.baseline) <= 0.35 * l.fontSize) g.push(l); else groups.push([l]);
      }
      const paragraphs: PdfTextLine[][][] = [];
      groups.forEach((g, gi) => {
        const prev = groups[gi - 1];
        const prevRight = prev ? Math.max(...prev.map((l) => l.x + l.w)) : 0;
        const cont = prev && prevRight >= cx1 - Math.max(2.5 * g[0].fontSize, (cx1 - cx0) * 0.12) && g[0].baseline - prev[0].baseline <= g[0].fontSize * 1.6;
        if (cont) paragraphs[paragraphs.length - 1].push(g); else paragraphs.push([g]);
      });
      return paragraphs.map((pg) => {
        const firstG = pg[0];
        const gl = Math.min(...firstG.map((l) => l.x)) - cx0, gr = cx1 - Math.max(...firstG.map((l) => l.x + l.w));
        const align = pg.length === 1 && gl > 3 && gr > 3 && Math.abs(gl - gr) <= Math.max(4, (cx1 - cx0) * 0.08) ? "center"
          : pg.length === 1 && gr <= 3 && gl > 8 ? "right" : "left";
        const runs: Run[] = [];
        pg.forEach((g, gi) => {
          if (gi > 0 && runs.length && !/[\s-]$/.test(runs[runs.length - 1].text)) runs[runs.length - 1].text += " ";
          g.forEach((l, li) => {
            if (li > 0 && runs.length && !/\s$/.test(runs[runs.length - 1].text)) runs[runs.length - 1].text += " ";
            runs.push(...runsOfLine(l));
          });
        });
        runs.forEach((r) => { r.text = r.text.replace(/ {2,}/g, " "); });
        if (runs.length) runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/\s+$/, "");
        const size = firstG[0].fontSize;
        return `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="${tw(pitchOf(size))}" w:lineRule="exact"/><w:jc w:val="${align}"/></w:pPr>${runs.filter((r) => r.text).map(runXml).join("")}</w:p>`;
      }).join("");
    };
    const rowsXml = t.cells.map((row, ri) => {
      const hgt = t.rowYs[ri + 1] - t.rowYs[ri];
      return `<w:tr><w:trPr><w:trHeight w:val="${tw(hgt)}" w:hRule="atLeast"/></w:trPr>${row.map((cell, ci) =>
        `<w:tc><w:tcPr><w:tcW w:w="${tw(widths[ci])}" w:type="dxa"/><w:vAlign w:val="center"/></w:tcPr>${cellParas(cell, ci)}</w:tc>`).join("")}</w:tr>`;
    }).join("");
    return `<w:tbl><w:tblPr><w:tblW w:w="${tw(t.colXs[t.colXs.length - 1] - t.colXs[0])}" w:type="dxa"/><w:tblInd w:w="${Math.round((t.x - L) * 20)}" w:type="dxa"/>`
      + `<w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map(b).join("")}</w:tblBorders><w:tblLayout w:type="fixed"/>`
      + `<w:tblCellMar><w:left w:w="${tw(inset)}" w:type="dxa"/><w:right w:w="${tw(inset)}" w:type="dxa"/></w:tblCellMar></w:tblPr>`
      + `<w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${tw(w)}"/>`).join("")}</w:tblGrid>${rowsXml}</w:tbl>`;
  };

  const body = paras.map((p, i) => {
    if (p.kind === "table") {
      // Jarak sebelum tabel diwakili paragraf kosong kecil; setelah tabel Word
      // wajib ada paragraf (kalau tabel elemen terakhir) — ditangani di bawah.
      const spacer = p.before > 1 || p.pageBreakBefore
        ? `<w:p><w:pPr>${p.pageBreakBefore ? "<w:pageBreakBefore/>" : ""}<w:spacing w:before="0" w:after="0" w:line="${tw(Math.max(1, p.before))}" w:lineRule="exact"/></w:pPr></w:p>` : "";
      const tail = i === paras.length - 1 ? `<w:p/>` : "";
      return spacer + tableXml(p.table!) + tail;
    }
    if (p.kind === "image") return `<w:p>${pPr(p)}${imageXml(p)}</w:p>`;
    return `<w:p>${pPr(p)}${paraRuns(p).map(runXml).join("")}</w:p>`;
  }).join("");

  // Header/footer (teks berulang tiap halaman).
  const hfParas = (rows: Row[]) => rows.map((r) => {
    const align = centered(r) ? "center" : Math.abs(r.right - R) <= 4 && r.x > C ? "right" : "left";
    const tabs = r.items.length > 1 ? `<w:tabs>${r.items.slice(1).map((i) => `<w:tab w:val="left" w:pos="${tw(Math.max(0, i.x - L))}"/>`).join("")}</w:tabs>` : "";
    const ind = align === "left" && r.x - L > 0.5 ? `<w:ind w:left="${tw(r.x - L)}"/>` : "";
    return `<w:p><w:pPr>${tabs}<w:spacing w:before="0" w:after="0"/>${ind}<w:jc w:val="${align}"/></w:pPr>${runsWithPageFields(r, r.page + 1, total).map(runXml).join("")}</w:p>`;
  }).join("");
  const NS = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"`;
  const hfRefs: string[] = [];
  const extraParts: { path: string; xml: string; ctype: string }[] = [];
  if (headerRows.length) {
    rels.push(`<Relationship Id="rIdHeader1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>`);
    hfRefs.push(`<w:headerReference w:type="default" r:id="rIdHeader1"/>`);
    extraParts.push({ path: "word/header1.xml", xml: `<w:hdr ${NS}>${hfParas(headerRows)}</w:hdr>`, ctype: "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml" });
  }
  if (footerRows.length) {
    rels.push(`<Relationship Id="rIdFooter1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>`);
    hfRefs.push(`<w:footerReference w:type="default" r:id="rIdFooter1"/>`);
    extraParts.push({ path: "word/footer1.xml", xml: `<w:ftr ${NS}>${hfParas(footerRows)}</w:ftr>`, ctype: "application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml" });
  }
  const headerDist = headerRows.length ? Math.max(12, Math.min(...headerRows.map((r) => r.top)) - 2) : 36;
  const footerDist = footerRows.length ? Math.max(12, pageH - Math.max(...footerRows.map((r) => r.bottom)) - 2) : 36;

  const sectPr = `<w:sectPr>${hfRefs.join("")}<w:pgSz w:w="${tw(pageW)}" w:h="${tw(pageH)}"${pageW > pageH ? ' w:orient="landscape"' : ""}/>`
    + `<w:pgMar w:top="${tw(topMargin)}" w:right="${tw(rightMargin)}" w:bottom="${tw(bottomMargin)}" w:left="${tw(leftMargin)}" w:header="${tw(headerDist)}" w:footer="${tw(footerDist)}" w:gutter="0"/></w:sectPr>`;

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${body}${sectPr}</w:body></w:document>`;
  const defFont = esc(FONT_NAME[def.family]);
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`
    + `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${defFont}" w:hAnsi="${defFont}" w:eastAsia="${defFont}" w:cs="${defFont}"/><w:sz w:val="${Math.round(def.size * 2)}"/><w:szCs w:val="${Math.round(def.size * 2)}"/><w:lang w:val="id-ID"/></w:rPr></w:rPrDefault>`
    + `<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>`
    + `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style></w:styles>`;
  const settingsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:defaultTabStop w:val="720"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>`
    + `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>`
    + `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>`
    + `<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>`
    + extraParts.map((x) => `<Override PartName="/${x.path}" ContentType="${x.ctype}"/>`).join("")
    + `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>`
    + `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const coreXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`
    + `<dc:title>Hasil konversi PDF</dc:title><dc:creator>Smart CLM</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;

  const zip = new JSZip();
  zip.file("[Content_Types].xml", contentTypes);
  zip.file("_rels/.rels", rootRels);
  zip.file("docProps/core.xml", coreXml);
  zip.file("word/document.xml", documentXml);
  zip.file("word/styles.xml", stylesXml);
  zip.file("word/settings.xml", settingsXml);
  zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`);
  for (const x of extraParts) zip.file(x.path, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${x.xml}`);
  for (const m of media) zip.file(`word/media/${m.name}`, m.data);
  const docx = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

  return {
    docx,
    stats: {
      pages: total,
      paragraphs: paras.filter((p) => p.kind === "text").length,
      tables: paras.filter((p) => p.kind === "table").length,
      images: imgCount,
      boxes: new Set(paras.filter((p) => p.box).map((p) => p.box)).size,
      rules: ruleCount,
      headerFooter: !!(headerRows.length || footerRows.length),
    },
  };
}

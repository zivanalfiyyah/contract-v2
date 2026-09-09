import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb, type RGB } from "pdf-lib";

// Generates a clean, structured master PDF for SOP/IK/Kebijakan/Memo composed
// directly in the app (as opposed to a user-uploaded finished PDF). The
// output feeds the SAME downstream pipeline as an upload (hash, store,
// approve, watermark) — composing is just an alternate way to produce the
// clean master, not a separate document type.
//
// Deliberately DB-independent (no import from dcs/repo.ts) so this module
// stays pure PDF generation, runnable standalone (see scripts/dcs-compose-*
// -test.ts) without touching Postgres — matching the file's original design.
export interface ComposeSection {
  heading: string;
  content: string;
  // Tabel data opsional di dalam section (mis. "Gol. Jabatan | Nominal" pada
  // Internal Memo) — dirender lewat drawTable, TERPISAH dari `content` (bisa
  // ada keduanya: paragraf lalu tabel di bawahnya).
  table?: { columns: string[]; rows: string[][] };
}
// Dua model koeksis (lihat FlowStep di src/types.ts untuk penjelasan lengkap):
// model GRAF baru (id + nextId/yesId/noId, posisi dihitung via layoutFlowGraph)
// dan model LEGACY lama (order + noTargetOrder, posisi linier). Dispatcher
// drawFlowDiagram memilih jalur berdasarkan ada/tidaknya edge graf terisi.
export interface ComposeFlowStep {
  id?: string;
  order: number;
  type: "start" | "process" | "decision" | "end";
  text: string;
  actor?: string;
  color?: string;
  textColor?: string;
  nextId?: string;
  yesId?: string;
  noId?: string;
  noTargetOrder?: number;
  // Geser manual (drag) — cermin FlowStep.manualOffset di src/types.ts, lihat
  // komentar di sana untuk kenapa ini fraksi relatif, bukan piksel absolut.
  manualOffset?: { dxLane: number; dyRow: number };
  // Penanggung jawab (Person In Charge) — dipetakan ke kolom "PIC" pada gaya
  // diagram tabel (lihat drawFlowDiagramTable); tidak dipakai gaya grafis.
  pic?: string;
}
export interface SignatureColumn {
  label: string;
  role: string;
  // Nama jabatan spesifik (mis. "HED Manager"), TERPISAH dari `label` (kata
  // kerja aksi, "Dibuat oleh") dan `role` (gerbang izin platform kasar,
  // "manager") — dicetak sbg baris placeholder kedua di bawah label sebelum
  // TTD, dan menggantikan `role` platform yang kasar pada baris "Jabatan"
  // setelah TTD. Opsional & mundur-kompatibel: kosong = perilaku lama persis.
  roleName?: string;
  // Penandatangan spesifik yang ditunjuk per-dokumen (lihat SignatureColumn di
  // repo.ts). Tidak dipakai saat merender PDF — cuma metadata — tapi disimpan
  // di struktur yang sama supaya kedua deklarasi tetap sinkron.
  assignedUserId?: string;
}
// A signature "band" on the Lembar Pengesahan — an optional heading (e.g.
// "Penyusun:", "Mengetahui:") over a row of columns. Multiple groups print
// grouped signers (Internal Memo: 2 groups x 2 columns = 4 signers) instead
// of a single flat row.
export interface SignatureGroup { heading?: string; columns: SignatureColumn[] }

// Margin halaman dalam POINTS (bukan mm) — pemanggil (dcs/routes.ts) yang
// mengonversi dari settings mm. Semua opsional; default 56pt = perilaku lama.
export interface PageMargins { top?: number; right?: number; bottom?: number; left?: number }

// Geometri layout tanda tangan yang DIPERSIST ke compose metadata, supaya
// pengisian kolom TTD saat sign-approve (fillSignatureColumn) memakai koordinat
// yang PERSIS sama dengan saat kotak digambar (drawSignatureGroups) — walau
// margin/header berubah. Dokumen lama tanpa ini jatuh ke konstanta default.
export interface SigLayout { marginX: number; colTopY: number; contentW: number }

export interface ComposeInput {
  documentNumber: string;
  title: string;
  docTypeCode: string;
  department: string;
  major: number;
  minor: number;
  purpose?: string;
  scope?: string;
  sections: ComposeSection[];
  flow?:
    | { mode: "builder"; steps: ComposeFlowStep[]; lanes?: string[]; displayStyle?: "diagram" | "table" }
    | { mode: "image"; image: Buffer; mimeType: string }
    | { mode: "none" };
  // Curated letterhead preset: company name/address + optional logo, printed
  // on page 1. Omit entirely to keep the plain title block (no visual change
  // for doc types that don't opt into a letterhead style).
  letterhead?: { companyName: string; companyAddress: string; logo?: { bytes: Buffer; mimeType: string } };
  // Printed as a blank "Lembar Pengesahan" (approval sheet) — the standard
  // Indonesian company document sign-off row (e.g. Dibuat/Diperiksa/Disetujui).
  // Each column is a blank slot until a matching approver signs (see
  // fillSignatureColumn below). `signatureGroups` is preferred when present;
  // flat `signatureColumns` is kept as a legacy fallback, wrapped into one
  // implicit group — omit both to skip the sheet entirely.
  signatureGroups?: SignatureGroup[];
  signatureColumns?: SignatureColumn[];
  // Auto-populated from real version history — no new user input needed.
  revisionHistory?: Array<{ major: number; minor: number; changeSummary: string | null; effectiveAt: string | null; createdAt: string }>;
  // Plain label+URL list (not clickable, no embedded previews — curated scope).
  appendix?: Array<{ label: string; url: string }>;
  // Margin halaman (points). Default 56pt semua sisi = perilaku lama.
  margins?: PageMargins;
  // "iso" = header kotak metadata formal ISO (berulang tiap halaman + Page X
  // Of Y), meniru SOP standar Indonesia. "simple" = header minimalis lama.
  headerStyle?: "iso" | "simple";
  // Metadata untuk header ISO (diabaikan saat headerStyle "simple").
  documentLevel?: string;   // "Tingkat Dokumen" mis. "Internal"
  processOwner?: string;    // "Pemilik Proses" mis. "HED Departement"
  language?: string;        // "Bahasa" mis. "Indonesia"
  issuedDate?: string;      // "Tanggal Diterbitkan"
  statusLabel?: string;     // "Status Dokumen" mis. "Draft"/"Berlaku"
  docTypeName?: string;     // nama lengkap jenis dok, mis. "Standard Operating Procedure"
  // Paragraf kerahasiaan/hak cipta dokumen, dicetak italic dekat akhir
  // dokumen kalau terisi (kosong/tidak ada = tidak dicetak sama sekali).
  // Sumbernya CompanyBranding.confidentialityNotice (dcs/repo.ts), diedit di
  // panel pengaturan tenant — kata-kata legalnya beda-beda per perusahaan
  // jadi TIDAK di-hardcode.
  confidentialityNotice?: string;
}

// Koordinat sel kop ISO yang nilainya BERUBAH setelah compose (Status Dokumen
// & Tanggal Diterbitkan) — sengaja dibiarkan KOSONG saat compose lalu diisi
// reaktif dari status versi yang sebenarnya saat dilihat/diunduh (lihat
// pdf-watermark.ts). Sama untuk semua halaman (kop identik per halaman), jadi
// satu pasang koordinat cukup. null untuk dokumen non-ISO (memo/simple).
export interface HeaderReactiveLayout {
  status: { x: number; y: number; size: number };
  issued: { x: number; y: number; size: number };
}

export interface ComposeResult {
  bytes: Uint8Array;
  // Which page (0-based) the signature sheet landed on — needed because
  // revisionHistory/appendix now print AFTER it, so it's no longer safe to
  // assume "signature sheet = last page" the way the original design did.
  // null when no signature groups were requested.
  signatureSheetPageIndex: number | null;
  // Geometri sig sheet yang dipakai — dipersist agar fillSignatureColumn cocok.
  sigLayout: SigLayout | null;
  // Koordinat sel kop reaktif (Status/Tanggal Terbit) — dipersist agar lapisan
  // reaktif tahu di mana mengisinya. null untuk header non-ISO.
  headerLayout: HeaderReactiveLayout | null;
}

const PAGE_W = 595.28; // A4
const PAGE_H = 841.89;
const DEFAULT_MARGIN = 56;
// Tinggi pita header ISO yang di-reserve di atas tiap halaman (points).
const HEADER_BOX_H = 96;
// Jarak bersih antara bawah kotak header ISO dan awal konten, supaya baseline
// judul halaman (Diagram Alir/Lembar Pengesahan/dll) tidak naik ke pita header.
const HEADER_GAP = 18;

// Konteks layout yang diturunkan sekali di composeDocumentPdf lalu diteruskan
// ke helper. Menggantikan konstanta MARGIN/CONTENT_W lama supaya margin bisa
// dikonfigurasi per perusahaan. `contentTopY` = y awal konten pada halaman
// baru (sudah memperhitungkan pita header ISO bila ada).
interface Layout {
  mLeft: number; mRight: number; mTop: number; mBottom: number;
  contentW: number; contentTopY: number; iso: boolean;
}

function buildLayout(margins: PageMargins | undefined, iso: boolean): Layout {
  const mLeft = margins?.left ?? DEFAULT_MARGIN;
  const mRight = margins?.right ?? DEFAULT_MARGIN;
  const mTop = margins?.top ?? DEFAULT_MARGIN;
  const mBottom = margins?.bottom ?? DEFAULT_MARGIN;
  return {
    mLeft, mRight, mTop, mBottom,
    contentW: PAGE_W - mLeft - mRight,
    contentTopY: PAGE_H - mTop - (iso ? HEADER_BOX_H + HEADER_GAP : 0),
    iso,
  };
}

interface Cursor { page: PDFPage; y: number; }

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\n/)) {
    if (!paragraph.trim()) { lines.push(""); continue; }
    const words = paragraph.split(/\s+/);
    let line = "";
    for (const word of words) {
      const trial = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(trial, size) > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = trial;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

function ensureSpace(doc: PDFDocument, cur: Cursor, needed: number, L: Layout): Cursor {
  if (cur.y - needed < L.mBottom) {
    const page = doc.addPage([PAGE_W, PAGE_H]);
    return { page, y: L.contentTopY };
  }
  return cur;
}

// Deteksi marker list di awal baris → tingkat indentasi tetap: bernomor
// ("1. ") = level 0, berhuruf ("a. ") = level 1, dash/bullet ("- "/"• ") =
// level 2. Whitespace awal yang SUDAH ADA di teks sumber (kalau user memang
// mengetik indentasi sendiri) ditambahkan DI ATAS level yang terdeteksi,
// jadi baik yang cuma mengetik marker polos maupun yang sudah terbiasa
// indentasi manual sama-sama menghasilkan tampilan yang masuk akal — bukan
// mesin markdown penuh, cuma pengenalan pola yang sudah natural diketik
// pengguna (persis pola SOP/IM: bernomor → sub huruf → sub-sub dash).
function detectListIndent(rawLine: string): number {
  const stripped = rawLine.replace(/^[ \t]+/, "");
  const leadingWs = (rawLine.length - stripped.length) * 3;
  if (/^\d+\.\s/.test(stripped)) return leadingWs;
  if (/^[a-zA-Z]\.\s/.test(stripped)) return leadingWs + 14;
  if (/^[-•]\s/.test(stripped)) return leadingWs + 28;
  return leadingWs;
}

interface TextRun { text: string; bold: boolean }

// Parser **bold** satu-lapis (tidak menangani nested) — cukup utk pola
// "**Istilah**: definisi" yang dipakai section DEFINISI/KETENTUAN.
function parseBoldRuns(text: string): TextRun[] {
  const runs: TextRun[] = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) runs.push({ text: text.slice(last, m.index), bold: false });
    runs.push({ text: m[1], bold: true });
    last = re.lastIndex;
  }
  if (last < text.length) runs.push({ text: text.slice(last), bold: false });
  return runs.length > 0 ? runs : [{ text, bold: false }];
}

// Paragraf dgn dukungan minimal: **bold** inline + indentasi otomatis 3
// tingkat berbasis marker list (lihat detectListIndent/parseBoldRuns) — BUKAN
// markdown/rich-text penuh, cuma 2 konvensi yang sudah natural diketik user
// utk mencocokkan struktur dokumen referensi (istilah tebal + list bertingkat).
function drawParagraph(doc: PDFDocument, cur: Cursor, text: string, regularFont: PDFFont, boldFont: PDFFont, size: number, L: Layout, color = rgb(0.2, 0.22, 0.27)): Cursor {
  const lineHeight = size * 1.45;
  for (const rawLine of text.split(/\n/)) {
    if (!rawLine.trim()) {
      cur = ensureSpace(doc, cur, lineHeight, L);
      cur = { page: cur.page, y: cur.y - lineHeight };
      continue;
    }
    const indent = detectListIndent(rawLine);
    const stripped = rawLine.replace(/^[ \t]+/, "");
    const runs = parseBoldRuns(stripped);
    const tokens: { word: string; bold: boolean }[] = [];
    for (const run of runs) {
      for (const w of run.text.split(/\s+/).filter(Boolean)) tokens.push({ word: w, bold: run.bold });
    }
    const maxWidth = Math.max(L.contentW - indent, 40);
    let lineTokens: typeof tokens = [];
    let lineWidth = 0;
    const flushLine = () => {
      if (lineTokens.length === 0) return;
      cur = ensureSpace(doc, cur, lineHeight, L);
      let x = L.mLeft + indent;
      for (const t of lineTokens) {
        const f = t.bold ? boldFont : regularFont;
        cur.page.drawText(t.word, { x, y: cur.y - lineHeight, size, font: f, color });
        x += f.widthOfTextAtSize(t.word + " ", size);
      }
      cur = { page: cur.page, y: cur.y - lineHeight };
      lineTokens = [];
      lineWidth = 0;
    };
    for (const t of tokens) {
      const f = t.bold ? boldFont : regularFont;
      const w = f.widthOfTextAtSize(t.word + " ", size);
      if (lineWidth + w > maxWidth && lineTokens.length > 0) flushLine();
      lineTokens.push(t);
      lineWidth += w;
    }
    flushLine();
  }
  return cur;
}

function drawHeading(doc: PDFDocument, cur: Cursor, text: string, font: PDFFont, L: Layout, size = 12): Cursor {
  cur = ensureSpace(doc, cur, size * 2.2, L);
  cur = { page: cur.page, y: cur.y - size * 0.6 };
  cur.page.drawText(text, { x: L.mLeft, y: cur.y - size, size, font, color: rgb(0.16, 0.32, 0.75) });
  cur.page.drawLine({ start: { x: L.mLeft, y: cur.y - size - 4 }, end: { x: PAGE_W - L.mRight, y: cur.y - size - 4 }, thickness: 0.75, color: rgb(0.7, 0.72, 0.78) });
  return { page: cur.page, y: cur.y - size - 12 };
}

// ---------------------------------------------------------------------------
// Header "memo" (headerStyle "simple", dipakai layoutStyle "memo"/Internal
// Memo): KOTAK berbingkai — beda dari header ISO (drawIsoHeaderBox, grid 8-sel
// tetap) DAN beda dari letterhead lama (teks polos tanpa bingkai). Blok kiri:
// cabang perusahaan (logo+nama+alamat). Blok kanan: info kompak (Nomor
// Dokumen/Revisi ke/Terbitan ke/Tanggal Efektif) — field-set SENGAJA beda
// dari ISO (tanpa Bahasa/Pemilik Proses/Tingkat/Status/Halaman) sesuai kop
// Internal Memo yang lebih ringkas. Logo di-embed oleh pemanggil (sama
// seperti embedLogo yang dipakai jalur ISO) supaya konsisten satu jalur.
// ---------------------------------------------------------------------------
function drawMemoHeaderBox(
  page: PDFPage, bold: PDFFont, regular: PDFFont,
  letterhead: ComposeInput["letterhead"],
  meta: { documentNumber: string; minor: number; major: number; issuedDate: string },
  L: Layout, logo: Awaited<ReturnType<typeof embedLogo>>,
): number {
  const boxTop = PAGE_H - L.mTop;
  const boxH = 92;
  const boxLeft = L.mLeft, boxRight = PAGE_W - L.mRight, boxW = boxRight - boxLeft;
  const border = rgb(0.25, 0.27, 0.32);
  page.drawRectangle({ x: boxLeft, y: boxTop - boxH, width: boxW, height: boxH, borderColor: border, borderWidth: 1 });

  const infoColW = 180;
  page.drawLine({ start: { x: boxRight - infoColW, y: boxTop }, end: { x: boxRight - infoColW, y: boxTop - boxH }, thickness: 0.75, color: border });

  // Blok cabang: logo + nama + alamat (maks 3 baris, area terbatas tinggi
  // kotak jadi tidak pernah memicu page-break).
  const brandX = boxLeft + 10;
  const brandColW = boxW - infoColW - 20;
  let logoW = 0;
  if (logo) {
    const scale = Math.min(50 / logo.width, 50 / logo.height, 1);
    const w = logo.width * scale, h = logo.height * scale;
    page.drawImage(logo, { x: brandX, y: boxTop - boxH / 2 - h / 2, width: w, height: h });
    logoW = w + 10;
  }
  const textX = brandX + logoW;
  if (letterhead?.companyName) {
    page.drawText(letterhead.companyName, { x: textX, y: boxTop - 26, size: 11, font: bold, color: rgb(0.09, 0.1, 0.14) });
  }
  if (letterhead?.companyAddress) {
    const lines = wrapText(letterhead.companyAddress, regular, 7.5, Math.max(brandColW - logoW, 60)).slice(0, 3);
    let ly = boxTop - 40;
    for (const line of lines) {
      page.drawText(line, { x: textX, y: ly, size: 7.5, font: regular, color: rgb(0.4, 0.42, 0.48) });
      ly -= 10;
    }
  }

  // Blok info kanan
  const infoX = boxRight - infoColW + 8;
  const rows: [string, string][] = [
    ["Nomor Dokumen", meta.documentNumber],
    ["Revisi ke", String(meta.minor)],
    ["Terbitan ke", String(meta.major)],
    ["Tanggal Efektif", meta.issuedDate],
  ];
  let ry = boxTop - 16;
  for (const [label, value] of rows) {
    page.drawText(`${label}:`, { x: infoX, y: ry, size: 7.5, font: bold, color: rgb(0.3, 0.32, 0.38) });
    const vw = infoColW - 16;
    const clippedValue = value.length > 28 ? value.slice(0, 27) + "…" : value;
    page.drawText(clippedValue, { x: infoX + Math.min(bold.widthOfTextAtSize(`${label}: `, 7.5), vw - 20), y: ry, size: 7.5, font: regular, color: rgb(0.16, 0.16, 0.2) });
    ry -= 15;
  }
  return boxTop - boxH - 20;
}

// Parse a "#rrggbb"/"#rgb" hex string into a pdf-lib RGB color (0-1 floats).
// Returns `fallback` for anything missing/malformed — callers never need to
// pre-validate user-entered color picker values.
function hexToRgbColor(hex: string | undefined, fallback: RGB): RGB {
  if (!hex) return fallback;
  const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return fallback;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  return rgb(r, g, b);
}

// Mixes `base` toward white by `amount` (0-1) — used for a light tinted box
// fill so a custom textColor (e.g. white text meant to sit on a solid
// colored box, as in most flowchart tools) stays legible instead of landing
// on a plain white fill and disappearing.
function tintTowardWhite(base: RGB, amount: number): RGB {
  return rgb(
    base.red + (1 - base.red) * amount,
    base.green + (1 - base.green) * amount,
    base.blue + (1 - base.blue) * amount,
  );
}

/** Flowchart rendered with plain pdf-lib primitives (no SVG dependency): oval-ish
 * rounded rects for start/end, plain rects for process, diamonds for decisions.
 * Mirrors the same notation used by the in-browser SVG preview so what the
 * user designs is what gets printed. Box/text color default to a per-type
 * palette, overridable per-step via step.color/step.textColor — fill only
 * tints away from the default plain white when a custom color IS set, so
 * untouched steps render byte-identical to before this was added. */
// Cuma gambar bentuknya (oval/kotak/wajik) tanpa teks — dipakai ulang oleh
// drawFlowStep (bentuk penuh + label) DAN drawMiniFlowShape (gaya tabel WI,
// teks instruksi ada di kolom terpisah) supaya matematika bentuknya satu
// sumber kebenaran, tidak diduplikasi.
function drawShapeOutline(page: PDFPage, step: ComposeFlowStep, cx: number, y: number, w: number, h: number, borderWidth = 1.4): { color: RGB; textColor: RGB } {
  const defaultColor = step.type === "start" ? rgb(0.06, 0.72, 0.51) : step.type === "end" ? rgb(0.96, 0.25, 0.37) : step.type === "decision" ? rgb(0.96, 0.62, 0.04) : rgb(0.39, 0.4, 0.95);
  const color = hexToRgbColor(step.color, defaultColor);
  const textColor = hexToRgbColor(step.textColor, rgb(0.15, 0.16, 0.2));
  const fill = step.color ? tintTowardWhite(color, 0.85) : rgb(1, 1, 1);
  if (step.type === "start" || step.type === "end") {
    // pdf-lib's drawRectangle has no rounded-corner option — an ellipse at each
    // end plus a rect in the middle approximates the oval "start/end" shape.
    page.drawEllipse({ x: cx - w / 2, y: y - h / 2, xScale: h / 2, yScale: h / 2, color: fill, borderColor: color, borderWidth });
    page.drawEllipse({ x: cx + w / 2, y: y - h / 2, xScale: h / 2, yScale: h / 2, color: fill, borderColor: color, borderWidth });
    page.drawRectangle({ x: cx - w / 2, y: y - h, width: w, height: h, color: fill, borderColor: color, borderWidth: 0 });
    page.drawLine({ start: { x: cx - w / 2, y }, end: { x: cx + w / 2, y }, thickness: borderWidth, color });
    page.drawLine({ start: { x: cx - w / 2, y: y - h }, end: { x: cx + w / 2, y: y - h }, thickness: borderWidth, color });
  } else if (step.type === "decision") {
    const top = { x: cx, y }; const right = { x: cx + w / 2, y: y - h / 2 };
    const bottom = { x: cx, y: y - h }; const left = { x: cx - w / 2, y: y - h / 2 };
    // drawSvgPath expects SVG-space (Y-down) coordinates and flips them back
    // internally (scale(1,-1)) — negate our PDF-space (Y-up) Y values so the
    // net result lands at the same points as the rest of this function's
    // drawLine/drawRectangle calls. x/y explicit 0 so it doesn't inherit the
    // page's implicit cursor position from an unrelated prior draw call.
    page.drawSvgPath(
      `M ${top.x} ${-top.y} L ${right.x} ${-right.y} L ${bottom.x} ${-bottom.y} L ${left.x} ${-left.y} Z`,
      { x: 0, y: 0, color: fill, borderColor: color, borderWidth },
    );
  } else {
    page.drawRectangle({ x: cx - w / 2, y: y - h, width: w, height: h, borderColor: color, borderWidth, color: fill });
  }
  return { color, textColor };
}

function drawFlowStep(page: PDFPage, font: PDFFont, step: ComposeFlowStep, cx: number, y: number, w: number, h: number) {
  const { textColor } = drawShapeOutline(page, step, cx, y, w, h);
  const label = step.text.length > 40 ? step.text.slice(0, 39) + "…" : step.text;
  const size = 9;
  const tw = font.widthOfTextAtSize(label, size);
  page.drawText(label, { x: cx - tw / 2, y: y - h / 2 - size / 2 + (step.actor ? 5 : 0), size, font, color: textColor });
  if (step.actor) {
    const at = `(${step.actor})`;
    const atw = font.widthOfTextAtSize(at, 7);
    page.drawText(at, { x: cx - atw / 2, y: y - h / 2 - 8, size: 7, font, color: rgb(0.4, 0.42, 0.48) });
  }
}

/** Original single-column chain. Preserves prior spacing; only MARGIN/CONTENT
 * references are now taken from the layout so custom margins apply. */
function drawFlowDiagramSingleColumn(doc: PDFDocument, ordered: ComposeFlowStep[], font: PDFFont, L: Layout) {
  const page = doc.addPage([PAGE_W, PAGE_H]);
  page.drawText("Diagram Alir", { x: L.mLeft, y: L.contentTopY, size: 14, font, color: rgb(0.16, 0.32, 0.75) });
  const nodeW = 280, nodeH = 46, gap = 34;
  let y = L.contentTopY - 40;
  const cx = PAGE_W / 2;
  for (let i = 0; i < ordered.length; i++) {
    const step = ordered[i];
    if (y - nodeH < L.mBottom + 30) break; // stop rather than overflow — flow rarely exceeds one page in practice
    drawFlowStep(page, font, step, cx, y, nodeW, nodeH);
    page.drawText(String(step.order), { x: cx - nodeW / 2 - 16, y: y - nodeH / 2 - 3, size: 9, font, color: rgb(0.5, 0.52, 0.58) });
    const isLast = i === ordered.length - 1;
    if (!isLast) {
      page.drawLine({ start: { x: cx, y: y - nodeH }, end: { x: cx, y: y - nodeH - gap + 6 }, thickness: 1.2, color: rgb(0.4, 0.42, 0.48) });
      if (step.type === "decision") {
        page.drawText("Ya", { x: cx + 6, y: y - nodeH - gap / 2, size: 8, font, color: rgb(0.06, 0.6, 0.4) });
      }
    }
    if (step.type === "decision" && step.noTargetOrder) {
      const t = `Tidak -> Langkah ${step.noTargetOrder}`;
      page.drawText(t, { x: cx + nodeW / 2 + 10, y: y - nodeH / 2, size: 8, font, color: rgb(0.87, 0.2, 0.3) });
    }
    y -= nodeH + gap;
  }
}

/**
 * Swimlane flowchart: steps grouped into vertical lanes by their `actor`
 * (BPMN-style, e.g. KARYAWAN | ATASAN | HED | FAT | DIREKSI). Vertical position
 * stays keyed to chronological `order`; connectors elbow when steps cross lanes.
 */
function drawFlowDiagramSwimlane(doc: PDFDocument, ordered: ComposeFlowStep[], font: PDFFont, lanes: string[], L: Layout) {
  const page = doc.addPage([PAGE_W, PAGE_H]);
  page.drawText("Diagram Alir", { x: L.mLeft, y: L.contentTopY, size: 14, font, color: rgb(0.16, 0.32, 0.75) });

  const laneW = L.contentW / lanes.length;
  const headerTopY = L.contentTopY - 34;
  for (let li = 0; li < lanes.length; li++) {
    const lx = L.mLeft + laneW * li;
    page.drawRectangle({ x: lx, y: headerTopY, width: laneW, height: 22, color: rgb(0.94, 0.95, 0.98), borderColor: rgb(0.7, 0.72, 0.78), borderWidth: 0.75 });
    const label = lanes[li].length > 18 ? lanes[li].slice(0, 17) + "…" : lanes[li];
    const lw = font.widthOfTextAtSize(label, 8.5);
    page.drawText(label, { x: lx + laneW / 2 - lw / 2, y: headerTopY + 7, size: 8.5, font, color: rgb(0.16, 0.16, 0.2) });
  }
  const bodyBottom = L.mBottom + 20;
  for (let li = 1; li < lanes.length; li++) {
    const lx = L.mLeft + laneW * li;
    page.drawLine({ start: { x: lx, y: headerTopY }, end: { x: lx, y: bodyBottom }, thickness: 0.5, color: rgb(0.85, 0.86, 0.9) });
  }

  const nodeW = Math.max(Math.min(laneW - 20, 200), 80);
  const nodeH = 40, gap = 28;
  let y = headerTopY - 30;
  const centers = new Map<number, { x: number; y: number }>(); // step.order -> node center

  for (const step of ordered) {
    if (y - nodeH < bodyBottom) break; // graceful stop, same guard as the single-column path
    const laneIdx = Math.max(0, lanes.indexOf(step.actor || ""));
    const cx = L.mLeft + laneW * laneIdx + laneW / 2;
    drawFlowStep(page, font, step, cx, y, nodeW, nodeH);
    centers.set(step.order, { x: cx, y });
    y -= nodeH + gap;
  }

  for (let i = 0; i < ordered.length - 1; i++) {
    const a = centers.get(ordered[i].order);
    const b = centers.get(ordered[i + 1].order);
    if (!a || !b) continue;
    const aBottom = a.y - nodeH, bTop = b.y;
    if (Math.abs(a.x - b.x) < 1) {
      page.drawLine({ start: { x: a.x, y: aBottom }, end: { x: b.x, y: bTop }, thickness: 1.2, color: rgb(0.4, 0.42, 0.48) });
    } else {
      const midY = (aBottom + bTop) / 2;
      page.drawLine({ start: { x: a.x, y: aBottom }, end: { x: a.x, y: midY }, thickness: 1.2, color: rgb(0.4, 0.42, 0.48) });
      page.drawLine({ start: { x: a.x, y: midY }, end: { x: b.x, y: midY }, thickness: 1.2, color: rgb(0.4, 0.42, 0.48) });
      page.drawLine({ start: { x: b.x, y: midY }, end: { x: b.x, y: bTop }, thickness: 1.2, color: rgb(0.4, 0.42, 0.48) });
    }
    if (ordered[i].type === "decision") {
      page.drawText("Ya", { x: a.x + 5, y: aBottom - 9, size: 7, font, color: rgb(0.06, 0.6, 0.4) });
    }
  }
  for (const step of ordered) {
    if (step.type === "decision" && step.noTargetOrder) {
      const c = centers.get(step.order);
      if (c) {
        const t = `Tidak -> Langkah ${step.noTargetOrder}`;
        const tx = Math.min(c.x + nodeW / 2 + 6, PAGE_W - L.mRight - 90);
        page.drawText(t, { x: tx, y: c.y - nodeH / 2, size: 7, font, color: rgb(0.87, 0.2, 0.3) });
      }
    }
  }
}

interface GraphLayoutResult {
  positions: Map<string, { laneIndex: number; row: number }>;
  forwardEdges: { from: string; to: string; label?: "Ya" | "Tidak" }[];
  backEdges: { from: string; to: string; label?: "Ya" | "Tidak" }[];
}

/**
 * Lays out steps that use explicit graph edges (nextId/yesId/noId) instead of
 * the legacy linear `order` chain. `row` (vertical layer) = BFS distance from
 * the start node following forward edges — this is what lets a decision
 * genuinely branch to two different downstream boxes and still converge
 * cleanly, and it's immune to infinite loops on cycles (a step whose nextId
 * points back to an earlier step) because BFS never revisits a node. Any
 * edge whose target row is <= its source row is classified as a back-edge (a
 * loop) and returned separately so the caller can route it around the side
 * instead of drawing it as a normal top-to-bottom connector. Returns lane
 * INDEX and row INDEX only (not pixel coordinates) — the caller (PDF drawer
 * here, or the SVG preview in App.tsx) applies its own pixel constants so
 * both stay visually consistent without duplicating geometry math.
 */
function layoutFlowGraph(steps: ComposeFlowStep[], lanes: string[]): GraphLayoutResult {
  const byId = new Map(steps.filter((s) => s.id).map((s) => [s.id as string, s]));
  const edges: { from: string; to: string; label?: "Ya" | "Tidak" }[] = [];
  for (const s of steps) {
    if (!s.id) continue;
    if (s.type === "decision") {
      if (s.yesId && byId.has(s.yesId)) edges.push({ from: s.id, to: s.yesId, label: "Ya" });
      if (s.noId && byId.has(s.noId)) edges.push({ from: s.id, to: s.noId, label: "Tidak" });
    } else if (s.nextId && byId.has(s.nextId)) {
      edges.push({ from: s.id, to: s.nextId });
    }
  }
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    if (!adjacency.has(e.from)) adjacency.set(e.from, []);
    adjacency.get(e.from)!.push(e.to);
  }
  const startStep = steps.find((s) => s.type === "start" && s.id) || steps.find((s) => s.id);
  const row = new Map<string, number>();
  if (startStep?.id) {
    row.set(startStep.id, 0);
    const queue = [startStep.id];
    while (queue.length > 0) {
      const cur = queue.shift() as string;
      const curRow = row.get(cur) as number;
      for (const next of adjacency.get(cur) || []) {
        if (!row.has(next)) {
          row.set(next, curRow + 1);
          queue.push(next);
        }
      }
    }
  }
  // Steps BFS never reached (disconnected from start, or start missing) still
  // need a row so nothing is silently dropped from the diagram — append them
  // after the deepest reached row, in list order.
  let maxRow = row.size > 0 ? Math.max(...Array.from(row.values())) : -1;
  for (const s of steps) {
    if (s.id && !row.has(s.id)) {
      maxRow += 1;
      row.set(s.id, maxRow);
    }
  }
  const laneIndexFor = (actor: string | undefined) => {
    const idx = lanes.length > 0 ? lanes.indexOf(actor || "") : -1;
    return idx >= 0 ? idx : 0;
  };
  const positions = new Map<string, { laneIndex: number; row: number }>();
  for (const s of steps) {
    if (!s.id) continue;
    positions.set(s.id, { laneIndex: laneIndexFor(s.actor), row: row.get(s.id) ?? 0 });
  }
  const forwardEdges: typeof edges = [];
  const backEdges: typeof edges = [];
  for (const e of edges) {
    const fromRow = row.get(e.from) ?? 0, toRow = row.get(e.to) ?? 0;
    (toRow > fromRow ? forwardEdges : backEdges).push(e);
  }
  return { positions, forwardEdges, backEdges };
}

/**
 * Unified renderer for graph-mode diagrams (explicit nextId/yesId/noId
 * edges) — replaces the swimlane/single-column split for this mode. With 0-1
 * lanes every step's laneIndex is 0, so it naturally centers like the old
 * single-column layout while still using row-based (not order-based) Y —
 * meaning even a single-lane diagram benefits from real branching/loop-back.
 */
function drawFlowDiagramGraph(doc: PDFDocument, steps: ComposeFlowStep[], font: PDFFont, L: Layout, lanes: string[]) {
  const page = doc.addPage([PAGE_W, PAGE_H]);
  page.drawText("Diagram Alir", { x: L.mLeft, y: L.contentTopY, size: 14, font, color: rgb(0.16, 0.32, 0.75) });

  const hasLaneHeaders = lanes.length > 1;
  const effectiveLanes = hasLaneHeaders ? lanes : ["_"];
  const { positions, forwardEdges, backEdges } = layoutFlowGraph(steps, hasLaneHeaders ? lanes : []);

  const laneW = L.contentW / effectiveLanes.length;
  const headerTopY = L.contentTopY - (hasLaneHeaders ? 34 : 0);
  if (hasLaneHeaders) {
    for (let li = 0; li < effectiveLanes.length; li++) {
      const lx = L.mLeft + laneW * li;
      page.drawRectangle({ x: lx, y: headerTopY, width: laneW, height: 22, color: rgb(0.94, 0.95, 0.98), borderColor: rgb(0.7, 0.72, 0.78), borderWidth: 0.75 });
      const label = effectiveLanes[li].length > 18 ? effectiveLanes[li].slice(0, 17) + "…" : effectiveLanes[li];
      const lw = font.widthOfTextAtSize(label, 8.5);
      page.drawText(label, { x: lx + laneW / 2 - lw / 2, y: headerTopY + 7, size: 8.5, font, color: rgb(0.16, 0.16, 0.2) });
    }
  }
  const bodyBottom = L.mBottom + 20;
  for (let li = 1; li < effectiveLanes.length; li++) {
    const lx = L.mLeft + laneW * li;
    page.drawLine({ start: { x: lx, y: headerTopY }, end: { x: lx, y: bodyBottom }, thickness: 0.5, color: rgb(0.85, 0.86, 0.9) });
  }

  const nodeW = Math.max(Math.min(laneW - 20, 200), 80);
  const nodeH = 40, gap = 30;
  const rowTopY = headerTopY - (hasLaneHeaders ? 30 : 40);
  const byId = new Map(steps.filter((s) => s.id).map((s) => [s.id as string, s]));
  const centers = new Map<string, { x: number; y: number }>();

  for (const [id, pos] of positions) {
    const step = byId.get(id);
    if (!step) continue;
    // manualOffset: MINUS pada Y (origin PDF di kiri-bawah, jadi Y makin
    // besar = makin ke ATAS) — supaya "geser turun" di preview client
    // (Y makin besar = makin ke BAWAH di sana) tetap terlihat turun/lebih
    // akhir di PDF ini juga, bukan cuma sama tanda mentahnya.
    const y = rowTopY - pos.row * (nodeH + gap) - (step.manualOffset?.dyRow || 0) * (nodeH + gap);
    if (y - nodeH < bodyBottom) continue; // graceful stop on overflow — same convention as the legacy renderers
    const cx = L.mLeft + laneW * pos.laneIndex + laneW / 2 + (step.manualOffset?.dxLane || 0) * laneW;
    drawFlowStep(page, font, step, cx, y, nodeW, nodeH);
    centers.set(id, { x: cx, y });
  }

  // Forward edges: elbow when crossing lanes, same visual style as the
  // legacy swimlane connector. Label placed at the connector's own midpoint
  // (not fixed near the source) so a decision's Ya/Tidak labels — now two
  // REAL lines leaving the same box — don't collide with each other.
  for (const e of forwardEdges) {
    const a = centers.get(e.from), b = centers.get(e.to);
    if (!a || !b) continue;
    const aBottom = a.y - nodeH, bTop = b.y;
    const lineColor = rgb(0.4, 0.42, 0.48);
    let labelX: number, labelY: number;
    if (Math.abs(a.x - b.x) < 1) {
      page.drawLine({ start: { x: a.x, y: aBottom }, end: { x: b.x, y: bTop }, thickness: 1.2, color: lineColor });
      labelX = a.x + 6; labelY = (aBottom + bTop) / 2;
    } else {
      const midY = (aBottom + bTop) / 2;
      page.drawLine({ start: { x: a.x, y: aBottom }, end: { x: a.x, y: midY }, thickness: 1.2, color: lineColor });
      page.drawLine({ start: { x: a.x, y: midY }, end: { x: b.x, y: midY }, thickness: 1.2, color: lineColor });
      page.drawLine({ start: { x: b.x, y: midY }, end: { x: b.x, y: bTop }, thickness: 1.2, color: lineColor });
      labelX = (a.x + b.x) / 2; labelY = midY + 3;
    }
    if (e.label) {
      page.drawText(e.label, { x: labelX, y: labelY, size: 7, font, color: e.label === "Tidak" ? rgb(0.87, 0.2, 0.3) : rgb(0.06, 0.6, 0.4) });
    }
  }

  // Back-edges (loops, e.g. "Revisi" pointing back to an earlier step): routed
  // out the LEFT side of both boxes, around via the content area's left edge,
  // dashed + distinct color so a loop always reads visually differently from
  // the forward flow instead of looking like a stray crossing line.
  const backEdgeColor = rgb(0.82, 0.3, 0.3);
  const outX = L.mLeft;
  for (const e of backEdges) {
    const a = centers.get(e.from), b = centers.get(e.to);
    if (!a || !b) continue;
    const aY = a.y - nodeH / 2, bY = b.y - nodeH / 2;
    const aLeftX = a.x - nodeW / 2, bLeftX = b.x - nodeW / 2;
    const opts = { thickness: 1.1, color: backEdgeColor, dashArray: [3, 2] };
    page.drawLine({ start: { x: aLeftX, y: aY }, end: { x: outX, y: aY }, ...opts });
    page.drawLine({ start: { x: outX, y: aY }, end: { x: outX, y: bY }, ...opts });
    page.drawLine({ start: { x: outX, y: bY }, end: { x: bLeftX, y: bY }, ...opts });
    const label = e.label ? `${e.label} — kembali` : "kembali";
    page.drawText(label, { x: outX + 2, y: (aY + bY) / 2 + 2, size: 6.5, font, color: backEdgeColor });
  }
}

/**
 * Gaya "Working Instruction": tabel 3 kolom (bentuk kecil | instruksi | PIC),
 * satu baris per step berurutan `order` — LINEAR MURNI, bukan routing graf.
 * Cabang Ya/Tidak cukup disebut sbg teks di kolom instruksi (persis cara
 * dokumen WI aslinya menjelaskan cabang lewat prosa, bukan lewat routing
 * visual — tidak ada ruang utk lane paralel di dalam satu kolom sempit).
 */
function drawFlowDiagramTable(doc: PDFDocument, ordered: ComposeFlowStep[], bold: PDFFont, regular: PDFFont, L: Layout) {
  let page = doc.addPage([PAGE_W, PAGE_H]);
  page.drawText("Diagram Alir", { x: L.mLeft, y: L.contentTopY, size: 14, font: bold, color: rgb(0.16, 0.32, 0.75) });

  const shapeColW = 90, picColW = 90;
  const instrColW = L.contentW - shapeColW - picColW;
  const headers = ["Diagram Alir", "Instruksi Kerja", "PIC"];
  const colWidths = [shapeColW, instrColW, picColW];
  let y = L.contentTopY - 30;
  const drawHeaderRow = () => {
    let x = L.mLeft;
    for (let i = 0; i < headers.length; i++) {
      page.drawRectangle({ x, y: y - 20, width: colWidths[i], height: 20, color: rgb(0.94, 0.95, 0.98), borderColor: rgb(0.7, 0.72, 0.78), borderWidth: 0.75 });
      const tw = bold.widthOfTextAtSize(headers[i], 9);
      page.drawText(headers[i], { x: x + colWidths[i] / 2 - tw / 2, y: y - 14, size: 9, font: bold, color: rgb(0.16, 0.16, 0.2) });
      x += colWidths[i];
    }
    y -= 20;
  };
  drawHeaderRow();

  const shapeH = 32;
  for (const step of ordered) {
    const instrLines = wrapText(step.text, regular, 8.5, instrColW - 10);
    const rowH = Math.max(shapeH + 14, instrLines.length * 12 + 10, 34);
    if (y - rowH < L.mBottom) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = L.contentTopY;
      drawHeaderRow();
    }
    let x = L.mLeft;
    // Kolom bentuk — cuma outline (drawShapeOutline), teks instruksi ada di
    // kolom sebelah, bukan di dalam bentuknya sendiri (beda dari drawFlowStep).
    page.drawRectangle({ x, y: y - rowH, width: colWidths[0], height: rowH, borderColor: rgb(0.85, 0.86, 0.9), borderWidth: 0.5 });
    drawShapeOutline(page, step, x + colWidths[0] / 2, y - (rowH - shapeH) / 2, 46, shapeH, 1.1);
    x += colWidths[0];
    page.drawRectangle({ x, y: y - rowH, width: colWidths[1], height: rowH, borderColor: rgb(0.85, 0.86, 0.9), borderWidth: 0.5 });
    let ty = y - 14;
    for (const line of instrLines) {
      page.drawText(line, { x: x + 5, y: ty, size: 8.5, font: regular, color: rgb(0.2, 0.22, 0.27) });
      ty -= 12;
    }
    x += colWidths[1];
    page.drawRectangle({ x, y: y - rowH, width: colWidths[2], height: rowH, borderColor: rgb(0.85, 0.86, 0.9), borderWidth: 0.5 });
    const picLines = wrapText(step.pic || step.actor || "-", regular, 8, colWidths[2] - 10);
    let py = y - rowH / 2 + ((picLines.length - 1) * 12) / 2 + 3;
    for (const line of picLines) {
      const pw = regular.widthOfTextAtSize(line, 8);
      page.drawText(line, { x: x + colWidths[2] / 2 - pw / 2, y: py, size: 8, font: regular, color: rgb(0.2, 0.22, 0.27) });
      py -= 12;
    }
    y -= rowH;
  }
}

function drawFlowDiagram(doc: PDFDocument, steps: ComposeFlowStep[], font: PDFFont, boldFont: PDFFont, L: Layout, lanes?: string[], displayStyle?: "diagram" | "table") {
  if (displayStyle === "table") {
    const ordered = [...steps].sort((a, b) => a.order - b.order);
    drawFlowDiagramTable(doc, ordered, boldFont, font, L);
    return;
  }
  // Graph mode (real branching + loop-back) kicks in the moment ANY step has
  // an explicit edge wired up. Documents composed before this existed never
  // have these fields, so they always take the legacy path below, byte-
  // identical to before — zero regression, zero migration needed.
  const hasGraphEdges = steps.some((s) => s.nextId || s.yesId || s.noId);
  if (hasGraphEdges) {
    const configuredLanes = (lanes || []).filter((l) => steps.some((s) => s.actor === l));
    const derivedLanes = Array.from(new Set(steps.map((s) => s.actor).filter((a): a is string => !!a)));
    const effectiveLanes = configuredLanes.length > 1 ? configuredLanes : derivedLanes.length > 1 ? derivedLanes : [];
    drawFlowDiagramGraph(doc, steps, font, L, effectiveLanes);
    return;
  }
  const ordered = [...steps].sort((a, b) => a.order - b.order);
  const configuredLanes = (lanes || []).filter((l) => ordered.some((s) => s.actor === l));
  const derivedLanes = Array.from(new Set(ordered.map((s) => s.actor).filter((a): a is string => !!a)));
  const effectiveLanes = configuredLanes.length > 1 ? configuredLanes : derivedLanes.length > 1 ? derivedLanes : [];
  if (effectiveLanes.length > 1) {
    drawFlowDiagramSwimlane(doc, ordered, font, effectiveLanes, L);
  } else {
    drawFlowDiagramSingleColumn(doc, ordered, font, L);
  }
}

// ---------------------------------------------------------------------------
// Signature sheet ("Lembar Pengesahan"). Geometry is a pure function of the
// group/column structure + a SigLayout (marginX/colTopY/contentW). The
// SigLayout is persisted to compose metadata so sign-approve-time filling
// (fillSignatureColumn) uses identical coordinates even if margins/header
// change. Documents composed before this existed fall back to the old
// constants, so their fill stays pixel-identical.
// ---------------------------------------------------------------------------
const SIG_COL_TOP_Y = PAGE_H - DEFAULT_MARGIN - 60; // legacy default (docs without persisted sigLayout)
const SIG_LABEL_GAP = 18;
const SIG_NAME_LINE_OFFSET = 70; // distance below a band's column-top to its "Nama" line
const SIG_GROUP_HEADING_H = 16; // extra vertical space reserved above a band when it has a heading
const SIG_BAND_BODY_H = SIG_NAME_LINE_OFFSET + 30; // height of one band's box
const SIG_BAND_GAP = 22; // vertical gap between consecutive bands

const DEFAULT_SIG_LAYOUT: SigLayout = {
  marginX: DEFAULT_MARGIN, colTopY: SIG_COL_TOP_Y, contentW: PAGE_W - DEFAULT_MARGIN * 2,
};

export interface SignatureSlot {
  flatIndex: number; groupIndex: number; colIndexInGroup: number;
  x: number; colW: number; colTopY: number;
}

/** Pure geometry — no drawing, no PDF object. Shared by drawSignatureGroups
 * (compose time) and fillSignatureColumn (sign-approve time). `sig` carries the
 * marginX/colTopY/contentW; defaults reproduce the original fixed geometry. */
export function layoutSignatureGroups(groups: SignatureGroup[], sig: SigLayout = DEFAULT_SIG_LAYOUT): SignatureSlot[] {
  const slots: SignatureSlot[] = [];
  let flatIndex = 0;
  let bandTopY = sig.colTopY;
  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    const colTopY = group.heading ? bandTopY - SIG_GROUP_HEADING_H : bandTopY;
    const colW = sig.contentW / Math.max(group.columns.length, 1);
    for (let ci = 0; ci < group.columns.length; ci++) {
      const x = sig.marginX + colW * ci;
      slots.push({ flatIndex: flatIndex++, groupIndex: gi, colIndexInGroup: ci, x, colW, colTopY });
    }
    bandTopY = colTopY - SIG_BAND_BODY_H - SIG_BAND_GAP;
  }
  return slots;
}

function drawSignatureGroups(doc: PDFDocument, bold: PDFFont, regular: PDFFont, groups: SignatureGroup[], sig: SigLayout): number {
  const pageIndex = doc.getPageCount();
  const page = doc.addPage([PAGE_W, PAGE_H]);
  page.drawText("LEMBAR PENGESAHAN", { x: sig.marginX, y: sig.colTopY + 60, size: 13, font: bold, color: rgb(0.16, 0.32, 0.75) });
  const slots = layoutSignatureGroups(groups, sig);
  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    const groupSlots = slots.filter((s) => s.groupIndex === gi);
    if (groupSlots.length === 0) continue;
    if (group.heading) {
      page.drawText(group.heading, { x: sig.marginX, y: groupSlots[0].colTopY + SIG_GROUP_HEADING_H - 4, size: 10, font: bold, color: rgb(0.16, 0.16, 0.2) });
    }
    for (const slot of groupSlots) {
      const column = group.columns[slot.colIndexInGroup];
      const cx = slot.x + slot.colW / 2;
      const lw = bold.widthOfTextAtSize(column.label, 10);
      page.drawText(column.label, { x: cx - lw / 2, y: slot.colTopY, size: 10, font: bold, color: rgb(0.16, 0.16, 0.2) });
      // roleName opsional: baris placeholder jabatan kedua di bawah label aksi
      // (mis. "Dibuat Oleh:" + "HED Manager") — kosong = perilaku lama persis
      // (1 baris saja).
      if (column.roleName) {
        const rw = regular.widthOfTextAtSize(column.roleName, 8.5);
        page.drawText(column.roleName, { x: cx - rw / 2, y: slot.colTopY - 13, size: 8.5, font: regular, color: rgb(0.4, 0.42, 0.48) });
      }
      page.drawRectangle({ x: slot.x + 8, y: slot.colTopY - SIG_BAND_BODY_H, width: slot.colW - 16, height: SIG_BAND_BODY_H - 12, borderColor: rgb(0.75, 0.76, 0.8), borderWidth: 0.75 });
      const fieldLabels = ["Nama", "Jabatan", "Tanggal"];
      for (let f = 0; f < fieldLabels.length; f++) {
        const y = slot.colTopY - SIG_NAME_LINE_OFFSET - f * SIG_LABEL_GAP;
        page.drawText(`${fieldLabels[f]}:`, { x: slot.x + 12, y, size: 8, font: regular, color: rgb(0.5, 0.52, 0.58) });
      }
    }
  }
  return pageIndex;
}

/**
 * Fills one column of an already-composed signature sheet with the actual
 * approver's name/role/date. `sig` MUST be the same SigLayout used at compose
 * time (persisted in compose metadata) so the text lands in the drawn box;
 * omitted → legacy default geometry for pre-SigLayout documents.
 */
export async function fillSignatureColumn(
  pdf: Buffer,
  groups: SignatureGroup[],
  pageIndex: number | null,
  flatColumnIndex: number,
  signerName: string,
  signerRole: string,
  dateStr: string,
  sig: SigLayout = DEFAULT_SIG_LAYOUT,
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdf);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  const page = (pageIndex !== null ? pages[pageIndex] : undefined) ?? pages[pages.length - 1];
  const slots = layoutSignatureGroups(groups, sig);
  const slot = slots[flatColumnIndex];
  if (!slot) throw new Error(`Signature column index ${flatColumnIndex} out of range (0..${slots.length - 1})`);
  // Baris "Jabatan" pakai roleName spesifik dari template kolom (mis. "HED
  // Manager") kalau dikonfigurasi — lebih bermakna daripada signerRole yang
  // cuma gerbang izin platform kasar ("manager"). Kosong = perilaku lama.
  const column = groups[slot.groupIndex]?.columns[slot.colIndexInGroup];
  const jabatan = column?.roleName || signerRole;
  const fieldValues = [signerName, jabatan, dateStr];
  for (let f = 0; f < fieldValues.length; f++) {
    const y = slot.colTopY - SIG_NAME_LINE_OFFSET - f * SIG_LABEL_GAP;
    const labelW = font.widthOfTextAtSize(["Nama", "Jabatan", "Tanggal"][f] + ": ", 8);
    const maxW = slot.colW - 16 - labelW - 4;
    const value = fieldValues[f].length * font.widthOfTextAtSize("M", 8) > maxW
      ? fieldValues[f].slice(0, Math.max(4, Math.floor(maxW / font.widthOfTextAtSize("M", 8))))
      : fieldValues[f];
    page.drawText(value, { x: slot.x + 12 + labelW, y, size: 8, font, color: rgb(0.06, 0.32, 0.2) });
  }
  return doc.save();
}

// Paragraf kerahasiaan/hak cipta dokumen — italic, abu-abu, dekat akhir
// dokumen. Kosong/tidak diisi tenant (CompanyBranding.confidentialityNotice)
// = tidak dicetak sama sekali (bukan wajib, kata-kata legalnya beda-beda
// per perusahaan jadi tidak ada default hardcoded di sini).
function drawConfidentialityNotice(doc: PDFDocument, bold: PDFFont, regular: PDFFont, text: string, L: Layout) {
  const page = doc.addPage([PAGE_W, PAGE_H]);
  let y = L.contentTopY;
  const lineHeight = 8.5 * 1.4;
  for (const line of wrapText(text, regular, 8.5, L.contentW)) {
    if (y - lineHeight < L.mBottom) break; // catatan singkat, tidak perlu multi-halaman
    page.drawText(line, { x: L.mLeft, y: y - lineHeight, size: 8.5, font: regular, color: rgb(0.45, 0.47, 0.52) });
    y -= lineHeight;
  }
}

// ---------------------------------------------------------------------------
// Tabel data generik: border, kolom lebar-sama, header abu-abu, page-break
// otomatis dekat batas bawah. Dipakai ULANG oleh riwayat revisi, tabel di
// dalam section (ComposeSection.table), dan bisa dipakai penambahan lain di
// masa depan — satu sumber mekanika gambar-tabel, tidak diduplikasi 2-3 kali.
function drawTable(doc: PDFDocument, cur: Cursor, columns: string[], rows: string[][], bold: PDFFont, regular: PDFFont, L: Layout): Cursor {
  if (columns.length === 0) return cur;
  // Lebar kolom = rata. Teks DIBUNGKUS ke lebar kolom sebenarnya (bukan
  // dipotong per-jumlah-karakter spt dulu, yg bikin teks meluber & menimpa
  // kolom/header sebelah). Tinggi baris dinamis mengikuti jumlah baris.
  const colW = L.contentW / columns.length;
  const PAD = 4;                 // padding kiri/kanan sel
  const textW = Math.max(colW - PAD * 2, 8);
  const HEAD_SIZE = 8.5, CELL_SIZE = 8, LINE_H = 11, VPAD = 6, MIN_ROW = 20, MAX_LINES = 8;
  let { page, y } = cur;

  const fitLines = (text: string, font: PDFFont, size: number): string[] => {
    const ls = wrapText(text || "", font, size, textW);
    if (ls.length === 0) return [""];
    return ls.length > MAX_LINES ? [...ls.slice(0, MAX_LINES - 1), "…"] : ls;
  };
  const rowHeight = (linesPer: string[][]) =>
    Math.max(MIN_ROW, Math.max(...linesPer.map((l) => l.length)) * LINE_H + VPAD * 2);

  const drawHeaderRow = () => {
    const linesPer = columns.map((c) => fitLines(c, bold, HEAD_SIZE));
    const h = rowHeight(linesPer);
    let x = L.mLeft;
    for (let i = 0; i < columns.length; i++) {
      page.drawRectangle({ x, y: y - h, width: colW, height: h, color: rgb(0.94, 0.95, 0.98), borderColor: rgb(0.7, 0.72, 0.78), borderWidth: 0.75 });
      linesPer[i].forEach((ln, li) => page.drawText(ln, { x: x + PAD, y: y - VPAD - HEAD_SIZE - li * LINE_H, size: HEAD_SIZE, font: bold, color: rgb(0.16, 0.16, 0.2) }));
      x += colW;
    }
    y -= h;
  };

  if (y - (MIN_ROW * 2) < L.mBottom) { page = doc.addPage([PAGE_W, PAGE_H]); y = L.contentTopY; }
  drawHeaderRow();
  for (const cells of rows) {
    const linesPer = columns.map((_c, i) => fitLines(cells[i] || "", regular, CELL_SIZE));
    const h = rowHeight(linesPer);
    if (y - h < L.mBottom) { page = doc.addPage([PAGE_W, PAGE_H]); y = L.contentTopY; drawHeaderRow(); }
    let x = L.mLeft;
    for (let i = 0; i < columns.length; i++) {
      page.drawRectangle({ x, y: y - h, width: colW, height: h, borderColor: rgb(0.85, 0.86, 0.9), borderWidth: 0.5 });
      linesPer[i].forEach((ln, li) => page.drawText(ln, { x: x + PAD, y: y - VPAD - CELL_SIZE - li * LINE_H, size: CELL_SIZE, font: regular, color: rgb(0.2, 0.22, 0.27) }));
      x += colW;
    }
    y -= h;
  }
  return { page, y: y - 10 };
}

// ---------------------------------------------------------------------------
// Revision history + appendix — trailing admin pages, printed after the
// signature sheet.
// ---------------------------------------------------------------------------
function drawRevisionHistoryTable(doc: PDFDocument, bold: PDFFont, regular: PDFFont, rows: NonNullable<ComposeInput["revisionHistory"]>, L: Layout) {
  const page = doc.addPage([PAGE_W, PAGE_H]);
  page.drawText("Revisi Dan Riwayat Perubahan", { x: L.mLeft, y: L.contentTopY, size: 13, font: bold, color: rgb(0.16, 0.32, 0.75) });
  // Selalu tampil minimal MIN_ROWS baris (nyata + kosong) supaya tabel ini
  // konsisten jadi kerangka siap-isi bahkan di versi pertama dokumen (tanpa
  // riwayat sungguhan) — bukan diam-diam absen sampai revisi ke-2.
  const MIN_ROWS = 3;
  const blankCount = Math.max(0, MIN_ROWS - rows.length);
  const tableRows: string[][] = [
    ...rows.map((r) => [
      `${r.major}.${r.minor}`,
      r.effectiveAt ? new Date(r.effectiveAt).toLocaleDateString("id-ID") : "-",
      r.changeSummary || "-",
    ]),
    ...Array.from({ length: blankCount }, () => ["", "", ""]),
  ];
  drawTable(doc, { page, y: L.contentTopY - 30 }, ["Rev. No", "Tanggal", "Catatan"], tableRows, bold, regular, L);
}

function drawAppendixList(doc: PDFDocument, bold: PDFFont, regular: PDFFont, items: NonNullable<ComposeInput["appendix"]>, L: Layout) {
  if (items.length === 0) return;
  let page = doc.addPage([PAGE_W, PAGE_H]);
  page.drawText("Lampiran", { x: L.mLeft, y: L.contentTopY, size: 13, font: bold, color: rgb(0.16, 0.32, 0.75) });
  let y = L.contentTopY - 30;
  let no = 1;
  for (const item of items) {
    if (y - 40 < L.mBottom) { page = doc.addPage([PAGE_W, PAGE_H]); y = L.contentTopY - 20; }
    page.drawText(`${no++}. ${item.label}`, { x: L.mLeft, y, size: 10, font: bold, color: rgb(0.15, 0.16, 0.2) });
    y -= 14;
    for (const line of wrapText(item.url, regular, 9, L.contentW - 12)) {
      page.drawText(line, { x: L.mLeft + 12, y, size: 9, font: regular, color: rgb(0.16, 0.32, 0.75) });
      y -= 12;
    }
    y -= 10;
  }
}

// ---------------------------------------------------------------------------
// Header ISO formal (kotak metadata) + footer "Page X Of Y", digambar SETELAH
// semua halaman terbentuk (two-pass) supaya jumlah halaman total diketahui.
// Meniru kop SOP standar Indonesia pada contoh: sel logo + judul di atas, lalu
// grid 2 kolom (Nomor Dokumen | Tanggal Diterbitkan; Revisi | Halaman; Bahasa |
// Tingkat; Pemilik Proses | Status).
// ---------------------------------------------------------------------------
interface IsoHeaderMeta {
  documentNumber: string; title: string; docTypeName: string;
  issuedDate: string; revisionLabel: string; language: string;
  documentLevel: string; processOwner: string; statusLabel: string;
}

async function embedLogo(doc: PDFDocument, logo?: { bytes: Buffer; mimeType: string }) {
  if (!logo) return null;
  try {
    return logo.mimeType.includes("png") ? await doc.embedPng(logo.bytes) : await doc.embedJpg(logo.bytes);
  } catch { return null; }
}

function drawIsoHeaderBox(
  page: PDFPage, bold: PDFFont, regular: PDFFont, meta: IsoHeaderMeta, L: Layout,
  pageNo: number, pageTotal: number, logo: Awaited<ReturnType<typeof embedLogo>>,
): HeaderReactiveLayout {
  const boxTop = PAGE_H - L.mTop;
  const boxLeft = L.mLeft;
  const boxRight = PAGE_W - L.mRight;
  const boxW = boxRight - boxLeft;
  const border = rgb(0.25, 0.27, 0.32);
  const line = (x1: number, y1: number, x2: number, y2: number, th = 0.75) =>
    page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: th, color: border });

  // Outer box
  page.drawRectangle({ x: boxLeft, y: boxTop - HEADER_BOX_H, width: boxW, height: HEADER_BOX_H, borderColor: border, borderWidth: 1 });

  const logoColW = 78;
  const titleBandH = 34;
  const titleX = boxLeft + logoColW;
  // Pemisah kolom logo — HANYA di pita judul (atas), TIDAK menembus ke grid
  // metadata di bawahnya (dulu setinggi kotak penuh → garis vertikal ini
  // memotong teks kolom kiri metadata spt "Nomor Dokumen: SOP|/HED/...").
  line(titleX, boxTop, titleX, boxTop - titleBandH);
  if (logo) {
    const scale = Math.min((logoColW - 16) / logo.width, (titleBandH - 8) / logo.height, 1);
    const w = logo.width * scale, h = logo.height * scale;
    page.drawImage(logo, { x: boxLeft + (logoColW - w) / 2, y: boxTop - titleBandH / 2 - h / 2, width: w, height: h });
  }
  // Title band (docTypeName + document title), centered in the remaining width
  const bandCx = titleX + (boxRight - titleX) / 2;
  const tn = meta.docTypeName.toUpperCase();
  const tnW = bold.widthOfTextAtSize(tn, 9);
  page.drawText(tn, { x: bandCx - tnW / 2, y: boxTop - 13, size: 9, font: bold, color: rgb(0.09, 0.1, 0.14) });
  const titleTxt = meta.title.length > 64 ? meta.title.slice(0, 63) + "…" : meta.title;
  const ttW = bold.widthOfTextAtSize(titleTxt, 8);
  page.drawText(titleTxt, { x: bandCx - ttW / 2, y: boxTop - 25, size: 8, font: bold, color: rgb(0.2, 0.22, 0.27) });
  // Garis bawah pita judul — LEBAR PENUH (boxLeft→boxRight), termasuk di bawah
  // sel logo (dulu mulai dari titleX → di bawah logo tak ada garis pemisah).
  line(boxLeft, boxTop - titleBandH, boxRight, boxTop - titleBandH);

  // Metadata grid: 4 rows x 2 cells, below the title band, spanning full width.
  const gridTop = boxTop - titleBandH;
  const gridH = HEADER_BOX_H - titleBandH;
  const rowH = gridH / 4;
  const midX = boxLeft + boxW / 2;
  line(midX, gridTop, midX, boxTop - HEADER_BOX_H);
  const cell = (col: 0 | 1, row: number, label: string, value: string) => {
    const cx0 = col === 0 ? boxLeft : midX;
    const yTop = gridTop - row * rowH;
    if (row > 0) line(boxLeft, yTop, boxRight, yTop, 0.5);
    const txt = `${label}: ${value}`;
    const clipped = txt.length > 46 ? txt.slice(0, 45) + "…" : txt;
    page.drawText(clipped, { x: cx0 + 5, y: yTop - rowH / 2 - 3, size: 7, font: regular, color: rgb(0.2, 0.22, 0.27) });
  };
  // Sel REAKTIF: gambar hanya labelnya, kosongkan nilainya, kembalikan koordinat
  // tempat nilai akan diisi reaktif (Status/Tanggal Terbit berubah setelah
  // compose — dipanggang di sini = selalu basi, lihat pdf-watermark.ts).
  const REACT_SIZE = 7;
  const cellReactive = (col: 0 | 1, row: number, label: string): { x: number; y: number; size: number } => {
    const cx0 = col === 0 ? boxLeft : midX;
    const yTop = gridTop - row * rowH;
    if (row > 0) line(boxLeft, yTop, boxRight, yTop, 0.5);
    const prefix = `${label}: `;
    const y = yTop - rowH / 2 - 3;
    page.drawText(prefix, { x: cx0 + 5, y, size: REACT_SIZE, font: regular, color: rgb(0.2, 0.22, 0.27) });
    return { x: cx0 + 5 + regular.widthOfTextAtSize(prefix, REACT_SIZE), y, size: REACT_SIZE };
  };
  cell(0, 0, "Nomor Dokumen", meta.documentNumber);
  const issued = cellReactive(1, 0, "Tanggal Diterbitkan");
  cell(0, 1, "Nomor Revisi/Tahun", meta.revisionLabel);
  cell(1, 1, "Nomor Halaman", `Page ${pageNo} Of ${pageTotal}`);
  cell(0, 2, "Bahasa", meta.language);
  cell(1, 2, "Tingkat Dokumen", meta.documentLevel);
  cell(0, 3, "Pemilik Proses", meta.processOwner);
  const status = cellReactive(1, 3, "Status Dokumen");
  return { status, issued };
}

function drawIsoFooter(page: PDFPage, regular: PDFFont, L: Layout, pageNo: number, pageTotal: number) {
  const txt = `Page ${pageNo} Of ${pageTotal}`;
  const w = regular.widthOfTextAtSize(txt, 8);
  page.drawText(txt, { x: PAGE_W / 2 - w / 2, y: L.mBottom - 16 > 8 ? L.mBottom - 16 : 8, size: 8, font: regular, color: rgb(0.45, 0.47, 0.52) });
}

export async function composeDocumentPdf(input: ComposeInput): Promise<ComposeResult> {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const iso = input.headerStyle === "iso";
  const L = buildLayout(input.margins, iso);

  const page = doc.addPage([PAGE_W, PAGE_H]);
  let cur: Cursor = { page, y: L.contentTopY };

  if (!iso) {
    // Header "memo" berbingkai (lihat drawMemoHeaderBox) — logo di-embed sekali
    // di sini, dipakai juga oleh two-pass ISO stamping di bawah kalau iso.
    const logo = await embedLogo(doc, input.letterhead?.logo);
    const bottomY = drawMemoHeaderBox(page, bold, regular, input.letterhead, {
      documentNumber: input.documentNumber, minor: input.minor, major: input.major,
      issuedDate: input.issuedDate || "-",
    }, L, logo);
    cur = { page, y: bottomY };
    const titleLines = wrapText(input.title, bold, 15, L.contentW);
    for (const lineTxt of titleLines) {
      cur = ensureSpace(doc, cur, 20, L);
      cur.page.drawText(lineTxt, { x: L.mLeft, y: cur.y - 15, size: 15, font: bold, color: rgb(0.09, 0.1, 0.14) });
      cur = { page: cur.page, y: cur.y - 20 };
    }
    cur = { page: cur.page, y: cur.y - 8 };
  }
  // Mode ISO: judul/nomor ada di kotak header (di-stamp two-pass di akhir),
  // jadi body langsung mulai dari section pertama.

  if (input.purpose?.trim()) {
    cur = drawHeading(doc, cur, "Tujuan", bold, L);
    cur = drawParagraph(doc, cur, input.purpose, regular, bold, 10.5, L);
    cur = { page: cur.page, y: cur.y - 8 };
  }
  if (input.scope?.trim()) {
    cur = drawHeading(doc, cur, "Ruang Lingkup", bold, L);
    cur = drawParagraph(doc, cur, input.scope, regular, bold, 10.5, L);
    cur = { page: cur.page, y: cur.y - 8 };
  }
  for (const section of input.sections) {
    if (!section.heading.trim() && !section.content.trim() && !section.table) continue;
    cur = drawHeading(doc, cur, section.heading || "(Tanpa Judul Bagian)", bold, L);
    if (section.content.trim()) {
      cur = drawParagraph(doc, cur, section.content, regular, bold, 10.5, L);
    }
    if (section.table && section.table.columns.length > 0) {
      cur = { page: cur.page, y: cur.y - 4 };
      cur = drawTable(doc, cur, section.table.columns, section.table.rows, bold, regular, L);
    }
    cur = { page: cur.page, y: cur.y - 8 };
  }

  if (input.flow?.mode === "builder" && input.flow.steps.length > 0) {
    drawFlowDiagram(doc, input.flow.steps, regular, bold, L, input.flow.lanes, input.flow.displayStyle);
  } else if (input.flow?.mode === "image") {
    const flowPage = doc.addPage([PAGE_W, PAGE_H]);
    flowPage.drawText("Diagram Alir", { x: L.mLeft, y: L.contentTopY, size: 14, font: bold, color: rgb(0.16, 0.32, 0.75) });
    const isPng = input.flow.mimeType.includes("png");
    const img = isPng ? await doc.embedPng(input.flow.image) : await doc.embedJpg(input.flow.image);
    const maxW = L.contentW, maxH = L.contentTopY - L.mBottom - 30;
    const scale = Math.min(maxW / img.width, maxH / img.height, 1);
    const w = img.width * scale, h = img.height * scale;
    flowPage.drawImage(img, { x: (PAGE_W - w) / 2, y: L.contentTopY - 30 - h, width: w, height: h });
  }

  // SigLayout: mode ISO menurunkan sheet di bawah pita header; mode simple
  // dengan margin default = geometri lama persis.
  const sig: SigLayout = {
    marginX: L.mLeft,
    colTopY: L.contentTopY - 60,
    contentW: L.contentW,
  };

  let signatureSheetPageIndex: number | null = null;
  let headerLayout: HeaderReactiveLayout | null = null;
  const groups: SignatureGroup[] | null = input.signatureGroups && input.signatureGroups.length > 0
    ? input.signatureGroups
    : input.signatureColumns && input.signatureColumns.length > 0
      ? [{ columns: input.signatureColumns }]
      : null;
  if (groups) {
    signatureSheetPageIndex = drawSignatureGroups(doc, bold, regular, groups, sig);
  }

  if (input.confidentialityNotice?.trim()) {
    drawConfidentialityNotice(doc, bold, regular, input.confidentialityNotice, L);
  }
  // Selalu dipanggil (bukan cuma saat ada riwayat sungguhan) — tabelnya
  // sendiri sudah menangani array kosong dgn menampilkan kerangka kosong,
  // supaya versi pertama dokumen pun langsung punya tabel siap-isi.
  drawRevisionHistoryTable(doc, bold, regular, input.revisionHistory || [], L);
  if (input.appendix && input.appendix.length > 0) {
    drawAppendixList(doc, bold, regular, input.appendix, L);
  }

  // Two-pass ISO header/footer stamping — now that every page exists and the
  // total is known, draw the metadata box + "Page X Of Y" on each page.
  if (iso) {
    const meta: IsoHeaderMeta = {
      documentNumber: input.documentNumber,
      title: input.title,
      docTypeName: input.docTypeName || input.docTypeCode,
      issuedDate: input.issuedDate || "-",
      revisionLabel: `${String(input.minor).padStart(2, "0")}/${new Date().getFullYear().toString().slice(-2)}`,
      language: input.language || "Indonesia",
      documentLevel: input.documentLevel || "Internal",
      processOwner: input.processOwner || input.department,
      statusLabel: input.statusLabel || "Draft",
    };
    const logo = await embedLogo(doc, input.letterhead?.logo);
    const pages = doc.getPages();
    const total = pages.length;
    for (let i = 0; i < total; i++) {
      headerLayout = drawIsoHeaderBox(pages[i], bold, regular, meta, L, i + 1, total, logo);
      drawIsoFooter(pages[i], regular, L, i + 1, total);
    }
  }

  const bytes = await doc.save();
  return { bytes, signatureSheetPageIndex, sigLayout: groups ? sig : null, headerLayout };
}

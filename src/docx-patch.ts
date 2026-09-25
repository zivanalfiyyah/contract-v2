// ---------------------------------------------------------------------------
// DOCX "edit in place" untuk Document Workspace (dokumen hasil Upload).
//
// Kenapa bukan konversi DOCX -> HTML -> DOCX?
//   Konversi bolak-balik (mammoth, html-docx, dst) selalu kehilangan kop/
//   header, logo, footer, section/page break, style tabel, dan tata letak
//   area tanda tangan — persis masalah "dokumen jadi kumpulan paragraf" yang
//   mau dihindari. Di sini berkas .docx ASLI tetap jadi sumber kebenaran:
//
//   1. Tampilan: docx-preview merender word/document.xml apa adanya (header,
//      footer, tabel, gambar, page break).
//   2. Edit: setiap <p> hasil render dipasangkan (by text) ke <w:p> di XML.
//      Hanya paragraf yang berhasil dipasangkan yang bisa diedit.
//   3. Simpan: untuk tiap paragraf yang berubah, dihitung diff karakter antara
//      teks lama & baru, lalu diff itu diterapkan langsung ke node <w:t> di
//      XML. Run (w:r) & properti paragraf (w:pPr) tidak disentuh, jadi bold/
//      italic/warna/ukuran font/alignment/numbering tetap; teks yang disisip
//      mengikuti format karakter di posisi sisip (perilaku sama seperti Word).
//   4. Seluruh part lain di dalam zip (header, footer, media, styles,
//      numbering, settings) disalin byte-per-byte ke berkas versi baru.
//
// Batasan tahap awal (sengaja): tidak bisa menambah paragraf/baris tabel
// baru dan header/footer tidak bisa diedit dari workspace (diproteksi supaya
// kop/logo tidak rusak). Untuk perubahan struktur, gunakan "Unggah Revisi".
// ---------------------------------------------------------------------------
import JSZip from "jszip";
import { diffChars } from "diff";

export const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const XML_NS = "http://www.w3.org/XML/1998/namespace";

export interface DocxModel {
  zip: JSZip;
  xml: XMLDocument;
  /** <w:p> di body dokumen, urut dokumen (termasuk yang di dalam tabel). */
  paragraphs: Element[];
}

type Seg =
  | { kind: "t"; el: Element; start: number; len: number }
  | { kind: "tab" | "br"; el: Element; start: number; len: 1 };

function isW(el: Element, local: string) {
  return el.namespaceURI === W_NS && el.localName === local;
}

/** true kalau el berada di dalam textbox/drawing (paragraf "melayang"). */
function insideTextbox(el: Element, stopAt: Element | null): boolean {
  let cur: Element | null = el.parentElement;
  while (cur && cur !== stopAt) {
    if (cur.namespaceURI === W_NS && cur.localName === "txbxContent") return true;
    cur = cur.parentElement;
  }
  return false;
}

/** Segmen teks sebuah <w:p> berurutan: w:t, w:tab ("\t"), w:br/w:cr ("\n"). */
function segmentsOf(p: Element): Seg[] {
  const segs: Seg[] = [];
  let pos = 0;
  const walk = (node: Element) => {
    for (const child of Array.from(node.children)) {
      if (child.namespaceURI === W_NS) {
        const ln = child.localName;
        // Teks yang terhapus (tracked change), instruksi field, & isi
        // textbox bukan bagian teks paragraf yang tampil — lewati.
        if (ln === "del" || ln === "instrText" || ln === "delText" || ln === "txbxContent" || ln === "pPr" || ln === "rPr") continue;
        if (ln === "t") {
          const len = (child.textContent || "").length;
          segs.push({ kind: "t", el: child, start: pos, len });
          pos += len;
          continue;
        }
        if (ln === "tab" && child.parentElement && isW(child.parentElement, "r")) {
          segs.push({ kind: "tab", el: child, start: pos, len: 1 });
          pos += 1;
          continue;
        }
        if ((ln === "br" || ln === "cr") && child.getAttributeNS(W_NS, "type") !== "page") {
          segs.push({ kind: "br", el: child, start: pos, len: 1 });
          pos += 1;
          continue;
        }
      }
      walk(child);
    }
  };
  walk(p);
  return segs;
}

export function paragraphText(p: Element): string {
  return segmentsOf(p)
    .map((s) => (s.kind === "t" ? s.el.textContent || "" : s.kind === "tab" ? "\t" : "\n"))
    .join("");
}

export async function loadDocx(buf: ArrayBuffer): Promise<DocxModel> {
  const zip = await JSZip.loadAsync(buf);
  const entry = zip.file("word/document.xml");
  if (!entry) throw new Error("Berkas .docx tidak valid (word/document.xml tidak ditemukan).");
  const xml = new DOMParser().parseFromString(await entry.async("string"), "application/xml");
  if (xml.getElementsByTagName("parsererror").length) throw new Error("word/document.xml tidak bisa dibaca.");
  const body = xml.getElementsByTagNameNS(W_NS, "body")[0];
  if (!body) throw new Error("Berkas .docx tidak punya body dokumen.");
  const paragraphs = Array.from(body.getElementsByTagNameNS(W_NS, "p")).filter((p) => !insideTextbox(p, body));
  return { zip, xml, paragraphs };
}

// ---- Normalisasi & ekstraksi teks dari DOM hasil render --------------------

/** Samakan karakter yang dirender beda tapi maknanya sama (1:1, panjang tetap). */
export function normChars(s: string): string {
  return s.replace(/ /g, " ").replace(/​/g, "");
}
function matchKey(s: string): string {
  return normChars(s).replace(/\s+/g, " ").trim();
}

// Atribut karakter yang bisa diubah dari toolbar workspace (bitmask).
export const ATTR_B = 1, ATTR_I = 2, ATTR_U = 4;

function styleAttrs(el: Element | null, host: Element): number {
  if (!el) return 0;
  const cs = getComputedStyle(el);
  let a = 0;
  const w = parseInt(cs.fontWeight, 10);
  if ((isNaN(w) ? cs.fontWeight === "bold" : w >= 600)) a |= ATTR_B;
  if (cs.fontStyle === "italic" || cs.fontStyle === "oblique") a |= ATTR_I;
  // text-decoration tidak diwariskan di computed style -> telusuri leluhur.
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    if (getComputedStyle(cur).textDecorationLine.includes("underline")) { a |= ATTR_U; break; }
    if (cur === host) break;
  }
  return a;
}

/**
 * Teks + atribut per karakter sebuah <p> hasil render.
 * <br> -> "\n", tab-stop docx-preview -> "\t", nbsp -> spasi.
 */
export function renderedChars(el: Element): { text: string; attrs: number[] } {
  let text = "";
  const attrs: number[] = [];
  const push = (s: string, a: number) => {
    for (const ch of s) {
      if (ch === "\u200b" || ch === "\ufeff") continue;
      text += ch === "\u00a0" ? " " : ch;
      attrs.push(a);
    }
  };
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) { push((n as Text).data, styleAttrs(n.parentElement, el)); return; }
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    const e = n as HTMLElement;
    if (e.tagName === "BR") { push("\n", attrs.length ? attrs[attrs.length - 1] : styleAttrs(e.parentElement, el)); return; }
    if (e.classList.contains("docx-tab-stop")) { push("\t", styleAttrs(e, el)); return; }
    e.childNodes.forEach(walk);
  };
  el.childNodes.forEach(walk);
  return { text, attrs };
}

/** Teks sebuah <p> hasil render (lihat renderedChars). */
export function renderedText(el: Element): string {
  return renderedChars(el).text;
}

export function renderedAlign(el: HTMLElement): string {
  const a = getComputedStyle(el).textAlign;
  return a === "start" ? "left" : a === "end" ? "right" : a;
}

export interface ParagraphBinding { el: HTMLElement; index: number; original: string; attrs: number[]; align: string }

/**
 * Pasangkan <p> hasil render (di luar header/footer) dengan <w:p> di XML,
 * greedy berdasarkan teks. Paragraf yang tidak yakin cocok TIDAK diikat
 * (tetap tampil, tapi tidak bisa diedit) — lebih aman daripada salah tulis.
 */
export function bindRenderedParagraphs(container: HTMLElement, model: DocxModel): ParagraphBinding[] {
  const rendered = Array.from(container.querySelectorAll("p")).filter(
    (p) => !p.closest("header") && !p.closest("footer"),
  ) as HTMLElement[];
  const xmlKeys = model.paragraphs.map((p) => matchKey(paragraphText(p)));
  const bindings: ParagraphBinding[] = [];
  let j = 0;
  const LOOKAHEAD = 40;
  for (const el of rendered) {
    const rc = renderedChars(el);
    const key = matchKey(rc.text);
    let found = -1;
    for (let k = j; k < Math.min(xmlKeys.length, j + LOOKAHEAD); k++) {
      if (xmlKeys[k] === key) { found = k; break; }
    }
    if (found === -1) continue;
    bindings.push({ el, index: found, original: rc.text, attrs: rc.attrs, align: renderedAlign(el) });
    j = found + 1;
  }
  return bindings;
}

// ---- Terapkan perubahan teks ke XML ----------------------------------------

function setText(t: Element, text: string) {
  t.textContent = text;
  t.setAttributeNS(XML_NS, "xml:space", "preserve");
}

/** Buat node run-child untuk teks yang boleh mengandung \n / \t. */
function nodesForText(xml: XMLDocument, text: string): Element[] {
  const out: Element[] = [];
  let buf = "";
  const flush = () => {
    if (!buf) return;
    const t = xml.createElementNS(W_NS, "w:t");
    setText(t, buf);
    out.push(t);
    buf = "";
  };
  for (const ch of text) {
    if (ch === "\n") { flush(); out.push(xml.createElementNS(W_NS, "w:br")); }
    else if (ch === "\t") { flush(); out.push(xml.createElementNS(W_NS, "w:tab")); }
    else buf += ch;
  }
  flush();
  return out;
}

/** Hapus teks [from, to) dari paragraf. */
function deleteRange(p: Element, from: number, to: number) {
  if (to <= from) return;
  for (const s of segmentsOf(p)) {
    const a = Math.max(from, s.start);
    const b = Math.min(to, s.start + s.len);
    if (b <= a) continue;
    if (s.kind === "t") {
      const txt = s.el.textContent || "";
      setText(s.el, txt.slice(0, a - s.start) + txt.slice(b - s.start));
    } else {
      s.el.parentNode?.removeChild(s.el);
    }
  }
}

/** Sisipkan teks pada posisi pos, mewarisi format run di posisi itu. */
function insertAt(xml: XMLDocument, p: Element, pos: number, text: string) {
  if (!text) return;
  const segs = segmentsOf(p);
  // Prioritas: segmen w:t yang memuat pos (atau berakhir tepat di pos —
  // format karakter sebelumnya, seperti Word), lalu segmen w:t mana pun
  // sesudahnya, lalu run apa pun.
  let target: Seg | undefined =
    segs.find((s) => s.kind === "t" && pos > s.start && pos <= s.start + s.len) ||
    segs.find((s) => s.kind === "t" && pos === s.start);
  if (!target) {
    // Posisi di batas tab/br atau paragraf tanpa w:t sama sekali.
    const before = [...segs].reverse().find((s) => s.start + s.len <= pos);
    const after = segs.find((s) => s.start >= pos);
    const anchor = before || after;
    if (anchor) {
      const nodes = nodesForText(xml, text);
      const ref = anchor.el;
      if (before) {
        let cursor: Node = ref;
        for (const n of nodes) { cursor.parentNode!.insertBefore(n, cursor.nextSibling); cursor = n; }
      } else {
        for (const n of nodes) ref.parentNode!.insertBefore(n, ref);
      }
      return;
    }
    // Paragraf kosong: buat run baru, salin format "mark run" paragraf bila ada.
    const r = xml.createElementNS(W_NS, "w:r");
    const pPr = Array.from(p.children).find((c) => isW(c, "pPr"));
    const markRPr = pPr ? Array.from(pPr.children).find((c) => isW(c, "rPr")) : undefined;
    if (markRPr) r.appendChild(markRPr.cloneNode(true));
    for (const n of nodesForText(xml, text)) r.appendChild(n);
    p.appendChild(r);
    return;
  }
  const t = target.el;
  const txt = t.textContent || "";
  const off = pos - target.start;
  if (!/[\n\t]/.test(text)) {
    setText(t, txt.slice(0, off) + text + txt.slice(off));
    return;
  }
  // Teks berisi baris baru/tab: pecah w:t jadi [sebelum][...sisipan...][sesudah]
  // di dalam run yang sama.
  setText(t, txt.slice(0, off));
  let cursor: Node = t;
  const tail = txt.slice(off);
  const nodes = nodesForText(xml, text);
  if (tail) {
    const tt = xml.createElementNS(W_NS, "w:t");
    setText(tt, tail);
    nodes.push(tt);
  }
  for (const n of nodes) { cursor.parentNode!.insertBefore(n, cursor.nextSibling); cursor = n; }
}

/**
 * Terapkan teks baru ke satu <w:p>. Perubahan dihitung dengan diff karakter
 * sehingga teks yang tidak berubah (dan run/format-nya) tetap persis sama.
 */
export function applyParagraphEdit(xml: XMLDocument, p: Element, oldText: string, newText: string) {
  if (oldText === newText) return;
  const current = normChars(paragraphText(p));
  // Offset diff dihitung terhadap teks yang dibaca dari XML. Kalau teks
  // render (oldText) sedikit berbeda dari XML (mis. spasi), pakai XML sbg dasar.
  const base = current === normChars(oldText) ? oldText : current;
  const ops: { pos: number; del: number; ins: string }[] = [];
  let pos = 0;
  for (const part of diffChars(normChars(base), newText)) {
    if (part.added) ops.push({ pos, del: 0, ins: part.value });
    else if (part.removed) { ops.push({ pos, del: part.value.length, ins: "" }); pos += part.value.length; }
    else pos += part.value.length;
  }
  // Gabungkan hapus+sisip yang bersebelahan (penggantian kata) supaya sisipan
  // mewarisi format teks yang diganti.
  const merged: typeof ops = [];
  for (const op of ops) {
    const last = merged[merged.length - 1];
    if (last && last.ins === "" && op.del === 0 && op.pos === last.pos + last.del) {
      last.ins = op.ins;
    } else merged.push({ ...op });
  }
  for (const op of merged.reverse()) {
    if (op.del) deleteRange(p, op.pos, op.pos + op.del);
    if (op.ins) {
      // Setelah deleteRange, sisipkan di awal rentang yang dihapus. Kalau
      // seluruh w:t di rentang itu habis, insertAt akan mencari run tetangga.
      insertAt(xml, p, op.pos, op.ins);
    }
  }
}

export interface DocxEdit { index: number; oldText: string; newText: string }

/** Hasilkan berkas .docx baru (Blob) dari model + daftar editan paragraf. */
export async function buildEditedDocx(model: DocxModel, edits: DocxEdit[]): Promise<Blob> {
  for (const e of edits) {
    const p = model.paragraphs[e.index];
    if (p) applyParagraphEdit(model.xml, p, e.oldText, e.newText);
  }
  const serialized = new XMLSerializer().serializeToString(model.xml);
  model.zip.file("word/document.xml", serialized.startsWith("<?xml") ? serialized : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${serialized}`);
  return model.zip.generateAsync({
    type: "blob",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    compression: "DEFLATE",
  });
}


// ---------------------------------------------------------------------------
// Editor lengkap: format karakter, perataan, paragraf baru/hapus, baris tabel
// ---------------------------------------------------------------------------

// Urutan anak w:rPr / w:pPr sesuai skema OOXML — Word menolak/merusak berkas
// bila urutannya salah, jadi elemen baru disisipkan di posisi yang benar.
const RPR_ORDER = ["rStyle", "rFonts", "b", "bCs", "i", "iCs", "caps", "smallCaps", "strike", "dstrike", "outline", "shadow", "emboss", "imprint", "noProof", "snapToGrid", "vanish", "webHidden", "color", "spacing", "w", "kern", "position", "sz", "szCs", "highlight", "u", "effect", "bdr", "shd", "fitText", "vertAlign", "rtl", "cs", "em", "lang", "eastAsianLayout", "specVanish", "oMath"];
const PPR_ORDER = ["pStyle", "keepNext", "keepLines", "pageBreakBefore", "framePr", "widowControl", "numPr", "suppressLineNumbers", "pBdr", "shd", "tabs", "suppressAutoHyphens", "kinsoku", "wordWrap", "overflowPunct", "topLinePunct", "autoSpaceDE", "autoSpaceDN", "bidi", "adjustRightInd", "snapToGrid", "spacing", "ind", "contextualSpacing", "mirrorIndents", "suppressOverlap", "jc", "textDirection", "textAlignment", "textboxTightWrap", "outlineLvl", "divId", "cnfStyle", "rPr", "sectPr", "pPrChange"];

function childW(el: Element, local: string): Element | undefined {
  return Array.from(el.children).find((c) => isW(c, local));
}

function setOrderedChild(xml: XMLDocument, parent: Element, local: string, order: string[], val?: string): Element {
  let el = childW(parent, local);
  if (!el) {
    el = xml.createElementNS(W_NS, `w:${local}`);
    const idx = order.indexOf(local);
    const before = Array.from(parent.children).find((c) => c.namespaceURI === W_NS && order.indexOf(c.localName) > idx);
    parent.insertBefore(el, before || null);
  }
  if (val === undefined) el.removeAttributeNS(W_NS, "val");
  else el.setAttributeNS(W_NS, "w:val", val);
  return el;
}

function ensureRPr(xml: XMLDocument, run: Element): Element {
  let rPr = childW(run, "rPr");
  if (!rPr) {
    rPr = xml.createElementNS(W_NS, "w:rPr");
    run.insertBefore(rPr, run.firstChild);
  }
  return rPr;
}
function ensurePPr(xml: XMLDocument, p: Element): Element {
  let pPr = childW(p, "pPr");
  if (!pPr) {
    pPr = xml.createElementNS(W_NS, "w:pPr");
    p.insertBefore(pPr, p.firstChild);
  }
  return pPr;
}

function runOf(el: Element): Element | null {
  const r = el.parentElement;
  return r && isW(r, "r") ? r : null;
}

/** Pastikan ada batas run tepat di posisi pos (pecah w:t / w:r bila perlu). */
function splitRunAt(xml: XMLDocument, p: Element, pos: number) {
  let segs = segmentsOf(p);
  const inside = segs.find((s) => s.kind === "t" && pos > s.start && pos < s.start + s.len);
  if (inside) {
    const txt = inside.el.textContent || "";
    const off = pos - inside.start;
    setText(inside.el, txt.slice(0, off));
    const t2 = xml.createElementNS(W_NS, "w:t");
    setText(t2, txt.slice(off));
    inside.el.parentNode!.insertBefore(t2, inside.el.nextSibling);
    segs = segmentsOf(p);
  }
  const at = segs.find((s) => s.start === pos);
  if (!at) return;
  const run = runOf(at.el);
  if (!run) return;
  const hasContentBefore = (() => {
    for (let c = at.el.previousElementSibling; c; c = c.previousElementSibling) if (!isW(c, "rPr")) return true;
    return false;
  })();
  if (!hasContentBefore) return;
  const r2 = xml.createElementNS(W_NS, "w:r");
  const rPr = childW(run, "rPr");
  if (rPr) r2.appendChild(rPr.cloneNode(true));
  let c: Element | null = at.el;
  while (c) { const next: Element | null = c.nextElementSibling; r2.appendChild(c); c = next; }
  run.parentNode!.insertBefore(r2, run.nextSibling);
}

/** Set tebal/miring/garis bawah eksplisit pada rentang [s, e) paragraf. */
export function setRangeFormat(xml: XMLDocument, p: Element, s: number, e: number, attr: number, mask: number) {
  if (e <= s || !mask) return;
  splitRunAt(xml, p, s);
  splitRunAt(xml, p, e);
  const runs = new Set<Element>();
  for (const seg of segmentsOf(p)) {
    if (seg.start >= s && seg.start + seg.len <= e) { const r = runOf(seg.el); if (r) runs.add(r); }
  }
  for (const r of runs) {
    const rPr = ensureRPr(xml, r);
    if (mask & ATTR_B) { const v = attr & ATTR_B ? undefined : "0"; setOrderedChild(xml, rPr, "b", RPR_ORDER, v); setOrderedChild(xml, rPr, "bCs", RPR_ORDER, v); }
    if (mask & ATTR_I) { const v = attr & ATTR_I ? undefined : "0"; setOrderedChild(xml, rPr, "i", RPR_ORDER, v); setOrderedChild(xml, rPr, "iCs", RPR_ORDER, v); }
    if (mask & ATTR_U) setOrderedChild(xml, rPr, "u", RPR_ORDER, attr & ATTR_U ? "single" : "none");
  }
}

const JC: Record<string, string> = { left: "left", center: "center", right: "right", justify: "both" };
export function setParagraphAlign(xml: XMLDocument, p: Element, align: string) {
  const v = JC[align];
  if (!v) return;
  setOrderedChild(xml, ensurePPr(xml, p), "jc", PPR_ORDER, v);
}

/**
 * Terapkan format karakter: bandingkan atribut lama vs baru, dengan
 * penyelarasan teks lama->baru lewat diff. Hanya karakter yang atributnya
 * BERUBAH (atau karakter sisipan yang atributnya beda dari tempat sisipnya)
 * yang diberi format eksplisit — sisanya tidak disentuh.
 */
function applyAttrChanges(xml: XMLDocument, p: Element, oldText: string, newText: string, oldAttrs: number[], newAttrs: number[]) {
  const want: (number | null)[] = new Array(newText.length).fill(null); // null = biarkan
  let io = 0, inew = 0;
  for (const part of diffChars(oldText, newText)) {
    const n = part.value.length;
    if (part.removed) { io += n; continue; }
    if (part.added) {
      const inherit = io > 0 ? oldAttrs[io - 1] ?? 0 : oldAttrs[0] ?? 0;
      for (let k = 0; k < n; k++) if ((newAttrs[inew + k] ?? inherit) !== inherit) want[inew + k] = newAttrs[inew + k];
      inew += n;
      continue;
    }
    for (let k = 0; k < n; k++) if ((newAttrs[inew + k] ?? 0) !== (oldAttrs[io + k] ?? 0)) want[inew + k] = newAttrs[inew + k];
    io += n; inew += n;
  }
  // Kelompokkan jadi rentang berurutan dgn nilai sama; mask = bit yang beda.
  let k = 0;
  while (k < want.length) {
    if (want[k] === null) { k++; continue; }
    const v = want[k]!;
    let e = k + 1;
    while (e < want.length && want[e] === v) e++;
    setRangeFormat(xml, p, k, e, v, ATTR_B | ATTR_I | ATTR_U);
    k = e;
  }
}

function paragraphIsRemovable(p: Element): boolean {
  if (p.getElementsByTagNameNS(W_NS, "sectPr").length) return false;
  for (const tag of ["drawing", "pict", "object", "fldChar", "fldSimple"]) if (p.getElementsByTagNameNS(W_NS, tag).length) return false;
  const parent = p.parentElement;
  if (parent && isW(parent, "tc")) {
    const ps = Array.from(parent.children).filter((c) => isW(c, "p"));
    if (ps.length <= 1) return false; // sel tabel wajib punya minimal 1 paragraf
  }
  return true;
}

/** Paragraf baru berdasarkan paragraf acuan (gaya paragraf & format run). */
function makeParagraph(xml: XMLDocument, anchor: Element, text: string, attrs: number[], baseAttr: number, align?: string): Element {
  const p = xml.createElementNS(W_NS, "w:p");
  const aPPr = childW(anchor, "pPr");
  if (aPPr) {
    const pPr = aPPr.cloneNode(true) as Element;
    const sect = childW(pPr, "sectPr");
    if (sect) pPr.removeChild(sect); // section break hanya milik paragraf asal
    p.appendChild(pPr);
  }
  // Format run diambil dari run berteks terakhir paragraf acuan.
  const textRuns = Array.from(anchor.getElementsByTagNameNS(W_NS, "r")).filter((r) => r.getElementsByTagNameNS(W_NS, "t").length);
  const baseRun = textRuns[textRuns.length - 1];
  const r = xml.createElementNS(W_NS, "w:r");
  const rPr = baseRun ? childW(baseRun, "rPr") : (aPPr ? childW(aPPr, "rPr") : undefined);
  if (rPr) r.appendChild(rPr.cloneNode(true));
  for (const n of nodesForText(xml, text)) r.appendChild(n);
  if (!text) { const t = xml.createElementNS(W_NS, "w:t"); setText(t, ""); r.appendChild(t); }
  p.appendChild(r);
  if (align) setParagraphAlign(xml, p, align);
  // Karakter yang formatnya beda dari format dasar diberi format eksplisit.
  let k = 0;
  while (k < attrs.length) {
    if (attrs[k] === baseAttr) { k++; continue; }
    const v = attrs[k];
    let e = k + 1;
    while (e < attrs.length && attrs[e] === v) e++;
    setRangeFormat(xml, p, k, e, v, ATTR_B | ATTR_I | ATTR_U);
    k = e;
  }
  return p;
}

export interface EditedParagraph { index: number; oldText: string; newText: string; oldAttrs: number[]; newAttrs: number[]; oldAlign: string; newAlign: string }
export interface NewParagraph { text: string; attrs: number[]; align?: string }
export interface DocxEditPlan {
  edits: EditedParagraph[];
  deleted: number[];
  /** Paragraf baru; afterIndex -1 = sebelum paragraf terikat pertama. */
  inserts: { afterIndex: number; anchorIndex: number; baseAttr: number; paragraphs: NewParagraph[] }[];
}

/** Terapkan rencana edit ke model (in-place). Elemen w:p lama tetap sama. */
export function applyPlan(model: DocxModel, plan: DocxEditPlan) {
  const { xml, paragraphs } = model;
  for (const e of plan.edits) {
    const p = paragraphs[e.index];
    if (!p) continue;
    applyParagraphEdit(xml, p, e.oldText, e.newText);
    applyAttrChanges(xml, p, e.oldText, e.newText, e.oldAttrs, e.newAttrs);
    if (e.newAlign && e.newAlign !== e.oldAlign) setParagraphAlign(xml, p, e.newAlign);
  }
  for (const ins of plan.inserts) {
    const anchor = paragraphs[ins.anchorIndex];
    if (!anchor) continue;
    if (ins.afterIndex === -1) {
      for (const np of ins.paragraphs) anchor.parentNode!.insertBefore(makeParagraph(xml, anchor, np.text, np.attrs, ins.baseAttr, np.align), anchor);
    } else {
      let cursor: Element = paragraphs[ins.afterIndex];
      for (const np of ins.paragraphs) {
        const el = makeParagraph(xml, anchor, np.text, np.attrs, ins.baseAttr, np.align);
        cursor.parentNode!.insertBefore(el, cursor.nextSibling);
        cursor = el;
      }
    }
  }
  for (const idx of plan.deleted) {
    const p = paragraphs[idx];
    if (!p || !p.parentNode) continue;
    if (paragraphIsRemovable(p)) p.parentNode.removeChild(p);
    else applyParagraphEdit(xml, p, paragraphText(p), "");
  }
}

export async function serializeDocx(model: DocxModel): Promise<ArrayBuffer> {
  const serialized = new XMLSerializer().serializeToString(model.xml);
  model.zip.file("word/document.xml", serialized.startsWith("<?xml") ? serialized : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${serialized}`);
  return model.zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
}

function rowOf(p: Element): Element | null {
  for (let c = p.parentElement; c; c = c.parentElement) if (isW(c, "tr")) return c;
  return null;
}

/** Tambah baris tabel (salinan kosong baris milik paragraf p) di bawahnya. */
export function addTableRowAfter(p: Element | undefined): boolean {
  const tr = p && rowOf(p);
  if (!tr) return false;
  const clone = tr.cloneNode(true) as Element;
  for (const tc of Array.from(clone.getElementsByTagNameNS(W_NS, "tc"))) {
    const ps = Array.from(tc.children).filter((c) => isW(c, "p"));
    ps.slice(1).forEach((x) => tc.removeChild(x));
    const first = ps[0];
    if (first) {
      for (const t of Array.from(first.getElementsByTagNameNS(W_NS, "t"))) setText(t, "");
      for (const tag of ["br", "tab", "drawing", "pict"]) for (const x of Array.from(first.getElementsByTagNameNS(W_NS, tag))) x.parentNode?.removeChild(x);
    }
  }
  tr.parentNode!.insertBefore(clone, tr.nextSibling);
  return true;
}

export function removeTableRow(p: Element | undefined): boolean {
  const tr = p && rowOf(p);
  if (!tr) return false;
  const rows = Array.from(tr.parentElement!.children).filter((c) => isW(c, "tr"));
  if (rows.length <= 1) return false;
  tr.parentNode!.removeChild(tr);
  return true;
}

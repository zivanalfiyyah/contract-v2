import { GoogleGenAI } from "@google/genai";

// Extracted from server.ts (mechanical move, no behavior change) so modules
// under dcs/ can use the same Gemini client + JSON-repair helper without a
// circular import — server.ts already imports dcs/routes.ts, so dcs/routes.ts
// cannot import back from server.ts.
export const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      "User-Agent": "aistudio-build",
    },
  },
});

// Same "is this real" check every AI endpoint uses to report an honest 503
// instead of letting the Gemini SDK fail with an opaque auth error partway
// through a request, or (worse) silently returning garbage.
export function isGeminiConfigured(): boolean {
  return !!process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== "MY_GEMINI_API_KEY";
}

// Gemini's JSON mode (responseMimeType: "application/json") strongly biases
// the model toward valid JSON but doesn't guarantee it byte-for-byte. Two
// failure modes confirmed live against real responses: a literal (unescaped)
// newline inside a multi-paragraph clause, and an unescaped `"` inside legal
// text quoting a defined term (e.g. "Informasi Rahasia") — both are exactly
// the kind of thing Indonesian legal drafting produces constantly. Repairs
// both classes and strips a ```json fence if one slipped through, instead of
// every AI endpoint needing its own recovery logic.
/**
 * Potong teks menjadi objek/array JSON PERTAMA yang kurung bukanya tertutup
 * seimbang, mengabaikan kurung yang berada di dalam string.
 *
 * Modelnya kadang menambahkan sesuatu SESUDAH objek JSON (kalimat penutup,
 * atau objek kedua). JSON.parse menolak seluruh balasan karena itu — padahal
 * objek pertamanya sudah benar dan itulah yang kita mau. Ditemukan nyata saat
 * impor massal: "Unexpected non-whitespace character after JSON at position 642".
 */
function sliceFirstJsonValue(s: string): string | null {
  const mulai = s.search(/[{[]/);
  if (mulai < 0) return null;
  const buka = s[mulai];
  const tutup = buka === "{" ? "}" : "]";
  let depth = 0, inString = false, escaped = false;
  for (let i = mulai; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === buka) depth++;
    else if (ch === tutup) { depth--; if (depth === 0) return s.slice(mulai, i + 1); }
  }
  return null; // tidak pernah tertutup — biarkan pemanggil mencoba perbaikan lain
}

export function parseAiJson(text: string | undefined): any {
  const raw = (text || "{}").trim();
  const unfenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] ?? raw;
  try {
    return JSON.parse(unfenced);
  } catch {
    // Sebelum menjalankan perbaikan tanda petik (yang menebak-nebak), coba dulu
    // kemungkinan yang paling jinak: objeknya sendiri sudah sah, hanya ada
    // sampah di belakangnya.
    const potongan = sliceFirstJsonValue(unfenced);
    if (potongan) {
      try { return JSON.parse(potongan); } catch { /* lanjut ke perbaikan di bawah */ }
    }
    return repairAndParse(potongan || unfenced, unfenced);
  }
}

/**
 * Perbaikan heuristik untuk balasan yang tanda petik di dalam nilainya tidak
 * di-escape. `cadangan` dicoba bila perbaikan atas `utama` tetap gagal —
 * pemotongan objek pertama bisa saja salah tebak ketika kurungnya sendiri
 * berantakan.
 */
function repairAndParse(utama: string, cadangan: string): any {
  const coba = (unfenced: string) => {
    let repaired = "";
    let inString = false;
    let escaped = false;
    for (let i = 0; i < unfenced.length; i++) {
      const ch = unfenced[i];
      if (inString) {
        if (escaped) { repaired += ch; escaped = false; continue; }
        if (ch === "\\") { repaired += ch; escaped = true; continue; }
        if (ch === '"') {
          // A quote inside a string is only a real closing quote if what
          // follows (skipping whitespace) is a JSON structural character —
          // otherwise it's a literal quote the model forgot to escape.
          let j = i + 1;
          while (j < unfenced.length && /\s/.test(unfenced[j])) j++;
          const next = unfenced[j];
          let looksLikeRealClose = next === undefined || [",", "}", "]", ":"].includes(next);
          // Comma alone is too weak a signal: Indonesian legal drafting is full
          // of `disebut "PIHAK PERTAMA", kemudian ...` — a literal quoted term
          // followed by a comma, mid-sentence. Treating that as a closing quote
          // ends the string early and breaks the whole document (OCR then
          // silently degrades to placeholder text). After a REAL value-closing
          // comma the next thing must be another key or a nested value, so
          // look one step further and only close on that.
          if (looksLikeRealClose && next === ",") {
            let k = j + 1;
            while (k < unfenced.length && /\s/.test(unfenced[k])) k++;
            const afterComma = unfenced[k];
            looksLikeRealClose = afterComma === undefined || ['"', "{", "["].includes(afterComma);
          }
          if (looksLikeRealClose) { inString = false; repaired += ch; }
          else repaired += '\\"';
          continue;
        }
        if (ch === "\n") { repaired += "\\n"; continue; }
        if (ch === "\r") { repaired += "\\r"; continue; }
        if (ch === "\t") { repaired += "\\t"; continue; }
        repaired += ch;
      } else {
        if (ch === '"') inString = true;
        repaired += ch;
      }
    }
    return JSON.parse(repaired);
  };
  try {
    return coba(utama);
  } catch (err) {
    if (cadangan !== utama) {
      try { return coba(cadangan); } catch { /* pakai error pertama, lebih relevan */ }
    }
    throw err;
  }
}

// Same classification every AI endpoint uses so upstream congestion (Google
// overloaded / quota exhausted / connection dropped) reports as an honest
// retry-later message instead of a generic 500 that looks like a system bug.
export function aiErrorResponse(res: { status: (n: number) => { json: (b: unknown) => unknown } }, err: any, fallback: string) {
  const msg = String(err?.message || "");
  if (msg.includes("UNAVAILABLE") || msg.includes("high demand") || msg.includes("overloaded")) {
    return res.status(503).json({ error: "Layanan AI Google sedang sibuk (bukan error sistem). Coba lagi beberapa saat lagi." });
  }
  if (msg.includes("RESOURCE_EXHAUSTED") || msg.includes("quota")) {
    return res.status(429).json({ error: "Kuota API Gemini habis untuk saat ini. Coba lagi nanti atau periksa kuota di Google AI Studio." });
  }
  if (msg.includes("ECONNRESET") || msg.includes("fetch failed") || msg.includes("ETIMEDOUT")) {
    return res.status(502).json({ error: "Koneksi ke layanan AI terputus. Periksa jaringan lalu coba lagi." });
  }
  return res.status(500).json({ error: fallback });
}

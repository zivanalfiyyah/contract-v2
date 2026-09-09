// Mesin token nomor dokumen bersama — dipakai oleh modul DCS (dcs/numbering.ts,
// via tabel dcs_numbering_rules + reservasi atomik) dan modul Kontrak
// (server.ts, via hitung-scan-existing yang lebih sederhana). Hanya logika
// substitusi token murni yang dibagi di sini; masing-masing modul tetap
// mengelola strategi penyimpanan/penguncian sequence-nya sendiri.

const SEQUENCE_RE = /\{Sequence(?::(\d+))?\}/;
const TOKEN_RE = /\{(\w+)(?::\d+)?\}/g;

export { SEQUENCE_RE, TOKEN_RE };

export type MaskTokens = { [key: string]: string | number | undefined };

const ROMAN_MONTHS = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];
/** Bulan (1..12) → angka romawi (I..XII), gaya penomoran surat Indonesia. */
export function romanMonth(m: number): string {
  return ROMAN_MONTHS[(Number(m) || 1) - 1] || "I";
}

/**
 * Renders the final control number. {Sequence:4} → zero-padded; {MonthRoman}
 * emits a Roman-numeral month. Unknown tokens throw rather than silently emit
 * an empty segment. A token that resolves to an EMPTY string (e.g. optional
 * {Codes}) is dropped and any resulting doubled/leading/trailing separator is
 * collapsed, so "001/PKS//VII/2026" becomes "001/PKS/VII/2026".
 */
export function renderMask(mask: string, tokens: MaskTokens, sequence: number): string {
  let out = mask.replace(SEQUENCE_RE, (_m, pad?: string) =>
    pad ? String(sequence).padStart(Number(pad), "0") : String(sequence),
  );
  let sawEmpty = false;
  out = out.replace(TOKEN_RE, (_m, name: string) => {
    if (name === "MonthRoman") {
      return romanMonth(Number(tokens.Month ?? tokens.MonthRoman));
    }
    const v = tokens[name];
    if (v === undefined || v === null) {
      throw new Error(`Mask token "{${name}}" has no value in the numbering context`);
    }
    const s = String(v);
    if (s === "") sawEmpty = true;
    return s;
  });
  // Rapikan hanya bila ada token yang kosong — jangan sentuh mask yang memang
  // memakai pemisah dobel secara sengaja tanpa token kosong.
  if (sawEmpty) {
    out = out
      .replace(/([\/.\-_])\1+/g, "$1") // pemisah berulang → satu
      .replace(/^[\/.\-_]+|[\/.\-_]+$/g, ""); // buang pemisah di ujung
  }
  return out;
}

// Kata umum yang tidak membawa arti pembeda di nama jenis dokumen — dibuang
// saat menyusun singkatan supaya "Perjanjian Kerja Sama" → PKS, bukan PKSA.
const CODE_STOPWORDS = new Set(["dan", "atau", "untuk", "yang", "dengan", "the", "of", "and", "for"]);

/**
 * Menyarankan kode singkat dari NAMA jenis dokumen, dipakai ketika kolom "Kode"
 * dibiarkan kosong. Tanpa ini semua jenis tanpa kode memakai prefix default
 * yang sama (mis. GA-AGR), sehingga dua jenis berbeda bisa menghasilkan nomor
 * yang TERLIHAT identik — masalah nyata untuk dokumen legal, walau counter-nya
 * sebenarnya terpisah.
 *
 * Aturan: kalau di dalam nama sudah ada singkatan huruf besar (PKWT, NDA, MOU),
 * pakai itu apa adanya. Kalau tidak, ambil huruf awal tiap kata bermakna
 * (maks. 4). Hasil selalu huruf besar, hanya A-Z0-9.
 */
export function suggestDocTypeCode(name: string): string {
  const raw = String(name || "").trim();
  if (!raw) return "";
  const words = raw.split(/[^A-Za-z0-9]+/).filter(Boolean);
  // 1) Singkatan yang sudah ditulis kapital penuh di nama aslinya.
  const acronym = words.find((w) => w.length >= 2 && w.length <= 6 && w === w.toUpperCase() && /[A-Z]/.test(w));
  if (acronym) return acronym.replace(/[^A-Z0-9]/g, "");
  // 2) Huruf awal tiap kata bermakna.
  const meaningful = words.filter((w) => !CODE_STOPWORDS.has(w.toLowerCase()));
  const initials = (meaningful.length ? meaningful : words)
    .slice(0, 4)
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  // 3) Nama satu kata pendek ("Perjanjian") → potong 3 huruf, lebih terbaca
  //    daripada satu huruf "P".
  if (initials.length <= 1) return raw.replace(/[^A-Za-z0-9]/g, "").slice(0, 3).toUpperCase();
  return initials;
}

/**
 * Validasi mask sebelum disimpan: wajib ada {Sequence...}, dan setiap token
 * lain yang dipakai harus termasuk daftar token yang diizinkan pemanggil.
 * Mengembalikan pesan error (string) jika tidak valid, atau null jika valid.
 */
export function validateMask(mask: string, allowedTokenNames: string[]): string | null {
  if (!mask || !mask.trim()) return "Format nomor tidak boleh kosong.";
  if (!SEQUENCE_RE.test(mask)) return "Format nomor wajib memuat token {Sequence} atau {Sequence:N}.";
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  const re = new RegExp(TOKEN_RE);
  while ((match = re.exec(mask)) !== null) {
    seen.add(match[1]);
  }
  for (const name of seen) {
    if (name === "Sequence") continue;
    if (!allowedTokenNames.includes(name)) {
      return `Token "{${name}}" tidak dikenal. Token yang tersedia: ${allowedTokenNames.map((t) => `{${t}}`).join(", ")}, {Sequence}.`;
    }
  }
  return null;
}

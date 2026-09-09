import crypto from "crypto";

// ---------------------------------------------------------------------------
// TOTP (RFC 6238) untuk 2FA login — ditulis manual dengan crypto bawaan Node,
// TANPA dependency npm tambahan untuk bagian keamanan intinya. Ini bagian
// yang paling sensitif di seluruh fitur 2FA (kalau salah, autentikasi
// keliru menerima/menolak kode), jadi sengaja dibuat sekecil dan setransparan
// mungkin untuk diaudit, bukan diimpor sebagai kotak hitam dari luar.
//
// Hanya rendering QR code (murni visual, bukan kriptografi) yang memakai
// library `qrcode` — dan itu pun 100% lokal, base32 secret TIDAK PERNAH
// dikirim ke layanan pihak ketiga mana pun (beda dari trik lama "tempel ke
// Google Chart API" yang membocorkan secret 2FA lewat URL eksternal).
// ---------------------------------------------------------------------------

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Encode buffer -> string Base32 (RFC 4648), tanpa padding — format standar secret TOTP. */
export function base32Encode(buf: Buffer): string {
  let bits = "";
  for (const byte of buf) bits += byte.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5).padEnd(5, "0");
    out += BASE32_ALPHABET[parseInt(chunk, 2)];
  }
  return out;
}

/** Decode string Base32 -> Buffer. Menerima huruf kecil & spasi (user sering salin-tempel begitu). */
export function base32Decode(str: string): Buffer {
  const clean = str.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) continue;
    bits += idx.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** Secret baru, 20 byte (160 bit) — panjang standar RFC 4226/6238. */
export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

/**
 * Hitung kode TOTP 6-digit untuk satu time-step tertentu (RFC 6238 §4).
 * HMAC-SHA1 atas counter waktu, lalu "dynamic truncation" (RFC 4226 §5.3) —
 * ambil 4 byte mulai dari offset yang ditentukan oleh nibble terakhir hash,
 * buang bit paling signifikan, modulo 10^6.
 */
export function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", secret).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, "0");
}

const STEP_SECONDS = 30;

/**
 * Verifikasi kode 6-digit yang dimasukkan user. Toleransi ±1 time-step (30
 * detik) untuk jam HP yang sedikit meleset atau jeda ketik — standar praktik
 * semua implementasi TOTP (Google Authenticator dkk melakukan hal sama).
 * Window LEBIH LEBAR dari ±1 sengaja tidak dipakai: itu melemahkan keamanan
 * (kode lama jadi lebih lama valid = lebih mudah ditebak/diputar ulang).
 */
export function verifyTotp(secretBase32: string, code: string, atMs = Date.now()): boolean {
  const cleaned = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(cleaned)) return false;
  const secret = base32Decode(secretBase32);
  if (secret.length === 0) return false;
  const counter = Math.floor(atMs / 1000 / STEP_SECONDS);
  for (const drift of [0, -1, 1]) {
    if (hotp(secret, counter + drift) === cleaned) return true;
  }
  return false;
}

/** otpauth:// URI standar — dibaca semua authenticator app (Google/Microsoft Authenticator, Authy, dst) via scan QR ATAU entry manual. */
export function totpAuthUrl(secretBase32: string, accountLabel: string, issuer = "Smart CLM"): string {
  const label = encodeURIComponent(`${issuer}:${accountLabel}`);
  const params = new URLSearchParams({ secret: secretBase32, issuer, algorithm: "SHA1", digits: "6", period: "30" });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// --- Kode cadangan (backup codes) ---------------------------------------
// Untuk saat HP hilang/authenticator app tak terpasang. Disimpan HANYA
// sebagai hash (pola sama seperti password) — kode mentahnya cuma pernah
// ditampilkan SEKALI ke user saat 2FA diaktifkan, tidak pernah disimpan
// mentah di server maupun database.
export function generateBackupCodes(count = 8): string[] {
  return Array.from({ length: count }, () =>
    crypto.randomBytes(5).toString("hex").toUpperCase().match(/.{1,5}/g)!.join("-"),
  );
}
export function hashBackupCode(code: string): string {
  return crypto.createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

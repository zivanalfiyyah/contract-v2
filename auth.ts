import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import dotenv from "dotenv";
import type { Request, Response, NextFunction } from "express";
import { loadDB } from "./db.js";
import { logger } from "./logger.js";
import type { User, SafeUser, UserRole } from "./src/types";

// ES module imports execute before the importing module's own top-level code
// (server.ts's `dotenv.config()` runs too late for this file), so this must
// load its own .env — otherwise process.env.JWT_SECRET always reads as unset
// here even when a real one is configured.
dotenv.config();

// JWT signing secret. A known fallback secret would let anyone forge a valid
// login session for any user, so production must set a real one — refuse to
// boot rather than silently run insecure. Local development still gets an
// obvious, working fallback so `npm run dev` isn't blocked on this.
const JWT_SECRET = process.env.JWT_SECRET || "dev-only-insecure-secret-change-me";
const TOKEN_TTL = "12h";
// "Ingat saya" pada login: sesi normal berakhir dalam 12 jam; dicentang, JWT
// & cookie-nya diperpanjang ke 30 hari alih-alih user harus login ulang tiap
// shift kerja. Defaultnya OFF (checkbox tidak dicentang) karena aplikasi ini
// menyimpan dokumen legal/kontrak sensitif — sesi panjang di komputer bersama
// adalah risiko nyata, jadi user harus secara eksplisit memintanya.
const TOKEN_TTL_REMEMBER = "30d";
const COOKIE_MAX_AGE = 12 * 60 * 60 * 1000;
const COOKIE_MAX_AGE_REMEMBER = 30 * 24 * 60 * 60 * 1000;
export const AUTH_COOKIE = "clm_token";

if (!process.env.JWT_SECRET) {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "[auth] JWT_SECRET is required in production. Generate one with: " +
        `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`,
    );
  }
  logger.warn("JWT_SECRET not set — using insecure dev fallback. Set JWT_SECRET before production.");
}

export function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, 10);
}
export function verifyPassword(plain: string, hash: string): boolean {
  return bcrypt.compareSync(plain, hash);
}

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 jam

// Token mentah dikirim via email & dipakai di URL reset — hanya hash-nya
// (SHA-256, bukan bcrypt: token sudah random+panjang jadi tidak butuh salt
// lambat, dan pencarian by-hash perlu deterministik) yang disimpan di DB,
// mirip pola JWT/password hashing lain di modul ini.
export function generateResetToken(): { rawToken: string; tokenHash: string; expiresAt: string } {
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
  return { rawToken, tokenHash, expiresAt };
}

export function hashResetToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

export function stripUser(u: User): SafeUser {
  const { passwordHash, resetTokenHash, resetTokenExpiresAt, totpSecret, totpBackupCodeHashes, ...safe } = u;
  return safe;
}

export function signToken(user: User, remember = false): string {
  return jwt.sign(
    { sub: user.id, tenantId: user.tenantId, role: user.role },
    JWT_SECRET,
    { expiresIn: remember ? TOKEN_TTL_REMEMBER : TOKEN_TTL },
  );
}

// Token SEMENTARA untuk langkah kedua login (2FA) — sengaja bukan token sesi
// penuh (tidak dipakai requireAuth, tidak jadi cookie). Umur pendek (5 menit)
// karena satu-satunya fungsinya adalah membuktikan "saya baru saja lolos
// email+password" ke endpoint verifikasi kode TOTP, bukan untuk mengakses
// data apa pun. `purpose` mencegah token sesi biasa disalahgunakan di sini
// atau sebaliknya.
const TOTP_CHALLENGE_TTL = "5m";
export function signTotpChallenge(user: User): string {
  return jwt.sign({ sub: user.id, purpose: "2fa-pending" }, JWT_SECRET, { expiresIn: TOTP_CHALLENGE_TTL });
}
export function verifyTotpChallenge(token: string): string | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { sub: string; purpose: string };
    return payload.purpose === "2fa-pending" ? payload.sub : null;
  } catch {
    return null;
  }
}

export function setAuthCookie(res: Response, token: string, remember = false) {
  res.cookie(AUTH_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: remember ? COOKIE_MAX_AGE_REMEMBER : COOKIE_MAX_AGE,
  });
}
export function clearAuthCookie(res: Response) {
  res.clearCookie(AUTH_COOKIE);
}

// Augment Express request with the resolved user.
export interface AuthedRequest extends Request {
  user?: SafeUser;
}

function resolveUser(req: Request): SafeUser | null {
  const token = (req as any).cookies?.[AUTH_COOKIE];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { sub: string };
    const db = loadDB();
    const user = (db.users as User[]).find((u) => u.id === payload.sub);
    if (!user || !user.active) return null;
    // Deactivating a tenant must cut off its members' access immediately,
    // not just block new logins — otherwise an already-open session keeps
    // working for as long as its 12h token stays valid.
    if (user.role !== "super_admin") {
      const tenant = (db.tenants as any[]).find((t) => t.id === user.tenantId);
      if (!tenant || !tenant.active) return null;
    }
    return stripUser(user);
  } catch {
    return null;
  }
}

// Blocks unauthenticated requests; attaches req.user on success.
export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const user = resolveUser(req);
  if (!user) return res.status(401).json({ error: "Sesi tidak valid atau kadaluarsa. Silakan login." });
  req.user = user;
  next();
}

// Restricts to specific roles (super_admin always allowed).
export function requireRole(...roles: UserRole[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: "Belum login" });
    if (req.user.role === "super_admin" || roles.includes(req.user.role)) return next();
    return res.status(403).json({ error: "Anda tidak memiliki izin untuk tindakan ini." });
  };
}

// The tenant a request operates within. super_admin may target another tenant
// via ?tenantId / body.tenantId; everyone else is locked to their own.
export function tenantOf(req: AuthedRequest): string {
  const u = req.user!;
  if (u.role === "super_admin") {
    const override = (req.query.tenantId as string) || req.body?.tenantId;
    if (override) return override;
  }
  return u.tenantId;
}

import express from "express";
import path from "path";
import fs from "fs";
import { randomBytes } from "crypto";
import dotenv from "dotenv";
import {
  Clause, Variable, Template, Contract, ContractVersion, ContractStatus,
  ContractApprovalStep, AuditTrail, SystemNotification, EmployeeData, VendorData, User, UserRole,
  ClauseComment, PushSubscription as PushSub, SubFolder, ContractSharingFeeItem, ContractVendorSnapshot,
  ContractPaymentTerm, ContractObligation, ContractVendorEvaluation, BudgetEntry
} from "./src/types";
import { loadDB, saveDB, initDB, DEFAULT_TENANT_ID, makeDefaultUsers } from "./db.js";
import { startReminderScheduler, runReminderCheck } from "./reminders.js";
import { startBackupScheduler, runBackup, listBackups } from "./backup.js";
import { isEmailConfigured, sendEmail, testEmailConnection, emailTemplate } from "./email.js";
import { isPushConfigured, sendPushToUser, sendPushToTenant } from "./push.js";
import { storeFile, fetchFile, isStorageCloudBacked } from "./storage.js";
import { sha256 } from "./dcs/pdf-io.js";
import { pool as dcsPool } from "./db.js";
import { createDcsRouter, initDcs } from "./dcs/routes.js";
import { runDcsReminderCheck, startDcsReminderScheduler } from "./dcs/reminders.js";
import { listDocTypes as listDcsDocTypes } from "./dcs/repo.js";
import {
  enableDcsExternalReview, disableDcsExternalReview, resolveDcsExternalReview,
  setDcsExternalReviewLock, addDcsExternalApproval, hasDcsExternalReviewToken,
  addReviewComment as addDcsReviewComment, listReviewComments as listDcsReviewComments,
  getComposeMetadata as getDcsComposeMetadata, getVersionReviewRound as getDcsVersionReviewRound,
  type ReviewCommentAnchor as DcsReviewCommentAnchor,
} from "./dcs/repo.js";
import { ai, isGeminiConfigured, parseAiJson, aiErrorResponse } from "./ai-client.js";
import { renderMask, validateMask, suggestDocTypeCode } from "./numbering-utils.js";
import {
  requireAuth, requireRole, tenantOf, AuthedRequest,
  hashPassword, verifyPassword, signToken, setAuthCookie, clearAuthCookie, stripUser,
  generateResetToken, hashResetToken, signTotpChallenge, verifyTotpChallenge,
} from "./auth.js";
import { generateTotpSecret, verifyTotp, totpAuthUrl, generateBackupCodes, hashBackupCode } from "./totp.js";
import QRCode from "qrcode";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import pinoHttp from "pino-http";
import { logger } from "./logger.js";

import multer from "multer";
import { PDFDocument, StandardFonts, rgb, degrees } from "pdf-lib";

dotenv.config();

export const app = express();
// Render (and most PaaS hosts) assign the port dynamically via $PORT and
// route external traffic to whatever the app actually binds to — hardcoding
// 3000 would make the health check fail on those platforms. Local dev keeps
// using 3000 since nothing sets PORT there.
const PORT = Number(process.env.PORT) || 3000;

// Structured request logging — one JSON (or pretty-printed, in dev) line per
// request with method/path/status/duration and a request id, so a
// production issue can be traced from logs alone. Auth/session cookies and
// passwords are redacted so they never end up in log output.
app.use(
  pinoHttp({
    logger,
    redact: {
      // req.headers.cookie: the caller's session token on every subsequent
      // request. res.headers["set-cookie"]: the freshly issued session
      // token on login — a full valid JWT (usable to impersonate that user
      // for up to 12h) written in plaintext until this was added.
      paths: [
        "req.headers.cookie",
        "req.headers.authorization",
        'res.headers["set-cookie"]',
        "req.body.password",
        "req.body.adminPassword",
        "req.body.newPassword",
      ],
      remove: true,
    },
    customLogLevel: (req, res, err) => {
      if (err || res.statusCode >= 500) return "error";
      if (res.statusCode >= 400) return "warn";
      return "info";
    },
    autoLogging: {
      ignore: (req) => req.url?.startsWith("/@") || req.url?.startsWith("/uploads/") || false, // skip Vite HMR/static asset noise
    },
  }),
);

// Security headers. CSP is left disabled: Vite's dev-mode React-refresh
// preamble relies on inline <script>/<style>, which a default CSP would block
// outright. Locking that down properly needs a nonce-based CSP refactor —
// tracked as a follow-up, not silently "solved" by a permissive policy here.
app.use(helmet({ contentSecurityPolicy: false }));

app.use(express.json({ limit: "8mb" })); // besar untuk payload kontrak berisi banyak pasal / OCR text
app.use(cookieParser());

// ---------------------------------------------------------------------------
// Jaring pengaman handler async.
//
// Express 4 TIDAK menangkap Promise yang reject dari handler `async` — errornya
// lolos jadi unhandledRejection, dan di bawah (baris ~4400) unhandledRejection
// memanggil process.exit(1). Akibatnya SATU request cacat bisa mematikan
// seluruh server untuk semua pengguna. Ini bukan skenario karangan: request
// ke /api/ai/compare-versions tanpa field oldVersion membuat `oldVersion.map`
// melempar di luar try, dan servernya benar-benar mati saat diuji.
//
// Dibungkus di sini secara terpusat, bukan menambal satu per satu ~150 rute:
// setiap handler async yang melempar diarahkan ke error middleware di akhir
// berkas (JSON 500), bukan membunuh proses. Harus dipasang SEBELUM rute mana
// pun didaftarkan.
// ---------------------------------------------------------------------------
const wrapAsyncHandler = (h: any) =>
  typeof h === "function" && h.length <= 3
    ? function wrapped(req: any, res: any, next: any) {
        try {
          const out = h(req, res, next);
          if (out && typeof out.then === "function") out.catch(next);
          return out;
        } catch (err) {
          next(err);
        }
      }
    : h;
for (const method of ["get", "post", "put", "patch", "delete", "all"] as const) {
  const original = (app as any)[method].bind(app);
  (app as any)[method] = (path: any, ...handlers: any[]) =>
    original(path, ...handlers.map(wrapAsyncHandler));
}

// Anti brute-force: login is the one endpoint an attacker can hammer without
// already having a valid session.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Terlalu banyak percobaan login. Coba lagi dalam beberapa menit." },
});

// General safety net across the whole API — generous enough for normal use
// (the dashboard alone fires ~9 parallel requests on load) while still
// capping abuse from a single client.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Terlalu banyak permintaan. Coba lagi dalam beberapa menit." },
});
app.use("/api/", apiLimiter);

// AI calls cost real money per request — cap them tighter than the general
// API limit so one compromised/misbehaving account can't run up the bill.
const aiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Terlalu banyak permintaan AI. Coba lagi dalam beberapa menit." },
});
app.use("/api/ai/", aiLimiter);

// Serve public/ folder untuk service worker dan assets statis lainnya
// (harus sebelum Vite middleware agar sw.js diakses di path root /)
const publicPath = path.join(process.cwd(), "public");
if (fs.existsSync(publicPath)) {
  app.use(express.static(publicPath, { index: false }));
}

// Helpers multi-tenant: kategori & pengaturan disimpan per tenant.
function catsFor(db: any, tid: string): string[] {
  return db.categoriesByTenant?.[tid] || ["General", "Vendor", "Employment", "NDA", "MOU", "Rental"];
}
function setCatsFor(db: any, tid: string, list: string[]) {
  db.categoriesByTenant = { ...(db.categoriesByTenant || {}), [tid]: list };
}
function rawSettingsFor(db: any, tid: string): any {
  return db.settingsByTenant?.[tid] || {};
}
function setSettingsFor(db: any, tid: string, obj: any) {
  db.settingsByTenant = { ...(db.settingsByTenant || {}), [tid]: obj };
}
// Filter koleksi ke tenant tertentu.
function scoped<T extends { tenantId?: string }>(arr: T[], tid: string): T[] {
  return (arr || []).filter((x) => x.tenantId === tid);
}
// ---------------------------------------------------------------------------
// DELEGASI PERSETUJUAN
//
// Tanpa ini satu approver yang cuti membuat dokumen mandek total — tidak ada
// jalur lain selain override admin, yang bukan jawaban untuk perusahaan yang
// tidak ingin admin ikut campur tiap kali orang berhalangan.
//
// Tiga aturan yang disengaja:
//  1. Delegasi SELALU punya rentang tanggal. Delegasi tanpa akhir sama dengan
//     memindahkan wewenang permanen tanpa disadari siapa pun.
//  2. Delegasi TIDAK berantai. Kalau si pengganti juga sedang mendelegasikan,
//     wewenangnya berhenti di dia — rantai delegasi membuat siapa yang
//     sebenarnya berwenang jadi mustahil ditelusuri saat diaudit.
//  3. Keputusan tetap dicatat atas nama approver ASLI, dengan penanda jelas
//     siapa yang menjalankannya sebagai pengganti.
// ---------------------------------------------------------------------------
/** Delegasi seorang user aktif hari ini? Kembalikan userId penggantinya. */
function activeDelegateIdOf(user: User | undefined, onDate?: string): string | null {
  if (!user || !user.delegateToId) return null;
  const hari = (onDate || new Date().toISOString()).slice(0, 10);
  const dari = (user.delegateFrom || "").slice(0, 10);
  const sampai = (user.delegateUntil || "").slice(0, 10);
  if (!dari || !sampai) return null; // rentang wajib — lihat aturan 1
  if (hari < dari || hari > sampai) return null;
  return user.delegateToId;
}
/** Boleh-kah `actorId` memutuskan atas nama `approverId` karena delegasi? */
function canActAsDelegate(db: any, tid: string, approverId: string, actorId: string): boolean {
  const approver = (db.users as User[]).find((u) => u.id === approverId && u.tenantId === tid);
  const delegateId = activeDelegateIdOf(approver);
  if (!delegateId || delegateId !== actorId) return false;
  const pengganti = (db.users as User[]).find((u) => u.id === actorId && u.tenantId === tid);
  return !!pengganti?.active; // pengganti nonaktif tidak mewarisi apa pun
}

// Catat audit trail memakai identitas & tenant pengguna yang sedang login.
function pushAudit(db: any, req: AuthedRequest, entry: any) {
  const u = req.user!;
  db.audits.unshift({
    id: "aud-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
    tenantId: tenantOf(req),
    userId: u.id, userName: u.name, userRole: u.role,
    timestamp: new Date().toISOString(),
    ipAddress: req.ip || "127.0.0.1",
    ...entry,
  });
}
// Notifikasi ter-scope tenant.
function pushNotif(db: any, tid: string, notif: any) {
  db.notifications.unshift({
    id: "not-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
    tenantId: tid, createdAt: new Date().toISOString(), read: false, ...notif,
  });
}

// ===== AUTHENTICATION =====
app.post("/api/auth/login", loginLimiter, (req, res) => {
  const db = loadDB();
  const { email, password, remember } = req.body;
  const user = (db.users as User[]).find(
    (u) => u.email.toLowerCase() === String(email || "").toLowerCase(),
  );
  if (!user || !user.active || !verifyPassword(password || "", user.passwordHash)) {
    return res.status(401).json({ error: "Email atau kata sandi salah." });
  }
  // super_admin operates across tenants, so it isn't gated by any single
  // tenant's active flag; every other role belongs to exactly one company.
  if (user.role !== "super_admin") {
    const tenant = (db.tenants as any[]).find((t) => t.id === user.tenantId);
    if (!tenant || !tenant.active) {
      return res.status(401).json({ error: "Akun perusahaan Anda sedang tidak aktif. Hubungi administrator sistem." });
    }
  }
  // 2FA aktif: JANGAN langsung buka sesi. Balas token tantangan berumur
  // pendek yang hanya berguna untuk langkah verifikasi kode — sesi penuh
  // (cookie) baru terbit setelah /api/auth/2fa/login-verify berhasil.
  if (user.totpEnabled && user.totpSecret) {
    return res.json({ success: true, requiresTotp: true, challengeToken: signTotpChallenge(user) });
  }
  user.lastLoginAt = new Date().toISOString();
  saveDB(db);
  setAuthCookie(res, signToken(user, !!remember), !!remember);
  res.json({ success: true, user: stripUser(user) });
});

// Langkah kedua login saat 2FA aktif: challengeToken (dari /login) + kode
// 6-digit ATAU salah satu kode cadangan. Dipisah dari loginLimiter endpoint
// /login karena percobaan brute-force di sini menebak KODE, bukan PASSWORD —
// tapi tetap perlu limiter sendiri (10 percobaan/15 menit, sama seperti
// login) supaya kode 6-digit tidak bisa ditebak paksa dalam waktu wajar.
app.post("/api/auth/2fa/login-verify", loginLimiter, (req, res) => {
  const db = loadDB();
  const { challengeToken, code, backupCode } = req.body;
  const uid = verifyTotpChallenge(String(challengeToken || ""));
  if (!uid) return res.status(401).json({ error: "Sesi verifikasi kadaluarsa. Silakan login ulang." });
  const user = (db.users as User[]).find((u) => u.id === uid);
  if (!user || !user.active || !user.totpEnabled || !user.totpSecret) {
    return res.status(401).json({ error: "Sesi verifikasi tidak valid. Silakan login ulang." });
  }

  let lolos = false;
  let backupTerpakai: string | null = null;
  if (backupCode) {
    const h = hashBackupCode(String(backupCode));
    if ((user.totpBackupCodeHashes || []).includes(h)) { lolos = true; backupTerpakai = h; }
  } else if (code) {
    lolos = verifyTotp(user.totpSecret, String(code));
  }
  if (!lolos) return res.status(401).json({ error: "Kode tidak valid atau sudah kedaluwarsa." });

  // Kode cadangan sekali pakai — dibuang begitu terpakai, kalau tidak
  // namanya bukan lagi "sekali pakai".
  if (backupTerpakai) {
    user.totpBackupCodeHashes = (user.totpBackupCodeHashes || []).filter((h) => h !== backupTerpakai);
  }
  user.lastLoginAt = new Date().toISOString();
  // pushAudit() butuh req.user asli (lewat requireAuth) — di titik ini sesi
  // belum terbentuk sama sekali, jadi dicatat manual dengan identitas user
  // yang baru saja terbukti sah lewat kode 2FA.
  db.audits.unshift({
    id: "aud-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
    tenantId: user.tenantId, userId: user.id, userName: user.name, userRole: user.role,
    timestamp: new Date().toISOString(), ipAddress: req.ip || "127.0.0.1",
    action: "Login dengan 2FA", details: backupTerpakai ? "Menggunakan kode cadangan (backup code)" : "Menggunakan kode aplikasi authenticator",
  });
  saveDB(db);
  // Baru DI SINI, setelah kode 2FA terbukti benar, sesi penuh benar-benar
  // terbit. Ini titik yang paling gampang lupa di seluruh alur 2FA — tanpa
  // baris ini kode terlihat benar (HTTP 200, success:true) tapi user tidak
  // pernah benar-benar bisa masuk, karena tidak ada cookie sesi yang terbit.
  setAuthCookie(res, signToken(user, false), false);
  res.json({ success: true, user: stripUser(user), backupCodeUsed: !!backupTerpakai, backupCodesRemaining: (user.totpBackupCodeHashes || []).length });
});

app.post("/api/auth/logout", (req, res) => {
  clearAuthCookie(res);
  res.json({ success: true });
});

// --- Pengaturan 2FA (dikelola user sendiri saat sudah login) --------------
// Setup dua langkah, sama seperti login: generate dulu (belum aktif), baru
// AKTIF setelah user membuktikan authenticator app-nya benar-benar
// tersinkron dengan memasukkan satu kode yang valid. Tanpa langkah konfirmasi
// ini, orang yang salah scan QR akan terkunci dari akunnya sendiri begitu
// totpEnabled otomatis true.
app.post("/api/auth/2fa/setup", requireAuth, async (req: AuthedRequest, res) => {
  const db = loadDB();
  const user = (db.users as User[]).find((u) => u.id === req.user!.id);
  if (!user) return res.status(404).json({ error: "User tidak ditemukan" });
  if (user.totpEnabled) return res.status(400).json({ error: "2FA sudah aktif. Matikan dulu sebelum mengatur ulang." });
  const secret = generateTotpSecret();
  // Disimpan tapi BELUM totpEnabled — hidup di sini sampai /confirm atau
  // sampai ditimpa oleh /setup berikutnya (mis. user mengulang scan QR).
  user.totpSecret = secret;
  saveDB(db);
  const otpauthUrl = totpAuthUrl(secret, user.email);
  // QR digenerate SEPENUHNYA lokal di server (library `qrcode`, tanpa
  // panggilan jaringan ke mana pun) — secret 2FA tidak pernah dikirim ke
  // layanan pihak ketiga mana pun untuk dijadikan gambar.
  const qrDataUrl = await QRCode.toDataURL(otpauthUrl, { width: 240, margin: 1 });
  res.json({ success: true, secret, otpauthUrl, qrDataUrl });
});

app.post("/api/auth/2fa/confirm", requireAuth, (req: AuthedRequest, res) => {
  const db = loadDB();
  const user = (db.users as User[]).find((u) => u.id === req.user!.id);
  if (!user) return res.status(404).json({ error: "User tidak ditemukan" });
  if (!user.totpSecret) return res.status(400).json({ error: "Belum ada setup 2FA yang berjalan. Mulai dari awal." });
  if (!verifyTotp(user.totpSecret, String(req.body.code || ""))) {
    return res.status(400).json({ error: "Kode tidak cocok. Pastikan jam di HP Anda akurat, lalu coba kode berikutnya." });
  }
  user.totpEnabled = true;
  const rawCodes = generateBackupCodes(8);
  user.totpBackupCodeHashes = rawCodes.map(hashBackupCode);
  pushAudit(db, req, { action: "Aktifkan 2FA", details: `${user.name} mengaktifkan verifikasi dua langkah (TOTP) pada akunnya.` });
  saveDB(db);
  // Kode cadangan MENTAH dikirim SEKALI di respons ini saja — tidak pernah
  // lagi bisa diambil ulang dari server sesudahnya (server hanya menyimpan
  // hash-nya, pola sama seperti password).
  res.json({ success: true, backupCodes: rawCodes });
});

app.post("/api/auth/2fa/disable", requireAuth, (req: AuthedRequest, res) => {
  const db = loadDB();
  const user = (db.users as User[]).find((u) => u.id === req.user!.id);
  if (!user) return res.status(404).json({ error: "User tidak ditemukan" });
  if (!user.totpEnabled) return res.status(400).json({ error: "2FA memang belum aktif." });
  // Mematikan 2FA WAJIB kode TOTP yang masih valid saat ini — bukan cuma
  // sesi login yang sedang jalan. Kalau tidak, sesi yang dibajak (mis. lupa
  // logout di komputer bersama) bisa mematikan 2FA korban tanpa tahu apa-apa
  // lagi tentang akun itu.
  if (!verifyTotp(user.totpSecret || "", String(req.body.code || ""))) {
    return res.status(400).json({ error: "Kode 2FA saat ini wajib dimasukkan untuk mematikan proteksi ini." });
  }
  user.totpEnabled = false;
  user.totpSecret = undefined;
  user.totpBackupCodeHashes = undefined;
  pushAudit(db, req, { action: "Matikan 2FA", details: `${user.name} menonaktifkan verifikasi dua langkah (TOTP) pada akunnya.` });
  saveDB(db);
  res.json({ success: true });
});

// Lupa password: minta tautan reset via email. Balasan SENGAJA sama persis
// baik email terdaftar maupun tidak (cegah enumerasi akun) — kecuali kalau
// SMTP memang belum dikonfigurasi sama sekali, di mana kita jujur bilang
// fitur ini belum aktif (honest degradation, bukan pura-pura terkirim),
// dan itu diperiksa SEBELUM mencari user jadi tidak bocorkan keberadaan akun.
app.post("/api/auth/forgot-password", loginLimiter, async (req, res) => {
  if (!isEmailConfigured()) {
    return res.status(503).json({
      error: "Reset password via email belum tersedia (SMTP belum dikonfigurasi di server ini). Hubungi admin perusahaan Anda untuk reset manual.",
    });
  }
  const genericMessage = "Jika email tersebut terdaftar, tautan reset password telah dikirim. Silakan cek kotak masuk (dan folder spam).";
  const db = loadDB();
  const email = String(req.body?.email || "").toLowerCase().trim();
  const user = (db.users as User[]).find((u) => u.email.toLowerCase() === email && u.active);
  if (user) {
    const { rawToken, tokenHash, expiresAt } = generateResetToken();
    user.resetTokenHash = tokenHash;
    user.resetTokenExpiresAt = expiresAt;
    saveDB(db);
    const resetUrl = `${shareBaseUrl(req)}/?resetToken=${rawToken}`;
    const html = emailTemplate({
      title: "Reset Password Smart CLM Enterprise",
      bodyHtml: `Halo ${user.name},<br><br>Kami menerima permintaan reset password untuk akun Anda. Klik tombol di bawah untuk membuat password baru. Tautan ini berlaku selama 1 jam dan hanya bisa dipakai sekali.<br><br>Jika Anda tidak meminta ini, abaikan email ini — password Anda tidak akan berubah.`,
      ctaLabel: "Reset Password",
      ctaUrl: resetUrl,
    });
    const result = await sendEmail({ to: user.email, subject: "Reset Password — Smart CLM Enterprise", html });
    if (!result.sent) {
      logger.error({ error: result.error, userId: user.id }, "Failed to send password reset email");
    }
  }
  res.json({ success: true, message: genericMessage });
});

// Selesaikan reset password memakai token dari email.
app.post("/api/auth/reset-password", loginLimiter, (req, res) => {
  const { token, newPassword } = req.body || {};
  if (!token || !newPassword || String(newPassword).length < 8) {
    return res.status(400).json({ error: "Token dan password baru (minimal 8 karakter) wajib diisi." });
  }
  const db = loadDB();
  const tokenHash = hashResetToken(String(token));
  const user = (db.users as User[]).find((u) => u.resetTokenHash === tokenHash);
  if (!user || !user.resetTokenExpiresAt || new Date(user.resetTokenExpiresAt).getTime() < Date.now()) {
    return res.status(400).json({ error: "Tautan reset tidak valid atau sudah kadaluarsa. Minta tautan baru." });
  }
  user.passwordHash = hashPassword(String(newPassword));
  user.resetTokenHash = undefined;
  user.resetTokenExpiresAt = undefined;
  // Endpoint ini sengaja tidak lewat requireAuth (user belum bisa login saat
  // reset password), jadi tulis audit langsung — pushAudit() mengasumsikan
  // req.user sudah ada dari middleware auth.
  db.audits.unshift({
    id: "aud-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
    tenantId: user.tenantId,
    userId: user.id, userName: user.name, userRole: user.role,
    timestamp: new Date().toISOString(),
    ipAddress: req.ip || "127.0.0.1",
    action: "Reset Password",
    details: `${user.name} berhasil reset password via tautan email.`,
  });
  saveDB(db);
  res.json({ success: true, message: "Password berhasil diubah. Silakan login dengan password baru." });
});

app.get("/api/auth/me", requireAuth, (req: AuthedRequest, res) => {
  const db = loadDB();
  const tenant = (db.tenants as any[]).find((t) => t.id === req.user!.tenantId) || null;
  const tid = req.user!.tenantId;
  const me = (db.users as User[]).find((u) => u.id === req.user!.id && u.tenantId === tid);
  // Dua arah delegasi dikirim sekali di sini supaya frontend tidak perlu
  // menarik seluruh daftar pengguna (yang hanya boleh diakses admin) hanya
  // untuk tahu dokumen siapa yang boleh saya putuskan sebagai pengganti.
  const delegatedToMe = (db.users as User[])
    .filter((u) => u.tenantId === tid && activeDelegateIdOf(u) === req.user!.id)
    .map((u) => ({ id: u.id, name: u.name, from: u.delegateFrom, until: u.delegateUntil, reason: u.delegateReason }));
  const myDelegation = me?.delegateToId
    ? { toId: me.delegateToId, toName: me.delegateToName, from: me.delegateFrom, until: me.delegateUntil, reason: me.delegateReason, active: !!activeDelegateIdOf(me) }
    : null;
  res.json({ user: req.user, tenant, delegatedToMe, myDelegation });
});

// Ganti kata sandi sendiri
app.post("/api/auth/change-password", requireAuth, (req: AuthedRequest, res) => {
  const db = loadDB();
  const { oldPassword, newPassword } = req.body;
  const user = (db.users as User[]).find((u) => u.id === req.user!.id);
  if (!user || !verifyPassword(oldPassword || "", user.passwordHash)) {
    return res.status(400).json({ error: "Kata sandi lama salah." });
  }
  if (!newPassword || String(newPassword).length < 8) {
    return res.status(400).json({ error: "Kata sandi baru minimal 8 karakter." });
  }
  user.passwordHash = hashPassword(newPassword);
  pushAudit(db, req, { action: "Change Password", details: "Mengganti kata sandi sendiri" });
  saveDB(db);
  res.json({ success: true });
});

// ===== USER MANAGEMENT (admin dalam tenant; super_admin lintas tenant) =====
app.get("/api/users", requireAuth, requireRole("admin"), (req: AuthedRequest, res) => {
  const db = loadDB();
  const tid = tenantOf(req);
  res.json(scoped(db.users as User[], tid).map(stripUser));
});

// Minimal colleague directory (id/name/role only) for the @mention picker in
// comments — any authenticated tenant member needs this, not just admins,
// so it's intentionally not behind requireRole("admin") like /api/users.
app.get("/api/users/mentionable", requireAuth, (req: AuthedRequest, res) => {
  const db = loadDB();
  const tid = tenantOf(req);
  res.json(
    scoped(db.users as User[], tid)
      .filter((u) => u.active)
      .map((u) => ({ id: u.id, name: u.name, role: u.role })),
  );
});

app.post("/api/users", requireAuth, requireRole("admin"), (req: AuthedRequest, res) => {
  const db = loadDB();
  const tid = tenantOf(req);
  const { name, email, password, role } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: "Nama, email, dan kata sandi wajib diisi" });
  if (String(password).length < 8) return res.status(400).json({ error: "Kata sandi minimal 8 karakter" });
  if ((db.users as User[]).some((u) => u.email.toLowerCase() === String(email).toLowerCase())) {
    return res.status(400).json({ error: "Email sudah terpakai" });
  }
  const allowedRoles: UserRole[] = ["admin", "legal", "manager", "staff", "viewer"];
  const finalRole: UserRole = allowedRoles.includes(role) ? role : "staff";
  const newUser: User = {
    id: "usr-" + Date.now(), tenantId: tid, name, email,
    passwordHash: hashPassword(password), role: finalRole, active: true,
    createdAt: new Date().toISOString(),
  };
  db.users.push(newUser);
  pushAudit(db, req, { action: "Create User", details: `Menambahkan pengguna "${name}" (${email}) sebagai ${finalRole}` });
  saveDB(db);
  res.json({ success: true, user: stripUser(newUser) });
});

app.put("/api/users/:id", requireAuth, requireRole("admin"), (req: AuthedRequest, res) => {
  const db = loadDB();
  const tid = tenantOf(req);
  const user = (db.users as User[]).find((u) => u.id === req.params.id && u.tenantId === tid);
  if (!user) return res.status(404).json({ error: "User tidak ditemukan" });

  // A tenant with zero active admins can no longer manage its own users —
  // that's a support-ticket-only dead end, not just an inconvenience.
  const wouldLoseAdminStatus =
    (typeof req.body.active === "boolean" && !req.body.active && user.role === "admin") ||
    (req.body.role && req.body.role !== "admin" && user.role === "admin");
  if (wouldLoseAdminStatus) {
    const otherActiveAdmins = (db.users as User[]).some(
      (u) => u.tenantId === tid && u.id !== user.id && u.role === "admin" && u.active,
    );
    if (!otherActiveAdmins) {
      return res.status(400).json({ error: "Tidak bisa menonaktifkan/mengubah peran admin terakhir di perusahaan ini." });
    }
  }
  if (req.params.id === req.user!.id && typeof req.body.active === "boolean" && !req.body.active) {
    return res.status(400).json({ error: "Tidak bisa menonaktifkan akun sendiri." });
  }

  if (req.body.name) user.name = req.body.name;
  if (req.body.role && ["admin", "legal", "manager", "staff", "viewer"].includes(req.body.role)) user.role = req.body.role;
  if (typeof req.body.active === "boolean") user.active = req.body.active;
  if (req.body.newPassword) {
    if (String(req.body.newPassword).length < 8) return res.status(400).json({ error: "Kata sandi minimal 8 karakter" });
    user.passwordHash = hashPassword(req.body.newPassword);
  }
  pushAudit(db, req, { action: "Update User", details: `Memperbarui pengguna "${user.name}"` });
  saveDB(db);
  res.json({ success: true, user: stripUser(user) });
});

// Atur / cabut delegasi persetujuan. Sengaja TIDAK dibatasi role admin: orang
// yang cuti harus bisa menunjuk penggantinya sendiri tanpa menunggu admin.
// Admin tetap boleh mengatur milik orang lain (mis. yang mendadak berhalangan).
app.put("/api/users/:id/delegation", requireAuth, (req: AuthedRequest, res) => {
  const db = loadDB();
  const tid = tenantOf(req);
  const user = (db.users as User[]).find((u) => u.id === req.params.id && u.tenantId === tid);
  if (!user) return res.status(404).json({ error: "User tidak ditemukan" });
  const isSelf = req.params.id === req.user!.id;
  const isAdmin = req.user!.role === "admin" || req.user!.role === "super_admin";
  if (!isSelf && !isAdmin) {
    return res.status(403).json({ error: "Hanya bisa mengatur delegasi milik sendiri." });
  }

  // Kirim delegateToId kosong = mencabut delegasi.
  const targetId = String(req.body.delegateToId || "").trim();
  if (!targetId) {
    user.delegateToId = undefined; user.delegateToName = undefined;
    user.delegateFrom = undefined; user.delegateUntil = undefined; user.delegateReason = undefined;
    pushAudit(db, req, { action: "Cabut Delegasi Persetujuan", details: `Mencabut delegasi persetujuan milik "${user.name}"` });
    saveDB(db);
    return res.json({ success: true, user: stripUser(user) });
  }

  if (targetId === user.id) return res.status(400).json({ error: "Tidak bisa mendelegasikan kepada diri sendiri." });
  const target = (db.users as User[]).find((u) => u.id === targetId && u.tenantId === tid);
  if (!target || !target.active) return res.status(400).json({ error: "Pengganti tidak ditemukan atau sedang nonaktif." });
  if (target.role === "viewer") return res.status(400).json({ error: "Viewer tidak bisa dijadikan pengganti — perannya tidak berwenang menyetujui." });

  const from = String(req.body.delegateFrom || "").slice(0, 10);
  const until = String(req.body.delegateUntil || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
    return res.status(400).json({ error: "Tanggal mulai dan selesai delegasi wajib diisi." });
  }
  if (until < from) return res.status(400).json({ error: "Tanggal selesai tidak boleh sebelum tanggal mulai." });

  // Delegasi timbal-balik (A→B sementara B→A) membuat keduanya bisa memutuskan
  // atas nama satu sama lain di rentang yang sama — ditolak, bukan diam-diam
  // dibiarkan (aturan "tidak berantai" ada di activeDelegateIdOf).
  if (activeDelegateIdOf(target) === user.id) {
    return res.status(400).json({ error: `${target.name} sedang mendelegasikan persetujuan kepada Anda — delegasi bolak-balik tidak diizinkan.` });
  }

  user.delegateToId = target.id;
  user.delegateToName = target.name;
  user.delegateFrom = from;
  user.delegateUntil = until;
  user.delegateReason = String(req.body.delegateReason || "").slice(0, 200) || undefined;
  pushAudit(db, req, {
    action: "Atur Delegasi Persetujuan",
    details: `Persetujuan milik "${user.name}" didelegasikan ke "${target.name}" pada ${from} s/d ${until}${user.delegateReason ? ` — ${user.delegateReason}` : ""}`,
  });
  pushNotif(db, tid, {
    title: "Anda Ditunjuk Sebagai Pengganti",
    message: `${user.name} menunjuk Anda menyetujui dokumen atas namanya pada ${from} s/d ${until}.`,
    type: "info",
  });
  saveDB(db);
  res.json({ success: true, user: stripUser(user) });
});

app.delete("/api/users/:id", requireAuth, requireRole("admin"), (req: AuthedRequest, res) => {
  const db = loadDB();
  const tid = tenantOf(req);
  if (req.params.id === req.user!.id) return res.status(400).json({ error: "Tidak bisa menghapus akun sendiri" });
  const target = (db.users as User[]).find((u) => u.id === req.params.id && u.tenantId === tid);
  if (!target) return res.status(404).json({ error: "User tidak ditemukan" });
  if (target.role === "admin") {
    const otherActiveAdmins = (db.users as User[]).some(
      (u) => u.tenantId === tid && u.id !== target.id && u.role === "admin" && u.active,
    );
    if (!otherActiveAdmins) {
      return res.status(400).json({ error: "Tidak bisa menghapus admin terakhir di perusahaan ini." });
    }
  }
  db.users = (db.users as User[]).filter((u) => u.id !== req.params.id);
  pushAudit(db, req, { action: "Delete User", details: `Menghapus pengguna "${target.name}"` });
  saveDB(db);
  res.json({ success: true });
});

// ===== TENANT MANAGEMENT (super_admin only) =====
app.get("/api/tenants", requireAuth, requireRole("super_admin"), (req: AuthedRequest, res) => {
  const db = loadDB();
  res.json(db.tenants);
});

app.post("/api/tenants", requireAuth, requireRole("super_admin"), (req: AuthedRequest, res) => {
  const db = loadDB();
  const { name, branch, adminName, adminEmail, adminPassword } = req.body;
  if (!name || !adminEmail || !adminPassword) {
    return res.status(400).json({ error: "Nama perusahaan, email admin, dan kata sandi admin wajib diisi" });
  }
  if (String(adminPassword).length < 8) return res.status(400).json({ error: "Kata sandi admin minimal 8 karakter" });
  if ((db.users as User[]).some((u) => u.email.toLowerCase() === String(adminEmail).toLowerCase())) {
    return res.status(400).json({ error: "Email admin sudah terpakai" });
  }
  const tid = "t-" + Date.now();
  db.tenants.push({ id: tid, name, branch: branch || "", active: true, createdAt: new Date().toISOString() });
  const adminUser: User = {
    id: "usr-" + Date.now(), tenantId: tid, name: adminName || "Admin " + name,
    email: adminEmail, passwordHash: hashPassword(adminPassword), role: "admin", active: true,
    createdAt: new Date().toISOString(),
  };
  db.users.push(adminUser);
  // Seed folder kategori & settings default untuk tenant baru
  setCatsFor(db, tid, ["General", "Vendor", "Employment", "Customer", "Legalitas Perusahaan", "NDA", "MOU", "Rental"]);
  setSettingsFor(db, tid, withSettingsDefaults({ companyName: name }));
  pushAudit(db, req, { action: "Create Tenant", details: `Membuat perusahaan baru "${name}" dengan admin ${adminEmail}` });
  saveDB(db);
  res.json({ success: true, tenant: db.tenants[db.tenants.length - 1], admin: stripUser(adminUser) });
});

app.put("/api/tenants/:id", requireAuth, requireRole("super_admin"), (req: AuthedRequest, res) => {
  const db = loadDB();
  const tenant = (db.tenants as any[]).find((t) => t.id === req.params.id);
  if (!tenant) return res.status(404).json({ error: "Tenant tidak ditemukan" });
  if (req.body.name) tenant.name = req.body.name;
  if (req.body.branch !== undefined) tenant.branch = req.body.branch;
  if (typeof req.body.active === "boolean") tenant.active = req.body.active;
  pushAudit(db, req, { action: "Update Tenant", details: `Memperbarui perusahaan "${tenant.name}"` });
  saveDB(db);
  res.json({ success: true, tenant });
});

// Set up multer for file uploads — buffered in memory, then handed to
// storage.ts which persists to cloud object storage (if STORAGE_* env vars
// are configured) or local disk (uploads/) otherwise. See storage.ts for the
// honest-degradation rationale.
// Vercel's function filesystem is read-only outside /tmp — creating this
// eagerly at module load would crash the whole app on import there. It's
// only actually needed when a file falls back to local disk (see
// storage.ts), so failing here is non-fatal: just log and move on.
const uploadDir = path.join(process.cwd(), 'uploads');
try {
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
} catch (err) {
  logger.warn({ err }, "Could not create local uploads/ directory (read-only filesystem, e.g. Vercel) — local file fallback will be unavailable");
}
// Contract documents are scans/PDFs, not arbitrary files — restrict type and
// size so upload can't be used to plant executables or exhaust disk space.
const ALLOWED_UPLOAD_MIME = new Set(["application/pdf", "image/jpeg", "image/png"]);
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10MB
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES }, // 10MB — cukup untuk scan kontrak, cegah abuse
  fileFilter: (req, file, cb) => {
    if (ALLOWED_UPLOAD_MIME.has(file.mimetype)) cb(null, true);
    else cb(new Error("Tipe berkas tidak didukung. Hanya PDF, JPG, atau PNG."));
  },
})
// Instance TERPISAH & lebih longgar khusus lampiran DCS (Word/PDF) — TIDAK
// melebarkan `ALLOWED_UPLOAD_MIME` global (yang dipakai upload dokumen utama
// PDF/JPG/PNG), supaya blast radius menerima .docx tetap sesempit mungkin.
const ALLOWED_LAMPIRAN_MIME = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const uploadLampiran = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_LAMPIRAN_MIME.has(file.mimetype)) cb(null, true);
    else cb(new Error("Tipe berkas tidak didukung. Hanya PDF atau Word (.doc/.docx)."));
  },
});
function uploadFileKey(originalname: string): string {
  const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
  return `file-${uniqueSuffix}${path.extname(originalname)}`;
}

// Serve locally-stored uploads statically (no-op for files actually persisted
// to cloud storage — those are fetched straight from the bucket/CDN URL).
app.use('/uploads', express.static(uploadDir));

// ai, isGeminiConfigured, parseAiJson, aiErrorResponse now live in
// ai-client.ts (extracted so dcs/routes.ts can use the same Gemini client
// without a circular import — server.ts already imports dcs/routes.ts).
// Applied ahead of every /api/ai/* route: fails fast with a clear message
// instead of each of the 10+ handlers below needing its own pre-flight check.
app.use("/api/ai/", (req, res, next) => {
  if (!isGeminiConfigured()) {
    return res.status(503).json({ error: "Fitur AI belum tersedia — GEMINI_API_KEY belum dikonfigurasi di server. Hubungi admin." });
  }
  next();
});


// Initial Seed Data for Clause Library
const defaultClauses: Clause[] = [
  {
    id: "cls-1",
    title: "Definisi & Penafsiran",
    content: "Kecuali ditentukan lain dalam Perjanjian ini, seluruh istilah yang didefinisikan dalam Perjanjian ini memiliki arti sebagaimana tercantum dalam UU Hukum Perdata Indonesia dan peraturan terkait lainnya yang berlaku di Republik Indonesia.",
    category: "General",
    tags: ["Definisi", "Umum"],
    isMandatory: true,
    isProtected: true,
    version: 1
  },
  {
    id: "cls-2",
    title: "Ruang Lingkup Pekerjaan",
    content: "Pihak Kedua sepakat untuk menyediakan jasa dan melakukan pekerjaan sesuai spesifikasi teknis, standar kualitas, dan jangka waktu yang disepakati sebagaimana tercantum dalam Lampiran A Perjanjian ini.",
    category: "Vendor",
    tags: ["Pekerjaan", "SLA"],
    isMandatory: true,
    isProtected: false,
    version: 1
  },
  {
    id: "cls-3",
    title: "Nilai Kontrak & Pembayaran",
    content: "Nilai Kontrak yang disepakati adalah sebesar {{ContractValue}} {{Currency}} belum termasuk PPN yang berlaku. Pembayaran dilakukan secara bertahap dalam jangka waktu {{PaymentTerm}} hari kalender setelah invoice resmi dan berita acara serah terima (BAST) diterima dengan lengkap oleh Pihak Kesatu.",
    category: "Vendor",
    tags: ["Keuangan", "Pembayaran"],
    isMandatory: true,
    isProtected: false,
    version: 1
  },
  {
    id: "cls-4",
    title: "Force Majeure (Keadaan Memaksa)",
    content: "Keadaan Memaksa adalah peristiwa di luar kendali wajar para pihak, termasuk namun tidak terbatas pada bencana alam (gempa bumi, banjir, topan), perang, pemberontakan, huru-hara, epidemi, tindakan pemerintah di bidang moneter, atau pemogokan umum yang secara langsung menghalangi pelaksanaan Perjanjian ini. Pihak yang mengalami Force Majeure wajib memberitahukan secara tertulis dalam waktu 3 (tiga) hari kerja sejak terjadinya peristiwa.",
    category: "General",
    tags: ["Force Majeure", "Kepatuhan"],
    isMandatory: true,
    isProtected: true,
    version: 1
  },
  {
    id: "cls-5",
    title: "Kerahasiaan Informasi (Non-Disclosure)",
    content: "Masing-masing pihak sepakat untuk menjaga kerahasiaan seluruh data, informasi bisnis, teknologi, formula, rahasia dagang, atau data karyawan yang diperoleh dari pihak lainnya selama pelaksanaan Perjanjian ini. Kewajiban kerahasiaan ini tetap berlaku selama 5 (lima) tahun setelah Perjanjian ini berakhir.",
    category: "NDA",
    tags: ["Confidentiality", "NDA"],
    isMandatory: false,
    isProtected: false,
    version: 1
  },
  {
    id: "cls-6",
    title: "Penyelesaian Sengketa & Domisili Hukum",
    content: "Setiap perselisihan yang timbul dari Perjanjian ini akan diselesaikan secara musyawarah untuk mufakat. Apabila perselisihan tidak dapat diselesaikan dalam waktu 30 (tiga puluh) hari kalender, maka para pihak sepakat untuk menyelesaikan sengketa melalui Badan Arbitrase Nasional Indonesia (BANI) atau Pengadilan Negeri Jakarta Pusat.",
    category: "General",
    tags: ["Hukum", "Sengketa"],
    isMandatory: true,
    isProtected: true,
    version: 1
  },
  {
    id: "cls-7",
    title: "Masa Percobaan (Probation Period)",
    content: "Karyawan wajib menjalani masa percobaan selama 3 (tiga) bulan terhitung sejak tanggal mulai bekerja. Selama masa percobaan, masing-masing pihak berhak memutuskan hubungan kerja dengan pemberitahuan tertulis 7 (tujuh) hari kerja sebelumnya tanpa kewajiban pemberian pesangon.",
    category: "Employment",
    tags: ["HR", "Employment"],
    isMandatory: false,
    isProtected: false,
    version: 1
  },
  {
    id: "cls-8",
    title: "Ganti Rugi & Penalti Pelanggaran",
    content: "Apabila Pihak Kedua melakukan kelalaian atau pelanggaran terhadap ketentuan Perjanjian ini yang menyebabkan kerugian material pada Pihak Kesatu, Pihak Kedua wajib mengganti kerugian tersebut sebesar maksimal nilai kontrak ini atau denda keterlambatan sebesar 0.1% per hari dari nilai sisa pekerjaan.",
    category: "Vendor",
    tags: ["Penalti", "Ganti Rugi"],
    isMandatory: false,
    isProtected: false,
    version: 1
  }
];

// Initial Seed Data for Variables
const defaultVariables: Variable[] = [
  { key: "CompanyName", label: "Nama Perusahaan (Pihak 1)", type: "string", description: "Nama entitas perusahaan kita" },
  { key: "VendorName", label: "Nama Vendor / Pihak 2", type: "string", description: "Nama pihak rekanan atau vendor" },
  { key: "EmployeeName", label: "Nama Karyawan", type: "string", description: "Nama lengkap karyawan yang dikontrak" },
  { key: "Position", label: "Jabatan", type: "string", description: "Posisi jabatan kerja" },
  { key: "Salary", label: "Gaji Bulanan", type: "number", description: "Nilai nominal gaji bulanan karyawan" },
  { key: "StartDate", label: "Tanggal Mulai Kontrak", type: "date", description: "Tanggal mulai berlakunya kontrak" },
  { key: "EndDate", label: "Tanggal Berakhir Kontrak", type: "date", description: "Tanggal berakhirnya kontrak" },
  { key: "ContractValue", label: "Nilai Kontrak", type: "number", description: "Total nilai kontrak kerja sama" },
  { key: "Currency", label: "Mata Uang", type: "string", description: "Mata uang pembayaran (IDR, USD, dll)", defaultValue: "IDR" },
  { key: "PaymentTerm", label: "Termin Pembayaran (Hari)", type: "number", description: "Batas waktu pelunasan invoice setelah BAST", defaultValue: "30" },
  { key: "Address", label: "Alamat Lengkap Pihak 2", type: "string", description: "Alamat tempat tinggal / domisili hukum pihak kedua" }
];

// Initial Seed Data for Templates
const defaultTemplates: Template[] = [
  {
    id: "tmp-1",
    name: "Kontrak Kerja PKWT Karyawan",
    description: "Template standar Perjanjian Kerja Waktu Tertentu (PKWT) untuk karyawan kontrak sesuai UU Cipta Kerja.",
    category: "Employment",
    clauseIds: ["cls-1", "cls-2", "cls-7", "cls-6"],
    requiredVariables: ["CompanyName", "EmployeeName", "Position", "Salary", "StartDate", "EndDate", "Address"],
    parties: ["Pihak Pertama (Perusahaan)", "Pihak Kedua (Karyawan)"]
  },
  {
    id: "tmp-2",
    name: "Perjanjian Kerjasama Vendor & Jasa (SLA)",
    description: "Template komprehensif untuk pengadaan barang/jasa vendor IT, logistik, atau maintenance GA.",
    category: "Vendor",
    clauseIds: ["cls-1", "cls-2", "cls-3", "cls-4", "cls-5", "cls-8", "cls-6"],
    requiredVariables: ["CompanyName", "VendorName", "ContractValue", "Currency", "PaymentTerm", "StartDate", "EndDate", "Address"],
    parties: ["Pihak Pertama (Perusahaan)", "Pihak Kedua (Vendor/Mitra)"]
  },
  {
    id: "tmp-3",
    name: "Non-Disclosure Agreement (NDA)",
    description: "Template perjanjian kerahasiaan informasi bisnis untuk mitra strategis, calon karyawan, atau investor.",
    category: "NDA",
    clauseIds: ["cls-1", "cls-5", "cls-6"],
    requiredVariables: ["CompanyName", "VendorName", "StartDate", "EndDate", "Address"],
    parties: ["Pihak Pertama (Disclosing Party)", "Pihak Kedua (Receiving Party)"]
  }
];

// Initial Integrated Module Data for Sync Simulation
const initialEmployees: EmployeeData[] = [
  { id: "EMP001", name: "Budi Santoso", position: "GA Supervisor", department: "General Affair", salary: 8500000, startDate: "2026-07-01" },
  { id: "EMP002", name: "Siti Rahma", position: "Legal Counsel", department: "Corporate Legal", salary: 12000000, startDate: "2026-08-15" },
  { id: "EMP003", name: "Dewi Lestari", position: "Finance Analyst", department: "Finance & Accounting", salary: 7500000, startDate: "2026-09-01" }
];

const initialVendors: VendorData[] = [
  { id: "VND001", name: "CV Solusi Bersama Abadi", picName: "Joko Susilo", email: "joko@solusibersama.com", npwp: "01.234.567.8-901.000", address: "Jl. Sudirman No. 45, Jakarta Selatan" },
  { id: "VND002", name: "PT Wahana Logistik Indonesia", picName: "Rian Hidayat", email: "rian@wahanalogistics.co.id", npwp: "02.456.789.0-123.000", address: "Kawasan Industri MM2100, Bekasi" },
  { id: "VND003", name: "PT Global Cleaning Service", picName: "Megawati", email: "mega@globalcleaning.co.id", npwp: "03.789.123.4-567.000", address: "Ruko Gading Serpong, Tangerang" }
];

// Format nomor kontrak:
//  - REFERENCE_DEFAULT_MASK: default baru gaya penomoran surat Indonesia
//    (urut/kode-jenis/kode-tambahan/bulan-romawi/tahun).
//  - LEGACY_DEFAULT_MASK: default LAMA — diperlakukan sebagai "belum dikustom",
//    jadi otomatis di-upgrade ke default baru (lihat withSettingsDefaults).
//    Mask yang benar-benar dikustom tenant TIDAK diubah.
const REFERENCE_DEFAULT_MASK = "{Sequence:3}/{DocTypeCode}/{Codes}/{MonthRoman}/{Year}";
const LEGACY_DEFAULT_MASK = "{Prefix}-{Year}-{Sequence:4}";

function createDefaultDB() {
  return {
    clauses: defaultClauses,
    variables: defaultVariables,
    templates: defaultTemplates,
    clauseCategories: ["General", "Vendor", "Employment", "Customer", "Legalitas Perusahaan", "NDA", "MOU", "Rental"],
    contracts: [
      {
        id: "ctr-0",
        tenantId: "t-01",
        templateId: "tmp-2",
        contractNumber: "GA-VND-2025-0014",
        title: "Perjanjian Sewa AC & Perawatan Gedung (Tahun Lalu)",
        category: "Vendor",
        party1Name: "PT Semesta Digital Terpadu",
        party2Name: "CV Solusi Bersama Abadi",
        party2Type: "Vendor",
        parties: [
          { role: "Pihak Pertama (Perusahaan)", name: "PT Semesta Digital Terpadu", type: "Company" },
          { role: "Pihak Kedua (Vendor/Mitra)", name: "CV Solusi Bersama Abadi", type: "Vendor" }
        ],
        startDate: "2025-07-01",
        endDate: "2025-12-31",
        contractValue: 40000000,
        currency: "IDR",
        status: "Archived",
        reminderDaysBefore: 30,
        isAutoRenew: false,
        variables: {
          CompanyName: "PT Semesta Digital Terpadu",
          VendorName: "CV Solusi Bersama Abadi",
          ContractValue: "40000000",
          Currency: "IDR",
          PaymentTerm: "30",
          StartDate: "2025-07-01",
          EndDate: "2025-12-31",
          Address: "Jl. Sudirman No. 45, Jakarta Selatan"
        },
        clauses: [
          { id: "cls-1", title: "Definisi & Penafsiran", content: "Kecuali ditentukan lain dalam Perjanjian ini, seluruh istilah yang didefinisikan dalam Perjanjian ini memiliki arti sebagaimana tercantum dalam UU Hukum Perdata Indonesia.", order: 1 },
          { id: "cls-2", title: "Ruang Lingkup Pekerjaan", content: "Pihak Kedua sepakat untuk menyediakan jasa perawatan AC berkala sebanyak 1 kali sebulan untuk Gedung Lantai 1-4 PT Semesta Digital Terpadu.", order: 2 },
          { id: "cls-3", title: "Nilai Kontrak & Pembayaran", content: "Nilai Kontrak yang disepakati adalah sebesar 40000000 IDR belum termasuk PPN. Pembayaran dilakukan secara bertahap dalam jangka waktu 30 hari kalender setelah invoice diterima.", order: 3 },
          { id: "cls-4", title: "Force Majeure (Keadaan Memaksa)", content: "Keadaan Memaksa adalah peristiwa di luar kendali wajar para pihak, termasuk bencana alam dan huru-hara.", order: 4 },
        ],
        createdAt: "2025-06-24T08:30:00Z",
        updatedAt: "2025-12-31T23:59:00Z"
      },
      {
        id: "ctr-1",
        tenantId: "t-01",
        templateId: "tmp-2",
        contractNumber: "GA-VND-2026-0001",
        title: "Perjanjian Sewa AC & Perawatan Gedung",
        category: "Vendor",
        party1Name: "PT Semesta Digital Terpadu",
        party2Name: "CV Solusi Bersama Abadi",
        party2Type: "Vendor",
        parties: [
          { role: "Pihak Pertama (Perusahaan)", name: "PT Semesta Digital Terpadu", type: "Company" },
          { role: "Pihak Kedua (Vendor/Mitra)", name: "CV Solusi Bersama Abadi", type: "Vendor" }
        ],
        startDate: "2026-07-01",
        endDate: "2026-12-31",
        contractValue: 45000000,
        currency: "IDR",
        status: "Aktif",
        reminderDaysBefore: 30,
        isAutoRenew: true,
        variables: {
          CompanyName: "PT Semesta Digital Terpadu",
          VendorName: "CV Solusi Bersama Abadi",
          ContractValue: "45000000",
          Currency: "IDR",
          PaymentTerm: "14",
          StartDate: "2026-07-01",
          EndDate: "2026-12-31",
          Address: "Jl. Sudirman No. 45, Jakarta Selatan"
        },
        clauses: [
          { id: "cls-1", title: "Definisi & Penafsiran", content: "Kecuali ditentukan lain dalam Perjanjian ini, seluruh istilah yang didefinisikan dalam Perjanjian ini memiliki arti sebagaimana tercantum dalam UU Hukum Perdata Indonesia.", order: 1 },
          { id: "cls-2", title: "Ruang Lingkup Pekerjaan", content: "Pihak Kedua sepakat untuk menyediakan jasa perawatan AC berkala sebanyak 2 kali sebulan untuk Gedung Lantai 1-4 PT Semesta Digital Terpadu.", order: 2 },
          { id: "cls-3", title: "Nilai Kontrak & Pembayaran", content: "Nilai Kontrak yang disepakati adalah sebesar 45000000 IDR belum termasuk PPN. Pembayaran dilakukan secara bertahap dalam jangka waktu 14 hari kalender setelah invoice diterima.", order: 3 },
          { id: "cls-4", title: "Force Majeure (Keadaan Memaksa)", content: "Keadaan Memaksa adalah peristiwa di luar kendali wajar para pihak, termasuk bencana alam, perang, pandemi nasional.", order: 4 },
          { id: "cls-5", title: "Kerahasiaan Informasi (Non-Disclosure)", content: "Masing-masing pihak sepakat untuk menjaga kerahasiaan seluruh data perusahaan yang diperoleh selama pelaksanaan perawatan.", order: 5 }
        ],
        createdAt: "2026-06-24T08:30:00Z",
        updatedAt: "2026-06-25T11:30:00Z"
      },
      {
        id: "ctr-2",
        tenantId: "t-01",
        templateId: "tmp-1",
        contractNumber: "HR-PKWT-2026-0002",
        title: "Kontrak Kerja PKWT - Roni Ardiansyah",
        category: "Employment",
        party1Name: "PT Semesta Digital Terpadu",
        party2Name: "Roni Ardiansyah",
        party2Type: "Employee",
        parties: [
          { role: "Pihak Pertama (Perusahaan)", name: "PT Semesta Digital Terpadu", type: "Company" },
          { role: "Pihak Kedua (Karyawan)", name: "Roni Ardiansyah", type: "Employee" }
        ],
        startDate: "2026-07-01",
        endDate: "2026-09-30", // Expiry dalam 3 bulan
        contractValue: 24000000,
        currency: "IDR",
        status: "Draft",
        reminderDaysBefore: 14,
        isAutoRenew: false,
        variables: {
          CompanyName: "PT Semesta Digital Terpadu",
          EmployeeName: "Roni Ardiansyah",
          Position: "GA Staff Support",
          Salary: "8000000",
          StartDate: "2026-07-01",
          EndDate: "2026-09-30",
          Address: "Jl. Tebet Timur Dalam No. 12, Jakarta Selatan"
        },
        clauses: [
          { id: "cls-1", title: "Definisi & Penafsiran", content: "Kecuali ditentukan lain dalam Perjanjian ini, seluruh istilah memiliki arti sesuai UU Ketenagakerjaan.", order: 1 },
          { id: "cls-2", title: "Ruang Lingkup Pekerjaan", content: "Pihak Kedua bertugas sebagai GA Staff Support yang bertanggung jawab atas inventarisasi aset kantor.", order: 2 },
          { id: "cls-7", title: "Masa Percobaan (Probation Period)", content: "Karyawan wajib menjalani masa percobaan selama 3 bulan.", order: 3 },
          { id: "cls-6", title: "Penyelesaian Sengketa", content: "Sengketa diselesaikan melalui Pengadilan Hubungan Industrial.", order: 4 }
        ],
        createdAt: "2026-06-29T09:00:00Z",
        updatedAt: "2026-06-29T10:00:00Z"
      }
    ],
    versions: [],
    audits: [
      { id: "aud-1", contractId: "ctr-1", contractNumber: "GA-VND-2026-0001", userId: "u-1", userName: "Ahmad GA", userRole: "Staff GA", action: "Create Contract", details: "Membuat draft kontrak sewa AC", timestamp: "2026-06-24T08:30:00Z", ipAddress: "192.168.1.10" },
      { id: "aud-2", contractId: "ctr-1", contractNumber: "GA-VND-2026-0001", userId: "u-2", userName: "Budi Santoso", userRole: "GA Supervisor", action: "Activate Contract", details: "Mengaktifkan kontrak sewa AC", timestamp: "2026-06-24T14:30:00Z", ipAddress: "192.168.1.12" }
    ],
    notifications: [
      { id: "not-1", title: "Draft Kontrak", message: "Kontrak HR-PKWT-2026-0002 masih draft — aktifkan setelah final.", type: "warning", createdAt: "2026-06-29T10:00:00Z", read: false, contractId: "ctr-2" }
    ],
    employees: initialEmployees,
    vendors: initialVendors,
    budgets: [],
    settings: defaultSettings()
  };
}

// Global app configuration (dynamic, editable via Konfigurasi page)
function defaultSettings() {
  return {
    // Hak akses menu sidebar per role (RBAC) — dikonfigurasi lewat UI
    // (Konfigurasi > Hak Akses), BUKAN hardcode di kode, supaya admin bisa
    // ubah kapan saja tanpa deploy ulang. Key = UserRole, value = daftar id
    // menu yang BOLEH diakses (lihat MENU_ITEMS di src/App.tsx untuk daftar
    // id-nya). Role yang TIDAK ADA sebagai key di sini = akses PENUH ke semua
    // menu (kondisi "belum pernah diatur" — floor default aman untuk tenant
    // lama yang upgrade, tidak ada yang mendadak terkunci keluar dari
    // fiturnya sendiri). super_admin SELALU penuh, tidak pernah dibatasi
    // config ini (lihat canAccessMenu di src/App.tsx).
    rolePermissions: {} as Record<string, string[]>,
    // Akses per FOLDER (kategori) di halaman "Arsip Dokumen Kontrak" — beda
    // level dgn rolePermissions di atas (itu per MENU/halaman; ini per
    // folder DI DALAM satu halaman itu). Konvensi sama: role tidak ada di
    // sini/array kosong = akses penuh ke semua folder (default aman).
    folderPermissions: {} as Record<string, string[]>,
    // Sengaja kosong (bukan nama perusahaan contoh) — ini floor default yang
    // dipakai withSettingsDefaults() untuk SETIAP tenant yang belum pernah
    // menyimpan pengaturannya sendiri, jadi tenant baru tidak pernah mewarisi
    // identitas tenant demo secara diam-diam. Tenant demo (t-01) punya
    // companyName tersimpan eksplisit di data-nya sendiri, tidak bergantung
    // pada default ini.
    // Batas wajar sebuah langkah approval menggantung, dalam hari kerja
    // kalender. Dipakai untuk menandai keterlambatan di UI dan memicu
    // notifikasi eskalasi. 0 = fitur SLA dimatikan.
    approvalSlaDays: 3,
    companyName: "",
    companyRepresentative: "",
    companyRepresentativeTitle: "",
    companyAddress: "",
    // Kop surat (letterhead) untuk dokumen DCS bergaya "memo"/"kebijakan" —
    // companyLogoKey adalah storage key (bukan URL publik), dipakai
    // dcs/routes.ts untuk fetchFile() saat compose; URL saja tidak cukup
    // kalau cloud storage memakai signed/CDN URL yang tak bisa di-fetch balik.
    companyLogoUrl: "",
    companyLogoKey: "",
    companyLogoMimeType: "",
    // Margin halaman PDF dokumen DCS (mm). Kiri sengaja lebih besar untuk
    // ruang penjilidan, praktik umum SOP. Dipakai dcs/pdf-compose.ts (dikonversi
    // ke points). Bisa diubah per perusahaan di Konfigurasi > DCS.
    dcsPageMargins: { top: 20, right: 18, bottom: 18, left: 25 },
    // Margin halaman PDF KONTRAK (mm) — dipakai sebagai padding pada preview
    // yang di-screenshot (html2canvas) oleh generateContractPdf di App.tsx.
    // Terpisah dari dcsPageMargins karena beda mesin render (kontrak = screenshot
    // preview, DCS = digambar langsung lewat pdf-lib). Default 40/30/30/40mm
    // = gaya margin dokumen resmi Indonesia umum (atas 4cm, kiri 4cm, kanan &
    // bawah 3cm). Bisa diubah per perusahaan di Konfigurasi > Master Data.
    contractPageMargins: { top: 30, right: 30, bottom: 30, left: 30 },
    // Watermark (CONTROLLED/UNCONTROLLED) pada PDF KONTRAK — OPSIONAL, default
    // MATI (tidak mandatory utk kontrak & karyawan). DCS TETAP wajib watermark
    // by sistem (reactive watermark modul DCS, tidak dipengaruhi setelan ini).
    contractWatermark: false,
    reminderDefaults: [7, 14, 30, 60, 90],
    // Master data dropdown yang sebelumnya hardcoded di frontend — sekarang
    // dikonfigurasi per tenant lewat Konfigurasi > Master Data. Bentuknya
    // sengaja sederhana (array string / record) supaya gampang diedit di UI.
    masterData: {
      // Jenis kontrak/dokumen. `categories` membatasi jenis ini muncul hanya
      // saat kategori tsb dipilih di form (kosong = berlaku semua kategori).
      // `id` stabil dipakai sebagai kunci defaultTemplateId/numberMask (lihat
      // withSettingsDefaults) — tidak berubah walau `name` diedit tenant.
      // `defaultTemplateId`: template yang otomatis diterapkan saat jenis ini
      // dipilih di wizard buat-kontrak. `numberMask`: override format nomor
      // token (lihat generateContractNumber) khusus jenis ini; kosong =
      // pakai masterData.defaultNumberMask.
      // `code`: kode singkat jenis (token {DocTypeCode} di nomor). `extraCodes`:
      // segmen kode tambahan dinamis per jenis (Divisi/Entitas/dll → {Codes}).
      docTypes: [
        { id: "dt-perjanjian-kerjasama", name: "Perjanjian Kerjasama", code: "PKS", extraCodes: [] as { label: string; value: string }[], categories: [] as string[], defaultTemplateId: "", numberMask: "" },
        { id: "dt-pkwt-pkwtt", name: "Perjanjian Kerja (PKWT/PKWTT)", code: "PK", extraCodes: [] as { label: string; value: string }[], categories: ["Employment"], defaultTemplateId: "", numberMask: "" },
        { id: "dt-nda", name: "NDA / Kerahasiaan", code: "NDA", extraCodes: [] as { label: string; value: string }[], categories: [] as string[], defaultTemplateId: "", numberMask: "" },
        { id: "dt-mou", name: "MOU / Nota Kesepahaman", code: "MOU", extraCodes: [] as { label: string; value: string }[], categories: [] as string[], defaultTemplateId: "", numberMask: "" },
        { id: "dt-sewa-menyewa", name: "Sewa Menyewa", code: "SWM", extraCodes: [] as { label: string; value: string }[], categories: [] as string[], defaultTemplateId: "", numberMask: "" },
        // numberMask sengaja terisi (beda dari jenis dokumen lain di sini) —
        // addendum lazimnya punya seri nomor sendiri di praktik hukum Indonesia.
        { id: "dt-addendum", name: "Addendum / Amandemen", code: "ADD", extraCodes: [] as { label: string; value: string }[], categories: [] as string[], defaultTemplateId: "", numberMask: "ADD-{Sequence:3}/{Year}" },
        { id: "dt-legalitas", name: "Legalitas / Izin Perusahaan", code: "LGL", extraCodes: [] as { label: string; value: string }[], categories: ["Legalitas Perusahaan"], defaultTemplateId: "", numberMask: "" },
        { id: "dt-lainnya", name: "Lainnya", code: "LL", extraCodes: [] as { label: string; value: string }[], categories: [] as string[], defaultTemplateId: "", numberMask: "" },
      ],
      partyTypes: ["Vendor", "Karyawan", "Customer / Klien", "Mitra / Partner"],
      currencies: ["IDR", "USD", "SGD", "EUR"],
      // Prefix nomor kontrak per kategori (menggantikan mapping hardcoded).
      // Kategori tanpa entri memakai fallback GA-AGR.
      categoryPrefixes: {
        Employment: "HR-PKWT",
        Vendor: "GA-VND",
        Customer: "CUST-AGR",
        "Legalitas Perusahaan": "CORP-LEG",
        MOU: "GA-MOU",
      } as Record<string, string>,
      defaultNumberPrefix: "GA-AGR",
      // Format nomor default (gaya penomoran surat Indonesia): urut / kode jenis
      // / kode tambahan / bulan romawi / tahun. Segmen kosong otomatis dirapikan.
      defaultNumberMask: REFERENCE_DEFAULT_MASK,
      // Status fisik rangkap kontrak (Disimpan/Dikirim/Di-assign/dll)
      copyStatuses: ["Disimpan", "Dikirim", "Di-assign", "Diarsipkan"],
      // Departemen — dipakai sebagai daftar pilihan pada form Document
      // Control (DCS) dan di manapun sebuah dokumen perlu ditandai per-unit
      // kerja.
      departments: ["HRD", "GA", "HSE", "Finance", "Legal"],
      // Narasi pembuka dokumen (kalimat awal + paragraf identifikasi Pihak
      // Pertama/Kedua), bisa dikustom PER KATEGORI di Library Klausul & Template.
      // Kosong/tak ada entri kategori = pakai DEFAULT_PREAMBLE_TEMPLATE bawaan
      // (lihat App.tsx). Template.openingParagraph (kalau diisi admin di
      // template tertentu) tetap jadi override tertinggi di atas ini.
      categoryOpeningParagraphs: {} as Record<string, string>,
      // Tipografi dokumen (item 7 fase 1) — gaya teks SELURUH dokumen kontrak
      // (narasi + pasal) di preview & PDF (PDF = html2canvas dari preview, jadi
      // gaya ini otomatis ikut tercetak). Per-tenant "house style". WYSIWYG
      // per-kata menyusul terpisah.
      documentTypography: {
        fontFamily: "serif" as "serif" | "sans" | "mono",
        fontSizePt: 11,
        lineHeight: 1.6,
        align: "justify" as "left" | "justify" | "center",
      },
    },
  };
}

export async function initFirebaseDB() {
  await initDB(createDefaultDB);
}

// REST APIs

// 1. CLAUSE LIBRARY
app.get("/api/clauses", requireAuth, (req: AuthedRequest, res) => {
  const db = loadDB();
  res.json(scoped(db.clauses as Clause[], tenantOf(req)));
});

app.get("/api/clause-categories", requireAuth, (req: AuthedRequest, res) => {
  const db = loadDB();
  res.json(catsFor(db, tenantOf(req)));
});

app.post("/api/clause-categories", requireAuth, requireRole("admin", "legal", "staff"), (req: AuthedRequest, res) => {
  const db = loadDB();
  const tid = tenantOf(req);
  const { category } = req.body;
  const cats = catsFor(db, tid);
  if (category && !cats.includes(category)) {
    setCatsFor(db, tid, [...cats, category]);
    pushAudit(db, req, { action: "Create Folder", details: `Menambahkan folder/kategori baru: "${category}"` });
    saveDB(db);
  }
  res.json({ success: true, categories: catsFor(db, tid) });
});

// Rename a folder/category everywhere it is referenced (cascade, within tenant)
app.put("/api/clause-categories", requireAuth, requireRole("admin", "legal"), (req: AuthedRequest, res) => {
  const db = loadDB();
  const tid = tenantOf(req);
  const { oldName, newName } = req.body;
  if (!oldName || !newName) return res.status(400).json({ error: "oldName & newName required" });
  const cats = catsFor(db, tid);
  if (cats.includes(newName)) return res.status(400).json({ error: "Nama folder sudah dipakai" });

  setCatsFor(db, tid, cats.map((c) => (c === oldName ? newName : c)));
  scoped(db.clauses as Clause[], tid).forEach((c) => { if (c.category === oldName) c.category = newName; });
  scoped(db.templates as Template[], tid).forEach((t) => { if (t.category === oldName) (t as any).category = newName; });
  scoped(db.contracts as Contract[], tid).forEach((c) => { if (c.category === oldName) c.category = newName; });
  pushAudit(db, req, { action: "Rename Folder", details: `Mengubah nama folder "${oldName}" menjadi "${newName}" (kontrak & klausul terkait ikut diperbarui)` });
  saveDB(db);
  res.json({ success: true, categories: catsFor(db, tid) });
});

// Delete a folder/category (blocked if still used by any contract in tenant)
app.delete("/api/clause-categories/:name", requireAuth, requireRole("admin"), (req: AuthedRequest, res) => {
  const db = loadDB();
  const tid = tenantOf(req);
  const name = decodeURIComponent(req.params.name);
  if (scoped(db.contracts as Contract[], tid).some((c) => c.category === name)) {
    return res.status(400).json({ error: "Folder masih dipakai kontrak. Pindahkan/hapus kontraknya dulu." });
  }
  setCatsFor(db, tid, catsFor(db, tid).filter((c) => c !== name));
  pushAudit(db, req, { action: "Delete Folder", details: `Menghapus folder/kategori: "${name}"` });
  saveDB(db);
  res.json({ success: true, categories: catsFor(db, tid) });
});

// Slug stabil untuk entri masterData.docTypes lama yang belum punya `id` —
// dipakai sebagai kunci defaultTemplateId/numberMask supaya tidak putus saat
// `name` diubah user. Fallback index-based kalau nama kosong/duplikat semua non-alnum.
function slugifyDocTypeId(name: string, index: number): string {
  const slug = (name || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  return slug ? `dt-${slug}` : `dt-${index}`;
}

// APP SETTINGS / KONFIGURASI (per tenant)
// Merge in fields added after a database was first created (e.g. `privy`),
// so older installs don't crash on missing keys.
function withSettingsDefaults(settings: any) {
  const defaults = defaultSettings();
  // Tenants that saved settings before certain keys were retired may still
  // carry them in their stored JSON — strip them here so they self-heal out
  // on every read/write instead of needing a one-off migration script.
  // internalDocKinds: replaced by Smart DCS's own dcs_document_types.
  // privy/eMaterai*/allowedSignMethods: retired with the digital-signature
  // feature (contract lifecycle is now Draft → Aktif without signing).
  const savedMasterData = { ...(settings?.masterData || {}) };
  delete savedMasterData.internalDocKinds;
  // docTypes adalah array, jadi merge dangkal di bawah akan MENGGANTI array
  // default sepenuhnya kalau tenant sudah punya list sendiri — backfill field
  // baru (id/defaultTemplateId/numberMask) di sini supaya tenant lama tetap
  // dapat identitas stabil tanpa migrasi terpisah.
  if (Array.isArray(savedMasterData.docTypes)) {
    savedMasterData.docTypes = savedMasterData.docTypes.map((d: any, i: number) => ({
      id: d.id || slugifyDocTypeId(d.name, i),
      name: d.name,
      categories: Array.isArray(d.categories) ? d.categories : [],
      defaultTemplateId: d.defaultTemplateId || "",
      numberMask: d.numberMask || "",
      // Modul tujuan jenis kontrak: "external" | "employee" | "both".
      // Data lama tanpa field ini = "both" (muncul di kontrak eksternal & karyawan).
      appliesTo: d.appliesTo === "external" || d.appliesTo === "employee" ? d.appliesTo : "both",
      // Kode singkat jenis (token {DocTypeCode}) & kode tambahan dinamis
      // ({Codes}). WAJIB dipertahankan di remap ini, kalau tidak akan ter-strip.
      code: typeof d.code === "string" ? d.code.trim().toUpperCase() : "",
      extraCodes: Array.isArray(d.extraCodes)
        ? d.extraCodes.map((c: any) => ({ label: String(c?.label || ""), value: String(c?.value || "") }))
        : [],
      // Kebijakan retensi arsip (tahun, dihitung sejak dokumen jadi non-aktif).
      // WAJIB dipertahankan di remap ini, kalau tidak akan ter-strip.
      // undefined/0 = retensi belum diatur untuk jenis ini — dokumen jenis
      // ini TIDAK PERNAH dianggap "boleh dimusnahkan" sampai diisi eksplisit,
      // supaya kebijakan retensi tidak diam-diam berlaku sebelum administrator
      // benar-benar memutuskan angkanya.
      retentionYears: Number.isFinite(Number(d.retentionYears)) && Number(d.retentionYears) > 0 ? Number(d.retentionYears) : undefined,
    }));
  }
  // Upgrade default: mask LAMA (atau kosong) dianggap belum dikustom → pakai
  // default baru gaya referensi. Mask yang benar-benar dikustom tak diubah.
  if (!savedMasterData.defaultNumberMask || savedMasterData.defaultNumberMask === LEGACY_DEFAULT_MASK) {
    savedMasterData.defaultNumberMask = REFERENCE_DEFAULT_MASK;
  }
  const merged: any = {
    ...defaults,
    ...settings,
    // Per-key merge (bukan replace utuh): tenant lama yang settings-nya
    // tersimpan sebelum sebuah list masterData baru ditambahkan tetap dapat
    // default untuk list tsb, tanpa menimpa list yang sudah mereka kustom.
    masterData: { ...defaults.masterData, ...savedMasterData },
  };
  delete merged.privy;
  delete merged.eMateraiEnabled;
  delete merged.eMateraiThreshold;
  delete merged.allowedSignMethods;
  return merged;
}

app.get("/api/settings", requireAuth, (req: AuthedRequest, res) => {
  const db = loadDB();
  res.json(withSettingsDefaults(rawSettingsFor(db, tenantOf(req))));
});

app.put("/api/settings", requireAuth, requireRole("admin"), (req: AuthedRequest, res) => {
  const db = loadDB();
  const tid = tenantOf(req);
  const { tenantId, ...patch } = req.body; // tenantId handled by tenantOf, not stored in settings
  // Validasi format nomor kontrak sebelum disimpan — mask tak valid baru
  // ketahuan saat generateContractNumber() dipanggil (throw) kalau tidak
  // dicegat di sini.
  const mdPatch = patch?.masterData;
  if (mdPatch?.defaultNumberMask) {
    const err = validateMask(mdPatch.defaultNumberMask, CONTRACT_MASK_TOKENS);
    if (err) return res.status(400).json({ error: `Format Nomor Default: ${err}` });
  }
  if (Array.isArray(mdPatch?.docTypes)) {
    for (const dt of mdPatch.docTypes) {
      if (dt.numberMask) {
        const err = validateMask(dt.numberMask, CONTRACT_MASK_TOKENS);
        if (err) return res.status(400).json({ error: `Format Nomor untuk "${dt.name}": ${err}` });
      }
    }
  }
  const merged = withSettingsDefaults({ ...rawSettingsFor(db, tid), ...patch });
  setSettingsFor(db, tid, merged);
  pushAudit(db, req, { action: "Update Settings", details: "Memperbarui konfigurasi (perusahaan / master data)" });
  saveDB(db);
  res.json({ success: true, settings: merged });
});

app.post("/api/clauses", requireAuth, requireRole("admin", "legal", "staff"), (req: AuthedRequest, res) => {
  const db = loadDB();
  const tid = tenantOf(req);
  const newClause: Clause = {
    id: "cls-" + Date.now(),
    tenantId: tid,
    title: req.body.title,
    content: req.body.content,
    category: req.body.category || "General",
    tags: req.body.tags || [],
    isMandatory: !!req.body.isMandatory,
    isProtected: !!req.body.isProtected,
    version: 1
  };
  db.clauses.push(newClause);
  pushAudit(db, req, { action: "Create Clause", details: `Menambahkan klausul baru: "${newClause.title}"` });
  saveDB(db);
  res.json({ success: true, clause: newClause });
});

app.put("/api/clauses/:id", requireAuth, requireRole("admin", "legal", "staff"), (req: AuthedRequest, res) => {
  const db = loadDB();
  const tid = tenantOf(req);
  const idx = db.clauses.findIndex((c: Clause) => c.id === req.params.id && c.tenantId === tid);
  if (idx !== -1) {
    // Klausul terproteksi hanya boleh diubah oleh legal/admin.
    if (db.clauses[idx].isProtected && !["admin", "legal", "super_admin"].includes(req.user!.role)) {
      return res.status(403).json({ error: "Klausul ini terproteksi — hanya Legal/Admin yang boleh mengubah." });
    }
    db.clauses[idx] = {
      ...db.clauses[idx],
      title: req.body.title,
      content: req.body.content,
      category: req.body.category || db.clauses[idx].category,
      tags: req.body.tags || db.clauses[idx].tags,
      isMandatory: req.body.isMandatory !== undefined ? !!req.body.isMandatory : db.clauses[idx].isMandatory,
      isProtected: req.body.isProtected !== undefined ? !!req.body.isProtected : db.clauses[idx].isProtected,
      version: db.clauses[idx].version + 1
    };
    saveDB(db);
    res.json({ success: true, clause: db.clauses[idx] });
  } else {
    res.status(404).json({ error: "Clause not found" });
  }
});

app.delete("/api/clauses/:id", requireAuth, requireRole("admin", "legal"), (req: AuthedRequest, res) => {
  const db = loadDB();
  const tid = tenantOf(req);
  db.clauses = db.clauses.filter((c: Clause) => !(c.id === req.params.id && c.tenantId === tid));
  saveDB(db);
  res.json({ success: true });
});


// 2. TEMPLATES
app.get("/api/templates", requireAuth, (req: AuthedRequest, res) => {
  const db = loadDB();
  res.json(scoped(db.templates as Template[], tenantOf(req)));
});

app.post("/api/templates", requireAuth, requireRole("admin", "legal", "staff"), (req: AuthedRequest, res) => {
  const db = loadDB();
  const newTemplate: Template = {
    id: "tmp-" + Date.now(),
    tenantId: tenantOf(req),
    name: req.body.name,
    description: req.body.description,
    category: req.body.category,
    clauseIds: req.body.clauseIds || [],
    requiredVariables: req.body.requiredVariables || [],
    parties: req.body.parties || ["Pihak Pertama", "Pihak Kedua"],
    openingParagraph: req.body.openingParagraph || undefined,
    closingParagraph: req.body.closingParagraph || undefined,
    addendumRecitalParagraph: req.body.addendumRecitalParagraph || undefined,
  };
  db.templates.push(newTemplate);
  pushAudit(db, req, { action: "Create Template", details: `Membuat master template baru: "${newTemplate.name}" (${newTemplate.clauseIds.length} pasal)` });
  saveDB(db);
  res.json({ success: true, template: newTemplate });
});

app.delete("/api/templates/:id", requireAuth, requireRole("admin", "legal"), (req: AuthedRequest, res) => {
  const db = loadDB();
  const tid = tenantOf(req);
  const target = db.templates.find((t: Template) => t.id === req.params.id && t.tenantId === tid);
  db.templates = db.templates.filter((t: Template) => !(t.id === req.params.id && t.tenantId === tid));
  if (target) pushAudit(db, req, { action: "Delete Template", details: `Menghapus master template: "${target.name}"` });
  saveDB(db);
  res.json({ success: true });
});

app.put("/api/templates/:id", requireAuth, requireRole("admin", "legal", "staff"), (req: AuthedRequest, res) => {
  const db = loadDB();
  const tid = tenantOf(req);
  const idx = db.templates.findIndex((t: Template) => t.id === req.params.id && t.tenantId === tid);
  if (idx !== -1) {
    const lama = db.templates[idx];
    const baru = {
      ...lama,
      name: req.body.name || lama.name,
      description: req.body.description || lama.description,
      category: req.body.category || lama.category,
      clauseIds: req.body.clauseIds || lama.clauseIds,
      requiredVariables: req.body.requiredVariables || lama.requiredVariables,
      parties: req.body.parties || lama.parties,
      openingParagraph: req.body.openingParagraph !== undefined ? (req.body.openingParagraph || undefined) : lama.openingParagraph,
      closingParagraph: req.body.closingParagraph !== undefined ? (req.body.closingParagraph || undefined) : lama.closingParagraph,
      addendumRecitalParagraph: req.body.addendumRecitalParagraph !== undefined ? (req.body.addendumRecitalParagraph || undefined) : lama.addendumRecitalParagraph,
    };
    // Versi naik HANYA bila yang berubah benar-benar memengaruhi isi dokumen.
    // Mengganti nama atau deskripsi template bukan perubahan redaksi, jadi
    // tidak boleh membuat semua kontrak lama terlihat "memakai versi usang".
    const FIELD_REDAKSI = ["clauseIds", "parties", "openingParagraph", "closingParagraph", "addendumRecitalParagraph"] as const;
    const redaksiBerubah = FIELD_REDAKSI.some((k) => JSON.stringify((lama as any)[k] ?? null) !== JSON.stringify((baru as any)[k] ?? null));
    if (redaksiBerubah) {
      baru.version = (Number(lama.version) || 1) + 1;
      baru.updatedAt = new Date().toISOString();
      baru.updatedByName = req.user!.name;
      pushAudit(db, req, {
        action: "Ubah Redaksi Template",
        details: `Template "${baru.name}" naik ke versi ${baru.version} — kontrak yang sudah dibuat tetap memakai redaksi versi sebelumnya`,
      });
    }
    db.templates[idx] = baru;
    saveDB(db);
    res.json({ success: true, template: db.templates[idx], versionBumped: redaksiBerubah });
  } else {
    res.status(404).json({ error: "Template not found" });
  }
});


// 3. INTEGRATED MODULES (HR & VENDORS)
app.get("/api/modules/employees", requireAuth, (req: AuthedRequest, res) => {
  const db = loadDB();
  res.json(scoped(db.employees as EmployeeData[], tenantOf(req)));
});

app.post("/api/modules/employees", requireAuth, requireRole("admin", "staff"), (req: AuthedRequest, res) => {
  const db = loadDB();
  const emp: EmployeeData = {
    id: "EMP" + Date.now(),
    tenantId: tenantOf(req),
    name: req.body.name,
    position: req.body.position || "",
    department: req.body.department || "",
    salary: Number(req.body.salary) || 0,
    startDate: req.body.startDate || "",
  };
  db.employees.push(emp);
  saveDB(db);
  res.json({ success: true, employee: emp });
});

app.put("/api/modules/employees/:id", requireAuth, requireRole("admin", "staff"), (req: AuthedRequest, res) => {
  const db = loadDB();
  const tid = tenantOf(req);
  const idx = db.employees.findIndex((e: EmployeeData) => e.id === req.params.id && e.tenantId === tid);
  if (idx === -1) return res.status(404).json({ error: "Employee not found" });
  db.employees[idx] = { ...db.employees[idx], ...req.body, id: db.employees[idx].id, tenantId: tid };
  saveDB(db);
  res.json({ success: true, employee: db.employees[idx] });
});

app.delete("/api/modules/employees/:id", requireAuth, requireRole("admin", "staff"), (req: AuthedRequest, res) => {
  const db = loadDB();
  const tid = tenantOf(req);
  db.employees = db.employees.filter((e: EmployeeData) => !(e.id === req.params.id && e.tenantId === tid));
  saveDB(db);
  res.json({ success: true });
});

app.get("/api/modules/vendors", requireAuth, (req: AuthedRequest, res) => {
  const db = loadDB();
  res.json(scoped(db.vendors as VendorData[], tenantOf(req)));
});

app.post("/api/modules/vendors", requireAuth, requireRole("admin", "staff"), (req: AuthedRequest, res) => {
  const db = loadDB();
  const vendor: VendorData = {
    id: "VND" + Date.now(),
    tenantId: tenantOf(req),
    name: req.body.name,
    picName: req.body.picName || "",
    picPhone: req.body.picPhone || "",
    email: req.body.email || "",
    npwp: req.body.npwp || "",
    address: req.body.address || "",
    bankAccountNumber: req.body.bankAccountNumber || "",
    bankAccountName: req.body.bankAccountName || "",
    bankName: req.body.bankName || "",
    bankBranch: req.body.bankBranch || "",
    pphRatePercent: req.body.pphRatePercent !== undefined ? Number(req.body.pphRatePercent) : undefined,
  };
  db.vendors.push(vendor);
  pushAudit(db, req, { action: "Create Vendor", details: `Menambahkan rekanan/vendor: "${vendor.name}"` });
  saveDB(db);
  res.json({ success: true, vendor });
});

app.put("/api/modules/vendors/:id", requireAuth, requireRole("admin", "staff"), (req: AuthedRequest, res) => {
  const db = loadDB();
  const tid = tenantOf(req);
  const idx = db.vendors.findIndex((v: VendorData) => v.id === req.params.id && v.tenantId === tid);
  if (idx === -1) return res.status(404).json({ error: "Vendor not found" });
  db.vendors[idx] = { ...db.vendors[idx], ...req.body, id: db.vendors[idx].id, tenantId: tid };
  saveDB(db);
  res.json({ success: true, vendor: db.vendors[idx] });
});

app.delete("/api/modules/vendors/:id", requireAuth, requireRole("admin", "staff"), (req: AuthedRequest, res) => {
  const db = loadDB();
  const tid = tenantOf(req);
  db.vendors = db.vendors.filter((v: VendorData) => !(v.id === req.params.id && v.tenantId === tid));
  saveDB(db);
  res.json({ success: true });
});

// SUB-FOLDERS (arsip 3-layer: kategori/folder utama > sub folder > sub-sub folder)
app.get("/api/subfolders", requireAuth, (req: AuthedRequest, res) => {
  const db = loadDB();
  const tid = tenantOf(req);
  let list = scoped(db.subFolders as SubFolder[], tid);
  if (req.query.category) list = list.filter((f) => f.category === req.query.category);
  res.json(list);
});

app.post("/api/subfolders", requireAuth, requireRole("admin", "staff", "legal", "manager"), (req: AuthedRequest, res) => {
  const db = loadDB();
  const tid = tenantOf(req);
  const { category, parentId, name } = req.body;
  if (!category || !name || !String(name).trim()) {
    return res.status(400).json({ error: "category dan name wajib diisi" });
  }
  if (parentId) {
    const parent = (db.subFolders as SubFolder[]).find((f) => f.id === parentId && f.tenantId === tid);
    if (!parent) return res.status(400).json({ error: "Parent folder tidak ditemukan" });
    // Dulu ada batas keras "maksimal 2 level" di sini (ditolak kalau parent-
    // nya sendiri sudah punya parent). Dihapus atas permintaan user — sub
    // folder sekarang boleh bersarang berapa level pun, tidak ada langit-
    // langit lagi. Padanan di frontend (canAddDeeper, src/App.tsx) dihapus
    // di request yang sama.
    if (parent.category !== category) {
      return res.status(400).json({ error: "Parent folder harus berada di kategori yang sama" });
    }
  }
  const folder: SubFolder = {
    id: `sf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    tenantId: tid,
    category,
    parentId: parentId || null,
    name: String(name).trim(),
    createdAt: new Date().toISOString(),
  };
  db.subFolders.push(folder);
  saveDB(db);
  res.json(folder);
});

app.put("/api/subfolders/:id", requireAuth, requireRole("admin", "staff", "legal", "manager"), (req: AuthedRequest, res) => {
  const db = loadDB();
  const tid = tenantOf(req);
  const folder = (db.subFolders as SubFolder[]).find((f) => f.id === req.params.id && f.tenantId === tid);
  if (!folder) return res.status(404).json({ error: "Folder tidak ditemukan" });
  if (req.body.name !== undefined && String(req.body.name).trim()) {
    folder.name = String(req.body.name).trim();
  }
  saveDB(db);
  res.json(folder);
});

app.delete("/api/subfolders/:id", requireAuth, requireRole("admin", "staff", "legal", "manager"), (req: AuthedRequest, res) => {
  const db = loadDB();
  const tid = tenantOf(req);
  const folder = (db.subFolders as SubFolder[]).find((f) => f.id === req.params.id && f.tenantId === tid);
  if (!folder) return res.status(404).json({ error: "Folder tidak ditemukan" });
  const hasChildren = (db.subFolders as SubFolder[]).some((f) => f.parentId === folder.id && f.tenantId === tid);
  if (hasChildren) {
    return res.status(400).json({ error: "Folder ini masih punya sub folder di dalamnya. Hapus sub folder tersebut dulu." });
  }
  const usedByContract = (db.contracts as Contract[]).some((c) => c.subFolderId === folder.id && c.tenantId === tid);
  if (usedByContract) {
    return res.status(400).json({ error: "Folder masih dipakai kontrak. Pindahkan/hapus kontraknya dulu." });
  }
  db.subFolders = db.subFolders.filter((f: SubFolder) => f.id !== folder.id);
  saveDB(db);
  res.json({ success: true });
});

// NOTE: The legacy internal_docs (SOP/Memo) REST module was removed and
// replaced by Smart DCS (/api/dcs, see dcs/routes.ts) — a normalized,
// ISO-9001 document-control module with proper versioning, an approval state
// machine, atomic auto-obsolete, and reactive watermarking. The old JSONB
// `internalDocs` collection is left untouched in the datastore for historical
// data but is no longer served or written.


// 4. CONTRACTS
// Nama perusahaan (Pihak Pertama) diambil dari settings/tenant, bukan hardcode.
function companyNameFor(db: any, tid: string): string {
  return rawSettingsFor(db, tid).companyName
    || (db.tenants as any[]).find((t) => t.id === tid)?.name
    || "Perusahaan";
}
// Temukan kontrak yang benar-benar milik tenant si pemanggil.
function findOwnedContract(db: any, req: AuthedRequest, id: string): Contract | undefined {
  const tid = tenantOf(req);
  return (db.contracts as Contract[]).find((c) => c.id === id && c.tenantId === tid);
}

app.get("/api/contracts", requireAuth, (req: AuthedRequest, res) => {
  const db = loadDB();
  res.json(scoped(db.contracts as Contract[], tenantOf(req)));
});

app.get("/api/contracts/generate-number", requireAuth, (req: AuthedRequest, res) => {
  const category = (req.query.category as string) || "General";
  const docType = (req.query.docType as string) || undefined;
  const db = loadDB();
  const tid = tenantOf(req);
  const currentYear = new Date().getFullYear().toString();
  // Pratinjau: JANGAN konsumsi nomor (consume:false) — cuma tampilkan calon nomor.
  const { number } = generateContractNumber(db, tid, category, docType, currentYear, { consume: false });
  res.json({ contractNumber: number });
});

app.get("/api/contracts/:id", requireAuth, (req: AuthedRequest, res) => {
  const db = loadDB();
  const contract = findOwnedContract(db, req, req.params.id);
  if (contract) res.json(contract);
  else res.status(404).json({ error: "Contract not found" });
});

// Token yang boleh dipakai di masterData.defaultNumberMask / docTypes[].numberMask
// — {Sequence} selalu diizinkan (divalidasi terpisah oleh validateMask).
//
// {Day} disamakan dengan daftar token mesin penomoran DCS (dcs/routes.ts,
// DCS_MASK_TOKENS) — sebelumnya hanya ada di sisi DCS tanpa alasan bisnis,
// murni kesenjangan implementasi antara dua mesin yang sebenarnya berbagi
// renderMask() yang sama (numbering-utils.ts).
const CONTRACT_MASK_TOKENS = ["Prefix", "Category", "DocType", "DocTypeCode", "Codes", "MonthRoman", "Year", "Month", "Day"];

const CONTRACT_CODE_SEP = "/"; // pemisah antar kode tambahan (extraCodes) di {Codes}

function contractScopeKey(tid: string, category: string, docType: string | undefined, year: string): string {
  const dtKey = (docType || "").trim() || (category || "default").trim();
  return `${tid}|${dtKey}|${year}`;
}

// Baseline saat sebuah scope PERTAMA kali dipakai counter persisten: hitung per
// Jenis Dokumen (docType) + tahun (atau kategori jika docType tidak ada).
function contractScopeBaseline(db: any, tid: string, category: string, docType: string | undefined, year: string): number {
  const dtKey = (docType || "").trim();
  const inScope = scoped(db.contracts as Contract[], tid).filter((c) => {
    const cYear = (c.createdAt || "").slice(0, 4);
    if (cYear !== year) return false;
    if (dtKey) return (c.docType || "").trim() === dtKey;
    return (c.category || "").trim() === (category || "").trim();
  });
  let maxSeq = 0;
  for (const c of inScope) {
    const s = (c as any).numberSeq;
    if (typeof s === "number" && s > maxSeq) maxSeq = s;
  }
  return Math.max(maxSeq, inScope.length);
}

/**
 * Potret redaksi template untuk disimpan di kontrak. Tanpa ini, mengedit
 * paragraf pembuka sebuah template diam-diam mengubah pembuka SEMUA kontrak
 * lama yang memakai template itu — termasuk yang sudah aktif & ditandatangani.
 * Pola yang sama sudah dipakai vendorSnapshot.
 */
function captureTemplateSnapshot(db: any, tid: string, templateId: string | undefined) {
  if (!templateId) return undefined;
  const t = (db.templates as Template[]).find((x) => x.id === templateId && x.tenantId === tid);
  if (!t) return undefined;
  return {
    templateId: t.id,
    templateName: t.name,
    version: Number(t.version) || 1,
    capturedAt: new Date().toISOString(),
    openingParagraph: t.openingParagraph,
    closingParagraph: t.closingParagraph,
    addendumRecitalParagraph: t.addendumRecitalParagraph,
  };
}

// Auto agreement number, format token dinamis (lihat numbering-utils.ts).
// Penomoran berpatokan tunggal pada Jenis Dokumen (docType) jika dipilih.
// Nomor urut memakai COUNTER PERSISTEN per (tenant|jenis|tahun) di db.numberCounters.
function generateContractNumber(
  db: any, tid: string, category: string, docType: string | undefined, year: string,
  opts?: { consume?: boolean },
): { number: string; seq: number } {
  const consume = opts?.consume !== false;
  const md = withSettingsDefaults(rawSettingsFor(db, tid)).masterData;
  const dtObj = docType ? (md.docTypes || []).find((d: any) => d.name === docType) : undefined;
  
  // Single Source of Truth untuk Kode Dokumen: diambil dari dtObj.code jika ada.
  // Kalau kolom Kode dibiarkan kosong, JANGAN jatuh ke defaultNumberPrefix —
  // semua jenis tanpa kode akan memakai prefix yang sama sehingga dua jenis
  // berbeda menghasilkan nomor yang terlihat kembar (mis. dua-duanya
  // "001/GA-AGR/VII/2026") walau counter-nya terpisah. Turunkan singkatan dari
  // nama jenisnya dulu; defaultNumberPrefix hanya untuk kontrak tanpa jenis.
  const explicitCode = String(dtObj?.code || "").trim().toUpperCase();
  const dtCode = explicitCode || (docType ? suggestDocTypeCode(docType) : "");
  const prefix = dtCode || md.defaultNumberPrefix || "GA-AGR";
  let mask = dtObj?.numberMask || md.defaultNumberMask || REFERENCE_DEFAULT_MASK;
  if (mask === LEGACY_DEFAULT_MASK) mask = REFERENCE_DEFAULT_MASK;

  if (!Array.isArray(db.numberCounters)) db.numberCounters = [];
  const key = contractScopeKey(tid, category, docType, year);
  let rec = (db.numberCounters as any[]).find((r) => r.id === key);
  if (!rec) {
    rec = { id: key, tenantId: tid, seq: contractScopeBaseline(db, tid, category, docType, year) };
    db.numberCounters.push(rec);
  }
  // Nomor yang DILEPAS (dokumen batal terbit) dipakai ulang lebih dulu, dari
  // yang terkecil — supaya tidak ada lubang di urutan. Baru kalau kolamnya
  // kosong, counter naik seperti biasa. Pelepasan sendiri dijaga ketat di
  // endpoint release-number (hanya dokumen yang belum pernah beredar).
  const released: number[] = Array.isArray(rec.released) ? rec.released : [];
  const recycled = released.length > 0 ? Math.min(...released) : null;
  const seq = recycled !== null ? recycled : rec.seq + 1;
  if (consume) {
    if (recycled !== null) rec.released = released.filter((n) => n !== recycled);
    else rec.seq = seq;
  }

  const codes = Array.isArray(dtObj?.extraCodes)
    ? dtObj.extraCodes.map((c: any) => String(c?.value || "").trim().toUpperCase()).filter(Boolean).join(CONTRACT_CODE_SEP)
    : "";
  const now = new Date();
  const number = renderMask(mask, {
    Prefix: prefix, Category: category, DocType: docType || "",
    DocTypeCode: dtCode || prefix, Codes: codes,
    Year: Number(year), Month: now.getMonth() + 1, Day: now.getDate(),
  }, seq);
  return { number, seq };
}

// Validasi & normalisasi baris sharing fee dari request body — dipakai oleh
// POST /contracts dan POST /contracts/:id/addendum supaya aturannya konsisten
// di kedua alur (bukan cuma dicegat di frontend, sama seperti mask di atas).
// undefined/bukan array = tidak ada sharing fee (kontrak biasa) → array kosong,
// bukan error, karena field ini opsional ("jika ada sharing fee").
// Bentuk return SATU shape (bukan discriminated union true/false) dengan
// `error` opsional — proyek ini tidak mengaktifkan strict/strictNullChecks
// di tsconfig, jadi narrowing union lewat `if (!result.ok)` tidak selalu
// konsisten diakui compiler; shape tunggal ini menghindarinya sepenuhnya.
function normalizeSharingFeeItems(raw: unknown): { ok: boolean; items: ContractSharingFeeItem[]; error?: string } {
  if (raw === undefined || raw === null) return { ok: true, items: [] };
  if (!Array.isArray(raw)) return { ok: false, items: [], error: "Format sharing fee tidak valid." };
  const items: ContractSharingFeeItem[] = [];
  for (const [i, it] of raw.entries()) {
    const productType = String((it as any)?.productType || "").trim();
    if (!productType) return { ok: false, items: [], error: `Jenis produk pada baris sharing fee ke-${i + 1} wajib diisi.` };
    const rawFeeType = (it as any)?.feeType;
    const feeType: "percentage" | "nominal" | null = rawFeeType === "nominal" ? "nominal" : rawFeeType === "percentage" ? "percentage" : null;
    if (!feeType) return { ok: false, items: [], error: `Tipe fee untuk "${productType}" harus persentase atau nominal.` };
    const value = Number((it as any)?.value);
    if (!Number.isFinite(value) || value < 0) return { ok: false, items: [], error: `Nilai fee untuk "${productType}" harus berupa angka >= 0.` };
    if (feeType === "percentage" && value > 100) return { ok: false, items: [], error: `Persentase fee untuk "${productType}" tidak boleh lebih dari 100%.` };
    const id = typeof (it as any)?.id === "string" && (it as any).id ? (it as any).id : `sf-${Date.now()}-${i}`;
    items.push({ id, productType, feeType, value });
  }
  return { ok: true, items };
}

/**
 * Validasi & normalisasi jadwal termin pembayaran. Mengikuti bentuk yang sama
 * dengan normalizeSharingFeeItems: satu shape return, `error` opsional.
 *
 * `undefined` = field tidak dikirim sama sekali (jangan diubah). Array kosong
 * = memang dikosongkan. Dua hal itu HARUS dibedakan, kalau tidak setiap PUT
 * yang tidak menyertakan paymentTerms akan menghapus seluruh jadwalnya.
 */
function normalizePaymentTerms(raw: unknown): { ok: boolean; items?: ContractPaymentTerm[]; error?: string } {
  if (raw === undefined) return { ok: true, items: undefined };
  if (raw === null) return { ok: true, items: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "Format termin pembayaran tidak valid." };
  if (raw.length > 60) return { ok: false, error: "Maksimal 60 termin pembayaran dalam satu kontrak." };
  const items: ContractPaymentTerm[] = [];
  for (const [i, it] of raw.entries()) {
    const t = it as any;
    const label = String(t?.label || "").trim();
    if (!label) return { ok: false, error: `Nama termin ke-${i + 1} wajib diisi.` };
    const dueDate = String(t?.dueDate || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return { ok: false, error: `Tanggal jatuh tempo "${label}" wajib diisi.` };
    const amountType: "nominal" | "percentage" = t?.amountType === "percentage" ? "percentage" : "nominal";
    const amount = Number(t?.amount);
    if (!Number.isFinite(amount) || amount < 0) return { ok: false, error: `Nilai "${label}" harus berupa angka >= 0.` };
    if (amountType === "percentage" && amount > 100) return { ok: false, error: `Persentase "${label}" tidak boleh lebih dari 100%.` };
    const status = ["belum", "ditagih", "lunas", "batal"].includes(t?.status) ? t.status : "belum";
    const paidAmount = Number(t?.paidAmount);
    const paidDate = String(t?.paidDate || "").slice(0, 10);
    if (paidDate && !/^\d{4}-\d{2}-\d{2}$/.test(paidDate)) return { ok: false, error: `Tanggal bayar "${label}" tidak valid.` };
    // Ditandai lunas tapi tanpa nilai yang diterima = data yang tidak bisa
    // direkonsiliasi. Ditolak di server, bukan cuma diingatkan di UI.
    if (status === "lunas" && (!Number.isFinite(paidAmount) || paidAmount <= 0)) {
      return { ok: false, error: `"${label}" ditandai lunas — isi juga nilai yang diterima.` };
    }
    items.push({
      id: typeof t?.id === "string" && t.id ? t.id : `pt-${Date.now()}-${i}`,
      label, dueDate, amountType, amount, status,
      invoiceNumber: String(t?.invoiceNumber || "").trim() || undefined,
      paidDate: paidDate || undefined,
      paidAmount: Number.isFinite(paidAmount) && paidAmount > 0 ? paidAmount : undefined,
      notes: String(t?.notes || "").slice(0, 300) || undefined,
      lastDueNudgeDate: typeof t?.lastDueNudgeDate === "string" ? t.lastDueNudgeDate : undefined,
    });
  }
  return { ok: true, items };
}

/** Validasi kewajiban kontrak. Bentuk return sama seperti normalizePaymentTerms. */
/** Validasi evaluasi kinerja vendor. undefined = tidak diubah; null = dihapus (dievaluasi ulang dari kosong). */
function normalizeVendorEvaluation(raw: unknown, evaluatorName: string): { ok: boolean; value?: ContractVendorEvaluation | null; error?: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null) return { ok: true, value: null };
  const t = raw as any;
  const rating = Number(t?.rating);
  if (!Number.isFinite(rating) || rating < 1 || rating > 5 || !Number.isInteger(rating)) {
    return { ok: false, error: "Rating evaluasi vendor harus bilangan bulat 1-5." };
  }
  const disputeCount = Number(t?.disputeCount);
  if (!Number.isFinite(disputeCount) || disputeCount < 0) {
    return { ok: false, error: "Jumlah sengketa harus angka >= 0." };
  }
  return {
    ok: true,
    value: {
      rating, disputeCount: Math.round(disputeCount),
      onTimeDelivery: typeof t?.onTimeDelivery === "boolean" ? t.onTimeDelivery : undefined,
      notes: String(t?.notes || "").slice(0, 300) || undefined,
      evaluatedByName: evaluatorName,
      evaluatedAt: new Date().toISOString(),
    },
  };
}

function normalizeObligations(db: any, tid: string, raw: unknown): { ok: boolean; items?: ContractObligation[]; error?: string } {
  if (raw === undefined) return { ok: true, items: undefined };
  if (raw === null) return { ok: true, items: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "Format kewajiban tidak valid." };
  if (raw.length > 100) return { ok: false, error: "Maksimal 100 kewajiban dalam satu kontrak." };
  const items: ContractObligation[] = [];
  for (const [i, it] of raw.entries()) {
    const t = it as any;
    const title = String(t?.title || "").trim();
    if (!title) return { ok: false, error: `Nama kewajiban ke-${i + 1} wajib diisi.` };
    const dueDate = String(t?.dueDate || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return { ok: false, error: `Tanggal jatuh tempo "${title}" wajib diisi.` };
    const recurrence = ["none", "monthly", "quarterly", "yearly"].includes(t?.recurrence) ? t.recurrence : "none";
    const status = ["open", "done", "waived"].includes(t?.status) ? t.status : "open";
    // Penanggung jawab diverifikasi ke daftar user tenant ini — nama yang
    // diketik bebas dari client tidak bisa dipercaya untuk menargetkan
    // notifikasi. Nama ikut disimpan (denormalisasi) supaya riwayat tetap
    // terbaca walau user-nya dihapus kemudian.
    let ownerId: string | undefined;
    let ownerName: string | undefined;
    if (t?.ownerId) {
      const u = (db.users as User[]).find((x) => x.id === t.ownerId && x.tenantId === tid);
      if (!u) return { ok: false, error: `Penanggung jawab "${title}" tidak ditemukan di perusahaan ini.` };
      ownerId = u.id; ownerName = u.name;
    }
    items.push({
      id: typeof t?.id === "string" && t.id ? t.id : `ob-${Date.now()}-${i}`,
      title, dueDate, recurrence, status, ownerId, ownerName,
      clauseId: String(t?.clauseId || "") || undefined,
      clauseTitle: String(t?.clauseTitle || "") || undefined,
      completedAt: typeof t?.completedAt === "string" ? t.completedAt : undefined,
      completedByName: typeof t?.completedByName === "string" ? t.completedByName : undefined,
      notes: String(t?.notes || "").slice(0, 300) || undefined,
      lastDueNudgeDate: typeof t?.lastDueNudgeDate === "string" ? t.lastDueNudgeDate : undefined,
    });
  }
  return { ok: true, items };
}

// Snapshot data master vendor PADA SAAT kontrak dibuat (lihat komentar
// ContractVendorSnapshot di types.ts) — sengaja dibangun ULANG dari db.vendors
// di server, TIDAK dari field snapshot yang mungkin dikirim client, supaya
// data finansial (PPh, rekening bank) tidak bisa dipalsukan lewat request body.
function buildVendorSnapshot(db: any, tid: string, vendorId: unknown): ContractVendorSnapshot | undefined {
  if (typeof vendorId !== "string" || !vendorId) return undefined;
  const v = (db.vendors as VendorData[]).find((x) => x.id === vendorId && x.tenantId === tid);
  if (!v) return undefined;
  return {
    vendorId: v.id, name: v.name, npwp: v.npwp, picName: v.picName, picPhone: v.picPhone,
    email: v.email, address: v.address, bankAccountNumber: v.bankAccountNumber,
    bankAccountName: v.bankAccountName, bankName: v.bankName, bankBranch: v.bankBranch,
    pphRatePercent: v.pphRatePercent,
  };
}

app.post("/api/master-contracts/upload", requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const stored = await storeFile(req.file.buffer, uploadFileKey(req.file.originalname), req.file.mimetype);
  res.json({ url: stored.url });
});

// Upload lampiran dokumen DCS (Word/PDF langsung, bukan form terstruktur di
// sistem) — hasilnya cuma URL, dipakai mengisi field `appendix[].url` yang
// sudah ada, tanpa perubahan skema.
app.post("/api/dcs/lampiran-upload", requireAuth, uploadLampiran.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Tidak ada berkas diunggah" });
  const stored = await storeFile(req.file.buffer, uploadFileKey(req.file.originalname), req.file.mimetype);
  res.json({ url: stored.url, name: req.file.originalname });
});

// Company logo upload (for the DCS letterhead preset). Returns both the
// public url (for the settings-page thumbnail) and the raw storage key (for
// dcs/routes.ts to fetchFile() at compose time) — same two-step convention
// as master-contracts/upload: this just uploads, the caller still needs to
// PUT /api/settings to actually persist the returned fields onto the tenant.
app.post("/api/settings/company-logo", requireAuth, requireRole("admin"), upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Tidak ada berkas" });
  if (!/^image\/(png|jpe?g)$/.test(req.file.mimetype)) {
    return res.status(400).json({ error: "Logo harus berformat PNG atau JPEG" });
  }
  const key = `company-logo-${Date.now()}-${req.file.originalname.replace(/[^\w.\-]/g, "_")}`;
  const stored = await storeFile(req.file.buffer, key, req.file.mimetype);
  res.json({ url: stored.url, key: stored.key, mimeType: req.file.mimetype });
});

// Upload logo Pihak Kedua — beda dari company-logo di atas (yang tenant-wide
// utk Pihak Pertama/perusahaan sendiri): ini per-kontrak, jadi TIDAK
// menyimpan ke appSettings sama sekali, cuma mengunggah berkas & balikin
// url/key-nya. Penyimpanan ke field party2LogoUrl kontrak terjadi lewat PUT
// /api/contracts/:id yang sudah ada (lihat komentar showLetterhead/
// party2LogoUrl di situ) — konsisten dgn alur "Edit Data Pihak & Kontrak" yg
// juga baru benar-benar tersimpan setelah tombol Simpan di modal itu diklik.
app.post("/api/contracts/:id/party2-logo", requireAuth, requireRole("admin", "staff", "legal", "manager"), upload.single("file"), async (req: AuthedRequest, res) => {
  if (!req.file) return res.status(400).json({ error: "Tidak ada berkas" });
  if (!/^image\/(png|jpe?g)$/.test(req.file.mimetype)) {
    return res.status(400).json({ error: "Logo harus berformat PNG atau JPEG" });
  }
  const key = `party2-logo-${req.params.id}-${Date.now()}-${req.file.originalname.replace(/[^\w.\-]/g, "_")}`;
  const stored = await storeFile(req.file.buffer, key, req.file.mimetype);
  res.json({ url: stored.url, key: stored.key, mimeType: req.file.mimetype });
});

// Bangun daftar rangkap fisik kontrak dari pilihan form (jumlah rangkap +
// bermeterai/tidak). Konvensi meterai rangkap 2 mengikuti praktik umum:
// rangkap pertama meterai di sisi Pihak Pertama, rangkap kedua di sisi
// Pihak Kedua — labelnya eksplisit agar tertulis jelas di arsip & cetakan.
function buildContractCopies(copyCount: number, hasMaterai: boolean): any[] {
  const count = copyCount === 2 ? 2 : 1;
  const now = new Date().toISOString();
  const pihak = ["Pihak Pertama", "Pihak Kedua"];
  return Array.from({ length: count }, (_, i) => {
    const idx = i + 1;
    const materaiOn = hasMaterai ? (count === 2 ? pihak[i] : pihak[0]) : undefined;
    const label = count === 2
      ? `Rangkap ${idx} — ${hasMaterai ? `Meterai pada ${materaiOn}` : "Tanpa Meterai"}`
      : `Rangkap Tunggal — ${hasMaterai ? `Meterai pada ${pihak[0]}` : "Tanpa Meterai"}`;
    return { index: idx, label, materaiOn, heldBy: pihak[i] || pihak[0], status: "Disimpan", updatedAt: now };
  });
}

app.post("/api/contracts", requireAuth, requireRole("admin", "staff", "legal", "manager"), (req: AuthedRequest, res) => {
  const db = loadDB();
  const tid = tenantOf(req);
  const company = companyNameFor(db, tid);
  const currentYear = new Date().getFullYear().toString();
  const isUpload = !!req.body.masterPdfUrl;
  // Dokumen UNGGAH PDF murni: nomor diisi FREE TEXT (nomor dari vendor/penerbit),
  // BUKAN auto-generate — dan TIDAK mengonsumsi counter (nomor kita tetap urut
  // untuk dokumen yg dibuat di sistem). Kalau manualNumber kosong, jatuh ke
  // penomoran otomatis seperti biasa.
  const manualNumber = typeof req.body.manualNumber === "string" ? req.body.manualNumber.trim() : "";
  let contractNumber: string, numberSeq: number | undefined;
  if (manualNumber) {
    contractNumber = manualNumber.slice(0, 80);
    numberSeq = undefined;
  } else {
    const gen = generateContractNumber(db, tid, req.body.category, req.body.docType, currentYear);
    contractNumber = gen.number;
    numberSeq = gen.seq;
  }

  const sharingFeeResult = normalizeSharingFeeItems(req.body.sharingFeeItems);
  if (!sharingFeeResult.ok) return res.status(400).json({ error: sharingFeeResult.error });

  const newContract: Contract = {
    id: "ctr-" + Date.now(),
    tenantId: tid,
    templateId: req.body.templateId || "",
    templateSnapshot: captureTemplateSnapshot(db, tid, req.body.templateId),
    contractNumber,
    numberSeq,
    title: req.body.title || `Kontrak Baru ${req.body.category}`,
    category: req.body.category,
    party1Name: company,
    party2Name: req.body.party2Name,
    party2Type: req.body.party2Type || "Vendor",
    parties: req.body.parties || [
      { role: "Pihak Pertama", name: company },
      { role: "Pihak Kedua", name: req.body.party2Name || "Pihak Kedua" }
    ],
    startDate: req.body.startDate,
    endDate: req.body.endDate,
    contractValue: Number(req.body.contractValue) || 0,
    currency: req.body.currency || "IDR",
    // "Aktif" diizinkan langsung saat create: registrasi dokumen upload dari
    // Arsip adalah kontrak yang sudah berjalan — dia lahir Aktif, bukan Draft.
    status: ["Draft", "Aktif", "Archived"].includes(req.body.status) ? req.body.status : "Draft",
    reminderDaysBefore: req.body.reminderDaysBefore || 30,
    isAutoRenew: !!req.body.isAutoRenew,
    variables: req.body.variables || {},
    clauses: req.body.clauses || [],
    masterPdfUrl: req.body.masterPdfUrl || null,
    docType: req.body.docType || undefined,
    notes: req.body.notes || undefined,
    subFolderId: req.body.subFolderId || undefined,
    copies: buildContractCopies(Number(req.body.copyCount) || 1, !!req.body.hasMaterai),
    sharingFeeItems: sharingFeeResult.items.length > 0 ? sharingFeeResult.items : undefined,
    vendorSnapshot: buildVendorSnapshot(db, tid, req.body.vendorId),
    // Detail pihak opsional (narasi pembuka) — lihat comment di types.ts.
    party1Address: req.body.party1Address || undefined,
    party1Position: req.body.party1Position || undefined,
    party1IdLabel: req.body.party1IdLabel || undefined,
    party1IdNumber: req.body.party1IdNumber || undefined,
    party2Address: req.body.party2Address || undefined,
    party2Position: req.body.party2Position || undefined,
    party2IdLabel: req.body.party2IdLabel || undefined,
    party2IdNumber: req.body.party2IdNumber || undefined,
    customOpeningParagraph: req.body.customOpeningParagraph || undefined,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  db.contracts.push(newContract);
  pushAudit(db, req, {
    contractId: newContract.id, contractNumber: newContract.contractNumber,
    action: isUpload ? "Register Document" : "Create Contract",
    details: isUpload
      ? `Mendaftarkan dokumen kontrak upload: "${newContract.title}" (kategori ${newContract.category})`
      : `Membuat request kontrak baru: "${newContract.title}"`,
  });
  pushNotif(db, tid, {
    title: "Draft Kontrak Baru",
    message: `Draft kontrak baru ${newContract.contractNumber} telah dibuat.`,
    type: "info", contractId: newContract.id,
  });
  saveDB(db);
  res.json({ success: true, contract: newContract });
});

// Transisi status yang sah lewat PUT ini — mencontoh pola state-machine DCS
// (dcs/state-machine.ts, isLegalTransition/assertTransition). Draft→OnReview,
// OnReview→Draft/FullyApproved, dan FullyApproved→Aktif SENGAJA tidak ada di
// sini: masing-masing WAJIB lewat POST /:id/submit-review, /:id/approval-
// decision, atau /:id/activate, supaya efek samping (notifikasi approver,
// auto-patch addendum-ke-induk, dsb) tidak pernah bisa dilewati oleh
// panggilan PUT langsung (mis. lewat API/devtools).
// Archived/Terminated adalah status terminal (tidak ada transisi lanjutan).
// Aktif→TidakAktif ada DUA jalur yang berujung status sama: otomatis oleh
// reminders.ts (runReminderCheck) saat endDate terlewati, ATAU manual lewat
// PUT ini (mis. dinonaktifkan sebelum waktunya karena alasan bisnis) — baris
// di bawah ini yang mengizinkan jalur manual tsb. Dari TidakAktif, manusia
// menutupnya lewat Archived/Terminated; "menghidupkan lagi" harus lewat alur
// Perpanjang/Renew (kontrak baru dengan endDate baru), bukan flip status
// mentah balik ke Aktif.
const CONTRACT_PUT_TRANSITIONS: Record<ContractStatus, ContractStatus[]> = {
  Draft: [],
  OnReview: [],
  FullyApproved: [],
  Aktif: ["TidakAktif", "Archived", "Terminated"],
  TidakAktif: ["Archived", "Terminated"],
  Archived: [],
  Terminated: [],
};

app.put("/api/contracts/:id", requireAuth, requireRole("admin", "staff", "legal", "manager"), (req: AuthedRequest, res) => {
  const db = loadDB();
  const tid = tenantOf(req);
  const idx = (db.contracts as Contract[]).findIndex((c) => c.id === req.params.id && c.tenantId === tid);
  if (idx === -1) return res.status(404).json({ error: "Contract not found" });
  const oldContract = db.contracts[idx];

  if (req.body.status !== undefined && req.body.status !== oldContract.status) {
    const allowed = CONTRACT_PUT_TRANSITIONS[oldContract.status] || [];
    if (!allowed.includes(req.body.status)) {
      const hint = oldContract.status === "Draft" && req.body.status === "Aktif"
        ? ' Gunakan endpoint "Aktifkan Kontrak".' : "";
      return res.status(400).json({ error: `Transisi status ${oldContract.status} → ${req.body.status} tidak diizinkan lewat endpoint ini.${hint}` });
    }
  }

  // Field ISI kontrak hanya boleh diubah selagi Draft — sebelumnya kontrak
  // "terkunci" begitu Aktif cuma ditegakkan di frontend (isContractEditable);
  // panggilan API langsung tetap bisa mengubah clauses dst. pada kontrak
  // Aktif. category/subFolderId dikecualikan dari kuncian ini: itu soal
  // pengarsipan/filing (Pindahkan ke Arsip), bukan isi kontrak — wajar
  // dipindah folder kapan pun terlepas dari status.
  const canEditContent = oldContract.status === "Draft";

  const termin = normalizePaymentTerms(req.body.paymentTerms);
  if (!termin.ok) return res.status(400).json({ error: termin.error });
  const terminBaru = termin.items;
  const kewajiban = normalizeObligations(db, tid, req.body.obligations);
  if (!kewajiban.ok) return res.status(400).json({ error: kewajiban.error });
  const kewajibanBaru = kewajiban.items;
  const evaluasi = normalizeVendorEvaluation(req.body.vendorEvaluation, req.user!.name);
  if (!evaluasi.ok) return res.status(400).json({ error: evaluasi.error });

  const newVersionNum = (db.versions.filter((v: ContractVersion) => v.contractId === oldContract.id).length) + 1;
  if (canEditContent) {
    db.versions.push({
      id: "ver-" + Date.now(),
      tenantId: tid,
      contractId: oldContract.id,
      version: newVersionNum,
      title: oldContract.title,
      variables: oldContract.variables,
      clauses: oldContract.clauses,
      updatedAt: oldContract.updatedAt,
      updatedBy: req.user!.name,
      comment: req.body.comment || `Perubahan ke versi ${newVersionNum}`
    });
  }

  db.contracts[idx] = {
    ...oldContract,
    ...(canEditContent ? {
      title: req.body.title || oldContract.title,
      party2Name: req.body.party2Name || oldContract.party2Name,
      party2Type: req.body.party2Type || oldContract.party2Type,
      currency: req.body.currency || oldContract.currency,
      startDate: req.body.startDate || oldContract.startDate,
      endDate: req.body.endDate || oldContract.endDate,
      contractValue: req.body.contractValue !== undefined ? Number(req.body.contractValue) : oldContract.contractValue,
      reminderDaysBefore: req.body.reminderDaysBefore !== undefined ? Number(req.body.reminderDaysBefore) : oldContract.reminderDaysBefore,
      isAutoRenew: req.body.isAutoRenew !== undefined ? !!req.body.isAutoRenew : oldContract.isAutoRenew,
      variables: req.body.variables || oldContract.variables,
      clauses: req.body.clauses || oldContract.clauses,
      parties: req.body.parties || oldContract.parties,
      docType: req.body.docType !== undefined ? (req.body.docType || undefined) : oldContract.docType,
      templateId: req.body.templateId !== undefined ? req.body.templateId : oldContract.templateId,
      notes: req.body.notes !== undefined ? (req.body.notes || undefined) : oldContract.notes,
      amendmentAttachments: req.body.amendmentAttachments !== undefined ? req.body.amendmentAttachments : oldContract.amendmentAttachments,
      party1Address: req.body.party1Address !== undefined ? (req.body.party1Address || undefined) : oldContract.party1Address,
      party1Position: req.body.party1Position !== undefined ? (req.body.party1Position || undefined) : oldContract.party1Position,
      party1IdLabel: req.body.party1IdLabel !== undefined ? (req.body.party1IdLabel || undefined) : oldContract.party1IdLabel,
      party1IdNumber: req.body.party1IdNumber !== undefined ? (req.body.party1IdNumber || undefined) : oldContract.party1IdNumber,
      party2Address: req.body.party2Address !== undefined ? (req.body.party2Address || undefined) : oldContract.party2Address,
      party2Position: req.body.party2Position !== undefined ? (req.body.party2Position || undefined) : oldContract.party2Position,
      party2IdLabel: req.body.party2IdLabel !== undefined ? (req.body.party2IdLabel || undefined) : oldContract.party2IdLabel,
      party2IdNumber: req.body.party2IdNumber !== undefined ? (req.body.party2IdNumber || undefined) : oldContract.party2IdNumber,
      // Sama level kuncinya dgn party2Address/Position di atas — logo Pihak
      // Kedua bagian dari identitas pihak yang disepakati, bukan preferensi
      // tampilan (beda dgn showLetterhead/showLetterheadLogo di bawah).
      party2LogoUrl: req.body.party2LogoUrl !== undefined ? (req.body.party2LogoUrl || undefined) : oldContract.party2LogoUrl,
      party2LogoKey: req.body.party2LogoKey !== undefined ? (req.body.party2LogoKey || undefined) : oldContract.party2LogoKey,
      party2LogoMimeType: req.body.party2LogoMimeType !== undefined ? (req.body.party2LogoMimeType || undefined) : oldContract.party2LogoMimeType,
      customOpeningParagraph: req.body.customOpeningParagraph !== undefined ? (req.body.customOpeningParagraph || undefined) : oldContract.customOpeningParagraph,
    } : {}),
    status: req.body.status !== undefined ? req.body.status : oldContract.status,
    // category/subFolderId: dipakai fitur "Pindahkan ke Arsip" (handleBulkMove
    // di App.tsx) — SELALU diizinkan terlepas dari status (lihat komentar
    // canEditContent di atas). subFolderId eksplisit boleh "" (pindah ke root
    // kategori, keluar dari sub folder manapun) makanya dicek lewat `in`,
    // bukan cuma truthy-check.
    category: req.body.category || oldContract.category,
    subFolderId: "subFolderId" in req.body ? (req.body.subFolderId || undefined) : oldContract.subFolderId,
    // Bahasa TAMPILAN dokumen (id / en / bilingual) juga selalu diizinkan,
    // seperti category/subFolderId di atas: memilih bahasa tampil TIDAK
    // mengubah naskah yang disepakati — teks sumber tetap utuh, versi bahasa
    // lain hanya rendering rujukan hasil terjemahan. Kalau ikut dikunci oleh
    // canEditContent, kontrak yang sudah Aktif (justru yang paling sering
    // perlu dibagikan ke pihak asing) tidak akan pernah bisa ditampilkan
    // dwibahasa.
    documentLanguage: req.body.documentLanguage !== undefined ? req.body.documentLanguage : oldContract.documentLanguage,
    sourceLanguage: req.body.sourceLanguage !== undefined ? req.body.sourceLanguage : oldContract.sourceLanguage,
    // showLetterhead: preferensi tampilan (nyala/mati kop surat di preview &
    // export), sama seperti documentLanguage di atas — bukan isi naskah yang
    // disepakati, jadi juga SELALU diizinkan terlepas dari status kontrak.
    showLetterhead: req.body.showLetterhead !== undefined ? !!req.body.showLetterhead : oldContract.showLetterhead,
    // showLetterheadLogo: sama alasannya dgn showLetterhead di atas — preferensi
    // tampilan, bukan isi naskah, jadi juga selalu diizinkan.
    showLetterheadLogo: req.body.showLetterheadLogo !== undefined ? !!req.body.showLetterheadLogo : oldContract.showLetterheadLogo,
    // showMeteraiPlaceholder: preferensi tampilan juga, alasan sama.
    showMeteraiPlaceholder: req.body.showMeteraiPlaceholder !== undefined ? !!req.body.showMeteraiPlaceholder : oldContract.showMeteraiPlaceholder,
    // Termin pembayaran SELALU boleh diperbarui, terlepas dari status —
    // justru setelah kontrak Aktif-lah tagihan berjalan dan realisasinya
    // dicatat. Mengunci ini di balik canEditContent (Draft saja) akan membuat
    // fiturnya tidak berguna sama sekali. Ini catatan administratif, bukan
    // naskah yang disepakati, jadi tidak menyentuh isi dokumen.
    paymentTerms: terminBaru !== undefined ? terminBaru : oldContract.paymentTerms,
    // Alasannya sama seperti paymentTerms di atas: kewajiban justru dilacak
    // SELAMA kontrak berjalan, jadi tidak boleh dikunci oleh canEditContent.
    obligations: kewajibanBaru !== undefined ? kewajibanBaru : oldContract.obligations,
    // Evaluasi vendor SELALU boleh diisi terlepas status — kinerja biasanya
    // dinilai SETELAH kontrak berjalan atau selesai, sama seperti paymentTerms
    // & obligations di atas.
    vendorEvaluation: evaluasi.value !== undefined ? (evaluasi.value === null ? undefined : evaluasi.value) : oldContract.vendorEvaluation,
    updatedAt: new Date().toISOString()
  };
  pushAudit(db, req, {
    contractId: oldContract.id, contractNumber: oldContract.contractNumber,
    action: canEditContent ? "Modify Clause / Details" : "Update Status/Location",
    details: canEditContent
      ? `Mengubah draf kontrak dan memperbarui ke versi ${newVersionNum}`
      : `Memperbarui status dan/atau lokasi arsip kontrak`,
  });
  saveDB(db);
  res.json({ success: true, contract: db.contracts[idx] });
});

// Ajukan kontrak Draft ke approval matrix — 2 penanggung jawab berurutan.
// Selesai lewat POST /:id/approval-decision (approve tiap step / reject
// balik ke Draft), TIDAK lewat PUT (lihat komentar CONTRACT_PUT_TRANSITIONS).
// ---------------------------------------------------------------------------
// IMPOR MASSAL KONTRAK LAMA (migrasi arsip)
//
// Dipecah SENGAJA menjadi dua langkah — baca dulu, simpan kemudian:
//
//   1. /extract : unggah berkas, OCR tiap dokumen, kembalikan hasil bacaannya.
//                 TIDAK menulis apa pun ke register dan TIDAK membakar nomor.
//   2. /commit  : simpan baris-baris yang SUDAH ditinjau & dikoreksi manusia.
//
// Alasannya konkret: tanggal berakhir yang salah baca akan langsung meracuni
// mesin pengingat dan monitoring, dan baru ketahuan berbulan-bulan kemudian.
// OCR-nya bagus, tapi tidak untuk dipercaya buta pada ratusan dokumen.
// ---------------------------------------------------------------------------
const BULK_IMPORT_MAX_FILES = 25;

app.post("/api/contracts/bulk-import/extract", requireAuth, requireRole("admin", "staff", "legal", "manager"),
  upload.array("files", BULK_IMPORT_MAX_FILES), async (req: AuthedRequest, res) => {
  const files = (req.files as Express.Multer.File[]) || [];
  if (files.length === 0) return res.status(400).json({ error: "Tidak ada berkas yang diunggah." });
  const db = loadDB();
  const tid = tenantOf(req);
  const md = withSettingsDefaults(rawSettingsFor(db, tid)).masterData;
  const categories = catsFor(db, tid);
  const docTypeNames = (md.docTypes || []).map((d: any) => (typeof d === "string" ? d : d.name));
  const hasRealKey = !!process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== "MY_GEMINI_API_KEY";

  const bacaSatu = async (file: Express.Multer.File) => {
    // Berkas disimpan lebih dulu supaya hasil unggahan tidak hilang walau
    // pembacaan AI-nya gagal — user tetap bisa melengkapi manual.
    const stored = await storeFile(file.buffer, uploadFileKey(file.originalname), file.mimetype);
    const baris: any = {
      fileName: file.originalname, masterPdfUrl: stored.url,
      title: file.originalname.replace(/\.[^.]+$/, ""),
      category: "", docType: "", party1Name: "", party2Name: "", party2Type: "",
      startDate: "", endDate: "", contractValue: 0, currency: "IDR",
      notes: "", ocrOk: false, ocrError: "",
    };
    if (!hasRealKey) { baris.ocrError = "GEMINI_API_KEY belum dikonfigurasi — isi manual."; return baris; }
    // Dicoba dua kali. Dalam impor batch, satu kegagalan SESAAT berarti satu
    // dokumen harus diketik ulang manual — biaya percobaan kedua jauh lebih
    // murah daripada itu. Kegagalan tetap dicatat ke log supaya bisa
    // didiagnosis, bukan cuma hilang ke dalam ocrError.
    for (let percobaan = 1; percobaan <= 2; percobaan++) {
    try {
      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: [
          { inlineData: { mimeType: file.mimetype, data: file.buffer.toString("base64") } },
          { text: `Anda asisten arsip legal. Baca dokumen kontrak ini (OCR bila hasil scan/foto), ekstrak data pendaftaran arsip.
Pilih nilai PERSIS dari daftar berikut (jangan mengarang di luar daftar; kosongkan bila benar-benar tidak yakin):
- category: ${JSON.stringify(categories)}
- docType: ${JSON.stringify(docTypeNames)}
- party2Type: ${JSON.stringify(md.partyTypes || [])}
- currency: ${JSON.stringify(md.currencies || ["IDR"])}
Balas JSON: {"title","category","docType","party1Name","party2Name","party2Type","startDate":"YYYY-MM-DD atau null","endDate":"YYYY-MM-DD atau null","contractValue":0,"currency","documentNumber":"nomor dokumen asli yang tertulis di berkas atau null","notes":"ringkasan 1-2 kalimat"}` },
        ],
        config: { responseMimeType: "application/json" },
      });
      const p = parseAiJson(response.text) || {};
      Object.assign(baris, {
        title: p.title || baris.title,
        category: categories.includes(p.category) ? p.category : "",
        docType: docTypeNames.includes(p.docType) ? p.docType : "",
        party1Name: p.party1Name || "", party2Name: p.party2Name || "",
        party2Type: (md.partyTypes || []).includes(p.party2Type) ? p.party2Type : "",
        startDate: /^\d{4}-\d{2}-\d{2}$/.test(p.startDate || "") ? p.startDate : "",
        endDate: /^\d{4}-\d{2}-\d{2}$/.test(p.endDate || "") ? p.endDate : "",
        contractValue: Number(p.contractValue) || 0,
        currency: p.currency || "IDR",
        documentNumber: p.documentNumber || "",
        notes: p.notes || "", ocrOk: true, ocrError: "",
      });
      break; // berhasil — tidak perlu percobaan berikutnya
    } catch (err: any) {
      baris.ocrError = String(err?.message || err).slice(0, 160);
      logger.warn({ err, file: file.originalname, percobaan }, "Bulk import OCR attempt failed");
      if (percobaan < 2) await new Promise((r) => setTimeout(r, 1500));
    }
    }
    return baris;
  };

  // Diproses 3 sekaligus: cukup cepat untuk puluhan berkas, tapi tidak
  // menghajar kuota AI sampai seluruh batch gagal berjamaah.
  const hasil: any[] = [];
  for (let i = 0; i < files.length; i += 3) {
    hasil.push(...await Promise.all(files.slice(i, i + 3).map(bacaSatu)));
  }
  res.json({ success: true, rows: hasil, terbaca: hasil.filter((r) => r.ocrOk).length, total: hasil.length });
});

app.post("/api/contracts/bulk-import/commit", requireAuth, requireRole("admin", "staff", "legal", "manager"), (req: AuthedRequest, res) => {
  const db = loadDB();
  const tid = tenantOf(req);
  const rows: any[] = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (rows.length === 0) return res.status(400).json({ error: "Tidak ada baris untuk disimpan." });
  if (rows.length > 200) return res.status(400).json({ error: "Maksimal 200 baris dalam satu kali impor." });

  const dibuat: any[] = [];
  const gagal: { baris: number; judul: string; alasan: string }[] = [];
  rows.forEach((r, i) => {
    const judul = String(r.title || "").trim();
    if (!judul) { gagal.push({ baris: i + 1, judul: "(tanpa judul)", alasan: "judul wajib diisi" }); return; }
    if (!r.startDate || !r.endDate) { gagal.push({ baris: i + 1, judul, alasan: "tanggal mulai & berakhir wajib diisi" }); return; }
    if (String(r.endDate) < String(r.startDate)) { gagal.push({ baris: i + 1, judul, alasan: "tanggal berakhir sebelum tanggal mulai" }); return; }

    // Nomor dokumen ASLI dari berkas dipakai apa adanya bila ada — dokumen
    // lama sudah beredar dengan nomor itu, menomori ulang justru memutus
    // jejaknya. Kalau kosong, baru sistem yang menerbitkan nomor.
    const nomorAsli = String(r.documentNumber || "").trim();
    const tahun = String(r.startDate).slice(0, 4);
    const gen = nomorAsli ? null : generateContractNumber(db, tid, r.category || "", r.docType || undefined, tahun);
    const now = new Date().toISOString();
    const kontrak: any = {
      id: "ctr-" + Date.now() + "-" + i,
      tenantId: tid,
      contractNumber: nomorAsli || gen!.number,
      numberSeq: gen?.seq,
      title: judul,
      category: r.category || "",
      docType: r.docType || "",
      templateId: "",
      party1Name: r.party1Name || "", party2Name: r.party2Name || "", party2Type: r.party2Type || "",
      startDate: r.startDate, endDate: r.endDate,
      contractValue: Number(r.contractValue) || 0,
      currency: r.currency || "IDR",
      // Dokumen hasil migrasi masuk sebagai ARSIP: sudah pernah berjalan di
      // dunia nyata, jadi tidak boleh melewati alur Draft->approval lagi.
      status: "Archived",
      clauses: [], variables: {},
      masterPdfUrl: r.masterPdfUrl || "",
      notes: r.notes || "",
      reminderDaysBefore: 30, isAutoRenew: false,
      createdAt: now, updatedAt: now,
      importedAt: now, importedByName: req.user!.name,
    };
    db.contracts.push(kontrak);
    dibuat.push({ contractNumber: kontrak.contractNumber, title: judul, nomorAsli: !!nomorAsli });
  });

  if (dibuat.length > 0) {
    pushAudit(db, req, {
      action: "Impor Massal Kontrak",
      details: `Mengimpor ${dibuat.length} kontrak lama ke arsip (${dibuat.filter((d) => d.nomorAsli).length} memakai nomor asli dari berkas, ${dibuat.filter((d) => !d.nomorAsli).length} diberi nomor sistem)${gagal.length ? `; ${gagal.length} baris ditolak` : ""}`,
    });
    saveDB(db);
  }
  res.json({ success: true, created: dibuat.length, rows: dibuat, failed: gagal });
});

// Kirim pengingat untuk BANYAK kontrak sekaligus. Satu-satunya aksi massal
// yang belum ada (pindah arsip / unduh PDF zip / hapus sudah ada sejak lama).
//
// Dua hal yang membedakannya dari reminder otomatis di reminders.ts:
//  - ini dipicu manusia, jadi TIDAK ikut dedup harian lastReminderDate —
//    kalau seseorang sengaja menekan tombolnya, pesannya memang harus terkirim
//  - penerimanya ditargetkan (penanggung jawab approval bila dokumen sedang
//    direview, selain itu pembuat draftnya), bukan disiarkan sekantor
// ---------------------------------------------------------------------------
// RETENSI & PEMUSNAHAN ARSIP
//
// Prinsip yang dipegang: SISTEM TIDAK PERNAH menghapus atau memusnahkan apa
// pun secara otomatis. Ia hanya menghitung kapan sebuah dokumen SECARA
// KEBIJAKAN boleh dimusnahkan, dan mencatat KEPUTUSAN manusia (legal hold
// atau pemusnahan) — mengikuti standar records management (ISO 15489): bukti
// bahwa sesuatu pernah dimusnahkan harus tetap tercatat, bukan hilang begitu
// saja dari sistem.
//
// Dihitung, bukan disimpan: "tanggal boleh dimusnahkan" = kapan dokumen
// menjadi non-aktif (Archived/Terminated/TidakAktif) + retentionYears jenis
// dokumennya. Kalau disimpan mentah, mengubah kebijakan retensi jenis
// dokumen tidak akan pernah terefleksi ke dokumen yang sudah ada.
function retentionEligibleDate(db: any, tid: string, contract: Contract): string | null {
  const md = withSettingsDefaults(rawSettingsFor(db, tid)).masterData;
  const dt = (md.docTypes || []).find((d: any) => d.name === contract.docType);
  const years = dt?.retentionYears;
  if (!years) return null; // retensi belum diatur untuk jenis ini
  const nonAktifSejak = contract.updatedAt || contract.endDate;
  if (!nonAktifSejak) return null;
  const d = new Date(nonAktifSejak);
  d.setFullYear(d.getFullYear() + years);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// ANGGARAN vs NILAI KONTRAK
//
// CRUD sederhana untuk BudgetEntry — angka anggaran itu sendiri adalah
// keputusan perencanaan yang diinput manual, bukan sesuatu yang bisa
// diturunkan dari data lain. Perbandingan terhadap nilai kontrak AKTUAL
// dihitung di klien (murni agregasi dari contracts yang sudah dimuat, sama
// pola seperti Kalender Legal/Retensi Arsip/Performa Vendor) — tidak perlu
// endpoint agregasi terpisah di sini.
// ---------------------------------------------------------------------------
app.get("/api/budgets", requireAuth, (req: AuthedRequest, res) => {
  const db = loadDB();
  res.json(scoped(db.budgets as BudgetEntry[], tenantOf(req)));
});

function normalizeBudgetBody(body: any): { ok: boolean; value?: Partial<BudgetEntry>; error?: string } {
  const year = Number(body.year);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return { ok: false, error: "Tahun anggaran tidak valid." };
  const category = String(body.category || "").trim();
  if (!category) return { ok: false, error: "Kategori wajib diisi." };
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount < 0) return { ok: false, error: "Nominal anggaran harus angka >= 0." };
  return {
    ok: true,
    value: {
      year, category, amount,
      department: String(body.department || "").trim() || undefined,
      notes: String(body.notes || "").slice(0, 300) || undefined,
    },
  };
}

app.post("/api/budgets", requireAuth, requireRole("admin", "legal", "manager"), (req: AuthedRequest, res) => {
  const db = loadDB();
  const tid = tenantOf(req);
  const v = normalizeBudgetBody(req.body);
  if (!v.ok) return res.status(400).json({ error: v.error });
  const now = new Date().toISOString();
  const entry: BudgetEntry = {
    id: "bud-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
    tenantId: tid, createdByName: req.user!.name, createdAt: now, updatedAt: now,
    ...(v.value as any),
  };
  if (!Array.isArray(db.budgets)) db.budgets = [];
  db.budgets.push(entry);
  pushAudit(db, req, { action: "Tambah Anggaran", details: `Anggaran ${entry.category} ${entry.year}${entry.department ? ` (${entry.department})` : ""}: Rp ${entry.amount.toLocaleString("id-ID")}` });
  saveDB(db);
  res.json({ success: true, entry });
});

app.put("/api/budgets/:id", requireAuth, requireRole("admin", "legal", "manager"), (req: AuthedRequest, res) => {
  const db = loadDB();
  const tid = tenantOf(req);
  const entry = (db.budgets as BudgetEntry[]).find((b) => b.id === req.params.id && b.tenantId === tid);
  if (!entry) return res.status(404).json({ error: "Anggaran tidak ditemukan" });
  const v = normalizeBudgetBody(req.body);
  if (!v.ok) return res.status(400).json({ error: v.error });
  Object.assign(entry, v.value, { updatedAt: new Date().toISOString() });
  pushAudit(db, req, { action: "Ubah Anggaran", details: `Anggaran ${entry.category} ${entry.year}${entry.department ? ` (${entry.department})` : ""} diperbarui menjadi Rp ${entry.amount.toLocaleString("id-ID")}` });
  saveDB(db);
  res.json({ success: true, entry });
});

app.delete("/api/budgets/:id", requireAuth, requireRole("admin", "legal", "manager"), (req: AuthedRequest, res) => {
  const db = loadDB();
  const tid = tenantOf(req);
  const entry = (db.budgets as BudgetEntry[]).find((b) => b.id === req.params.id && b.tenantId === tid);
  if (!entry) return res.status(404).json({ error: "Anggaran tidak ditemukan" });
  db.budgets = (db.budgets as BudgetEntry[]).filter((b) => b.id !== req.params.id);
  pushAudit(db, req, { action: "Hapus Anggaran", details: `Anggaran ${entry.category} ${entry.year} dihapus` });
  saveDB(db);
  res.json({ success: true });
});

app.post("/api/contracts/:id/legal-hold", requireAuth, requireRole("admin", "legal"), (req: AuthedRequest, res) => {
  const db = loadDB();
  const tid = tenantOf(req);
  const c = (db.contracts as Contract[]).find((x) => x.id === req.params.id && x.tenantId === tid);
  if (!c) return res.status(404).json({ error: "Contract not found" });
  const aktifkan = req.body.hold !== false;
  if (aktifkan) {
    const alasan = String(req.body.reason || "").trim();
    if (!alasan) return res.status(400).json({ error: "Alasan legal hold wajib diisi — ini akan tercatat di audit trail." });
    c.legalHold = true;
    c.legalHoldReason = alasan;
    c.legalHoldSetByName = req.user!.name;
    c.legalHoldSetAt = new Date().toISOString();
    pushAudit(db, req, { contractId: c.id, contractNumber: c.contractNumber, action: "Pasang Legal Hold", details: `Legal hold dipasang pada "${c.title}": ${alasan}` });
  } else {
    c.legalHold = false;
    pushAudit(db, req, { contractId: c.id, contractNumber: c.contractNumber, action: "Lepas Legal Hold", details: `Legal hold dilepas dari "${c.title}" (alasan sebelumnya: ${c.legalHoldReason || "-"})` });
    c.legalHoldReason = undefined; c.legalHoldSetByName = undefined; c.legalHoldSetAt = undefined;
  }
  saveDB(db);
  res.json({ success: true, contract: c });
});

app.post("/api/contracts/:id/mark-destroyed", requireAuth, requireRole("admin", "legal"), (req: AuthedRequest, res) => {
  const db = loadDB();
  const tid = tenantOf(req);
  const c = (db.contracts as Contract[]).find((x) => x.id === req.params.id && x.tenantId === tid);
  if (!c) return res.status(404).json({ error: "Contract not found" });
  if (c.destroyedAt) return res.status(400).json({ error: "Dokumen ini sudah tercatat dimusnahkan sebelumnya." });
  if (c.legalHold) return res.status(400).json({ error: "Tidak bisa dimusnahkan — sedang dalam legal hold. Lepas legal hold-nya dulu." });
  if (c.status !== "Archived" && c.status !== "Terminated" && c.status !== "TidakAktif") {
    return res.status(400).json({ error: "Hanya dokumen yang sudah tidak aktif (Archived/Terminated/TidakAktif) yang bisa ditandai dimusnahkan." });
  }
  const batas = retentionEligibleDate(db, tid, c);
  const hariIni = new Date().toISOString().slice(0, 10);
  if (!batas) return res.status(400).json({ error: "Jenis dokumen ini belum punya kebijakan retensi (atur di Konfigurasi > Jenis Dokumen)." });
  if (batas > hariIni) return res.status(400).json({ error: `Belum boleh dimusnahkan — masa retensi berakhir ${batas}.` });
  c.destroyedAt = new Date().toISOString();
  c.destroyedByName = req.user!.name;
  c.destroyedNote = String(req.body.note || "").slice(0, 300) || undefined;
  pushAudit(db, req, { contractId: c.id, contractNumber: c.contractNumber, action: "Catat Pemusnahan Arsip", details: `"${c.title}" ditandai dimusnahkan sesuai kebijakan retensi (batas ${batas})${c.destroyedNote ? ` — ${c.destroyedNote}` : ""}. Record metadata TETAP disimpan sebagai bukti pemusnahan (ISO 15489), bukan dihapus dari sistem.` });
  saveDB(db);
  res.json({ success: true, contract: c });
});

app.post("/api/contracts/bulk-reminder", requireAuth, requireRole("admin", "staff", "legal", "manager"), (req: AuthedRequest, res) => {
  const db = loadDB();
  const tid = tenantOf(req);
  const ids: string[] = Array.isArray(req.body.contractIds) ? req.body.contractIds.filter((x: unknown) => typeof x === "string") : [];
  if (ids.length === 0) return res.status(400).json({ error: "Pilih minimal satu dokumen." });
  if (ids.length > 200) return res.status(400).json({ error: "Maksimal 200 dokumen dalam satu kali kirim." });
  const pesanTambahan = String(req.body.message || "").slice(0, 500).trim();

  const terkirim: string[] = [];
  const dilewati: { contractNumber: string; alasan: string }[] = [];
  for (const id of ids) {
    const c = (db.contracts as Contract[]).find((x) => x.id === id && x.tenantId === tid);
    if (!c) { dilewati.push({ contractNumber: id, alasan: "tidak ditemukan" }); continue; }
    // Dokumen yang sudah selesai jalannya tidak punya tindakan tersisa —
    // mengingatkannya cuma jadi gangguan.
    if (c.status === "Archived" || c.status === "Terminated") {
      dilewati.push({ contractNumber: c.contractNumber, alasan: `berstatus ${c.status}` });
      continue;
    }
    const penerima = new Set<string>();
    const langkah = (c.approvalSteps || []).find((s) => s.decision === "pending");
    if (c.status === "OnReview" && langkah) {
      penerima.add(langkah.approverId);
      const approver = (db.users as User[]).find((u) => u.id === langkah.approverId && u.tenantId === tid);
      const pengganti = activeDelegateIdOf(approver);
      if (pengganti) penerima.add(pengganti);
    }
    if (c.approvalSubmittedById) penerima.add(c.approvalSubmittedById);
    if (penerima.size === 0) penerima.add(req.user!.id); // minimal pengirimnya sendiri punya jejak

    const sisa = Math.ceil((new Date(c.endDate).getTime() - Date.now()) / 86400000);
    const konteks = c.status === "OnReview" && langkah
      ? `menunggu keputusan ${langkah.approverName}`
      : Number.isFinite(sisa)
        ? (sisa < 0 ? `sudah lewat masa berlaku ${Math.abs(sisa)} hari` : `berakhir dalam ${sisa} hari`)
        : `berstatus ${c.status}`;
    pushNotif(db, tid, {
      title: "Pengingat Tindak Lanjut Dokumen",
      message: `${req.user!.name} mengingatkan: ${c.contractNumber} (${c.title}) — ${konteks}.${pesanTambahan ? ` Catatan: ${pesanTambahan}` : ""}`,
      type: "warning",
      contractId: c.id,
      targetUserIds: [...penerima],
    });
    terkirim.push(c.contractNumber);
  }

  if (terkirim.length > 0) {
    pushAudit(db, req, {
      action: "Kirim Pengingat Massal",
      details: `Mengirim pengingat untuk ${terkirim.length} dokumen: ${terkirim.slice(0, 8).join(", ")}${terkirim.length > 8 ? `, +${terkirim.length - 8} lainnya` : ""}${pesanTambahan ? ` — "${pesanTambahan}"` : ""}`,
    });
    saveDB(db);
  }
  res.json({ success: true, sent: terkirim.length, skipped: dilewati });
});

app.post("/api/contracts/:id/submit-review", requireAuth, requireRole("admin", "staff", "legal", "manager"), (req: AuthedRequest, res) => {
  const db = loadDB();
  const tid = tenantOf(req);
  const contract = findOwnedContract(db, req, req.params.id);
  if (!contract) return res.status(404).json({ error: "Contract not found" });
  if (contract.status !== "Draft") {
    return res.status(400).json({ error: "Hanya kontrak berstatus Draft yang bisa diajukan untuk persetujuan." });
  }

  // Matriks approval FLEKSIBEL: 1..N penanggung jawab berurutan (dulu dikunci
  // tepat 2 — tidak cocok untuk semua perusahaan). Batas atas wajar (8) untuk
  // cegah abuse; tidak boleh kosong/berulang. Handler approval-decision sudah
  // generik memproses N langkah, jadi tak perlu diubah.
  const approverIds: string[] = Array.isArray(req.body.approverIds) ? req.body.approverIds.filter((x: unknown) => typeof x === "string" && x) : [];
  if (approverIds.length < 1) {
    return res.status(400).json({ error: "Pilih minimal 1 penanggung jawab." });
  }
  if (approverIds.length > 8) {
    return res.status(400).json({ error: "Maksimal 8 penanggung jawab dalam satu matriks approval." });
  }
  if (new Set(approverIds).size !== approverIds.length) {
    return res.status(400).json({ error: "Penanggung jawab tidak boleh sama/berulang dalam satu matriks." });
  }
  const approvers = approverIds.map((id) => (db.users as User[]).find((u) => u.id === id && u.tenantId === tid && u.active));
  if (approvers.some((u) => !u)) {
    return res.status(400).json({ error: "Salah satu penanggung jawab tidak valid/tidak aktif." });
  }
  if (approvers.some((u) => u!.role === "viewer")) {
    return res.status(400).json({ error: "Penanggung jawab tidak boleh berperan sebagai Viewer." });
  }

  const steps: ContractApprovalStep[] = approvers.map((u, i) => ({
    id: "aps-" + Date.now() + "-" + i,
    order: i + 1,
    approverId: u!.id, approverName: u!.name, approverRole: u!.role,
    decision: "pending",
    // Hanya langkah PERTAMA yang giliranya mulai sekarang; langkah berikutnya
    // baru diberi startedAt saat langkah sebelumnya disetujui, supaya SLA tiap
    // orang dihitung dari saat bola benar-benar ada di tangannya.
    startedAt: i === 0 ? new Date().toISOString() : undefined,
  }));
  contract.approvalSteps = steps;
  contract.approvalRound = (contract.approvalRound || 0) + 1;
  contract.approvalSubmittedById = req.user!.id;
  contract.approvalSubmittedByName = req.user!.name;
  contract.status = "OnReview";
  contract.updatedAt = new Date().toISOString();

  pushAudit(db, req, {
    contractId: contract.id, contractNumber: contract.contractNumber,
    action: "Ajukan Persetujuan Kontrak",
    details: `Mengajukan kontrak "${contract.title}" untuk persetujuan ${steps.map((s) => s.approverName).join(" → ")}`,
  });
  pushNotif(db, tid, {
    title: "Kontrak Menunggu Persetujuan",
    message: `Kontrak ${contract.contractNumber} diajukan untuk persetujuan — menunggu ${steps[0].approverName}.`,
    type: "info", contractId: contract.id,
  });
  saveDB(db);
  sendPushToUser(steps[0].approverId, {
    title: "Menunggu Persetujuan Anda",
    body: `Kontrak ${contract.contractNumber} ("${contract.title}") menunggu review Anda.`,
    url: `/?contract=${contract.id}`,
    tag: `approval-${contract.id}`,
  }).catch((err) => logger.warn({ err }, "Push for submit-review failed"));

  res.json({ success: true, contract });
});

// Approve/reject step approval matrix yang sedang giliran approver ybs.
app.post("/api/contracts/:id/approval-decision", requireAuth, (req: AuthedRequest, res) => {
  const db = loadDB();
  const tid = tenantOf(req);
  const contract = findOwnedContract(db, req, req.params.id);
  if (!contract) return res.status(404).json({ error: "Contract not found" });
  if (contract.status !== "OnReview") {
    return res.status(400).json({ error: "Kontrak ini tidak sedang dalam proses review." });
  }

  const decision: string = req.body.decision;
  const comment: string = (req.body.comment || "").trim();
  if (decision !== "approved" && decision !== "rejected") {
    return res.status(400).json({ error: "Keputusan tidak valid." });
  }
  if (decision === "rejected" && !comment) {
    return res.status(400).json({ error: "Komentar wajib diisi saat menolak, supaya pembuat draft tahu apa yang perlu diperbaiki." });
  }

  const steps = contract.approvalSteps || [];
  const currentStep = steps.find((s) => s.decision === "pending");
  if (!currentStep) {
    return res.status(400).json({ error: "Tidak ada langkah persetujuan yang menunggu." });
  }
  // Admin OVERRIDE: admin/super_admin boleh memutuskan langkah mana pun atas
  // nama approver yang ditunjuk (mis. approver tak tersedia) — tercatat jelas di
  // audit & komentar langkah sebagai "override admin". Approver ditunjuk tetap
  // bisa memutuskan gilirannya sendiri seperti biasa.
  // Urutan pemeriksaan disengaja: pemilik giliran → pengganti resmi (delegasi)
  // → override admin. Delegasi didahulukan dari override supaya keputusan
  // tercatat sebagai "pengganti yang ditunjuk", bukan "admin turun tangan" —
  // dua hal yang sangat berbeda saat diaudit.
  const isOwnTurn = currentStep.approverId === req.user!.id;
  const isDelegate = !isOwnTurn && canActAsDelegate(db, tid, currentStep.approverId, req.user!.id);
  const isAdminOverride = !isOwnTurn && !isDelegate
    && (req.user!.role === "admin" || req.user!.role === "super_admin");
  if (!isOwnTurn && !isDelegate && !isAdminOverride) {
    return res.status(403).json({ error: "Bukan giliran Anda menyetujui dokumen ini." });
  }

  const overrideNote = isDelegate
    ? ` [dijalankan ${req.user!.name} sebagai pengganti ${currentStep.approverName} (delegasi)]`
    : isAdminOverride ? ` [override oleh admin ${req.user!.name}, atas nama ${currentStep.approverName}]` : "";
  if (isDelegate) {
    currentStep.decidedByDelegateId = req.user!.id;
    currentStep.decidedByDelegateName = req.user!.name;
  }
  currentStep.decision = decision;
  currentStep.comment = (comment + overrideNote).trim() || undefined;
  currentStep.decidedAt = new Date().toISOString();
  contract.updatedAt = new Date().toISOString();

  const archiveRound = (outcome: "approved" | "rejected") => {
    if (!contract.approvalHistory) contract.approvalHistory = [];
    contract.approvalHistory.push({
      round: contract.approvalRound || 1,
      steps: steps.map((s) => ({ ...s })),
      submittedById: contract.approvalSubmittedById || "",
      submittedByName: contract.approvalSubmittedByName || "",
      submittedAt: contract.updatedAt!,
      outcome,
      resolvedAt: new Date().toISOString(),
    });
  };

  if (decision === "rejected") {
    archiveRound("rejected");
    contract.status = "Draft";
    pushAudit(db, req, {
      contractId: contract.id, contractNumber: contract.contractNumber,
      action: "Tolak Kontrak (Approval Matrix)",
      details: `${req.user!.name} menolak kontrak "${contract.title}": ${comment}`,
    });
    pushNotif(db, tid, {
      title: "Kontrak Ditolak",
      message: `Kontrak ${contract.contractNumber} ditolak oleh ${req.user!.name}: ${comment}`,
      type: "warning", contractId: contract.id,
    });
    saveDB(db);
    if (contract.approvalSubmittedById) {
      sendPushToUser(contract.approvalSubmittedById, {
        title: "Kontrak Ditolak",
        body: `${req.user!.name} menolak "${contract.title}": ${comment}`,
        url: `/?contract=${contract.id}`,
        tag: `approval-${contract.id}`,
      }).catch((err) => logger.warn({ err }, "Push for rejection failed"));
    }
    return res.json({ success: true, contract });
  }

  // Approved — lanjut ke step berikutnya, atau kalau ini step terakhir, kontrak FullyApproved.
  const nextStep = steps.find((s) => s.decision === "pending");
  if (nextStep) {
    // Jam SLA orang berikutnya baru mulai SEKARANG, bukan sejak dokumen
    // diajukan — kalau tidak, approver terakhir selalu terlihat terlambat
    // gara-gara lamanya orang-orang sebelum dia.
    nextStep.startedAt = new Date().toISOString();
    pushAudit(db, req, {
      contractId: contract.id, contractNumber: contract.contractNumber,
      action: "Setujui Kontrak (Approval Matrix)",
      details: `${req.user!.name} menyetujui langkah ${currentStep.order} — menunggu ${nextStep.approverName}`,
    });
    saveDB(db);
    sendPushToUser(nextStep.approverId, {
      title: "Menunggu Persetujuan Anda",
      body: `Kontrak ${contract.contractNumber} ("${contract.title}") menunggu review Anda.`,
      url: `/?contract=${contract.id}`,
      tag: `approval-${contract.id}`,
    }).catch((err) => logger.warn({ err }, "Push for next approver failed"));
  } else {
    archiveRound("approved");
    contract.status = "FullyApproved";
    pushAudit(db, req, {
      contractId: contract.id, contractNumber: contract.contractNumber,
      action: "Setujui Kontrak (Approval Matrix)",
      details: `${req.user!.name} menyetujui langkah terakhir — kontrak "${contract.title}" disetujui penuh`,
    });
    pushNotif(db, tid, {
      title: "Kontrak Disetujui Penuh",
      message: `Kontrak ${contract.contractNumber} disetujui penuh — siap diunduh untuk TTD basah.`,
      type: "success", contractId: contract.id,
    });
    saveDB(db);
    if (contract.approvalSubmittedById) {
      sendPushToUser(contract.approvalSubmittedById, {
        title: "Kontrak Disetujui Penuh",
        body: `"${contract.title}" disetujui penuh — siap diunduh untuk TTD basah.`,
        url: `/?contract=${contract.id}`,
        tag: `approval-${contract.id}`,
      }).catch((err) => logger.warn({ err }, "Push for full approval failed"));
    }
  }

  res.json({ success: true, contract });
});

// Delete contract
app.delete("/api/contracts/:id", requireAuth, requireRole("admin", "staff", "legal", "manager"), (req: AuthedRequest, res) => {
  const db = loadDB();
  const tid = tenantOf(req);
  const target = findOwnedContract(db, req, req.params.id);
  if (!target) return res.status(404).json({ error: "Contract not found" });
  // Opsional: kembalikan nomor dokumen ke kolam agar bisa dipakai dokumen
  // berikutnya (dokumen batal terbit). Hanya boleh untuk dokumen yang BELUM
  // pernah beredar — lihat canReleaseContractNumber.
  let numberReleased = false;
  if (req.query.releaseNumber === "1" || req.body?.releaseNumber === true) {
    const gate = canReleaseContractNumber(target);
    if (!gate.ok) return res.status(400).json({ error: gate.reason });
    numberReleased = releaseContractNumber(db, tid, target);
  }
  db.contracts = (db.contracts as Contract[]).filter((c) => !(c.id === req.params.id && c.tenantId === tid));
  pushAudit(db, req, {
    contractId: target.id, contractNumber: target.contractNumber, action: "Delete Contract",
    details: `Menghapus kontrak "${target.title}"${numberReleased ? ` — nomor ${target.contractNumber} dilepas & bisa dipakai dokumen berikutnya` : ""}`,
  });
  saveDB(db);
  res.json({ success: true, numberReleased });
});

// Apakah nomor sebuah dokumen boleh dilepas untuk dipakai ulang?
// Prinsipnya: nomor yang SUDAH PERNAH BEREDAR tidak boleh dipakai ulang, karena
// akan menghasilkan dua dokumen berbeda dengan nomor sama. Aman hanya kalau
// dokumen masih Draft, belum pernah diekspor/dibagikan, dan bukan nomor manual
// (nomor manual milik penerbit lain — tidak pernah mengambil dari counter kita).
function canReleaseContractNumber(c: Contract): { ok: boolean; reason?: string } {
  if (typeof c.numberSeq !== "number") {
    return { ok: false, reason: "Nomor dokumen ini tidak berasal dari penomoran otomatis (nomor bebas dari penerbit), jadi tidak ada yang perlu dilepas." };
  }
  if (c.status !== "Draft") {
    return { ok: false, reason: `Nomor hanya bisa dilepas selama dokumen masih Draft. Status sekarang: ${c.status}.` };
  }
  if (c.exportedPdfUrl || c.externalReviewToken) {
    return { ok: false, reason: "Dokumen ini sudah pernah diekspor/dibagikan, jadi nomornya berpotensi sudah beredar di luar dan tidak boleh dipakai ulang." };
  }
  return { ok: true };
}

// Kembalikan seq ke kolam `released` pada scope counter yang sama.
function releaseContractNumber(db: any, tid: string, c: Contract): boolean {
  if (typeof c.numberSeq !== "number") return false;
  const year = (c.createdAt || new Date().toISOString()).slice(0, 4);
  const key = contractScopeKey(tid, c.category, c.docType, year);
  if (!Array.isArray(db.numberCounters)) db.numberCounters = [];
  const rec = (db.numberCounters as any[]).find((r) => r.id === key);
  if (!rec) return false;
  const released: number[] = Array.isArray(rec.released) ? rec.released : [];
  if (released.includes(c.numberSeq)) return true; // idempoten
  // Kalau yang dilepas kebetulan nomor TERAKHIR, cukup mundurkan counter —
  // lebih bersih daripada menyimpannya di kolam.
  if (rec.seq === c.numberSeq) { rec.seq = c.numberSeq - 1; return true; }
  rec.released = [...released, c.numberSeq].sort((a, b) => a - b);
  return true;
}

// Lepas nomor TANPA menghapus dokumennya (mis. dokumen mau ditulis ulang dari
// awal tapi arsipnya masih ingin disimpan sebentar).
app.post("/api/contracts/:id/release-number", requireAuth, requireRole("admin", "staff", "legal", "manager"), (req: AuthedRequest, res) => {
  const db = loadDB();
  const tid = tenantOf(req);
  const target = findOwnedContract(db, req, req.params.id);
  if (!target) return res.status(404).json({ error: "Contract not found" });
  const gate = canReleaseContractNumber(target);
  if (!gate.ok) return res.status(400).json({ error: gate.reason });
  const freed = target.contractNumber;
  releaseContractNumber(db, tid, target);
  target.contractNumber = "";
  target.numberSeq = undefined;
  target.updatedAt = new Date().toISOString();
  pushAudit(db, req, {
    contractId: target.id, contractNumber: freed, action: "Lepas Nomor Dokumen",
    details: `Melepas nomor ${freed} dari "${target.title}" — nomor kembali ke kolam dan bisa dipakai dokumen berikutnya`,
  });
  saveDB(db);
  res.json({ success: true, releasedNumber: freed, contract: target });
});

// RANGKAP KONTRAK (physical copies) — update status/pemegang/penerima satu
// rangkap, atau upload scan berkas rangkap tsb. Kontrak lama (dibuat sebelum
// fitur ini) belum punya `copies`; endpoint update menginisialisasi on-demand
// lewat req.body.initCopies agar arsip lama bisa mulai dilacak juga.
app.put("/api/contracts/:id/copies/:index", requireAuth, requireRole("admin", "staff", "legal", "manager"), (req: AuthedRequest, res) => {
  const db = loadDB();
  const contract = findOwnedContract(db, req, req.params.id);
  if (!contract) return res.status(404).json({ error: "Contract not found" });
  if ((!contract.copies || contract.copies.length === 0) && req.body.initCopies) {
    contract.copies = buildContractCopies(Number(req.body.initCopies.copyCount) || 1, !!req.body.initCopies.hasMaterai);
  }
  const copy = (contract.copies || []).find((c: any) => c.index === Number(req.params.index));
  if (!copy) return res.status(404).json({ error: "Rangkap tidak ditemukan pada kontrak ini" });
  if (req.body.status !== undefined) copy.status = String(req.body.status);
  if (req.body.heldBy !== undefined) copy.heldBy = String(req.body.heldBy);
  if (req.body.assignedTo !== undefined) copy.assignedTo = String(req.body.assignedTo) || undefined;
  copy.updatedAt = new Date().toISOString();
  contract.updatedAt = copy.updatedAt;
  pushAudit(db, req, {
    contractId: contract.id, contractNumber: contract.contractNumber,
    action: "Update Rangkap",
    details: `${copy.label}: status "${copy.status}"${copy.assignedTo ? ` → ${copy.assignedTo}` : ""} (pemegang: ${copy.heldBy})`,
  });
  saveDB(db);
  res.json({ success: true, contract });
});

app.post("/api/contracts/:id/copies/:index/upload", requireAuth, requireRole("admin", "staff", "legal", "manager"), upload.single("file"), async (req: AuthedRequest, res) => {
  const db = loadDB();
  const contract = findOwnedContract(db, req, req.params.id);
  if (!contract) return res.status(404).json({ error: "Contract not found" });
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const copy = (contract.copies || []).find((c: any) => c.index === Number(req.params.index));
  if (!copy) return res.status(404).json({ error: "Rangkap tidak ditemukan pada kontrak ini" });
  const stored = await storeFile(req.file.buffer, uploadFileKey(req.file.originalname), req.file.mimetype);
  copy.fileUrl = stored.url;
  copy.updatedAt = new Date().toISOString();
  contract.updatedAt = copy.updatedAt;
  pushAudit(db, req, {
    contractId: contract.id, contractNumber: contract.contractNumber,
    action: "Upload Berkas Rangkap",
    details: `Mengunggah scan untuk ${copy.label}`,
  });
  saveDB(db);
  res.json({ success: true, contract });
});

// 5. SIKLUS HIDUP KONTRAK — aktivasi FullyApproved → Aktif.
// Aktivasi WAJIB disertai unggahan bukti tanda tangan (hasil scan dokumen
// yang sudah ditandatangani/bermeterai di luar sistem) — status Aktif baru
// "terkoneksi" ke berkas nyata, bukan cuma klik tombol tanpa bukti. Berkas
// itu jadi masterPdfUrl kontrak ini (dipakai watermark CONTROLLED selanjutnya).
// Verifikasi ulang: hitung ulang SHA-256 berkas yang SAAT INI tersimpan dan
// bandingkan dengan checksum yang dicatat saat aktivasi. Tanpa endpoint ini,
// hash yang "disimpan lalu tidak pernah dicek lagi" nilainya jauh lebih
// kecil — kalau seseorang mengganti berkas langsung di storage, tidak ada
// cara mengetahuinya. Read-only, tidak mengubah apa pun.
app.get("/api/contracts/:id/verify-integrity", requireAuth, async (req: AuthedRequest, res) => {
  const db = loadDB();
  const contract = findOwnedContract(db, req, req.params.id);
  if (!contract) return res.status(404).json({ error: "Contract not found" });
  if (!contract.activationProofHash || !contract.activationProofKey) {
    return res.status(400).json({ error: "Kontrak ini tidak punya checksum aktivasi tersimpan (diaktifkan sebelum fitur ini ada, atau bukan berkas hasil aktivasi)." });
  }
  try {
    const buf = await fetchFile(contract.activationProofKey);
    const currentHash = sha256(buf);
    res.json({ success: true, match: currentHash === contract.activationProofHash, storedHash: contract.activationProofHash, currentHash });
  } catch (err: any) {
    res.status(404).json({ error: `Berkas tidak ditemukan di penyimpanan: ${String(err?.message || err).slice(0, 150)}` });
  }
});

app.post("/api/contracts/:id/activate", requireAuth, requireRole("admin", "staff", "legal", "manager"), upload.single("file"), async (req: AuthedRequest, res) => {
  const db = loadDB();
  const contract = findOwnedContract(db, req, req.params.id);
  if (!contract) return res.status(404).json({ error: "Contract not found" });
  if (contract.status !== "FullyApproved") {
    return res.status(400).json({ error: "Kontrak baru bisa diaktifkan setelah disetujui penuh lewat approval matrix." });
  }
  if (!req.file) {
    return res.status(400).json({ error: "Unggah berkas bukti tanda tangan (hasil scan dokumen yang sudah ditandatangani) untuk mengaktifkan kontrak." });
  }

  // Checksum dihitung dari buffer SEBELUM diunggah — bukti berkas yang
  // benar-benar diterima server saat itu, bukan berkas yang mungkin
  // berbeda hasil unggahan ulang. Lihat catatan panjang di types.ts
  // (Contract.activationProofHash) soal ini BUKAN e-meterai/TTD elektronik.
  const proofHash = sha256(req.file.buffer);
  const stored = await storeFile(req.file.buffer, uploadFileKey(req.file.originalname), req.file.mimetype);
  contract.masterPdfUrl = stored.url;
  contract.activationProofHash = proofHash;
  contract.activationProofKey = stored.key;
  contract.status = "Aktif";
  contract.updatedAt = new Date().toISOString();

  pushAudit(db, req, {
    contractId: contract.id, contractNumber: contract.contractNumber,
    action: "Activate Contract",
    details: `Mengaktifkan kontrak "${contract.title}" dengan bukti TTD "${req.file.originalname}" (SHA-256: ${proofHash.slice(0, 16)}…) — terkunci dari editing & masuk monitoring`,
  });
  pushNotif(db, tenantOf(req), {
    title: "Kontrak Diaktifkan",
    message: `Kontrak ${contract.contractNumber} kini berstatus Aktif dan masuk monitoring & reminder.`,
    type: "success", contractId: contract.id,
  });

  // Addendum: kalau mengamandemen kontrak induk & jangka waktu/nilainya
  // beda dari induk saat ini, tempelkan perubahan itu ke induk (efek nyata
  // "perpanjangan/perubahan via addendum"). Dibungkus try/catch supaya
  // kegagalan di sini TIDAK membatalkan aktivasi addendum itu sendiri —
  // induk yang somehow sudah tidak Aktif lagi cukup dilewati diam-diam.
  if (contract.amendsContractId) {
    try {
      const parent = (db.contracts as Contract[]).find((c) => c.id === contract.amendsContractId && c.tenantId === contract.tenantId);
      if (parent && parent.status === "Aktif") {
        const changedFields: string[] = [];
        if (contract.endDate && contract.endDate !== parent.endDate) {
          changedFields.push(`Tanggal Berakhir: ${parent.endDate} → ${contract.endDate}`);
          parent.endDate = contract.endDate;
        }
        if (contract.contractValue && contract.contractValue !== parent.contractValue) {
          changedFields.push(`Nilai Kontrak: ${parent.contractValue} → ${contract.contractValue}`);
          parent.contractValue = contract.contractValue;
        }
        if (changedFields.length > 0) {
          parent.updatedAt = new Date().toISOString();
          pushAudit(db, req, {
            contractId: parent.id, contractNumber: parent.contractNumber,
            action: "Update via Addendum",
            details: `Diperbarui via ${contract.contractNumber}: ${changedFields.join("; ")}`,
          });
        }
      }
    } catch (err) {
      logger.warn({ err, contractId: contract.id }, "Gagal menerapkan addendum ke kontrak induk — aktivasi addendum tetap berhasil");
    }
  }

  saveDB(db);
  res.json({ success: true, contract });
});

// Hitung urutan addendum ("Addendum Kesebelas") + referensi addendum terakhir
// on-the-fly dari data existing — tidak disimpan, supaya tidak basi kalau ada
// addendum yang dihapus. Dipakai frontend untuk preview nomor urut sebelum submit.
const ADDENDUM_ORDINALS = ["", "Pertama", "Kedua", "Ketiga", "Keempat", "Kelima", "Keenam", "Ketujuh", "Kedelapan", "Kesembilan", "Kesepuluh", "Kesebelas", "Kedua Belas", "Ketiga Belas", "Keempat Belas", "Kelima Belas"];
function addendumOrdinal(n: number): string {
  return ADDENDUM_ORDINALS[n] || `Ke-${n}`;
}

// Versi server dari getAddendumInfo() di src/App.tsx — dipakai HANYA buat
// menyusun teks sumber terjemahan (recital & closing addendum, lihat
// composeAddendumRecitalForTranslation/composeAddendumClosingForTranslation
// di bawah). Cari induk (parent) & addendum sebelumnya (previous) dari
// db.contracts, persis logika frontend, supaya kalimat "yang telah diubah
// terakhir kali melalui Addendum ... Nomor ... tanggal ..." konsisten.
function getAddendumInfoServer(db: any, contract: Contract): { parent: Contract | null; previous: Contract | null; ordinal: string } | null {
  if (!contract.amendsContractId) return null;
  const all = db.contracts as Contract[];
  const parent = all.find((c) => c.id === contract.amendsContractId) || null;
  const siblings = all
    .filter((c) => c.amendsContractId === contract.amendsContractId)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const myIndex = siblings.findIndex((c) => c.id === contract.id);
  const sequence = myIndex >= 0 ? myIndex + 1 : siblings.length + 1;
  const previous = myIndex > 0 ? siblings[myIndex - 1] : null;
  return { parent, previous, ordinal: addendumOrdinal(sequence) };
}

app.get("/api/contracts/:id/addendum-context", requireAuth, (req: AuthedRequest, res) => {
  const db = loadDB();
  const parent = findOwnedContract(db, req, req.params.id);
  if (!parent) return res.status(404).json({ error: "Contract not found" });
  const existing = (db.contracts as Contract[])
    .filter((c) => c.tenantId === parent.tenantId && c.amendsContractId === parent.id)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const amendmentSequence = existing.length + 1;
  const previousAddendum = existing[0]
    ? { number: existing[0].contractNumber, createdAt: existing[0].createdAt, ordinal: addendumOrdinal(existing.length) }
    : null;
  res.json({ amendmentSequence, ordinal: addendumOrdinal(amendmentSequence), previousAddendum });
});

// Buat Addendum: dokumen SATELIT yang mengamandemen kontrak induk (induk
// tetap hidup, tidak digantikan — beda dari /renew yang membuat kontrak
// pengganti independen). Hanya valid untuk kontrak induk yang sudah Aktif
// (amandemen cuma masuk akal untuk kontrak yang sudah mengikat).
app.post("/api/contracts/:id/addendum", requireAuth, requireRole("admin", "staff", "legal", "manager"), (req: AuthedRequest, res) => {
  const db = loadDB();
  const tid = tenantOf(req);
  const parent = findOwnedContract(db, req, req.params.id);
  if (!parent) return res.status(404).json({ error: "Contract not found" });
  if (parent.status !== "Aktif") {
    return res.status(400).json({ error: "Addendum hanya bisa dibuat untuk kontrak berstatus Aktif." });
  }

  // Pertahanan berlapis — validasi yang sama sudah ada di frontend
  // (handleSubmitAddendum), tapi endpoint ini juga bisa dipanggil langsung.
  const effectiveAddendumStart = req.body.startDate || new Date().toISOString().split("T")[0];
  const effectiveAddendumEnd = req.body.endDate || parent.endDate;
  if (effectiveAddendumEnd <= effectiveAddendumStart) {
    return res.status(400).json({ error: "Tanggal berakhir addendum harus setelah tanggal mulainya (hari ini, kecuali diisi manual)." });
  }

  // sharingFeeItems TIDAK wajib dikirim ulang — kalau addendum ini memang
  // tidak mengubah skema bagi hasil, ia mewarisi apa adanya dari induk.
  // Kalau dikirim (mis. addendum yang justru mengubah persentase/nominal
  // fee), req.body menang — sama seperti pola contractValue di bawah.
  const sharingFeeResult = normalizeSharingFeeItems(req.body.sharingFeeItems);
  if (!sharingFeeResult.ok) return res.status(400).json({ error: sharingFeeResult.error });

  const ADDENDUM_DOC_TYPE = "Addendum / Amandemen";
  const currentYear = new Date().getFullYear().toString();
  const { number: contractNumber, seq: numberSeq } = generateContractNumber(db, tid, parent.category, ADDENDUM_DOC_TYPE, currentYear);

  const newAddendum: Contract = {
    id: "ctr-" + Date.now(),
    tenantId: tid,
    templateId: req.body.templateId || "",
    templateSnapshot: captureTemplateSnapshot(db, tid, req.body.templateId),
    contractNumber,
    numberSeq,
    title: req.body.title || `Addendum ${parent.title}`,
    category: parent.category,
    party1Name: parent.party1Name,
    party2Name: parent.party2Name,
    party2Type: parent.party2Type,
    parties: parent.parties,
    // startDate addendum = tanggal penandatanganan addendum ini sendiri
    // (default hari ini, dipakai paragraf pembuka "Pada hari ini, tanggal..."),
    // BUKAN startDate kontrak induk — endDate-lah yang membawa "jangka waktu
    // baru" dan itu yang ditempelkan ke induk saat addendum diaktifkan.
    startDate: req.body.startDate || new Date().toISOString().split("T")[0],
    endDate: req.body.endDate || parent.endDate,
    contractValue: req.body.contractValue !== undefined && req.body.contractValue !== "" ? Number(req.body.contractValue) : parent.contractValue,
    currency: parent.currency,
    status: "Draft",
    reminderDaysBefore: parent.reminderDaysBefore,
    isAutoRenew: false,
    variables: { ...parent.variables },
    // Pasal boleh dikirim dari client: cascade dari Template Addendum (kalau
    // dikonfigurasi) digabung pasal perubahan otomatis (jangka waktu/nilai,
    // dihitung dari selisih endDate/contractValue vs induk) — lihat
    // buildAddendumAutoClauses di App.tsx. Kosong = tetap seperti dulu,
    // diisi manual lewat Editor Pasal setelah addendum dibuat.
    clauses: Array.isArray(req.body.clauses) ? req.body.clauses : [],
    masterPdfUrl: null,
    docType: ADDENDUM_DOC_TYPE,
    amendsContractId: parent.id,
    amendmentAttachments: Array.isArray(req.body.amendmentAttachments) ? req.body.amendmentAttachments : [],
    // Default 2 rangkap bermeterai (praktik umum: tiap pihak pegang 1 asli
    // bermeterai) — bisa diubah dari form Addendum, sama seperti kontrak baru.
    copies: buildContractCopies(Number(req.body.copyCount) || 2, req.body.hasMaterai !== false),
    sharingFeeItems: req.body.sharingFeeItems !== undefined
      ? (sharingFeeResult.items.length > 0 ? sharingFeeResult.items : undefined)
      : parent.sharingFeeItems,
    // Addendum tidak pernah memilih ulang vendor/customer — identitas pihak
    // mengikuti induk (mengubah pihak berarti kontrak baru, bukan addendum).
    vendorSnapshot: parent.vendorSnapshot,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  db.contracts.push(newAddendum);
  pushAudit(db, req, {
    contractId: newAddendum.id, contractNumber: newAddendum.contractNumber,
    action: "Create Addendum",
    details: `Membuat Addendum untuk kontrak "${parent.title}" (${parent.contractNumber})`,
  });
  pushNotif(db, tid, {
    title: "Addendum Baru Dibuat",
    message: `Addendum ${newAddendum.contractNumber} dibuat untuk kontrak ${parent.contractNumber}.`,
    type: "info", contractId: newAddendum.id,
  });
  saveDB(db);
  res.json({ success: true, contract: newAddendum });
});

// Resolve base URL untuk tautan yang dibagikan keluar (email/WA)
function shareBaseUrl(req: express.Request): string {
  return process.env.APP_URL && process.env.APP_URL !== "MY_APP_URL"
    ? process.env.APP_URL.replace(/\/$/, "")
    : `${req.protocol}://${req.get("host")}`;
}

// 6b-watermark. VIEW PDF DENGAN WATERMARK REAKTIF — berkas asli (clean)
// tidak pernah dimodifikasi; watermark di-stamp in-memory setiap kali
// endpoint ini dipanggil, berdasarkan status kontrak saat itu:
//   Aktif             → biru  "CONTROLLED COPY"
//   Terminated        → merah "UNCONTROLLED COPY — TIDAK BERLAKU / TERMINATED"
//   Archived          → merah "UNCONTROLLED COPY — DIARSIPKAN / ARCHIVED"
//   Draft/lainnya     → abu   "DRAFT — NOT FOR USE"
// Ini berlaku tanpa melihat masa berlaku (endDate) — status DB yang menentukan.
app.get("/api/contracts/:id/view-pdf", requireAuth, async (req: AuthedRequest, res) => {
  const db = loadDB();
  const contract = findOwnedContract(db, req, req.params.id);
  if (!contract) return res.status(404).json({ error: "Contract not found" });
  // Sebelum approval matrix selesai, dokumen tidak boleh diunduh sama sekali.
  if (!["FullyApproved", "Aktif", "TidakAktif", "Archived", "Terminated"].includes(contract.status)) {
    return res.status(403).json({ error: "Dokumen belum bisa diunduh — selesaikan approval matriks terlebih dahulu." });
  }

  // Ambil URL berkas PDF (prioritas: masterPdfUrl, fallback: exportedPdfKey)
  const fileUrl = contract.masterPdfUrl || contract.exportedPdfUrl;
  if (!fileUrl) {
    return res.status(409).json({ error: "Kontrak ini belum memiliki berkas PDF yang diunggah." });
  }

  try {
    // Fetch berkas — lokal (/uploads/...) atau cloud (S3/GCS)
    let cleanBuf: Buffer;
    if (fileUrl.startsWith("/uploads/")) {
      const localPath = path.join(uploadDir, path.basename(fileUrl));
      if (!fs.existsSync(localPath)) {
        return res.status(404).json({ error: "Berkas PDF tidak ditemukan di server." });
      }
      cleanBuf = fs.readFileSync(localPath);
    } else {
      // Cloud: gunakan exportedPdfKey jika ada, fallback basename dari URL
      const storageKey = contract.exportedPdfKey
        || (contract.masterPdfUrl ? path.basename(new URL(contract.masterPdfUrl).pathname) : null);
      if (!storageKey) return res.status(409).json({ error: "Tidak dapat menentukan storage key berkas PDF." });
      cleanBuf = await fetchFile(storageKey);
    }

    // Watermark kontrak OPSIONAL — default MATI (tidak mandatory utk kontrak &
    // karyawan). Kalau setelan mati, sajikan PDF BERSIH apa adanya. DCS punya
    // watermark wajib sendiri (modul DCS), tak dipengaruhi setelan ini.
    const wmSettings = withSettingsDefaults(rawSettingsFor(db, tenantOf(req)));
    if (!wmSettings.contractWatermark) {
      pushAudit(db, req, {
        contractId: contract.id, contractNumber: contract.contractNumber,
        action: "View PDF",
        details: `${req.user!.name} membuka PDF kontrak "${contract.title}" [status: ${contract.status}] — watermark nonaktif (opsi).`,
      });
      saveDB(db);
      const safeName = contract.contractNumber.replace(/\//g, "-");
      const disp = req.query.download === "1" ? "attachment" : "inline";
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Length", cleanBuf.length);
      res.setHeader("Content-Disposition", `${disp}; filename="${safeName}-${contract.status}.pdf"`);
      return res.send(cleanBuf);
    }

    // Resolusi watermark berdasarkan status kontrak
    interface WmSpec { banner: string; footer: string; r: number; g: number; b: number; bannerOpacity: number; footerOpacity: number; }
    const userName = req.user!.name;
    const accessedAt = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
    const docRef = `${contract.contractNumber}`;

    let spec: WmSpec;
    if (contract.status === "Aktif") {
      spec = {
        banner: "CONTROLLED COPY",
        footer: `CONTROLLED COPY · ${docRef} · Accessed by ${userName} on ${accessedAt}`,
        r: 0.16, g: 0.32, b: 0.75,
        bannerOpacity: 0.10, footerOpacity: 0.55,
      };
    } else if (contract.status === "TidakAktif") {
      spec = {
        banner: "UNCONTROLLED COPY — TIDAK AKTIF / KEDALUWARSA",
        footer: `UNCONTROLLED / EXPIRED · ${docRef} · Retrieved by ${userName} on ${accessedAt}`,
        r: 0.80, g: 0.12, b: 0.12,
        bannerOpacity: 0.14, footerOpacity: 0.65,
      };
    } else if (contract.status === "Terminated") {
      spec = {
        banner: "UNCONTROLLED COPY — TIDAK BERLAKU / TERMINATED",
        footer: `UNCONTROLLED / TERMINATED · ${docRef} · Retrieved by ${userName} on ${accessedAt}`,
        r: 0.80, g: 0.12, b: 0.12,
        bannerOpacity: 0.14, footerOpacity: 0.65,
      };
    } else if (contract.status === "Archived") {
      spec = {
        banner: "UNCONTROLLED COPY — DIARSIPKAN / ARCHIVED",
        footer: `UNCONTROLLED / ARCHIVED · ${docRef} · Retrieved by ${userName} on ${accessedAt}`,
        r: 0.80, g: 0.12, b: 0.12,
        bannerOpacity: 0.14, footerOpacity: 0.65,
      };
    } else {
      // Draft atau status tak dikenal
      spec = {
        banner: `DRAFT — NOT FOR USE (${contract.status.toUpperCase()})`,
        footer: `DRAFT · ${docRef} · Accessed by ${userName} on ${accessedAt}`,
        r: 0.45, g: 0.45, b: 0.45,
        bannerOpacity: 0.12, footerOpacity: 0.55,
      };
    }

    // Stamp watermark in-memory via pdf-lib
    const pdfDoc = await PDFDocument.load(cleanBuf);
    const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const color = rgb(spec.r, spec.g, spec.b);
    for (const page of pdfDoc.getPages()) {
      const { width, height } = page.getSize();
      // Diagonal tiled banner
      const bannerSize = 42;
      const stepX = Math.max(spec.banner.length * bannerSize * 0.35, 320);
      const stepY = 190;
      for (let y = -height; y < height * 2; y += stepY) {
        for (let x = -width; x < width * 2; x += stepX) {
          page.drawText(spec.banner, {
            x, y, size: bannerSize, font, color,
            opacity: spec.bannerOpacity, rotate: degrees(45),
          });
        }
      }
      // Footer provenance strip
      page.drawText(spec.footer, {
        x: 24, y: 14, size: 7.5, font, color,
        opacity: spec.footerOpacity, maxWidth: width - 48,
      });
    }
    const stamped = Buffer.from(await pdfDoc.save());

    // Catat audit trail bahwa dokumen dilihat
    pushAudit(db, req, {
      contractId: contract.id, contractNumber: contract.contractNumber,
      action: "View PDF (Watermarked)",
      details: `${userName} membuka PDF kontrak "${contract.title}" [status: ${contract.status}] dengan watermark ${contract.status === "Aktif" ? "CONTROLLED" : "UNCONTROLLED"}.`,
    });
    saveDB(db);

    const safeFileName = contract.contractNumber.replace(/\//g, "-");
    const disposition = req.query.download === "1" ? "attachment" : "inline";
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Length", stamped.length);
    res.setHeader("Content-Disposition", `${disposition}; filename="${safeFileName}-${contract.status}.pdf"`);
    res.send(stamped);
  } catch (err: any) {
    logger.error({ err, contractId: contract.id }, "Watermark PDF gagal");
    res.status(500).json({ error: "Gagal memproses watermark PDF: " + (err?.message || "unknown error") });
  }
});

// 6c. EXPORT PDF UNTUK DIBAGIKAN (email / WA) — penerima bisa unduh, print,
// lalu tanda tangan basah. Frontend meng-generate PDF dari preview kontrak
// dan mengunggahnya ke sini; untuk dokumen upload (masterPdfUrl) file yang
// sudah ada dipakai langsung tanpa generate ulang.
app.post("/api/contracts/:id/export-share", requireAuth, upload.single("file"), async (req: AuthedRequest, res) => {
  const db = loadDB();
  const contract = findOwnedContract(db, req, req.params.id);
  if (!contract) return res.status(404).json({ error: "Contract not found" });
  // Sebelum approval matrix selesai, dokumen tidak boleh diunduh/dibagikan sama sekali.
  if (!["FullyApproved", "Aktif", "TidakAktif", "Archived", "Terminated"].includes(contract.status)) {
    return res.status(400).json({ error: "Dokumen belum bisa diunduh — selesaikan approval matriks terlebih dahulu." });
  }

  let fileUrl: string;
  if (req.file) {
    const stored = await storeFile(req.file.buffer, uploadFileKey(req.file.originalname), req.file.mimetype);
    fileUrl = stored.url;
    contract.exportedPdfUrl = fileUrl;
    contract.exportedPdfKey = stored.key; // untuk fetch ulang server-side (lampiran email)
  } else if (contract.masterPdfUrl) {
    fileUrl = contract.masterPdfUrl;
  } else {
    return res.status(400).json({ error: "Tidak ada berkas PDF: unggah hasil export atau pastikan kontrak punya dokumen upload" });
  }

  contract.updatedAt = new Date().toISOString();
  pushAudit(db, req, {
    contractId: contract.id, contractNumber: contract.contractNumber,
    action: "Export & Share PDF",
    details: `Menyiapkan tautan PDF kontrak untuk dibagikan (print & TTD basah): ${fileUrl}`,
  });
  saveDB(db);

  // fileUrl is already absolute when it came from cloud storage — only a
  // local /uploads/... path needs the app's own base URL prefixed onto it.
  const absoluteUrl = fileUrl.startsWith("/") ? `${shareBaseUrl(req)}${fileUrl}` : fileUrl;
  res.json({ success: true, url: fileUrl, absoluteUrl });
});

// Send a previously-generated share link by email. Scoped to a contract the
// caller already owns and to a fixed template (not free-form content), so an
// authenticated user can't turn this into an open relay for arbitrary email.
app.post("/api/contracts/:id/export-share/email", requireAuth, async (req: AuthedRequest, res) => {
  const db = loadDB();
  const contract = findOwnedContract(db, req, req.params.id);
  if (!contract) return res.status(404).json({ error: "Contract not found" });

  const to = String(req.body.email || "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return res.status(400).json({ error: "Alamat email tidak valid." });
  }
  const url = contract.exportedPdfUrl || contract.masterPdfUrl;
  if (!url) return res.status(400).json({ error: "Belum ada dokumen PDF untuk kontrak ini." });
  const absoluteUrl = url.startsWith("http") ? url : `${shareBaseUrl(req)}${url}`;

  if (!isEmailConfigured()) {
    return res.status(503).json({ error: "SMTP belum dikonfigurasi di server. Gunakan tautan manual (mailto/WA) sebagai gantinya." });
  }

  // Lampirkan PDF-nya langsung bila berkasnya bisa diambil dari storage —
  // penerima tidak wajib klik tautan. Gagal fetch (mis. berkas legacy tanpa
  // key tersimpan) bukan alasan menggagalkan email: fallback link-only.
  // Fallback basename(url) aman selama uploadFileKey() menghasilkan key flat
  // tanpa segmen path.
  let attachments: { filename: string; content: Buffer; contentType: string }[] | undefined;
  try {
    const key = contract.exportedPdfKey || path.basename(new URL(absoluteUrl).pathname);
    const buf = await fetchFile(key);
    if (buf.length <= 10 * 1024 * 1024) {
      attachments = [{ filename: `Kontrak_${contract.contractNumber.replace(/\//g, "-")}.pdf`, content: buf, contentType: "application/pdf" }];
    }
  } catch (err) {
    logger.warn({ err, contractId: contract.id }, "PDF attachment fetch failed — sending link-only email");
  }

  const result = await sendEmail({
    to,
    subject: `Dokumen Kontrak untuk Ditandatangani: ${contract.contractNumber}`,
    html: emailTemplate({
      title: "Dokumen Kontrak Siap Ditandatangani",
      bodyHtml: `<p>Silakan unduh, cetak, dan tandatangani dokumen kontrak berikut:</p>
        <p><b>${contract.title}</b><br/>No. ${contract.contractNumber}</p>
        ${attachments ? "<p>Dokumen PDF terlampir pada email ini; tautan unduh juga tersedia di bawah.</p>" : ""}
        <p>Setelah ditandatangani, mohon kirimkan kembali hasil scan dokumen kepada kami.</p>`,
      ctaLabel: "Unduh Dokumen PDF",
      ctaUrl: absoluteUrl,
    }),
    attachments,
  });

  if (result.sent) {
    pushAudit(db, req, {
      contractId: contract.id, contractNumber: contract.contractNumber,
      action: "Email PDF Kontrak",
      details: `Mengirim tautan dokumen PDF via email ke ${to}`,
    });
    saveDB(db);
  }

  res.json({ success: result.sent, error: result.error });
});

// 6d. OCR DOKUMEN HARDCOPY/SCAN — menerjemahkan berkas upload menjadi teks
// pasal, sehingga fitur Preview / Compare / Extend menampilkan isi teksnya.
// Memakai Gemini vision jika GEMINI_API_KEY dikonfigurasi; jika tidak,
// fallback ke hasil simulasi yang DIBERI LABEL JELAS (tidak pura-pura asli).
app.post("/api/contracts/:id/ocr", requireAuth, async (req: AuthedRequest, res) => {
  const db = loadDB();
  const contract = findOwnedContract(db, req, req.params.id);
  if (!contract) return res.status(404).json({ error: "Contract not found" });
  if (!contract.masterPdfUrl) {
    return res.status(400).json({ error: "Kontrak ini tidak memiliki dokumen upload untuk di-OCR" });
  }
  const filePath = path.join(uploadDir, path.basename(contract.masterPdfUrl));
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Berkas dokumen tidak ditemukan di server" });
  }

  const hasRealKey = !!process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== "MY_GEMINI_API_KEY";
  let ocrResult: { fullText: string; clauses: { title: string; content: string }[]; simulated: boolean } | null = null;
  let ocrFailureReason = "";

  if (hasRealKey) {
    try {
      const ext = path.extname(filePath).toLowerCase();
      const mime = ext === ".pdf" ? "application/pdf" : ext === ".png" ? "image/png" : "image/jpeg";
      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: [
          { inlineData: { mimeType: mime, data: fs.readFileSync(filePath).toString("base64") } },
          {
            text: `Lakukan OCR penuh pada dokumen kontrak ini, lalu strukturkan menjadi pasal-pasal.
            Balas JSON: { "fullText": "seluruh teks dokumen", "clauses": [ { "title": "Judul Pasal", "content": "Isi pasal" } ] }.
            Jika dokumen tidak memiliki struktur pasal, bagi ke bagian-bagian logis dengan judul deskriptif.`,
          },
        ],
        config: { responseMimeType: "application/json" },
      });
      const parsed = parseAiJson(response.text);
      if (parsed.fullText || (parsed.clauses && parsed.clauses.length)) {
        ocrResult = { fullText: parsed.fullText || "", clauses: parsed.clauses || [], simulated: false };
      }
    } catch (err) {
      logger.warn({ err }, "Gemini OCR failed, falling back to simulation mode");
      ocrFailureReason = String((err as any)?.message || err).slice(0, 200);
    }
  }

  if (!ocrResult) {
    // Fallback simulasi: susun teks dari metadata kontrak yang sudah dikenal,
    // dengan penanda jelas bahwa ini bukan hasil pembacaan dokumen asli.
    // Sebabnya HARUS jujur: dulu selalu tertulis "GEMINI_API_KEY belum
    // dikonfigurasi" walau key-nya terpasang dan yang gagal sebenarnya
    // panggilan/parsing AI — menyesatkan saat menelusuri masalah.
    const fileName = path.basename(contract.masterPdfUrl);
    const reasonLabel = !hasRealKey
      ? "GEMINI_API_KEY belum dikonfigurasi"
      : `pembacaan AI gagal — ${ocrFailureReason || "penyebab tidak diketahui"}`;
    ocrResult = {
      simulated: true,
      fullText: `[HASIL OCR SIMULASI — ${reasonLabel}]\nBerkas: ${fileName}\nDokumen: ${contract.title}\nPara pihak: ${contract.party1Name} dan ${contract.party2Name}\nMasa berlaku: ${contract.startDate} s/d ${contract.endDate}`,
      clauses: [
        { title: "Para Pihak [OCR Simulasi]", content: `Perjanjian ini dibuat antara ${contract.party1Name} selaku Pihak Pertama dan ${contract.party2Name} selaku Pihak Kedua, sebagaimana tercantum pada dokumen "${contract.title}".` },
        { title: "Jangka Waktu [OCR Simulasi]", content: `Perjanjian berlaku sejak ${contract.startDate} sampai dengan ${contract.endDate}.` },
        { title: "Nilai Perjanjian [OCR Simulasi]", content: `Nilai perjanjian sebesar ${contract.currency} ${Number(contract.contractValue || 0).toLocaleString("id-ID")}.` },
        { title: "Isi Dokumen [OCR Simulasi]", content: `Teks lengkap belum dapat dibaca otomatis karena OCR AI belum aktif (GEMINI_API_KEY belum diisi). Isi asli tetap dapat dilihat pada berkas terlampir: ${fileName}. Setelah API key dikonfigurasi, jalankan ulang OCR untuk mengganti bagian ini dengan teks asli dokumen.` },
      ],
    };
  }

  contract.ocrText = ocrResult.fullText;
  contract.ocrSimulated = ocrResult.simulated;
  // Isi pasal dari hasil OCR agar Preview/Compare/Extend menampilkan teks.
  // Jangan timpa pasal yang sudah ada kecuali diminta eksplisit.
  if (!contract.clauses || contract.clauses.length === 0 || req.body?.overwrite) {
    contract.clauses = ocrResult.clauses.map((c, i) => ({
      id: `ocr-cls-${Date.now()}-${i}`,
      title: c.title,
      content: c.content,
      order: i + 1,
    }));
    // Pasal lama diganti total (id-nya juga berubah) → terjemahan EN yang
    // menempel di pasal SEBELUMNYA sudah tidak berpadanan dengan teks sumber
    // yang baru. Jangan biarkan pasal baru diam-diam tampil dengan
    // terjemahan basi (salah/menyesatkan) — bersihkan, paksa terjemahan
    // ulang saat toggle EN/ID+EN dipilih lagi (lihat handleSetDocumentLanguage).
    if (contract.preambleEn || contract.translationUpdatedAt) {
      contract.preambleEn = undefined;
      contract.preambleEnOriginal = undefined;
      contract.translationUpdatedAt = undefined;
      contract.translationSimulated = undefined;
      contract.translationWarnings = undefined;
      if (contract.documentLanguage && contract.documentLanguage !== "id") contract.documentLanguage = "id";
    }
  }
  contract.updatedAt = new Date().toISOString();

  pushAudit(db, req, {
    contractId: contract.id, contractNumber: contract.contractNumber,
    action: ocrResult.simulated ? "OCR Dokumen (Simulasi)" : "OCR Dokumen",
    details: `Menerjemahkan dokumen upload menjadi ${contract.clauses.length} pasal teks${ocrResult.simulated ? " (mode simulasi, AI belum aktif)" : " via Gemini OCR"}`,
  });
  saveDB(db);

  res.json({ success: true, contract, simulated: ocrResult.simulated });
});

// 7. VERSION CONTROL COMPARISON & HISTORI
app.get("/api/contracts/:id/versions", requireAuth, (req: AuthedRequest, res) => {
  const db = loadDB();
  const contract = findOwnedContract(db, req, req.params.id);
  if (!contract) return res.status(404).json({ error: "Contract not found" });
  const versions = (db.versions as ContractVersion[]).filter((v) => v.contractId === contract.id);
  res.json(versions);
});


// 8. SMART RENEWAL ENGINE (klik perpanjang, AI atau sistem buat perpanjangan otomatis tahun berikutnya)
app.post("/api/contracts/:id/renew", requireAuth, requireRole("admin", "staff", "legal", "manager"), (req: AuthedRequest, res) => {
  const db = loadDB();
  const tid = tenantOf(req);
  const sourceContract = findOwnedContract(db, req, req.params.id);
  if (sourceContract) {
    // Perpanjangan hanya masuk akal untuk kontrak yang sudah PERNAH benar-
    // benar berlaku (lolos matriks approval) — bukan Draft/OnReview/
    // FullyApproved-belum-aktif. Cermin server-side dari gate tombol di UI
    // (isContractRenewable) — pertahanan berlapis, bukan cuma sembunyikan tombol.
    if (!["Aktif", "TidakAktif", "Archived", "Terminated"].includes(sourceContract.status)) {
      return res.status(400).json({ error: "Perpanjangan hanya bisa dibuat untuk kontrak yang sudah pernah aktif (lolos matriks approval)." });
    }
    // Guard against duplicate renewal drafts: if a non-terminal renewal
    // already exists for this contract, point the caller at it instead of
    // silently creating another one every time "Perpanjang" is clicked.
    const existingRenewal = (db.contracts as Contract[]).find(
      (c) => c.tenantId === tid && c.renewedFromId === sourceContract.id
        && c.status !== "Terminated" && c.status !== "Archived",
    );
    if (existingRenewal) {
      return res.status(409).json({
        error: `Kontrak ini sudah punya draft perpanjangan (${existingRenewal.contractNumber}, status: ${existingRenewal.status}). Tinjau draft tersebut alih-alih membuat yang baru.`,
        existingContractId: existingRenewal.id,
      });
    }

    const currentYear = new Date().getFullYear().toString();

    // Tentukan periode baru (default 1 tahun sejak akhir kontrak lama),
    // tapi izinkan override dari preview/edit di UI perpanjangan.
    const startObj = new Date(sourceContract.endDate);
    // Tambah 1 hari dari tanggal selesai lama sebagai tgl mulai baru
    startObj.setDate(startObj.getDate() + 1);
    const endObj = new Date(startObj);
    endObj.setFullYear(endObj.getFullYear() + 1); // Perpanjang otomatis 1 tahun

    const { number: newContractNumber, seq: newNumberSeq } = generateContractNumber(db, tid, sourceContract.category, sourceContract.docType, currentYear);
    const newStartDate = req.body.startDate || startObj.toISOString().split("T")[0];
    const newEndDate = req.body.endDate || endObj.toISOString().split("T")[0];

    const renewedContract: Contract = {
      ...sourceContract,
      id: "ctr-" + Date.now(),
      tenantId: tid,
      contractNumber: newContractNumber,
      numberSeq: newNumberSeq, // timpa numberSeq warisan dari sourceContract
      renewedFromId: sourceContract.id,
      title: req.body.title || `${sourceContract.title} (Renewal ${parseInt(currentYear, 10) + 1})`,
      startDate: newStartDate,
      endDate: newEndDate,
      contractValue: req.body.contractValue !== undefined ? Number(req.body.contractValue) : sourceContract.contractValue,
      // Dokumen baru (jika diunggah) terpisah dari dokumen kontrak sebelumnya;
      // dokumen sourceContract tidak diubah sama sekali.
      masterPdfUrl: req.body.masterPdfUrl || null,
      status: "Draft", // Perpanjangan lahir sebagai draft — aktifkan setelah final
      // Approval matrix TIDAK ikut ter-spread dari sourceContract — draft
      // perpanjangan harus melalui pengajuan persetujuannya sendiri, bukan
      // mewarisi matrix (yang sudah selesai/basi) milik kontrak asal.
      approvalSteps: undefined,
      approvalRound: undefined,
      approvalSubmittedById: undefined,
      approvalSubmittedByName: undefined,
      approvalHistory: undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // Update variables
    renewedContract.variables = {
      ...sourceContract.variables,
      StartDate: renewedContract.startDate,
      EndDate: renewedContract.endDate,
      AgreementNumber: newContractNumber
    };

    db.contracts.push(renewedContract);

    pushAudit(db, req, {
      contractId: renewedContract.id,
      contractNumber: renewedContract.contractNumber,
      action: "Renew",
      details: `Memperpanjang kontrak ${sourceContract.contractNumber} menjadi ${renewedContract.contractNumber} dengan masa berlaku baru`,
    });
    pushNotif(db, tid, {
      title: "Perpanjangan Kontrak Dibuat",
      message: `Kontrak perpanjangan otomatis ${renewedContract.contractNumber} telah di-generate. Silakan tinjau pasal-pasalnya sebelum diaktifkan.`,
      type: "success",
      contractId: renewedContract.id,
    });

    saveDB(db);
    res.json({ success: true, contract: renewedContract });
  } else {
    res.status(404).json({ error: "Contract not found" });
  }
});


// 9. AUDIT TRAILS & NOTIFICATIONS
app.get("/api/audits", requireAuth, (req: AuthedRequest, res) => {
  const db = loadDB();
  res.json(scoped(db.audits as AuditTrail[], tenantOf(req)));
});

app.get("/api/notifications", requireAuth, (req: AuthedRequest, res) => {
  const db = loadDB();
  // targetUserIds kosong/tidak ada = notifikasi seluruh tenant (perilaku lama,
  // sengaja tidak diubah). Kalau diisi, hanya orang yang disebut yang melihat —
  // dipakai eskalasi SLA supaya teguran keterlambatan tidak jadi pengumuman
  // sekantor.
  const mine = scoped(db.notifications as SystemNotification[], tenantOf(req))
    .filter((n) => !n.targetUserIds?.length || n.targetUserIds.includes(req.user!.id));
  res.json(mine);
});

app.post("/api/notifications/read-all", requireAuth, (req: AuthedRequest, res) => {
  const db = loadDB();
  const tid = tenantOf(req);
  (db.notifications as SystemNotification[]).forEach((n) => {
    if (n.tenantId === tid) n.read = true;
  });
  saveDB(db);
  res.json({ success: true });
});

// Manual trigger for the proactive expiry-reminder sweep (normally runs on
// its own 6h timer). Scoped to super_admin since the sweep evaluates
// contracts across every tenant, not just the caller's.
app.post("/api/reminders/run-check", requireAuth, requireRole("super_admin"), async (req: AuthedRequest, res) => {
  await runReminderCheck();
  res.json({ success: true });
});

// Database + uploads backup snapshots (local disk). super_admin-scoped since
// this touches the whole system's data, not just one tenant.
app.get("/api/admin/backups", requireAuth, requireRole("super_admin"), (req: AuthedRequest, res) => {
  res.json(listBackups());
});

app.post("/api/admin/backups/run", requireAuth, requireRole("super_admin"), async (req: AuthedRequest, res) => {
  try {
    const result = await runBackup();
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Backup gagal" });
  }
});

// SMTP status + connection test. Credentials live in .env (infra-level,
// shared across tenants), so there's nothing tenant-specific to configure
// here — just whether the server-wide relay is reachable.
app.get("/api/admin/email/status", requireAuth, requireRole("super_admin"), (req: AuthedRequest, res) => {
  res.json({ configured: isEmailConfigured() });
});

app.post("/api/admin/email/test-connection", requireAuth, requireRole("super_admin"), async (req: AuthedRequest, res) => {
  const result = await testEmailConnection();
  res.json(result);
});

// Storage status: cloud (S3-compatible) vs local disk fallback. Same
// infra-level, cross-tenant scope as SMTP status above.
app.get("/api/admin/storage/status", requireAuth, requireRole("super_admin"), (req: AuthedRequest, res) => {
  res.json({ cloudConfigured: isStorageCloudBacked() });
});


// 10. AI ENDPOINTS (GEMINI INTEGRATION)

// AI 1: Suggest suitable template based on text prompt
app.post("/api/ai/suggest-template", requireAuth, async (req, res) => {
  const prompt = req.body.prompt;
  if (!prompt) {
    return res.status(400).json({ error: "Prompt is required" });
  }

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: `Rekomendasikan kategori kontrak dan sebutkan 3-5 pasal penting yang wajib dimasukkan untuk permintaan bisnis ini: "${prompt}". 
      Tanggapi dalam bentuk format JSON yang rapi dengan struktur:
      {
        "category": "Employment" | "Vendor" | "Customer" | "Legalitas Perusahaan" | "NDA" | "MOU" | "Rental" | "Services" | "Other",
        "recommendedTitle": "Judul Kontrak yang Disarankan",
        "reason": "Alasan penentuan kategori ini",
        "mandatoryClauses": [
          {"title": "Nama Pasal", "reason": "Penjelasan mengapa pasal ini wajib"}
        ],
        "variablesToAsk": ["Nama variabel yang harus ditanyakan ke pengguna"]
      }`,
      config: {
        responseMimeType: "application/json",
      }
    });

    const result = parseAiJson(response.text);
    res.json(result);
  } catch (err: any) {
    logger.error({ err }, "AI template recommendation failed");
    aiErrorResponse(res, err, "AI failed to process. Please check GEMINI_API_KEY.");
  }
});

// AI 2: Compare text/clauses with current Indonesian Laws & Regulations (UU Ketenagakerjaan, UU Cipta Kerja, dll.)
app.post("/api/ai/compliance-check", requireAuth, async (req, res) => {
  const { title, clauses, category } = req.body;
  if (!clauses || !Array.isArray(clauses)) {
    return res.status(400).json({ error: "Clauses are required and must be an array" });
  }

  const contractFullText = clauses.map(c => `Pasal: ${c.title}\nIsi: ${c.content}`).join("\n\n");

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: `Anda adalah pakar hukum korporasi dan ketenagakerjaan di Indonesia. Tinjau dokumen draf kontrak atau pasal-pasal berikut (Kategori: ${category || 'Umum'}):
      
      === MULAI KONTRAK ===
      Judul: ${title || "Draf Agreement"}
      
      ${contractFullText}
      === AKHIR KONTRAK ===

      Analisislah draf di atas berdasarkan Undang-Undang dan Peraturan Republik Indonesia yang berlaku saat ini (seperti UU Ketenagakerjaan, UU Cipta Kerja No. 6 Tahun 2023, KUHPerdata, PP tentang PKWT, dll.). 
      Sebutkan apakah ada pasal yang TIDAK SESUAI, BERISIKO TINGGI, atau melanggar peraturan perundang-undangan saat ini.
      Berikan masukan berupa 'suggest' (saran perbaikan redaksional/pasal tambahan) dan highlight risiko hukumnya.
      
      Tanggapi dalam bentuk JSON dengan format berikut:
      {
        "isCompliant": boolean (true jika tidak ada pelanggaran hukum fatal, false jika ada resiko fatal),
        "overallSummary": "Ringkasan kepatuhan hukum kontrak ini",
        "violations": [
          {
            "clauseTitle": "Nama Pasal yang diperiksa",
            "issue": "Detail ketidaksesuaian dengan regulasi UU saat ini",
            "severity": "High" | "Medium" | "Low",
            "regulatoryReference": "Pasal atau UU rujukan (misal: Pasal 59 UU No 13/2003 jo UU Cipta Kerja)",
            "correctionSuggest": "Redaksional saran perbaikan pasal yang sah"
          }
        ],
        "missingEssentialClauses": [
          {
            "title": "Nama pasal esensial yang hilang dari draf",
            "suggestedText": "Teks standar klausa tersebut untuk dimasukkan",
            "importance": "Mengapa ini penting dimasukkan"
          }
        ]
      }`,
      config: {
        responseMimeType: "application/json",
      }
    });

    const result = parseAiJson(response.text);
    res.json(result);
  } catch (err: any) {
    logger.error({ err }, "AI compliance checker failed");
    aiErrorResponse(res, err, "AI Compliance check failed. Please make sure GEMINI_API_KEY is configured.");
  }
});

// AI 3: Summarize and Extract variables automatically from raw text
app.post("/api/ai/extract-details", requireAuth, async (req, res) => {
  const { rawText } = req.body;
  if (!rawText) {
    return res.status(400).json({ error: "Raw contract text is required" });
  }

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: `Analisislah draf teks kontrak acak berikut dan ekstrak ringkasan penting serta nilai-nilai variabel yang terkandung di dalamnya.
      
      === TEKS DOKUMEN ===
      ${rawText}
      === AKHIR TEKS ===

      Tanggapi dalam format JSON sebagai berikut:
      {
        "title": "Judul kontrak yang diidentifikasi",
        "summaryPoints": ["Poin penting ringkasan isi kontrak..."],
        "variables": {
          "CompanyName": "Nama perusahaan pihak kesatu jika ditemukan",
          "VendorName": "Nama vendor/karyawan pihak kedua jika ditemukan",
          "EmployeeName": "Nama karyawan jika ini PKWT",
          "Position": "Jabatan jika PKWT",
          "Salary": "Gaji dalam bentuk angka atau null",
          "StartDate": "Tanggal mulai YYYY-MM-DD atau null",
          "EndDate": "Tanggal berakhir YYYY-MM-DD atau null",
          "ContractValue": "Nilai nominal total kontrak dalam bentuk angka atau null",
          "Currency": "Mata uang (misal: IDR, USD)"
        },
        "riskLevel": "Low" | "Medium" | "High",
        "riskAnalysis": "Analisis resiko draf teks ini"
      }`,
      config: {
        responseMimeType: "application/json",
      }
    });

    const result = parseAiJson(response.text);
    res.json(result);
  } catch (err: any) {
    logger.error({ err }, "AI details extraction failed");
    aiErrorResponse(res, err, "AI failed to extract details.");
  }
});

// OCR form pendaftaran: baca PDF/scan yang BELUM didaftarkan dan ekstrak
// field-field Form Pendaftaran Dokumen langsung dari isinya, supaya user
// tinggal koreksi alih-alih mengetik semuanya manual. Nilai docType /
// party2Type / kategori dipilihkan dari daftar dinamis milik tenant (bukan
// nilai bebas) agar hasilnya langsung cocok dengan opsi dropdown form.
app.post("/api/ai/extract-registration", requireAuth, upload.single("file"), async (req: AuthedRequest, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const db = loadDB();
  const tid = tenantOf(req);
  const md = withSettingsDefaults(rawSettingsFor(db, tid)).masterData;
  const categories = catsFor(db, tid);
  const docTypeNames = (md.docTypes || []).map((d: any) => (typeof d === "string" ? d : d.name));
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: [
        { inlineData: { mimeType: req.file.mimetype, data: req.file.buffer.toString("base64") } },
        {
          text: `Anda adalah asisten arsip legal. Baca dokumen kontrak/perjanjian ini (OCR bila hasil scan), lalu ekstrak data untuk form pendaftaran arsip.

Pilih nilai dari daftar berikut PERSIS seperti tertulis (jangan mengarang nilai di luar daftar; jika tidak yakin pilih yang paling mendekati):
- category (folder arsip): ${JSON.stringify(categories)}
- docType (jenis dokumen): ${JSON.stringify(docTypeNames)}
- party2Type (tipe pihak kedua): ${JSON.stringify(md.partyTypes || [])}
- currency: ${JSON.stringify(md.currencies || ["IDR"])}

Balas JSON:
{
  "title": "judul/nama dokumen sesuai isi",
  "category": "salah satu dari daftar category",
  "docType": "salah satu dari daftar docType",
  "party1Name": "nama pihak pertama atau null",
  "party2Name": "nama pihak kedua atau null",
  "party2Type": "salah satu dari daftar party2Type",
  "startDate": "YYYY-MM-DD atau null",
  "endDate": "YYYY-MM-DD atau null",
  "contractValue": 0,
  "currency": "salah satu dari daftar currency",
  "hasMaterai": true/false (apakah terlihat ada meterai/e-meterai pada dokumen),
  "notes": "ringkasan 1-2 kalimat isi dokumen"
}`,
        },
      ],
      config: { responseMimeType: "application/json" },
    });
    res.json(parseAiJson(response.text));
  } catch (err: any) {
    logger.error({ err }, "AI registration extraction failed");
    if (String(err?.message || "").includes("no pages")) {
      return res.status(400).json({ error: "Berkas PDF tidak valid / kosong — pastikan file PDF berisi halaman." });
    }
    aiErrorResponse(res, err, "Gagal membaca dokumen via OCR AI.");
  }
});

// DCS analogue of extract-registration above: OCR-autofill for the "Unggah
// Dokumen Jadi" path of the document-control creation wizard. Same
// inline-base64-to-Gemini shape, but constrains docTypeCode to this tenant's
// REAL Smart DCS document classes (not the contract module's masterData) so
// the suggestion is always something the wizard's dropdown can actually
// select — never a hallucinated code.
app.post("/api/ai/extract-dcs-metadata", requireAuth, upload.single("file"), async (req: AuthedRequest, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const tid = tenantOf(req);
  try {
    const docTypes = await listDcsDocTypes(dcsPool, tid);
    const docTypeCodes = docTypes.map((d) => d.code);
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: [
        { inlineData: { mimeType: req.file.mimetype, data: req.file.buffer.toString("base64") } },
        {
          text: `Anda adalah asisten Document Control ISO 9001. Baca dokumen ini (OCR bila hasil scan), lalu usulkan data untuk mendaftarkannya sebagai dokumen terkontrol.

Pilih docTypeCode dari daftar berikut PERSIS seperti tertulis (jangan mengarang kode di luar daftar; jika tidak yakin pilih yang paling mendekati jenis dokumennya):
- docTypeCode: ${JSON.stringify(docTypeCodes)}

Balas JSON:
{
  "title": "judul dokumen sesuai isi",
  "docTypeCode": "salah satu dari daftar docTypeCode",
  "department": "nama departemen/divisi pemilik dokumen jika terlihat, atau null"
}`,
        },
      ],
      config: { responseMimeType: "application/json" },
    });
    const result = parseAiJson(response.text);
    // Defense in depth beyond the prompt constraint: never hand the wizard a
    // docTypeCode that doesn't actually exist for this tenant.
    if (result.docTypeCode && !docTypeCodes.includes(result.docTypeCode)) delete result.docTypeCode;
    res.json(result);
  } catch (err: any) {
    logger.error({ err }, "AI DCS metadata extraction failed");
    if (String(err?.message || "").includes("no pages")) {
      return res.status(400).json({ error: "Berkas PDF tidak valid / kosong — pastikan file PDF berisi halaman." });
    }
    aiErrorResponse(res, err, "Gagal membaca dokumen via OCR AI.");
  }
});



// Migrasi satu kali (idempoten) data kontrak era TTD/approval ke siklus hidup
// baru. Status legacy dipetakan: yang sudah selesai/disetujui → Aktif, yang
// masih di tengah proses → Draft; properti data TTD/approval yang tersisa di
// JSONB ikut dibersihkan. WAJIB jalan sebelum request pertama — /renew
// men-spread kontrak sumber, jadi properti lama bisa "bangkit" ke kontrak
// baru kalau belum disapu.
function migrateLegacyContracts() {
  const db = loadDB();
  const statusMap: Record<string, string> = {
    Request: "Draft", Review: "Draft", Approval: "Draft",
    Signed: "Aktif", Approved: "Aktif", Signature: "Aktif",
    Completed: "Archived",
  };
  const validStatuses = ["Draft", "OnReview", "FullyApproved", "Aktif", "TidakAktif", "Archived", "Terminated"];
  const staleProps = ["signToken", "externalSignFor", "externalSignEmail", "useEMeterai", "signatures", "approvalWorkflow", "currentApprovalStep"];
  let migrated = 0;
  for (const contract of db.contracts as any[]) {
    let changed = false;
    if (statusMap[contract.status]) { contract.status = statusMap[contract.status]; changed = true; }
    else if (!validStatuses.includes(contract.status)) { contract.status = "Draft"; changed = true; } // string tak dikenal → Draft (aman: bisa diedit, tidak terkunci palsu)
    for (const prop of staleProps) {
      if (prop in contract) { delete contract[prop]; changed = true; }
    }
    for (const party of contract.parties || []) {
      for (const p of ["signed", "signedAt", "signer"]) {
        if (p in party) { delete party[p]; changed = true; }
      }
    }
    if (changed) migrated++;
  }
  if (migrated > 0) {
    saveDB(db);
    logger.info({ migrated }, "Migrated legacy contracts to new Draft/Aktif lifecycle");
  }
}

async function startServer() {
  await initFirebaseDB();
  migrateLegacyContracts();

  // Smart DCS (Document Control System): normalized module on the same Postgres
  // pool, mounted under /api/dcs. Schema init is idempotent. Kept separate from
  // the JSONB-blob store because its ISO invariants need real DB constraints.
  await initDcs(dcsPool);
  app.use("/api/dcs", createDcsRouter(dcsPool));
  // setInterval-based schedulers only make sense on a long-lived process.
  // On Vercel each invocation is a fresh/frozen function instance, so an
  // interval started here has no reliable way to keep firing — instead the
  // /api/cron/* endpoints below are wired to Vercel Cron (see vercel.json).
  if (!process.env.VERCEL) {
    startReminderScheduler();
    startDcsReminderScheduler(dcsPool);
    startBackupScheduler();
  }

  // Vercel Cron equivalents of the setInterval schedulers above. Vercel signs
  // its own cron requests with an `Authorization: Bearer $CRON_SECRET` header
  // when CRON_SECRET is set as an env var — this rejects anyone else from
  // triggering these for free (e.g. running an extra unscheduled backup).
  app.post("/api/cron/reminders", async (req, res) => {
    if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    try {
      await runReminderCheck();
      await runDcsReminderCheck(dcsPool);
      res.json({ success: true });
    } catch (err: any) {
      logger.error({ err }, "Cron reminder check failed");
      res.status(500).json({ error: err?.message || "Reminder check failed" });
    }
  });
  app.post("/api/cron/backup", async (req, res) => {
    if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    try {
      const result = await runBackup();
      res.json({ success: true, ...result });
    } catch (err: any) {
      logger.error({ err }, "Cron backup failed");
      res.status(500).json({ error: err?.message || "Backup failed" });
    }
  });

  // AI 4: AI Clause Writer
app.post("/api/ai/write-clause", requireAuth, async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "Prompt is required" });
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: `Anda adalah Senior Legal Drafter di Indonesia. Pengguna meminta: "${prompt}".
      Tuliskan satu buah klausul hukum (Legal Clause) yang formal, tegas, dan sesuai dengan hukum Indonesia (seperti KUHPerdata, UU Ketenagakerjaan, dll). 
      Format balasan dalam JSON:
      {
        "title": "Judul Pasal yang Sesuai",
        "content": "Isi pasal formal hukum",
        "tags": ["tag1", "tag2"],
        "reasoning": "Alasan penulisan pasal ini"
      }`,
      config: { responseMimeType: "application/json" }
    });
    res.json(parseAiJson(response.text));
  } catch (err: any) {
    logger.error({ err }, "AI write-clause failed");
    aiErrorResponse(res, err, "Gagal membuat klausul.");
  }
});

// AI 5: AI Risk Analysis & Legal Review (Inconsistencies, missing clauses, Risk Score)
app.post("/api/ai/analyze-risk", requireAuth, async (req, res) => {
  const { title, clauses, variables } = req.body;
  if (!Array.isArray(clauses)) {
    return res.status(400).json({ error: "clauses wajib berupa array pasal." });
  }
  const fullText = clauses.map((c: any) => `[${c.title}]\n${c.content}`).join("\n\n");
  
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: `Lakukan AI Risk Analysis komprehensif pada dokumen kontrak ini:
      Judul: ${title}
      Variabel: ${JSON.stringify(variables)}
      
      Isi Kontrak:
      ${fullText}
      
      Tugas:
      1. Berikan Risk Score (0-100, 100 berarti sangat berisiko).
      2. Temukan Inkonsistensi (misal di pasal 1 disebut 30 hari, di pasal 2 disebut 45 hari).
      3. Cek apakah ada variabel kosong atau belum terisi.
      4. Identifikasi Missing Essential Clauses (seperti SLA, Penalti, Force Majeure, Data Privacy).
      
      Format balasan JSON:
      {
        "riskScore": 85,
        "riskLevel": "High" | "Medium" | "Low",
        "inconsistencies": ["Inkonsistensi 1", "Inkonsistensi 2"],
        "missingClauses": ["SLA", "Penalti"],
        "emptyVariables": ["VendorName"],
        "summary": "Ringkasan analisis risiko"
      }`,
      config: { responseMimeType: "application/json" }
    });
    res.json(parseAiJson(response.text));
  } catch (err: any) {
    logger.error({ err }, "AI analyze-risk failed");
    aiErrorResponse(res, err, "Gagal menganalisis risiko.");
  }
});

// AI 6: Compare Versions & AI Change Summary
app.post("/api/ai/compare-versions", requireAuth, async (req, res) => {
  const { oldVersion, newVersion } = req.body;
  // Divalidasi eksplisit: tanpa ini `.map` melempar di luar try dan (sebelum
  // wrapAsyncHandler dipasang) mematikan proses server.
  if (!Array.isArray(oldVersion) || !Array.isArray(newVersion)) {
    return res.status(400).json({ error: "oldVersion dan newVersion wajib berupa array pasal." });
  }
  const oldText = oldVersion.map((c: any) => `[${c.title}]: ${c.content}`).join("\n");
  const newText = newVersion.map((c: any) => `[${c.title}]: ${c.content}`).join("\n");
  
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: `Bandingkan versi Lama dan versi Baru dari kontrak ini.
      Versi Lama:
      ${oldText}
      
      Versi Baru:
      ${newText}
      
      Tugas:
      1. Buat AI Change Summary.
      2. Tentukan Legal Impact (High/Medium/Low).
      3. Buat draft Addendum (Perjanjian Tambahan) otomatis jika ada perubahan signifikan.
      
      Format balasan JSON:
      {
        "summary": ["3 Clause Changed", "1 Clause Added"],
        "legalImpact": "Medium",
        "changes": [
          {"clause": "Judul Pasal", "status": "Added" | "Modified" | "Deleted", "detail": "Penjelasan perubahan"}
        ],
        "addendumDraft": "Draf teks Addendum yang sah secara hukum Indonesia berdasarkan perubahan ini."
      }`,
      config: { responseMimeType: "application/json" }
    });
    res.json(parseAiJson(response.text));
  } catch (err: any) {
    logger.error({ err }, "AI compare-versions failed");
    aiErrorResponse(res, err, "Gagal membandingkan versi.");
  }
});

// AI: Compare two ARBITRARY documents (e.g. a vendor's proposed draft vs our
// standard template, or two external documents pasted/OCR'd in) — distinct
// from compare-versions above, which only diffs our own internal version
// history (structured clause arrays already in our data model). This one
// takes raw free-text on both sides, so it also works for documents that
// never went through our template system at all.
app.post("/api/ai/compare-documents", requireAuth, async (req, res) => {
  const { documentA, documentB, labelA, labelB } = req.body;
  if (!documentA || !documentB) {
    return res.status(400).json({ error: "Dua dokumen (documentA dan documentB) wajib diisi untuk dibandingkan." });
  }
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: `Anda adalah pakar legal drafter internasional yang menguasai hukum kontrak Indonesia maupun praktik kontrak internasional. Bandingkan dua dokumen berikut secara menyeluruh, pasal per pasal jika memungkinkan.

      === DOKUMEN A: "${labelA || 'Dokumen A'}" ===
      ${documentA}
      === AKHIR DOKUMEN A ===

      === DOKUMEN B: "${labelB || 'Dokumen B'}" ===
      ${documentB}
      === AKHIR DOKUMEN B ===

      Tugas:
      1. Identifikasi perbedaan substantif (bukan cuma perbedaan kata, tapi perbedaan yang mengubah hak/kewajiban/risiko para pihak).
      2. Untuk tiap perbedaan, jelaskan pihak mana yang lebih diuntungkan/dirugikan oleh versi tersebut.
      3. Identifikasi klausul yang ada di salah satu dokumen tapi tidak ada di dokumen lainnya.
      4. Berikan rekomendasi: dokumen mana yang lebih aman secara hukum Indonesia, dan poin spesifik apa yang perlu dinegosiasikan ulang.
      5. Berikan overall risk delta (apakah Dokumen B secara keseluruhan menaikkan atau menurunkan risiko dibanding Dokumen A).

      Format balasan JSON:
      {
        "overallAssessment": "Ringkasan umum perbandingan kedua dokumen",
        "riskDelta": "Higher" | "Lower" | "Similar",
        "differences": [
          {
            "topic": "Topik/pasal yang berbeda",
            "documentAPosition": "Isi/posisi di Dokumen A",
            "documentBPosition": "Isi/posisi di Dokumen B",
            "favors": "Dokumen A" | "Dokumen B" | "Netral",
            "riskNote": "Catatan risiko atas perbedaan ini"
          }
        ],
        "onlyInA": ["Klausul yang cuma ada di Dokumen A"],
        "onlyInB": ["Klausul yang cuma ada di Dokumen B"],
        "negotiationPoints": ["Poin spesifik yang direkomendasikan untuk dinegosiasikan ulang"],
        "recommendation": "Rekomendasi akhir: dokumen mana yang sebaiknya dipakai sebagai basis, dan mengapa"
      }`,
      config: { responseMimeType: "application/json" }
    });
    res.json(parseAiJson(response.text));
  } catch (err: any) {
    logger.error({ err }, "AI compare-documents failed");
    aiErrorResponse(res, err, "Gagal membandingkan dokumen.");
  }
});

// AI: Generate a full contract draft (title + ordered clauses + suggested
// variables) from a plain-language business requirement — "create dokumen
// AI". Distinct from write-clause (single clause) and the template system
// (pre-authored clauses only) — this drafts original clause text from
// scratch based on the prompt, in Indonesian or English per `language`.
app.post("/api/ai/generate-contract-draft", requireAuth, async (req, res) => {
  const { prompt, category, language } = req.body;
  if (!prompt || !String(prompt).trim()) {
    return res.status(400).json({ error: "Deskripsikan kebutuhan kontrak yang ingin dibuat." });
  }
  const lang = language === "en" ? "en" : "id";
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: `Anda adalah Senior Legal Drafter internasional yang menguasai hukum kontrak Indonesia (KUHPerdata, UU Cipta Kerja, UU PDP, UU ITE) sekaligus praktik penyusunan kontrak berbahasa Inggris standar internasional. Susunlah draft kontrak LENGKAP berdasarkan kebutuhan berikut.

      Kategori kontrak: ${category || "Umum"}
      Bahasa keluaran: ${lang === "en" ? "Bahasa Inggris (English), gaya kontrak internasional formal" : "Bahasa Indonesia, gaya hukum formal sesuai konvensi kontrak Indonesia"}
      Kebutuhan bisnis (dari pengguna): ${prompt}

      Tugas:
      1. Susun judul kontrak yang sesuai.
      2. Susun pasal-pasal (clauses) LENGKAP dan runtut mulai dari Definisi, Ruang Lingkup, Hak & Kewajiban, Nilai & Pembayaran, Jangka Waktu, Force Majeure, Kerahasiaan, Penyelesaian Sengketa, hingga Penutup — sesuaikan dengan kategori & kebutuhan spesifik yang diminta. Isi tiap pasal harus teks hukum yang benar-benar bisa dipakai, bukan placeholder kosong.
      3. Sertakan variabel yang masih perlu diisi pengguna (nama pihak, nominal, tanggal, dst) memakai format {{NamaVariabel}} di dalam teks pasal, lalu daftar semua variabel itu terpisah.
      4. Tandai tingkat kehati-hatian (risk flags) untuk pasal-pasal yang biasanya jadi sumber sengketa pada jenis kontrak ini.

      Format balasan JSON:
      {
        "title": "Judul kontrak yang disusun",
        "clauses": [
          {"title": "Judul Pasal", "content": "Isi lengkap pasal, memakai {{Variabel}} untuk bagian yang perlu diisi"}
        ],
        "suggestedVariables": [
          {"key": "NamaVariabel", "label": "Label yang mudah dipahami", "type": "string" | "number" | "date"}
        ],
        "riskFlags": [
          {"clauseTitle": "Judul pasal terkait", "note": "Kenapa pasal ini butuh perhatian ekstra saat negosiasi/review"}
        ]
      }`,
      config: { responseMimeType: "application/json" }
    });
    const result = parseAiJson(response.text);
    res.json(result);
  } catch (err: any) {
    logger.error({ err }, "AI generate-contract-draft failed");
    aiErrorResponse(res, err, "Gagal membuat draft kontrak.");
  }
});

// AI 7: AI Legal Copilot Chat — real multi-turn memory. Previously this
// only ever sent the latest question, so follow-ups like "jelaskan lebih
// detail soal itu" had nothing to refer back to from the AI's side (the
// frontend showed history, but the model never saw it). Now the prior
// Q&A turns are sent as proper role-tagged `contents` so the model has
// actual conversational context, capped to the last 10 turns to keep
// prompt size bounded.
app.post("/api/ai/copilot", requireAuth, async (req, res) => {
  const { question, context, history } = req.body;
  if (!question || !String(question).trim()) {
    return res.status(400).json({ error: "Pertanyaan tidak boleh kosong." });
  }
  const priorTurns: { q: string; a: string }[] = Array.isArray(history) ? history.slice(-10) : [];
  const contents: { role: string; parts: { text: string }[] }[] = [];
  for (const turn of priorTurns) {
    if (!turn?.q || !turn?.a) continue;
    contents.push({ role: "user", parts: [{ text: turn.q }] });
    contents.push({ role: "model", parts: [{ text: turn.a }] });
  }
  contents.push({ role: "user", parts: [{ text: question }] });

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents,
      config: {
        systemInstruction: `Anda adalah AI Legal Copilot — pakar legalitas dokumen kontrak yang menguasai hukum Indonesia (KUHPerdata, UU Cipta Kerja, UU PDP, UU ITE) sekaligus praktik kontrak internasional, dan bisa menjawab dalam Bahasa Indonesia maupun Inggris sesuai bahasa pertanyaan pengguna.
        Konteks Kontrak Saat Ini: ${context || 'Tidak ada kontrak yang sedang dibuka.'}
        Jawab profesional, solutif, ringkas, konsisten dengan apa yang sudah dibahas di percakapan sebelumnya (kalau ada). Jika pertanyaan di luar konteks hukum/kontrak, tolak dengan sopan.`,
      },
    });
    res.json({ answer: response.text });
  } catch (err: any) {
    logger.error({ err }, "AI copilot failed");
    aiErrorResponse(res, err, "Copilot gagal merespon.");
  }
});

// Seeded Indonesian Regulations
const defaultRegulations = [
  {
    id: "reg-1",
    title: "UU No. 6 Tahun 2023 tentang Penetapan Perppu Cipta Kerja",
    category: "Ketenagakerjaan",
    enactedDate: "2023-03-21",
    status: "Aktif",
    summary: "Mengatur ketentuan PKWT (Perjanjian Kerja Waktu Tertentu), outsourcing, jam kerja, upah minimum, pesangon, dan pemutusan hubungan kerja (PHK) di Indonesia.",
    obligations: [
      "PKWT dilarang mensyaratkan masa percobaan (probation). Jika disyaratkan, batal demi hukum.",
      "Uang kompensasi PKWT wajib diberikan kepada pekerja saat berakhirnya jangka waktu kontrak kerja.",
      "PKWT dapat diperpanjang dengan jangka waktu keseluruhan maksimal 5 tahun."
    ]
  },
  {
    id: "reg-2",
    title: "UU No. 27 Tahun 2022 tentang Pelindungan Data Pribadi (PDP)",
    category: "Data Privacy",
    enactedDate: "2022-10-17",
    status: "Aktif",
    summary: "Mengatur kewajiban Pengendali Data Pribadi dan Prosesor Data Pribadi dalam memproses data karyawan, pelanggan, dan pihak ketiga secara sah, transparan, dan aman.",
    obligations: [
      "Wajib memperoleh persetujuan tertulis eksplisit (consent) untuk pemrosesan data pribadi.",
      "Wajib mencantumkan klausul perlindungan data pribadi dan penanganan kebocoran data dalam kontrak kerja sama.",
      "Adanya denda administratif hingga 2% dari pendapatan tahunan untuk pelanggaran data pribadi."
    ]
  },
  {
    id: "reg-3",
    title: "PP No. 35 Tahun 2021 tentang PKWT, Alih Daya, Waktu Kerja, dan PHK",
    category: "Ketenagakerjaan",
    enactedDate: "2021-02-02",
    status: "Aktif",
    summary: "Aturan turunan UU Cipta Kerja yang merinci perhitungan uang kompensasi PKWT, durasi maksimal PKWT, dan prosedur PHK secara operasional.",
    obligations: [
      "Kompensasi PKWT diberikan kepada pekerja yang memiliki masa kerja minimal 1 bulan secara terus menerus.",
      "Rumus uang kompensasi PKWT: (Masa Kerja / 12) x 1 Bulan Upah.",
      "Pemutusan PKWT sebelum waktunya mewajibkan pihak yang mengakhiri membayar ganti rugi sisa gaji."
    ]
  },
  {
    id: "reg-4",
    title: "Kitab Undang-Undang Hukum Perdata (KUHPerdata) Buku III",
    category: "Umum / Perikatan",
    enactedDate: "1847-04-30",
    status: "Aktif",
    summary: "Hukum dasar yang mengatur sahnya perjanjian (Pasal 1320), asas kebebasan berkontrak (Pasal 1338), dan wanprestasi (Pasal 1243) di Indonesia.",
    obligations: [
      "Syarat sah perjanjian: Kesepakatan, kecakapan, suatu hal tertentu, dan sebab yang halal (Pasal 1320).",
      "Perjanjian mengikat sebagai undang-undang bagi para pihak (Pasal 1338).",
      "Kewajiban ganti rugi wanprestasi timbul sejak debitur dinyatakan lalai (Pasal 1243)."
    ]
  },
  {
    id: "reg-5",
    title: "UU No. 1 Tahun 2024 tentang Perubahan Kedua UU ITE",
    category: "Teknologi / E-Commerce",
    enactedDate: "2024-01-02",
    status: "Aktif",
    summary: "Mengatur legalitas informasi elektronik, tanda tangan elektronik tersertifikasi (e-sign), dan transaksi elektronik secara nasional.",
    obligations: [
      "Tanda tangan elektronik memiliki kekuatan hukum setara tanda tangan basah jika memenuhi syarat keandalan (Pasal 11).",
      "Kewajiban penggunaan tanda tangan tersertifikasi untuk transaksi penting korporasi.",
      "Penyelenggaraan transaksi elektronik wajib aman, andal, dan bertanggung jawab."
    ]
  }
];

// GET: Regulations List
app.get("/api/regulations", requireAuth, (req, res) => {
  res.json(defaultRegulations);
});

// POST: AI Regulation Impact Analysis
app.post("/api/ai/analyze-regulation-impact", requireAuth, async (req: AuthedRequest, res) => {
  const { regulationId } = req.body;
  const db = loadDB();
  // Kritis: batasi ke portofolio kontrak milik tenant pemanggil saja — jangan
  // pernah kirim data kontrak perusahaan lain ke prompt AI.
  const contractsList = scoped(db.contracts as Contract[], tenantOf(req));
  const regulation = defaultRegulations.find(r => r.id === regulationId);

  if (!regulation) {
    return res.status(404).json({ error: "Regulation not found" });
  }

  const contractsBrief = contractsList.map((c: any) => ({
    id: c.id,
    number: c.contractNumber,
    title: c.title,
    category: c.category,
    party2: c.party2Name,
    value: c.contractValue,
    clauses: c.clauses.map((cl: any) => ({ title: cl.title, content: cl.content }))
  }));

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: `Anda adalah pakar hukum Indonesia.
      Tinjau regulasi baru berikut:
      Judul Regulasi: ${regulation.title}
      Kategori: ${regulation.category}
      Ringkasan Regulasi: ${regulation.summary}
      Kewajiban Utama: ${JSON.stringify(regulation.obligations)}

      Analisislah dampaknya terhadap portofolio kontrak aktif kami berikut:
      ${JSON.stringify(contractsBrief)}

      Tugas:
      1. Identifikasi kontrak mana saja yang terdampak oleh regulasi ini.
      2. Berikan analisis risiko spesifik untuk setiap kontrak yang terdampak (misalnya: klausul perlindungan data pribadi dsb).
      3. Berikan Risk Level (High, Medium, Low) untuk masing-masing kontrak.
      4. Buatkan draf pasal addendum yang sesuai untuk memperbaiki klausul tersebut agar patuh hukum.

      Tanggapi dalam format JSON sebagai berikut:
      {
        "impactSummary": "Ringkasan umum mengenai dampak regulasi terhadap seluruh portofolio kontrak.",
        "affectedContractsCount": number,
        "results": [
          {
            "contractId": "ID kontrak yang terdampak",
            "contractNumber": "Nomor kontrak",
            "contractTitle": "Judul kontrak",
            "impactLevel": "High" | "Medium" | "Low",
            "reason": "Penjelasan mengapa kontrak ini terpengaruh dan apa risikonya berdasarkan hukum Indonesia.",
            "actionRequired": "Tindakan perbaikan yang direkomendasikan",
            "addendumClauseDraft": "Draf pasal addendum yang disarankan untuk ditambahkan/diubah agar patuh hukum."
          }
        ]
      }`,
      config: { responseMimeType: "application/json" }
    });

    const result = parseAiJson(response.text);
    res.json(result);
  } catch (err: any) {
    logger.error({ err }, "AI regulation impact analysis failed");
    aiErrorResponse(res, err, "Gagal menganalisis dampak regulasi.");
  }
});

// POST: AI Court Decision Analyzer (Putusan Pengadilan)
app.post("/api/ai/analyze-court-decision", requireAuth, async (req, res) => {
  const { decisionText } = req.body;
  if (!decisionText) {
    return res.status(400).json({ error: "Decision text is required" });
  }

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: `Analisislah teks putusan pengadilan Indonesia berikut secara mendalam:
      
      === TEKS PUTUSAN ===
      ${decisionText}
      === AKHIR TEKS ===

      Tugas:
      1. Ekstrak informasi formal: Nomor Putusan, Pengadilan, Tanggal Putusan, Para Pihak.
      2. Ringkas Kasus Posisi (Latar belakang sengketa).
      3. Jelaskan Pertimbangan Hukum Hakim (Rasio Decidendi).
      4. Tuliskan Amar Putusan (Ruling).
      5. Berikan Analisis Dampak & Rekomendasi Bisnis untuk kontrak serupa milik perusahaan kita.

      Tanggapi dalam format JSON:
      {
        "decisionNumber": "Nomor Putusan lengkap",
        "court": "Nama Instansi Pengadilan",
        "parties": "Pihak Kesatu vs Pihak Kedua",
        "date": "Tanggal Putusan",
        "caseSummary": "Latar belakang duduk perkara secara ringkas",
        "ratioDecidendi": "Pertimbangan hukum utama hakim dalam menjatuhkan putusan",
        "ruling": "Isi singkat dari amar putusan",
        "businessImplications": ["Implikasi bisnis 1", "Implikasi bisnis 2"],
        "recommendations": ["Rekomendasi klausul pencegahan kontrak untuk tim Legal kami"]
      }`,
      config: { responseMimeType: "application/json" }
    });

    const result = parseAiJson(response.text);
    res.json(result);
  } catch (err: any) {
    logger.error({ err }, "AI court decision analyzer failed");
    aiErrorResponse(res, err, "Gagal menganalisis putusan pengadilan.");
  }
});

// POST: AI Legal Opinion Generator (Opini Hukum)
app.post("/api/ai/generate-legal-opinion", requireAuth, async (req, res) => {
  const { kasusPosisi, pertanyaanHukum, dasarHukum } = req.body;
  if (!kasusPosisi || !pertanyaanHukum) {
    return res.status(400).json({ error: "Kasus posisi dan pertanyaan hukum wajib diisi" });
  }

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: `Anda adalah Corporate Legal Counsel senior di Indonesia. Buatkan Legal Opinion (Opini Hukum) resmi dan terstruktur berdasarkan masukan berikut:
      
      Kasus Posisi (Fakta Kasus):
      ${kasusPosisi}

      Pertanyaan Hukum (Legal Issues):
      ${pertanyaanHukum}

      Dasar Hukum Referensi (Opsional):
      ${dasarHukum || "Gunakan UU Cipta Kerja, KUHPerdata, dan aturan terkait yang relevan secara otomatis."}

      Format output Legal Opinion harus lengkap, formal, dan objektif dalam format JSON:
      {
        "title": "MEMORANDUM HUKUM / LEGAL OPINION",
        "executiveSummary": "Ringkasan eksekutif dari kesimpulan hukum.",
        "factsAnalysis": "Analisis kronologi dan rekonstruksi fakta kasus.",
        "legalFramework": [
          {"regulation": "Nama UU / Pasal rujukan", "relevance": "Keterkaitan pasal tersebut dengan isu hukum di atas"}
        ],
        "legalDiscussion": "Diskusi dan analisis hukum mendalam yang menghubungkan fakta dengan dasar hukum secara teoritis dan normatif.",
        "conclusions": ["Kesimpulan hukum 1", "Kesimpulan hukum 2"],
        "businessRecommendations": ["Rekomendasi langkah strategis / mitigasi risiko bisnis"]
      }`,
      config: { responseMimeType: "application/json" }
    });

    const result = parseAiJson(response.text);
    res.json(result);
  } catch (err: any) {
    logger.error({ err }, "AI legal opinion generator failed");
    aiErrorResponse(res, err, "Gagal menghasilkan opini hukum.");
  }
});

// POST: AI Legal Translation (Terjemah Dokumen)
app.post("/api/ai/translate-legal", requireAuth, async (req, res) => {
  const { text, sourceLang, targetLang } = req.body;
  if (!text) {
    return res.status(400).json({ error: "Text is required" });
  }

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: `Anda adalah Penerjemah Tersumpah (Sworn Translator) spesialis dokumen hukum kontrak dari Indonesia ke Inggris dan sebaliknya.
      Terjemahkan teks hukum berikut dari ${sourceLang || 'Bahasa Indonesia'} ke ${targetLang || 'Bahasa Inggris'}:
      
      === TEKS DOKUMEN ===
      ${text}
      === AKHIR TEKS ===

      Terjemahkan secara formal dan presisi. Ekstrak juga beberapa istilah khusus (legal glossary) yang diterjemahkan beserta alasannya.

      Format output JSON:
      {
        "translatedText": "Hasil terjemahan formal dokumen hukum",
        "glossary": [
          {
            "original": "Istilah hukum asli",
            "translated": "Hasil terjemahan istilah",
            "explanation": "Penjelasan mengapa istilah ini digunakan dalam konteks hukum."
          }
        ]
      }`,
      config: { responseMimeType: "application/json" }
    });

    const result = parseAiJson(response.text);
    res.json(result);
  } catch (err: any) {
    logger.error({ err }, "AI legal translation failed");
    aiErrorResponse(res, err, "Gagal menerjemahkan dokumen.");
  }
});

// ===== ANALYTICS LANJUTAN =====
// GET /api/analytics — data nyata dari kontrak tenant: tren per bulan, breakdown kategori, nilai
app.get("/api/analytics", requireAuth, (req: AuthedRequest, res) => {
  const db = loadDB();
  const tid = tenantOf(req);
  const categoryFilter = typeof req.query.category === "string" ? req.query.category : "";
  const monthsParam = parseInt(String(req.query.months || "12"), 10);
  const monthsWindow = [3, 6, 12, 24].includes(monthsParam) ? monthsParam : 12;
  const allContracts = scoped(db.contracts as Contract[], tid).filter(
    (c) => !categoryFilter || categoryFilter === "Semua" || c.category === categoryFilter,
  );

  // Tren kontrak per bulan (jendela waktu dapat diperbesar/perkecil via ?months=3|6|12|24)
  const now = new Date();
  const monthlyTrend: { month: string; label: string; created: number; activated: number; value: number }[] = [];
  for (let i = monthsWindow - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const label = d.toLocaleDateString("id-ID", { month: "short", year: "2-digit" });
    const inMonth = allContracts.filter((c) => c.createdAt?.startsWith(key));
    const activatedInMonth = allContracts.filter((c) => c.status === "Aktif" && (c.updatedAt || c.createdAt)?.startsWith(key));
    monthlyTrend.push({
      month: key, label,
      created: inMonth.length,
      activated: activatedInMonth.length,
      value: inMonth.reduce((s, c) => s + (c.contractValue || 0), 0),
    });
  }

  // Breakdown per kategori
  const categoryMap: Record<string, { count: number; value: number }> = {};
  for (const c of allContracts) {
    const cat = c.category || "Other";
    if (!categoryMap[cat]) categoryMap[cat] = { count: 0, value: 0 };
    categoryMap[cat].count++;
    categoryMap[cat].value += c.contractValue || 0;
  }
  const byCategory = Object.entries(categoryMap)
    .map(([name, d]) => ({ name, count: d.count, value: d.value }))
    .sort((a, b) => b.count - a.count);

  // Breakdown per vendor/pihak
  const vendorMap: Record<string, { count: number; value: number }> = {};
  for (const c of allContracts) {
    const v = c.party2Name || "Unknown";
    if (!vendorMap[v]) vendorMap[v] = { count: 0, value: 0 };
    vendorMap[v].count++;
    vendorMap[v].value += c.contractValue || 0;
  }
  const byVendor = Object.entries(vendorMap)
    .map(([name, d]) => ({ name, count: d.count, value: d.value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);

  // Breakdown per status
  const statusMap: Record<string, number> = {};
  for (const c of allContracts) {
    statusMap[c.status] = (statusMap[c.status] || 0) + 1;
  }
  const byStatus = Object.entries(statusMap).map(([status, count]) => ({ status, count }));

  // Kontrak akan berakhir per bulan ke depan (6 bulan)
  const expiryForecast: { month: string; label: string; count: number }[] = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const label = d.toLocaleDateString("id-ID", { month: "short", year: "2-digit" });
    const count = allContracts.filter((c) => c.endDate?.startsWith(key) && c.status !== "Terminated" && c.status !== "Archived").length;
    expiryForecast.push({ month: key, label, count });
  }

  // Summary totals
  const totalValue = allContracts.reduce((s, c) => s + (c.contractValue || 0), 0);
  const activeValue = allContracts.filter((c) => c.status === "Aktif").reduce((s, c) => s + (c.contractValue || 0), 0);
  const expiringSoon = allContracts.filter((c) => {
    if (!c.endDate || c.status === "Terminated" || c.status === "Archived") return false;
    const diff = (new Date(c.endDate).getTime() - Date.now()) / 86400000;
    return diff >= 0 && diff <= 30;
  }).length;

  res.json({
    summary: {
      total: allContracts.length,
      aktif: allContracts.filter((c) => c.status === "Aktif").length,
      draft: allContracts.filter((c) => c.status === "Draft").length,
      expiringSoon,
      totalValue,
      activeValue,
    },
    monthlyTrend,
    byCategory,
    byVendor,
    byStatus,
    expiryForecast,
  });
});

// ===== KOMENTAR PER KLAUSUL =====
// GET /api/contracts/:id/comments — ambil semua komentar dalam 1 kontrak
app.get("/api/contracts/:id/comments", requireAuth, (req: AuthedRequest, res) => {
  const db = loadDB();
  const tid = tenantOf(req);
  const comments = (db.clauseComments as ClauseComment[] || [])
    .filter((c) => c.tenantId === tid && c.contractId === req.params.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  res.json(comments);
});

// POST /api/contracts/:id/comments — tambah komentar baru
app.post("/api/contracts/:id/comments", requireAuth, async (req: AuthedRequest, res) => {
  const db = loadDB();
  const tid = tenantOf(req);
  const contract = (db.contracts as Contract[]).find((c) => c.id === req.params.id && c.tenantId === tid);
  if (!contract) return res.status(404).json({ error: "Kontrak tidak ditemukan" });

  const { clauseId, clauseTitle, text, parentId, mentions, anchor, kind } = req.body;
  if (!clauseId || !text?.trim()) return res.status(400).json({ error: "clauseId dan text wajib diisi" });

  const u = req.user!;
  const comment: ClauseComment = {
    id: "cmt-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
    tenantId: tid,
    contractId: req.params.id,
    clauseId,
    clauseTitle: clauseTitle || clauseId,
    userId: u.id,
    userName: u.name,
    userRole: u.role,
    text: text.trim(),
    resolved: false,
    mentions: Array.isArray(mentions) ? mentions : [],
    createdAt: new Date().toISOString(),
    parentId: parentId || undefined,
    ...(anchor && typeof anchor.start === "number" && typeof anchor.end === "number"
      ? { anchor: { start: anchor.start, end: anchor.end, quote: String(anchor.quote || "").slice(0, 500) } } : {}),
    kind: kind === "strike" ? "strike" : "comment",
  };

  if (!db.clauseComments) db.clauseComments = [];
  db.clauseComments.unshift(comment);

  // Notifikasi ke pengguna yang di-mention (in-app + push browser real-time)
  if (Array.isArray(mentions) && mentions.length > 0) {
    for (const mentionedUserId of mentions) {
      const mentionedUser = (db.users as User[]).find((usr) => usr.id === mentionedUserId && usr.tenantId === tid);
      if (mentionedUser) {
        pushNotif(db, tid, {
          title: "Disebutkan dalam komentar",
          message: `${u.name} menyebut Anda dalam komentar pada kontrak "${contract.title}" (klausul: ${clauseTitle || clauseId})`,
          type: "info",
          contractId: req.params.id,
        });
        sendPushToUser(mentionedUserId, {
          title: `${u.name} menyebut Anda`,
          body: `Pada klausul "${clauseTitle || clauseId}" di kontrak ${contract.contractNumber}: "${text.trim().slice(0, 100)}"`,
          url: `/?contract=${req.params.id}`,
          tag: `mention-${comment.id}`,
        }).catch((err) => logger.warn({ err }, "Push for mention failed"));
      }
    }
  }

  // Notifikasi pemilik kontrak jika ada komentar baru
  pushNotif(db, tid, {
    title: "Komentar Baru pada Kontrak",
    message: `${u.name} menambahkan komentar pada klausul "${clauseTitle || clauseId}" di kontrak "${contract.title}"`,
    type: "info",
    contractId: req.params.id,
  });

  pushAudit(db, req, {
    contractId: contract.id,
    contractNumber: contract.contractNumber,
    action: "Add Comment",
    details: `Menambahkan komentar pada klausul "${clauseTitle || clauseId}": "${text.trim().slice(0, 80)}..."`,
  });

  saveDB(db);
  res.json({ success: true, comment });
});

// PUT /api/contracts/:id/comments/:cid — edit komentar (hanya pemilik)
app.put("/api/contracts/:id/comments/:cid", requireAuth, (req: AuthedRequest, res) => {
  const db = loadDB();
  const tid = tenantOf(req);
  const comment = (db.clauseComments as ClauseComment[] || []).find(
    (c) => c.id === req.params.cid && c.tenantId === tid && c.contractId === req.params.id
  );
  if (!comment) return res.status(404).json({ error: "Komentar tidak ditemukan" });

  const isOwnerOrPrivileged = comment.userId === req.user!.id || ["admin", "legal"].includes(req.user!.role);

  // Editing the actual comment text stays owner/admin/legal-only, but
  // resolving a thread is a collaborative action (Google-Docs style: anyone
  // who addressed the feedback should be able to mark it resolved, not just
  // whoever originally wrote it) — gating both the same way blocked that.
  if (req.body.text !== undefined) {
    if (!isOwnerOrPrivileged) return res.status(403).json({ error: "Tidak dapat mengedit teks komentar orang lain" });
    comment.text = req.body.text.trim();
  }
  if (typeof req.body.resolved === "boolean") {
    comment.resolved = req.body.resolved;
  }
  // Ubah sorotan/highlight komentar (mis. penulis salah menyorot kalimat
  // saat pertama membuat) — sama seperti edit teks, hanya pemilik/admin/legal.
  if (req.body.anchor !== undefined) {
    if (!isOwnerOrPrivileged) return res.status(403).json({ error: "Tidak dapat mengubah sorotan komentar orang lain" });
    const a = req.body.anchor;
    if (a === null) {
      delete comment.anchor; // lepas sorotan sepenuhnya (komentar jadi umum, tak menempel kalimat)
    } else if (a && typeof a.start === "number" && typeof a.end === "number" && a.end > a.start) {
      comment.anchor = { start: a.start, end: a.end, quote: String(a.quote || "").slice(0, 500) };
    } else {
      return res.status(400).json({ error: "Format sorotan tidak valid." });
    }
  }
  comment.updatedAt = new Date().toISOString();
  saveDB(db);
  res.json({ success: true, comment });
});

// DELETE /api/contracts/:id/comments/:cid — hapus komentar
app.delete("/api/contracts/:id/comments/:cid", requireAuth, (req: AuthedRequest, res) => {
  const db = loadDB();
  const tid = tenantOf(req);
  const idx = (db.clauseComments as ClauseComment[] || []).findIndex(
    (c) => c.id === req.params.cid && c.tenantId === tid && c.contractId === req.params.id
  );
  if (idx === -1) return res.status(404).json({ error: "Komentar tidak ditemukan" });
  const comment = db.clauseComments[idx];
  if (comment.userId !== req.user!.id && !["admin", "legal"].includes(req.user!.role)) {
    return res.status(403).json({ error: "Tidak dapat menghapus komentar orang lain" });
  }
  db.clauseComments.splice(idx, 1);
  saveDB(db);
  res.json({ success: true });
});

// ===== REVIEW EKSTERNAL VIA TOKEN LINK (pihak kedua tanpa akun) =====
// Alur: sebelum matriks approval, pembuat membagikan link ber-token ke pihak
// kedua. Tamu eksternal membuka link (tanpa login), melihat pratinjau klausul,
// bisa menyorot & mengomentari/mencoret klausul yang belum sesuai, atau klik
// "OK/Setuju". Semua endpoint publik di bawah ini di-scope KETAT oleh token
// (bukan tenant/akun) dan hanya membuka data klausul + komentar — tidak ada
// field kontrak sensitif lain yang dibocorkan.

// Aktifkan/putar token review eksternal (authed). Hanya sebelum FullyApproved.
app.post("/api/contracts/:id/external-review/enable", requireAuth, (req: AuthedRequest, res) => {
  const db = loadDB();
  const tid = tenantOf(req);
  const contract = (db.contracts as Contract[]).find((c) => c.id === req.params.id && c.tenantId === tid);
  if (!contract) return res.status(404).json({ error: "Kontrak tidak ditemukan" });
  if (contract.status === "Aktif" || contract.status === "Archived" || contract.status === "Terminated") {
    return res.status(409).json({ error: "Review eksternal hanya untuk kontrak yang masih dalam penyusunan/review (sebelum aktif)." });
  }
  contract.externalReviewToken = randomBytes(24).toString("hex");
  const days = Number(req.body?.expiresInDays);
  contract.externalReviewExpiresAt = Number.isFinite(days) && days > 0
    ? new Date(Date.now() + days * 86400000).toISOString() : null;
  contract.updatedAt = new Date().toISOString();
  pushAudit(db, req, { contractId: contract.id, contractNumber: contract.contractNumber, action: "Enable External Review", details: `Membuat link review eksternal${contract.externalReviewExpiresAt ? ` (kadaluarsa ${new Date(contract.externalReviewExpiresAt).toLocaleDateString("id-ID")})` : ""}.` });
  saveDB(db);
  res.json({ success: true, token: contract.externalReviewToken, expiresAt: contract.externalReviewExpiresAt, url: `${shareBaseUrl(req)}/?reviewToken=${contract.externalReviewToken}` });
});

// Matikan token (link lama langsung tidak berlaku).
app.post("/api/contracts/:id/external-review/disable", requireAuth, (req: AuthedRequest, res) => {
  const db = loadDB();
  const tid = tenantOf(req);
  const contract = (db.contracts as Contract[]).find((c) => c.id === req.params.id && c.tenantId === tid);
  if (!contract) return res.status(404).json({ error: "Kontrak tidak ditemukan" });
  contract.externalReviewToken = undefined;
  contract.externalReviewExpiresAt = null;
  contract.externalReviewLocked = false;
  contract.updatedAt = new Date().toISOString();
  saveDB(db);
  res.json({ success: true });
});

// Buka kembali akses komentar/setuju setelah tamu eksternal mengunci sesinya
// (klik Setuju/OK) — TIDAK memutar ulang token, link yang sama tetap berlaku.
app.post("/api/contracts/:id/external-review/unlock", requireAuth, (req: AuthedRequest, res) => {
  const db = loadDB();
  const tid = tenantOf(req);
  const contract = (db.contracts as Contract[]).find((c) => c.id === req.params.id && c.tenantId === tid);
  if (!contract) return res.status(404).json({ error: "Kontrak tidak ditemukan" });
  if (!contract.externalReviewToken) return res.status(409).json({ error: "Belum ada link review eksternal aktif untuk kontrak ini." });
  contract.externalReviewLocked = false;
  contract.updatedAt = new Date().toISOString();
  pushAudit(db, req, { contractId: contract.id, contractNumber: contract.contractNumber, action: "Unlock External Review", details: "Membuka kembali akses komentar/persetujuan eksternal (link tidak diganti)." });
  saveDB(db);
  res.json({ success: true });
});

// Resolusi token → kontrak (helper). Mengembalikan null kalau token tak ada/kadaluarsa.
function resolveExternalReview(token: string): Contract | null {
  if (!token) return null;
  const db = loadDB();
  const contract = (db.contracts as Contract[]).find((c) => c.externalReviewToken === token);
  if (!contract) return null;
  if (contract.externalReviewExpiresAt && new Date(contract.externalReviewExpiresAt) < new Date()) return null;
  return contract;
}

// PUBLIK (tanpa auth) — pratinjau klausul + komentar. Rate-limited via apiLimiter.
// Sama PERSIS dengan DEFAULT_PREAMBLE_TEMPLATE di src/App.tsx (renderPreambleParagraphs)
// — kalau salah satu diubah, ubah juga yang satunya supaya pratinjau internal
// dan halaman review eksternal selalu menampilkan narasi bawaan yang sama.
const DEFAULT_PREAMBLE_TEMPLATE_SERVER =
  "Pada hari ini, tanggal **{{StartDate}}**, kami yang bertandatangan di bawah ini:\n\n" +
  "**PIHAK PERTAMA:** {{Party1Name}}, berkedudukan di {{Party1Address}}, dalam hal ini diwakili oleh {{Party1Representative}} selaku {{Party1RepTitle}}, selanjutnya disebut sebagai **Pihak Pertama**.\n\n" +
  "**PIHAK KEDUA:** {{Party2Name}}, berdomisili di {{Party2Address}}, selanjutnya disebut sebagai **Pihak Kedua**.";

// Menyusun teks polos narasi pembuka sebuah kontrak (rantai fallback SAMA
// dengan getPreambleTemplateAndTokens di frontend: override per-kontrak >
// Template.openingParagraph > narasi kategori > bawaan sistem), lalu tambahkan
// baris Jabatan/No. Identitas otomatis kalau field-nya terisi. Dipakai untuk
// menyisipkan "pseudo-klausul" narasi pembuka ke halaman review eksternal —
// mengirim TEKS SUDAH JADI (bukan field mentah appSettings/party) supaya
// permukaan data yang diekspos ke publik tetap sekecil mungkin.
function composeContractPreambleText(db: any, contract: Contract): string {
  const settings = withSettingsDefaults(rawSettingsFor(db, contract.tenantId));
  // Potret template didahulukan dari template hidup: redaksi yang dipakai
  // kontrak ini harus tetap seperti saat dibuat, walau templatenya sudah
  // diubah orang lain belakangan. Kontrak lama (tanpa potret) jatuh kembali
  // ke template hidup, persis perilaku sebelumnya.
  const template =
    contract.customOpeningParagraph ||
    contract.templateSnapshot?.openingParagraph ||
    (db.templates as Template[]).find((t) => t.id === contract.templateId)?.openingParagraph ||
    settings.masterData?.categoryOpeningParagraphs?.[contract.category] ||
    DEFAULT_PREAMBLE_TEMPLATE_SERVER;
  const tokens: Record<string, string> = {
    ...(contract.variables || {}),
    StartDate: contract.startDate,
    // Placeholder untuk field yang belum diisi WAJIB berkurung siku — harus
    // sama persis dengan getPreambleTemplateAndTokens() di src/App.tsx. Dulu
    // tanpa kurung ("Alamat Perusahaan Anda"), sehingga di halaman review
    // eksternal kalimatnya terbaca seolah itu data sungguhan — justru di
    // permukaan yang dilihat pihak luar (vendor/mitra).
    Party1Name: settings.companyName || "[Nama perusahaan belum diisi]",
    Party1Address: contract.party1Address || settings.companyAddress || "[Alamat perusahaan belum diisi]",
    Party1Representative: settings.companyRepresentative || "[Nama perwakilan belum diisi]",
    Party1RepTitle: settings.companyRepresentativeTitle || "[Jabatan perwakilan belum diisi]",
    Party2Name: contract.party2Name,
    Party2Address: contract.party2Address || contract.variables?.Address || "[Alamat belum diisi]",
  };
  const substituted = template.replace(/\{\{([^}]+)\}\}/g, (_m: string, k: string) => tokens[k] ?? `{{${k}}}`);
  // Narasi bisa berupa HTML kaya (editor WYSIWYG) atau markdown lama. Review
  // eksternal = teks polos, jadi buang tag HTML + marker **tebal**. <br>/<p>/
  // <li> jadi baris; entitas dasar didecode.
  const plain = substituted
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/\*\*([^*]+)\*\*/g, "$1");
  const trailers: string[] = [];
  if (contract.party1Position || contract.party1IdNumber) {
    trailers.push(
      [
        contract.party1Position ? `Jabatan Pihak Pertama: ${contract.party1Position}.` : "",
        contract.party1IdNumber ? `${contract.party1IdLabel || "No. Identitas"} Pihak Pertama: ${contract.party1IdNumber}.` : "",
      ].filter(Boolean).join(" "),
    );
  }
  if (contract.party2Position || contract.party2IdNumber) {
    trailers.push(
      [
        contract.party2Position ? `Jabatan Pihak Kedua: ${contract.party2Position}.` : "",
        contract.party2IdNumber ? `${contract.party2IdLabel || "No. Identitas"} Pihak Kedua: ${contract.party2IdNumber}.` : "",
      ].filter(Boolean).join(" "),
    );
  }
  return [plain, ...trailers].join("\n\n");
}

// Sama seperti composeContractPreambleText, TAPI khusus dipakai sebagai
// *sumber* untuk AI penerjemah (bukan untuk halaman review eksternal):
// - Tanggal diformat jadi kalimat (bukan ISO mentah "2026-07-01") supaya AI
//   ikut menerjemahkan/melokalkan tanggalnya, bukan sekadar menyalin digitnya
//   apa adanya (dulu ini yang bikin sisi Inggris tampil "2026-07-01").
// - Markup **tebal** DIPERTAHANKAN (bukan dilucuti) supaya hasil terjemahan
//   masih bisa dirender tebal oleh renderPreambleParagraphs di frontend —
//   dulu ini yang bikin sisi Inggris kehilangan bold sama sekali.
function composeContractPreambleForTranslation(db: any, contract: Contract, sourceLang: "id" | "en"): string {
  const settings = withSettingsDefaults(rawSettingsFor(db, contract.tenantId));
  const template =
    contract.customOpeningParagraph ||
    contract.templateSnapshot?.openingParagraph ||
    (db.templates as Template[]).find((t) => t.id === contract.templateId)?.openingParagraph ||
    settings.masterData?.categoryOpeningParagraphs?.[contract.category] ||
    DEFAULT_PREAMBLE_TEMPLATE_SERVER;
  const formattedStartDate = contract.startDate
    ? new Date(contract.startDate).toLocaleDateString(sourceLang === "en" ? "en-US" : "id-ID", { weekday: "long", day: "numeric", month: "long", year: "numeric" })
    : contract.startDate;
  const tokens: Record<string, string> = {
    ...(contract.variables || {}),
    StartDate: formattedStartDate,
    Party1Name: settings.companyName || "[Nama perusahaan belum diisi]",
    Party1Address: contract.party1Address || settings.companyAddress || "[Alamat perusahaan belum diisi]",
    Party1Representative: settings.companyRepresentative || "[Nama perwakilan belum diisi]",
    Party1RepTitle: settings.companyRepresentativeTitle || "[Jabatan perwakilan belum diisi]",
    Party2Name: contract.party2Name,
    Party2Address: contract.party2Address || contract.variables?.Address || "[Alamat belum diisi]",
  };
  const substituted = template.replace(/\{\{([^}]+)\}\}/g, (_m: string, k: string) => tokens[k] ?? `{{${k}}}`);
  // Rich HTML (editor WYSIWYG) → markdown: <br>/</p>/</li>/</h*> jadi baris
  // baru rangkap (paragraf tetap terpisah), <strong>/<b> jadi **bold** (bukan
  // dibuang) supaya penanda tebalnya ikut terbawa ke teks yang dikirim ke AI.
  const plain = substituted
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*\/(p|div|li|h[1-6])\s*>/gi, "\n\n")
    .replace(/<\s*(p|div|h[1-6])(\s[^>]*)?>/gi, "")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<\s*(strong|b)(\s[^>]*)?>/gi, "**").replace(/<\s*\/(strong|b)\s*>/gi, "**")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const trailers: string[] = [];
  if (contract.party1Position || contract.party1IdNumber) {
    trailers.push(
      [
        contract.party1Position ? `Jabatan Pihak Pertama: ${contract.party1Position}.` : "",
        contract.party1IdNumber ? `${contract.party1IdLabel || "No. Identitas"} Pihak Pertama: ${contract.party1IdNumber}.` : "",
      ].filter(Boolean).join(" "),
    );
  }
  if (contract.party2Position || contract.party2IdNumber) {
    trailers.push(
      [
        contract.party2Position ? `Jabatan Pihak Kedua: ${contract.party2Position}.` : "",
        contract.party2IdNumber ? `${contract.party2IdLabel || "No. Identitas"} Pihak Kedua: ${contract.party2IdNumber}.` : "",
      ].filter(Boolean).join(" "),
    );
  }
  return [plain, ...trailers].join("\n\n");
}

// Pengaman deterministik: gemini-3.5-flash kadang membiarkan label baku
// "PIHAK PERTAMA"/"PIHAK KEDUA" (dan padanan Inggrisnya) tidak ikut
// diterjemahkan sama sekali — kemungkinan besar karena prompt sebelumnya
// memakai frasa PERSIS ini sebagai contoh "pertahankan tanda **", yang lalu
// disalahartikan modelnya sebagai "pertahankan frasa ini apa adanya" (bukan
// cuma tanda bintangnya). Dipaksa benar di sini, terlepas dari perilaku
// model, karena frasa ini SELALU berasal dari template baku (bukan input
// bebas pengguna) sehingga aman dipetakan langsung tanpa AI.
// Teks sumber utk terjemahan paragraf RECITAL addendum ("Bahwa PARA PIHAK
// telah membuat dan menandatangani ... Nomor ... tanggal ..., yang telah
// diubah terakhir kali melalui Addendum ... (selanjutnya disebut
// "Perjanjian")..."). undefined kalau kontrak ini BUKAN addendum (tidak ada
// yang perlu diterjemahkan). Beda dari closing paragraph di bawah: token
// ParentDocType/ParentNumber/dll di sini DIBEKUKAN (disubstitusi nilai
// asli) di sini — sama seperti composeContractPreambleForTranslation
// membekukan StartDate/Party1Name dst — karena nilainya berasal dari
// kontrak INDUK/SEBELUMNYA (bukan dari selectedContract.variables), fakta
// historis yang jarang berubah setelah addendum ini final, jadi hasil
// terjemahannya aman disimpan sebagai teks jadi (frontend render dgn tokens
// kosong, persis preambleEn — lihat addendumRecitalEn di src/App.tsx).
function composeAddendumRecitalForTranslation(db: any, contract: Contract, sourceLang: "id" | "en"): string | undefined {
  if (!contract.amendsContractId) return undefined;
  const info = getAddendumInfoServer(db, contract);
  if (!info) return undefined;
  const template =
    contract.templateSnapshot?.addendumRecitalParagraph ||
    (db.templates as Template[]).find((t) => t.id === contract.templateId)?.addendumRecitalParagraph;
  const previousOrdinal = info.previous ? (getAddendumInfoServer(db, info.previous)?.ordinal || "") : "";
  // Sama seperti composeContractPreambleForTranslation: format tanggal jadi
  // kalimat panjang (bukan ISO mentah "2026-07-01") SEBELUM dikirim ke AI,
  // supaya AI ikut menerjemahkan/melokalkan tanggalnya juga — kalau dikirim
  // mentah, prompt yang minta AI "mempertahankan tanggal apa adanya" bikin
  // tanggalnya nyangkut ISO di kedua bahasa (baik ID maupun EN).
  const fmtDate = (d?: string) =>
    d ? new Date(d).toLocaleDateString(sourceLang === "en" ? "en-US" : "id-ID", { day: "numeric", month: "long", year: "numeric" }) : "";
  if (template) {
    const tokens: Record<string, string> = {
      ParentDocType: info.parent?.docType || info.parent?.category || "Perjanjian",
      ParentNumber: info.parent?.contractNumber || "",
      ParentDate: fmtDate(info.parent?.startDate),
      ParentEndDate: fmtDate(info.parent?.endDate),
      PreviousOrdinal: previousOrdinal,
      PreviousNumber: info.previous?.contractNumber || "",
      PreviousDate: fmtDate(info.previous?.startDate),
    };
    return template.replace(/\{\{([^}]+)\}\}/g, (_m: string, k: string) => tokens[k] ?? `{{${k}}}`);
  }
  // Sama persis dgn default JSX di src/App.tsx (blok selectedContractAddendumInfo)
  // — kalau JSX itu diubah, sinkronkan juga di sini.
  const parentLabel = info.parent?.docType || info.parent?.category || "Perjanjian";
  const previousClause = info.previous
    ? `, yang telah diubah terakhir kali melalui Addendum ${previousOrdinal} Nomor **${info.previous.contractNumber}** tanggal **${fmtDate(info.previous.startDate)}**`
    : "";
  return `Bahwa PARA PIHAK telah membuat dan menandatangani ${parentLabel} Nomor **${info.parent?.contractNumber || ""}** tanggal **${fmtDate(info.parent?.startDate)}**${previousClause} (selanjutnya disebut "Perjanjian"). Bahwa Perjanjian tersebut akan berakhir pada tanggal **${fmtDate(info.parent?.endDate)}**. Sehubungan dengan hal tersebut, PARA PIHAK sepakat untuk mengubah ketentuan Perjanjian sebagaimana diatur dalam pasal-pasal berikut:`;
}

// Teks sumber utk terjemahan paragraf PENUTUP addendum ("Demikian Addendum
// ini dibuat dan ditandatangani..."). undefined kalau bukan addendum. Beda
// dari recital di atas: token {{Variabel}} di sini (kalau ada, dari
// template kustom) TIDAK dibekukan — dikirim mentah ke AI (sama seperti
// clause.content) supaya tetap sinkron kalau selectedContract.variables
// diedit belakangan; frontend mensubstitusinya ulang saat render (lihat
// closingParagraphEn di src/App.tsx), bukan dibekukan sekali di sini.
function composeAddendumClosingForTranslation(db: any, contract: Contract): string | undefined {
  if (!contract.amendsContractId) return undefined;
  const template =
    contract.templateSnapshot?.closingParagraph ||
    (db.templates as Template[]).find((t) => t.id === contract.templateId)?.closingParagraph;
  if (template) return template;
  return 'Demikian Addendum ini dibuat dan ditandatangani oleh PARA PIHAK, addendum ini menjadi bagian yang tidak terpisahkan dari Perjanjian tersebut di atas.';
}

function fixFixedPartyLabels(text: string | undefined, targetLang: "id" | "en"): string | undefined {
  if (!text) return text;
  const pairs: [RegExp, string][] =
    targetLang === "en"
      ? [
          [/PIHAK PERTAMA/g, "FIRST PARTY"],
          [/Pihak Pertama/g, "First Party"],
          [/PIHAK KEDUA/g, "SECOND PARTY"],
          [/Pihak Kedua/g, "Second Party"],
        ]
      : [
          [/FIRST PARTY/g, "PIHAK PERTAMA"],
          [/First Party/g, "Pihak Pertama"],
          [/SECOND PARTY/g, "PIHAK KEDUA"],
          [/Second Party/g, "Pihak Kedua"],
        ];
  let out = text;
  for (const [re, rep] of pairs) out = out.replace(re, rep);
  return out;
}

// Terjemahkan isi kontrak (narasi pembuka + seluruh pasal) ke bahasa lawan,
// untuk mode dokumen "en" dan "bilingual". Hasilnya disimpan di field terpisah
// (titleEn/contentEn/preambleEn) — teks sumber TIDAK PERNAH ditimpa, sehingga
// terjemahan bisa dibuat ulang kapan saja tanpa kehilangan naskah asli, dan
// arah terjemahan bisa dibalik (kontrak yang aslinya berbahasa Inggris
// diterjemahkan ke Indonesia).
app.post("/api/contracts/:id/translate", requireAuth, requireRole("admin", "staff", "legal", "manager"), async (req: AuthedRequest, res) => {
  const db = loadDB();
  const contract = findOwnedContract(db, req, req.params.id);
  if (!contract) return res.status(404).json({ error: "Contract not found" });
  if (!contract.clauses || contract.clauses.length === 0) {
    return res.status(400).json({ error: "Kontrak ini belum punya pasal untuk diterjemahkan. Untuk dokumen hasil unggahan, jalankan OCR dulu." });
  }
  if (!isGeminiConfigured()) {
    return res.status(503).json({ error: "Terjemahan otomatis butuh GEMINI_API_KEY yang aktif. Isi API key di .env lalu coba lagi." });
  }

  const sourceLang: "id" | "en" = req.body?.sourceLanguage === "en" ? "en" : (contract.sourceLanguage === "en" ? "en" : "id");
  const from = sourceLang === "en" ? "Bahasa Inggris" : "Bahasa Indonesia";
  const to = sourceLang === "en" ? "Bahasa Indonesia" : "Bahasa Inggris";

  const preambleSource = composeContractPreambleForTranslation(db, contract, sourceLang);
  const isAddendum = !!contract.amendsContractId;
  const addendumRecitalSource = isAddendum ? composeAddendumRecitalForTranslation(db, contract, sourceLang) : undefined;
  const addendumClosingSource = isAddendum ? composeAddendumClosingForTranslation(db, contract) : undefined;
  const docTypeSource = contract.docType || "Surat Perjanjian Kerjasama";
  const payload = {
    title: contract.title,
    docType: docTypeSource,
    preamble: preambleSource,
    clauses: contract.clauses.map((c) => ({ id: c.id, title: c.title, content: c.content })),
    // Dua field ini HANYA ada kalau kontrak ini Addendum (lihat isAddendum di
    // atas) — kontrak biasa tidak pernah punya paragraf ini sama sekali,
    // jadi tidak perlu dikirim/diterjemahkan.
    ...(addendumRecitalSource ? { addendumRecital: addendumRecitalSource } : {}),
    ...(addendumClosingSource ? { addendumClosing: addendumClosingSource } : {}),
  };

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: `Anda adalah Penerjemah Tersumpah (Sworn Translator) spesialis kontrak/perjanjian dari ${from} ke ${to}.
      Terjemahkan seluruh isi dokumen berikut ke ${to} secara formal dan presisi mengikuti konvensi penulisan kontrak.
      ATURAN PENTING:
      - Pertahankan struktur JSON persis: jumlah dan urutan "clauses" harus SAMA, dan "id" tiap pasal disalin apa adanya.
      - "title" adalah judul dokumen (mis. "Perjanjian Sewa AC & Perawatan Gedung") dan "docType" adalah jenis suratnya
        (mis. "Surat Perjanjian Kerjasama", "Nota Kesepahaman", "Addendum") — terjemahkan keduanya secara natural dan
        formal, memakai istilah hukum baku di bahasa tujuan (mis. "Cooperation Agreement Letter", "Memorandum of
        Understanding"), BUKAN diterjemahkan kata per kata secara kaku.
      - JANGAN menerjemahkan nama orang, nama perusahaan, nomor dokumen (mis. "GA-VND-2026-0001"), NIK/NPWP, dan nilai
        angka/mata uang (mis. "45000000" atau "Rp 45.000.000" tetap angka yang sama).
      - KECUALI tanggal: tanggal yang ditulis sebagai kalimat (mis. "Rabu, 1 Juli 2026") HARUS ikut diterjemahkan/
        dilokalkan ke format kalimat tanggal yang wajar di bahasa tujuan (mis. "Wednesday, July 1, 2026") — jangan
        disalin mentah sebagai angka/ISO (mis. JANGAN jadi "2026-07-01"), dan jangan diringkas jadi angka.
      - Pertahankan token bergaya {{NamaVariabel}} apa adanya, jangan diterjemahkan.
      - Teks sumber memakai markdown **tebal** (dua bintang) untuk menandai bagian yang harus tetap tebal. WAJIB
        terjemahkan teks DI DALAM tanda bintang itu ke ${to} (JANGAN dibiarkan tetap berbahasa ${from}), sambil tetap
        mempertahankan sepasang tanda ** di sekeliling hasil terjemahannya. Ini termasuk label baku seperti "PIHAK
        PERTAMA"/"PIHAK KEDUA" — label semacam ini WAJIB ikut diterjemahkan juga (mis. "**PIHAK PERTAMA:**" menjadi
        "**FIRST PARTY:**"), TIDAK BOLEH dibiarkan sama seperti bahasa sumbernya walau ditulis huruf kapital semua.
      - Kalau field "addendumRecital" dan/atau "addendumClosing" ADA di dokumen sumber (cuma muncul kalau dokumen ini
        Addendum), terjemahkan juga keduanya dengan aturan yang SAMA persis seperti di atas (nama/nomor/tanggal
        dipertahankan atau dilokalkan sesuai aturan, ** dipertahankan & isinya diterjemahkan). Kalau field itu TIDAK
        ADA di dokumen sumber, JANGAN dimunculkan di balasan sama sekali.

      === DOKUMEN SUMBER (JSON) ===
      ${JSON.stringify(payload)}
      === AKHIR DOKUMEN ===

      Balas HANYA JSON: { "title": "...", "docType": "...", "preamble": "...", "clauses": [ { "id": "...", "title": "...", "content": "..." } ]${addendumRecitalSource ? ', "addendumRecital": "..."' : ""}${addendumClosingSource ? ', "addendumClosing": "..."' : ""} }`,
      config: { responseMimeType: "application/json" },
    });
    const parsed = parseAiJson(response.text);
    const targetLang: "id" | "en" = sourceLang === "en" ? "id" : "en";
    const byId = new Map<string, { title?: string; content?: string }>();
    for (const c of (parsed.clauses || [])) {
      if (!c?.id) continue;
      byId.set(String(c.id), {
        title: fixFixedPartyLabels(c.title, targetLang),
        content: fixFixedPartyLabels(c.content, targetLang),
      });
    }

    // Jaring pengaman: AI kadang menerjemahkan atau merusak token {{Variabel}}
    // walau sudah dilarang eksplisit di prompt di atas — kalau ini lolos tak
    // terdeteksi, klausul aktif bisa tampil dengan variabel yang tidak pernah
    // tersubstitusi (mis. "{{TanggalMulai}}" berubah jadi "{{StartDate}}").
    // Bandingkan token sumber vs hasil per pasal; kalau beda, JANGAN pakai
    // hasil AI untuk pasal itu — pertahankan teks asli & catat sbg peringatan
    // supaya user tahu pasal mana yang perlu diterjemahkan manual.
    const TOKEN_RE_CHECK = /\{\{[^{}]+\}\}/g;
    const tokensOf = (s: string) => new Set(String(s || "").match(TOKEN_RE_CHECK) || []);
    const sameTokens = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((t) => b.has(t));
    const warnings: string[] = [];

    contract.clauses = contract.clauses.map((c) => {
      const t = byId.get(c.id);
      if (!t) return c;
      if (!sameTokens(tokensOf(c.content), tokensOf(t.content || ""))) {
        warnings.push(c.title || "(tanpa judul)");
        return c;
      }
      return { ...c, titleEn: t.title || c.titleEn, contentEn: t.content || c.contentEn };
    });
    const fixedPreamble = fixFixedPartyLabels(parsed.preamble, targetLang);
    if (fixedPreamble && !sameTokens(tokensOf(preambleSource), tokensOf(fixedPreamble))) {
      warnings.push("Narasi Pembuka");
    } else {
      contract.preambleEn = fixedPreamble || contract.preambleEn;
      contract.preambleEnOriginal = fixedPreamble || contract.preambleEnOriginal;
    }
    // Recital & closing Addendum — cuma diproses kalau memang dikirim di
    // payload (isAddendum true DAN compose-nya menghasilkan sesuatu).
    if (addendumRecitalSource) {
      const fixedRecital = fixFixedPartyLabels(parsed.addendumRecital, targetLang);
      if (fixedRecital && !sameTokens(tokensOf(addendumRecitalSource), tokensOf(fixedRecital))) {
        warnings.push("Narasi Pembuka Addendum");
      } else {
        contract.addendumRecitalEn = fixedRecital || contract.addendumRecitalEn;
      }
    }
    if (addendumClosingSource) {
      const fixedClosing = fixFixedPartyLabels(parsed.addendumClosing, targetLang);
      if (fixedClosing && !sameTokens(tokensOf(addendumClosingSource), tokensOf(fixedClosing))) {
        warnings.push("Kalimat Penutup Addendum");
      } else {
        contract.closingParagraphEn = fixedClosing || contract.closingParagraphEn;
      }
    }
    // Judul dokumen & jenis surat (header) — teksnya pendek dan jarang memuat
    // token {{Variabel}}, jadi cukup dipakai langsung kalau ada hasilnya.
    contract.titleEn = parsed.title || contract.titleEn;
    contract.docTypeEn = parsed.docType || contract.docTypeEn;
    contract.translationWarnings = warnings.length > 0 ? warnings : undefined;
    contract.sourceLanguage = sourceLang;
    contract.translationUpdatedAt = new Date().toISOString();
    contract.translationSimulated = false;
    contract.updatedAt = new Date().toISOString();

    pushAudit(db, req, {
      contractId: contract.id, contractNumber: contract.contractNumber,
      action: "Terjemahkan Kontrak",
      details: `Menerjemahkan ${contract.clauses.length} pasal dari ${from} ke ${to}`,
    });
    saveDB(db);
    res.json({ success: true, contract });
  } catch (err) {
    logger.error({ err }, "Contract translate failed");
    return aiErrorResponse(res, err, "Gagal menerjemahkan kontrak.");
  }
});


app.get("/api/external-review/:token", apiLimiter, (req, res) => {
  const contract = resolveExternalReview(req.params.token);
  if (!contract) return res.status(404).json({ error: "Link review tidak valid atau sudah kadaluarsa." });
  const db = loadDB();
  const comments = (db.clauseComments as ClauseComment[] || [])
    .filter((c) => c.contractId === contract.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  // Narasi pembuka disisipkan sbg "pseudo-klausul" __preamble__ di urutan
  // PALING AWAL — supaya pihak eksternal juga bisa menyorot & mengomentarinya
  // lewat mekanisme yang SAMA dengan klausul biasa (tak perlu UI terpisah).
  const preambleClause = { id: "__preamble__", title: "Narasi Pembuka & Para Pihak", order: -1, content: composeContractPreambleText(db, contract) };
  // Hanya paparkan yang perlu untuk review — bukan seluruh objek kontrak.
  res.json({
    contract: {
      title: contract.title, contractNumber: contract.contractNumber,
      party1Name: contract.party1Name, party2Name: contract.party2Name,
      clauses: [preambleClause, ...(contract.clauses || []).slice().sort((a, b) => a.order - b.order)],
    },
    comments,
    alreadyApproved: (contract.externalApprovals || []).length > 0,
    locked: !!contract.externalReviewLocked,
  });
});

// PUBLIK — tamu eksternal menambah komentar (dengan sorotan/coret opsional).
// Terkunci (setelah klik Setuju/OK) sampai pemilik dokumen buka akses lagi.
app.post("/api/external-review/:token/comments", apiLimiter, (req, res) => {
  const contract = resolveExternalReview(req.params.token);
  if (!contract) return res.status(404).json({ error: "Link review tidak valid atau sudah kadaluarsa." });
  if (contract.externalReviewLocked) {
    return res.status(403).json({ error: "Review ini sudah terkunci sejak Anda menyetujui (Setuju/OK). Hubungi pemilik dokumen untuk membuka akses kembali." });
  }
  const { clauseId, clauseTitle, text, anchor, kind, name } = req.body || {};
  if (!clauseId || !text?.trim() || !String(name || "").trim()) {
    return res.status(400).json({ error: "Nama, klausul, dan komentar wajib diisi." });
  }
  const db = loadDB();
  const comment: ClauseComment = {
    id: "cmt-ext-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
    tenantId: contract.tenantId, contractId: contract.id,
    clauseId, clauseTitle: clauseTitle || clauseId,
    userId: "external", userName: String(name).trim().slice(0, 80), userRole: "Pihak Eksternal",
    text: String(text).trim(), resolved: false, mentions: [], createdAt: new Date().toISOString(),
    external: true, externalName: String(name).trim().slice(0, 80),
    ...(anchor && typeof anchor.start === "number" && typeof anchor.end === "number"
      ? { anchor: { start: anchor.start, end: anchor.end, quote: String(anchor.quote || "").slice(0, 500) } } : {}),
    kind: kind === "strike" ? "strike" : "comment",
  };
  if (!db.clauseComments) db.clauseComments = [];
  db.clauseComments.unshift(comment);
  pushNotif(db, contract.tenantId, {
    title: "Komentar Review Eksternal",
    message: `${comment.userName} (pihak eksternal) mengomentari klausul "${comment.clauseTitle}" di kontrak "${contract.title}".`,
    type: "warning", contractId: contract.id,
  });
  saveDB(db);
  res.json({ success: true, comment });
});

// PUBLIK — tamu eksternal klik "OK / Setuju" (klausul sudah sesuai). Sekali
// disetujui, sesi ini TERKUNCI (tak bisa komentar/setuju lagi lewat token yang
// sama) sampai pemilik dokumen membuka akses kembali (endpoint /unlock di atas).
app.post("/api/external-review/:token/approve", apiLimiter, (req, res) => {
  const contract = resolveExternalReview(req.params.token);
  if (!contract) return res.status(404).json({ error: "Link review tidak valid atau sudah kadaluarsa." });
  if (contract.externalReviewLocked) {
    return res.status(403).json({ error: "Review ini sudah terkunci. Hubungi pemilik dokumen untuk membuka akses kembali." });
  }
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "Nama wajib diisi." });
  const db = loadDB();
  const live = (db.contracts as Contract[]).find((c) => c.id === contract.id)!;
  if (!live.externalApprovals) live.externalApprovals = [];
  live.externalApprovals.push({ name: name.slice(0, 80), approvedAt: new Date().toISOString(), note: String(req.body?.note || "").slice(0, 300) || undefined });
  live.externalReviewLocked = true;
  live.updatedAt = new Date().toISOString();
  pushNotif(db, contract.tenantId, {
    title: "Pihak Eksternal Menyetujui",
    message: `${name} menyetujui (OK) isi klausul kontrak "${contract.title}" via review eksternal.`,
    type: "success", contractId: contract.id,
  });
  saveDB(db);
  res.json({ success: true });
});

// ===== DCS REVIEW EKSTERNAL VIA TOKEN — mirror persis pola di atas, untuk
// dokumen internal (SOP/IK/Memo/Kebijakan). Auditor/pihak eksternal tanpa
// akun bisa pratinjau bagian dokumen, menyorot untuk berkomentar, atau klik
// Setuju/OK — sebelum approval-matrix internal menyelesaikan approve-nya.
// Disimpan di dcs_document_versions.metadata->'externalReview' (lihat dcs/repo.ts).
function sanitizeDcsAnchor(raw: any): DcsReviewCommentAnchor {
  if (!raw || typeof raw !== "object") return { field: "general" };
  const field = ["purpose", "scope", "section", "flow", "general"].includes(raw.field) ? raw.field : "general";
  const a: DcsReviewCommentAnchor = { field };
  if (field === "section" && Number.isInteger(Number(raw.sectionIndex))) a.sectionIndex = Number(raw.sectionIndex);
  if (typeof raw.sectionHeading === "string") a.sectionHeading = raw.sectionHeading.slice(0, 200);
  if (typeof raw.quote === "string" && raw.quote.trim()) a.quote = raw.quote.slice(0, 500);
  return a;
}

app.post("/api/dcs/versions/:vid/external-review/enable", requireAuth, requireRole("admin", "staff", "legal", "manager"), async (req: AuthedRequest, res) => {
  try {
    const tid = tenantOf(req);
    const token = randomBytes(24).toString("hex");
    const days = Number(req.body?.expiresInDays);
    const expiresAt = Number.isFinite(days) && days > 0 ? new Date(Date.now() + days * 86400000).toISOString() : null;
    await enableDcsExternalReview(dcsPool, { tenantId: tid, versionId: req.params.vid, token, expiresAt });
    res.json({ success: true, token, expiresAt, url: `${shareBaseUrl(req)}/?dcsReviewToken=${token}` });
  } catch (err: any) {
    res.status(409).json({ error: String(err?.message || "Gagal mengaktifkan review eksternal.") });
  }
});

app.post("/api/dcs/versions/:vid/external-review/disable", requireAuth, requireRole("admin", "staff", "legal", "manager"), async (req: AuthedRequest, res) => {
  await disableDcsExternalReview(dcsPool, { tenantId: tenantOf(req), versionId: req.params.vid });
  res.json({ success: true });
});

app.post("/api/dcs/versions/:vid/external-review/unlock", requireAuth, requireRole("admin", "staff", "legal", "manager"), async (req: AuthedRequest, res) => {
  const tid = tenantOf(req);
  // Guard yang sama seperti sisi Kontrak (/api/contracts/:id/external-review/unlock):
  // tanpa ini, versi yang belum pernah punya link review eksternal balas 200
  // sukses padahal tidak ada apa pun yang berubah — jsonb_set nested gagal
  // senyap saat parent key 'externalReview' belum ada. Dibuktikan lewat
  // pengujian nyata sebelum diperbaiki.
  if (!(await hasDcsExternalReviewToken(dcsPool, tid, req.params.vid))) {
    return res.status(409).json({ error: "Belum ada link review eksternal aktif untuk dokumen ini." });
  }
  await setDcsExternalReviewLock(dcsPool, { tenantId: tid, versionId: req.params.vid, locked: false });
  res.json({ success: true });
});

// PUBLIK (tanpa auth) — pratinjau bagian dokumen (dari metadata->'compose')
// + komentar. Kalau versi ini bukan hasil compose (upload PDF langsung),
// `sections` kosong — halaman publik cuma menampilkan komentar umum + OK.
app.get("/api/dcs-external-review/:token", apiLimiter, async (req, res) => {
  const resolved = await resolveDcsExternalReview(dcsPool, req.params.token);
  if (!resolved) return res.status(404).json({ error: "Link review tidak valid atau sudah kadaluarsa." });
  const compose = await getDcsComposeMetadata(dcsPool, resolved.tenantId, resolved.versionId) as any;
  const comments = await listDcsReviewComments(dcsPool, resolved.tenantId, resolved.versionId);
  res.json({
    document: {
      title: resolved.title, documentNumber: resolved.documentNumber, docTypeCode: resolved.docTypeCode,
      major: resolved.major, minor: resolved.minor,
      purpose: compose?.purpose || "", scope: compose?.scope || "",
      sections: Array.isArray(compose?.sections) ? compose.sections : [],
    },
    comments,
    locked: !!resolved.state.locked,
  });
});

// PUBLIK — tamu eksternal menambah komentar (anchor: purpose/scope/section/flow/general).
app.post("/api/dcs-external-review/:token/comments", apiLimiter, async (req, res) => {
  const resolved = await resolveDcsExternalReview(dcsPool, req.params.token);
  if (!resolved) return res.status(404).json({ error: "Link review tidak valid atau sudah kadaluarsa." });
  if (resolved.state.locked) {
    return res.status(403).json({ error: "Review ini sudah terkunci sejak Anda menyetujui (Setuju/OK). Hubungi pemilik dokumen untuk membuka akses kembali." });
  }
  const name = String(req.body?.name || "").trim();
  const body = String(req.body?.body || "").trim();
  if (!name || !body) return res.status(400).json({ error: "Nama dan komentar wajib diisi." });
  try {
    const round = await getDcsVersionReviewRound(dcsPool, resolved.tenantId, resolved.versionId);
    const comment = await addDcsReviewComment(dcsPool, {
      tenantId: resolved.tenantId, versionId: resolved.versionId,
      authorUserId: "external", authorName: name.slice(0, 80), authorRole: "Pihak Eksternal",
      anchor: sanitizeDcsAnchor(req.body?.anchor), body: body.slice(0, 4000), reviewRound: round,
    });
    const db = loadDB();
    pushNotif(db, resolved.tenantId, {
      title: "Komentar Review Eksternal (DCS)",
      message: `${name} (pihak eksternal) mengomentari "${resolved.title}" (${resolved.documentNumber}).`,
      type: "warning", dcsDocumentId: resolved.documentId,
    });
    saveDB(db);
    res.json({ success: true, comment });
  } catch (err: any) {
    res.status(500).json({ error: String(err?.message || "Gagal menambah komentar.") });
  }
});

// PUBLIK — tamu eksternal klik "OK / Setuju". Mengunci sesi (sama seperti
// Kontrak) — BUKAN langkah approval-matrix resmi, cuma catatan sign-off tamu.
app.post("/api/dcs-external-review/:token/approve", apiLimiter, async (req, res) => {
  const resolved = await resolveDcsExternalReview(dcsPool, req.params.token);
  if (!resolved) return res.status(404).json({ error: "Link review tidak valid atau sudah kadaluarsa." });
  if (resolved.state.locked) {
    return res.status(403).json({ error: "Review ini sudah terkunci. Hubungi pemilik dokumen untuk membuka akses kembali." });
  }
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "Nama wajib diisi." });
  await addDcsExternalApproval(dcsPool, {
    tenantId: resolved.tenantId, versionId: resolved.versionId,
    approval: { name: name.slice(0, 80), approvedAt: new Date().toISOString(), note: String(req.body?.note || "").slice(0, 300) || undefined },
  });
  await setDcsExternalReviewLock(dcsPool, { tenantId: resolved.tenantId, versionId: resolved.versionId, locked: true });
  const db = loadDB();
  pushNotif(db, resolved.tenantId, {
    title: "Pihak Eksternal Menyetujui (DCS)",
    message: `${name} menyetujui (OK) isi dokumen "${resolved.title}" (${resolved.documentNumber}) via review eksternal.`,
    type: "success", dcsDocumentId: resolved.documentId,
  });
  saveDB(db);
  res.json({ success: true });
});

// ===== WEB PUSH NOTIFICATION =====
// GET /api/push/vapid-public-key — kirim public key ke client untuk subscribe
app.get("/api/push/vapid-public-key", requireAuth, (_req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) return res.status(503).json({ error: "Push notification belum dikonfigurasi (VAPID_PUBLIC_KEY tidak diset)" });
  res.json({ publicKey: key });
});

// POST /api/push/subscribe — simpan subscription browser pengguna
app.post("/api/push/subscribe", requireAuth, (req: AuthedRequest, res) => {
  const db = loadDB();
  const tid = tenantOf(req);
  const u = req.user!;
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: "Data subscription tidak lengkap" });
  }

  if (!db.pushSubscriptions) db.pushSubscriptions = [];
  // Hapus subscription lama dari endpoint yang sama
  db.pushSubscriptions = (db.pushSubscriptions as PushSub[]).filter((s) => s.endpoint !== endpoint);

  const sub: PushSub = {
    id: "psub-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
    userId: u.id,
    tenantId: tid,
    endpoint,
    keys,
    createdAt: new Date().toISOString(),
  };
  db.pushSubscriptions.push(sub);
  saveDB(db);
  res.json({ success: true });
});

// DELETE /api/push/unsubscribe — hapus subscription
app.delete("/api/push/unsubscribe", requireAuth, (req: AuthedRequest, res) => {
  const db = loadDB();
  const u = req.user!;
  const { endpoint } = req.body;
  if (!db.pushSubscriptions) return res.json({ success: true });
  db.pushSubscriptions = (db.pushSubscriptions as PushSub[]).filter(
    (s) => !(s.userId === u.id && s.endpoint === endpoint)
  );
  saveDB(db);
  res.json({ success: true });
});

// POST /api/push/test — kirim test push nyata ke pengguna yang sedang login
app.post("/api/push/test", requireAuth, async (req: AuthedRequest, res) => {
  const db = loadDB();
  const u = req.user!;
  const subs = (db.pushSubscriptions as PushSub[] || []).filter((s) => s.userId === u.id);
  if (subs.length === 0) return res.status(404).json({ error: "Tidak ada subscription aktif untuk akun ini" });

  if (!isPushConfigured()) {
    return res.status(503).json({ error: "Push notification belum dikonfigurasi (VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY tidak diset di .env)" });
  }

  const result = await sendPushToUser(u.id, {
    title: "Test Notifikasi",
    body: "Jika Anda melihat ini, push notification berfungsi dengan baik.",
    tag: "test-push",
  });

  if (result.sent === 0 && result.failed > 0) {
    return res.status(502).json({ error: `Gagal mengirim ke semua ${result.failed} perangkat terdaftar.` });
  }
  res.json({ success: true, sent: result.sent, failed: result.failed });
});

// Turns multer upload failures (oversized file, disallowed type) into a
// clean JSON 400, and logs+responds JSON for any other unexpected error
// instead of Express's default HTML error page. Must be registered after
// all routes — Express only reaches error middleware declared later than
// the route that called next(err).
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: `Berkas terlalu besar. Maksimal ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))}MB.` });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err?.message?.includes("Tipe berkas tidak didukung")) {
    return res.status(400).json({ error: err.message });
  }
  (req.log || logger).error({ err }, "Unhandled request error");
  res.status(500).json({ error: "Terjadi kesalahan pada server." });
});

// Vite middleware for development / Production static serving. Skipped
// entirely on Vercel: the frontend build is served straight from Vercel's
// own static CDN (see vercel.json's outputDirectory), and this function
// only ever receives requests rewritten from /api/* — process.cwd() inside
// a Vercel function is also not the project root, so a dist/ lookup here
// would fail anyway.
  if (!process.env.VERCEL) {
    if (process.env.NODE_ENV !== "production") {
      // Dynamic import so `vite` (a devDependency, pulls in esbuild/rollup)
      // never gets bundled into the Vercel serverless function — that branch
      // never runs there, but a static top-level import would still drag the
      // whole package into the function bundle.
      const { createServer: createViteServer } = await import("vite");
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: "spa",
      });
      app.use(vite.middlewares);
    } else {
      const distPath = path.join(process.cwd(), "dist");
      app.use(express.static(distPath));
      app.get("*all", (req, res) => {
        res.sendFile(path.join(distPath, "index.html"));
      });
    }

    app.listen(PORT, "0.0.0.0", () => {
      logger.info({ port: PORT }, "Smart Contract Lifecycle Management Server running");
    });
  }
}

// Last line of defense: log crashes with full context before the process
// dies, instead of an unstructured stack trace on stderr that's easy to miss
// in aggregated log output.
// Koneksi Postgres yang IDLE terputus (provider serverless seperti Neon
// menutup koneksi idle secara agresif, termasuk saat compute auto-suspend)
// TIDAK menaikkan event 'error' di level Pool (yang sudah ditangani di
// db.ts) kalau kejadiannya persis saat sebuah query SEDANG berjalan —
// dalam kasus itu node-postgres me-reject PROMISE QUERY itu sendiri.
// Query di dalam handler rute Express aman (wrapAsyncHandler menangkapnya),
// tapi ini tetap bisa lolos sebagai unhandledRejection dari jalur lain
// (mis. jeda antara acquire client dan query pertama).
//
// DIBUKTIKAN nyata, bukan teori: server ini mati sendiri (process.exit)
// dengan "Connection terminated unexpectedly" dari node_modules/pg setelah
// dibiarkan idle beberapa menit — padahal tidak ada bug logika aplikasi.
// Untuk provider serverless, kegagalan koneksi transient seperti ini NORMAL
// dan SERING, sehingga mematikan seluruh server karenanya (me-restart semua
// pengguna) jauh lebih berbahaya daripada sekadar mencatatnya — pool pg akan
// membuat koneksi baru dengan sendirinya pada acquire berikutnya.
//
// unhandledRejection/uncaughtException LAIN (bukan kegagalan koneksi
// Postgres yang dikenal transient) TETAP mematikan proses seperti semula —
// state yang mungkin sudah korup lebih aman di-restart bersih daripada
// dibiarkan jalan terus dengan asumsi yang mungkin salah.
function isTransientPgConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (/connection terminated|terminating connection|econnreset|timeout expired|connection.*closed/i.test(err.message)) {
    return true;
  }
  // Penanda tambahan: error berasal dari dalam library pg itu sendiri
  // (bukan dari kode aplikasi kita) — pola pesan baru dari provider yang
  // belum tercantum di atas tetap tertangkap selama stack-nya menunjuk pg.
  return /[\\/]node_modules[\\/]pg[\\/]/.test(err.stack || "");
}
process.on("uncaughtException", (err) => {
  if (isTransientPgConnectionError(err)) {
    logger.error({ err }, "Transient Postgres connection error (uncaught) — logged, process stays up");
    return;
  }
  logger.fatal({ err }, "Uncaught exception — process will exit");
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  if (isTransientPgConnectionError(reason)) {
    logger.error({ err: reason }, "Transient Postgres connection error (unhandled rejection) — logged, process stays up");
    return;
  }
  logger.fatal({ err: reason }, "Unhandled promise rejection — process will exit");
  process.exit(1);
});

// Exported so api/index.ts (Vercel serverless entrypoint) can await full
// route registration + DB hydration before handling the first request,
// instead of re-running this on every invocation.
export const readyPromise = startServer();

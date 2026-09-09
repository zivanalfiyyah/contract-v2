import nodemailer, { Transporter } from "nodemailer";
import { logger } from "./logger.js";

// Transactional email via SMTP — just needs credentials in .env, so this is
// fully functional, not scaffolding. Until those env vars are set,
// isConfigured() is false and callers fall back to manual mailto:/wa.me
// links — the app must never claim an email was sent when it wasn't.

export interface EmailConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  fromEmail: string;
  fromName: string;
}

function readConfig(): Partial<EmailConfig> {
  return {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === "true",
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    fromEmail: process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER,
    fromName: process.env.SMTP_FROM_NAME || "Smart CLM Enterprise",
  } as Partial<EmailConfig>;
}

export function isEmailConfigured(): boolean {
  const cfg = readConfig();
  return !!(cfg.host && cfg.user && cfg.pass && cfg.fromEmail);
}

let cachedTransporter: Transporter | null = null;
let cachedConfigKey = "";

function getTransporter(): Transporter {
  const cfg = readConfig();
  const key = `${cfg.host}:${cfg.port}:${cfg.user}`;
  // Re-create the transporter if env vars changed since last build (e.g. an
  // admin just updated SMTP settings and hit "Test Connection" again).
  if (!cachedTransporter || cachedConfigKey !== key) {
    cachedTransporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure, // true for port 465, false for 587/25 (STARTTLS)
      auth: { user: cfg.user, pass: cfg.pass },
    });
    cachedConfigKey = key;
  }
  return cachedTransporter;
}

export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  text?: string;
  // Lampiran opsional (mis. PDF kontrak) — diteruskan apa adanya ke
  // nodemailer, yang mendukung Buffer content secara native.
  attachments?: { filename: string; content: Buffer; contentType?: string }[];
}

export interface SendEmailResult {
  sent: boolean;
  error?: string;
}

export async function sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
  if (!isEmailConfigured()) {
    return { sent: false, error: "SMTP belum dikonfigurasi." };
  }
  const cfg = readConfig();
  try {
    await getTransporter().sendMail({
      from: `"${cfg.fromName}" <${cfg.fromEmail}>`,
      to: params.to,
      subject: params.subject,
      html: params.html,
      text: params.text,
      attachments: params.attachments,
    });
    return { sent: true };
  } catch (err: any) {
    logger.error({ err, to: params.to }, "Failed to send email via SMTP");
    return { sent: false, error: err?.message || "Gagal mengirim email." };
  }
}

export interface TestConnectionResult {
  connected: boolean;
  message: string;
}

export async function testEmailConnection(): Promise<TestConnectionResult> {
  if (!isEmailConfigured()) {
    return { connected: false, message: "SMTP_HOST, SMTP_USER, SMTP_PASS, dan SMTP_FROM_EMAIL belum lengkap di .env." };
  }
  try {
    await getTransporter().verify();
    return { connected: true, message: "Berhasil terhubung ke server SMTP." };
  } catch (err: any) {
    return { connected: false, message: `Gagal terhubung ke SMTP: ${err?.message || "unknown error"}` };
  }
}

// Shared HTML wrapper so every transactional email looks consistent.
export function emailTemplate(opts: { title: string; bodyHtml: string; ctaLabel?: string; ctaUrl?: string }): string {
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#0f172a;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;">
<div style="max-width:560px;margin:0 auto;padding:32px 20px;">
  <div style="background:#1e293b;border:1px solid #334155;border-radius:16px;padding:28px;">
    <h1 style="color:#e2e8f0;font-size:18px;margin:0 0 16px;">${opts.title}</h1>
    <div style="color:#cbd5e1;font-size:14px;line-height:1.6;">${opts.bodyHtml}</div>
    ${opts.ctaUrl ? `<div style="margin-top:24px;"><a href="${opts.ctaUrl}" style="display:inline-block;background:#6366f1;color:#fff;text-decoration:none;padding:12px 24px;border-radius:10px;font-weight:600;font-size:14px;">${opts.ctaLabel || "Buka Tautan"}</a></div>` : ""}
  </div>
  <p style="color:#64748b;font-size:11px;text-align:center;margin-top:20px;">Email otomatis dari Smart Contract Lifecycle Management System.</p>
</div>
</body></html>`;
}

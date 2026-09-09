import type { Pool } from "pg";
import { loadDB, saveDB } from "../db.js";
import { logger } from "../logger.js";
import { sendPushToTenant, sendPushToUser } from "../push.js";
import { listVersionsDueForReview, markReviewReminderSent, listVersionsDueForRelease } from "./repo.js";
import { promoteVersionToEffective } from "./obsolete-engine.js";

// Proactive review-due reminders for Smart DCS documents — same shape as
// reminders.ts for contracts (one scan, filter in JS, dedupe by calendar
// date via a `lastReminderDate` stamp), reading dcs_document_versions
// instead of the JSONB contracts collection, but writing into the SAME
// notifications/push channels so users see both kinds of reminders together.

function getDaysRemaining(dueDate: string): number {
  const due = new Date(dueDate);
  due.setHours(0, 0, 0, 0);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.ceil((due.getTime() - now.getTime()) / 86400000);
}

export async function runDcsReminderCheck(pool: Pool) {
  const dueVersions = await listVersionsDueForReview(pool);
  const today = new Date().toISOString().split("T")[0];
  const db = loadDB();
  let sentCount = 0;
  const pushJobs: { tenantId: string; title: string; message: string; versionId: string }[] = [];

  for (const v of dueVersions) {
    if (v.lastReminderDate === today) continue; // already notified today

    const daysRemaining = getDaysRemaining(v.reviewDueAt);
    const withinWindow = daysRemaining <= v.reviewReminderDays;
    if (!withinWindow) continue;

    const overdue = daysRemaining < 0;
    const title = overdue ? "Dokumen Lewat Jadwal Tinjau Ulang" : "Dokumen Perlu Ditinjau Ulang";
    const message = overdue
      ? `${v.documentNumber} (${v.title}) sudah melewati jadwal tinjau ulang ${Math.abs(daysRemaining)} hari yang lalu.`
      : `${v.documentNumber} (${v.title}) perlu ditinjau ulang dalam ${daysRemaining} hari.`;
    const type = overdue ? "danger" : daysRemaining <= 7 ? "warning" : "info";

    db.notifications.unshift({
      id: "not-dcs-reminder-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
      tenantId: v.tenantId,
      title, message, type,
      createdAt: new Date().toISOString(),
      read: false,
    });

    await markReviewReminderSent(pool, v.versionId, today);
    sentCount++;
    pushJobs.push({ tenantId: v.tenantId, title, message, versionId: v.versionId });
  }

  if (sentCount > 0) {
    saveDB(db);
    logger.info({ sentCount }, "Sent DCS review-due notification(s)");
    for (const job of pushJobs) {
      try {
        await sendPushToTenant(job.tenantId, {
          title: job.title, body: job.message,
          url: "/?tab=internal-docs",
          tag: `dcs-reminder-${job.versionId}`,
        });
      } catch (err) {
        logger.warn({ err, versionId: job.versionId }, "Push for DCS reminder failed");
      }
    }
  }
}

// Aktivasi rilis TERJADWAL: dokumen internal yang full-approval + punya
// scheduledEffectiveAt yang sudah tiba → diberlakukan (effective/CONTROLLED),
// versi effective lama otomatis superseded/UNCONTROLLED (via promote engine).
// Tanggal berlaku memakai tanggal terjadwal, bukan waktu cron berjalan.
export async function runDcsReleaseCheck(pool: Pool) {
  const due = await listVersionsDueForRelease(pool);
  if (due.length === 0) return;
  const db = loadDB();
  let released = 0;
  const pushJobs: { ownerUserId: string; tenantId: string; documentId: string; documentNumber: string; title: string }[] = [];

  for (const r of due) {
    try {
      await promoteVersionToEffective(pool, {
        tenantId: r.tenantId, documentId: r.documentId, targetVersionId: r.versionId,
        actorId: r.ownerUserId || "system-scheduler", effectiveAt: r.scheduledEffectiveAt,
      });
      db.notifications.unshift({
        id: "not-dcs-release-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
        tenantId: r.tenantId,
        title: "Dokumen Berlaku Otomatis (Terjadwal)",
        message: `${r.documentNumber} (${r.title}) kini resmi berlaku sesuai jadwal rilis.`,
        type: "success", createdAt: new Date().toISOString(), read: false, dcsDocumentId: r.documentId,
      });
      released++;
      pushJobs.push({ ownerUserId: r.ownerUserId, tenantId: r.tenantId, documentId: r.documentId, documentNumber: r.documentNumber, title: r.title });
    } catch (err) {
      logger.warn({ err, versionId: r.versionId }, "Scheduled DCS release failed — will retry next scan");
    }
  }

  if (released > 0) {
    saveDB(db);
    logger.info({ released }, "Activated scheduled DCS release(s)");
    for (const j of pushJobs) {
      const target = j.ownerUserId
        ? sendPushToUser(j.ownerUserId, { title: "Dokumen Berlaku (Terjadwal)", body: `"${j.title}" (${j.documentNumber}) kini resmi berlaku.`, url: `/?dcsDocument=${j.documentId}`, tag: `dcs-${j.documentId}` })
        : sendPushToTenant(j.tenantId, { title: "Dokumen Berlaku (Terjadwal)", body: `"${j.title}" (${j.documentNumber}) kini resmi berlaku.`, url: `/?dcsDocument=${j.documentId}`, tag: `dcs-${j.documentId}` });
      target.catch((err) => logger.warn({ err, documentId: j.documentId }, "Push for scheduled DCS release failed"));
    }
  }
}

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;    // review-due nudges — matches the contract reminder cadence
const RELEASE_INTERVAL_MS = 15 * 60 * 1000;       // scheduled releases — more responsive (cheap query)

export function startDcsReminderScheduler(pool: Pool) {
  runDcsReminderCheck(pool).catch((err) => logger.error({ err }, "Initial DCS review-reminder check failed"));
  runDcsReleaseCheck(pool).catch((err) => logger.error({ err }, "Initial DCS scheduled-release check failed"));
  setInterval(() => {
    runDcsReminderCheck(pool).catch((err) => logger.error({ err }, "DCS review-reminder check failed"));
  }, CHECK_INTERVAL_MS);
  setInterval(() => {
    runDcsReleaseCheck(pool).catch((err) => logger.error({ err }, "DCS scheduled-release check failed"));
  }, RELEASE_INTERVAL_MS);
  logger.info("DCS scheduler started (review nudges every 6h, scheduled-release activation every 15m)");
}

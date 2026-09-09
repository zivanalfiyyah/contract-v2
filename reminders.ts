import { loadDB, saveDB } from "./db.js";
import { logger } from "./logger.js";
import { sendPushToTenant } from "./push.js";
import type { Contract } from "./src/types";

// Proactive expiry reminders — runs on a timer instead of only computing
// "days remaining" client-side when someone happens to open the dashboard.
// Dedup is by calendar date (Contract.lastReminderDate): each active
// contract gets at most one reminder notification per day, whether the
// check runs once or a dozen times that day (server restarts, multiple
// interval ticks, etc), and without needing an extra job-scheduling table.

function getDaysRemaining(endDate: string): number {
  const end = new Date(endDate);
  end.setHours(0, 0, 0, 0);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.ceil((end.getTime() - now.getTime()) / 86400000);
}

// Reminder kedaluwarsa HANYA relevan untuk kontrak yang benar-benar sudah
// berjalan (status "Aktif" — sudah lolos approval matrix DAN sudah ada bukti
// TTD basah yang diunggah). Draft/OnReview/FullyApproved belum mengikat
// apa-apa, jadi tidak pernah butuh reminder "akan berakhir". TidakAktif juga
// dikecualikan — begitu kontrak sudah ditandai Tidak Aktif (lihat transisi
// otomatis di bawah), ia tidak perlu terus memicu reminder harian lagi;
// keputusan lanjutannya (renew/Archived/Terminated) ada di tangan manusia
// lewat dashboard, bukan notifikasi berulang.
function isActive(contract: Contract): boolean {
  return contract.status === "Aktif";
}

/**
 * Eskalasi SLA approval: dokumen yang menggantung di satu langkah melewati
 * batas wajar diingatkan sekali per hari — ke approver-nya, ke penggantinya
 * bila sedang ada delegasi, dan ke pengaju draftnya.
 *
 * Tanpa ini "berapa lama dokumen tertahan di siapa" tidak pernah terukur:
 * satu-satunya cara tahu adalah seseorang kebetulan membuka Monitoring dan
 * memperhatikan tanggalnya.
 *
 * Dedup memakai pola yang sama seperti reminder kedaluwarsa (penanda tanggal
 * kalender pada langkahnya), jadi scheduler boleh berjalan berkali-kali sehari
 * tanpa membanjiri notifikasi.
 */
export function checkApprovalSla(db: any, today: string): number {
  let count = 0;
  for (const contract of db.contracts as Contract[]) {
    if (contract.status !== "OnReview") continue;
    const settings = (db.settings || []).find((s: any) => s.tenantId === contract.tenantId);
    const slaDays = Number(settings?.approvalSlaDays ?? 3);
    if (!Number.isFinite(slaDays) || slaDays <= 0) continue; // 0 = SLA dimatikan
    const steps = [...(contract.approvalSteps || [])].sort((a, b) => a.order - b.order);
    const current = steps.find((s) => s.decision === "pending");
    if (!current) continue;
    // Langkah lama (dibuat sebelum startedAt ada) tidak punya titik mulai yang
    // bisa dipercaya — dilewati, bukan ditebak dari updatedAt.
    if (!current.startedAt) continue;
    if ((current as any).lastSlaNudgeDate === today) continue;
    const hari = Math.floor((Date.now() - new Date(current.startedAt).getTime()) / 86400000);
    if (hari < slaDays) continue;

    const pesan = `Kontrak ${contract.contractNumber} (${contract.title}) sudah ${hari} hari menunggu keputusan ${current.approverName} — melewati batas ${slaDays} hari.`;
    const penerima = new Set<string>([current.approverId]);
    if (contract.approvalSubmittedById) penerima.add(contract.approvalSubmittedById);
    const approver = (db.users as any[]).find((u) => u.id === current.approverId);
    if (approver?.delegateToId && approver.delegateFrom && approver.delegateUntil
        && today >= approver.delegateFrom && today <= approver.delegateUntil) {
      penerima.add(approver.delegateToId);
    }
    db.notifications.unshift({
      id: "not-sla-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
      tenantId: contract.tenantId,
      title: "Persetujuan Melewati Batas Waktu",
      message: pesan,
      type: hari >= slaDays * 2 ? "danger" : "warning",
      createdAt: new Date().toISOString(),
      read: false,
      contractId: contract.id,
      targetUserIds: [...penerima],
    });
    (current as any).lastSlaNudgeDate = today;
    count++;
  }
  return count;
}

/**
 * Pengingat jatuh tempo TERMIN PEMBAYARAN.
 *
 * Terpisah dari reminder masa berlaku kontrak karena jadwalnya beda: satu
 * kontrak bisa punya banyak termin dengan tanggal masing-masing, dan yang
 * berakhir masa berlakunya belum tentu lunas tagihannya.
 *
 * Termin berstatus "lunas" atau "batal" tidak pernah diingatkan — tidak ada
 * tindakan tersisa. Dedup per termin per tanggal kalender, pola sama seperti
 * reminder lain di berkas ini.
 */
export function checkPaymentDue(db: any, today: string): number {
  let count = 0;
  const AMBANG_HARI = 7; // diingatkan mulai seminggu sebelum jatuh tempo
  for (const contract of db.contracts as Contract[]) {
    if (contract.status === "Archived" || contract.status === "Terminated") continue;
    const termin = contract.paymentTerms || [];
    if (termin.length === 0) continue;
    for (const t of termin) {
      if (t.status === "lunas" || t.status === "batal") continue;
      if (t.lastDueNudgeDate === today) continue;
      const sisa = Math.ceil((new Date(t.dueDate).getTime() - new Date(today).getTime()) / 86400000);
      if (!Number.isFinite(sisa) || sisa > AMBANG_HARI) continue;
      const telat = sisa < 0;
      db.notifications.unshift({
        id: "not-pay-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
        tenantId: contract.tenantId,
        title: telat ? "Termin Pembayaran Terlambat" : "Termin Pembayaran Akan Jatuh Tempo",
        message: telat
          ? `${contract.contractNumber} — "${t.label}" sudah lewat jatuh tempo ${Math.abs(sisa)} hari (${t.dueDate}) dan belum ditandai lunas.`
          : `${contract.contractNumber} — "${t.label}" jatuh tempo dalam ${sisa} hari (${t.dueDate}).`,
        type: telat ? "danger" : "warning",
        createdAt: new Date().toISOString(),
        read: false,
        contractId: contract.id,
      });
      t.lastDueNudgeDate = today;
      count++;
    }
  }
  return count;
}

/**
 * Pengingat KEWAJIBAN kontrak (laporan berkala, perpanjangan asuransi, dsb).
 *
 * Ditargetkan ke penanggung jawabnya bila ada — kewajiban adalah tugas satu
 * orang, bukan pengumuman perusahaan. Kalau belum ada penanggung jawab,
 * notifikasinya tenant-wide supaya tetap terlihat dan bisa diambil orang.
 */
export function checkObligationDue(db: any, today: string): number {
  let count = 0;
  const AMBANG_HARI = 7;
  for (const contract of db.contracts as Contract[]) {
    if (contract.status === "Archived" || contract.status === "Terminated") continue;
    for (const o of contract.obligations || []) {
      if (o.status !== "open") continue; // done / waived: tidak ada tindakan tersisa
      if (o.lastDueNudgeDate === today) continue;
      const sisa = Math.ceil((new Date(o.dueDate).getTime() - new Date(today).getTime()) / 86400000);
      if (!Number.isFinite(sisa) || sisa > AMBANG_HARI) continue;
      const telat = sisa < 0;
      db.notifications.unshift({
        id: "not-obl-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
        tenantId: contract.tenantId,
        title: telat ? "Kewajiban Kontrak Terlambat" : "Kewajiban Kontrak Akan Jatuh Tempo",
        message: telat
          ? `${contract.contractNumber} — "${o.title}" sudah lewat ${Math.abs(sisa)} hari dari jatuh tempo ${o.dueDate}${o.ownerName ? ` (penanggung jawab: ${o.ownerName})` : ""}.`
          : `${contract.contractNumber} — "${o.title}" jatuh tempo dalam ${sisa} hari (${o.dueDate})${o.ownerName ? `, penanggung jawab ${o.ownerName}` : ""}.`,
        type: telat ? "danger" : "warning",
        createdAt: new Date().toISOString(),
        read: false,
        contractId: contract.id,
        ...(o.ownerId ? { targetUserIds: [o.ownerId] } : {}),
      });
      o.lastDueNudgeDate = today;
      count++;
    }
  }
  return count;
}

/**
 * Majukan tanggal kewajiban berulang ke periode berikutnya.
 *
 * Tanggal akhir bulan DIJEPIT ke hari terakhir bulan tujuan. Memakai
 * Date.setMonth() begitu saja salah: 31 Januari + 1 bulan menjadi "31 Februari"
 * yang dinormalkan JS ke 3 Maret — Februari terlewat sama sekali, dan tanggalnya
 * terus melenceng tiap periode. Laporan bulanan yang jatuh tempo tanggal 31
 * akan pelan-pelan bergeser ke pertengahan bulan.
 */
export function nextObligationDate(dueDate: string, recurrence: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dueDate);
  if (!m) return dueDate;
  const tambahBulan = recurrence === "monthly" ? 1 : recurrence === "quarterly" ? 3 : recurrence === "yearly" ? 12 : 0;
  if (tambahBulan === 0) return dueDate;
  const tahun = Number(m[1]), bulan = Number(m[2]) - 1, tanggal = Number(m[3]);
  const totalBulan = bulan + tambahBulan;
  const tahunBaru = tahun + Math.floor(totalBulan / 12);
  const bulanBaru = ((totalBulan % 12) + 12) % 12;
  // Hari terakhir bulan tujuan: tanggal 0 bulan berikutnya.
  const hariTerakhir = new Date(Date.UTC(tahunBaru, bulanBaru + 1, 0)).getUTCDate();
  const tanggalBaru = Math.min(tanggal, hariTerakhir);
  return `${tahunBaru}-${String(bulanBaru + 1).padStart(2, "0")}-${String(tanggalBaru).padStart(2, "0")}`;
}

export async function runReminderCheck() {
  const db = loadDB();
  const today = new Date().toISOString().split("T")[0];
  let sentCount = 0;
  // Push is sent per-contract after saveDB commits the in-app notification,
  // so a push failure never blocks the (more important) in-app record.
  const pushJobs: { tenantId: string; title: string; message: string; contractId: string }[] = [];

  for (const contract of db.contracts as Contract[]) {
    if (!isActive(contract)) continue;
    if (contract.lastReminderDate === today) continue; // already notified today

    const daysRemaining = getDaysRemaining(contract.endDate);
    const overdue = daysRemaining < 0;

    // Kontrak yang BENAR-BENAR berjalan (status Aktif) dan sudah lewat masa
    // berlaku otomatis pindah ke TidakAktif — bukan Archived/Terminated
    // (itu selalu keputusan manusia eksplisit lewat PUT), murni penanda
    // "sudah kedaluwarsa, butuh tindak lanjut". Draft/OnReview/FullyApproved
    // tidak pernah "expired" begini karena belum pernah benar-benar berjalan.
    if (overdue && contract.status === "Aktif") {
      contract.status = "TidakAktif";
      contract.updatedAt = new Date().toISOString();
    }

    const withinWindow = daysRemaining <= (contract.reminderDaysBefore || 30);
    if (!withinWindow) continue;

    const title = overdue ? "Kontrak Menjadi Tidak Aktif (Kedaluwarsa)" : "Kontrak Akan Berakhir";
    const message = overdue
      ? `Kontrak ${contract.contractNumber} (${contract.title}) telah melewati masa berlaku ${Math.abs(daysRemaining)} hari yang lalu dan otomatis ditandai Tidak Aktif.`
      : `Kontrak ${contract.contractNumber} (${contract.title}) akan berakhir dalam ${daysRemaining} hari.`;
    const type = overdue ? "danger" : daysRemaining <= 7 ? "warning" : "info";

    db.notifications.unshift({
      id: "not-reminder-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
      tenantId: contract.tenantId,
      title,
      message,
      type,
      createdAt: new Date().toISOString(),
      read: false,
      contractId: contract.id,
    });

    contract.lastReminderDate = today;
    sentCount++;
    pushJobs.push({ tenantId: contract.tenantId, title, message, contractId: contract.id });
  }

  const slaCount = checkApprovalSla(db, today);
  const payCount = checkPaymentDue(db, today);
  const oblCount = checkObligationDue(db, today);
  if (sentCount > 0 || slaCount > 0 || payCount > 0 || oblCount > 0) {
    saveDB(db);
    logger.info({ sentCount, slaCount, payCount, oblCount }, "Sent proactive expiry / approval-SLA / payment-due / obligation-due notification(s)");

    for (const job of pushJobs) {
      try {
        await sendPushToTenant(job.tenantId, {
          title: job.title,
          body: job.message,
          url: `/?contract=${job.contractId}`,
          tag: `reminder-${job.contractId}`,
        });
      } catch (err) {
        logger.warn({ err, contractId: job.contractId }, "Push for reminder failed");
      }
    }
  }
}

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours; date-based dedup makes more frequent runs harmless

export function startReminderScheduler() {
  runReminderCheck().catch((err) => logger.error({ err }, "Initial reminder check failed")); // catch up immediately on boot (e.g. after downtime)
  setInterval(() => {
    runReminderCheck().catch((err) => logger.error({ err }, "Reminder check failed"));
  }, CHECK_INTERVAL_MS);
  logger.info("Proactive expiry reminder scheduler started (checks every 6h)");
}
import path from "path";
import fs from "fs";
import { loadDB } from "./db.js";
import { logger } from "./logger.js";

// Automated backups — losing the database with no backup strategy is a
// total-data-loss risk for every tenant sharing it. Snapshots go to
// ./backups/<timestamp>/ containing a full logical JSON dump of everything
// db.ts holds in memory (every collection + categories + settings, the same
// shape the legacy database.json import already understood) plus a
// recursive copy of /uploads (contract documents stored on local disk are
// business data too, not just DB rows — files that ended up in cloud
// storage instead aren't duplicated here, the bucket is their backup).
//
// This moved from a binary SQLite file copy to a JSON snapshot when the
// persistence layer moved from SQLite to Postgres (see db.ts) — a full
// logical dump is portable across either backend and needs no DB-specific
// tooling (pg_dump etc) to be present on this machine.
//
// Local-disk only: this protects against a bad migration or accidental
// deletion in the app itself, but NOT against losing the whole machine.
// Production should also ship these snapshots off-box (S3/GCS/etc) — that
// needs cloud credentials this environment doesn't have, so it's a
// follow-up, not silently covered here.

const UPLOADS_DIR = path.join(process.cwd(), "uploads");
const BACKUP_ROOT = path.join(process.cwd(), "backups");
const RETENTION_COUNT = 14; // keep the last 14 daily snapshots

function timestampSlug(): string {
  return new Date().toISOString().replace(/:/g, "-").split(".")[0]; // e.g. 2026-07-08T22-15-30
}

export async function runBackup(): Promise<{ dir: string; dbSizeBytes: number }> {
  if (process.env.VERCEL) {
    // Vercel functions have a read-only filesystem outside /tmp, and /tmp
    // itself doesn't survive between invocations — a "local disk" backup
    // snapshot has nowhere durable to live there.
    throw new Error("Backup lokal tidak didukung di Vercel (filesystem read-only/ephemeral). Gunakan platform dengan disk persisten (Render/VPS) untuk fitur backup ini.");
  }
  fs.mkdirSync(BACKUP_ROOT, { recursive: true });

  const dir = path.join(BACKUP_ROOT, timestampSlug());
  fs.mkdirSync(dir, { recursive: true });

  const snapshotPath = path.join(dir, "data.json");
  const json = JSON.stringify(loadDB());
  fs.writeFileSync(snapshotPath, json, "utf-8");

  if (fs.existsSync(UPLOADS_DIR)) {
    fs.cpSync(UPLOADS_DIR, path.join(dir, "uploads"), { recursive: true });
  }

  const dbSizeBytes = fs.statSync(snapshotPath).size;
  logger.info({ dir, dbSizeKB: +(dbSizeBytes / 1024).toFixed(1) }, "Backup snapshot created");

  rotateOldBackups();
  return { dir, dbSizeBytes };
}

function rotateOldBackups() {
  if (!fs.existsSync(BACKUP_ROOT)) return;
  const entries = fs
    .readdirSync(BACKUP_ROOT)
    .filter((name) => fs.statSync(path.join(BACKUP_ROOT, name)).isDirectory())
    .sort(); // timestamp-slug names sort chronologically as strings
  const excess = entries.length - RETENTION_COUNT;
  if (excess <= 0) return;
  for (const old of entries.slice(0, excess)) {
    fs.rmSync(path.join(BACKUP_ROOT, old), { recursive: true, force: true });
    logger.info({ snapshot: old }, "Rotated out old backup snapshot");
  }
}

export function listBackups() {
  if (!fs.existsSync(BACKUP_ROOT)) return [];
  return fs
    .readdirSync(BACKUP_ROOT)
    .filter((name) => fs.statSync(path.join(BACKUP_ROOT, name)).isDirectory())
    .sort()
    .reverse()
    .map((name) => {
      const snapshotPath = path.join(BACKUP_ROOT, name, "data.json");
      const stat = fs.statSync(path.join(BACKUP_ROOT, name));
      return {
        name,
        createdAt: stat.birthtime.toISOString(),
        dbSizeBytes: fs.existsSync(snapshotPath) ? fs.statSync(snapshotPath).size : 0,
      };
    });
}

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // check every 6h; date dedup keeps it to one real backup/day
let lastBackupDate = "";

function dailyCheck() {
  const today = new Date().toISOString().split("T")[0];
  if (lastBackupDate === today) return;
  runBackup()
    .then(() => {
      lastBackupDate = today;
    })
    .catch((err) => logger.error({ err }, "Backup failed"));
}

export function startBackupScheduler() {
  dailyCheck(); // catch up immediately if today's backup hasn't run yet (e.g. after downtime)
  setInterval(dailyCheck, CHECK_INTERVAL_MS);
  logger.info("Daily backup scheduler started (retains last 14 snapshots)");
}

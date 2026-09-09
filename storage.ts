import fs from "fs";
import path from "path";
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { logger } from "./logger.js";

// File storage abstraction — same honest-degradation shape as email.ts/push.ts.
// Uses any S3-compatible object storage (AWS S3, Cloudflare R2, MinIO, or
// GCS via its S3-interop endpoint) when STORAGE_* env vars are set. Falls
// back to local disk (uploads/ folder, served at /uploads) when they aren't,
// so a fresh dev install keeps working with zero configuration — it just
// won't survive redeploys/multi-instance scaling until cloud storage is
// wired up.

export interface StorageConfig {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string; // set for R2/MinIO/GCS-interop; omit for real AWS S3
  publicUrlBase?: string; // override for constructing public URLs (e.g. CDN domain, R2 public bucket URL)
  forcePathStyle: boolean;
}

function readConfig(): Partial<StorageConfig> {
  return {
    bucket: process.env.STORAGE_BUCKET,
    region: process.env.STORAGE_REGION || "auto",
    accessKeyId: process.env.STORAGE_ACCESS_KEY_ID,
    secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY,
    endpoint: process.env.STORAGE_ENDPOINT || undefined,
    publicUrlBase: process.env.STORAGE_PUBLIC_URL_BASE || undefined,
    forcePathStyle: process.env.STORAGE_FORCE_PATH_STYLE === "true",
  } as Partial<StorageConfig>;
}

export function isCloudStorageConfigured(): boolean {
  const cfg = readConfig();
  return !!(cfg.bucket && cfg.accessKeyId && cfg.secretAccessKey);
}

let cachedClient: S3Client | null = null;
let cachedConfigKey = "";

function getClient(): S3Client {
  const cfg = readConfig();
  const key = `${cfg.endpoint}:${cfg.region}:${cfg.accessKeyId}`;
  if (!cachedClient || cachedConfigKey !== key) {
    cachedClient = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint,
      forcePathStyle: cfg.forcePathStyle,
      credentials: { accessKeyId: cfg.accessKeyId!, secretAccessKey: cfg.secretAccessKey! },
    });
    cachedConfigKey = key;
  }
  return cachedClient;
}

export interface StoredFile {
  url: string;
  key: string; // storage key/filename — needed later to delete the object
  usedCloud: boolean;
}

const LOCAL_UPLOAD_DIR = path.join(process.cwd(), "uploads");
// Creating this eagerly at import time would crash the whole app on a
// read-only filesystem (e.g. Vercel functions) even when cloud storage IS
// configured and local disk is never actually touched. Created lazily,
// right before the one place that writes to it, instead.
function ensureLocalUploadDir() {
  if (!fs.existsSync(LOCAL_UPLOAD_DIR)) fs.mkdirSync(LOCAL_UPLOAD_DIR, { recursive: true });
}

// Saves an in-memory file buffer to whichever backend is configured and
// returns the URL to serve it from. `key` should already be a unique,
// sanitized filename (caller controls naming, same as multer did before).
export async function storeFile(buffer: Buffer, key: string, mimetype: string): Promise<StoredFile> {
  if (isCloudStorageConfigured()) {
    const cfg = readConfig();
    try {
      await getClient().send(new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: key,
        Body: buffer,
        ContentType: mimetype,
      }));
      const url = cfg.publicUrlBase
        ? `${cfg.publicUrlBase.replace(/\/$/, "")}/${key}`
        : cfg.endpoint
          ? `${cfg.endpoint.replace(/\/$/, "")}/${cfg.bucket}/${key}`
          : `https://${cfg.bucket}.s3.${cfg.region}.amazonaws.com/${key}`;
      return { url, key, usedCloud: true };
    } catch (err: any) {
      logger.error({ err, key }, "Cloud storage upload failed — falling back to local disk for this file");
      // Fall through to local disk so an upload doesn't hard-fail just
      // because the bucket had a transient error.
    }
  }
  try {
    ensureLocalUploadDir();
    fs.writeFileSync(path.join(LOCAL_UPLOAD_DIR, key), buffer);
    return { url: `/uploads/${key}`, key, usedCloud: false };
  } catch (err: any) {
    logger.error({ err, key }, "Local disk storage unavailable and cloud storage is not configured");
    throw new Error("Penyimpanan berkas tidak tersedia — cloud storage (STORAGE_*) belum dikonfigurasi dan disk lokal read-only di platform ini.");
  }
}

export async function deleteFile(key: string): Promise<void> {
  if (isCloudStorageConfigured()) {
    const cfg = readConfig();
    try {
      await getClient().send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
      return;
    } catch (err: any) {
      logger.error({ err, key }, "Cloud storage delete failed");
      return;
    }
  }
  const localPath = path.join(LOCAL_UPLOAD_DIR, key);
  if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
}

export function isStorageCloudBacked(): boolean {
  return isCloudStorageConfigured();
}

/**
 * Reads a stored object back into a Buffer from whichever backend holds it —
 * the mirror of storeFile(). Used by Smart DCS to fetch the clean PDF master
 * before applying the on-the-fly watermark. `key` is the storage key returned
 * by storeFile() (StoredFile.key), NOT the public URL.
 */
export async function fetchFile(key: string): Promise<Buffer> {
  if (isCloudStorageConfigured()) {
    const cfg = readConfig();
    const res = await getClient().send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
    const chunks: Buffer[] = [];
    for await (const chunk of res.Body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  const localPath = path.join(LOCAL_UPLOAD_DIR, key);
  if (!fs.existsSync(localPath)) {
    throw new Error(`Berkas tidak ditemukan di penyimpanan lokal: ${key}`);
  }
  return fs.readFileSync(localPath);
}

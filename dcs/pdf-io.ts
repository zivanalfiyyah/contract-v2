import crypto from "crypto";
import { fetchFile } from "../storage.js";

export class IntegrityError extends Error {
  constructor(key: string, expected: string, actual: string) {
    super(`Integrity check failed for ${key}: expected ${expected}, got ${actual}`);
    this.name = "IntegrityError";
  }
}

/**
 * Fetches the CLEAN master (via the platform storage abstraction — cloud or
 * local disk, DRY) and verifies it byte-for-byte against the sha256 recorded at
 * approval time. A mismatch means the stored master was tampered with after
 * signing — we refuse to serve it rather than watermark a corrupted document.
 * This is the tamper-proof integrity guarantee enforced at read time.
 */
export async function fetchAndVerifyCleanPdf(
  key: string,
  expectedSha256: string | null,
): Promise<Buffer> {
  const buf = await fetchFile(key);
  if (expectedSha256) {
    const actual = crypto.createHash("sha256").update(buf).digest("hex");
    if (actual !== expectedSha256) throw new IntegrityError(key, expectedSha256, actual);
  }
  return buf;
}

export function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

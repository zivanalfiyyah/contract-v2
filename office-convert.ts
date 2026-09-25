import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Konversi Word 97-2003 (.doc) -> .docx memakai LibreOffice (headless).
//
// Format .doc adalah biner lama (OLE2) yang tidak bisa dirender/diedit di
// browser. Supaya dokumen .doc tetap bisa dipratinjau & diedit di Document
// Workspace TANPA merusak layout, .doc dikonversi ke .docx oleh LibreOffice
// (konverter .doc paling akurat yang tersedia bebas). Berkas .doc ASLI tetap
// disimpan utuh sebagai versinya sendiri.
//
// LibreOffice harus terpasang di server. Lokasi dicari dari env
// LIBREOFFICE_PATH, lalu PATH, lalu lokasi instalasi standar Windows/macOS/
// Linux. Kalau tidak ada, fitur ini melapor jujur (isOfficeConverterAvailable)
// dan workspace menampilkan instruksi pemasangan.
// ---------------------------------------------------------------------------

const CANDIDATES = [
  "/usr/bin/soffice",
  "/usr/bin/libreoffice",
  "/usr/local/bin/soffice",
  "/usr/lib/libreoffice/program/soffice",
  "/opt/libreoffice/program/soffice",
  "/snap/bin/libreoffice",
  "/Applications/LibreOffice.app/Contents/MacOS/soffice",
  "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
  "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
];

let cached: string | null | undefined;
export function findSoffice(): string | null {
  if (cached !== undefined) return cached;
  const fromEnv = process.env.LIBREOFFICE_PATH || process.env.SOFFICE_PATH;
  const list = [
    ...(fromEnv ? [fromEnv] : []),
    ...(process.env.PATH || "").split(path.delimiter).filter(Boolean).flatMap((d) =>
      process.platform === "win32" ? [path.join(d, "soffice.exe")] : [path.join(d, "soffice"), path.join(d, "libreoffice")]),
    ...CANDIDATES,
  ];
  cached = list.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
  return cached;
}

export function isOfficeConverterAvailable(): boolean {
  return !!findSoffice();
}

// LibreOffice tidak aman dijalankan paralel dgn profil yang sama — antrikan.
let queue: Promise<unknown> = Promise.resolve();

export function convertDocToDocx(buf: Buffer): Promise<Buffer> {
  const run = async () => {
    const soffice = findSoffice();
    if (!soffice) {
      throw Object.assign(new Error("Konversi .doc membutuhkan LibreOffice di server (belum terpasang). Pasang LibreOffice atau set LIBREOFFICE_PATH, lalu muat ulang."), { status: 501 });
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clm-doc-"));
    try {
      const input = path.join(dir, "input.doc");
      fs.writeFileSync(input, buf);
      const profile = "file:///" + path.join(dir, "profile").replace(/\\/g, "/").replace(/^\/+/, "");
      await new Promise<void>((resolve, reject) => {
        const child = spawn(soffice, [
          `-env:UserInstallation=${profile}`,
          "--headless", "--norestore", "--nolockcheck", "--nodefault",
          "--convert-to", "docx:MS Word 2007 XML",
          "--outdir", dir, input,
        ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        let stderr = "";
        child.stderr.on("data", (d) => { stderr += d; });
        const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Konversi .doc melebihi batas waktu.")); }, 120_000);
        child.on("error", (e) => { clearTimeout(timer); reject(e); });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`LibreOffice gagal mengonversi (kode ${code}). ${stderr.slice(0, 300)}`));
        });
      });
      const out = path.join(dir, "input.docx");
      if (!fs.existsSync(out)) throw new Error("LibreOffice tidak menghasilkan berkas .docx.");
      return fs.readFileSync(out);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) { logger.warn({ err }, "Gagal membersihkan folder konversi sementara"); }
    }
  };
  const p = queue.then(run, run);
  queue = p.catch(() => undefined);
  return p;
}

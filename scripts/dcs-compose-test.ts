import { PDFDocument } from "pdf-lib";
import { composeDocumentPdf } from "../dcs/pdf-compose";
import fs from "fs";

(async () => {
  const { bytes, signatureSheetPageIndex } = await composeDocumentPdf({
    documentNumber: "SOP/HRD/2026/0001",
    title: "Prosedur Pengajuan Cuti Karyawan",
    docTypeCode: "SOP",
    department: "HRD",
    major: 1, minor: 0,
    purpose: "Menjelaskan tata cara pengajuan cuti tahunan karyawan agar tercatat rapi dan disetujui atasan tepat waktu.\nBerlaku untuk seluruh karyawan tetap.",
    scope: "Berlaku untuk seluruh unit kerja di kantor pusat dan cabang.",
    sections: [
      { heading: "1. Definisi", content: "Cuti tahunan adalah hak istirahat kerja yang diberikan kepada karyawan sesuai peraturan perusahaan." },
      { heading: "2. Ketentuan Umum", content: "Pengajuan cuti dilakukan minimal 3 hari kerja sebelum tanggal cuti melalui sistem HRIS. Atasan langsung wajib menyetujui dalam 1x24 jam." },
    ],
    flow: {
      mode: "builder",
      steps: [
        { order: 1, type: "start", text: "Mulai" },
        { order: 2, type: "process", text: "Karyawan mengajukan cuti di HRIS", actor: "Karyawan" },
        { order: 3, type: "decision", text: "Disetujui atasan?", noTargetOrder: 2 },
        { order: 4, type: "process", text: "HRD memproses & mengarsipkan", actor: "HRD" },
        { order: 5, type: "end", text: "Selesai" },
      ],
    },
    signatureColumns: [
      { label: "Dibuat oleh", role: "staff" },
      { label: "Diperiksa oleh", role: "manager" },
      { label: "Disetujui oleh", role: "legal" },
    ],
  });

  const buf = Buffer.from(bytes);
  const reloaded = await PDFDocument.load(buf);
  console.log("PDF bytes:", buf.length, "pages:", reloaded.getPageCount(), "header:", buf.slice(0, 5).toString(), "signatureSheetPageIndex:", signatureSheetPageIndex);
  const outPath = "C:/Users/user/AppData/Local/Temp/claude/c--Users-user-Downloads-Contract-Management/6f20ac19-8898-49c8-aee9-32a4eab95023/scratchpad/compose-test.pdf";
  fs.writeFileSync(outPath, buf);
  console.log("written to", outPath);
  console.log("COMPOSE TEST PASSED");
})().catch((e) => { console.error("FAIL:", e); process.exit(1); });

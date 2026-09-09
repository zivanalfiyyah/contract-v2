import { PDFDocument } from "pdf-lib";
import { composeDocumentPdf, type ComposeInput } from "../dcs/pdf-compose";
import fs from "fs";

const SCRATCH = "C:/Users/user/AppData/Local/Temp/claude/c--Users-user-Downloads-Contract-Management/6f20ac19-8898-49c8-aee9-32a4eab95023/scratchpad";

const swimlaneFlow: ComposeInput["flow"] = {
  mode: "builder",
  lanes: ["KARYAWAN", "ATASAN LANGSUNG", "HED", "DIREKSI"],
  steps: [
    { order: 1, type: "start", text: "Mulai", actor: "KARYAWAN" },
    { order: 2, type: "process", text: "Identifikasi kebutuhan barang", actor: "KARYAWAN" },
    { order: 3, type: "decision", text: "Disetujui atasan?", actor: "ATASAN LANGSUNG", noTargetOrder: 2 },
    { order: 4, type: "process", text: "Proses pembelian & pencatatan", actor: "HED" },
    { order: 5, type: "decision", text: "Butuh persetujuan direksi?", actor: "DIREKSI", noTargetOrder: 4 },
    { order: 6, type: "end", text: "Selesai", actor: "DIREKSI" },
  ],
};

const revisionHistory: ComposeInput["revisionHistory"] = [
  { major: 1, minor: 0, changeSummary: "Terbitan awal", effectiveAt: "2025-01-15T00:00:00Z", createdAt: "2025-01-10T00:00:00Z" },
  { major: 1, minor: 1, changeSummary: "Perbaikan poin 2 — verifikasi HSE ditambahkan", effectiveAt: "2025-06-01T00:00:00Z", createdAt: "2025-05-20T00:00:00Z" },
  { major: 2, minor: 0, changeSummary: "Terbitan ke-2 — restrukturisasi alur persetujuan", effectiveAt: "2026-02-02T00:00:00Z", createdAt: "2026-01-27T00:00:00Z" },
];

const appendix: ComposeInput["appendix"] = [
  { label: "Formulir Pembelian Asset", url: "https://drive.google.com/file/d/12dKLXM3ah9heXNN3jgFVlwdgWzZTUpNl/view" },
  { label: "Formulir Pengajuan Mutasi Aset", url: "https://forms.gle/HR-21-mutasi-aset" },
];

async function testLayout(name: string, input: ComposeInput, expectMinPages: number) {
  const { bytes, signatureSheetPageIndex } = await composeDocumentPdf(input);
  const buf = Buffer.from(bytes);
  const reloaded = await PDFDocument.load(buf);
  const pages = reloaded.getPageCount();
  const outPath = `${SCRATCH}/layout-${name}.pdf`;
  fs.writeFileSync(outPath, buf);
  const ok = pages >= expectMinPages;
  console.log(`${ok ? "✓" : "✗"} [${name}] pages=${pages} (expect >=${expectMinPages}) sigPage=${signatureSheetPageIndex} -> ${outPath}`);
  if (!ok) throw new Error(`${name}: expected >=${expectMinPages} pages, got ${pages}`);
}

(async () => {
  // 1. "standard" layout style — no letterhead, single-group signatures, swimlane flow (SOP-like)
  await testLayout("standard-sop", {
    documentNumber: "SOP/OPS/2026/0001",
    title: "Prosedur Pengendalian Asset",
    docTypeCode: "SOP", department: "OPS", major: 1, minor: 0,
    purpose: "Menetapkan pedoman pengendalian aset perusahaan.",
    scope: "Berlaku bagi seluruh karyawan yang terlibat pengajuan pembelian, penghapusan, dan mutasi aset.",
    sections: [
      { heading: "III. Referensi", content: "1. Peraturan Perusahaan\n2. SOP Penghapusan Aktiva Tetap" },
      { heading: "IV. Definisi", content: "Asset: barang milik perusahaan yang memiliki nilai ekonomis." },
    ],
    flow: swimlaneFlow,
    signatureGroups: [{ columns: [{ label: "Dibuat oleh", role: "staff" }, { label: "Diperiksa oleh", role: "manager" }, { label: "Disetujui oleh", role: "legal" }] }],
    revisionHistory,
    appendix,
  }, 4);

  // 2. "memo" layout style — letterhead + 2 grouped signature bands (Penyusun/Mengetahui), no flow
  await testLayout("memo-grouped-sig", {
    documentNumber: "IM-HED-01-02-26",
    title: "Bantuan Karyawan PT TBK",
    docTypeCode: "MEMO", department: "HED", major: 2, minor: 2,
    sections: [
      { heading: "I. Definisi", content: "Bantuan Pernikahan adalah bantuan yang diberikan kepada karyawan yang melangsungkan pernikahan secara resmi." },
      { heading: "II. Ketentuan", content: "a. Bantuan diberikan 1 kali.\nb. Karyawan wajib melampirkan dokumen pendukung." },
    ],
    letterhead: { companyName: "PT. Trans Berjaya Khatulistiwa", companyAddress: "Jl. Purbasari 4 No. 1 Kel. Cipageran, Kec. Cimahi Utara, Kota Cimahi, Jawa Barat" },
    signatureGroups: [
      { heading: "Penyusun:", columns: [{ label: "Manager HED", role: "manager" }, { label: "Manager FAT", role: "manager" }] },
      { heading: "Mengetahui:", columns: [{ label: "CAO", role: "legal" }, { label: "CEO", role: "admin" }] },
    ],
  }, 2);

  // 3. "kebijakan" layout style — letterhead + single signer
  await testLayout("kebijakan-single-sig", {
    documentNumber: "POL/DIR/2026/0001",
    title: "Kebijakan Mutu",
    docTypeCode: "POL", department: "DIR", major: 1, minor: 0,
    sections: [{ heading: "Pernyataan Kebijakan", content: "Mampu menghasilkan produk yang memenuhi kebutuhan pasar dalam aspek kualitas, harga, dan ketepatan waktu." }],
    letterhead: { companyName: "PT Makmur Abadi Valve", companyAddress: "Kp. Tegal Loa Rt. 11/03 Desa Karya Mekar, Purwakarta - Jawa Barat" },
    signatureGroups: [{ columns: [{ label: "Disetujui oleh", role: "admin" }] }],
  }, 2);

  console.log("\nALL LAYOUT TESTS PASSED");
})().catch((e) => { console.error("FAIL:", e); process.exit(1); });

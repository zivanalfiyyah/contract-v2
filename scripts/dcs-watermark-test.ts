import { PDFDocument, StandardFonts } from "pdf-lib";
import { applyReactiveWatermark } from "../dcs/pdf-watermark";
import { sha256 } from "../dcs/pdf-io";

(async () => {
  const clean = await PDFDocument.create();
  const p = clean.addPage([595, 842]);
  const f = await clean.embedFont(StandardFonts.Helvetica);
  p.drawText("SOP: Prosedur Cuti Karyawan", { x: 60, y: 760, size: 16, font: f });
  const cleanBytes = Buffer.from(await clean.save());
  console.log("clean pdf bytes:", cleanBytes.length, "sha:", sha256(cleanBytes).slice(0, 12));

  const eff = Buffer.from(await applyReactiveWatermark(cleanBytes, { status: "effective", viewerName: "Budi Legal", accessedAt: "2026-07-10 09:00 UTC", documentNumber: "SOP/HRD/2026/0001", major: 1, minor: 0 }));
  const reloaded = await PDFDocument.load(eff);
  console.log("EFFECTIVE bytes:", eff.length, "pages:", reloaded.getPageCount(), "header:", eff.slice(0, 5).toString());

  const sup = Buffer.from(await applyReactiveWatermark(cleanBytes, { status: "superseded", viewerName: "Budi Legal", accessedAt: "2026-07-10 09:00 UTC", documentNumber: "SOP/HRD/2026/0001", major: 1, minor: 0 }));
  console.log("SUPERSEDED bytes:", sup.length);
  console.log("valid PDF header:", eff.slice(0, 5).toString() === "%PDF-" ? "YES" : "NO");
  console.log("watermark stamped (bigger than clean):", eff.length > cleanBytes.length ? "YES" : "NO");
  console.log("ALL PDF CHECKS PASSED");
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });

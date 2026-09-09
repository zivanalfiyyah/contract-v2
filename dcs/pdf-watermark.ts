import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { drawDiagonalBanner, drawProvenanceFooter } from "./pdf-draw.js";
import type { VersionStatus } from "./state-machine";
import type { HeaderReactiveLayout } from "./pdf-compose.js";

export interface WatermarkContext {
  status: VersionStatus;
  viewerName: string;
  accessedAt: string;
  documentNumber: string;
  major: number;
  minor: number;
  // True bila versi masih 'effective' tapi sudah lewat tanggal tinjau ulang
  // (reviewDueAt) — dokumen dianggap kedaluwarsa dan TIDAK lagi terkendali,
  // jadi diberi watermark UNCONTROLLED walau status DB-nya masih effective.
  expired?: boolean;
  // Sel kop ISO yang diisi REAKTIF dari status live (Status Dokumen + Tanggal
  // Diterbitkan) — koordinatnya dari compose (HeaderReactiveLayout). Kosong =
  // dokumen non-ISO / lama (sebelum fitur ini) → kop tidak diisi ulang.
  headerLayout?: HeaderReactiveLayout | null;
  // Tanggal efektif versi ini (sudah diformat), diisi ke sel "Tanggal
  // Diterbitkan". "-" bila belum efektif.
  issuedDate?: string;
}

// "Status Dokumen" di kop = status KENDALI dokumen (bukan sekadar kata alur
// kerja), diturunkan dari status versi yang sebenarnya saat diakses — inilah
// yang membuat kop selalu jujur tanpa perlu compose ulang (yang akan menghapus
// tanda tangan). Sejalan dengan makna "Status Dokumen" pada dokumen ISO nyata.
function resolveHeaderStatus(ctx: WatermarkContext): { label: string; color: ReturnType<typeof rgb> } {
  if (ctx.status === "effective" && ctx.expired) return { label: "KEDALUWARSA (TIDAK TERKENDALI)", color: rgb(0.80, 0.12, 0.12) };
  switch (ctx.status) {
    case "effective":    return { label: "TERKENDALI (CONTROLLED)", color: rgb(0.13, 0.50, 0.25) };
    case "superseded":   return { label: "TIDAK TERKENDALI (OBSOLETE)", color: rgb(0.80, 0.12, 0.12) };
    case "approved":     return { label: "DISETUJUI", color: rgb(0.16, 0.32, 0.75) };
    case "under_review": return { label: "DALAM REVIEW", color: rgb(0.72, 0.45, 0.05) };
    default:             return { label: "DRAFT", color: rgb(0.40, 0.42, 0.48) };
  }
}

interface WatermarkSpec {
  banner: string;
  footer: string;
  color: ReturnType<typeof rgb>;
  bannerOpacity: number;
  footerOpacity: number;
}

/**
 * The CRITICAL reactive rule set. Watermark content is derived from live version
 * status at access time — the same clean file yields a blue "CONTROLLED COPY"
 * for an effective version and a red "UNCONTROLLED — OBSOLETE" for a superseded
 * one, with zero duplicate storage.
 */
function resolveSpec(ctx: WatermarkContext): WatermarkSpec {
  const rev = `${ctx.documentNumber}  Terbitan ${ctx.major} Revisi ${ctx.minor}`;
  // Effective tapi sudah lewat jadwal tinjau ulang → diperlakukan sebagai
  // UNCONTROLLED (kedaluwarsa): sama merahnya dengan dokumen obsolete.
  if (ctx.status === "effective" && ctx.expired) {
    return {
      banner: "UNCONTROLLED COPY — KEDALUWARSA / REVIEW OVERDUE",
      footer: `UNCONTROLLED / EXPIRED · ${rev} · Retrieved by ${ctx.viewerName} on ${ctx.accessedAt}`,
      color: rgb(0.80, 0.12, 0.12),
      bannerOpacity: 0.14, footerOpacity: 0.65,
    };
  }
  switch (ctx.status) {
    case "effective":
      return {
        banner: "CONTROLLED COPY",
        footer: `CONTROLLED COPY · ${rev} · Accessed by ${ctx.viewerName} on ${ctx.accessedAt}`,
        color: rgb(0.16, 0.32, 0.75),
        bannerOpacity: 0.10, footerOpacity: 0.55,
      };
    case "superseded":
      return {
        banner: "UNCONTROLLED COPY — OBSOLETE HISTORY",
        footer: `UNCONTROLLED / OBSOLETE · ${rev} · Retrieved by ${ctx.viewerName} on ${ctx.accessedAt}`,
        color: rgb(0.80, 0.12, 0.12),
        bannerOpacity: 0.14, footerOpacity: 0.65,
      };
    default:
      return {
        banner: `${ctx.status.toUpperCase().replace("_", " ")} — NOT FOR USE`,
        footer: `${ctx.status.toUpperCase()} · ${rev} · Accessed by ${ctx.viewerName} on ${ctx.accessedAt}`,
        color: rgb(0.45, 0.45, 0.45),
        bannerOpacity: 0.12, footerOpacity: 0.55,
      };
  }
}

/** Loads clean bytes, stamps the reactive watermark in-memory, returns new bytes. */
export async function applyReactiveWatermark(cleanPdf: Buffer, ctx: WatermarkContext): Promise<Uint8Array> {
  const spec = resolveSpec(ctx);
  const doc = await PDFDocument.load(cleanPdf);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  // Font reguler + status kop hanya disiapkan bila memang ada sel reaktif utk
  // diisi (dokumen ISO baru) — dokumen lama/non-ISO tidak menanggung biaya ini.
  const regular = ctx.headerLayout ? await doc.embedFont(StandardFonts.Helvetica) : null;
  const headerStatus = ctx.headerLayout ? resolveHeaderStatus(ctx) : null;
  for (const page of doc.getPages()) {
    drawDiagonalBanner(page, font, spec.banner, spec.color, spec.bannerOpacity);
    drawProvenanceFooter(page, font, spec.footer, spec.color, spec.footerOpacity);
    // Isi sel kop reaktif: Status Dokumen (dari status live) + Tanggal
    // Diterbitkan (tanggal efektif live) — di koordinat yang dicatat compose.
    if (ctx.headerLayout && headerStatus && regular) {
      const { status, issued } = ctx.headerLayout;
      page.drawText(headerStatus.label, { x: status.x, y: status.y, size: status.size, font, color: headerStatus.color });
      page.drawText(ctx.issuedDate || "-", { x: issued.x, y: issued.y, size: issued.size, font: regular, color: rgb(0.2, 0.22, 0.27) });
    }
  }
  return doc.save();
}

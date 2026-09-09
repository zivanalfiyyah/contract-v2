import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export interface InjectableSignature {
  signerName: string;
  signerRole: string;
  approvedAt: string;
  signatureImagePng: Uint8Array | null;
  anchor: { page: number; x: number; y: number; w: number; h: number };
}

/**
 * Injects every approver's signature image + name/role/date at its anchor.
 * Called by the approval flow the moment a version reaches 'approved'; the
 * returned bytes become the CLEAN master stored to S3 and hashed into
 * clean_file_sha256. Signatures are therefore part of the integrity-protected
 * record — unlike watermarks, which are never stored.
 */
export async function injectSignatures(
  cleanPdf: Buffer,
  signatures: InjectableSignature[],
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(cleanPdf);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();

  for (const sig of signatures) {
    // page < 0 (or out of range) → stamp on the last page. Lets callers add a
    // signature block without first loading the PDF to count pages.
    const idx = sig.anchor.page < 0 || sig.anchor.page >= pages.length ? pages.length - 1 : sig.anchor.page;
    const page = pages[idx];
    if (!page) continue;
    const { x, y, w, h } = sig.anchor;
    if (sig.signatureImagePng) {
      const img = await doc.embedPng(sig.signatureImagePng);
      page.drawImage(img, { x, y: y + 14, width: w, height: h - 14 });
    }
    page.drawText(`${sig.signerName} — ${sig.signerRole}`, { x, y: y + 2, size: 8, font, color: rgb(0.1, 0.1, 0.1) });
    page.drawText(`Approved: ${sig.approvedAt}`, { x, y: y - 8, size: 7, font, color: rgb(0.35, 0.35, 0.35) });
  }
  return doc.save();
}

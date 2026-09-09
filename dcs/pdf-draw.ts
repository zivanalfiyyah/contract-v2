import { degrees, type PDFFont, type PDFPage, type RGB } from "pdf-lib";

/** Tiled diagonal banner across the whole page — hard to crop away. */
export function drawDiagonalBanner(
  page: PDFPage, font: PDFFont, text: string, color: RGB, opacity: number, size = 42,
) {
  const { width, height } = page.getSize();
  const stepX = Math.max(text.length * size * 0.35, 320);
  const stepY = 190;
  for (let y = -height; y < height * 2; y += stepY) {
    for (let x = -width; x < width * 2; x += stepX) {
      page.drawText(text, { x, y, size, font, color, opacity, rotate: degrees(45) });
    }
  }
}

/** Per-page provenance footer strip — the audit line proving WHO/WHEN/WHICH. */
export function drawProvenanceFooter(
  page: PDFPage, font: PDFFont, text: string, color: RGB, opacity: number,
) {
  const { width } = page.getSize();
  page.drawText(text, { x: 24, y: 14, size: 7.5, font, color, opacity, maxWidth: width - 48 });
}

/**
 * Container label sheet — a line-for-line TypeScript port of V2's
 * `handleGenerate` drawing routine (portal-v2/src/pages/ContainerLabels.jsx,
 * lines 38-105 and 230-437). The constants, drawing order, fallbacks, and
 * shrink/truncate loops are preserved exactly so the PDF this produces is
 * byte-for-byte the same shape V2 generated. Only the data plumbing changed:
 * V2 read component state (`moves`, `containerTags`, `tagImageCache`) via
 * closures; here that data arrives as `ContainerLabelInput` and the barcode
 * and QR image generators arrive as `Adapters` (bwip-js differs between the
 * browser and Node runtimes, so the drawing routine itself stays runtime
 * agnostic — see `containerLabelAdapters.browser.ts` and
 * `containerLabelAdapters.node.ts`).
 */
import { jsPDF } from 'jspdf';

// TAG_TYPES/TagKey/TagDefinition moved to `tagTypes.ts` (which this module
// still fully re-exports) so callers that only need the tag keys/labels/
// colors don't have to import jsPDF along with them — see that file's
// header comment.
export { TAG_TYPES, type TagDefinition, type TagKey } from './tagTypes';
import { TAG_TYPES, type TagKey } from './tagTypes';

// Avery 5164 specs (inches) - 4" wide x 3-1/3" tall, 2 columns x 3 rows = 6 labels per sheet
export const AVERY_5164 = {
  pageWidth: 8.5,
  pageHeight: 11,
  labelWidth: 4,
  labelHeight: 3.333,
  marginTop: 0.5,
  marginLeft: 0.156,
  gapX: 0.188,
  gapY: 0,
  cols: 2,
  rows: 3,
};

export interface ContainerLabelMove {
  id: string;
  name: string | null;
  sourceSite: string | null;
  destSite: string | null;
  scheduledStart: string | null;
}

export interface ContainerLabelContainer {
  id: string;
  name: string | null;
  tag: TagKey | null;
}

export interface ContainerLabelInput {
  move: ContainerLabelMove;
  containers: ContainerLabelContainer[];
  tagImages: Partial<Record<TagKey, string>>;
}

/** Generates a data-URL PNG for a barcode/QR code. Implemented differently in
 *  the browser (bwip-js `toCanvas`) and Node (bwip-js `toBuffer`) runtimes,
 *  but with the same bwip-js option objects V2 used — see
 *  containerLabelAdapters.browser.ts / containerLabelAdapters.node.ts. */
export interface Adapters {
  barcode(text: string): string;
  qr(text: string, color: string): string;
}

/** The minimal jsPDF surface `buildContainerLabelPdf` touches, so tests can
 *  inject a recording fake in place of a real jsPDF document. A real jsPDF
 *  instance satisfies this structurally. */
export interface JsPdfLike {
  addPage(): void;
  setFont(fontName: string, fontStyle: string): void;
  setFontSize(size: number): void;
  text(text: string, x: number, y: number, options?: Record<string, unknown>): void;
  addImage(imageData: string, format: string, x: number, y: number, width: number, height: number): void;
  setDrawColor(gray: number): void;
  setLineDashPattern(pattern: number[], phase: number): void;
  line(x1: number, y1: number, x2: number, y2: number): void;
  getTextWidth(text: string): number;
  /** Not called by `buildContainerLabelPdf` itself — only by callers that
   *  want the browser download (V2's own `pdf.save(...)`). Declared here
   *  anyway so the return type is directly usable without a cast; a real
   *  jsPDF instance already has it, and the exactness test's recording
   *  fake below adds a harmless stub. */
  save(filename: string): void;
}

/**
 * Builds the container label PDF: one sheet (page) per container, 6 labels
 * per sheet (2 cols x 3 rows). Labels 1-5 are barcode + name (with an
 * optional tag image); label 6 is the info label (QR + move details + RFID
 * placeholder). This is a direct port of V2's `handleGenerate` body — see
 * the file header for what changed and what didn't.
 */
const MONTHS_UPPER = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** The Date value on label 6, as `dd-MMM-yyyy` (e.g. `01-SEP-2026`).
 *  DELIBERATE DIVERGENCE FROM V2 (Jimmy, 2026-09-12): V2 printed
 *  `toLocaleDateString()` (mm/dd/yyyy), which reads ambiguously across the
 *  regions the company operates in. 'N/A' when the move has no scheduled
 *  start. */
export function formatLabelDate(iso: string | null | undefined): string {
  if (!iso) return 'N/A';
  // Date-only fields (scheduled_start) arrive as MIDNIGHT UTC, so reading the
  // day through local time names the day before anywhere west of UTC. Read the
  // Y-M-D digits straight off the string when it has them — the same approach
  // `parseApiDay` in lib/timeline.ts takes — and fall back to UTC parts for
  // anything else. (Fixed 2026-09-16; V2 had this bug too, so the exactness
  // test's embedded V2 routine calls this same function and still matches.)
  const ymd = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (ymd) {
    const [, y, m, d] = ymd;
    const month = Number(m);
    if (month >= 1 && month <= 12) {
      return `${d}-${MONTHS_UPPER[month - 1]}-${y}`;
    }
  }
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return 'N/A';
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${dd}-${MONTHS_UPPER[dt.getUTCMonth()]}-${dt.getUTCFullYear()}`;
}

export function buildContainerLabelPdf(
  input: ContainerLabelInput,
  adapters: Adapters,
  doc?: JsPdfLike,
): JsPdfLike {
  const pdf: JsPdfLike = doc ?? (new jsPDF({ orientation: 'portrait', unit: 'in', format: 'letter' }) as unknown as JsPdfLike);
  const spec = AVERY_5164;

  for (let i = 0; i < input.containers.length; i++) {
    if (i > 0) pdf.addPage();

    const container = input.containers[i];
    const name = container.name || `Container ${container.id}`;
    const tagType = container.tag || null;
    const tagDef = tagType ? TAG_TYPES[tagType] : null;
    const tagImgDataUrl = tagType ? input.tagImages[tagType] ?? null : null;

    // Generate barcode and QR code images
    const barcodeDataUrl = adapters.barcode(name);
    const qrColor = tagDef?.qrColor || '000000';
    const qrDataUrl = adapters.qr(name, qrColor);

    // Move info for the 6th label
    const sourceSite = input.move.sourceSite || 'N/A';
    const destSite = input.move.destSite || 'N/A';
    const moveDate = formatLabelDate(input.move.scheduledStart);

    // Print 6 labels on the page (2 cols x 3 rows)
    // Labels 1-5: barcode + name, Label 6: info label with QR + RFID
    let labelIndex = 0;
    for (let row = 0; row < spec.rows; row++) {
      for (let col = 0; col < spec.cols; col++) {
        labelIndex++;
        const x = spec.marginLeft + col * (spec.labelWidth + spec.gapX);
        const y = spec.marginTop + row * (spec.labelHeight + spec.gapY);

        if (labelIndex === 6) {
          // 6th label: info label with QR code, move details, and RFID section
          const padding = 0.25;
          const leftX = x + padding;
          const qrSize = 1;
          let cursorY = y + padding + 0.15;

          // QR code top-right
          const qrX = x + spec.labelWidth - padding - qrSize;
          const qrY = y + padding;
          pdf.addImage(qrDataUrl, 'PNG', qrX, qrY, qrSize, qrSize);

          // Max text width to avoid QR code collision
          const indentX = leftX + 0.2;
          const indentMaxWidth = qrX - indentX - 0.1;

          // Truncate text to fit within a max width
          const truncate = (text: string, maxW: number): string => {
            if (pdf.getTextWidth(text) <= maxW) return text;
            let t = text;
            while (t.length > 0 && pdf.getTextWidth(t + '...') > maxW) {
              t = t.slice(0, -1);
            }
            return t + '...';
          };

          // Left-justified fields with values on next line indented
          pdf.setFontSize(12);
          pdf.setFont('helvetica', 'bold');
          pdf.text('Source:', leftX, cursorY);
          cursorY += 0.2;
          pdf.setFont('helvetica', 'normal');
          pdf.text(truncate(sourceSite, indentMaxWidth), indentX, cursorY);
          cursorY += 0.25;

          pdf.setFont('helvetica', 'bold');
          pdf.text('Dest:', leftX, cursorY);
          cursorY += 0.2;
          pdf.setFont('helvetica', 'normal');
          pdf.text(truncate(destSite, indentMaxWidth), indentX, cursorY);
          cursorY += 0.25;

          // Date
          pdf.setFont('helvetica', 'bold');
          pdf.text('Date:', leftX, cursorY);
          cursorY += 0.2;
          pdf.setFont('helvetica', 'normal');
          pdf.text(truncate(moveDate, indentMaxWidth), indentX, cursorY);
          cursorY += 0.25;

          // Container name
          pdf.setFont('helvetica', 'bold');
          pdf.text('Container:', leftX, cursorY);
          cursorY += 0.2;
          pdf.setFont('helvetica', 'normal');
          pdf.text(truncate(name, indentMaxWidth), indentX, cursorY);

          // RFID TAG HERE - centered at bottom of label
          const rfidY = y + spec.labelHeight - padding - 0.1;
          const centerX = x + spec.labelWidth / 2;
          pdf.setFontSize(11);
          pdf.setFont('helvetica', 'normal');
          pdf.setDrawColor(150);
          pdf.setLineDashPattern([0.1, 0.05], 0);
          const lineWidth = spec.labelWidth * 0.7;
          const lineX = x + (spec.labelWidth - lineWidth) / 2;
          pdf.line(lineX, rfidY - 0.3, lineX + lineWidth, rfidY - 0.3);
          pdf.text('RFID TAG HERE', centerX, rfidY, { align: 'center' });
          pdf.line(lineX, rfidY + 0.15, lineX + lineWidth, rfidY + 0.15);
          pdf.setLineDashPattern([], 0);
          pdf.setDrawColor(0);
        } else {
          // Labels 1-5: centered barcode + text (with optional tag image above)
          const hasTag = !!tagImgDataUrl;
          const barcodeHeight = 0.7;
          const barcodeWidth = spec.labelWidth * 0.6;
          const textSize = 42;
          const gap = 0.25;
          const centerX = x + spec.labelWidth / 2;
          const moveNameMargin = 0.25;

          // Tag image specs (~3.1:1 aspect ratio for all tags)
          const tagWidth = 3.6;
          const tagHeight = tagWidth / 3.1;

          // Container name - shrink font if needed to fit label width
          let nameSize = textSize;
          const maxNameWidth = spec.labelWidth * 0.9;
          pdf.setFont('helvetica', 'bold');
          pdf.setFontSize(nameSize);
          while (nameSize > 8 && pdf.getTextWidth(name) > maxNameWidth) {
            nameSize -= 1;
            pdf.setFontSize(nameSize);
          }
          const nameSizeInches = nameSize / 72;

          // Calculate total content height and center vertically
          const availableHeight = spec.labelHeight - moveNameMargin;
          const totalContent = (hasTag ? tagHeight + gap : 0)
            + barcodeHeight + gap + nameSizeInches;
          const contentTop = y + (availableHeight - totalContent) / 2;
          let curY = contentTop;

          // Tag image
          if (hasTag) {
            const tagX = x + (spec.labelWidth - tagWidth) / 2;
            pdf.addImage(tagImgDataUrl as string, 'PNG', tagX, curY, tagWidth, tagHeight);
            curY += tagHeight + gap;
          }

          // Barcode
          const barcodeX = x + (spec.labelWidth - barcodeWidth) / 2;
          pdf.addImage(barcodeDataUrl, 'PNG', barcodeX, curY, barcodeWidth, barcodeHeight);

          // Container name
          pdf.setFontSize(nameSize);
          pdf.setFont('helvetica', 'bold');
          const textY = curY + barcodeHeight + gap + nameSizeInches;
          pdf.text(name, centerX, textY, { align: 'center', baseline: 'bottom' });

          // Small move name at very bottom of label
          const moveName = input.move.name || `Move #${input.move.id}`;
          pdf.setFontSize(8);
          pdf.setFont('helvetica', 'normal');
          pdf.text(moveName, centerX, y + spec.labelHeight - 0.1, { align: 'center' });
        }
      }
    }
  }

  return pdf;
}

/** Filename for the browser download, matching V2's `pdf.save(...)` call
 *  exactly: `Container-Labels-<move name>.pdf`, falling back to
 *  `Move-<id>` (not `Move #<id>` — V2 used two different fallback strings
 *  for the filename and the on-label move name). */
export function containerLabelsFilename(moveName: string | null, moveId: string): string {
  const name = moveName || `Move-${moveId}`;
  return `Container-Labels-${name}.pdf`;
}

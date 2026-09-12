/**
 * Exactness proof for `buildContainerLabelPdf` against V2's original
 * `handleGenerate` drawing code (portal-v2/src/pages/ContainerLabels.jsx,
 * lines 230-437), plus a real-jsPDF smoke test and `containerLabelsFilename`
 * coverage.
 *
 * `v2Draw` below is V2's drawing routine, transcribed with only the
 * React-state reads swapped for reads of the same `ContainerLabelInput`
 * shape our port takes (`moves.find(...)` -> `input.move`,
 * `container.container_name` -> `container.name`,
 * `containerTags[container.id]` -> `container.tag`) and its own bwip-js
 * calls swapped for the injected `generateBarcode`/`generateQRCode`
 * parameters V2 already called through local closures. `V2_AVERY_5164` and
 * `V2_TAG_TYPES` are separately-transcribed copies of V2's constants (not
 * imported from the module under test), so a divergence in either the
 * constants or the drawing logic of `containerLabelSheet.ts` shows up as a
 * log mismatch. One line V2 has is intentionally dropped from both copies:
 * `const maxTextWidth = qrX - leftX - 0.1;` is computed and never read in
 * V2 (dead code) — `noUnusedLocals` rejects it, and since it feeds no
 * `pdf.*` call, dropping it from both sides cannot affect the recorded log.
 */
import { describe, expect, it } from 'vitest';

import {
  buildContainerLabelPdf,
  containerLabelsFilename,
  TAG_TYPES,
} from './containerLabelSheet';
import type {
  Adapters,
  ContainerLabelInput,
  ContainerLabelMove,
  JsPdfLike,
  TagDefinition,
  TagKey,
} from './containerLabelSheet';

// ---------------------------------------------------------------------------
// V2's original drawing code, transcribed (see file header for what changed)
// ---------------------------------------------------------------------------

const V2_AVERY_5164 = {
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

const V2_TAG_TYPES: Record<string, TagDefinition> = {
  none: { label: 'None', color: '#000000', qrColor: '000000', image: null },
  priority: { label: 'Priority', color: '#f5222d', qrColor: 'CC0000', image: '/images/priority-tag.png' },
  vendor: { label: 'Vendor', color: '#1890ff', qrColor: '1890ff', image: '/images/vendor-tag.png' },
  accessories: { label: 'Accessories', color: '#722ed1', qrColor: '722ed1', image: '/images/accessories-tag.png' },
  ewaste: { label: 'E-Waste', color: '#fa8c16', qrColor: 'e08200', image: '/images/e-waste-tag.png' },
  warehouse: { label: 'Warehouse', color: '#d4b106', qrColor: 'b89e00', image: '/images/warehouse-tag.png' },
};

function v2Draw(
  pdf: JsPdfLike,
  input: ContainerLabelInput,
  tagImageCache: Partial<Record<TagKey, string>>,
  generateBarcode: (text: string) => string,
  generateQRCode: (text: string, color: string) => string,
): void {
  const spec = V2_AVERY_5164;
  const moveData = input.move;

  for (let i = 0; i < input.containers.length; i++) {
    if (i > 0) pdf.addPage();

    const container = input.containers[i];
    const name = container.name || `Container ${container.id}`;
    const tagType = container.tag || null;
    const tagDef = tagType ? V2_TAG_TYPES[tagType] : null;
    const tagImgDataUrl = tagType ? tagImageCache[tagType] : null;

    // Generate barcode and QR code images
    const barcodeDataUrl = generateBarcode(name);
    const qrColor = tagDef?.qrColor || '000000';
    const qrDataUrl = generateQRCode(name, qrColor);

    // Get move info for 6th label
    const sourceSite = moveData?.sourceSite || 'N/A';
    const destSite = moveData?.destSite || 'N/A';
    const moveDate = moveData?.scheduledStart
      ? new Date(moveData.scheduledStart).toLocaleDateString()
      : 'N/A';

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
          const moveName = moveData?.name || `Move #${moveData?.id}`;
          pdf.setFontSize(8);
          pdf.setFont('helvetica', 'normal');
          pdf.text(moveName, centerX, y + spec.labelHeight - 0.1, { align: 'center' });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Recording fake jsPDF
// ---------------------------------------------------------------------------

interface LogEntry {
  method: string;
  args: unknown[];
}

/** Records every call as {method, args}. `getTextWidth` returns a
 *  deterministic width (text.length * current font size * 0.5 / 72) so the
 *  shrink and truncate loops in both drawing routines actually run and
 *  branch identically, without depending on a real font metrics table. */
class RecordingPdf implements JsPdfLike {
  readonly log: LogEntry[] = [];
  private fontSize = 16;

  addPage(): void {
    this.log.push({ method: 'addPage', args: [] });
  }

  setFont(fontName: string, fontStyle: string): void {
    this.log.push({ method: 'setFont', args: [fontName, fontStyle] });
  }

  setFontSize(size: number): void {
    this.fontSize = size;
    this.log.push({ method: 'setFontSize', args: [size] });
  }

  text(text: string, x: number, y: number, options?: Record<string, unknown>): void {
    this.log.push({ method: 'text', args: [text, x, y, options ?? null] });
  }

  addImage(imageData: string, format: string, x: number, y: number, width: number, height: number): void {
    this.log.push({ method: 'addImage', args: [imageData, format, x, y, width, height] });
  }

  setDrawColor(gray: number): void {
    this.log.push({ method: 'setDrawColor', args: [gray] });
  }

  setLineDashPattern(pattern: number[], phase: number): void {
    this.log.push({ method: 'setLineDashPattern', args: [pattern, phase] });
  }

  line(x1: number, y1: number, x2: number, y2: number): void {
    this.log.push({ method: 'line', args: [x1, y1, x2, y2] });
  }

  getTextWidth(text: string): number {
    const width = (text.length * this.fontSize * 0.5) / 72;
    this.log.push({ method: 'getTextWidth', args: [text] });
    return width;
  }
}

const fakeAdapters: Adapters = {
  barcode: (text) => `barcode:${text}`,
  qr: (text, color) => `qr:${text}:${color}`,
};

function baseMove(overrides: Partial<ContainerLabelMove> = {}): ContainerLabelMove {
  return {
    id: 'move-1',
    name: 'NAP11 Migration',
    sourceSite: 'HQ Datacenter',
    destSite: 'Colo West',
    scheduledStart: '2026-09-20T00:00:00.000Z',
    ...overrides,
  };
}

/** Runs both drawing routines against fresh recording fakes for the same
 *  input and asserts the recorded jsPDF call logs are identical. */
function expectIdenticalDrawLogs(input: ContainerLabelInput): { log: LogEntry[] } {
  const portPdf = new RecordingPdf();
  buildContainerLabelPdf(input, fakeAdapters, portPdf);

  const v2Pdf = new RecordingPdf();
  v2Draw(v2Pdf, input, input.tagImages, fakeAdapters.barcode, fakeAdapters.qr);

  expect(portPdf.log).toEqual(v2Pdf.log);
  return { log: portPdf.log };
}

describe('buildContainerLabelPdf — exactness vs V2', () => {
  it('matches V2 for a container with no tag', () => {
    const input: ContainerLabelInput = {
      move: baseMove(),
      containers: [{ id: 'c1', name: 'Rack A Contents', tag: null }],
      tagImages: {},
    };
    expectIdenticalDrawLogs(input);
  });

  const realTagKeys = (Object.keys(TAG_TYPES) as TagKey[]).filter((key) => key !== 'none');

  it.each(realTagKeys)('matches V2 for the "%s" tag', (tagKey) => {
    const input: ContainerLabelInput = {
      move: baseMove(),
      containers: [{ id: 'c1', name: 'Tagged Container', tag: tagKey }],
      tagImages: { [tagKey]: `data:image/png;base64,FAKE-${tagKey}` },
    };
    expectIdenticalDrawLogs(input);
  });

  it('matches V2 for a 60-character name that shrinks the font to 8pt', () => {
    const longName = 'A'.repeat(60);
    const input: ContainerLabelInput = {
      move: baseMove(),
      containers: [{ id: 'c1', name: longName, tag: null }],
      tagImages: {},
    };
    const { log } = expectIdenticalDrawLogs(input);
    // Sanity check the shrink loop actually bottomed out at 8pt, so this
    // test is exercising the loop and not merely a coincidental match.
    const fontSizes = log.filter((e) => e.method === 'setFontSize').map((e) => e.args[0]);
    expect(fontSizes).toContain(8);
  });

  it('matches V2 for a source site name long enough to truncate', () => {
    const longSourceSite = 'Northeast Regional Distribution and Fulfillment Center';
    const input: ContainerLabelInput = {
      move: baseMove({ sourceSite: longSourceSite }),
      containers: [{ id: 'c1', name: 'Rack A Contents', tag: null }],
      tagImages: {},
    };
    const { log } = expectIdenticalDrawLogs(input);
    const truncatedTexts = log.filter((e) => e.method === 'text').map((e) => e.args[0]);
    expect(truncatedTexts.some((t) => typeof t === 'string' && t.endsWith('...'))).toBe(true);
  });

  it('matches V2 for an unscheduled move with null names (all fallbacks)', () => {
    const input: ContainerLabelInput = {
      move: { id: 'move-9', name: null, sourceSite: null, destSite: null, scheduledStart: null },
      containers: [{ id: 'c9', name: null, tag: null }],
      tagImages: {},
    };
    const { log } = expectIdenticalDrawLogs(input);
    const texts = log.filter((e) => e.method === 'text').map((e) => e.args[0]);
    expect(texts).toContain('Container c9');
    expect(texts).toContain('Move #move-9');
    expect(texts).toContain('N/A');
  });

  it('matches V2 across three containers (three sheets, addPage between them)', () => {
    const input: ContainerLabelInput = {
      move: baseMove(),
      containers: [
        { id: 'c1', name: 'Rack A Contents', tag: 'priority' },
        { id: 'c2', name: 'Rack B Contents', tag: null },
        { id: 'c3', name: 'Rack C Contents', tag: 'warehouse' },
      ],
      tagImages: {
        priority: 'data:image/png;base64,FAKE-priority',
        warehouse: 'data:image/png;base64,FAKE-warehouse',
      },
    };
    const { log } = expectIdenticalDrawLogs(input);
    expect(log.filter((e) => e.method === 'addPage')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Real jsPDF smoke test
// ---------------------------------------------------------------------------

// A minimal valid 1x1 PNG, standing in for a real barcode/QR image — jsPDF's
// addImage decodes the PNG header, so this has to be real PNG bytes.
const TINY_PNG = 'data:image/png;base64,'
  + 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const smokeAdapters: Adapters = {
  barcode: () => TINY_PNG,
  qr: () => TINY_PNG,
};

describe('buildContainerLabelPdf — real jsPDF smoke test', () => {
  it('produces a valid multi-page PDF containing the container names and the RFID placeholder', () => {
    const input: ContainerLabelInput = {
      move: baseMove(),
      containers: [
        { id: 'c1', name: 'Rack A Contents', tag: null },
        { id: 'c2', name: 'Rack B Contents', tag: null },
      ],
      tagImages: {},
    };

    const doc = buildContainerLabelPdf(input, smokeAdapters) as unknown as {
      output(type: 'arraybuffer'): ArrayBuffer;
    };
    const pdfText = Buffer.from(doc.output('arraybuffer')).toString('latin1');

    expect(pdfText.startsWith('%PDF')).toBe(true);
    const pageObjectCount = (pdfText.match(/\/Type\s*\/Page\b/g) ?? []).length;
    expect(pageObjectCount).toBe(2);
    expect(pdfText).toContain('Rack A Contents');
    expect(pdfText).toContain('Rack B Contents');
    expect(pdfText).toContain('RFID TAG HERE');
  });
});

// ---------------------------------------------------------------------------
// containerLabelsFilename
// ---------------------------------------------------------------------------

describe('containerLabelsFilename', () => {
  it('uses the move name when present', () => {
    expect(containerLabelsFilename('NAP11 Migration', 'move-1')).toBe('Container-Labels-NAP11 Migration.pdf');
  });

  it('falls back to Move-<id> (not "Move #<id>") when the name is null', () => {
    expect(containerLabelsFilename(null, 'move-2')).toBe('Container-Labels-Move-move-2.pdf');
  });
});

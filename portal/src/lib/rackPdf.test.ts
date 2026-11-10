// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import type { DeviceListRow } from './initiatives';
import {
  PDF_CONTENT_WIDTH, PDF_HEIGHT_BUDGET, prepareSvgForPdf, rackPdfFileName, rackPdfLayout,
} from './rackPdf';
import type { RackPdfLayout } from './rackPdf';
import { RACK_LINE_WORK } from './rackPrint';

describe('rackPdfFileName', () => {
  it('names the file <Move> - <Rack> (<Side>).pdf', () => {
    expect(rackPdfFileName('NAP11 Migration', 'A1', 'Source'))
      .toBe('NAP11 Migration - A1 (Source).pdf');
  });

  it.each(['/', '\\', ':', '*', '?', '"', '<', '>', '|', '\u0001', '\u001f', '\u007f'])(
    'replaces %j with -', (c) => {
      expect(rackPdfFileName(`a${c}b`, `r${c}1`, 'Destination'))
        .toBe('a-b - r-1 (Destination).pdf');
    });

  it('falls back to Move for a blank move name', () => {
    expect(rackPdfFileName('', 'A1', 'Source')).toBe('Move - A1 (Source).pdf');
    expect(rackPdfFileName('   ', 'A1', 'Source')).toBe('Move - A1 (Source).pdf');
  });

  it('trims whitespace around each part', () => {
    expect(rackPdfFileName('  NAP11 Migration\t', ' A1 ', ' Source '))
      .toBe('NAP11 Migration - A1 (Source).pdf');
  });
});

const row = (i: number, over: Partial<DeviceListRow> = {}): DeviceListRow => ({
  id: `r${i}`, name: `device-${i}`, makeModel: 'Dell R740', ruText: `${i}`,
  categoryColor: '#1668a7', group: 'FRONT', indent: false, orphan: false, ...over,
});

// a 52U frame's viewBox (see RackElevation)
const frame = (heading: string) => ({ heading, width: 190, height: 52 * 16 + 20 });

/** Every drawn thing sits inside the 7.2in x 9.3in content box. */
function expectInsideBudget(layout: RackPdfLayout) {
  const { left, top } = layout;
  const right = left + PDF_CONTENT_WIDTH + 0.01;
  const bottom = top + PDF_HEIGHT_BUDGET + 0.01;
  expect(layout.width).toBeLessThanOrEqual(PDF_CONTENT_WIDTH + 0.01);
  expect(layout.height).toBeLessThanOrEqual(PDF_HEIGHT_BUDGET + 0.01);
  for (const t of layout.texts) {
    expect(t.x).toBeGreaterThanOrEqual(left - 0.01);
    expect(t.x + t.width).toBeLessThanOrEqual(right);
    // Courier's ascender is 0.629 em, its descender 0.157 em
    expect(t.y - 0.629 * t.size).toBeGreaterThanOrEqual(top - 0.01);
    expect(t.y + 0.157 * t.size).toBeLessThanOrEqual(bottom);
  }
  for (const b of [...layout.boxes, ...layout.frames.map((f) =>
    ({ x: f.x, y: f.y, w: f.width, h: f.height }))]) {
    expect(b.x).toBeGreaterThanOrEqual(left - 0.01);
    expect(b.y).toBeGreaterThanOrEqual(top - 0.01);
    expect(b.x + b.w).toBeLessThanOrEqual(right);
    expect(b.y + b.h).toBeLessThanOrEqual(bottom);
  }
  for (const l of layout.lines) {
    expect(Math.min(l.x1, l.x2)).toBeGreaterThanOrEqual(left - 0.01);
    expect(Math.max(l.x1, l.x2)).toBeLessThanOrEqual(right);
    expect(Math.max(l.y1, l.y2)).toBeLessThanOrEqual(bottom);
  }
}

describe('rackPdfLayout', () => {
  const base = {
    title: 'Rack A1 — Source', grouped: false,
    legend: [{ label: 'Server', color: '#1668a7' }],
  };

  it('lays out a single frame, the list and the legend at full size', () => {
    const layout = rackPdfLayout({ ...base, frames: [frame('FRONT')], listRows: [row(1), row(2)] });
    expect(layout.scale).toBe(1);
    expectInsideBudget(layout);
    const texts = layout.texts.map((t) => t.text);
    expect(texts).toContain('Rack A1 — Source');
    // a lone frame gets no caption
    expect(texts).not.toContain('FRONT');
    expect(texts).toEqual(expect.arrayContaining(
      ['device-1', 'device-2', 'Dell R740', 'Server', 'Verified', 'Planned']));
    // 8.7in tall elevation
    expect(layout.frames[0].height).toBeCloseTo(8.7 * 72);
    // list swatch per row + one per legend item
    expect(layout.boxes).toHaveLength(2 + 3);
  });

  it('captions every frame when there is more than one, and fits four frames by scaling', () => {
    const layout = rackPdfLayout({
      ...base, frames: ['FRONT', 'FRONT · NODES', 'REAR', 'REAR · NODES'].map(frame),
      listRows: [row(1)],
    });
    const texts = layout.texts.map((t) => t.text);
    expect(texts).toEqual(expect.arrayContaining(['FRONT', 'FRONT · NODES', 'REAR', 'REAR · NODES']));
    expect(layout.scale).toBeLessThan(1);
    expectInsideBudget(layout);
  });

  it('scales a tall list down so the whole sheet stays inside the budget', () => {
    const listRows = Array.from({ length: 80 }, (_, i) =>
      row(i, { group: i < 40 ? 'FRONT' : 'REAR' }));
    const layout = rackPdfLayout({ ...base, grouped: true, frames: [frame('FRONT'), frame('REAR')], listRows });
    expect(layout.scale).toBeLessThan(1);
    expectInsideBudget(layout);
    // group headings when grouped
    expect(layout.texts.filter((t) => t.text === 'FRONT' || t.text === 'REAR')).toHaveLength(4);
  });

  it('indents a child row and prefixes an orphan with "! "', () => {
    const layout = rackPdfLayout({
      ...base, frames: [frame('FRONT')],
      listRows: [row(1), row(2, { indent: true }), row(3, { orphan: true })],
    });
    const x = (text: string) => layout.texts.find((t) => t.text === text)!.x;
    expect(x('device-2')).toBeGreaterThan(x('device-1'));
    expect(layout.texts.map((t) => t.text)).toContain('! device-3');
  });
});

describe('prepareSvgForPdf', () => {
  it('writes the shared rack line-work styles onto a clone as attributes', () => {
    const host = document.createElement('div');
    host.innerHTML = '<svg viewBox="0 0 190 852" class="rack-svg">'
      + '<rect class="rack-post"/><line class="rack-u-hairline"/>'
      + '<text class="rack-u-label" dominant-baseline="middle">1</text></svg>';
    const svg = host.querySelector('svg') as SVGSVGElement;
    const clone = prepareSvgForPdf(svg);
    expect(clone).not.toBe(svg);
    const post = clone.querySelector('.rack-post')!;
    for (const [k, v] of Object.entries(RACK_LINE_WORK['rack-post'])) {
      expect(post.getAttribute(k)).toBe(v);
    }
    expect(clone.querySelector('.rack-u-hairline')!.getAttribute('stroke'))
      .toBe(RACK_LINE_WORK['rack-u-hairline'].stroke);
    expect(clone.querySelector('text')!.getAttribute('alignment-baseline')).toBe('middle');
    // the live SVG is left alone
    expect(svg.querySelector('.rack-post')!.hasAttribute('fill')).toBe(false);
  });
});

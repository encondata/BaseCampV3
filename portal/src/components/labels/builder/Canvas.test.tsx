// @vitest-environment jsdom
/**
 * The builder canvas over the Vegas fixture, with a tiny fake font: every
 * digit is 400 units wide, every capital 450 (the widest), lower case 400,
 * anything else 300, on a 1000-unit em with ascent 750 and descent 250.
 *
 * jsdom lays nothing out, so the label's SVG sits at client (0, 0) and a
 * point `in` inches from its corner is at `in × dpi × zoom` client pixels.
 */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import vegas from '../../../../../api/src/serversherpa/labels/fixtures/vegas_v2.json';
import { align } from '../../../labels/builder/align';
import { faceFile, type FontWeight } from '../../../labels/builder/fonts';
import { cssFamilyOf, textBoxFor, textWidthIn, type FontMetrics, type LoadedFont } from '../../../labels/builder/metrics';
import {
  parseDesign, replaceElements, updateElement, type DesignV2, type ElementV2, type TextElement,
} from '../../../labels/builder/model';
import { toDots } from '../../../labels/builder/units';
import { FIELDS } from './builderTestKit';
import Canvas, { DEFAULT_VIEW, type CanvasProps, type CanvasView } from './Canvas';
import PropertiesPanel from './PropertiesPanel';

const DPI = 300;
const Z = 0.5;

function fakeAdvances(): Record<string, number> {
  const out: Record<string, number> = {};
  for (let c = 32; c < 127; c++) {
    const ch = String.fromCharCode(c);
    out[ch] = /[0-9]/.test(ch) ? 400 : /[A-Z]/.test(ch) ? 450 : /[a-z]/.test(ch) ? 400 : 300;
  }
  return out;
}

const METRICS: FontMetrics = { unitsPerEm: 1000, ascent: 750, descent: 250, advances: fakeAdvances() };

const metricsFor = vi.fn((family: string, weight: FontWeight): LoadedFont => ({
  face: null, metrics: METRICS, cssFamily: cssFamilyOf(faceFile({ family, weight })),
}));

const SAMPLES: Record<string, string> = {
  destination_rack: '14.01.07C.02.03',
  destination_ru: '23',
  asset_name: 'lvn-hm1w2-vc1-c1n7',
  serial_number: '36B7144',
  make_model: 'Dell R660',
  asset_id: '10482',
  origin_site_code: 'LVN14',
  move_date: '10/07/2026',
};

const VEGAS = (): DesignV2 => parseDesign(vegas);

function el(d: DesignV2, id: string): ElementV2 {
  const found = d.elements.find((e) => e.id === id);
  if (!found) throw new Error(`no ${id}`);
  return found;
}

/** Pointer event init at a point on the label, in inches. */
function at(xIn: number, yIn: number, extra: Record<string, unknown> = {}) {
  return { clientX: xIn * DPI * Z, clientY: yIn * DPI * Z, pointerId: 1, isPrimary: true, button: 0, ...extra };
}

interface Setup {
  design?: DesignV2;
  selection?: string[];
  view?: Partial<CanvasView>;
  samples?: Record<string, string>;
  props?: Partial<CanvasProps>;
}

function setup({ design, selection = [], view, samples = SAMPLES, props }: Setup = {}) {
  const change = vi.fn<(d: DesignV2) => void>();
  const select = vi.fn<(ids: string[]) => void>();
  const gesture = vi.fn<(phase: 'begin' | 'end') => void>();
  const onView = vi.fn<(v: CanvasView) => void>();
  function Harness() {
    const [d, setD] = useState<DesignV2>(design ?? VEGAS());
    const [sel, setSel] = useState<string[]>(selection);
    const [v, setV] = useState<CanvasView>({ ...DEFAULT_VIEW, zoom: Z, ...view });
    return (
      <Canvas design={d} dpi={DPI} view={v} samples={samples} selection={sel}
        metricsFor={metricsFor} platform="mac"
        onChange={(next) => { change(next); setD(next); }}
        onSelect={(ids) => { select(ids); setSel(ids); }}
        onGesture={gesture}
        onView={(next) => { onView(next); setV(next); }}
        {...props} />
    );
  }
  const utils = render(<Harness />);
  const svg = utils.container.querySelector('svg.lbc-label') as SVGSVGElement;
  const last = (): DesignV2 => change.mock.calls[change.mock.calls.length - 1][0];
  const node = (id: string) => utils.container.querySelector(`[data-el-id="${id}"]`) as SVGGElement;
  return { ...utils, svg, change, select, gesture, onView, last, node };
}

function click(target: Element, xIn: number, yIn: number, extra: Record<string, unknown> = {}) {
  fireEvent.pointerDown(target, at(xIn, yIn, extra));
  fireEvent.pointerUp(target, at(xIn, yIn, extra));
}

function drag(target: Element, from: [number, number], to: [number, number],
  mods: { down?: Record<string, unknown>; move?: Record<string, unknown> } = {}) {
  fireEvent.pointerDown(target, at(from[0], from[1], mods.down));
  fireEvent.pointerMove(target, at(to[0], to[1], mods.move));
  fireEvent.pointerUp(target, at(to[0], to[1], mods.move));
}

beforeAll(() => {
  // jsdom has no pointer capture
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
});

afterEach(() => {
  cleanup();
  metricsFor.mockClear();
});

describe('rendering', () => {
  it('renders every Vegas element, in the loaded face, with the sample values through the field rules', () => {
    const { container, node } = setup();
    expect(container.querySelectorAll('[data-el-id]')).toHaveLength(vegas.elements.length);
    for (const e of vegas.elements) expect(node(e.id), e.id).not.toBeNull();

    const pod = node('banner-pod').querySelector('text.lbc-text')!;
    expect(pod.textContent).toBe('07C');
    // the resident Swiss cut draws with the Roboto Condensed Bold stand-in
    expect(pod.getAttribute('font-family')).toContain('label-builder-roboto-condensed-bold');
    expect(metricsFor).toHaveBeenCalledWith('swiss721-cond-bold', 'regular');
    expect(node('banner-nap').querySelector('text.lbc-text')!.textContent).toBe('14');
    expect(node('banner-ru').querySelector('text.lbc-text')!.textContent).toBe('23');
    expect(node('caption-name').querySelector('text.lbc-text')!.textContent).toBe('Name:');

    expect(node('barcode').querySelector('.lbc-bars')).not.toBeNull();
    expect(node('barcode').querySelector('text.lbc-hri')!.textContent).toBe('10482');
    expect(node('qr').querySelector('.lbc-qr-symbol')).not.toBeNull();
    expect(node('rule').querySelector('.lbc-shape')).not.toBeNull();
    expect(node('side-site').querySelector('.lbc-frame')!.getAttribute('transform')).toContain('rotate(270)');
  });

  it('draws an inverted element as the black box plus its pad, in printer dots, with the text in white', () => {
    const { node } = setup();
    const sector = node('banner-sector');
    const box = sector.querySelector('rect.lbc-invert')!;
    // labels/zpl.py _invert_box: ^FO190,18^GB165,92
    expect(box.getAttribute('x')).toBe('190');
    expect(box.getAttribute('y')).toBe('18');
    expect(box.getAttribute('width')).toBe('165');
    expect(box.getAttribute('height')).toBe('92');
    expect(sector.classList.contains('is-inverted')).toBe(true);
  });

  it('stops the inverted block at the label\'s top and left edges, like the compiler', () => {
    const d = updateElement(VEGAS(), 'banner-sector', { x: 0.02, y: 0.01 });
    const { node } = setup({ design: d });
    const box = node('banner-sector').querySelector('rect.lbc-invert')!;
    // x 6 - pad 20 = -14 → 0, width 165 - 14 = 151; y 3 - 10 = -7 → 0, height 92 - 7 = 85
    expect(box.getAttribute('x')).toBe('0');
    expect(box.getAttribute('y')).toBe('0');
    expect(box.getAttribute('width')).toBe('151');
    expect(box.getAttribute('height')).toBe('85');
  });

  it('puts every edge on the dot the printer rounds to', () => {
    // 0.05 in at 203 DPI is 10.15 dots: the printer's 10
    function At203() {
      const [v, setV] = useState<CanvasView>({ ...DEFAULT_VIEW, zoom: Z });
      const box: ElementV2 = { id: 'b', type: 'box', x: 0.05, y: 0.05, w: 0.55, h: 0.35, rotation: 0, strokeIn: 0.01 };
      const text: TextElement = {
        id: 't', type: 'text', content: 'AB', x: 0.05, y: 0.55, w: 0.55, h: 0.15, rotation: 0,
        sizePt: 10, baselineIn: 0.1,
      };
      const design: DesignV2 = { schema: 2, size: { w: 2, h: 1 }, splits: {}, elements: [box, text] };
      return <Canvas design={design} dpi={203} view={v} onView={setV} samples={{}} selection={[]}
        metricsFor={metricsFor} platform="mac" onChange={() => {}} onSelect={() => {}} onGesture={() => {}} />;
    }
    const { container } = render(<At203 />);
    const shape = container.querySelector('[data-el-id="b"] .lbc-shape')!;
    expect(shape.getAttribute('d')).toMatch(/^M10 10h112v71h-112Z/);
    const frame = container.querySelector('[data-el-id="t"] .lbc-frame')!;
    expect(frame.getAttribute('transform')).toBe('translate(10 112)');
    const box = container.querySelector('[data-el-id="t"] rect.lbc-box')!;
    expect(box.getAttribute('width')).toBe('112');
    expect(box.getAttribute('height')).toBe('30');
    const text = container.querySelector('[data-el-id="t"] text.lbc-text')!;
    // ^FT10,132 (0.65 in = 131.95 dots); the font is round(10 × 203 / 72) = 28 dots
    expect(text.getAttribute('x')).toBe('0');
    expect(text.getAttribute('y')).toBe(String(132 - 112));
    expect(text.getAttribute('font-size')).toBe('28');
  });

  it('an inverted element with a blank value prints no box', () => {
    const { node } = setup({ samples: { ...SAMPLES, destination_rack: '14' } });
    expect(node('banner-sector').querySelector('rect.lbc-invert')).toBeNull();
    expect(node('banner-sector').classList.contains('is-hidden')).toBe(true);
  });

  it('the POD element shows its reserved width, not its sample width', () => {
    const { node } = setup();
    const pod = node('banner-pod');
    expect(Number(pod.querySelector('rect.lbc-box')!.getAttribute('width'))).toBeCloseTo(0.5 * DPI, 6);
    const sampleWidth = textWidthIn(METRICS, 24, '07C') * DPI;
    expect(sampleWidth).toBeCloseTo(125, 6);
    expect(Number(pod.querySelector('text.lbc-text')!.getAttribute('textLength'))).toBeCloseTo(sampleWidth, 6);
    expect(pod.classList.contains('is-overflow')).toBe(false);
  });

  it('shows the overflow in red past the box when the sample is wider', () => {
    const { node } = setup({ samples: { ...SAMPLES, destination_rack: '14.01.07CXXXXX.02.03' } });
    const grid = node('grid-pod');
    expect(grid.classList.contains('is-overflow')).toBe(true);
    const red = grid.querySelector('rect.lbc-overflow')!;
    expect(Number(red.getAttribute('x'))).toBe(toDots(0.1733, DPI));
    expect(Number(red.getAttribute('width'))).toBeCloseTo(textWidthIn(METRICS, 8.4, '07CXXXXX') * DPI - toDots(0.1733, DPI), 6);
    // the banner's Max characters keeps it to 07C
    expect(node('banner-pod').classList.contains('is-overflow')).toBe(false);
  });

  it('Field names shows each field and Split piece by name', () => {
    const { node, onView } = setup({ props: { fieldName: (k) => (k === 'asset_name' ? 'Name' : k) } });
    fireEvent.click(screen.getByRole('button', { name: 'Field names' }));
    expect(onView).toHaveBeenLastCalledWith(expect.objectContaining({ showSamples: false }));
    expect(node('banner-pod').querySelector('text.lbc-text')!.textContent).toBe('POD');
    expect(node('value-name').querySelector('text.lbc-text')!.textContent).toBe('Name');
    expect(screen.getByRole('button', { name: 'Field names' }).getAttribute('aria-pressed')).toBe('true');
    // a name wider than its box shrinks into it rather than spilling
    // ('Sector' is 245 dots at 24 pt; the box is 125)
    const sector = node('banner-sector');
    const text = sector.querySelector('text.lbc-text')!;
    expect(text.textContent).toBe('Sector');
    expect(Number(text.getAttribute('textLength'))).toBe(125);
    expect(Number(text.getAttribute('font-size'))).toBeCloseTo(100 * (125 / 245), 6);
    expect(sector.classList.contains('is-overflow')).toBe(false);
  });

  it('rulers count dots at the viewed DPI; grid, snap and rulers toggle', () => {
    const { container, onView } = setup();
    const top = container.querySelector('.lbc-ruler-x')!;
    const marks = Array.from(top.querySelectorAll('text')).map((t) => t.textContent);
    expect(marks).toContain('0');
    expect(marks).toContain('600');
    expect(marks).toContain('1200');
    expect(container.querySelector('.lbc-gridlines')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Grid' }));
    expect(onView).toHaveBeenLastCalledWith(expect.objectContaining({ grid: false }));
    expect(container.querySelector('.lbc-gridlines')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Rulers' }));
    expect(container.querySelector('.lbc-ruler-x')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Snap' }));
    expect(onView).toHaveBeenLastCalledWith(expect.objectContaining({ snap: false }));
    // ⌘' brings the grid back
    fireEvent.keyDown(document.body, { key: "'", code: 'Quote', metaKey: true });
    expect(container.querySelector('.lbc-gridlines')).not.toBeNull();
  });

  it('rulers follow the DPI', () => {
    function At203() {
      const [v, setV] = useState<CanvasView>({ ...DEFAULT_VIEW, zoom: Z });
      return <Canvas design={VEGAS()} dpi={203} view={v} onView={setV} samples={SAMPLES} selection={[]}
        metricsFor={metricsFor} platform="mac" onChange={() => {}} onSelect={() => {}} onGesture={() => {}} />;
    }
    const { container } = render(<At203 />);
    const marks = Array.from(container.querySelectorAll('.lbc-ruler-x text')).map((t) => t.textContent);
    expect(marks).toContain('800');
    expect(marks).not.toContain('1200');
  });
});

describe('selection', () => {
  it('click selects, ⇧-click adds and removes, a click on empty space clears', () => {
    const { svg, select } = setup();
    click(svg, 1.5, 0.2);
    expect(select).toHaveBeenLastCalledWith(['banner-pod']);
    click(svg, 0.1, 0.2, { shiftKey: true });
    expect(select).toHaveBeenLastCalledWith(['banner-pod', 'banner-nap']);
    click(svg, 1.5, 0.2, { shiftKey: true });
    expect(select).toHaveBeenLastCalledWith(['banner-nap']);
    click(svg, 2.0, 1.9);
    expect(select).toHaveBeenLastCalledWith([]);
  });

  it('a click on one element of a multi-selection selects just it', () => {
    const { svg, select } = setup({ selection: ['banner-pod', 'banner-nap'] });
    click(svg, 1.5, 0.2);
    expect(select).toHaveBeenLastCalledWith(['banner-pod']);
  });

  it('a marquee on empty space selects the three captions it touches', () => {
    const { svg, container, select } = setup();
    fireEvent.pointerDown(svg, at(0.05, 1.05));
    fireEvent.pointerMove(svg, at(0.3, 1.65));
    expect(container.querySelector('rect.lbc-marquee')).not.toBeNull();
    fireEvent.pointerUp(svg, at(0.3, 1.65));
    expect(select).toHaveBeenLastCalledWith(['grid-caption-nap', 'grid-caption-pod', 'grid-caption-rack']);
    expect(container.querySelector('rect.lbc-marquee')).toBeNull();
  });

  it('⇧-marquee adds to the selection', () => {
    const { svg, select } = setup({ selection: ['banner-pod'] });
    drag(svg, [0.05, 1.05], [0.3, 1.65], { down: { shiftKey: true }, move: { shiftKey: true } });
    expect(select).toHaveBeenLastCalledWith(
      ['banner-pod', 'grid-caption-nap', 'grid-caption-pod', 'grid-caption-rack']);
  });

  it('eight handles on one unlocked element; none on a locked one or a multi-selection', () => {
    const one = setup({ selection: ['banner-pod'] });
    expect(one.container.querySelectorAll('[data-handle]')).toHaveLength(8);
    cleanup();
    const many = setup({ selection: ['banner-pod', 'banner-nap'] });
    expect(many.container.querySelectorAll('[data-handle]')).toHaveLength(0);
    expect(many.container.querySelectorAll('rect.lbc-sel')).toHaveLength(2);
    cleanup();
    const locked = setup({ design: updateElement(VEGAS(), 'banner-pod', { locked: true }), selection: ['banner-pod'] });
    expect(locked.container.querySelectorAll('[data-handle]')).toHaveLength(0);
    expect(locked.container.querySelector('rect.lbc-sel.is-locked')).not.toBeNull();
  });

  it('Tab steps through the elements; ⌘A selects them all; Escape clears', () => {
    const { select } = setup({ selection: ['banner-nap'] });
    fireEvent.keyDown(document.body, { key: 'Tab', code: 'Tab' });
    expect(select).toHaveBeenLastCalledWith(['banner-sector']);
    fireEvent.keyDown(document.body, { key: 'Tab', code: 'Tab', shiftKey: true });
    expect(select).toHaveBeenLastCalledWith(['banner-nap']);
    fireEvent.keyDown(document.body, { key: 'a', code: 'KeyA', metaKey: true });
    expect(select).toHaveBeenLastCalledWith(vegas.elements.map((e) => e.id));
    fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' });
    expect(select).toHaveBeenLastCalledWith([]);
  });
});

describe('moving and resizing', () => {
  it('drag moves the element by the snapped delta, as one gesture', () => {
    const { svg, last, gesture } = setup();
    drag(svg, [1.5, 0.2], [1.62, 0.21]);
    // the grid is 0.05 in: 0.12 snaps to 0.1, 0.01 to 0
    expect(el(last(), 'banner-pod').x).toBeCloseTo(1.3333 + 0.1, 9);
    expect(el(last(), 'banner-pod').y).toBeCloseTo(0.0933, 9);
    expect(gesture.mock.calls).toEqual([['begin'], ['end']]);
  });

  it('without snap a drag moves in whole dots', () => {
    const { svg, last } = setup({ view: { snap: false } });
    drag(svg, [1.5, 0.2], [1.6234, 0.2]);
    expect(el(last(), 'banner-pod').x).toBeCloseTo(1.3333 + 37 / DPI, 9);
  });

  it('a click without a drag changes nothing and opens no gesture', () => {
    const { svg, change, gesture } = setup();
    click(svg, 1.5, 0.2);
    expect(change).not.toHaveBeenCalled();
    expect(gesture).not.toHaveBeenCalled();
  });

  it('⇧ locks the drag to one axis', () => {
    const { svg, last } = setup({ selection: ['banner-pod'] });
    drag(svg, [1.5, 0.2], [1.6, 0.5], { move: { shiftKey: true } });
    expect(el(last(), 'banner-pod').x).toBeCloseTo(1.3333, 9);
    expect(el(last(), 'banner-pod').y).toBeCloseTo(0.0933 + 0.3, 9);
  });

  it('moves the whole selection together and keeps it on the label', () => {
    const { svg, last } = setup({ selection: ['banner-pod', 'banner-nap'] });
    drag(svg, [1.5, 0.2], [1.0, 0.2]);
    // banner-nap starts 0.0333 from the left edge: the group stops there
    expect(el(last(), 'banner-nap').x).toBeCloseTo(0, 9);
    expect(el(last(), 'banner-pod').x).toBeCloseTo(1.3333 - 0.0333, 9);
  });

  it('⌥-drag moves a copy and leaves the original', () => {
    const { svg, last, select } = setup({ selection: ['banner-pod'] });
    drag(svg, [1.5, 0.2], [1.6, 0.2], { down: { altKey: true }, move: { altKey: true } });
    const d = last();
    expect(d.elements).toHaveLength(vegas.elements.length + 1);
    expect(el(d, 'banner-pod').x).toBeCloseTo(1.3333, 9);
    const copy = d.elements[d.elements.length - 1];
    expect(copy.type).toBe('field');
    expect(copy.x).toBeCloseTo(1.4333, 9);
    expect(select).toHaveBeenLastCalledWith([copy.id]);
  });

  it('a locked element stays put', () => {
    const { svg, change } = setup({ design: updateElement(VEGAS(), 'banner-pod', { locked: true }) });
    drag(svg, [1.5, 0.2], [1.8, 0.4]);
    expect(change).not.toHaveBeenCalled();
  });

  it('a resize handle resizes the element, as one gesture', () => {
    const { container, last, gesture } = setup({ selection: ['value-name'] });
    const handle = container.querySelector('[data-handle="e"]')!;
    const v = el(VEGAS(), 'value-name');
    drag(handle, [v.x + v.w, v.y + v.h / 2], [v.x + v.w + 0.2, v.y + v.h / 2]);
    expect(el(last(), 'value-name').w).toBeCloseTo(2.6667 + 0.2, 9);
    expect(el(last(), 'value-name').h).toBeCloseTo(0.084, 9);
    expect(gesture.mock.calls).toEqual([['begin'], ['end']]);
  });

  it('⇧ on a corner handle keeps the proportions', () => {
    const box: ElementV2 = { id: 'b', type: 'box', x: 1, y: 0.5, w: 1, h: 0.5, rotation: 0, strokeIn: 0.01 };
    const design: DesignV2 = { schema: 2, size: { w: 4, h: 2 }, splits: {}, elements: [box] };
    const { container, last } = setup({ design, selection: ['b'] });
    drag(container.querySelector('[data-handle="se"]')!, [2, 1], [2.5, 1.05], { move: { shiftKey: true } });
    expect(el(last(), 'b').w).toBeCloseTo(1.5, 9);
    expect(el(last(), 'b').h).toBeCloseTo(0.75, 9);
  });

  it('arrow keys nudge by one dot, ⇧ by ten; a held arrow is one gesture', () => {
    const { last, gesture } = setup({ selection: ['banner-pod'] });
    fireEvent.keyDown(document.body, { key: 'ArrowRight', code: 'ArrowRight' });
    fireEvent.keyDown(document.body, { key: 'ArrowRight', code: 'ArrowRight', repeat: true });
    fireEvent.keyUp(document.body, { key: 'ArrowRight', code: 'ArrowRight' });
    expect(el(last(), 'banner-pod').x).toBeCloseTo(1.3333 + 2 / DPI, 9);
    expect(gesture.mock.calls).toEqual([['begin'], ['end']]);
    fireEvent.keyDown(document.body, { key: 'ArrowDown', code: 'ArrowDown', shiftKey: true });
    fireEvent.keyUp(document.body, { key: 'ArrowDown', code: 'ArrowDown', shiftKey: true });
    expect(el(last(), 'banner-pod').y).toBeCloseTo(0.0933 + 10 / DPI, 9);
  });

  it('⌥ arrows resize by a dot', () => {
    const { last } = setup({ selection: ['value-name'] });
    fireEvent.keyDown(document.body, { key: 'ArrowRight', code: 'ArrowRight', altKey: true });
    expect(el(last(), 'value-name').w).toBeCloseTo(2.6667 + 1 / DPI, 9);
  });

  it('arrow keys are left alone while typing in a box', () => {
    const { change } = setup({ selection: ['banner-pod'] });
    const input = document.createElement('input');
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: 'ArrowRight', code: 'ArrowRight' });
    input.remove();
    expect(change).not.toHaveBeenCalled();
  });

  it('Delete removes the selection; ⌘D duplicates it', () => {
    const { last, select } = setup({ selection: ['banner-pod'] });
    fireEvent.keyDown(document.body, { key: 'd', code: 'KeyD', metaKey: true });
    expect(last().elements).toHaveLength(vegas.elements.length + 1);
    const copy = last().elements[last().elements.length - 1];
    expect(select).toHaveBeenLastCalledWith([copy.id]);
    fireEvent.keyDown(document.body, { key: 'Backspace', code: 'Backspace' });
    expect(last().elements).toHaveLength(vegas.elements.length);
    expect(last().elements.some((e) => e.id === copy.id)).toBe(false);
    expect(select).toHaveBeenLastCalledWith([]);
  });
});

describe('align', () => {
  const selected = ['banner-pod', 'banner-nap', 'banner-rack'];

  it('the align buttons run align over the selection', () => {
    const { last } = setup({ selection: selected });
    fireEvent.click(screen.getByRole('button', { name: 'Align left' }));
    const d = VEGAS();
    const expected = replaceElements(d, align(selected.map((id) => el(d, id)), 'left', d.size));
    expect(last()).toEqual(expected);
    for (const id of selected) expect(el(last(), id).x).toBeCloseTo(0.0333, 9);
  });

  it('one element aligns to the label', () => {
    const { last } = setup({ selection: ['banner-pod'] });
    fireEvent.click(screen.getByRole('button', { name: 'Align right' }));
    expect(el(last(), 'banner-pod').x).toBeCloseTo(4 - 0.5, 9);
  });

  it('distribute needs three, match needs two', () => {
    setup({ selection: ['banner-pod', 'banner-nap'] });
    expect((screen.getByRole('button', { name: 'Distribute horizontally' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Match width' }) as HTMLButtonElement).disabled).toBe(false);
    cleanup();
    setup();
    expect((screen.getByRole('button', { name: 'Align left' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('⌥A aligns left from the keyboard', () => {
    const { last } = setup({ selection: selected });
    fireEvent.keyDown(document.body, { key: 'å', code: 'KeyA', altKey: true });
    for (const id of selected) expect(el(last(), id).x).toBeCloseTo(0.0333, 9);
  });
});

describe('view', () => {
  it('zoom steps, 1:1 and fit', () => {
    const { onView } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    const zoomed = onView.mock.calls[onView.mock.calls.length - 1][0].zoom;
    expect(typeof zoomed === 'number' && zoomed > Z).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(onView).toHaveBeenLastCalledWith(expect.objectContaining({ zoom: Z }));
    fireEvent.click(screen.getByRole('button', { name: 'True size' }));
    expect(onView).toHaveBeenLastCalledWith(expect.objectContaining({ zoom: 1 }));
    fireEvent.click(screen.getByRole('button', { name: 'Fit' }));
    expect(onView).toHaveBeenLastCalledWith(expect.objectContaining({ zoom: 'fit' }));
    fireEvent.keyDown(document.body, { key: ')', code: 'Digit0', shiftKey: true });
    expect(onView).toHaveBeenLastCalledWith(expect.objectContaining({ zoom: 1 }));
  });

  it('the canvas is in dots at zoom px per dot', () => {
    const { svg } = setup();
    expect(svg.getAttribute('viewBox')).toBe('0 0 1200 600');
    expect(svg.getAttribute('width')).toBe(String(1200 * Z));
    expect(svg.getAttribute('height')).toBe(String(600 * Z));
  });

  it('⌘-wheel zooms; a plain wheel pans', () => {
    const { container, svg, onView } = setup();
    const stage = container.querySelector('.lbc-stage')!;
    act(() => {
      stage.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, metaKey: true, bubbles: true, cancelable: true }));
    });
    const zoomed = onView.mock.calls[onView.mock.calls.length - 1][0].zoom;
    expect(typeof zoomed === 'number' && zoomed > Z).toBe(true);
    const before = svg.style.left;
    act(() => {
      stage.dispatchEvent(new WheelEvent('wheel', { deltaX: 40, bubbles: true, cancelable: true }));
    });
    expect(svg.style.left).not.toBe(before);
  });

  it('space-drag pans without touching the selection or the design', () => {
    const { svg, select, change } = setup();
    const before = svg.style.left;
    fireEvent.keyDown(document.body, { key: ' ', code: 'Space' });
    drag(svg, [1.5, 0.2], [1.8, 0.2]);
    fireEvent.keyUp(document.body, { key: ' ', code: 'Space' });
    expect(select).not.toHaveBeenCalled();
    expect(change).not.toHaveBeenCalled();
    expect(svg.style.left).not.toBe(before);
  });
});

describe('tools', () => {
  it('a tool places its element where clicked, selects it and goes back to Select', () => {
    const { svg, last, select } = setup();
    fireEvent.keyDown(document.body, { key: 'r', code: 'KeyR' });
    const tools = screen.getByRole('group', { name: 'Tools' });
    expect(within(tools).getByRole('button', { name: 'Box' }).getAttribute('aria-pressed')).toBe('true');
    click(svg, 2.02, 0.88);
    const box = last().elements[last().elements.length - 1];
    expect(box.type).toBe('box');
    // snapped to the 0.05 in grid
    expect(box.x).toBeCloseTo(2.0, 9);
    expect(box.y).toBeCloseTo(0.9, 9);
    expect(select).toHaveBeenLastCalledWith([box.id]);
    expect(within(tools).getByRole('button', { name: 'Select' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('new text is one line of its font tall', () => {
    const { svg, last } = setup();
    fireEvent.click(within(screen.getByRole('group', { name: 'Tools' })).getByRole('button', { name: 'Text' }));
    click(svg, 1, 1.9);
    const text = last().elements[last().elements.length - 1];
    expect(text.type).toBe('text');
    const box = textBoxFor(METRICS, 12);
    expect(text.h).toBeCloseTo(box.h, 9);
    expect(text.type === 'text' && text.baselineIn).toBeCloseTo(box.baselineIn, 9);
  });

  it('read-only allows selecting but no edits', () => {
    const { svg, container, change, select } = setup({ selection: ['banner-pod'], props: { readOnly: true } });
    expect(container.querySelectorAll('[data-handle]')).toHaveLength(0);
    drag(svg, [1.5, 0.2], [1.8, 0.4]);
    fireEvent.keyDown(document.body, { key: 'ArrowRight', code: 'ArrowRight' });
    expect(change).not.toHaveBeenCalled();
    click(svg, 0.1, 0.2);
    expect(select).toHaveBeenLastCalledWith(['banner-nap']);
  });
});

describe('space', () => {
  it('Space on a button the keyboard reached presses it rather than starting a pan', () => {
    setup();
    const grid = screen.getByRole('button', { name: 'Grid' });
    grid.focus();
    expect(fireEvent.keyDown(grid, { key: ' ', code: 'Space' })).toBe(true);
    expect(fireEvent.keyDown(document.body, { key: ' ', code: 'Space' })).toBe(false);
    fireEvent.keyUp(document.body, { key: ' ', code: 'Space' });
  });
});

/** A design on its own at `dpi`, no interaction. */
function renderDesign(design: DesignV2, dpi: number) {
  function Alone() {
    const [v, setV] = useState<CanvasView>({ ...DEFAULT_VIEW, zoom: Z });
    return <Canvas design={design} dpi={dpi} view={v} onView={setV} samples={{}} selection={[]}
      metricsFor={metricsFor} platform="mac" onChange={() => {}} onSelect={() => {}} onGesture={() => {}} />;
  }
  return render(<Alone />);
}

describe('rotation', () => {
  /** labels/zpl.py _origin: the ^FT point, the start of the baseline. */
  function ft(t: TextElement, dpi: number): [number, number] {
    const { x, y, w, h, baselineIn: b } = t;
    const pos = t.rotation === 90 ? [x + h - b, y] : t.rotation === 180 ? [x + w, y + h - b]
      : t.rotation === 270 ? [x + b, y + w] : [x, y + b];
    return [toDots(pos[0], dpi), toDots(pos[1], dpi)];
  }

  /** Where the frame's transform puts the text's (x, y) on the label. */
  function placed(frame: Element, text: Element): [number, number] {
    const m = /^translate\(([-\d.]+) ([-\d.]+)\)(?: rotate\((\d+)\))?$/.exec(frame.getAttribute('transform')!)!;
    const [tx, ty, r] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
    const u = Number(text.getAttribute('x'));
    const v = Number(text.getAttribute('y'));
    const a = (r * Math.PI) / 180;
    return [tx + u * Math.cos(a) - v * Math.sin(a), ty + u * Math.sin(a) + v * Math.cos(a)];
  }

  it.each([0, 90, 180, 270] as const)('at %i° the baseline starts on the compiler\'s ^FT origin', (rotation) => {
    const t: TextElement = {
      id: 't', type: 'text', content: 'AB', x: 0.517, y: 0.333, w: 0.611, h: 0.153, rotation,
      sizePt: 10, baselineIn: 0.117,
    };
    const { container } = renderDesign({ schema: 2, size: { w: 2, h: 1.5 }, splits: {}, elements: [t] }, 203);
    const frame = container.querySelector('[data-el-id="t"] .lbc-frame')!;
    const [x, y] = placed(frame, container.querySelector('[data-el-id="t"] text.lbc-text')!);
    const [fx, fy] = ft(t, 203);
    expect(x).toBeCloseTo(fx, 6);
    expect(y).toBeCloseTo(fy, 6);
  });
});

describe('a value typed into a box, then a press on the stage', () => {
  // the stage takes focus on pointerdown, which commits the box's draft
  // (blur) into the page's design before the press does anything with it
  function withPanel(selection: string[]) {
    const change = vi.fn<(d: DesignV2) => void>();
    function Harness() {
      const [d, setD] = useState<DesignV2>(VEGAS());
      const [sel, setSel] = useState<string[]>(selection);
      const onChange = (next: DesignV2) => { change(next); setD(next); };
      return (
        <>
          <Canvas design={d} dpi={DPI} view={{ ...DEFAULT_VIEW, zoom: Z }} samples={SAMPLES} selection={sel}
            metricsFor={metricsFor} platform="mac" onChange={onChange} onSelect={setSel}
            onGesture={() => {}} onView={() => {}} />
          <PropertiesPanel design={d} selection={sel} samples={SAMPLES} fields={FIELDS} dpi={DPI}
            metricsFor={metricsFor} onChange={onChange} onSelect={setSel} />
        </>
      );
    }
    const utils = render(<Harness />);
    const svg = utils.container.querySelector('svg.lbc-label') as SVGSVGElement;
    const last = (): DesignV2 => change.mock.calls[change.mock.calls.length - 1][0];
    /** Types `value` into the box and leaves it there, uncommitted. */
    const draft = (name: string, value: string) => {
      const box = screen.getByRole('textbox', { name });
      act(() => box.focus());
      fireEvent.change(box, { target: { value } });
      expect(change).not.toHaveBeenCalled();
    };
    return { ...utils, svg, change, last, draft };
  }

  it('a drag keeps the typed value and moves on top of it', () => {
    const { svg, last, draft } = withPanel(['banner-pod']);
    draft('X', '+15');                                       // 400 → 415 dots
    drag(svg, [1.5, 0.2], [1.62, 0.2]);                      // snapped: +0.1 in
    expect(el(last(), 'banner-pod').x).toBeCloseTo(415 / DPI + 0.1, 9);
  });

  it('a handle drag resizes the box as typed', () => {
    const { container, last, draft } = withPanel(['value-name']);
    const v = el(VEGAS(), 'value-name');
    draft('X', '+15');                                       // 185 → 200 dots
    drag(container.querySelector('[data-handle="e"]')!, [v.x + v.w, v.y + v.h / 2], [v.x + v.w + 0.2, v.y + v.h / 2]);
    expect(el(last(), 'value-name').x).toBeCloseTo(200 / DPI, 9);
    expect(el(last(), 'value-name').w).toBeCloseTo(2.6667 + 0.2, 9);
  });

  it('a tool places its element on the design as typed', () => {
    const { svg, last, draft } = withPanel(['banner-pod']);
    fireEvent.click(within(screen.getByRole('group', { name: 'Tools' })).getByRole('button', { name: 'Box' }));
    draft('X', '+15');
    click(svg, 2.02, 0.88);
    const d = last();
    expect(d.elements[d.elements.length - 1].type).toBe('box');
    expect(el(d, 'banner-pod').x).toBeCloseTo(415 / DPI, 9);
  });
});

describe('gesture hygiene', () => {
  it('pointercancel ends a drag\'s gesture', () => {
    const { svg, gesture, select } = setup({ selection: ['banner-pod', 'banner-nap'] });
    fireEvent.pointerDown(svg, at(1.5, 0.2));
    fireEvent.pointerMove(svg, at(1.6, 0.2));
    fireEvent.pointerCancel(svg, at(1.6, 0.2));
    expect(gesture.mock.calls).toEqual([['begin'], ['end']]);
    expect(select).not.toHaveBeenCalled();
  });

  it('pointercancel places nothing and keeps the tool', () => {
    const { svg, change } = setup();
    const tools = within(screen.getByRole('group', { name: 'Tools' }));
    fireEvent.click(tools.getByRole('button', { name: 'Box' }));
    fireEvent.pointerDown(svg, at(2, 1));
    fireEvent.pointerCancel(svg, at(2, 1));
    expect(change).not.toHaveBeenCalled();
    expect(tools.getByRole('button', { name: 'Box' }).getAttribute('aria-pressed')).toBe('true');
    click(svg, 2, 1);
    expect(change).toHaveBeenCalledTimes(1);
    expect(tools.getByRole('button', { name: 'Select' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('pointercancel never click-selects', () => {
    const { svg, select } = setup({ selection: ['banner-pod', 'banner-nap'] });
    fireEvent.pointerDown(svg, at(1.5, 0.2));
    fireEvent.pointerCancel(svg, at(1.5, 0.2));
    expect(select).not.toHaveBeenCalled();
  });

  it('pointercancel drops a marquee instead of selecting with it', () => {
    const { svg, container, select } = setup({ selection: ['banner-pod'] });
    fireEvent.pointerDown(svg, at(0.05, 1.05, { shiftKey: true }));
    fireEvent.pointerMove(svg, at(0.3, 1.65, { shiftKey: true }));
    fireEvent.pointerCancel(svg, at(3.9, 1.95, { shiftKey: true }));
    expect(select).not.toHaveBeenCalled();
    expect(container.querySelector('rect.lbc-marquee')).toBeNull();
  });

  it('a second pointer mid-drag is ignored', () => {
    const { svg, gesture, select, change, last } = setup();
    fireEvent.pointerDown(svg, at(1.5, 0.2));
    fireEvent.pointerMove(svg, at(1.62, 0.2));
    // would clear the selection and start a marquee, then move the drag
    fireEvent.pointerDown(svg, at(2.0, 1.9, { pointerId: 2 }));
    fireEvent.pointerMove(svg, at(3.0, 1.9, { pointerId: 2 }));
    fireEvent.pointerUp(svg, at(3.0, 1.9, { pointerId: 2 }));
    expect(el(last(), 'banner-pod').x).toBeCloseTo(1.4333, 9);
    fireEvent.pointerUp(svg, at(1.62, 0.2));
    expect(select.mock.calls).toEqual([[['banner-pod']]]);
    expect(change).toHaveBeenCalledTimes(1);
    expect(gesture.mock.calls).toEqual([['begin'], ['end']]);
  });

  it('a pointer that is not the primary one starts nothing', () => {
    const { svg, select } = setup();
    click(svg, 1.5, 0.2, { isPrimary: false, pointerId: 3 });
    expect(select).not.toHaveBeenCalled();
  });

  it('unmounting mid-arrow-hold ends the key gesture', () => {
    const { gesture, unmount } = setup({ selection: ['banner-pod'] });
    fireEvent.keyDown(document.body, { key: 'ArrowRight', code: 'ArrowRight' });
    expect(gesture.mock.calls).toEqual([['begin']]);
    unmount();
    expect(gesture.mock.calls).toEqual([['begin'], ['end']]);
  });

  it('unmounting mid-drag ends the drag gesture', () => {
    const { svg, gesture, unmount } = setup();
    fireEvent.pointerDown(svg, at(1.5, 0.2));
    fireEvent.pointerMove(svg, at(1.62, 0.2));
    unmount();
    expect(gesture.mock.calls).toEqual([['begin'], ['end']]);
  });

  it('⌥-drag copies only the unlocked elements, and nothing when all are locked', () => {
    const one = setup({ design: updateElement(VEGAS(), 'banner-nap', { locked: true }), selection: ['banner-pod', 'banner-nap'] });
    drag(one.svg, [1.5, 0.2], [1.6, 0.2], { down: { altKey: true }, move: { altKey: true } });
    const d = one.last();
    expect(d.elements).toHaveLength(vegas.elements.length + 1);
    const copy = d.elements[d.elements.length - 1];
    expect(copy.type === 'field' && copy.piece).toBe(2);
    expect(copy.x).toBeCloseTo(1.4333, 9);
    expect(one.select).toHaveBeenLastCalledWith([copy.id]);
    cleanup();
    const all = setup({ design: updateElement(VEGAS(), 'banner-pod', { locked: true }), selection: ['banner-pod'] });
    drag(all.svg, [1.5, 0.2], [1.6, 0.2], { down: { altKey: true }, move: { altKey: true } });
    expect(all.change).not.toHaveBeenCalled();
    expect(all.select).not.toHaveBeenCalled();
  });
});

describe('multi-line text', () => {
  it('marks each spilling line on its own line', () => {
    const t: TextElement = {
      id: 't', type: 'text', content: 'AAAA BBBBBBBBBBBB', x: 0.1, y: 0.1, w: 0.3, h: 0.25, rotation: 0,
      sizePt: 12, baselineIn: 0.125, lines: 2,
    };
    const { container } = renderDesign({ schema: 2, size: { w: 2, h: 1 }, splits: {}, elements: [t] }, 300);
    const texts = container.querySelectorAll('[data-el-id="t"] text.lbc-text');
    expect(Array.from(texts, (n) => n.textContent)).toEqual(['AAAA', 'BBBBBBBBBBBB']);
    const red = container.querySelectorAll('[data-el-id="t"] rect.lbc-overflow');
    expect(red).toHaveLength(1);
    // the second line: one font height (round(12 × 300 / 72) = 50 dots) below the first, one tall
    expect(red[0].getAttribute('y')).toBe('50');
    expect(red[0].getAttribute('height')).toBe('50');
  });
});

// @vitest-environment jsdom
/**
 * An image element on the canvas (spec 2026-10-20-badge-templates §4.3,
 * §4.5, §4.12): the server's gray picture (POST /labels/images/raster,
 * mocked at lib/api.ts labelImageRaster: null is its 404 `no_image`) dithered by dither.ts and painted dot for dot into an SVG
 * <image> at the footprint, pixelated, white left transparent; a dashed
 * placeholder named Photo, Logo or Image when there is no picture, and the
 * 2-dot outline the printer prints when hide-when-empty is off.
 *
 * jsdom has no 2D canvas: the tests stand in a context that records the
 * ImageData each picture is painted with, and never read pixels back.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ditherBitmap } from '../../../labels/builder/dither';
import { bitsToRgba } from '../../../labels/builder/image';
import { imageParams, type ImageElement } from '../../../labels/builder/model';

const api = vi.hoisted(() => ({ labelImageRaster: vi.fn() }));
vi.mock('../../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../../lib/api')>()), ...api,
}));

const { ApiError } = await import('../../../lib/api');
const { default: CanvasElement } = await import('./CanvasElement');
const { clearRasterCache, RASTER_DEBOUNCE_MS } = await import('./imageRaster');

const DPI = 300;
const PERSON = '0b7f3c52-6a2e-4c41-9d1e-3f2a9b8c7d10';

interface Painted { width: number; height: number; data: Uint8ClampedArray }
let painted: Painted[] = [];

/** A w x h gray picture: a ramp with some texture, so dithering shows. */
function picture(w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = ((i % w) * 255 / Math.max(1, w - 1) + (i % 7) * 9) & 0xff;
  return out;
}

function photo(over: Partial<ImageElement> = {}): ImageElement {
  return { id: 'image-1', type: 'image', source: 'photo', fit: 'cover', mode: 'dither', x: 0.1, y: 0.2, w: 0.8, h: 1,
    rotation: 0, hideWhenEmpty: true, ...over };
}

function draw(el: ImageElement, opts: { personId?: string | null; names?: boolean; dpi?: number } = {}) {
  const props = (e: ImageElement) => (
    <svg>
      <CanvasElement el={e} dpi={opts.dpi ?? DPI} text="" names={opts.names ?? false} hidden={false} font={null}
        value="" px={1} uid="t" personId={opts.personId === undefined ? PERSON : opts.personId} />
    </svg>
  );
  const utils = render(props(el));
  const image = () => utils.container.querySelector('image.lbc-image');
  return { ...utils, image, redraw: (e: ImageElement) => utils.rerender(props(e)) };
}

/** The bits as the canvas paints them. */
const expected = (gray: Uint8Array, w: number, h: number, el: ImageElement) =>
  Array.from(bitsToRgba(ditherBitmap(gray, w, h, imageParams(el)), w, h));

beforeEach(() => {
  clearRasterCache();
  painted = [];
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    createImageData: (width: number, height: number) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
    putImageData: (img: Painted) => { painted.push({ ...img, data: new Uint8ClampedArray(img.data) }); },
    getImageData: () => { throw new Error('the canvas never reads pixels back'); },
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.toDataURL = vi.fn(() => `data:image/png;base64,picture-${painted.length}`);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('an image with a picture', () => {
  it('asks for the sample person’s photo at its box and draws exactly the bits dither.ts gives', async () => {
    const gray = picture(240, 300);
    api.labelImageRaster.mockResolvedValue({ width: 240, height: 300, gray });
    const el = photo();
    const { image } = draw(el);
    await waitFor(() => expect(image()).not.toBeNull());
    expect(api.labelImageRaster).toHaveBeenCalledTimes(1);
    expect(api.labelImageRaster).toHaveBeenCalledWith({
      source: 'photo', person_id: PERSON, w_in: 0.8, h_in: 1, dpi: DPI, fit: 'cover', rotation: 0,
    });
    expect(painted).toHaveLength(1);
    expect(painted[0]).toMatchObject({ width: 240, height: 300 });
    expect(Array.from(painted[0].data)).toEqual(expected(gray, 240, 300, el));
    const img = image()!;
    // at the footprint's top-left, one dot a pixel, pixelated
    expect([img.getAttribute('x'), img.getAttribute('y')]).toEqual(['30', '60']);
    expect([img.getAttribute('width'), img.getAttribute('height')]).toEqual(['240', '300']);
    expect(img.getAttribute('href')).toBe('data:image/png;base64,picture-1');
    expect(img.getAttribute('style')).toContain('image-rendering: pixelated');
    expect(img.getAttribute('preserveAspectRatio')).toBe('none');
  });

  it('paints black dots opaque and white ones transparent', async () => {
    const gray = new Uint8Array(240 * 300).fill(255);
    gray[0] = 0;
    api.labelImageRaster.mockResolvedValue({ width: 240, height: 300, gray });
    const { image } = draw(photo({ mode: 'threshold' }));
    await waitFor(() => expect(image()).not.toBeNull());
    const alpha = Array.from({ length: 240 * 300 }, (_, i) => painted[0].data[i * 4 + 3]);
    expect(alpha[0]).toBe(255);
    expect(alpha.slice(1).every((a) => a === 0)).toBe(true);
  });

  it('turned 90, draws the turned picture over the swapped footprint', async () => {
    const gray = picture(300, 240);
    api.labelImageRaster.mockResolvedValue({ width: 300, height: 240, gray });
    const el = photo({ rotation: 90 });
    const { image } = draw(el);
    await waitFor(() => expect(image()).not.toBeNull());
    expect(api.labelImageRaster.mock.calls[0][0]).toMatchObject({ w_in: 0.8, h_in: 1, rotation: 90 });
    expect([image()!.getAttribute('width'), image()!.getAttribute('height')]).toEqual(['300', '240']);
    expect(Array.from(painted[0].data)).toEqual(expected(gray, 300, 240, el));
  });

  // the box in whole dots as the compiler rounds it, turned with the element:
  // 0.1, 0.2, 0.8 x 1 in at 203 is (20, 41) 162 x 203; at 600, (60, 120) 480 x 600
  it.each([
    [203, 0, { x: '20', y: '41', w: 162, h: 203 }],
    [203, 90, { x: '20', y: '41', w: 203, h: 162 }],
    [600, 0, { x: '60', y: '120', w: 480, h: 600 }],
    [600, 90, { x: '60', y: '120', w: 600, h: 480 }],
  ] as const)('at %i DPI turned %i, draws the picture dot for dot over its footprint', async (dpi, rotation, box) => {
    const gray = picture(box.w, box.h);
    api.labelImageRaster.mockResolvedValue({ width: box.w, height: box.h, gray });
    const el = photo({ rotation });
    const { image } = draw(el, { dpi });
    await waitFor(() => expect(image()).not.toBeNull());
    expect(api.labelImageRaster).toHaveBeenCalledWith({
      source: 'photo', person_id: PERSON, w_in: 0.8, h_in: 1, dpi, fit: 'cover', rotation,
    });
    const img = image()!;
    expect([img.getAttribute('x'), img.getAttribute('y')]).toEqual([box.x, box.y]);
    expect([img.getAttribute('width'), img.getAttribute('height')]).toEqual([`${box.w}`, `${box.h}`]);
    expect(painted[0]).toMatchObject({ width: box.w, height: box.h });
    expect(Array.from(painted[0].data)).toEqual(expected(gray, box.w, box.h, el));
  });

  it('Brightness and Contrast change the bits drawn, from the same picture (no new request)', async () => {
    const gray = picture(240, 300);
    api.labelImageRaster.mockResolvedValue({ width: 240, height: 300, gray });
    const { image, redraw } = draw(photo());
    await waitFor(() => expect(painted).toHaveLength(1));
    const brighter = photo({ brightness: 40 });
    redraw(brighter);
    await waitFor(() => expect(painted).toHaveLength(2));
    expect(Array.from(painted[1].data)).toEqual(expected(gray, 240, 300, brighter));
    expect(Array.from(painted[1].data)).not.toEqual(Array.from(painted[0].data));
    const flatter = photo({ brightness: 40, contrast: 30 });
    redraw(flatter);
    await waitFor(() => expect(painted).toHaveLength(3));
    expect(Array.from(painted[2].data)).toEqual(expected(gray, 240, 300, flatter));
    expect(image()!.getAttribute('href')).toBe('data:image/png;base64,picture-3');
    expect(api.labelImageRaster).toHaveBeenCalledTimes(1);
  });

  it('waits 250 ms of quiet before asking again while it is resized', async () => {
    vi.useFakeTimers();
    api.labelImageRaster.mockImplementation(async (body: { w_in: number; h_in: number }) => {
      const w = Math.round(body.w_in * DPI);
      const h = Math.round(body.h_in * DPI);
      return { width: w, height: h, gray: picture(w, h) };
    });
    const { image, redraw } = draw(photo());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(image()).not.toBeNull();
    expect(api.labelImageRaster).toHaveBeenCalledTimes(1);
    redraw(photo({ w: 0.9 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    redraw(photo({ w: 1 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(RASTER_DEBOUNCE_MS - 1); });
    expect(api.labelImageRaster).toHaveBeenCalledTimes(1);
    // the old picture stays up meanwhile, stretched over the new box
    expect(image()!.getAttribute('width')).toBe('300');
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(api.labelImageRaster).toHaveBeenCalledTimes(2);
    expect(api.labelImageRaster.mock.calls[1][0]).toMatchObject({ w_in: 1, h_in: 1 });
    expect(image()!.getAttribute('width')).toBe('300');
    expect(image()!.getAttribute('height')).toBe('300');
    // back to a size it has: from the cache, at once
    redraw(photo());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(image()!.getAttribute('width')).toBe('240');
    expect(api.labelImageRaster).toHaveBeenCalledTimes(2);
  });

  it('a static image is drawn in Field names too; a photo is not', async () => {
    api.labelImageRaster.mockResolvedValue({ width: 300, height: 150, gray: picture(300, 150) });
    const { image } = draw(photo({ source: 'static', imageId: 'img-1', w: 1, h: 0.5, fit: 'contain', mode: 'threshold' }),
      { names: true, personId: null });
    await waitFor(() => expect(image()).not.toBeNull());
    expect(api.labelImageRaster).toHaveBeenCalledWith({
      source: 'static', image_id: 'img-1', w_in: 1, h_in: 0.5, dpi: DPI, fit: 'contain', rotation: 0,
    });
    cleanup();
    draw(photo(), { names: true });
    expect(screen.getByText('Photo')).toBeTruthy();
    expect(api.labelImageRaster).toHaveBeenCalledTimes(1);
  });
});

describe('an image without a picture', () => {
  it('with no sample person: a dashed placeholder named Photo, and no request', () => {
    const { container, image } = draw(photo(), { personId: null });
    expect(api.labelImageRaster).not.toHaveBeenCalled();
    expect(image()).toBeNull();
    expect(screen.getByText('Photo')).toBeTruthy();
    const box = container.querySelector('rect.lbc-image-placeholder')!;
    expect(box.getAttribute('stroke-dasharray')).toBeTruthy();
    expect([box.getAttribute('x'), box.getAttribute('y'), box.getAttribute('width'), box.getAttribute('height')])
      .toEqual(['30', '60', '240', '300']);
    // nothing prints: no outline
    expect(container.querySelector('.lbc-image-outline')).toBeNull();
  });

  it('names a logo and a static image with none picked', () => {
    draw(photo({ source: 'logo' }), { personId: null });
    expect(screen.getByText('Logo')).toBeTruthy();
    cleanup();
    draw(photo({ source: 'static' }));
    expect(screen.getByText('Image')).toBeTruthy();
    expect(api.labelImageRaster).not.toHaveBeenCalled();
  });

  it('turned 90, the placeholder covers the swapped footprint', () => {
    const { container } = draw(photo({ rotation: 90 }), { personId: null });
    const box = container.querySelector('rect.lbc-image-placeholder')!;
    expect([box.getAttribute('width'), box.getAttribute('height')]).toEqual(['300', '240']);
  });

  it('the person has no photo (no_image): the placeholder; hide-when-empty off draws the 2-dot outline that prints', async () => {
    api.labelImageRaster.mockResolvedValue(null);
    const { container } = draw(photo({ hideWhenEmpty: false }));
    await waitFor(() => expect(api.labelImageRaster).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector('.lbc-image-outline')).not.toBeNull());
    expect(screen.getByText('Photo')).toBeTruthy();
    // the ^GB outline: 240 x 300 dots at (30, 60), 2 dots thick
    expect(container.querySelector('.lbc-image-outline')!.getAttribute('d'))
      .toBe('M30 60h240v300h-240ZM32 62v296h236v-296Z');
    expect(painted).toHaveLength(0);
  });

  it('a request that fails: the placeholder, saying so', async () => {
    api.labelImageRaster.mockRejectedValue(new Error('boom'));
    const { container } = draw(photo());
    await waitFor(() => expect(container.querySelector('title')?.textContent)
      .toBe('Couldn’t load the picture. Try again in a moment.'));
    expect(screen.getByText('Photo')).toBeTruthy();
  });

  it.each([
    [422, 'image_too_large', 'Image too large at this DPI.'],
    [422, 'unreadable_image', 'Can’t read this image.'],
    [422, 'person_not_found', 'The sample person is no longer on file.'],
    [422, 'bad_field', 'Can’t draw this image.'],
    [502, 'storage_unavailable', 'Images unavailable right now.'],
  ])('a %i %s says so on the placeholder', async (status, code, text) => {
    api.labelImageRaster.mockRejectedValue(new ApiError(status, code));
    const { container } = draw(photo());
    await waitFor(() => expect(container.querySelector('title')?.textContent).toBe(text));
    expect(container.querySelector('rect.lbc-image-placeholder.is-error')).not.toBeNull();
  });

  it('a request that fails, with hide-when-empty off: the 2-dot outline still shows, as it prints', async () => {
    api.labelImageRaster.mockRejectedValue(new ApiError(422, 'unreadable_image'));
    const { container } = draw(photo({ hideWhenEmpty: false }));
    await waitFor(() => expect(container.querySelector('title')?.textContent).toBe('Can’t read this image.'));
    expect(container.querySelector('.lbc-image-outline')!.getAttribute('d'))
      .toBe('M30 60h240v300h-240ZM32 62v296h236v-296Z');
    cleanup();
    // hide-when-empty on: nothing prints there, no outline
    const hidden = draw(photo());
    await waitFor(() => expect(hidden.container.querySelector('title')?.textContent).toBe('Can’t read this image.'));
    expect(hidden.container.querySelector('.lbc-image-outline')).toBeNull();
  });

  it('a failure is never kept: the element’s next change asks again, and only then', async () => {
    api.labelImageRaster.mockRejectedValueOnce(new ApiError(502, 'storage_unavailable'));
    api.labelImageRaster.mockResolvedValue({ width: 240, height: 300, gray: picture(240, 300) });
    const { container, image, redraw } = draw(photo());
    await waitFor(() => expect(container.querySelector('title')?.textContent).toBe('Images unavailable right now.'));
    // no retry on its own
    await new Promise((r) => { setTimeout(r, RASTER_DEBOUNCE_MS + 50); });
    expect(api.labelImageRaster).toHaveBeenCalledTimes(1);
    redraw(photo({ brightness: 5 }));
    await waitFor(() => expect(image()).not.toBeNull());
    expect(api.labelImageRaster).toHaveBeenCalledTimes(2);
    expect(container.querySelector('title')).toBeNull();
  });

  it('settings out of range draw no bits and say why', async () => {
    api.labelImageRaster.mockResolvedValue({ width: 240, height: 300, gray: picture(240, 300) });
    const { container, image } = draw(photo({ brightness: 500 }));
    await waitFor(() => expect(container.querySelector('title')?.textContent)
      .toBe('brightness must be a whole number from -100 to 100'));
    expect(image()).toBeNull();
    expect(painted).toHaveLength(0);
  });
});

describe('inverted text over a picture', () => {
  it('reverses what lies under it, as ^FR prints: a difference blend inside the label', () => {
    const css = readFileSync(join(__dirname, '../../../styles/labelBuilder.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = (selector: string) => {
      const at = css.indexOf(`${selector} {`);
      expect(at, selector).toBeGreaterThanOrEqual(0);
      return css.slice(at, css.indexOf('}', at));
    };
    expect(rule('.lbc-el.is-inverted .lbc-text')).toMatch(/mix-blend-mode:\s*difference/);
    expect(rule('.lbc-label')).toMatch(/isolation:\s*isolate/);
  });
});

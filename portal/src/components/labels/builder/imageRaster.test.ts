// @vitest-environment jsdom
/**
 * The canvas's picture cache (imageRaster.ts): one request per picture,
 * kept for the session within an entry cap AND a byte cap (the oldest go
 * first); "no picture" (404 `no_image`) is an answer for the element that
 * asked, never kept for the session; and a new sample person (Load from
 * person…, Clear) or a deleted library picture drops what was kept for it,
 * so the canvas asks again instead of drawing an old picture.
 */

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { imageRasterSize } from '../../../labels/builder/image';
import type { ImageElement } from '../../../labels/builder/model';

const api = vi.hoisted(() => ({ labelImageRaster: vi.fn() }));
vi.mock('../../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../../lib/api')>()), ...api,
}));

const {
  RASTER_CACHE_BYTES, RASTER_ERROR, clearRasterCache, compileImageErrorText, fetchRaster, forgetPersonRasters,
  forgetStaticRaster, rasterCacheBytes, rasterErrorText, useImageRaster,
} = await import('./imageRaster');
const { ApiError } = await import('../../../lib/api');

const PERSON = '0b7f3c52-6a2e-4c41-9d1e-3f2a9b8c7d10';

function el(over: Partial<ImageElement> = {}): ImageElement {
  return { id: 'image-1', type: 'image', source: 'photo', fit: 'cover', mode: 'dither', x: 0, y: 0, w: 0.8, h: 1,
    rotation: 0, hideWhenEmpty: true, ...over };
}

/** The server: a flat gray picture exactly the size asked for. */
function answerPictures() {
  api.labelImageRaster.mockImplementation(async (body: { w_in: number; h_in: number; dpi: number; rotation: 0 | 90 }) => {
    const { width, height } = imageRasterSize(el({ w: body.w_in, h: body.h_in, rotation: body.rotation }), body.dpi);
    return { width, height, gray: new Uint8Array(width * height).fill(128) };
  });
}

beforeEach(() => {
  clearRasterCache();
  answerPictures();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('fetchRaster', () => {
  it('asks once per picture and keeps it', async () => {
    const a = await fetchRaster(el(), 300, PERSON);
    const b = await fetchRaster(el(), 300, PERSON);
    expect(b).toBe(a);
    expect(api.labelImageRaster).toHaveBeenCalledTimes(1);
    expect(rasterCacheBytes()).toBe(240 * 300);
  });

  it('keeps at most RASTER_CACHE_BYTES of pictures, dropping the oldest first', async () => {
    expect(RASTER_CACHE_BYTES).toBe(64 * 1024 * 1024);
    // a whole badge at 600 DPI: 2025 x 1275 levels, about 2.5 MiB each,
    // so 30 of them (well under the 64-entry cap) pass the byte cap
    const big = (i: number) => el({ source: 'static', imageId: `img-${i}`, w: 3.375, h: 2.125 });
    const each = 2025 * 1275;
    for (let i = 0; i < 30; i++) await fetchRaster(big(i), 600, null);
    expect(api.labelImageRaster).toHaveBeenCalledTimes(30);
    expect(rasterCacheBytes()).toBeLessThanOrEqual(RASTER_CACHE_BYTES);
    expect(rasterCacheBytes()).toBe(Math.floor(RASTER_CACHE_BYTES / each) * each);
    // the newest is still kept; the first went
    await fetchRaster(big(29), 600, null);
    expect(api.labelImageRaster).toHaveBeenCalledTimes(30);
    await fetchRaster(big(0), 600, null);
    expect(api.labelImageRaster).toHaveBeenCalledTimes(31);
  });

  it('a picture used again moves to the back of the line', async () => {
    const big = (i: number) => el({ source: 'static', imageId: `img-${i}`, w: 3.375, h: 2.125 });
    const fits = Math.floor(RASTER_CACHE_BYTES / (2025 * 1275));
    for (let i = 0; i < fits; i++) await fetchRaster(big(i), 600, null);
    await fetchRaster(big(0), 600, null);   // used again
    await fetchRaster(big(fits), 600, null); // one more: img-1 goes, not img-0
    const calls = api.labelImageRaster.mock.calls.length;
    await fetchRaster(big(0), 600, null);
    expect(api.labelImageRaster).toHaveBeenCalledTimes(calls);
    await fetchRaster(big(1), 600, null);
    expect(api.labelImageRaster).toHaveBeenCalledTimes(calls + 1);
  });

  it('"no picture" is never kept for the session: the next ask asks the server again', async () => {
    api.labelImageRaster.mockResolvedValue(null);
    expect(await fetchRaster(el(), 300, PERSON)).toBeNull();
    expect(await fetchRaster(el(), 300, PERSON)).toBeNull();
    expect(api.labelImageRaster).toHaveBeenCalledTimes(2);
    // two asks at once still share one request
    await Promise.all([fetchRaster(el(), 300, PERSON), fetchRaster(el(), 300, PERSON)]);
    expect(api.labelImageRaster).toHaveBeenCalledTimes(3);
    expect(rasterCacheBytes()).toBe(0);
  });

  it('forgetPersonRasters drops every photo and logo, and keeps static pictures', async () => {
    await fetchRaster(el(), 300, PERSON);
    await fetchRaster(el({ source: 'logo' }), 300, PERSON);
    await fetchRaster(el({ source: 'static', imageId: 'img-1' }), 300, null);
    expect(api.labelImageRaster).toHaveBeenCalledTimes(3);
    forgetPersonRasters();
    expect(rasterCacheBytes()).toBe(240 * 300);
    await fetchRaster(el(), 300, PERSON);
    await fetchRaster(el({ source: 'logo' }), 300, PERSON);
    await fetchRaster(el({ source: 'static', imageId: 'img-1' }), 300, null);
    expect(api.labelImageRaster).toHaveBeenCalledTimes(5);
  });

  it('a photo still on its way when the person changes is not kept', async () => {
    let answer: (v: unknown) => void = () => {};
    api.labelImageRaster.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const pending = fetchRaster(el(), 300, PERSON);
    forgetPersonRasters();
    answer({ width: 240, height: 300, gray: new Uint8Array(240 * 300) });
    await pending;
    expect(rasterCacheBytes()).toBe(0);
    await fetchRaster(el(), 300, PERSON);
    expect(api.labelImageRaster).toHaveBeenCalledTimes(2);
  });

  it('forgetStaticRaster drops that library picture only', async () => {
    await fetchRaster(el({ source: 'static', imageId: 'img-1' }), 300, null);
    await fetchRaster(el({ source: 'static', imageId: 'img-1', w: 1 }), 300, null);
    await fetchRaster(el({ source: 'static', imageId: 'img-2' }), 300, null);
    await fetchRaster(el(), 300, PERSON);
    forgetStaticRaster('img-1');
    await fetchRaster(el({ source: 'static', imageId: 'img-2' }), 300, null);
    await fetchRaster(el(), 300, PERSON);
    expect(api.labelImageRaster).toHaveBeenCalledTimes(4);
    await fetchRaster(el({ source: 'static', imageId: 'img-1' }), 300, null);
    expect(api.labelImageRaster).toHaveBeenCalledTimes(5);
  });
});

describe('useImageRaster', () => {
  it('asks again once the person’s pictures are forgotten, and shows the new answer', async () => {
    const { result } = renderHook(() => useImageRaster(el(), 300, PERSON, true));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(api.labelImageRaster).toHaveBeenCalledTimes(1);
    // the person's photo was removed since: Load from person… again
    api.labelImageRaster.mockResolvedValue(null);
    act(() => { forgetPersonRasters(); });
    await waitFor(() => expect(result.current.status).toBe('none'));
    expect(api.labelImageRaster).toHaveBeenCalledTimes(2);
  });

  it('a deleted library picture degrades to no picture', async () => {
    const pic = el({ source: 'static', imageId: 'img-1', fit: 'contain', mode: 'threshold' });
    const { result } = renderHook(() => useImageRaster(pic, 300, null, true));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    api.labelImageRaster.mockResolvedValue(null);
    act(() => { forgetStaticRaster('img-1'); });
    await waitFor(() => expect(result.current.status).toBe('none'));
    expect(api.labelImageRaster).toHaveBeenCalledTimes(2);
  });

  it('a person with no photo is asked again for a new sample person, not for a deleted library picture', async () => {
    api.labelImageRaster.mockResolvedValue(null);
    const { result } = renderHook(() => useImageRaster(el(), 300, PERSON, true));
    await waitFor(() => expect(api.labelImageRaster).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.status).toBe('none'));
    act(() => { forgetStaticRaster('img-1'); });
    await new Promise((r) => { setTimeout(r, 300); });
    expect(api.labelImageRaster).toHaveBeenCalledTimes(1);
    // they have a photo now
    answerPictures();
    act(() => { forgetPersonRasters(); });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(api.labelImageRaster).toHaveBeenCalledTimes(2);
  });

  it('forgetting someone else’s pictures asks nothing', async () => {
    const pic = el({ source: 'static', imageId: 'img-1', fit: 'contain', mode: 'threshold' });
    const { result } = renderHook(() => useImageRaster(pic, 300, null, true));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    act(() => { forgetStaticRaster('img-2'); });
    await new Promise((r) => { setTimeout(r, 300); });
    expect(result.current.status).toBe('ready');
    expect(api.labelImageRaster).toHaveBeenCalledTimes(1);
  });
});

describe('what the errors say', () => {
  it('a picture refused in read-only mode says so', () => {
    expect(rasterErrorText(new ApiError(423, 'read_only_mode')))
      .toBe('Pictures can’t load during read-only maintenance.');
    expect(rasterErrorText(new ApiError(500, 'something_else'))).toBe(RASTER_ERROR);
  });

  it('a compile’s picture, design and read-only codes are sentences, the same for Test print and the preview', () => {
    const say = (code: string, detail?: unknown) => compileImageErrorText(new ApiError(422, code, detail));
    expect(say('person_not_found')).toBe('The sample person is no longer on file. Load another or clear the sample person.');
    expect(say('image_too_large')).toBe('A picture is too large at this DPI. Make its box smaller.');
    expect(say('storage_unavailable')).toBe('The pictures can’t be loaded right now. Try again in a moment.');
    expect(say('images_badge_only')).toBe('Can’t print: images print on ID Badge templates in ZPL only.');
    expect(say('bad_design', { code: 'bad_design', problems: ['image-1: pick a picture'] }))
      .toBe('The design can’t print yet: image-1: pick a picture');
    expect(say('bad_design')).toBe('The design can’t print yet.');
    expect(say('read_only_mode'))
      .toBe('Labels can’t be compiled while the portal is in read-only maintenance mode.');
  });

  it('anything else is left to the caller', () => {
    expect(compileImageErrorText(new ApiError(500, 'labelary_unavailable'))).toBeNull();
    expect(compileImageErrorText(new Error('offline'))).toBeNull();
  });
});

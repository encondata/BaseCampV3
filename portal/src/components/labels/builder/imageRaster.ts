/**
 * The builder canvas's pictures (spec 2026-10-20-badge-templates §4.5,
 * §4.12): each image element's gray raster from the server
 * (POST /labels/images/raster, lib/api.ts labelImageRaster), fetched once
 * per picture, box in dots, fit, turn, DPI and person (labels/builder/
 * image.ts rasterKey) and kept for the session, so a change of look
 * (brightness, contrast, threshold, invert) only dithers again.
 *
 * `useImageRaster` gives an element its raster: from the cache at once, else
 * fetched — the element's first picture straight away, any later one (a
 * resize, a new fit or DPI) after RASTER_DEBOUNCE_MS without a further
 * change, so a drag asks once, for the size it ends on. Meanwhile the
 * picture it had stays up. "No picture" (the API's 404 `no_image`) is an
 * answer and is kept; a request that fails is never cached, its element
 * says why (`rasterErrorText`) and asks again the next time it changes.
 */

import { useEffect, useRef, useState } from 'react';

import { imageRasterSize, rasterKey, rasterRequest, type RasterRequest } from '../../../labels/builder/image';
import type { ImageElement } from '../../../labels/builder/model';
import { ApiError, labelImageRaster } from '../../../lib/api';

/** A picture as the canvas dithers it: gray levels, the footprint's size. */
export interface GrayRaster {
  width: number;
  height: number;
  gray: Uint8Array;
}

export const RASTER_DEBOUNCE_MS = 250;
/** How many pictures the session keeps. */
const CACHE_SIZE = 64;

interface Entry {
  promise: Promise<GrayRaster | null>;
  /** Set once it resolves: the raster, or null for no picture. */
  value?: GrayRaster | null;
}

const cache = new Map<string, Entry>();

/** Forgets every picture (tests; a new session starts empty anyway). */
export function clearRasterCache(): void {
  cache.clear();
}

function remember(key: string, entry: Entry): void {
  cache.set(key, entry);
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
}

async function load(req: RasterRequest, el: ImageElement): Promise<GrayRaster | null> {
  const got = await labelImageRaster(req);
  if (!got) return null;
  // the size asked for when the response's headers can't be read
  const want = imageRasterSize(el, req.dpi);
  const width = got.width ?? want.width;
  const height = got.height ?? want.height;
  if (got.gray.length !== width * height) {
    throw new Error(`the picture should be ${width} x ${height} levels, not ${got.gray.length}`);
  }
  return { width, height, gray: got.gray };
}

/** The settled raster for `key`: the picture, null for none, undefined
 *  while it loads or when it was never asked for. */
function settled(key: string): GrayRaster | null | undefined {
  const hit = cache.get(key);
  if (hit && hit.value !== undefined) {
    // recently used: to the back of the line
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit?.value;
}

/** `el`'s gray raster at `dpi` for the sample person `personId`: null when
 *  the source has no picture (no sample person, no static image picked, a
 *  person with no photo or logo). Cached by what the picture depends on. */
export function fetchRaster(el: ImageElement, dpi: number, personId: string | null): Promise<GrayRaster | null> {
  const req = rasterRequest(el, dpi, personId);
  if (!req) return Promise.resolve(null);
  const key = rasterKey(req);
  const hit = cache.get(key);
  if (hit) return hit.promise;
  const entry: Entry = {
    promise: load(req, el).then((value) => {
      entry.value = value;
      return value;
    }, (err: unknown) => {
      if (cache.get(key) === entry) cache.delete(key);
      throw err;
    }),
  };
  remember(key, entry);
  return entry.promise;
}

export type RasterState =
  /** Nothing to draw: no request to make, or the source has no picture. */
  | { status: 'none' }
  /** Waiting; `stale` is the picture shown before, if any. */
  | { status: 'loading'; stale: GrayRaster | null }
  | { status: 'ready'; raster: GrayRaster }
  | { status: 'error'; message: string; stale: GrayRaster | null };

export const RASTER_ERROR = 'Couldn’t load the picture. Try again in a moment.';

/** What an element says when its picture can't be had. */
export function rasterErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'image_too_large': return 'Image too large at this DPI.';
      case 'unreadable_image': return 'Can’t read this image.';
      case 'person_not_found': return 'The sample person is no longer on file.';
      case 'storage_unavailable': return 'Images unavailable right now.';
      case 'bad_field': return 'Can’t draw this image.';
      default: break;
    }
  }
  return RASTER_ERROR;
}

/** The raster `el` draws, when `enabled` (a photo or logo in Field names
 *  draws none). */
export function useImageRaster(el: ImageElement, dpi: number, personId: string | null, enabled: boolean): RasterState {
  const req = enabled ? rasterRequest(el, dpi, personId) : null;
  const key = req ? rasterKey(req) : null;
  // the latest element and person, for the request the effect makes
  const latest = useRef({ el, dpi, personId });
  useEffect(() => { latest.current = { el, dpi, personId }; });
  // the picture on screen, kept up while the next one loads
  const shown = useRef<GrayRaster | null>(null);
  // a picture was asked for before: the next request waits for quiet
  const asked = useRef(false);
  const [result, setResult] = useState<
    { key: string; raster: GrayRaster | null } | { key: string; error: string } | null>(null);

  const cached = key === null ? undefined : settled(key);
  // after a failure, the element's next change asks again: a lasting fault
  // asks once per edit, never in a loop
  const failed = result !== null && result.key === key && 'error' in result;
  const [attempt, setAttempt] = useState(0);
  const seen = useRef(el);
  useEffect(() => {
    if (seen.current === el) return;
    seen.current = el;
    if (failed) setAttempt((n) => n + 1);
  }, [el, failed]);

  useEffect(() => {
    if (key === null) return undefined;
    if (cached !== undefined) {
      asked.current = true;
      return undefined;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      asked.current = true;
      const { el: e, dpi: d, personId: p } = latest.current;
      fetchRaster(e, d, p).then(
        (raster) => { if (live) setResult({ key, raster }); },
        (err: unknown) => { if (live) setResult({ key, error: rasterErrorText(err) }); },
      );
    }, asked.current ? RASTER_DEBOUNCE_MS : 0);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [key, cached, attempt]);

  let state: RasterState;
  if (key === null) state = { status: 'none' };
  else if (cached !== undefined) state = cached ? { status: 'ready', raster: cached } : { status: 'none' };
  else if (result?.key === key) {
    state = 'error' in result ? { status: 'error', message: result.error, stale: null }
      : result.raster ? { status: 'ready', raster: result.raster } : { status: 'none' };
  } else {
    state = { status: 'loading', stale: shown.current };
  }

  const ready = state.status === 'ready' ? state.raster : null;
  const none = state.status === 'none';
  useEffect(() => {
    if (ready) shown.current = ready;
    else if (none) shown.current = null;
  }, [ready, none]);
  return state;
}

/**
 * The builder canvas's pictures (spec 2026-10-20-badge-templates §4.5,
 * §4.12): each image element's gray raster from the server
 * (POST /labels/images/raster, lib/api.ts labelImageRaster), fetched once
 * per picture, box in dots, fit, turn, DPI and person (labels/builder/
 * image.ts rasterKey) and kept for the session, so a change of look
 * (brightness, contrast, threshold, invert) only dithers again.
 *
 * The session keeps at most RASTER_CACHE_SIZE pictures and
 * RASTER_CACHE_BYTES of them (the server's own raster cache's caps), the
 * least recently used going first. "No picture" (the API's 404 `no_image`)
 * is an answer for whoever asked, never kept: the person may have a photo
 * by the next ask. Opening a template in the builder forgets every picture
 * (`forgetAllRasters`: someone may have replaced an avatar or a logo since),
 * a new sample person (Load from person… — even the same one again — or
 * Clear sample person) forgets every photo and logo
 * (`forgetPersonRasters`), and a picture deleted from the label image
 * library forgets that picture (`forgetStaticRaster`); the elements that
 * drew one ask again.
 *
 * `useImageRaster` gives an element its raster: from the cache at once, else
 * fetched — the element's first picture straight away, any later one (a
 * resize, a new fit or DPI, a forgotten picture) after RASTER_DEBOUNCE_MS
 * without a further change, so a drag asks once, for the size it ends on.
 * Meanwhile the picture it had stays up. A request that fails is never
 * cached, its element says why (`rasterErrorText`) and asks again the next
 * time it changes. Test print and the printer preview say why a compile
 * was refused with `compileImageErrorText`.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { imageRasterSize, rasterKey, rasterRequest, type RasterRequest } from '../../../labels/builder/image';
import type { ImageElement, ImageSource } from '../../../labels/builder/model';
import { ApiError, labelImageRaster } from '../../../lib/api';

/** A picture as the canvas dithers it: gray levels, the footprint's size. */
export interface GrayRaster {
  width: number;
  height: number;
  gray: Uint8Array;
}

export const RASTER_DEBOUNCE_MS = 250;
/** How many pictures the session keeps (asked for or kept). */
export const RASTER_CACHE_SIZE = 64;
/** How many bytes of gray levels the session keeps at most. */
export const RASTER_CACHE_BYTES = 64 * 1024 * 1024;

interface Entry {
  promise: Promise<GrayRaster | null>;
  /** Whose picture: a library image's id, or (a photo or logo) a person's. */
  source: ImageSource;
  subject: string | null;
  /** Set once the picture is kept. */
  value?: GrayRaster;
}

/** Oldest first: Map order, a kept or reused picture moved to the back. */
const cache = new Map<string, Entry>();
let bytes = 0;

/** How many times every picture, the sample person's pictures, and each
 *  library picture were forgotten: an element whose count moves asks again. */
let allEpoch = 0;
let personEpoch = 0;
const staticEpochs = new Map<string, number>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function epochOf(req: RasterRequest | null): string {
  if (!req) return `${allEpoch}`;
  const own = req.source === 'static' ? staticEpochs.get(req.image_id ?? '') ?? 0 : personEpoch;
  return `${allEpoch}.${own}`;
}

function drop(key: string): void {
  const hit = cache.get(key);
  if (!hit) return;
  cache.delete(key);
  if (hit.value) bytes -= hit.value.gray.length;
}

/** Drops the oldest pictures until both caps hold, never `except`. */
function evict(except: string): void {
  for (const key of cache.keys()) {
    if (cache.size <= RASTER_CACHE_SIZE && bytes <= RASTER_CACHE_BYTES) return;
    if (key !== except) drop(key);
  }
}

/** Forgets every picture (tests; a new session starts empty anyway). */
export function clearRasterCache(): void {
  cache.clear();
  bytes = 0;
}

/** The bytes of gray levels kept now. */
export function rasterCacheBytes(): number {
  return bytes;
}

/** A template opened in the builder: every picture kept, or on its way,
 *  is forgotten (a photo, logo or library picture may have changed since
 *  it was kept, and the canvas must draw what prints), and the elements
 *  showing one ask again. */
export function forgetAllRasters(): void {
  cache.clear();
  bytes = 0;
  allEpoch += 1;
  listeners.forEach((l) => l());
}

/** A new sample person (or the same one loaded again, or none): every
 *  photo and logo kept, or on its way, is forgotten, and the elements
 *  showing one ask again. */
export function forgetPersonRasters(): void {
  for (const [key, entry] of cache) {
    if (entry.source !== 'static') drop(key);
  }
  personEpoch += 1;
  listeners.forEach((l) => l());
}

/** A library picture was deleted: its pictures are forgotten, and the
 *  elements showing it ask again (and get "no picture"). */
export function forgetStaticRaster(imageId: string): void {
  for (const [key, entry] of cache) {
    if (entry.source === 'static' && entry.subject === imageId) drop(key);
  }
  staticEpochs.set(imageId, (staticEpochs.get(imageId) ?? 0) + 1);
  listeners.forEach((l) => l());
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

/** The kept raster for `key`, undefined when none is kept (never asked
 *  for, on its way, no picture, forgotten). */
function settled(key: string): GrayRaster | undefined {
  const hit = cache.get(key);
  if (hit?.value === undefined) return undefined;
  // recently used: to the back of the line
  cache.delete(key);
  cache.set(key, hit);
  return hit.value;
}

/** `el`'s gray raster at `dpi` for the sample person `personId`: null when
 *  the source has no picture (no sample person, no static image picked, a
 *  person with no photo or logo). Cached by what the picture depends on. */
export function fetchRaster(el: ImageElement, dpi: number, personId: string | null): Promise<GrayRaster | null> {
  const req = rasterRequest(el, dpi, personId);
  if (!req) return Promise.resolve(null);
  const key = rasterKey(req);
  const hit = cache.get(key);
  if (hit) {
    if (hit.value) settled(key);
    return hit.promise;
  }
  const entry: Entry = {
    source: req.source,
    subject: (req.source === 'static' ? req.image_id : req.person_id) ?? null,
    promise: load(req, el).then((value) => {
      const current = cache.get(key) === entry;
      if (!value) {
        // no picture: the answer for those asking now, never kept
        if (current) cache.delete(key);
        return null;
      }
      if (current) {
        entry.value = value;
        bytes += value.gray.length;
        cache.delete(key);
        cache.set(key, entry);
        evict(key);
      }
      return value;
    }, (err: unknown) => {
      if (cache.get(key) === entry) cache.delete(key);
      throw err;
    }),
  };
  cache.set(key, entry);
  evict(key);
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
      case 'read_only_mode': return 'Pictures can’t load during read-only maintenance.';
      default: break;
    }
  }
  return RASTER_ERROR;
}

/** What Test print and the printer preview say when the compile refuses
 *  the design for its pictures, its problems or read-only mode; null for
 *  anything else, which each says in its own way. */
export function compileImageErrorText(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  switch (err.code) {
    case 'person_not_found': return 'The sample person is no longer on file. Load another or clear the sample person.';
    case 'image_too_large': return 'A picture is too large at this DPI. Make its box smaller.';
    case 'storage_unavailable': return 'The pictures can’t be loaded right now. Try again in a moment.';
    case 'images_badge_only': return 'Can’t print: images print on ID Badge templates in ZPL only.';
    case 'bad_design': {
      const problems = (err.detail as { problems?: string[] } | undefined)?.problems;
      return problems?.length ? `The design can’t print yet: ${problems[0]}` : 'The design can’t print yet.';
    }
    case 'read_only_mode': return 'Labels can’t be compiled while the portal is in read-only maintenance mode.';
    default: return null;
  }
}

/** The raster `el` draws, when `enabled` (a photo or logo in Field names
 *  draws none). */
export function useImageRaster(el: ImageElement, dpi: number, personId: string | null, enabled: boolean): RasterState {
  const req = enabled ? rasterRequest(el, dpi, personId) : null;
  const key = req ? rasterKey(req) : null;
  // moves when this picture is forgotten: an answer from before is old
  const epoch = useSyncExternalStore(subscribe, () => epochOf(req));
  const slot = key === null ? null : `${epoch}:${key}`;
  // the latest element and person, for the request the effect makes
  const latest = useRef({ el, dpi, personId });
  useEffect(() => { latest.current = { el, dpi, personId }; });
  // the picture on screen, kept up while the next one loads
  const shown = useRef<GrayRaster | null>(null);
  // a picture was asked for before: the next request waits for quiet
  const asked = useRef(false);
  const [result, setResult] = useState<
    { slot: string; raster: GrayRaster | null } | { slot: string; error: string } | null>(null);

  const cached = key === null ? undefined : settled(key);
  // after a failure, the element's next change asks again: a lasting fault
  // asks once per edit, never in a loop
  const failed = result !== null && result.slot === slot && 'error' in result;
  const [attempt, setAttempt] = useState(0);
  const seen = useRef(el);
  useEffect(() => {
    if (seen.current === el) return;
    seen.current = el;
    if (failed) setAttempt((n) => n + 1);
  }, [el, failed]);

  useEffect(() => {
    if (slot === null) return undefined;
    if (cached !== undefined) {
      asked.current = true;
      return undefined;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      asked.current = true;
      const { el: e, dpi: d, personId: p } = latest.current;
      fetchRaster(e, d, p).then(
        (raster) => { if (live) setResult({ slot, raster }); },
        (err: unknown) => { if (live) setResult({ slot, error: rasterErrorText(err) }); },
      );
    }, asked.current ? RASTER_DEBOUNCE_MS : 0);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [slot, cached, attempt]);

  let state: RasterState;
  if (key === null) state = { status: 'none' };
  else if (cached !== undefined) state = { status: 'ready', raster: cached };
  else if (result?.slot === slot) {
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

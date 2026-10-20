/**
 * The builder page's fonts (labels/builder/metrics.ts loadFont): each family
 * and weight loads once, from the library file GET /labels/fonts lists for
 * it — its metrics (GET /labels/fonts/{id}/metrics) to measure with, its
 * face to draw with (for the resident Swiss cut, the Roboto Condensed Bold
 * stand-in). A Bold the library has no file for measures as the Regular,
 * as the printer prints it.
 *
 * `metricsFor` is what the canvas and panels take: a loaded font, or null
 * while it loads. Asking for one not loaded yet starts loading it, and when
 * it arrives `metricsFor` changes identity, so everything that measured
 * with it draws again. A load that fails stays failed (`failed` names it)
 * and measures as null.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { familyInfo, type FontWeight } from '../../../labels/builder/fonts';
import { loadFont, type FontMetrics, type FontSource, type LoadedFont } from '../../../labels/builder/metrics';
import { getLabelFontBytes, getLabelFontMetrics, type LabelFont } from '../../../lib/api';
import type { MetricsFor } from './Canvas';

export interface BuilderFonts {
  metricsFor: MetricsFor;
  /** `family/weight` of each load that failed. */
  failed: string[];
}

type Entry = LoadedFont | 'loading' | 'failed';

/** The library row a family and weight prints with: its own file, or for a
 *  Bold the library lacks, the family's Regular. */
export function libraryRow(library: readonly LabelFont[], family: string, weight: FontWeight): LabelFont | undefined {
  const find = (w: FontWeight) => library.find((f) => f.family === family && f.weight === w);
  return find(weight) ?? (weight === 'bold' ? find('regular') : undefined);
}

/** The FontSource for loadFont over the library, each file's metrics and
 *  bytes fetched once however many families and weights share it. */
export function librarySource(library: readonly LabelFont[]): FontSource {
  const metrics = new Map<string, Promise<FontMetrics>>();
  const bytes = new Map<string, Promise<ArrayBuffer>>();
  const once = <T>(memo: Map<string, Promise<T>>, family: string, weight: FontWeight,
    fetch: (id: string) => Promise<T>): Promise<T> => {
    const row = libraryRow(library, family, weight);
    if (!row) return Promise.reject(new Error(`the font library has no ${family} ${weight} file`));
    let hit = memo.get(row.id);
    if (!hit) {
      hit = fetch(row.id);
      memo.set(row.id, hit);
    }
    return hit;
  };
  return {
    metrics: (family, weight) => once(metrics, family, weight, getLabelFontMetrics),
    bytes: (family, weight) => once(bytes, family, weight,
      async (id) => (await getLabelFontBytes(id)).slice().buffer as ArrayBuffer),
  };
}

export function useBuilderFonts(library: readonly LabelFont[] | null): BuilderFonts {
  const cache = useRef(new Map<string, Entry>());
  const [loads, setLoads] = useState(0);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);
  const source = useMemo(() => (library ? librarySource(library) : null), [library]);

  const metricsFor = useCallback<MetricsFor>((family, weight) => {
    const key = `${family}/${weight}`;
    const hit = cache.current.get(key);
    if (hit !== undefined) return typeof hit === 'string' ? null : hit;
    if (!source || !familyInfo(family)) return null;
    cache.current.set(key, 'loading');
    const settle = (entry: Entry) => {
      cache.current.set(key, entry);
      if (live.current) setLoads((n) => n + 1);
    };
    loadFont(family, weight, source).then(settle, () => settle('failed'));
    return null;
    // `loads` gives the function a new identity each time a font arrives
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, loads]);

  const failed = useMemo(() => [...cache.current].filter(([, e]) => e === 'failed').map(([k]) => k),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loads]);

  return { metricsFor, failed };
}

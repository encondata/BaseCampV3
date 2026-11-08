/**
 * Label bundles and the label vocabulary, cached for Bulk Print. An online
 * load writes through to IndexedDB (`label_bundles`, and the `label_vocab`
 * row in `meta`); when the API is unreachable the last copy serves instead,
 * so a kiosk can keep printing labels it already downloaded. Only an
 * offline failure falls back: any other error (forbidden, move locked)
 * is the real answer and is rethrown.
 */
import { naturalCompare } from '@portal/lib/naturalSort';

import {
  ApiError, fetchKioskLabelBundle, fetchLabelVocab,
  type GeneratedLabelBundle, type LabelVocab,
} from './api';
import { getAll, getRow, putRows, readMeta, writeMeta } from './localDb';

export interface CachedBundle extends GeneratedLabelBundle { cached_at: string }

interface BundleRow {
  key: string; initiative_id: string; label_type: string; cached_at: string;
  bundle: GeneratedLabelBundle;
}

export function bundleKey(initiativeId: string, labelType: string): string {
  return `${initiativeId}:${labelType}`;
}

/** The API cannot be reached (network down, laptop edge offline) or the
 *  person's cloud session is missing (they signed in offline). */
export function isOfflineError(err: unknown): boolean {
  return err instanceof ApiError
    && (err.code === 'network' || err.code === 'cloud_sign_in_required');
}

export async function putCachedBundle(bundle: GeneratedLabelBundle, now: Date = new Date()): Promise<void> {
  const row: BundleRow = {
    key: bundleKey(bundle.initiative_id, bundle.label_type),
    initiative_id: bundle.initiative_id,
    label_type: bundle.label_type,
    cached_at: now.toISOString(),
    bundle,
  };
  await putRows('label_bundles', [row]);
}

export async function getCachedBundle(
  initiativeId: string, labelType: string,
): Promise<CachedBundle | null> {
  const row = await getRow<BundleRow>('label_bundles', bundleKey(initiativeId, labelType));
  return row ? { ...row.bundle, cached_at: row.cached_at } : null;
}

/** The label types this move has a cached bundle for, natural-sorted. */
export async function cachedBundleTypes(initiativeId: string): Promise<string[]> {
  const rows = await getAll<BundleRow>('label_bundles');
  return rows.filter((r) => r.initiative_id === initiativeId)
    .map((r) => r.label_type).sort(naturalCompare);
}

export async function loadBundle(
  initiativeId: string, labelType: string,
): Promise<{ bundle: GeneratedLabelBundle; offlineSince: string | null }> {
  try {
    const bundle = await fetchKioskLabelBundle(initiativeId, labelType);
    await putCachedBundle(bundle);
    return { bundle, offlineSince: null };
  } catch (err) {
    if (!isOfflineError(err)) throw err;
    const cached = await getCachedBundle(initiativeId, labelType);
    if (!cached) throw err;
    const { cached_at: offlineSince, ...bundle } = cached;
    return { bundle, offlineSince };
  }
}

export async function loadVocab(): Promise<{ vocab: LabelVocab[]; offline: boolean }> {
  try {
    const vocab = await fetchLabelVocab();
    await writeMeta('label_vocab', { rows: vocab, cached_at: new Date().toISOString() });
    return { vocab, offline: false };
  } catch (err) {
    if (!isOfflineError(err)) throw err;
    const stored = await readMeta('label_vocab');
    return { vocab: (stored?.rows as LabelVocab[] | undefined) ?? [], offline: true };
  }
}

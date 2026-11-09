/**
 * Custom sizes, shared by New template and Change size…: a width and height
 * typed in inches or millimeters (always sent in inches) become a size row
 * (POST /labels/vocab). "Save this size to the list" leaves it listed for
 * the next template; otherwise it is kept off the list for this template
 * alone. A listed size of the same dimensions is reused instead. When the
 * save that follows fails and the size or the switch changes before the
 * retry, the row this dialog made off the list is rewritten (PATCH
 * /labels/vocab, which lets a designer change a pending size: off the
 * list, on no template) rather than left behind with another posted.
 */

import { useRef } from 'react';

import { ApiError, createLabelVocab, updateLabelVocab, type LabelVocab } from '../../../lib/api';
import { sizeMeta } from '../../../lib/labels';

export type Unit = 'in' | 'mm';

const MM_PER_IN = 25.4;

/** A dimension typed in `unit`, in inches to the thousandth; null unless
 *  it is a positive number. */
export function toInches(text: string, unit: Unit): number | null {
  const n = Number(text.trim());
  if (!text.trim() || !Number.isFinite(n) || n <= 0) return null;
  const inches = Math.round((unit === 'mm' ? n / MM_PER_IN : n) * 1000) / 1000;
  return inches > 0 ? inches : null;
}

/** Inches to the thousandth, no trailing zeros ("4", "4.5"). */
export function fmtInches(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

/** A size row's key and label for `w` × `h` inches, as the seeded rows
 *  read (`4x2`, `4" x 2"`): dots become underscores, and a key another
 *  size already holds gets `-2`, `-3`… */
export function customSizeKey(w: number, h: number, taken: ReadonlySet<string>): string {
  const base = `${fmtInches(w)}x${fmtInches(h)}`.replace(/\./g, '_');
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** Whether a (tab-less) size row is `w` × `h` inches. */
export function sameSize(row: LabelVocab, w: number, h: number): boolean {
  const m = sizeMeta(row);
  return Math.abs(m.width_in - w) < 0.0005 && Math.abs(m.height_in - h) < 0.0005 && !m.has_tab;
}

/** The size row key for a custom `w` × `h`: a listed row of those
 *  dimensions, this dialog's own row (rewritten while it is pending), or a
 *  new row. `vocab` is every vocab row; `listed` the active sizes. */
export function useCustomSizeRow(vocab: LabelVocab[], listed: LabelVocab[]) {
  /** The custom size row this dialog last posted, so a retry after a failed
   *  save uses it instead of posting another: `made` once the API has it
   *  (or a repeat of the post found it there). */
  const own = useRef<{ key: string; w: number; h: number; active: boolean; made: boolean } | null>(null);
  /** Keys this dialog posted or found taken: never offered again. */
  const usedKeys = useRef(new Set<string>());

  return async (w: number, h: number, keep: boolean): Promise<string> => {
    const match = listed.find((s) => sameSize(s, w, h));
    if (match) return match.key;
    const mine = own.current;
    const again = mine !== null && mine.w === w && mine.h === h && mine.active === keep;
    if (again && mine.made) return mine.key;
    // the size or the switch changed since this dialog made its row off the list
    if (mine !== null && mine.made && !mine.active) {
      try {
        await updateLabelVocab('size', mine.key, {
          label: `${fmtInches(w)}" x ${fmtInches(h)}"`, is_active: keep,
          meta: { width_in: w, height_in: h, has_tab: false },
        });
        own.current = { key: mine.key, w, h, active: keep, made: true };
        return mine.key;
      } catch (err) {
        // no longer a pending row (a template took it, it was listed or
        // removed): post a new one; anything else, the next try rewrites again
        if (!(err instanceof ApiError) || (err.status !== 403 && err.status !== 404)) throw err;
        own.current = null;
      }
    }
    // a repeat of a post whose answer was lost: a 409 now means it landed
    const repeat = again && !mine.made;
    const taken = new Set([...vocab.filter((v) => v.kind === 'size').map((v) => v.key), ...usedKeys.current]);
    const key = repeat ? mine.key : customSizeKey(w, h, taken);
    usedKeys.current.add(key);
    own.current = { key, w, h, active: keep, made: false };
    try {
      await createLabelVocab({
        kind: 'size', key, label: `${fmtInches(w)}" x ${fmtInches(h)}"`, is_active: keep,
        meta: { width_in: w, height_in: h, has_tab: false },
      });
    } catch (err) {
      const landed = repeat && err instanceof ApiError && err.code === 'label_vocab_exists';
      if (!landed) {
        // another's row under that key: the next try takes a new one
        if (err instanceof ApiError && err.code === 'label_vocab_exists') own.current = null;
        throw err;
      }
    }
    own.current.made = true;
    return key;
  };
}

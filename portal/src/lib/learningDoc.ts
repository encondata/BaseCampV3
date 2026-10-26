/**
 * Shared bits of the learning Library and Document pages: the validity
 * choices, the re-sign copy, translation status chips, API error wording and
 * a few formatters. The wording of the rules mirrors the mockup
 * (docs/mockups/learning-portal.html, "Document settings").
 */

import { ApiError } from './api';
import type { ResignRule, SignStyle, TranslationStatus } from './learning';

/** "Valid for" choices. `custom` is the Custom days option (a number box);
 *  the stored value is validity_days (null = never expires). */
export type ValidityChoice = 'never' | '30' | '90' | '182' | '365' | 'custom';

export const VALIDITY_OPTIONS: { value: ValidityChoice; label: string }[] = [
  { value: 'never', label: 'Never' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '182', label: '6 months' },
  { value: '365', label: '1 year' },
  { value: 'custom', label: 'Custom days' },
];

/** The select's value for a stored validity: a preset when it matches one. */
export function validityChoice(days: number | null): ValidityChoice {
  if (days === null) return 'never';
  const preset = VALIDITY_OPTIONS.find((o) => o.value === String(days));
  return preset ? preset.value : 'custom';
}

/** "1 year", "182 days"… for read-only views. */
export function validityText(days: number | null): string {
  if (days === null) return 'Never expires';
  const preset = VALIDITY_OPTIONS.find((o) => o.value === String(days));
  return preset ? preset.label : `${days} days`;
}

export const RESIGN_OPTIONS: { value: ResignRule; title: string; sub: string }[] = [
  {
    value: 'every_initiative', title: 'Sign again every initiative',
    sub: 'Best for client NDAs and site rules',
  },
  {
    value: 'expired_or_new_version', title: 'Only if expired or there’s a new version',
    sub: 'Best for company-wide policies',
  },
];

export const SIGN_STYLES: { value: SignStyle; label: string }[] = [
  { value: 'checkbox', label: 'Checkbox' },
  { value: 'typed_name', label: 'Typed name' },
  { value: 'drawn_signature', label: 'Drawn signature' },
];

export const TRANSLATION_STATUS: Record<TranslationStatus, { label: string; cls: string }> = {
  draft: { label: 'Draft', cls: 'c-slate' },
  in_review: { label: 'In review', cls: 'c-amber' },
  published: { label: 'Published', cls: 'c-green' },
  out_of_date: { label: 'Out of date', cls: 'c-red' },
  missing: { label: 'Not translated', cls: 'c-slate' },
};

/** Languages the learn app lays out right to left. */
const RTL = new Set(['he', 'ar', 'fa', 'ur']);
export const textDir = (language: string): 'rtl' | 'ltr' =>
  (RTL.has(language.split('-')[0]) ? 'rtl' : 'ltr');

/** A whole number >= 1 from an input's text, else null. */
export function positiveInt(text: string): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 ? n : null;
}

/** Plain-language wording for API failures. A known code gets the page's own
 *  wording; otherwise the server's message (read-only mode included); a
 *  validation failure with no message gets a generic line. */
export function apiErrorText(
  err: unknown, known: Record<string, string> = {}, fallback = 'Something went wrong. Try again.',
): string {
  if (err instanceof ApiError) {
    if (known[err.code]) return known[err.code];
    if (err.code === 'read_only_mode') return err.message;
    const detail = err.detail as { message?: unknown } | undefined;
    if (detail && typeof detail.message === 'string' && detail.message) return detail.message;
    if (err.status === 403) return 'You don’t have permission to do that.';
    if (err.status === 422) return 'Check the values and try again.';
  }
  return fallback;
}

export const TRANSLATION_ERRORS: Record<string, string> = {
  self_review: 'Someone other than the last editor has to approve this translation.',
  not_in_review: 'Only a translation that is in review can be approved.',
  not_draft: 'Only a draft can be sent for review.',
  not_published: 'Publish the document before translating it.',
  translation_unavailable: 'Translating with Claude isn’t available right now.',
  translation_failed: 'Claude couldn’t translate this document. Try again.',
  translation_exists: 'There is already a translation of this version. Open it with Edit.',
  version_changed: 'A new version was published meanwhile. Reload and try again.',
  title_required: 'The translation needs a title.',
  content_required: 'The translation needs content.',
};

export const PUBLISH_ERRORS: Record<string, string> = {
  no_changes: 'The wiki page hasn’t changed since the last version.',
  stale_wiki_version: 'The wiki page was rolled back. Publish it again in the wiki first.',
  wiki_not_published: 'The wiki page has no published version yet.',
  wiki_page_missing: 'The linked wiki page is gone. Link the document to another page.',
  render_rejected: 'The wiki couldn’t render this page’s content. Check the page in the wiki.',
  render_unavailable: 'The wiki couldn’t render the page right now. Try again shortly.',
};

export const QUESTION_ERRORS: Record<string, string> = {
  too_few_choices: 'A question needs at least two choices.',
  no_correct_choice: 'Mark at least one choice as correct.',
  duplicate_choice: 'Two choices share an id.',
  duplicate_correct: 'A correct choice is listed twice.',
  unknown_correct_choice: 'A correct choice isn’t one of the question’s choices.',
  unknown_translated_choice: 'A translation names a choice the question doesn’t have.',
};

export const shortDate = (iso: string): string =>
  new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });

export const dateTime = (iso: string): string =>
  new Date(iso).toLocaleString([], {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });

/** An id for a quiz choice the server hasn't seen (it keeps ids we send). */
export function newChoiceId(): string {
  const bytes = new Uint8Array(4);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return `c${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

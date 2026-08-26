// Pure helpers for the Variables page. Kept out of the component so they can
// be tested without a live API — same convention as lib/sites.ts.
import type { AssetCategoryOut, SiteLookup, StatusValue, WorkerLevel } from './api';

// The seven the palette was built on. Not a limit any more — a starting point,
// so the common case stays one click. Values are the light-theme hexes; render
// clamps lightness per theme (see the CSS in styles/directory.css).
export const PRESET_COLORS: { value: string; label: string }[] = [
  { value: '#178a4c', label: 'Green' },
  { value: '#a36207', label: 'Amber' },
  { value: '#c03540', label: 'Red' },
  { value: '#1668a7', label: 'Blue' },
  { value: '#6d4fc4', label: 'Violet' },
  { value: '#0f7c86', label: 'Aqua' },
  { value: '#51606f', label: 'Slate' },
];

const HEX_RE = /^#[0-9a-f]{6}$/;

export function isHex(v: string): boolean {
  return HEX_RE.test(v);
}

// Accepts what a person actually pastes; returns the canonical stored form, or
// null rather than guessing at junk.
export function normalizeHex(input: string): string | null {
  let v = input.trim().toLowerCase();
  if (!v.startsWith('#')) v = `#${v}`;
  if (/^#[0-9a-f]{3}$/.test(v)) {
    v = `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  }
  return HEX_RE.test(v) ? v : null;
}

export interface InsertionPoint { after: string | null; label: string }

// The gaps ARE the insertion points — "before, between, after" is one list.
export function insertionPoints(levels: WorkerLevel[]): InsertionPoint[] {
  const sorted = [...levels].sort((a, b) => a.rank - b.rank);
  if (!sorted.length) return [{ after: null, label: 'First level' }];
  const out: InsertionPoint[] = [
    { after: null, label: `Before ${sorted[0].level} (first)` },
  ];
  sorted.forEach((l, i) => {
    const next = sorted[i + 1];
    out.push({
      after: l.level,
      label: next ? `Between ${l.level} and ${next.level}`
                  : `After ${l.level} (last)`,
    });
  });
  return out;
}

// Mirrors the server's rule so the preview matches what will be saved.
// `after` naming an anchor absent from `levels` returns null rather than
// guessing — the server (routes/workers.py::create_level) 422s with
// unknown_level in that case, and a stale client list (the anchor was
// deleted between fetch and submit) must not render a confident but false
// insertion order.
export function rankAfter(levels: WorkerLevel[], after: string | null): number | null {
  if (after === null) return 1;
  const anchor = levels.find((l) => l.level === after);
  return anchor ? anchor.rank + 1 : null;
}

// The resulting level-key order if `newLevel` were inserted at `after` —
// what the position preview renders. Mirrors rankAfter's null contract: an
// unknown anchor yields null so the caller shows nothing rather than a
// false order.
export function previewOrder(
  levels: WorkerLevel[], newLevel: string, after: string | null,
): string[] | null {
  const rank = rankAfter(levels, after);
  if (rank === null) return null;
  const sorted = [...levels].sort((a, b) => a.rank - b.rank).map((l) => l.level);
  const idx = rank - 1;
  return [...sorted.slice(0, idx), newLevel, ...sorted.slice(idx)];
}

export interface StatusForm {
  record_type: string;
  key: string;
  label: string;
  description: string;
  color: string;
  sort_order: string;   // form state is a string; coerced on the way out
  is_active: boolean;
  // asset only (editor gates on record_type); form state is a
  // string, and unlike sort_order an EMPTY string is a *valid* input here
  // (it means "null" — the status is excluded from progress). See
  // parseProgressWeight.
  progress_weight: string;
}

export interface SiteTypeForm {
  key: string;   // editable only in create mode; immutable (FK: sites.site_type) after
  label: string;
  description: string;
  sort_order: string;   // form state is a string; coerced on the way out
  icon: string;
  color: string;
}

export interface WorkerLevelForm {
  level: string;   // editable only in create mode; immutable (FK: worker_profiles.level) after
  after: string | null;   // insertion point; create mode only, never sent verbatim — the
                            // server derives rank from it (routes/workers.py::create_level)
  title: string;
  description: string;
  expected_skills: string[];
  color: string;
}

// sort_order arrives from the form as a string. Number('') is 0 (a silent,
// wrong default) and Number('abc') is NaN — which JSON-stringifies to null and
// gets a 422 from the API on this non-nullable field. The payload builders
// below deliberately don't validate, so callers must run this FIRST and refuse
// to submit on null. Returns the parsed value, or null if it isn't a
// non-negative integer.
export function parseSortOrder(text: string): number | null {
  const t = text.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// progress_weight arrives from the form as a string, but unlike sort_order
// an empty string is a VALID input here — it means "clear to null" (the
// status is excluded from progress). Only a non-empty string that doesn't
// parse to an integer 0-100 is invalid. Returns undefined for that invalid
// case so callers (submit handlers) can detect and reject it before saving,
// distinct from null (explicit clear) and a real parsed weight.
export function parseProgressWeight(text: string): number | null | undefined {
  const t = text.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isInteger(n) && n >= 0 && n <= 100 ? n : undefined;
}

export function statusSearchText(v: StatusValue): string {
  return [v.record_type, v.key, v.label, v.description]
    .join(' ').toLowerCase();
}

export function recordTypeOptions(
  values: StatusValue[],
): { value: string; label: string }[] {
  return [...new Set(values.map((v) => v.record_type))]
    .sort()
    .map((t) => ({ value: t, label: t }));
}

export function statusFormFromValue(v: StatusValue): StatusForm {
  return {
    record_type: v.record_type,
    key: v.key,
    label: v.label,
    description: v.description,
    color: v.color,
    sort_order: String(v.sort_order),
    is_active: v.is_active,
    progress_weight: v.progress_weight == null ? '' : String(v.progress_weight),
  };
}

export function statusCreatePayload(form: StatusForm): Record<string, unknown> {
  return {
    record_type: form.record_type,
    key: form.key,
    label: form.label,
    description: form.description,
    color: form.color,
    sort_order: Number(form.sort_order),
    // progress_weight is never editable in create mode (the field only
    // renders when editing an existing asset row, and this
    // dropdown never creates one), so it's intentionally omitted here.
  };
}

// The server forbids unknown fields and treats "sent" as "set" — so send only
// what actually changed. is_active is a boolean: a falsy check would drop it.
export function statusUpdatePayload(
  form: StatusForm, original: StatusValue,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (form.label !== original.label) out.label = form.label;
  if (form.description !== original.description) {
    out.description = form.description;
  }
  if (form.color !== original.color) out.color = form.color;
  if (Number(form.sort_order) !== original.sort_order) {
    out.sort_order = Number(form.sort_order);
  }
  if (form.is_active !== original.is_active) out.is_active = form.is_active;
  // Only asset rows render this field; for any other record
  // type form.progress_weight stays at whatever statusFormFromValue seeded
  // it to, so it diffs to "unchanged" and never affects unrelated saves.
  const weight = parseProgressWeight(form.progress_weight);
  if (weight !== undefined && weight !== original.progress_weight) {
    out.progress_weight = weight;
  }
  return out;
}

// Once POST succeeds, a retry after a later failure must never re-create.
// Mirrors needsSiteCreate in lib/sites.ts.
export function needsStatusCreate(
  original: StatusValue | null, createdKey: string | null,
): boolean {
  return original === null && createdKey === null;
}

/* ── site types ───────────────────────────────────────────────────── */

export function siteTypeFormFromValue(v: SiteLookup): SiteTypeForm {
  return {
    key: v.key,
    label: v.label,
    description: v.description,
    sort_order: String(v.sort_order),
    icon: v.icon ?? '',
    // color is NOT NULL going forward, but SiteLookupOut still types it
    // nullable for rows that predate the hex migration — ColorField needs a
    // real string to display, so fall back to the first preset.
    color: v.color ?? PRESET_COLORS[0].value,
  };
}

// Same "send only what changed" contract as statusUpdatePayload. icon is the
// one nullable column (site_types.icon is Mapped[str | None]), so an emptied
// field sends an explicit null to CLEAR it — not '', which would put a
// semantically wrong empty string in a nullable column.
export function siteTypeUpdatePayload(
  form: SiteTypeForm, original: SiteLookup,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (form.label !== original.label) out.label = form.label;
  if (form.description !== original.description) out.description = form.description;
  if (Number(form.sort_order) !== original.sort_order) {
    out.sort_order = Number(form.sort_order);
  }
  const icon = form.icon.trim() === '' ? null : form.icon;
  if (icon !== (original.icon ?? null)) out.icon = icon;
  // Same fallback siteTypeFormFromValue seeds the field with, so a legacy
  // null-colour row the user never touched diffs to "unchanged" rather than
  // silently assigning it the first preset on every save.
  if (form.color !== (original.color ?? PRESET_COLORS[0].value)) out.color = form.color;
  return out;
}

export function siteTypeCreatePayload(form: SiteTypeForm): Record<string, unknown> {
  return {
    key: form.key,
    label: form.label,
    description: form.description,
    sort_order: Number(form.sort_order),
    icon: form.icon.trim() === '' ? null : form.icon,
    color: form.color,
  };
}

// Once POST succeeds, a retry after a later failure must never re-create.
// Mirrors needsStatusCreate.
export function needsSiteTypeCreate(
  original: SiteLookup | null, createdKey: string | null,
): boolean {
  return original === null && createdKey === null;
}

/* ── worker levels ────────────────────────────────────────────────── */

export function workerLevelFormFromValue(v: WorkerLevel): WorkerLevelForm {
  return {
    level: v.level,
    after: null,   // edit mode only ever reads this; create mode seeds it fresh
    title: v.title,
    description: v.description,
    expected_skills: [...v.expected_skills],
    color: v.color,
  };
}

function sameSkills(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

// The API forbids unknown fields on this endpoint (WorkerLevelUpdateIn uses
// extra="forbid"), so level/rank/after must never appear here.
export function workerLevelUpdatePayload(
  form: WorkerLevelForm, original: WorkerLevel,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (form.title !== original.title) out.title = form.title;
  if (form.description !== original.description) out.description = form.description;
  if (!sameSkills(form.expected_skills, original.expected_skills)) {
    out.expected_skills = form.expected_skills;
  }
  if (form.color !== original.color) out.color = form.color;
  return out;
}

export function workerLevelCreatePayload(form: WorkerLevelForm): Record<string, unknown> {
  return {
    level: form.level,
    title: form.title,
    description: form.description,
    expected_skills: form.expected_skills,
    color: form.color,
    after: form.after,
  };
}

// Once POST succeeds, a retry after a later failure must never re-create.
// Mirrors needsStatusCreate.
export function needsWorkerLevelCreate(
  original: WorkerLevel | null, createdKey: string | null,
): boolean {
  return original === null && createdKey === null;
}

/* ── asset categories ─────────────────────────────────────────────── */

export interface AssetCategoryForm {
  key: string;   // editable only in create mode; immutable (FK: asset_models.category) after
  label: string;
  description: string;
  sort_order: string;   // form state is a string; coerced on the way out
  color: string;
}

export function assetCategoryFormFromValue(v: AssetCategoryOut): AssetCategoryForm {
  return {
    key: v.key,
    label: v.label,
    description: v.description,
    sort_order: String(v.sort_order),
    color: v.color,
  };
}

export function assetCategoryCreatePayload(form: AssetCategoryForm): Record<string, unknown> {
  return {
    key: form.key,
    label: form.label,
    description: form.description,
    sort_order: Number(form.sort_order),
    color: form.color,
  };
}

// Same "send only what changed" contract as statusUpdatePayload.
export function assetCategoryUpdatePayload(
  form: AssetCategoryForm, original: AssetCategoryOut,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (form.label !== original.label) out.label = form.label;
  if (form.description !== original.description) out.description = form.description;
  if (Number(form.sort_order) !== original.sort_order) {
    out.sort_order = Number(form.sort_order);
  }
  if (form.color !== original.color) out.color = form.color;
  return out;
}

// Once POST succeeds, a retry after a later failure must never re-create.
export function needsAssetCategoryCreate(
  original: AssetCategoryOut | null, createdKey: string | null,
): boolean {
  return original === null && createdKey === null;
}

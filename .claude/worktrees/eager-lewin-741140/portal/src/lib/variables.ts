// Pure helpers for the Variables page. Kept out of the component so they can
// be tested without a live API — same convention as lib/sites.ts.
import type { SiteLookup, StatusValue, WorkerLevel } from './api';

export interface StatusForm {
  record_type: string;
  key: string;
  label: string;
  description: string;
  color: string;
  sort_order: string;   // form state is a string; coerced on the way out
  is_active: boolean;
}

export interface SiteTypeForm {
  label: string;
  description: string;
  sort_order: string;   // form state is a string; coerced on the way out
  icon: string;
}

export interface WorkerLevelForm {
  title: string;
  description: string;
  expected_skills: string[];
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
  return out;
}

// Once POST succeeds, a retry after a later failure must never re-create.
// Mirrors needsSiteCreate in lib/sites.ts.
export function needsStatusCreate(
  original: StatusValue | null, createdKey: string | null,
): boolean {
  return original === null && createdKey === null;
}

/* ── site types (edit-only) ──────────────────────────────────────── */

export function siteTypeFormFromValue(v: SiteLookup): SiteTypeForm {
  return {
    label: v.label,
    description: v.description,
    sort_order: String(v.sort_order),
    icon: v.icon ?? '',
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
  return out;
}

/* ── worker levels (edit-only) ───────────────────────────────────── */

export function workerLevelFormFromValue(v: WorkerLevel): WorkerLevelForm {
  return {
    title: v.title,
    description: v.description,
    expected_skills: [...v.expected_skills],
  };
}

function sameSkills(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

// The API forbids unknown fields on this endpoint (WorkerLevelUpdateIn uses
// extra="forbid"), so level/rank must never appear here.
export function workerLevelUpdatePayload(
  form: WorkerLevelForm, original: WorkerLevel,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (form.title !== original.title) out.title = form.title;
  if (form.description !== original.description) out.description = form.description;
  if (!sameSkills(form.expected_skills, original.expected_skills)) {
    out.expected_skills = form.expected_skills;
  }
  return out;
}

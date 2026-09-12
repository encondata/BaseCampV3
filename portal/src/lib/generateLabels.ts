/**
 * Pure helpers for the Generate Labels page and the template editor's
 * Generation rules panel — no React/DOM dependencies, so they're
 * trivially unit-testable and reusable from both places.
 */
import type {
  InitiativeItem, LabelGeneratePreviewType, LabelGenerationRules, LabelRun, LabelTemplateCandidate,
} from './api';

/** Seeded `status_values` keys (record_type=initiative, migration 0016)
 *  that mean "nothing left to generate labels for" — mirrors the
 *  `archived_at` check every other initiative picker already does, plus
 *  the two finished-work statuses V2's own move picker hid. */
export const HIDDEN_INITIATIVE_STATUSES = new Set(['completed', 'cancelled', 'canceled']);

/** Initiatives worth showing in the Generate Labels picker: not archived,
 *  not finished, newest first. */
export function visibleInitiativesForGenerate(items: InitiativeItem[]): InitiativeItem[] {
  return items
    .filter((i) => !i.archived_at && !HIDDEN_INITIATIVE_STATUSES.has(i.status))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

/** Generate is reachable only once an initiative and at least one label
 *  type are picked, only when that initiative has no run already
 *  queued/running (the API's own 409 `run_active` backs this up — this is
 *  just the button gating so the operator sees why up front), and only
 *  once every selected type has a resolved template (`unresolvedType` is
 *  the first selected type still missing one, from `firstUnresolvedType`
 *  below — normally the per-type row's own disabled state already keeps
 *  an unresolved type out of `labelTypes`, but a type can still land here
 *  unresolved if it was checked before the preview loaded and then
 *  resolved to "no auto-match", so Generate double-checks rather than
 *  trusting the row alone). */
export function canGenerate({ initiativeId, labelTypes, activeRunId, unresolvedType = null }: {
  initiativeId: string | null; labelTypes: string[]; activeRunId: string | null;
  unresolvedType?: string | null;
}): boolean {
  return !!initiativeId && labelTypes.length > 0 && !activeRunId && !unresolvedType;
}

/** A run in flight — used to gate Generate/show Cancel/keep the progress
 *  panel and poll alive. */
export function isRunActive(run: Pick<LabelRun, 'status'> | null): boolean {
  return !!run && (run.status === 'queued' || run.status === 'running');
}

/** Prefer the server's own `progress_pct` (it may account for things the
 *  client doesn't, e.g. a type with no template counted as errors); fall
 *  back to processed/total for a run shape that omits it. */
export function progressPct(run: { progress_pct?: number | null; processed: number; total: number }): number {
  if (typeof run.progress_pct === 'number' && Number.isFinite(run.progress_pct)) {
    return Math.max(0, Math.min(100, run.progress_pct));
  }
  if (!run.total) return 0;
  return Math.max(0, Math.min(100, Math.round((run.processed / run.total) * 100)));
}

// ── Per-type template resolution (Label types card / Generate gating) ─

/** The scope sub-line shown beside a template candidate in the "Choose a
 *  template…" combo — `'other'` names the sites it IS linked to (never
 *  this initiative's own site, or it'd already be a `'site'` candidate). */
export function candidateScopeText(c: Pick<LabelTemplateCandidate, 'scope' | 'site_names'>): string {
  if (c.scope === 'site') return 'This site';
  if (c.scope === 'global') return 'Global';
  return `Linked to other sites: ${c.site_names.join(', ')}`;
}

/** The template id that will actually be used for one type: an explicit
 *  override (operator picked it, whether or not there was an auto-match)
 *  wins over the preview's own auto-match; `null` when neither exists —
 *  the type isn't resolved yet. */
export function resolvedTemplateId(
  type: Pick<LabelGeneratePreviewType, 'template'> | undefined,
  overrideId: string | undefined,
): string | null {
  return overrideId ?? type?.template?.id ?? null;
}

/** The first selected type with no resolved template, in selection order
 *  — names the type Generate's gating hint should point at, or `null`
 *  once every selected type is resolved (including when `types` hasn't
 *  loaded yet, since there's nothing to judge against). */
export function firstUnresolvedType(
  types: LabelGeneratePreviewType[] | null,
  selected: string[],
  overrides: Record<string, string>,
): string | null {
  if (!types) return null;
  for (const key of selected) {
    const type = types.find((t) => t.key === key);
    if (!resolvedTemplateId(type, overrides[key])) return key;
  }
  return null;
}

/** `startLabelRun`'s own `templates` body field: only the types the
 *  operator resolved themselves belong here — an auto-matched type with
 *  no override is omitted entirely (the server already knows its
 *  template), which is exactly every key present in `overrides` since an
 *  override is the only way a value ever lands there, whether it replaced
 *  an auto-match or supplied one that didn't exist. */
export function templatesPayloadFor(
  selected: string[], overrides: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of selected) {
    if (overrides[key]) out[key] = overrides[key];
  }
  return out;
}

/** Error-type summary rows, busiest first (ties broken alphabetically so
 *  repeated renders are stable). */
export function sortedErrorSummary(summary: Record<string, number>): [string, number][] {
  return Object.entries(summary).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** True once the run carries more errors than the (server-capped, first
 *  50) `error_details` array holds — the "only the first 50 are shown"
 *  note's condition. */
export function hasHiddenErrors(run: Pick<LabelRun, 'errors' | 'error_details'>): boolean {
  return run.errors > run.error_details.length;
}

// ── Generation rules (template editor panel) ─────────────────────────

/** A template's `generation_rules` JSON, as PATCHed/returned by the API —
 *  same shape as `LabelTemplate.generation_rules` (api.ts); aliased here
 *  under the name this file's own helpers were written against, rather
 *  than keeping two separate interfaces for one shape. */
export type GenerationRulesJson = LabelGenerationRules;

export interface PositionRuleRow { position: string; token: string }
export interface LimitRuleRow { token: string; limit: string }

/** The panel's own row-editor shape — kept as strings (even the limit)
 *  so a half-typed input never fights the control. */
export interface GenerationRulesRows {
  destination: PositionRuleRow[];
  source: PositionRuleRow[];
  lengthLimits: LimitRuleRow[];
}

/** Token keys are validated `[a-z0-9_]+` (spec's own rule, matching the
 *  placeholder syntax they're substituted into). */
export const TOKEN_PATTERN = /^[a-z0-9_]+$/;

export function isValidToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

export function jsonToRuleRows(rules: GenerationRulesJson | null | undefined): GenerationRulesRows {
  const positions = (m?: Record<string, string>): PositionRuleRow[] =>
    Object.entries(m ?? {}).map(([position, token]) => ({ position, token }));
  const limits = (m?: Record<string, number>): LimitRuleRow[] =>
    Object.entries(m ?? {}).map(([token, limit]) => ({ token, limit: String(limit) }));
  return {
    destination: positions(rules?.destination),
    source: positions(rules?.source),
    lengthLimits: limits(rules?.length_limits),
  };
}

/** Drops blank rows (an untouched "+ Add" row) and trims the rest — the
 *  inverse of `jsonToRuleRows`, modulo row order within an object (JSON
 *  objects have no order of their own). */
export function ruleRowsToJson(rows: GenerationRulesRows): GenerationRulesJson {
  const out: GenerationRulesJson = {};
  const destination = Object.fromEntries(
    rows.destination
      .filter((r) => r.position.trim() && r.token.trim())
      .map((r) => [r.position.trim(), r.token.trim()]),
  );
  const source = Object.fromEntries(
    rows.source
      .filter((r) => r.position.trim() && r.token.trim())
      .map((r) => [r.position.trim(), r.token.trim()]),
  );
  const length_limits = Object.fromEntries(
    rows.lengthLimits
      .filter((r) => r.token.trim() && r.limit.trim())
      .map((r) => [r.token.trim(), Number(r.limit)]),
  );
  if (Object.keys(destination).length) out.destination = destination;
  if (Object.keys(source).length) out.source = source;
  if (Object.keys(length_limits).length) out.length_limits = length_limits;
  return out;
}

/** First problem found among the NON-blank rows, or `null` when every row
 *  that's been touched is well-formed. A row with nothing typed in either
 *  of its fields yet is ignored — it's just an empty "+ Add" row. */
export function validateRuleRows(rows: GenerationRulesRows): string | null {
  for (const r of [...rows.destination, ...rows.source]) {
    if (!r.position.trim() && !r.token.trim()) continue;
    if (!r.position.trim() || !/^[1-9][0-9]*$/.test(r.position.trim())) {
      return `Position "${r.position}" must be a positive whole number.`;
    }
    if (!isValidToken(r.token.trim())) {
      return `Token "${r.token}" must be lowercase letters, numbers, or underscores.`;
    }
  }
  for (const r of rows.lengthLimits) {
    if (!r.token.trim() && !r.limit.trim()) continue;
    if (!isValidToken(r.token.trim())) {
      return `Token "${r.token}" must be lowercase letters, numbers, or underscores.`;
    }
    if (!/^[1-9][0-9]*$/.test(r.limit.trim())) {
      return `Length limit for "${r.token}" must be a positive whole number.`;
    }
  }
  return null;
}

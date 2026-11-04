/**
 * The web kiosk's label build, store-free: the shared generator
 * (`labelgen`, the byte-for-byte port of the laptop edge's Python) run over
 * a whole move, the part of the edge's label runner (`changed_jobs`,
 * `render_job` per job, `prune`) that needs no database.
 *
 * Pure, like `labelgen` itself: no IndexedDB, no DOM, no React. It runs
 * inside the label Web Worker (`worker.ts`) so a move of thousands of
 * assets never freezes the page, and in-thread only where there is no
 * `Worker` (jsdom under the tests). `labelBuild.ts` does the reading and
 * writing on the main thread around it.
 *
 * Only labels whose fingerprint changed are rendered: `previous` maps each
 * stored label's asset id to the fingerprint it was made with, and a job
 * whose fingerprint equals it is left alone. `renderLabels` parses both
 * whole bodies on every call, so the changed jobs go through it in
 * batches (500 by default), not one by one.
 *
 * Also the worker's message protocol, so the worker and the page share one
 * definition of it.
 */

import {
  buildPlan, renderLabels, type Plan, type PlanInput, type RenderResult,
} from '../../labelgen/plan';

/** How many labels one `renderLabels` call renders (each call parses
 *  both bodies, so one call per label would parse them thousands of times). */
export const BATCH_SIZE = 500;

export interface LabelSet {
  plan: Plan;
  /** Only the jobs whose fingerprint differs from `previous`, in plan order. */
  rendered: RenderResult[];
  /** Asset ids in `previous` that are no longer on the move; `[]` when the
   *  plan has no asset data (no jobs for want of data must prune nothing). */
  removed: string[];
}

/**
 * The move's labels that need making. `previous` is asset id -> the
 * fingerprint of its stored label. `onProgress(done, total)` is called
 * with 0 before the first batch and after every batch, `total` being the
 * number of labels to render; it is never called when there are none, so
 * a sync that changed no label shows no progress at all.
 *
 * An asset the move lists twice takes its last row (as `renderLabels`
 * does), and is rendered once.
 */
export function buildLabelSet(
  input: PlanInput,
  previous: ReadonlyMap<string, string>,
  onProgress?: (done: number, total: number) => void,
  batchSize = BATCH_SIZE,
): LabelSet {
  const plan = buildPlan(input);
  // id -> the fingerprint of its LAST job: insertion order is the first
  // sighting, the value the last (what renderLabels gives that asset)
  const latest = new Map<string, string>();
  for (const job of plan.jobs) latest.set(job.assetId, job.fingerprint);
  const changed = [...latest].filter(([id, fp]) => previous.get(id) !== fp).map(([id]) => id);

  const rendered: RenderResult[] = [];
  const total = changed.length;
  const size = Math.max(1, Math.floor(batchSize));
  if (total > 0) onProgress?.(0, total);
  for (let at = 0; at < total; at += size) {
    rendered.push(...renderLabels(input, changed.slice(at, at + size)));
    onProgress?.(Math.min(at + size, total), total);
  }

  const removed = plan.hasAssetData ? [...previous.keys()].filter((id) => !latest.has(id)) : [];
  return { plan, rendered, removed };
}

/** The plan alone (which template, its fonts and notes, the DPIs that have
 *  one), for the printer setup's DPI check. */
export function planOnly(input: PlanInput): Plan {
  return buildPlan(input);
}

/**
 * The `name` of the template `templateId` in the raw templates body the
 * labels were built from (the last one with that id, as the generator
 * picks it), or null when there is none or the body can't be read. A
 * plain `JSON.parse` is fine here: a name is text, and nothing parsed
 * here goes back into a label.
 */
export function templateName(templatesJson: string, templateId: string | null): string | null {
  if (templateId === null) return null;
  let body: unknown;
  try {
    body = JSON.parse(templatesJson);
  } catch {
    return null;
  }
  const list = (body as { templates?: unknown } | null)?.templates;
  if (!Array.isArray(list)) return null;
  let name: string | null = null;
  for (const t of list) {
    if (t === null || typeof t !== 'object') continue;
    const { id, name: n } = t as { id?: unknown; name?: unknown };
    if (id !== undefined && id !== null && String(id) === templateId) {
      name = typeof n === 'string' ? n : null;
    }
  }
  return name;
}

/** What a build hands back to the page: the label set and the name of the
 *  template it was made with. */
export interface LabelBuildResult extends LabelSet {
  templateName: string | null;
}

/** One build, as both the worker and the in-thread runner run it. */
export function runBuild(
  input: PlanInput,
  previous: ReadonlyMap<string, string>,
  onProgress?: (done: number, total: number) => void,
): LabelBuildResult {
  const set = buildLabelSet(input, previous, onProgress);
  return { ...set, templateName: templateName(input.templatesJson, set.plan.templateId) };
}

// ── the worker's message protocol ───────────────────────────────────

/** To the worker. `previous` crosses as a Map (structured clone keeps it). */
export type WorkerRequest =
  | { type: 'build'; id: number; input: PlanInput; previous: ReadonlyMap<string, string> }
  | { type: 'plan'; id: number; input: PlanInput };

/** From the worker: progress while a build renders, then exactly one
 *  `result` (a build's carries the label set, a plan's only `plan`) or
 *  `error`. */
export type WorkerResponse =
  | { type: 'progress'; id: number; done: number; total: number }
  | ({ type: 'result'; id: number; plan: Plan } & Partial<Omit<LabelBuildResult, 'plan'>>)
  | { type: 'error'; id: number; message: string };

/** An error's message for the status (and the worker's `error` reply). */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

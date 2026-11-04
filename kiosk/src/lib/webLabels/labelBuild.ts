/**
 * The web kiosk's label build: every asset's label made ahead of time with
 * the shared generator (`labelgen`, the port of the laptop's Python) and
 * kept in IndexedDB, so a scan prints from a stored label with no API call
 * and no rendering in the print path. The laptop's edge does the same in
 * Python (edge/labels/runner.py); this is that runner for a browser.
 *
 * A build needs three things, or it is not attempted and the status sits
 * idle with nothing counted:
 *   - label settings with a printer and its DPI (`readWebLabelSettings`),
 *   - a set-up move (`readKioskSetup`),
 *   - both raw sync bodies (`assets_raw`, `label_templates_raw`) belonging
 *     to that move. A missing body (a kiosk upgraded from IndexedDB v6
 *     that hasn't synced since) or one for another move is "not
 *     downloaded yet": the parsed rows are never re-serialized as a
 *     stand-in, since the generator must read the API's exact text.
 *
 * The build key is (move, kind, DPI, the generator's `SOURCE_HASH`, a hash
 * of each body). It is stored in the `labels` meta row with the counts;
 * when a request's key matches it, nothing is rebuilt. Offsets and peel
 * are not in it: they are applied when a label is sent. Inside a build,
 * only labels whose fingerprint changed are rendered (`buildCore`); a row
 * made for another move, kind or DPI, or by another generator, counts as
 * changed, and removed assets' rows are deleted. Everything (changed rows,
 * deletions, meta) is written in one transaction at the end, and only if
 * both bodies are still the ones it was built from (`writeLabelSet`): a
 * Clear local data mid-build leaves nothing behind.
 *
 * Builds run in a Web Worker (`worker.ts`, one per call) so the page never
 * freezes; where there is no `Worker` (jsdom) they run in-thread. A newer
 * request supersedes a running build (its worker is terminated and its
 * result never written), except one with the very same key, which it
 * simply waits for. A build superseded with its write already in flight
 * may still land, so it then asks once more: the newer request decided on
 * the meta from before that commit. While a sync is running nothing
 * builds: the sync's end asks again, so a build never reads a
 * half-replaced pair of bodies.
 *
 * The status reuses the edge's `LabelRunStatus` shape, so the laptop's
 * screens (the yellow takeover, the Printing Station header) read it
 * unchanged: `state` is 'running' only while labels are being rendered (a
 * build with nothing to render never shows); `reason` is 'setup' for the
 * first build for a move and 'updates' after; `total`/`done` are the last
 * finished run's (kept while idle, as the edge keeps them); `ready`,
 * `errors` and `unsupported` count the stored labels. `error` says why the
 * last build failed, until the next one.
 *
 * Web only: `installLabelBuild()` is called from main.tsx when the kiosk
 * is not the laptop, whose labels come from its edge.
 */

import { useSyncExternalStore } from 'react';

import { fingerprint, type Plan, type PlanInput } from '../../labelgen/plan';
import { SOURCE_HASH } from '../../labelgen/sourceHash';
import type { LabelKind, LabelRunStatus } from '../api';
import { readKioskSetup } from '../kioskSetup';
import {
  getAll, readMeta, readRawBody, writeLabelSet, type MetaRow, type RawBodyRow,
} from '../localDb';
import { readSyncStatus, subscribeSyncStatus } from '../sync';
import { readWebLabelSettings, subscribeWebLabelSettings } from '../webLabelSettings';
import {
  errorMessage, planOnly, runBuild, type LabelBuildResult, type WorkerRequest, type WorkerResponse,
} from './buildCore';

// ── shapes ──────────────────────────────────────────────────────────

export type WebLabelStatus = LabelRunStatus & { error?: string };

/** One stored label (`labels` store, keyPath `asset_id`). `zpl` is null
 *  and `error` the generator's outcome (`no_template_at_dpi`,
 *  `template_failed`, `template_unsupported`) when no label could be made. */
export interface WebLabelRow {
  asset_id: string;
  zpl: string | null;
  error: string | null;
  fingerprint: string;
  /** '' when no template was picked. */
  template_name: string;
  dpi: number;
  label_kind: LabelKind;
  initiativeId: string;
}

/** The `meta` row of the stored build. */
export const LABELS_META_KEY = 'labels';

/** The build key (the first six fields) and what the build made. `total`
 *  is the stored labels (`ready + errors`); `problems` counts the errors
 *  by outcome; `notes` are the plan's pick notes. */
export type WebLabelMeta = {
  initiativeId: string;
  kind: LabelKind;
  dpi: number;
  sourceHash: string;
  assetsHash: string;
  templatesHash: string;
  total: number;
  ready: number;
  errors: number;
  unsupported: number;
  problems: Record<string, number>;
  notes: string[];
  templateName: string | null;
  builtAt: string;
};

type BuildKey = Pick<WebLabelMeta,
  'initiativeId' | 'kind' | 'dpi' | 'sourceHash' | 'assetsHash' | 'templatesHash'>;

const KEY_FIELDS: readonly (keyof BuildKey)[] = [
  'initiativeId', 'kind', 'dpi', 'sourceHash', 'assetsHash', 'templatesHash',
];

// ── runners ─────────────────────────────────────────────────────────

/** A build in progress: its result, and a way to stop it (the result then
 *  rejects, and nothing it made is used). */
export interface LabelBuildJob {
  result: Promise<LabelBuildResult>;
  cancel(): void;
}

/** Where `buildCore` runs: a Web Worker by default, in-thread without one;
 *  tests may inject their own (`setLabelBuildRunner`). */
export interface LabelBuildRunner {
  build(input: PlanInput, previous: ReadonlyMap<string, string>,
    onProgress: (done: number, total: number) => void): LabelBuildJob;
  plan(input: PlanInput): Promise<Plan>;
}

/** A canceled build's rejection. */
class Superseded extends Error {
  constructor() {
    super('superseded by a newer label build');
    this.name = 'Superseded';
  }
}

/** `buildCore` on this thread: where there is no `Worker` (jsdom), and
 *  the base the tests wrap. It can't stop a render part-way; cancel only
 *  makes its result reject. */
export const inThreadLabelBuildRunner: LabelBuildRunner = {
  build(input, previous, onProgress) {
    let canceled = false;
    const result = Promise.resolve().then(() => {
      if (canceled) throw new Superseded();
      const built = runBuild(input, previous, (done, total) => {
        if (!canceled) onProgress(done, total);
      });
      if (canceled) throw new Superseded();
      return built;
    });
    return { result, cancel: () => { canceled = true; } };
  },
  plan: async (input) => planOnly(input),
};

let nextCallId = 0;

type WorkerResult = Extract<WorkerResponse, { type: 'result' }>;

/** One worker for one call: started, asked, terminated once it answers
 *  (or when canceled, which really does stop it mid-render). */
function workerCall(
  request: (id: number) => WorkerRequest,
  onProgress?: (done: number, total: number) => void,
): { result: Promise<WorkerResult>; cancel(): void } {
  const id = ++nextCallId;
  let fail: (err: Error) => void = () => undefined;
  const result = new Promise<WorkerResult>((resolve, reject) => {
    // A Worker that can't even be made (a policy forbidding it) throws
    // here, which rejects this promise like any other worker failure.
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    fail = (err) => {
      worker.terminate();
      reject(err);
    };
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data;
      if (msg.id !== id) return;
      if (msg.type === 'progress') {
        onProgress?.(msg.done, msg.total);
        return;
      }
      worker.terminate();
      if (msg.type === 'result') resolve(msg);
      else reject(new Error(msg.message));
    };
    worker.onerror = (event) => {
      event.preventDefault();
      fail(new Error(event.message || 'the label worker failed to run'));
    };
    worker.onmessageerror = () => fail(new Error('the label worker sent an unreadable reply'));
    worker.postMessage(request(id));
  });
  return { result, cancel: () => fail(new Superseded()) };
}

const workerRunner: LabelBuildRunner = {
  build(input, previous, onProgress) {
    const call = workerCall((id) => ({ type: 'build', id, input, previous }), onProgress);
    return {
      result: call.result.then((m) => ({
        plan: m.plan, rendered: m.rendered ?? [], removed: m.removed ?? [],
        templateName: m.templateName ?? null,
      })),
      cancel: call.cancel,
    };
  },
  plan: (input) => workerCall((id) => ({ type: 'plan', id, input })).result.then((m) => m.plan),
};

let runnerOverride: LabelBuildRunner | null = null;

/** Test seam: the runner every later build and plan uses; null restores
 *  the default (a module Web Worker, or in-thread without `Worker`). */
export function setLabelBuildRunner(runner: LabelBuildRunner | null): void {
  runnerOverride = runner;
}

function runner(): LabelBuildRunner {
  if (runnerOverride) return runnerOverride;
  return typeof Worker === 'undefined' ? inThreadLabelBuildRunner : workerRunner;
}

// ── the status store ────────────────────────────────────────────────

const IDLE: WebLabelStatus = {
  state: 'idle', reason: null, total: 0, done: 0, ready: 0, errors: 0, unsupported: 0,
};

interface Counts { ready: number; errors: number; unsupported: number }
type Run = Pick<WebLabelStatus, 'reason' | 'total' | 'done'>;

const NO_COUNTS: Counts = { ready: 0, errors: 0, unsupported: 0 };
const NO_RUN: Run = { reason: null, total: 0, done: 0 };

let status: WebLabelStatus = IDLE;
/** The last run that finished rendering: what an idle status reports. */
let lastRun: Run = NO_RUN;
const listeners = new Set<() => void>();

const STATUS_FIELDS: readonly (keyof WebLabelStatus)[] = [
  'state', 'reason', 'total', 'done', 'ready', 'errors', 'unsupported', 'error',
];

/** Replaces the snapshot and tells subscribers, unless nothing changed
 *  (useSyncExternalStore re-renders on every new object). */
function setStatus(next: WebLabelStatus): void {
  if (STATUS_FIELDS.every((k) => status[k] === next[k])) return;
  status = next;
  listeners.forEach((fn) => fn());
}

/** Nothing to build from: idle, nothing counted, no run remembered. */
function setNothing(): void {
  lastRun = NO_RUN;
  setStatus(IDLE);
}

export function readWebLabelStatus(): WebLabelStatus {
  return status;
}

export function subscribeWebLabelStatus(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useWebLabelStatus(): WebLabelStatus {
  return useSyncExternalStore(subscribeWebLabelStatus, readWebLabelStatus);
}

// ── the build ───────────────────────────────────────────────────────

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function countsOf(meta: MetaRow): Counts {
  return { ready: num(meta.ready), errors: num(meta.errors), unsupported: num(meta.unsupported) };
}

function keyMatches(meta: MetaRow, key: BuildKey): boolean {
  return KEY_FIELDS.every((k) => meta[k] === key[k]);
}

/** The stored labels' counts, as the edge's status counts its table. */
function tally(rows: Iterable<Pick<WebLabelRow, 'zpl' | 'error'>>):
  Counts & { total: number; problems: Record<string, number> } {
  let ready = 0;
  let errors = 0;
  const problems: Record<string, number> = {};
  for (const row of rows) {
    if (row.error === null && row.zpl !== null) {
      ready += 1;
    } else {
      errors += 1;
      const why = row.error ?? 'template_failed';
      problems[why] = (problems[why] ?? 0) + 1;
    }
  }
  return {
    total: ready + errors, ready, errors, unsupported: problems.template_unsupported ?? 0, problems,
  };
}

/** A stored row's fingerprint that can never match a job's (those are 14
 *  hex digits): the row was made for another move, kind or DPI, or by
 *  another generator, so it is rendered again (or removed). */
const STALE = '';

interface ActiveBuild {
  keyText: string;
  job: LabelBuildJob | null;
  done: Promise<void>;
}

let active: ActiveBuild | null = null;
let requestSeq = 0;
let latest: Promise<void> = Promise.resolve();

/** Stops the running build, if any; its result is never written. */
function stopActive(): void {
  const running = active;
  active = null;
  running?.job?.cancel();
}

/**
 * Brings the stored labels up to date with the settings, the set-up move
 * and the downloaded bodies (see the module comment for when that means
 * nothing at all). Resolves once they are, or once a newer request has
 * taken over and done the same. Never rejects: a failure is the status's
 * `error`.
 */
export function requestLabelBuild(): Promise<void> {
  const seq = ++requestSeq;
  const decided = decide(seq);
  latest = decided;
  return decided;
}

async function decide(seq: number): Promise<void> {
  if (readSyncStatus().phase === 'running') {
    // the sync is replacing the bodies: its end asks again
    stopActive();
    setStatus({ ...status, state: 'idle', ...lastRun });
    return;
  }
  const settings = readWebLabelSettings();
  const moveId = readKioskSetup()?.initiativeId ?? '';
  if (settings === null || moveId === '') {
    stopActive();
    setNothing();
    return;
  }

  let assets: RawBodyRow | null;
  let templates: RawBodyRow | null;
  let meta: MetaRow | null;
  try {
    [assets, templates, meta] = await Promise.all([
      readRawBody('assets_raw'), readRawBody('label_templates_raw'), readMeta(LABELS_META_KEY),
    ]);
  } catch (err) {
    if (seq !== requestSeq) return latest;
    stopActive();
    lastRun = NO_RUN;
    setStatus({ ...IDLE, error: errorMessage(err) });
    return;
  }
  if (seq !== requestSeq) return latest;   // a newer request decides instead
  if (assets === null || templates === null
      || assets.initiativeId !== moveId || templates.initiativeId !== moveId) {
    stopActive();
    setNothing();
    return;
  }

  const key: BuildKey = {
    initiativeId: moveId, kind: settings.label_kind, dpi: settings.dpi, sourceHash: SOURCE_HASH,
    assetsHash: fingerprint([assets.text]), templatesHash: fingerprint([templates.text]),
  };
  if (meta !== null && keyMatches(meta, key)) {
    stopActive();
    setStatus({ state: 'idle', ...lastRun, ...countsOf(meta) });
    return;
  }
  const keyText = JSON.stringify(KEY_FIELDS.map((k) => key[k]));
  if (active !== null && active.keyText === keyText) return active.done;
  stopActive();
  return startBuild(key, keyText, assets, templates, meta);
}

function startBuild(
  key: BuildKey, keyText: string, assets: RawBodyRow, templates: RawBodyRow, meta: MetaRow | null,
): Promise<void> {
  const sameMove = meta !== null && meta.initiativeId === key.initiativeId;
  const reason = sameMove ? 'updates' : 'setup';
  // what the store holds while this build runs (it writes only at the end)
  const before: Counts = sameMove ? countsOf(meta) : NO_COUNTS;
  const me: ActiveBuild = { keyText, job: null, done: Promise.resolve() };
  active = me;

  const fail = (err: unknown): void => {
    if (active !== me) return;            // superseded: someone else owns the status
    active = null;
    setStatus({ state: 'idle', ...lastRun, ...before, error: errorMessage(err) });
  };

  me.done = (async () => {
    try {
      const rows = await getAll<WebLabelRow>('labels');
      if (active !== me) return;
      const fresh = meta !== null && meta.sourceHash === SOURCE_HASH;
      const previous = new Map(rows.map((r) => [r.asset_id,
        fresh && r.initiativeId === key.initiativeId && r.label_kind === key.kind && r.dpi === key.dpi
          ? r.fingerprint : STALE]));

      const job = runner().build(
        { assetsJson: assets.text, templatesJson: templates.text, kind: key.kind, dpi: key.dpi },
        previous,
        (done, total) => {
          if (active === me) setStatus({ state: 'running', reason, total, done, ...before });
        });
      me.job = job;
      const result = await job.result;
      if (active !== me) return;

      const put: WebLabelRow[] = result.rendered.map((r) => ({
        asset_id: r.assetId, zpl: r.zpl, error: r.outcome === 'ok' ? null : r.outcome,
        fingerprint: r.fingerprint, template_name: result.templateName ?? '', dpi: key.dpi,
        label_kind: key.kind, initiativeId: key.initiativeId,
      }));
      // the stored set as it will be: still-current rows, less the
      // removed, plus the new (a stale row left in place is not counted)
      const after = new Map<string, Pick<WebLabelRow, 'zpl' | 'error'>>();
      for (const r of rows) if (previous.get(r.asset_id) !== STALE) after.set(r.asset_id, r);
      for (const id of result.removed) after.delete(id);
      for (const r of put) after.set(r.asset_id, r);
      const counts = tally(after.values());
      const value: WebLabelMeta = {
        ...key, ...counts, notes: result.plan.notes, templateName: result.templateName,
        builtAt: new Date().toISOString(),
      };

      const wrote = await writeLabelSet({
        builtFrom: { assets, templates }, put, remove: result.removed,
        meta: { key: LABELS_META_KEY, value },
      });
      if (active !== me) {
        // Superseded while the write was in flight, and it landed anyway.
        // Whoever superseded this build decided on the meta from BEFORE
        // the commit: one that skipped (DPI 203 -> 300 -> 203 with the 300
        // write in flight) left the store holding this build's rows. Ask
        // again now that the meta says what the store really holds.
        if (wrote) return requestLabelBuild();
        return;
      }
      active = null;
      if (!wrote) {
        // wiped, or a sync replaced a body: nothing of this build is kept
        setNothing();
        return;
      }
      if (put.length > 0) lastRun = { reason, total: put.length, done: put.length };
      setStatus({
        state: 'idle', ...lastRun, ready: counts.ready, errors: counts.errors,
        unsupported: counts.unsupported,
      });
    } catch (err) {
      fail(err);
    }
  })();
  return me.done;
}

/**
 * The plan for `dpi` and `kind` from the stored bodies (which template,
 * its fonts and notes, the DPIs that have one), through the same runner as
 * the build; null unless both bodies are downloaded for the set-up move.
 */
export async function requestLabelPlan(opts: { dpi: number; kind: LabelKind }): Promise<Plan | null> {
  const moveId = readKioskSetup()?.initiativeId ?? '';
  if (moveId === '') return null;
  const [assets, templates] = await Promise.all([
    readRawBody('assets_raw'), readRawBody('label_templates_raw'),
  ]);
  if (assets === null || templates === null
      || assets.initiativeId !== moveId || templates.initiativeId !== moveId) return null;
  return runner().plan({
    assetsJson: assets.text, templatesJson: templates.text, kind: opts.kind, dpi: opts.dpi,
  });
}

/** What of the label settings a build depends on: whether a printer is
 *  saved, the kind and the DPI. Offsets and peel are applied when a label
 *  is sent, so a save that changes only those is not a reason to look. */
function buildSettings(): string | null {
  const settings = readWebLabelSettings();
  return settings === null ? null : `${settings.label_kind}:${settings.dpi}`;
}

/**
 * Starts the web kiosk's label builds: one now, one whenever the label
 * settings a build depends on change (a printer saved, or another kind or
 * DPI; an offsets-or-peel save asks nothing, so it never reads and hashes
 * the bodies), and one whenever the sync's phase changes (a finished sync
 * brings new bodies; a starting one stops any build; a Clear local data
 * resets it, and then finds nothing to build). Returns the uninstaller.
 */
export function installLabelBuild(): () => void {
  let phase = readSyncStatus().phase;
  const offSync = subscribeSyncStatus(() => {
    const next = readSyncStatus().phase;
    if (next === phase) return;
    phase = next;
    void requestLabelBuild();
  });
  let seen = buildSettings();
  const offSettings = subscribeWebLabelSettings(() => {
    const next = buildSettings();
    if (next === seen) return;
    seen = next;
    void requestLabelBuild();
  });
  void requestLabelBuild();
  return () => {
    offSync();
    offSettings();
  };
}

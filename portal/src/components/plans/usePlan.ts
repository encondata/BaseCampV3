/**
 * The plan tab's one source of truth: the plan, its outline, every write,
 * undo/redo and noticing someone else's change. Components drive the plan
 * only through the PlanController this returns.
 *
 * Every write goes through one queue, so each batch sends the version the
 * write before it answered: two edits typed quickly never collide into a
 * self-inflicted 409 `plan_changed`. A 409 `plan_changed` means someone
 * else changed the plan: it reloads, clears undo (spec: a refresh clears
 * the undo stack) and says so; the edit is not applied on top. Any other
 * failure leaves the plan as it was, so a cell shows its old value.
 *
 * The version poll (every 30 s while the page is visible) reloads at once
 * when the version moved past ours, unless someone is editing
 * (`setEditing(true)`): then `staleBy` says so and the reload waits until
 * editing ends.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useToast } from '../../lib/notificationsContext';
import {
  clearBaseline as apiClearBaseline,
  createPlan,
  deletePlan,
  getPlan,
  getPlanVersion,
  lockPlan,
  patchPlan,
  postOps,
  setBaseline as apiSetBaseline,
  unlockPlan,
  updateProject as apiUpdateProject,
  type Op,
  type OpsResult,
  type Plan,
  type PlanPatch,
  type UpdateProjectBody,
} from '../../lib/plans/api';
import { failureOf, withConfirm, type ApplyResult } from '../../lib/plans/applyResult';
import { PLAN_ERRORS, planErrorDetail, planErrorText } from '../../lib/plans/errors';
import { mergeOps, planView, type PlanView } from '../../lib/plans/merge';
import type { Outline } from '../../lib/plans/outline';
import { UndoStack, type UndoEntry } from '../../lib/plans/undo';
import { WriteQueue } from '../../lib/plans/writeQueue';

export type { ApplyResult } from '../../lib/plans/applyResult';

export const POLL_MS = 30_000;
export const PLAN_CHANGED_TOAST = 'This plan was changed by someone else — reloaded.';
const UPDATE_PROJECT_LABEL = 'Update Project';

export type PlanStatus = 'loading' | 'none' | 'ready' | 'error';

export interface ApplyOptions {
  /** Resend after a `completion_confirm`: every completing op confirms. */
  confirm?: boolean;
  /** Undo this batch with the step on top (a paste's second batch). */
  joinUndo?: boolean;
}

/** A PATCH body; the controller sends the version it holds as `base_version`. */
export type PlanPatchFields = Omit<PlanPatch, 'base_version'> & { base_version?: number };

export interface PlanController {
  status: PlanStatus;
  plan: Plan | null;                 // tasks/links merged after every op
  outline: Outline;
  error: string;                     // load error text
  busy: boolean;                     // a write is queued or in flight
  apply(ops: Op[], label: string, opts?: ApplyOptions): Promise<ApplyResult>;
  undo(): Promise<void>;             // a refusal is a toast; the step stays
  redo(): Promise<void>;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;          // the step Undo takes back ("Indent")
  redoLabel: string | null;
  // these reject with the API's error (word it with planErrorText)
  patch(p: PlanPatchFields): Promise<void>;
  lock(): Promise<void>;
  unlock(): Promise<void>;
  setBaseline(replace: boolean): Promise<ApplyResult>;
  clearBaseline(): Promise<void>;
  updateProject(body: UpdateProjectBody): Promise<ApplyResult>;
  create(body: { project_start: string; template_id?: string }): Promise<void>;
  remove(): Promise<void>;
  reload(): Promise<void>;           // reads the plan again; clears undo
  setEditing(on: boolean): void;     // defers polling refreshes
  staleBy: string | null;            // "Plan updated by <name>" while a refresh waits
}

const isPlanChanged = (err: unknown): boolean => planErrorDetail(err)?.code === 'plan_changed';

/** Load failures that mean the plan is out of reach, not a passing glitch:
 *  the plan leaves the screen (and its polling stops) instead of a toast. */
const OUT_OF_REACH = new Set(['initiative_not_found', 'plan_not_found', 'forbidden']);

const OK: ApplyResult = { ok: true, notices: [] };
const NO_PLAN: ApplyResult = { ok: false, kind: 'error', code: 'no_plan', message: PLAN_ERRORS.no_plan };
const PLAN_CHANGED: ApplyResult = {
  ok: false, kind: 'error', code: 'plan_changed', message: PLAN_CHANGED_TOAST,
};
/** What a write answers once the tab has moved on to another plan. */
const GONE: ApplyResult = { ok: false, kind: 'error', code: 'gone', message: '' };
const EMPTY_OUTLINE: Outline = new Map();

interface Steps {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
}

const NO_STEPS: Steps = { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null };

/** Whether the job's plan is still the one on screen. */
type Alive = () => boolean;

export function usePlan(initiativeId: string): PlanController {
  const toast = useToast();
  const toastRef = useRef(toast);
  useEffect(() => { toastRef.current = toast; }, [toast]);

  const [status, setStatus] = useState<PlanStatus>('loading');
  const [view, setView] = useState<PlanView | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(0);
  const [steps, setSteps] = useState<Steps>(NO_STEPS);
  const [staleBy, setStaleBy] = useState<string | null>(null);

  // what the queued jobs read and write: they run one at a time, each after
  // the one before it finished, so the refs always hold the latest answer
  const viewRef = useRef<PlanView | null>(null);
  const stackRef = useRef(new UndoStack());
  const queueRef = useRef(new WriteQueue());
  const genRef = useRef(0);
  const editingRef = useRef(false);
  const waitingRef = useRef(false);          // a refresh waits for editing to end
  const probingRef = useRef(false);

  const actions = useMemo(() => {
    const show = (next: PlanView | null) => {
      viewRef.current = next;
      setView(next);
    };

    const syncSteps = () => {
      const stack = stackRef.current;
      setSteps({
        canUndo: stack.canUndo, canRedo: stack.canRedo,
        undoLabel: stack.undoLabel, redoLabel: stack.redoLabel,
      });
    };

    /** Runs `job` after every job queued before it; `gone` when the tab has
     *  moved on to another plan before its turn. `quiet` keeps it out of busy. */
    function enqueue<T>(job: (alive: Alive) => Promise<T>, gone: T, quiet = false): Promise<T> {
      const gen = genRef.current;
      const alive: Alive = () => genRef.current === gen;
      if (!quiet) setPending((n) => n + 1);
      const run = queueRef.current.run(() => (alive() ? job(alive) : Promise.resolve(gone)));
      if (!quiet) void run.finally(() => setPending((n) => n - 1)).catch(() => undefined);
      return run;
    }

    /** Reads the plan. A passing failure (the network, a 500) keeps a plan
     *  already on screen and says so; one that puts it out of reach does not. */
    async function fetchPlan(alive: Alive): Promise<void> {
      try {
        const plan = await getPlan(initiativeId);
        if (!alive()) return;
        show(planView(plan));
        setStatus('ready');
        setError('');
      } catch (err) {
        if (!alive()) return;
        const code = planErrorDetail(err)?.code ?? '';
        if (code === 'no_plan') {
          show(null);
          setStatus('none');
          setError('');
        } else if (viewRef.current && !OUT_OF_REACH.has(code)) {
          toastRef.current(planErrorText(err));
        } else {
          show(null);
          setStatus('error');
          setError(planErrorText(err));
        }
      }
    }

    /** A fresh copy from the server, which clears undo and any waiting refresh. */
    async function refresh(alive: Alive): Promise<void> {
      stackRef.current.clear();
      syncSteps();
      waitingRef.current = false;
      setStaleBy(null);
      await fetchPlan(alive);
    }

    /** Someone else changed the plan under a write: reload and say so. */
    async function changedElsewhere(alive: Alive): Promise<void> {
      await refresh(alive);
      if (alive()) toastRef.current(PLAN_CHANGED_TOAST);
    }

    /** A failed write's answer; plan_changed reloads first. */
    async function failed(err: unknown, alive: Alive): Promise<ApplyResult> {
      if (!alive()) return failureOf(err);
      if (isPlanChanged(err)) {
        await changedElsewhere(alive);
        return PLAN_CHANGED;
      }
      return failureOf(err);
    }

    /** An ops answer onto the plan it was sent against. A version past ours
     *  + 1 means another batch landed in between (a progress-only batch
     *  skips the version check): the rows merged are then not the whole
     *  story, so the version stays the one this state was whole at, and
     *  the next probe (or a structural edit's 409) reloads. */
    function commitOps(sentAt: PlanView, out: OpsResult): void {
      const merged = mergeOps(sentAt.plan, out);
      const base = sentAt.plan.version;
      show(out.version === base + 1
        ? merged
        : { ...merged, plan: { ...merged.plan, version: base } });
    }

    /** Posts one step's batches, last first; what they answer becomes the
     *  step on the other side. On a refusal what did not go through stays
     *  on its side and what did moves across. */
    async function replay(entry: UndoEntry, side: 'undo' | 'redo', alive: Alive): Promise<void> {
      const stack = stackRef.current;
      const put = (onUndo: boolean, batches: readonly (readonly Op[])[]) => (onUndo
        ? stack.pushUndo({ label: entry.label, batches })
        : stack.pushRedo({ label: entry.label, batches }));
      const back = (batches: readonly (readonly Op[])[]) => put(side === 'undo', batches);
      const across = (batches: readonly (readonly Op[])[]) => put(side === 'redo', batches);
      const answered: (readonly Op[])[] = [];
      for (let i = entry.batches.length - 1; i >= 0; i -= 1) {
        const sentAt = viewRef.current;
        if (!sentAt) return;
        let out: OpsResult;
        try {
          out = await postOps(sentAt.plan.id, sentAt.plan.version, entry.batches[i]);
        } catch (err) {
          if (!alive()) return;
          if (isPlanChanged(err)) {
            await changedElsewhere(alive);
            return;
          }
          back(entry.batches.slice(0, i + 1));
          across(answered);
          syncSteps();
          toastRef.current(planErrorText(err));
          return;
        }
        if (!alive()) return;
        commitOps(sentAt, out);
        answered.push(out.inverse);
      }
      across(answered);
      syncSteps();
    }

    /** Takes a plan-level write's answer (the whole plan). */
    async function planWrite(write: (planId: string, version: number) => Promise<Plan>): Promise<void> {
      await enqueue(async (alive) => {
        const current = viewRef.current;
        if (!current) throw new Error('no plan is loaded');
        try {
          const plan = await write(current.plan.id, current.plan.version);
          if (alive()) show(planView(plan));
        } catch (err) {
          if (alive() && isPlanChanged(err)) await changedElsewhere(alive);
          throw err;
        }
      }, undefined);
    }

    /** An ops write (a batch, or Update Project): its answer merged and its
     *  inverse handed to `remember` for undo. */
    async function opsWrite(
      alive: Alive, post: (sentAt: PlanView) => Promise<OpsResult>, remember: (inverse: Op[]) => void,
    ): Promise<ApplyResult> {
      const sentAt = viewRef.current;
      if (!sentAt) return NO_PLAN;
      let out: OpsResult;
      try {
        out = await post(sentAt);
      } catch (err) {
        return failed(err, alive);
      }
      if (alive()) {
        commitOps(sentAt, out);
        remember(out.inverse);
        syncSteps();
      }
      return { ok: true, notices: out.notices };
    }

    /** Undo or redo: the step on top of that side, replayed. */
    const step = (side: 'undo' | 'redo') => enqueue(async (alive) => {
      const entry = side === 'undo' ? stackRef.current.undo() : stackRef.current.redo();
      if (!entry) return;
      syncSteps();
      await replay(entry, side, alive);
    }, undefined);

    /** One version probe: someone else's change reloads, or waits while editing. */
    async function probe(alive: Alive): Promise<void> {
      const current = viewRef.current;
      if (!current) return;
      let name: string | null;
      try {
        const answer = await getPlanVersion(current.plan.id);
        if (!alive() || answer.version <= (viewRef.current?.plan.version ?? answer.version)) return;
        name = answer.updated_by_name;
      } catch (err) {
        // a deleted plan reads as changed; anything else waits for the next tick
        if (!alive() || planErrorDetail(err)?.code !== 'plan_not_found') return;
        name = null;
      }
      if (editingRef.current) {
        waitingRef.current = true;
        setStaleBy(`Plan updated by ${name ?? 'someone else'}`);
        return;
      }
      await refresh(alive);
    }

    return {
      enqueue, fetchPlan, refresh, probe, syncSteps, show,

      apply: (ops: Op[], label: string, opts: ApplyOptions = {}) => enqueue((alive) => opsWrite(
        alive,
        (at) => postOps(at.plan.id, at.plan.version, opts.confirm ? withConfirm(ops) : ops),
        (inverse) => (opts.joinUndo
          ? stackRef.current.join(inverse, label)
          : stackRef.current.push(inverse, label)),
      ), GONE),

      undo: () => step('undo'),
      redo: () => step('redo'),

      patch: (p: PlanPatchFields) => planWrite((id, version) => patchPlan(id, { ...p, base_version: version })),
      lock: () => planWrite((id) => lockPlan(id)),
      unlock: () => planWrite((id) => unlockPlan(id)),
      clearBaseline: () => planWrite((id) => apiClearBaseline(id)),

      setBaseline: (replace: boolean) => enqueue(async (alive) => {
        const current = viewRef.current;
        if (!current) return NO_PLAN;
        try {
          const plan = await apiSetBaseline(current.plan.id, replace);
          if (alive()) show(planView(plan));
          return OK;
        } catch (err) {
          return failed(err, alive);
        }
      }, GONE),

      updateProject: (body: UpdateProjectBody) => enqueue(async (alive) => {
        const result = await opsWrite(
          alive,
          (at) => apiUpdateProject(at.plan.id, body),
          (inverse) => stackRef.current.push(inverse, UPDATE_PROJECT_LABEL),
        );
        // statuses follow the status date, which the answer leaves out (and
        // undo never restores): read the plan again, keeping our undo
        if (result.ok && alive()) await fetchPlan(alive);
        return result;
      }, GONE),

      create: (body: { project_start: string; template_id?: string }) => enqueue(async (alive) => {
        let plan: Plan;
        try {
          plan = await createPlan(initiativeId, body);
        } catch (err) {
          // someone else made one meanwhile: show it, and let the caller say so
          if (alive() && planErrorDetail(err)?.code === 'plan_exists') await refresh(alive);
          throw err;
        }
        if (!alive()) return;
        stackRef.current.clear();
        syncSteps();
        show(planView(plan));
        setStatus('ready');
        setError('');
      }, undefined),

      remove: () => enqueue(async (alive) => {
        await deletePlan(initiativeId);
        if (!alive()) return;
        stackRef.current.clear();
        syncSteps();
        waitingRef.current = false;
        setStaleBy(null);
        show(null);
        setStatus('none');
      }, undefined),

      reload: () => enqueue((alive) => refresh(alive), undefined),
    };
  }, [initiativeId]);

  // a new initiative (or the first mount): a fresh queue, stack and load
  useEffect(() => {
    genRef.current += 1;
    queueRef.current = new WriteQueue();
    stackRef.current = new UndoStack();
    viewRef.current = null;
    editingRef.current = false;
    waitingRef.current = false;
    setView(null);
    setStatus('loading');
    setError('');
    setStaleBy(null);
    setSteps(NO_STEPS);
    void actions.enqueue((alive) => actions.fetchPlan(alive), undefined);
    return () => { genRef.current += 1; };
  }, [actions]);

  // the version poll, while a plan is open and the page is visible
  useEffect(() => {
    if (status !== 'ready') return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible' || probingRef.current) return;
      probingRef.current = true;
      void actions.enqueue((alive) => actions.probe(alive), undefined, true)
        .finally(() => { probingRef.current = false; });
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [status, actions]);

  const setEditing = useCallback((on: boolean) => {
    editingRef.current = on;
    if (!on && waitingRef.current) {
      waitingRef.current = false;
      void actions.enqueue((alive) => actions.refresh(alive), undefined);
    }
  }, [actions]);

  return useMemo<PlanController>(() => ({
    status,
    plan: view?.plan ?? null,
    outline: view?.outline ?? EMPTY_OUTLINE,
    error,
    busy: pending > 0,
    apply: actions.apply,
    undo: actions.undo,
    redo: actions.redo,
    ...steps,
    patch: actions.patch,
    lock: actions.lock,
    unlock: actions.unlock,
    setBaseline: actions.setBaseline,
    clearBaseline: actions.clearBaseline,
    updateProject: actions.updateProject,
    create: actions.create,
    remove: actions.remove,
    reload: actions.reload,
    setEditing,
    staleBy,
  }), [status, view, error, pending, steps, staleBy, actions, setEditing]);
}

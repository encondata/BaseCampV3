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
 * Whenever the plan on screen is replaced by someone else's change (that
 * reload, a poll's reload, a write whose answer skipped another's), the
 * edits still queued were asked for against the state that is gone: they
 * are dropped unsent, with one toast (`superseded` below).
 *
 * The version poll (every 30 s while the page is visible) reloads at once
 * when the version moved past ours, unless someone holds editing
 * (`beginEditing`): then `staleBy` says so and the reload waits until the
 * last holder lets go.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/api';
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
import { PLAN_ERRORS, isPlanChanged, planErrorDetail, planErrorText } from '../../lib/plans/errors';
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

/** A PATCH body without `base_version`: the controller sends the version it holds. */
export type PlanPatchFields = Omit<PlanPatch, 'base_version'>;

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
  /*
   * patch, lock, unlock, clearBaseline, create and remove reject with the
   * API's error (word it with planErrorText). When `isPlanChanged(err)`
   * (lib/plans/errors) holds, someone else changed the plan: it has been
   * reloaded and a toast already said so, so close quietly.
   */
  patch(p: PlanPatchFields): Promise<void>;
  lock(): Promise<void>;
  unlock(): Promise<void>;
  setBaseline(replace: boolean): Promise<ApplyResult>;
  clearBaseline(): Promise<void>;
  updateProject(body: UpdateProjectBody): Promise<ApplyResult>;
  create(body: { project_start: string; template_id?: string }): Promise<void>;
  remove(): Promise<void>;
  reload(): Promise<void>;           // reads the plan again; clears undo
  /** Holds off polling refreshes while `owner` (a cell editor, a dialog)
   *  is open. Call the function it returns to let go; a second call does
   *  nothing. A refresh that waited runs once nobody holds editing. */
  beginEditing(owner: string): () => void;
  /** `beginEditing` for one default owner: true holds, false lets go. */
  setEditing(on: boolean): void;
  staleBy: string | null;            // "Plan updated by <name>" while a refresh waits
}

/** Load failures that mean the plan is out of reach, not a passing glitch:
 *  the plan leaves the screen (and its polling stops) instead of a toast. */
const OUT_OF_REACH = new Set(['initiative_not_found', 'plan_not_found', 'forbidden']);

const OK: ApplyResult = { ok: true, notices: [], tempIds: {} };
const NO_PLAN: ApplyResult = { ok: false, kind: 'error', code: 'no_plan', message: PLAN_ERRORS.no_plan };
const PLAN_CHANGED: ApplyResult = {
  ok: false, kind: 'error', code: 'plan_changed', message: PLAN_CHANGED_TOAST,
};
/** What a write answers once the tab has moved on to another plan. */
const GONE: ApplyResult = { ok: false, kind: 'error', code: 'gone', message: '' };
const EMPTY_OUTLINE: Outline = new Map();

/** The rejection of a void write dropped for someone else's change. */
const planChangedError = (): ApiError =>
  new ApiError(409, 'plan_changed', { code: 'plan_changed' }, PLAN_CHANGED_TOAST);

interface Steps {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
}

const NO_STEPS: Steps = { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null };

/** A queued job's view of the hook. */
interface Job {
  /** The hook still shows the plan this job was queued for (still mounted, same id). */
  alive: () => boolean;
  /** The plan on screen was replaced by someone else's change after the
   *  job was queued: it was asked for against a state that is gone. */
  superseded: () => boolean;
}

export function usePlan(initiativeId: string): PlanController {
  const toast = useToast();
  const { person } = useAuth();
  const toastRef = useRef(toast);
  const myNameRef = useRef<string | null>(null);
  useEffect(() => {
    toastRef.current = toast;
    myNameRef.current = person?.display_name ?? null;
  }, [toast, person]);

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
  const sessionRef = useRef<object | null>(null);   // the controller on duty
  const genRef = useRef(0);                         // bumped by every mount and unmount
  const epochRef = useRef(0);                       // bumped when the plan on screen is replaced
  const toastedEpochRef = useRef(-1);               // the replacement a toast already covered
  const holdsRef = useRef(new Map<number, string>());   // editing holds: token -> owner
  const holdSeqRef = useRef(0);
  const shimRef = useRef<(() => void) | null>(null);    // setEditing's hold
  const waitingRef = useRef(false);                 // a refresh waits for editing to end
  const probingRef = useRef(false);

  const actions = useMemo(() => {
    const session = {};

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

    const editing = () => holdsRef.current.size > 0;

    /** Runs `job` after every job queued before it. `gone` at once when
     *  this controller is off duty (a stale one after the id changed), or
     *  by its turn when the tab moved on meanwhile. `quiet` keeps it out of busy. */
    function enqueue<T>(job: (ctx: Job) => Promise<T>, gone: T, quiet = false): Promise<T> {
      if (sessionRef.current !== session) return Promise.resolve(gone);
      const gen = genRef.current;
      const epoch = epochRef.current;
      const ctx: Job = {
        alive: () => genRef.current === gen,      // every mount, unmount and id change bumps it
        superseded: () => epochRef.current !== epoch,
      };
      if (!quiet) setPending((n) => n + 1);
      const run = queueRef.current.run(() => (ctx.alive() ? job(ctx) : Promise.resolve(gone)));
      if (!quiet) void run.finally(() => setPending((n) => n - 1)).catch(() => undefined);
      return run;
    }

    /** Undo and any waiting refresh go with the state they belonged to. */
    function forget(): void {
      stackRef.current.clear();
      syncSteps();
      waitingRef.current = false;
      setStaleBy(null);
    }

    /** The plan on screen now holds someone else's change: what is still
     *  queued was asked for against the state before it. */
    const supersede = () => { epochRef.current += 1; };

    /** A queued write whose state is gone, dropped unsent: one toast per replacement. */
    function dropped(): void {
      if (toastedEpochRef.current === epochRef.current) return;
      toastedEpochRef.current = epochRef.current;
      toastRef.current(PLAN_CHANGED_TOAST);
    }

    /** Reads the plan; true when what is on screen was replaced. A passing
     *  failure (the network, a 500) keeps a plan already shown and says so;
     *  one that puts it out of reach does not. */
    async function fetchPlan(alive: () => boolean): Promise<boolean> {
      try {
        const plan = await getPlan(initiativeId);
        if (!alive()) return false;
        show(planView(plan));
        setStatus('ready');
        setError('');
        return true;
      } catch (err) {
        if (!alive()) return false;
        const code = planErrorDetail(err)?.code ?? '';
        if (code === 'no_plan') {
          show(null);
          setStatus('none');
          setError('');
          return true;
        }
        if (viewRef.current && !OUT_OF_REACH.has(code)) {
          toastRef.current(planErrorText(err));
          return false;
        }
        show(null);
        setStatus('error');
        setError(planErrorText(err));
        return true;
      }
    }

    /** A fresh copy from the server: undo cleared, queued writes superseded
     *  once it is on screen (not before: an edit typed while it loads was
     *  typed against the old state too) — but only when it holds something
     *  new: the same plan at the same version (a manual reload with nothing
     *  changed) is the state those edits were typed against. */
    async function refresh(ctx: Job): Promise<boolean> {
      forget();
      const before = viewRef.current?.plan ?? null;
      const replaced = await fetchPlan(ctx.alive);
      const after = viewRef.current?.plan ?? null;
      const same = before?.id === after?.id && before?.version === after?.version;
      if (replaced && !same) supersede();
      return replaced;
    }

    /** Someone else changed the plan under a write: reload and say so. */
    async function changedElsewhere(ctx: Job): Promise<void> {
      if (!(await refresh(ctx)) || !ctx.alive()) return;
      toastedEpochRef.current = epochRef.current;
      toastRef.current(PLAN_CHANGED_TOAST);
    }

    /** A failed write's answer; plan_changed reloads first. */
    async function failed(err: unknown, ctx: Job): Promise<ApplyResult> {
      if (!ctx.alive()) return failureOf(err);
      if (isPlanChanged(err)) {
        await changedElsewhere(ctx);
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

    /** A whole plan a write answered, sent at version `base`. Past base + 1
     *  someone else's write landed too: like the probe finding it, undo
     *  goes and the writes still queued are dropped. */
    function takePlan(plan: Plan, base: number): void {
      show(planView(plan));
      if (plan.version > base + 1) {
        forget();
        supersede();
      }
    }

    /** Posts one step's batches, last first; what they answer becomes the
     *  step on the other side. On a refusal what did not go through stays
     *  on its side and what did moves across. */
    async function replay(entry: UndoEntry, side: 'undo' | 'redo', ctx: Job): Promise<void> {
      const stack = stackRef.current;
      const put = (onUndo: boolean, batches: readonly (readonly Op[])[]) => (onUndo
        ? stack.pushUndo({ label: entry.label, batches })
        : stack.pushRedo({ label: entry.label, batches }));
      const answered: (readonly Op[])[] = [];
      for (let i = entry.batches.length - 1; i >= 0; i -= 1) {
        const sentAt = viewRef.current;
        if (!sentAt) return;
        let out: OpsResult;
        try {
          out = await postOps(sentAt.plan.id, sentAt.plan.version, entry.batches[i]);
        } catch (err) {
          if (!ctx.alive()) return;
          if (isPlanChanged(err)) {
            await changedElsewhere(ctx);
            return;
          }
          put(side === 'undo', entry.batches.slice(0, i + 1));
          put(side === 'redo', answered);
          syncSteps();
          toastRef.current(planErrorText(err));
          return;
        }
        if (!ctx.alive()) return;
        commitOps(sentAt, out);
        answered.push(out.inverse);
      }
      put(side === 'redo', answered);
      syncSteps();
    }

    /** An ops write (a batch, or Update Project): its answer merged and its
     *  inverse handed to `remember` for undo. */
    async function opsWrite(
      ctx: Job, post: (sentAt: PlanView) => Promise<OpsResult>, remember: (inverse: Op[]) => void,
    ): Promise<ApplyResult> {
      const sentAt = viewRef.current;
      if (!sentAt) return NO_PLAN;
      let out: OpsResult;
      try {
        out = await post(sentAt);
      } catch (err) {
        return failed(err, ctx);
      }
      if (ctx.alive()) {
        commitOps(sentAt, out);
        remember(out.inverse);
        syncSteps();
      }
      return { ok: true, notices: out.notices, tempIds: out.temp_ids };
    }

    /** Undo or redo: the step on top of that side, replayed. */
    const step = (side: 'undo' | 'redo') => enqueue(async (ctx) => {
      if (ctx.superseded()) {
        dropped();
        return;
      }
      const entry = side === 'undo' ? stackRef.current.undo() : stackRef.current.redo();
      if (!entry) return;
      syncSteps();
      await replay(entry, side, ctx);
    }, undefined);

    /** A plan-level write answered with the whole plan. A `versioned` one
     *  (PATCH) sends our version, so it is dropped once superseded. */
    const planWrite = (write: (planId: string, version: number) => Promise<Plan>, versioned = false) =>
      enqueue(async (ctx) => {
        if (versioned && ctx.superseded()) {
          dropped();
          throw planChangedError();
        }
        const current = viewRef.current;
        if (!current) throw new Error('no plan is loaded');
        try {
          const plan = await write(current.plan.id, current.plan.version);
          if (ctx.alive()) takePlan(plan, current.plan.version);
        } catch (err) {
          if (ctx.alive() && isPlanChanged(err)) await changedElsewhere(ctx);
          throw err;
        }
      }, undefined);

    /** "Plan updated by <name>", never naming the signed-in person (their
     *  other tab, or their own batch landing after someone else's). */
    function staleText(name: string | null): string {
      if (name === null) return 'Plan updated by someone else';
      return name === myNameRef.current ? 'Plan updated elsewhere' : `Plan updated by ${name}`;
    }

    /** One version probe: someone else's change reloads, or waits while editing. */
    async function probe(ctx: Job): Promise<void> {
      const current = viewRef.current;
      if (!current) return;
      let name: string | null;
      try {
        const answer = await getPlanVersion(current.plan.id);
        if (!ctx.alive() || answer.version <= (viewRef.current?.plan.version ?? answer.version)) return;
        name = answer.updated_by_name;
      } catch (err) {
        // a deleted plan reads as changed; anything else waits for the next tick
        if (!ctx.alive() || planErrorDetail(err)?.code !== 'plan_not_found') return;
        name = null;
      }
      if (editing()) {
        waitingRef.current = true;
        setStaleBy(staleText(name));
        return;
      }
      await refresh(ctx);
    }

    /** The refresh that waited for editing, once its turn comes: still
     *  only when nobody holds editing then (Enter moves to the next cell). */
    async function deferredRefresh(ctx: Job): Promise<void> {
      if (!waitingRef.current || editing()) return;
      await refresh(ctx);
    }

    return {
      session, enqueue, fetchPlan, probe, deferredRefresh,

      apply: (ops: Op[], label: string, opts: ApplyOptions = {}) => enqueue(async (ctx) => {
        if (ctx.superseded()) {
          dropped();
          return PLAN_CHANGED;
        }
        return opsWrite(
          ctx,
          (at) => postOps(at.plan.id, at.plan.version, opts.confirm ? withConfirm(ops) : ops),
          (inverse) => (opts.joinUndo
            ? stackRef.current.join(inverse, label)
            : stackRef.current.push(inverse, label)),
        );
      }, GONE),

      undo: () => step('undo'),
      redo: () => step('redo'),

      patch: (p: PlanPatchFields) =>
        planWrite((id, version) => patchPlan(id, { ...p, base_version: version }), true),
      lock: () => planWrite((id) => lockPlan(id)),
      unlock: () => planWrite((id) => unlockPlan(id)),
      clearBaseline: () => planWrite((id) => apiClearBaseline(id)),

      setBaseline: (replace: boolean) => enqueue(async (ctx) => {
        const current = viewRef.current;
        if (!current) return NO_PLAN;
        try {
          const plan = await apiSetBaseline(current.plan.id, replace);
          if (ctx.alive()) takePlan(plan, current.plan.version);
          return OK;
        } catch (err) {
          return failed(err, ctx);
        }
      }, GONE),

      updateProject: (body: UpdateProjectBody) => enqueue(async (ctx) => {
        const sentAt = viewRef.current;
        const result = await opsWrite(
          ctx,
          (at) => apiUpdateProject(at.plan.id, body),
          (inverse) => stackRef.current.push(inverse, UPDATE_PROJECT_LABEL),
        );
        if (!result.ok || !sentAt || !ctx.alive()) return result;
        // statuses follow the status date, which the answer leaves out (and
        // undo never restores): read the plan again, keeping our undo
        // unless the read shows someone else's write too
        await fetchPlan(ctx.alive);
        const now = viewRef.current;
        if (ctx.alive() && now && now.plan.version > sentAt.plan.version + 1) {
          forget();
          supersede();
        }
        return result;
      }, GONE),

      create: (body: { project_start: string; template_id?: string }) => enqueue(async (ctx) => {
        let plan: Plan;
        try {
          plan = await createPlan(initiativeId, body);
        } catch (err) {
          // someone else made one meanwhile: show it, and let the caller say so
          if (ctx.alive() && planErrorDetail(err)?.code === 'plan_exists') await refresh(ctx);
          throw err;
        }
        if (!ctx.alive()) return;
        forget();
        show(planView(plan));
        setStatus('ready');
        setError('');
      }, undefined),

      remove: () => enqueue(async (ctx) => {
        await deletePlan(initiativeId);
        if (!ctx.alive()) return;
        forget();
        show(null);
        setStatus('none');
      }, undefined),

      reload: () => enqueue(async (ctx) => { await refresh(ctx); }, undefined),
    };
  }, [initiativeId]);

  const actionsRef = useRef(actions);

  // a new initiative (or the first mount): this controller on duty, with a
  // fresh queue, stack and load. Keyed on the id alone; `actions` is keyed
  // on it too, so this render's instance is the one for this id.
  useEffect(() => {
    actionsRef.current = actions;
    sessionRef.current = actions.session;
    genRef.current += 1;
    queueRef.current = new WriteQueue();
    stackRef.current = new UndoStack();
    viewRef.current = null;
    holdsRef.current = new Map();
    shimRef.current = null;
    waitingRef.current = false;
    setView(null);
    setStatus('loading');
    setError('');
    setStaleBy(null);
    setSteps(NO_STEPS);
    void actions.enqueue(async (ctx) => { await actions.fetchPlan(ctx.alive); }, undefined);
    return () => {
      genRef.current += 1;
      sessionRef.current = null;
    };
  }, [initiativeId]);

  // the version poll, while a plan is open and the page is visible
  useEffect(() => {
    if (status !== 'ready') return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible' || probingRef.current) return;
      probingRef.current = true;
      void actions.enqueue((ctx) => actions.probe(ctx), undefined, true)
        .finally(() => { probingRef.current = false; });
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [status, actions]);

  const beginEditing = useCallback((owner: string) => {
    holdSeqRef.current += 1;
    const token = holdSeqRef.current;
    const holds = holdsRef.current;
    holds.set(token, owner);
    return () => {
      if (!holds.delete(token)) return;       // let go already
      if (holdsRef.current.size === 0 && waitingRef.current) {
        const latest = actionsRef.current;
        void latest.enqueue((ctx) => latest.deferredRefresh(ctx), undefined);
      }
    };
  }, []);

  const setEditing = useCallback((on: boolean) => {
    if (on) {
      shimRef.current ??= beginEditing('default');
    } else {
      const release = shimRef.current;
      shimRef.current = null;
      release?.();
    }
  }, [beginEditing]);

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
    beginEditing,
    setEditing,
    staleBy,
  }), [status, view, error, pending, steps, staleBy, actions, beginEditing, setEditing]);
}

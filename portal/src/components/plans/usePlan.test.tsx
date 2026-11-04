// @vitest-environment jsdom
/**
 * components/plans/usePlan.ts: the plan tab's state. Loading, ops merged
 * into the plan, one queue for every write (each batch sends the version
 * the one before it answered), undo/redo with grouped steps, the 409s
 * (plan_changed reloads and clears undo; completion ones become their
 * kinds), errors that leave the plan as it was, and the 30 s version poll
 * that waits while someone is editing.
 */
import { act, renderHook, waitFor, type RenderHookResult } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Op, OpsResult, Plan, PlanVersion } from '../../lib/plans/api';
import {
  flatTasks, makeLink, makeOpsResult, makePlan, makeRestore, makeTask,
} from '../../lib/plans/planFixtures';
import type { ApplyResult, PlanController } from './usePlan';

const toast = vi.hoisted(() => vi.fn());
vi.mock('../../lib/notificationsContext', () => ({ useToast: () => toast }));

const auth = vi.hoisted(() => ({ person: { id: 'p-me', display_name: 'Jimmy Henderson' } }));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => auth }));

const api = vi.hoisted(() => ({
  getPlan: vi.fn(),
  createPlan: vi.fn(),
  deletePlan: vi.fn(),
  postOps: vi.fn(),
  patchPlan: vi.fn(),
  lockPlan: vi.fn(),
  unlockPlan: vi.fn(),
  setBaseline: vi.fn(),
  clearBaseline: vi.fn(),
  updateProject: vi.fn(),
  getPlanVersion: vi.fn(),
}));
vi.mock('../../lib/plans/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/plans/api')>()),
  ...api,
}));

const { ApiError } = await import('../../lib/api');
const { isPlanChanged } = await import('../../lib/plans/errors');
const { usePlan, POLL_MS } = await import('./usePlan');

type Hook = RenderHookResult<PlanController, unknown>;

const apiError = (status: number, detail: Record<string, unknown>) =>
  new ApiError(status, String(detail.code), detail);

function deferred<V>() {
  let resolve!: (v: V) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<V>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const version = (v: number, name: string | null = 'Dana Reyes'): PlanVersion =>
  ({ version: v, updated_at: '2026-10-28T10:00:00Z', updated_by_name: name });

const rename: Op[] = [{ op: 'update_task', id: 'b', fields: { name: 'Rack servers' } }];
const relink: Op[] = [{ op: 'update_task', id: 'c', fields: { predecessors: '1' } }];

/** What a write answers when someone else's change got there first. */
const CHANGED: ApplyResult = {
  ok: false, kind: 'error', code: 'plan_changed',
  message: 'This plan was changed by someone else — reloaded.',
};

const blocker = (task_id: string, display_id: number, reason: 'subtask' | 'predecessor') =>
  ({ task_id, display_id, name: `Task ${task_id}`, reason });

let visibility: DocumentVisibilityState = 'visible';

beforeEach(() => {
  vi.useRealTimers();
  for (const fn of [toast, ...Object.values(api)]) fn.mockReset();
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});

afterEach(() => {
  vi.useRealTimers();
  delete (document as { visibilityState?: unknown }).visibilityState;
});

async function loaded(plan: Plan = makePlan()): Promise<Hook> {
  api.getPlan.mockResolvedValueOnce(plan);
  const hook = renderHook(() => usePlan('init-1'));
  await waitFor(() => expect(hook.result.current.status).toBe('ready'));
  return hook;
}

/** Runs a controller call inside act and hands back what it resolved to. */
async function call<T>(fn: () => Promise<T>): Promise<T> {
  let out!: T;
  await act(async () => { out = await fn(); });
  return out;
}

/** Runs a controller call that should reject inside act (so React still
 *  flushes what it set on the way) and hands back the rejection. */
async function rejection(fn: () => Promise<unknown>): Promise<unknown> {
  let caught: unknown = null;
  await act(async () => {
    try {
      await fn();
    } catch (err) {
      caught = err;
    }
  });
  return caught;
}

describe('loading', () => {
  it('loads the initiative’s plan and its outline', async () => {
    const plan = makePlan({ links: [makeLink('l1', 'a', 'c')] });
    const { result } = await loaded(plan);
    expect(api.getPlan).toHaveBeenCalledWith('init-1');
    expect(result.current.plan?.id).toBe('plan-1');
    expect(result.current.plan?.tasks.map((t) => t.id)).toEqual(['a', 'b', 'c']);
    expect(result.current.outline.get('c')?.predecessors).toBe('1');
    expect(result.current.error).toBe('');
    expect(result.current.busy).toBe(false);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
    expect(result.current.staleBy).toBeNull();
  });

  it('starts as loading', () => {
    api.getPlan.mockReturnValueOnce(new Promise(() => {}));
    const { result } = renderHook(() => usePlan('init-1'));
    expect(result.current.status).toBe('loading');
    expect(result.current.plan).toBeNull();
    expect(result.current.outline.size).toBe(0);
  });

  it('reads 404 no_plan as an initiative with no plan yet', async () => {
    api.getPlan.mockRejectedValueOnce(apiError(404, { code: 'no_plan' }));
    const { result } = renderHook(() => usePlan('init-1'));
    await waitFor(() => expect(result.current.status).toBe('none'));
    expect(result.current.plan).toBeNull();
    expect(result.current.error).toBe('');
  });

  it('shows any other load failure in words', async () => {
    api.getPlan.mockRejectedValueOnce(apiError(403, { code: 'forbidden' }));
    const { result } = renderHook(() => usePlan('init-1'));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBe('You don’t have permission to do that.');
  });

  it('loads the other initiative’s plan when the id changes', async () => {
    api.getPlan.mockResolvedValueOnce(makePlan());
    const { result, rerender } = renderHook(({ id }) => usePlan(id), { initialProps: { id: 'init-1' } });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    api.getPlan.mockResolvedValueOnce(makePlan({ id: 'plan-2', initiative_id: 'init-2' }));
    rerender({ id: 'init-2' });
    await waitFor(() => expect(result.current.plan?.id).toBe('plan-2'));
    expect(api.getPlan).toHaveBeenLastCalledWith('init-2');
  });
});

describe('apply', () => {
  it('posts the batch at the plan’s version and merges the changed task and the order', async () => {
    const { result } = await loaded();
    api.postOps.mockResolvedValueOnce(makeOpsResult({
      version: 6,
      tasks: [makeTask('b', { name: 'Rack servers', position: 0 })],
      order: ['b', 'a', 'c'],
      notices: [{ code: 'constraint_added', task_id: 'b', constraint_type: 'snet' }],
    }));
    const res = await call(() => result.current.apply(rename, 'Rename'));
    expect(api.postOps).toHaveBeenCalledWith('plan-1', 5, rename);
    expect(res).toMatchObject({
      ok: true, notices: [{ code: 'constraint_added', task_id: 'b', constraint_type: 'snet' }], tempIds: {},
    });
    const plan = result.current.plan!;
    expect(plan.version).toBe(6);
    expect(plan.tasks.map((t) => t.id)).toEqual(['b', 'a', 'c']);
    expect(plan.tasks[0].name).toBe('Rack servers');
    expect(plan.tasks.map((t) => t.display_id)).toEqual([1, 2, 3]);
    expect([...result.current.outline.keys()]).toEqual(['b', 'a', 'c']);
  });

  it('still sends base_version with a progress-only batch', async () => {
    const { result } = await loaded();
    api.postOps.mockResolvedValueOnce(makeOpsResult({ version: 6 }));
    const ops: Op[] = [{ op: 'set_percent', ids: ['a'], percent: 50 }];
    await call(() => result.current.apply(ops, '50% Complete'));
    expect(api.postOps).toHaveBeenCalledWith('plan-1', 5, ops);
  });

  it('hands back the real ids of the tasks the batch added', async () => {
    const { result } = await loaded();
    api.postOps.mockResolvedValueOnce(makeOpsResult({
      version: 6, temp_ids: { t1: 'task-9', t2: 'task-10' },
      tasks: [makeTask('task-9', { position: 3 }), makeTask('task-10', { position: 4 })],
      order: ['a', 'b', 'c', 'task-9', 'task-10'],
    }));
    const res = await call(() => result.current.apply(
      [{ op: 'add_task', temp_id: 't1' }, { op: 'add_task', temp_id: 't2' }], 'Insert Task'));
    expect(res).toMatchObject({ ok: true, notices: [], tempIds: { t1: 'task-9', t2: 'task-10' } });
  });

  it('puts the inverse on the undo stack; undo posts it as received and redo posts its answer', async () => {
    const { result } = await loaded();
    const inverse = [makeRestore('inv1')];
    api.postOps.mockResolvedValueOnce(makeOpsResult({ version: 6, inverse }));
    await call(() => result.current.apply(rename, 'Rename'));
    expect(result.current.canUndo).toBe(true);
    expect(result.current.undoLabel).toBe('Rename');

    const redoInverse = [makeRestore('redo1')];
    api.postOps.mockResolvedValueOnce(makeOpsResult({
      version: 7, inverse: redoInverse, tasks: [makeTask('b', { display_id: 2, wbs: '2', position: 1, name: 'Task b' })],
    }));
    await call(() => result.current.undo());
    expect(api.postOps).toHaveBeenLastCalledWith('plan-1', 6, inverse);
    expect(api.postOps.mock.lastCall![2]).toBe(inverse);           // the very ops, unchanged
    expect(result.current.plan?.version).toBe(7);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(true);
    expect(result.current.redoLabel).toBe('Rename');

    api.postOps.mockResolvedValueOnce(makeOpsResult({ version: 8, inverse: [makeRestore('inv2')] }));
    await call(() => result.current.redo());
    expect(api.postOps).toHaveBeenLastCalledWith('plan-1', 7, redoInverse);
    expect(api.postOps.mock.lastCall![2]).toBe(redoInverse);
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(false);
  });

  it('clears the redo side on a fresh edit', async () => {
    const { result } = await loaded();
    api.postOps
      .mockResolvedValueOnce(makeOpsResult({ version: 6 }))
      .mockResolvedValueOnce(makeOpsResult({ version: 7 }))
      .mockResolvedValueOnce(makeOpsResult({ version: 8 }));
    await call(() => result.current.apply(rename, 'Rename'));
    await call(() => result.current.undo());
    expect(result.current.canRedo).toBe(true);
    await call(() => result.current.apply(rename, 'Rename again'));
    expect(result.current.canRedo).toBe(false);
  });

  it('runs writes one at a time: a second batch waits and sends the first one’s version', async () => {
    const { result } = await loaded();
    const first = deferred<OpsResult>();
    api.postOps
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(makeOpsResult({ version: 7 }));
    const second: Op[] = [{ op: 'update_task', id: 'c', fields: { duration: '2d' } }];
    let one!: Promise<unknown>;
    let two!: Promise<unknown>;
    act(() => {
      one = result.current.apply(rename, 'Rename');
      two = result.current.apply(second, 'Duration');     // typed before the first answered
    });
    await act(async () => { await Promise.resolve(); });
    expect(api.postOps).toHaveBeenCalledTimes(1);
    expect(api.postOps.mock.calls[0][1]).toBe(5);
    expect(result.current.busy).toBe(true);

    first.resolve(makeOpsResult({ version: 6 }));
    const [r1, r2] = await call(() => Promise.all([one, two]));
    expect(r1).toMatchObject({ ok: true, notices: [], tempIds: {} });
    expect(r2).toMatchObject({ ok: true, notices: [], tempIds: {} });
    expect(api.postOps).toHaveBeenCalledTimes(2);
    expect(api.postOps.mock.calls[1]).toEqual(['plan-1', 6, second]);
    expect(result.current.plan?.version).toBe(7);
    // no self-inflicted conflict: no reload, no toast, undo intact
    expect(api.getPlan).toHaveBeenCalledTimes(1);
    expect(toast).not.toHaveBeenCalled();
    expect(result.current.canUndo).toBe(true);
    expect(result.current.busy).toBe(false);
  });

  it('on 409 plan_changed reloads, clears undo, says so, and never applies the stale edit', async () => {
    const { result } = await loaded();
    api.postOps.mockResolvedValueOnce(makeOpsResult({ version: 6 }));
    await call(() => result.current.apply(rename, 'Rename'));
    expect(result.current.canUndo).toBe(true);

    const fresh = makePlan({ version: 9, tasks: flatTasks(['a', 'b', 'c', 'd']) });
    api.postOps.mockRejectedValueOnce(apiError(409, { code: 'plan_changed', version: 9 }));
    api.getPlan.mockResolvedValueOnce(fresh);
    const res = await call(() => result.current.apply([{ op: 'indent', ids: ['b'] }], 'Indent'));

    expect(res).toEqual({
      ok: false, kind: 'error', code: 'plan_changed',
      message: 'This plan was changed by someone else — reloaded.',
    });
    expect(api.getPlan).toHaveBeenCalledTimes(2);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith('This plan was changed by someone else — reloaded.');
    const plan = result.current.plan!;
    expect(plan.version).toBe(9);
    expect(plan.tasks.map((t) => t.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(plan.tasks.find((t) => t.id === 'b')?.parent_id).toBeNull();
  });

  it('turns 409 completion_confirm into a confirm and changes nothing', async () => {
    const { result } = await loaded();
    const before = result.current.plan;
    api.postOps.mockRejectedValueOnce(apiError(409, {
      code: 'completion_confirm',
      will_complete: [blocker('b', 2, 'subtask')],
      open_predecessors: [blocker('a', 1, 'predecessor')],
    }));
    const res = await call(() => result.current.apply([{ op: 'complete', ids: ['c'] }], '100% Complete'));
    expect(res).toEqual({
      ok: false, kind: 'confirm',
      willComplete: [blocker('b', 2, 'subtask')],
      openPredecessors: [blocker('a', 1, 'predecessor')],
    });
    expect(result.current.plan).toBe(before);
    expect(result.current.canUndo).toBe(false);
    expect(api.getPlan).toHaveBeenCalledTimes(1);
    expect(toast).not.toHaveBeenCalled();
  });

  it('reads a completion_confirm that names only open predecessors', async () => {
    const { result } = await loaded();
    api.postOps.mockRejectedValueOnce(apiError(409, {
      code: 'completion_confirm', will_complete: [], open_predecessors: [blocker('a', 1, 'predecessor')],
    }));
    const res = await call(() => result.current.apply([{ op: 'complete', ids: ['c'] }], '100% Complete'));
    expect(res).toEqual({
      ok: false, kind: 'confirm', willComplete: [], openPredecessors: [blocker('a', 1, 'predecessor')],
    });
  });

  it('turns 409 completion_blocked into blocked with its blockers', async () => {
    const { result } = await loaded();
    const before = result.current.plan;
    api.postOps.mockRejectedValueOnce(apiError(409, {
      code: 'completion_blocked', blockers: [blocker('a', 1, 'predecessor')],
    }));
    const res = await call(() => result.current.apply([{ op: 'complete', ids: ['c'] }], '100% Complete'));
    expect(res).toEqual({ ok: false, kind: 'blocked', blockers: [blocker('a', 1, 'predecessor')] });
    expect(result.current.plan).toBe(before);
  });

  it('with confirm: true marks every completing op, and no other', async () => {
    const { result } = await loaded();
    api.postOps.mockResolvedValueOnce(makeOpsResult({ version: 6 }));
    const restore = makeRestore('r');
    const ops: Op[] = [
      { op: 'set_percent', ids: ['a'], percent: 100 },
      { op: 'complete', ids: ['b'] },
      { op: 'mark_on_track', ids: ['c'] },
      { op: 'update_task', id: 'a', fields: { percent_complete: 100 } },
      { op: 'update_task', id: 'b', fields: { name: 'Racked' } },
      { op: 'indent', ids: ['c'] },
      restore,
    ];
    await call(() => result.current.apply(ops, 'Complete', { confirm: true }));
    const sent = api.postOps.mock.lastCall![2] as Op[];
    expect(sent.map((op) => ('confirm' in op ? op.confirm : undefined)))
      .toEqual([true, true, true, true, undefined, undefined, undefined]);
    expect(sent[6]).toBe(restore);                       // a signed restore is never touched
    expect(ops[0]).toEqual({ op: 'set_percent', ids: ['a'], percent: 100 });   // the caller's ops neither
  });

  it('on a 422 answers the plan wording and leaves the plan and undo as they were', async () => {
    const { result } = await loaded();
    api.postOps.mockResolvedValueOnce(makeOpsResult({ version: 6 }));
    await call(() => result.current.apply(rename, 'Rename'));
    const before = result.current.plan;

    api.postOps.mockRejectedValueOnce(apiError(422, {
      code: 'link_cycle', task_ids: ['a', 'b'], display_ids: [1, 2],
    }));
    const res = await call(() => result.current.apply(
      [{ op: 'update_task', id: 'a', fields: { predecessors: '2' } }], 'Predecessors'));
    expect(res).toEqual({
      ok: false, kind: 'error', code: 'link_cycle',
      message: 'Tasks 1 and 2 would depend on each other.', taskIds: ['a', 'b'],
    });
    expect(result.current.plan).toBe(before);
    expect(result.current.undoLabel).toBe('Rename');
    expect(api.getPlan).toHaveBeenCalledTimes(1);
    expect(toast).not.toHaveBeenCalled();
  });

  it('names the one task a field error is about', async () => {
    const { result } = await loaded();
    api.postOps.mockRejectedValueOnce(apiError(422, { code: 'bad_duration', field: 'duration', task_id: 'b' }));
    const res = await call(() => result.current.apply(
      [{ op: 'update_task', id: 'b', fields: { duration: '99999y' } }], 'Duration'));
    expect(res).toMatchObject({ ok: false, kind: 'error', code: 'bad_duration', taskIds: ['b'] });
  });

  it('answers a locked plan in words', async () => {
    const { result } = await loaded();
    api.postOps.mockRejectedValueOnce(apiError(409, { code: 'plan_locked' }));
    const res = await call(() => result.current.apply(rename, 'Rename'));
    expect(res).toEqual({
      ok: false, kind: 'error', code: 'plan_locked',
      message: 'The schedule is locked, so only progress can be updated until someone unlocks it.',
    });
  });
});

describe('grouped undo', () => {
  it('undoes a joined batch with its step, latest first, and redoes it in order', async () => {
    const { result } = await loaded();
    const inv1 = [makeRestore('inv1')];
    const inv2 = [makeRestore('inv2')];
    api.postOps
      .mockResolvedValueOnce(makeOpsResult({
        version: 6, inverse: inv1, temp_ids: { t1: 'n' },
        tasks: [makeTask('n', { position: 3 })], order: ['a', 'b', 'c', 'n'],
      }))
      .mockResolvedValueOnce(makeOpsResult({ version: 7, inverse: inv2 }));
    const added = await call(() => result.current.apply([{ op: 'add_task', temp_id: 't1', name: 'New' }], 'Paste'));
    if (!added.ok) throw new Error('the add batch failed');
    const newId = added.tempIds.t1;
    expect(newId).toBe('n');
    await call(() => result.current.apply(
      [{ op: 'update_task', id: newId, fields: { predecessors: '1' } }], 'Paste', { joinUndo: added.undoStep ?? null }));
    expect(api.postOps.mock.calls[1][1]).toBe(6);
    expect(api.postOps.mock.calls[1][2]).toEqual([{ op: 'update_task', id: 'n', fields: { predecessors: '1' } }]);
    expect(result.current.undoLabel).toBe('Paste');

    // one undo posts both batches, the later one first
    const redo2 = [makeRestore('redo2')];
    const redo1 = [makeRestore('redo1')];
    api.postOps
      .mockResolvedValueOnce(makeOpsResult({ version: 8, inverse: redo2 }))
      .mockResolvedValueOnce(makeOpsResult({ version: 9, inverse: redo1, deleted_tasks: ['n'], order: ['a', 'b', 'c'] }));
    await call(() => result.current.undo());
    expect(api.postOps).toHaveBeenCalledTimes(4);
    expect(api.postOps.mock.calls[2]).toEqual(['plan-1', 7, inv2]);
    expect(api.postOps.mock.calls[2][2]).toBe(inv2);
    expect(api.postOps.mock.calls[3]).toEqual(['plan-1', 8, inv1]);
    expect(result.current.plan?.tasks.map((t) => t.id)).toEqual(['a', 'b', 'c']);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(true);
    expect(result.current.redoLabel).toBe('Paste');

    // one redo re-adds the rows first, then their links
    const again1 = [makeRestore('again1')];
    const again2 = [makeRestore('again2')];
    api.postOps
      .mockResolvedValueOnce(makeOpsResult({ version: 10, inverse: again1 }))
      .mockResolvedValueOnce(makeOpsResult({ version: 11, inverse: again2 }));
    await call(() => result.current.redo());
    expect(api.postOps.mock.calls[4]).toEqual(['plan-1', 9, redo1]);
    expect(api.postOps.mock.calls[5]).toEqual(['plan-1', 10, redo2]);
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(false);

    // and undoing that takes the links off first again
    api.postOps
      .mockResolvedValueOnce(makeOpsResult({ version: 12 }))
      .mockResolvedValueOnce(makeOpsResult({ version: 13 }));
    await call(() => result.current.undo());
    expect(api.postOps.mock.calls[6]).toEqual(['plan-1', 11, again2]);
    expect(api.postOps.mock.calls[7]).toEqual(['plan-1', 12, again1]);
  });

  it('when part of a grouped undo fails, keeps what is left on the undo side', async () => {
    const { result } = await loaded();
    const inv1 = [makeRestore('inv1')];
    const inv2 = [makeRestore('inv2')];
    api.postOps
      .mockResolvedValueOnce(makeOpsResult({ version: 6, inverse: inv1 }))
      .mockResolvedValueOnce(makeOpsResult({ version: 7, inverse: inv2 }));
    const pasted = await call(() => result.current.apply(rename, 'Paste'));
    if (!pasted.ok) throw new Error('paste failed');
    await call(() => result.current.apply(rename, 'Paste', { joinUndo: pasted.undoStep ?? null }));

    const redo2 = [makeRestore('redo2')];
    api.postOps
      .mockResolvedValueOnce(makeOpsResult({ version: 8, inverse: redo2 }))
      .mockRejectedValueOnce(apiError(409, { code: 'plan_locked' }));
    await call(() => result.current.undo());
    expect(toast).toHaveBeenCalledWith(
      'The schedule is locked, so only progress can be updated until someone unlocks it.');
    expect(result.current.plan?.version).toBe(8);
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(true);

    api.postOps.mockResolvedValueOnce(makeOpsResult({ version: 9 }));
    await call(() => result.current.undo());
    expect(api.postOps.mock.lastCall).toEqual(['plan-1', 8, inv1]);
  });
});

describe('applyThen (a paste: rows, then what names them)', () => {
  const add: Op[] = [{ op: 'add_task', temp_id: 't1', name: 'Crate' }];
  const addResult = (over: Partial<OpsResult> = {}) => makeOpsResult({
    version: 6, inverse: [makeRestore('one')], temp_ids: { t1: 'n' },
    tasks: [makeTask('n', { display_id: 4, position: 3, name: 'Crate' })], order: ['a', 'b', 'c', 'n'], ...over,
  });
  const linkNew = (first: { tempIds: Record<string, string> }): Op[] =>
    [{ op: 'update_task', id: first.tempIds.t1, fields: { predecessors: '1' } }];

  it('sends the second batch with the ids the first answered, and both undo as one step', async () => {
    const { result } = await loaded();
    api.postOps
      .mockResolvedValueOnce(addResult())
      .mockResolvedValueOnce(makeOpsResult({ version: 7, inverse: [makeRestore('two')] }));
    const out = await call(() => result.current.applyThen(add, 'Paste', linkNew));
    expect(out.first.ok && out.second?.ok).toBe(true);
    expect(api.postOps.mock.calls[1]).toEqual(['plan-1', 6, [{ op: 'update_task', id: 'n', fields: { predecessors: '1' } }]]);
    expect(result.current.undoLabel).toBe('Paste');
    api.postOps
      .mockResolvedValueOnce(makeOpsResult({ version: 8 }))
      .mockResolvedValueOnce(makeOpsResult({ version: 9 }));
    await call(() => result.current.undo());
    expect(api.postOps.mock.calls[2][2]).toEqual([makeRestore('two')]);
    expect(api.postOps.mock.calls[3][2]).toEqual([makeRestore('one')]);
    expect(result.current.canUndo).toBe(false);
  });

  it('a write asked for while the paste runs lands after both batches, never between them', async () => {
    const { result } = await loaded();
    const held = deferred<OpsResult>();
    api.postOps
      .mockReturnValueOnce(held.promise)
      .mockResolvedValueOnce(makeOpsResult({ version: 7, inverse: [makeRestore('two')] }))
      .mockResolvedValueOnce(makeOpsResult({ version: 8, inverse: [makeRestore('three')] }));
    let paste!: Promise<unknown>;
    let edit!: Promise<unknown>;
    act(() => {
      paste = result.current.applyThen(add, 'Paste', linkNew);
      edit = result.current.apply(rename, 'Edit Task Name');
    });
    await act(async () => { held.resolve(addResult()); await paste; await edit; });
    expect(api.postOps.mock.calls.map((c) => c[2])).toEqual([
      add, [{ op: 'update_task', id: 'n', fields: { predecessors: '1' } }], rename,
    ]);
    expect(api.postOps.mock.calls.map((c) => c[1])).toEqual([5, 6, 7]);
    // two steps: the edit, then the paste (both of its batches)
    expect(result.current.undoLabel).toBe('Edit Task Name');
  });

  it('a first batch the rules stop sends no second one', async () => {
    const { result } = await loaded();
    api.postOps.mockRejectedValueOnce(apiError(409, {
      code: 'completion_confirm', will_complete: [], open_predecessors: [blocker('a', 1, 'predecessor')],
    }));
    const then = vi.fn(linkNew);
    const out = await call(() => result.current.applyThen(add, 'Paste', then));
    expect(out.first).toMatchObject({ ok: false, kind: 'confirm' });
    expect(out.second).toBeNull();
    expect(then).not.toHaveBeenCalled();
    expect(api.postOps).toHaveBeenCalledTimes(1);
  });

  it('a refused second batch leaves the first in, as the paste’s one undo step', async () => {
    const { result } = await loaded();
    api.postOps
      .mockResolvedValueOnce(addResult())
      .mockRejectedValueOnce(apiError(422, { code: 'link_cycle', display_ids: [1, 4] }));
    const out = await call(() => result.current.applyThen(add, 'Paste', linkNew));
    expect(out.first.ok).toBe(true);
    expect(out.second).toMatchObject({ ok: false, kind: 'error', code: 'link_cycle' });
    expect(result.current.plan?.tasks.map((t) => t.id)).toEqual(['a', 'b', 'c', 'n']);
    expect(result.current.undoLabel).toBe('Paste');
    api.postOps.mockResolvedValueOnce(makeOpsResult({ version: 7, deleted_tasks: ['n'], order: ['a', 'b', 'c'] }));
    await call(() => result.current.undo());
    expect(api.postOps.mock.lastCall?.[2]).toEqual([makeRestore('one')]);
    expect(result.current.canUndo).toBe(false);
  });

  it('a tab that moved on between the batches answers the second as gone, not as nothing to send', async () => {
    const hook = await loaded();
    const held = deferred<OpsResult>();
    api.postOps.mockReturnValueOnce(held.promise);
    let paste!: Promise<{ first: ApplyResult; second: ApplyResult | null }>;
    act(() => { paste = hook.result.current.applyThen(add, 'Paste', linkNew); });
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(1));
    hook.unmount();
    held.resolve(addResult());
    const out = await paste;
    expect(out.first.ok).toBe(true);
    expect(out.second).toMatchObject({ ok: false, kind: 'error', code: 'gone' });
    expect(api.postOps).toHaveBeenCalledTimes(1);
  });

  it('a second batch someone else’s change stopped reloads quietly and says so in its answer (one message)', async () => {
    const { result } = await loaded();
    api.postOps
      .mockResolvedValueOnce(addResult())
      .mockRejectedValueOnce(apiError(409, { code: 'plan_changed', version: 9 }));
    api.getPlan.mockResolvedValueOnce(makePlan({ version: 9 }));
    const out = await call(() => result.current.applyThen(add, 'Paste', linkNew));
    expect(out.second).toMatchObject({ ok: false, kind: 'error', code: 'plan_changed', reloaded: true });
    expect(result.current.plan?.version).toBe(9);
    expect(result.current.canUndo).toBe(false);
    // the caller words the paste's outcome: usePlan says nothing of its own
    expect(toast).not.toHaveBeenCalled();
  });

  it('a second batch whose reload failed doesn’t claim it was reloaded, and toasts nothing itself', async () => {
    const { result } = await loaded();
    api.postOps
      .mockResolvedValueOnce(addResult())
      .mockRejectedValueOnce(apiError(409, { code: 'plan_changed', version: 9 }));
    api.getPlan.mockRejectedValueOnce(apiError(500, { code: 'server_error' }));
    const out = await call(() => result.current.applyThen(add, 'Paste', linkNew));
    expect(out.second).toMatchObject({ ok: false, kind: 'error', code: 'plan_changed', reloaded: false });
    expect(out.second && !out.second.ok && out.second.kind === 'error' && out.second.message).toBeTruthy();
    expect(out.second && !out.second.ok && out.second.kind === 'error' && out.second.message)
      .not.toBe('This plan was changed by someone else — reloaded.');
    expect(toast).not.toHaveBeenCalled();
  });

  it('a late batch joins the step it names only while that step is still on top', async () => {
    const { result } = await loaded();
    api.postOps
      .mockResolvedValueOnce(makeOpsResult({ version: 6, inverse: [makeRestore('paste')] }))
      .mockResolvedValueOnce(makeOpsResult({ version: 7, inverse: [makeRestore('edit')] }))
      .mockResolvedValueOnce(makeOpsResult({ version: 8, inverse: [makeRestore('late')] }));
    const first = await call(() => result.current.apply(rename, 'Paste'));
    if (!first.ok) throw new Error('paste failed');
    await call(() => result.current.apply(relink, 'Edit Predecessors'));
    await call(() => result.current.apply(rename, 'Paste', { joinUndo: first.undoStep ?? null }));
    // the paste's step isn't on top any more: the late batch is its own step
    api.postOps.mockResolvedValueOnce(makeOpsResult({ version: 9 }));
    await call(() => result.current.undo());
    expect(api.postOps.mock.lastCall?.[2]).toEqual([makeRestore('late')]);
    expect(result.current.undoLabel).toBe('Edit Predecessors');
  });
});

describe('undo failures', () => {
  it('keeps a step the API refused, says why, and leaves the plan as it was', async () => {
    const { result } = await loaded();
    const inverse = [makeRestore('inv1')];
    api.postOps.mockResolvedValueOnce(makeOpsResult({ version: 6, inverse }));
    await call(() => result.current.apply(rename, 'Rename'));
    const before = result.current.plan;

    api.postOps.mockRejectedValueOnce(apiError(409, { code: 'plan_locked' }));
    await call(() => result.current.undo());
    expect(toast).toHaveBeenCalledWith(
      'The schedule is locked, so only progress can be updated until someone unlocks it.');
    expect(result.current.plan).toBe(before);
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(false);
  });

  it('reloads and clears both sides when an undo meets someone else’s change', async () => {
    const { result } = await loaded();
    api.postOps.mockResolvedValueOnce(makeOpsResult({ version: 6 }));
    await call(() => result.current.apply(rename, 'Rename'));

    api.postOps.mockRejectedValueOnce(apiError(409, { code: 'plan_changed', version: 8 }));
    api.getPlan.mockResolvedValueOnce(makePlan({ version: 8 }));
    await call(() => result.current.undo());
    expect(api.getPlan).toHaveBeenCalledTimes(2);
    expect(toast).toHaveBeenCalledWith('This plan was changed by someone else — reloaded.');
    expect(result.current.plan?.version).toBe(8);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });

  it('does nothing with nothing to undo or redo', async () => {
    const { result } = await loaded();
    await call(() => result.current.undo());
    await call(() => result.current.redo());
    expect(api.postOps).not.toHaveBeenCalled();
  });
});

describe('plan-level writes', () => {
  it('patch sends the version the write before it answered and shows the plan it returns', async () => {
    const { result } = await loaded();
    const first = deferred<OpsResult>();
    api.postOps.mockImplementationOnce(() => first.promise);
    api.patchPlan.mockResolvedValueOnce(makePlan({ version: 7, status_date: '2026-11-03T17:00' }));
    let applied!: Promise<unknown>;
    let patched!: Promise<unknown>;
    act(() => {
      applied = result.current.apply(rename, 'Rename');
      patched = result.current.patch({ status_date: '2026-11-03' });
    });
    first.resolve(makeOpsResult({ version: 6 }));
    await call(() => Promise.all([applied, patched]));
    expect(api.patchPlan).toHaveBeenCalledWith('plan-1', { status_date: '2026-11-03', base_version: 6 });
    expect(result.current.plan?.version).toBe(7);
    expect(result.current.plan?.status_date).toBe('2026-11-03T17:00');
    expect(result.current.canUndo).toBe(true);           // our own write keeps undo
  });

  it('patch on someone else’s change reloads, says so, and rejects', async () => {
    const { result } = await loaded();
    const conflict = apiError(409, { code: 'plan_changed', version: 9 });
    api.patchPlan.mockRejectedValueOnce(conflict);
    api.getPlan.mockResolvedValueOnce(makePlan({ version: 9 }));
    const caught = await rejection(() => result.current.patch({ settings: { show_times: true } }));
    expect(caught).toBe(conflict);
    expect(isPlanChanged(caught)).toBe(true);
    expect(api.getPlan).toHaveBeenCalledTimes(2);
    expect(toast).toHaveBeenCalledWith('This plan was changed by someone else — reloaded.');
    expect(result.current.plan?.version).toBe(9);
  });

  it('patch rejects any other error and leaves the plan', async () => {
    const { result } = await loaded();
    const before = result.current.plan;
    const bad = apiError(422, { code: 'bad_timezone' });
    api.patchPlan.mockRejectedValueOnce(bad);
    expect(await rejection(() => result.current.patch({ timezone: 'Mars/Olympus' }))).toBe(bad);
    expect(result.current.plan).toBe(before);
  });

  it('lock, unlock and clearing the baseline show the plan they return', async () => {
    const { result } = await loaded();
    api.lockPlan.mockResolvedValueOnce(makePlan({ version: 6, locked_at: '2026-10-28T10:00:00Z', locked_by_name: 'Dana Reyes' }));
    await call(() => result.current.lock());
    expect(api.lockPlan).toHaveBeenCalledWith('plan-1');
    expect(result.current.plan?.locked_by_name).toBe('Dana Reyes');

    api.unlockPlan.mockResolvedValueOnce(makePlan({ version: 7 }));
    await call(() => result.current.unlock());
    expect(result.current.plan?.locked_at).toBeNull();

    api.clearBaseline.mockResolvedValueOnce(makePlan({ version: 8, baseline_set_at: null }));
    await call(() => result.current.clearBaseline());
    expect(api.clearBaseline).toHaveBeenCalledWith('plan-1');
    expect(result.current.plan?.version).toBe(8);
  });

  it('setBaseline answers ok, or the 409 when one exists', async () => {
    const { result } = await loaded();
    api.setBaseline.mockRejectedValueOnce(apiError(409, { code: 'baseline_exists', set_at: '2026-10-20T10:00:00Z' }));
    expect(await call(() => result.current.setBaseline(false))).toEqual({
      ok: false, kind: 'error', code: 'baseline_exists', message: 'This plan already has a baseline.',
      setAt: '2026-10-20T10:00:00Z',
    });
    api.setBaseline.mockResolvedValueOnce(makePlan({ version: 6, baseline_set_at: '2026-10-28T10:00:00Z' }));
    expect(await call(() => result.current.setBaseline(true))).toEqual({ ok: true, notices: [], tempIds: {} });
    expect(api.setBaseline).toHaveBeenLastCalledWith('plan-1', true);
    expect(result.current.plan?.baseline_set_at).toBe('2026-10-28T10:00:00Z');
  });

  it('updateProject posts, keeps its undo, and reads the plan again', async () => {
    const { result } = await loaded();
    api.updateProject.mockResolvedValueOnce(makeOpsResult({
      version: 6, inverse: [makeRestore('up')], tasks: [makeTask('a', { percent_complete: 100 })],
    }));
    api.getPlan.mockResolvedValueOnce(makePlan({ version: 6, status_date: '2026-11-03T17:00' }));
    const body = { status_date: '2026-11-03', complete_through: '2026-11-03' };
    const res = await call(() => result.current.updateProject(body));
    expect(api.updateProject).toHaveBeenCalledWith('plan-1', body);
    expect(res).toMatchObject({ ok: true, notices: [], tempIds: {} });
    expect(api.getPlan).toHaveBeenCalledTimes(2);
    expect(result.current.plan?.status_date).toBe('2026-11-03T17:00');
    expect(result.current.canUndo).toBe(true);
    expect(result.current.undoLabel).toBe('Update Project');
  });

  it('updateProject maps a completion_confirm', async () => {
    const { result } = await loaded();
    api.updateProject.mockRejectedValueOnce(apiError(409, {
      code: 'completion_confirm', will_complete: [blocker('c', 3, 'subtask')], open_predecessors: [],
    }));
    const res = await call(() => result.current.updateProject({ status_date: null, complete_through: '2026-11-03' }));
    expect(res).toEqual({ ok: false, kind: 'confirm', willComplete: [blocker('c', 3, 'subtask')], openPredecessors: [] });
    expect(api.getPlan).toHaveBeenCalledTimes(1);
  });

  it('create shows the new plan; remove goes back to none and forgets undo', async () => {
    api.getPlan.mockRejectedValueOnce(apiError(404, { code: 'no_plan' }));
    const { result } = renderHook(() => usePlan('init-1'));
    await waitFor(() => expect(result.current.status).toBe('none'));

    api.createPlan.mockResolvedValueOnce(makePlan());
    await call(() => result.current.create({ project_start: '2026-11-02' }));
    expect(api.createPlan).toHaveBeenCalledWith('init-1', { project_start: '2026-11-02' });
    expect(result.current.status).toBe('ready');

    api.postOps.mockResolvedValueOnce(makeOpsResult({ version: 6 }));
    await call(() => result.current.apply(rename, 'Rename'));
    api.deletePlan.mockResolvedValueOnce(undefined);
    await call(() => result.current.remove());
    expect(api.deletePlan).toHaveBeenCalledWith('init-1');
    expect(result.current.status).toBe('none');
    expect(result.current.plan).toBeNull();
    expect(result.current.canUndo).toBe(false);
  });

  it('create rejects with the API’s error', async () => {
    api.getPlan.mockRejectedValueOnce(apiError(404, { code: 'no_plan' }));
    const { result } = renderHook(() => usePlan('init-1'));
    await waitFor(() => expect(result.current.status).toBe('none'));
    const bad = apiError(422, { code: 'bad_field', field: 'project_start' });
    api.createPlan.mockRejectedValueOnce(bad);
    expect(await rejection(() => result.current.create({ project_start: 'soon' }))).toBe(bad);
    expect(result.current.status).toBe('none');
  });

  it('reload reads the plan again and clears undo', async () => {
    const { result } = await loaded();
    api.postOps.mockResolvedValueOnce(makeOpsResult({ version: 6 }));
    await call(() => result.current.apply(rename, 'Rename'));
    api.getPlan.mockResolvedValueOnce(makePlan({ version: 6 }));
    await call(() => result.current.reload());
    expect(api.getPlan).toHaveBeenCalledTimes(2);
    expect(result.current.canUndo).toBe(false);
  });

  it('a reload that finds the plan out of reach drops it and shows why', async () => {
    const { result } = await loaded();
    api.getPlan.mockRejectedValueOnce(apiError(404, { code: 'initiative_not_found' }));
    await call(() => result.current.reload());
    expect(result.current.status).toBe('error');
    expect(result.current.plan).toBeNull();
    expect(result.current.error).toBe('This initiative no longer exists, or you can’t see it.');
    expect(toast).not.toHaveBeenCalled();
  });

  it('a reload after someone deleted the plan goes back to none', async () => {
    const { result } = await loaded();
    api.getPlan.mockRejectedValueOnce(apiError(404, { code: 'no_plan' }));
    await call(() => result.current.reload());
    expect(result.current.status).toBe('none');
    expect(result.current.plan).toBeNull();
  });

  it('create when someone else just made one shows theirs, then rejects', async () => {
    api.getPlan.mockRejectedValueOnce(apiError(404, { code: 'no_plan' }));
    const { result } = renderHook(() => usePlan('init-1'));
    await waitFor(() => expect(result.current.status).toBe('none'));
    const exists = apiError(409, { code: 'plan_exists' });
    api.createPlan.mockRejectedValueOnce(exists);
    api.getPlan.mockResolvedValueOnce(makePlan({ version: 3 }));
    expect(await rejection(() => result.current.create({ project_start: '2026-11-02' }))).toBe(exists);
    expect(result.current.status).toBe('ready');
    expect(result.current.plan?.version).toBe(3);
  });

  it('a failed reload keeps the plan on screen and says why', async () => {
    const { result } = await loaded();
    const before = result.current.plan;
    api.getPlan.mockRejectedValueOnce(apiError(500, { code: 'unknown_error' }));
    await call(() => result.current.reload());
    expect(result.current.status).toBe('ready');
    expect(result.current.plan).toBe(before);
    expect(toast).toHaveBeenCalledWith('Something went wrong. Try again.');
  });

  it('a reload that finds nothing new drops nothing queued behind it and says nothing', async () => {
    const { result } = await loaded();
    const fresh = deferred<Plan>();
    api.getPlan.mockImplementationOnce(() => fresh.promise);
    let reloaded!: Promise<void>;
    let applied!: Promise<ApplyResult>;
    act(() => {
      reloaded = result.current.reload();
      applied = result.current.apply(rename, 'Rename');   // typed while it loads
    });
    api.postOps.mockResolvedValueOnce(makeOpsResult({ version: 6 }));
    fresh.resolve(makePlan({ version: 5 }));                // the version already on screen
    await act(async () => { await reloaded; });
    expect((await call(() => applied)).ok).toBe(true);
    expect(api.postOps).toHaveBeenCalledWith('plan-1', 5, rename);
    expect(toast).not.toHaveBeenCalled();
  });

  it('a reload that finds a newer version still drops what was queued behind it', async () => {
    const { result } = await loaded();
    const fresh = deferred<Plan>();
    api.getPlan.mockImplementationOnce(() => fresh.promise);
    let reloaded!: Promise<void>;
    let applied!: Promise<ApplyResult>;
    act(() => {
      reloaded = result.current.reload();
      applied = result.current.apply(rename, 'Rename');
    });
    fresh.resolve(makePlan({ version: 6 }));
    await act(async () => { await reloaded; });
    expect(await call(() => applied)).toEqual(CHANGED);
    expect(api.postOps).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledTimes(1);
  });
});

describe('polling', () => {
  async function loadedWithFakeTimers(plan: Plan = makePlan()) {
    vi.useFakeTimers();
    api.getPlan.mockResolvedValueOnce(plan);
    const hook = renderHook(() => usePlan('init-1'));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(hook.result.current.status).toBe('ready');
    return hook;
  }

  const tick = async (ms = POLL_MS) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

  it('probes every 30 s and reloads at once when someone else moved the version', async () => {
    const { result } = await loadedWithFakeTimers();
    api.getPlanVersion.mockResolvedValue(version(5));
    await tick(POLL_MS - 1);
    expect(api.getPlanVersion).not.toHaveBeenCalled();
    await tick(1);
    expect(api.getPlanVersion).toHaveBeenCalledWith('plan-1');
    expect(api.getPlan).toHaveBeenCalledTimes(1);           // same version: nothing to do

    api.getPlanVersion.mockResolvedValue(version(6));
    api.getPlan.mockResolvedValueOnce(makePlan({ version: 6, tasks: flatTasks(['a', 'b']) }));
    await tick();
    expect(api.getPlan).toHaveBeenCalledTimes(2);
    expect(result.current.plan?.version).toBe(6);
    expect(result.current.plan?.tasks).toHaveLength(2);
    expect(result.current.staleBy).toBeNull();
  });

  it('never takes our own write for someone else’s', async () => {
    const { result } = await loadedWithFakeTimers();
    api.postOps.mockResolvedValueOnce(makeOpsResult({ version: 6 }));
    await act(async () => { await result.current.apply(rename, 'Rename'); });
    api.getPlanVersion.mockResolvedValue(version(6));
    await tick();
    expect(api.getPlanVersion).toHaveBeenCalledTimes(1);
    expect(api.getPlan).toHaveBeenCalledTimes(1);
    expect(result.current.canUndo).toBe(true);
  });

  it('while editing, waits with staleBy set, then reloads when editing ends', async () => {
    const { result } = await loadedWithFakeTimers();
    act(() => result.current.setEditing(true));
    api.getPlanVersion.mockResolvedValue(version(6, 'Dana Reyes'));
    await tick();
    expect(api.getPlan).toHaveBeenCalledTimes(1);
    expect(result.current.staleBy).toBe('Plan updated by Dana Reyes');

    api.getPlan.mockResolvedValueOnce(makePlan({ version: 6 }));
    act(() => result.current.setEditing(false));
    await tick(0);
    expect(api.getPlan).toHaveBeenCalledTimes(2);
    expect(result.current.plan?.version).toBe(6);
    expect(result.current.staleBy).toBeNull();
  });

  it('says “someone else” when the probe names nobody', async () => {
    const { result } = await loadedWithFakeTimers();
    act(() => result.current.setEditing(true));
    api.getPlanVersion.mockResolvedValue(version(6, null));
    await tick();
    expect(result.current.staleBy).toBe('Plan updated by someone else');
  });

  it('does not probe while the page is hidden', async () => {
    await loadedWithFakeTimers();
    visibility = 'hidden';
    await tick();
    expect(api.getPlanVersion).not.toHaveBeenCalled();
    visibility = 'visible';
    api.getPlanVersion.mockResolvedValue(version(5));
    await tick();
    expect(api.getPlanVersion).toHaveBeenCalledTimes(1);
  });

  it('a progress batch that skipped someone else’s write leaves the next probe to reload', async () => {
    const { result } = await loadedWithFakeTimers();
    // version 6 was someone else's progress edit; ours made it 7
    api.postOps.mockResolvedValueOnce(makeOpsResult({ version: 7 }));
    await act(async () => {
      await result.current.apply([{ op: 'set_percent', ids: ['a'], percent: 50 }], '50% Complete');
    });
    api.getPlanVersion.mockResolvedValue(version(7));
    api.getPlan.mockResolvedValueOnce(makePlan({ version: 7 }));
    await tick();
    expect(api.getPlan).toHaveBeenCalledTimes(2);
    expect(result.current.plan?.version).toBe(7);
  });

  it('a failed probe waits for the next one', async () => {
    const { result } = await loadedWithFakeTimers();
    api.getPlanVersion.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await tick();
    expect(result.current.status).toBe('ready');
    expect(toast).not.toHaveBeenCalled();
    api.getPlanVersion.mockResolvedValue(version(5));
    await tick();
    expect(api.getPlanVersion).toHaveBeenCalledTimes(2);
  });

  it('reads a probe’s plan_not_found as a change: the reload finds no plan', async () => {
    const { result } = await loadedWithFakeTimers();
    api.getPlanVersion.mockRejectedValueOnce(apiError(404, { code: 'plan_not_found' }));
    api.getPlan.mockRejectedValueOnce(apiError(404, { code: 'no_plan' }));
    await tick();
    expect(result.current.status).toBe('none');
    // no plan, no polling
    await tick();
    expect(api.getPlanVersion).toHaveBeenCalledTimes(1);
  });

  it('waits while any editor holds editing, and reloads once the last lets go', async () => {
    const { result } = await loadedWithFakeTimers();
    let releaseCell!: () => void;
    let releaseDialog!: () => void;
    act(() => {
      releaseCell = result.current.beginEditing('cell');
      releaseDialog = result.current.beginEditing('dialog');
    });
    api.getPlanVersion.mockResolvedValue(version(6));
    await tick();
    expect(result.current.staleBy).toBe('Plan updated by Dana Reyes');

    act(() => releaseCell());
    await tick(0);
    expect(api.getPlan).toHaveBeenCalledTimes(1);          // the dialog still holds it
    act(() => releaseCell());                              // a second release is a no-op
    await tick(0);
    expect(api.getPlan).toHaveBeenCalledTimes(1);

    api.getPlan.mockResolvedValueOnce(makePlan({ version: 6 }));
    act(() => releaseDialog());
    await tick(0);
    expect(api.getPlan).toHaveBeenCalledTimes(2);
    expect(result.current.plan?.version).toBe(6);
    expect(result.current.staleBy).toBeNull();
  });

  it('moving to the next cell (let go, then hold again in the same tick) does not reload', async () => {
    const { result } = await loadedWithFakeTimers();
    let release!: () => void;
    act(() => { release = result.current.beginEditing('cell'); });
    api.getPlanVersion.mockResolvedValue(version(6));
    await tick();
    expect(result.current.staleBy).toBe('Plan updated by Dana Reyes');

    act(() => {
      release();
      release = result.current.beginEditing('cell');       // Enter: the next cell's editor
    });
    await tick(0);
    expect(api.getPlan).toHaveBeenCalledTimes(1);
    expect(result.current.staleBy).toBe('Plan updated by Dana Reyes');

    // the setEditing shim flipping false then true in one tick behaves the same
    act(() => {
      release();
      result.current.setEditing(true);
    });
    act(() => {
      result.current.setEditing(false);
      result.current.setEditing(true);
    });
    await tick(0);
    expect(api.getPlan).toHaveBeenCalledTimes(1);

    api.getPlan.mockResolvedValueOnce(makePlan({ version: 6 }));
    act(() => result.current.setEditing(false));
    await tick(0);
    expect(api.getPlan).toHaveBeenCalledTimes(2);
    expect(result.current.staleBy).toBeNull();
  });

  it('never names the signed-in person as the one who changed the plan', async () => {
    const { result } = await loadedWithFakeTimers();
    act(() => result.current.setEditing(true));
    api.getPlanVersion.mockResolvedValue(version(6, 'Jimmy Henderson'));
    await tick();
    expect(result.current.staleBy).toBe('Plan updated elsewhere');
  });

  it('a write queued behind a poll reload does not post against the reloaded plan', async () => {
    const { result } = await loadedWithFakeTimers();
    api.getPlanVersion.mockResolvedValue(version(6));
    const fresh = deferred<Plan>();
    api.getPlan.mockImplementationOnce(() => fresh.promise);
    await tick();
    expect(api.getPlan).toHaveBeenCalledTimes(2);          // the poll's reload is in flight

    let applied!: Promise<ApplyResult>;
    act(() => { applied = result.current.apply(relink, 'Predecessors'); });  // typed against the old outline
    fresh.resolve(makePlan({ version: 6 }));
    await tick(0);
    expect(await applied).toEqual(CHANGED);
    expect(api.postOps).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith('This plan was changed by someone else — reloaded.');

    // a write made after the reload landed goes through
    api.postOps.mockResolvedValueOnce(makeOpsResult({ version: 7 }));
    await act(async () => { await result.current.apply(rename, 'Rename'); });
    expect(api.postOps).toHaveBeenCalledWith('plan-1', 6, rename);
  });

  it('an undo queued behind a poll reload says why it did nothing', async () => {
    const { result } = await loadedWithFakeTimers();
    api.postOps.mockResolvedValueOnce(makeOpsResult({ version: 6 }));
    await act(async () => { await result.current.apply(rename, 'Rename'); });
    api.getPlanVersion.mockResolvedValue(version(7));
    const fresh = deferred<Plan>();
    api.getPlan.mockImplementationOnce(() => fresh.promise);
    await tick();

    let undone!: Promise<void>;
    act(() => { undone = result.current.undo(); });        // pressed while the reload loads
    fresh.resolve(makePlan({ version: 7 }));
    await tick(0);
    await act(async () => { await undone; });
    expect(api.postOps).toHaveBeenCalledTimes(1);          // only the edit itself
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith('This plan was changed by someone else — reloaded.');
    expect(result.current.canUndo).toBe(false);
  });

  it('stops probing once unmounted', async () => {
    const { unmount } = await loadedWithFakeTimers();
    unmount();
    await tick();
    expect(api.getPlanVersion).not.toHaveBeenCalled();
  });
});

describe('writes queued behind someone else’s change', () => {
  it('a batch queued behind a plan_changed never posts against the reloaded plan', async () => {
    const { result } = await loaded();
    const first = deferred<OpsResult>();
    api.postOps.mockImplementationOnce(() => first.promise);
    api.getPlan.mockResolvedValueOnce(makePlan({ version: 9 }));
    let one!: Promise<ApplyResult>;
    let two!: Promise<ApplyResult>;
    act(() => {
      one = result.current.apply(rename, 'Rename');
      two = result.current.apply(relink, 'Predecessors');    // typed before the conflict came back
    });
    first.reject(apiError(409, { code: 'plan_changed', version: 9 }));
    const [r1, r2] = await call(() => Promise.all([one, two]));
    expect(r1).toEqual(CHANGED);
    expect(r2).toEqual(CHANGED);
    expect(api.postOps).toHaveBeenCalledTimes(1);
    expect(api.getPlan).toHaveBeenCalledTimes(2);          // one reload
    expect(toast).toHaveBeenCalledTimes(1);                // one toast
    expect(result.current.plan?.version).toBe(9);
  });

  it('a progress-only batch queued behind a plan_changed is still sent, against the reloaded plan', async () => {
    const { result } = await loaded();
    const first = deferred<OpsResult>();
    api.postOps.mockImplementationOnce(() => first.promise);
    api.getPlan.mockResolvedValueOnce(makePlan({ version: 9 }));
    api.postOps.mockResolvedValueOnce(makeOpsResult({ version: 10 }));
    const progress: Op[] = [{ op: 'set_percent', ids: ['a'], percent: 100 }];
    let one!: Promise<ApplyResult>;
    let two!: Promise<ApplyResult>;
    act(() => {
      one = result.current.apply(rename, 'Rename');
      two = result.current.apply(progress, '100% Complete');   // clicked as the conflict came back
    });
    first.reject(apiError(409, { code: 'plan_changed', version: 9 }));
    const [r1, r2] = await call(() => Promise.all([one, two]));
    expect(r1).toEqual(CHANGED);
    // progress never collides: it goes, at the reloaded version
    expect(r2.ok).toBe(true);
    expect(api.postOps).toHaveBeenCalledTimes(2);
    expect(api.postOps.mock.calls[1]).toEqual(['plan-1', 9, progress]);
    expect(toast).toHaveBeenCalledTimes(1);                // the reload's, nothing more
    expect(result.current.plan?.version).toBe(10);
    expect(result.current.undoLabel).toBe('100% Complete');
  });

  it('a progress-only batch on a task someone deleted meanwhile answers its 422 as usual', async () => {
    const { result } = await loaded();
    const first = deferred<OpsResult>();
    api.postOps.mockImplementationOnce(() => first.promise);
    api.getPlan.mockResolvedValueOnce(makePlan({ version: 9, tasks: flatTasks(['b', 'c']) }));
    api.postOps.mockRejectedValueOnce(new ApiError(422, 'unknown_task', { code: 'unknown_task', task_id: 'a' }));
    let two!: Promise<ApplyResult>;
    act(() => {
      void result.current.apply(rename, 'Rename');
      two = result.current.apply([{ op: 'set_percent', ids: ['a'], percent: 50 }], '50% Complete');
    });
    first.reject(apiError(409, { code: 'plan_changed', version: 9 }));
    const r2 = await call(() => two);
    expect(api.postOps).toHaveBeenCalledTimes(2);
    expect(r2).toMatchObject({ ok: false, kind: 'error', code: 'unknown_task' });
  });

  it('an undo, a redo and a patch queued behind it neither post nor reload again', async () => {
    const { result } = await loaded();
    api.postOps.mockResolvedValueOnce(makeOpsResult({ version: 6 }));
    await call(() => result.current.apply(rename, 'Rename'));
    const first = deferred<OpsResult>();
    api.postOps.mockImplementationOnce(() => first.promise);
    api.getPlan.mockResolvedValueOnce(makePlan({ version: 9 }));
    let applied!: Promise<ApplyResult>;
    let undone!: Promise<void>;
    let redone!: Promise<void>;
    let patched!: Promise<unknown>;
    act(() => {
      applied = result.current.apply(relink, 'Predecessors');
      undone = result.current.undo();
      redone = result.current.redo();
      patched = result.current.patch({ status_date: null }).then(() => null, (err: unknown) => err);
    });
    first.reject(apiError(409, { code: 'plan_changed', version: 9 }));
    const [, , , patchError] = await call(() => Promise.all([applied, undone, redone, patched]));
    expect(api.postOps).toHaveBeenCalledTimes(2);          // the first edit and the conflicting one
    expect(api.patchPlan).not.toHaveBeenCalled();
    expect(isPlanChanged(patchError)).toBe(true);
    expect(api.getPlan).toHaveBeenCalledTimes(2);
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('a write queued behind a lock whose answer skipped someone else’s write is dropped', async () => {
    const { result } = await loaded();
    const locking = deferred<Plan>();
    api.lockPlan.mockImplementationOnce(() => locking.promise);
    let locked!: Promise<void>;
    let applied!: Promise<ApplyResult>;
    act(() => {
      locked = result.current.lock();
      applied = result.current.apply(relink, 'Predecessors');
    });
    locking.resolve(makePlan({ version: 8, locked_at: '2026-10-28T10:00:00Z' }));
    await call(() => locked);
    expect(await call(() => applied)).toEqual(CHANGED);
    expect(api.postOps).not.toHaveBeenCalled();
    expect(result.current.plan?.version).toBe(8);
  });
});

describe('the gap rule for plan-level writes', () => {
  it('keeps undo when the answer is the next version', async () => {
    const { result } = await loaded();
    api.postOps.mockResolvedValueOnce(makeOpsResult({ version: 6 }));
    await call(() => result.current.apply(rename, 'Rename'));
    api.lockPlan.mockResolvedValueOnce(makePlan({ version: 7, locked_at: '2026-10-28T10:00:00Z' }));
    await call(() => result.current.lock());
    expect(result.current.canUndo).toBe(true);
  });

  it('forgets undo when lock, unlock, setBaseline or clearBaseline skipped someone else’s write', async () => {
    const { result } = await loaded();
    const edit = async (v: number) => {
      api.postOps.mockResolvedValueOnce(makeOpsResult({ version: v }));
      await call(() => result.current.apply(rename, 'Rename'));
      expect(result.current.canUndo).toBe(true);
    };
    await edit(6);
    api.lockPlan.mockResolvedValueOnce(makePlan({ version: 8 }));
    await call(() => result.current.lock());
    expect(result.current.canUndo).toBe(false);

    await edit(9);
    api.unlockPlan.mockResolvedValueOnce(makePlan({ version: 11 }));
    await call(() => result.current.unlock());
    expect(result.current.canUndo).toBe(false);

    await edit(12);
    api.setBaseline.mockResolvedValueOnce(makePlan({ version: 14 }));
    await call(() => result.current.setBaseline(false));
    expect(result.current.canUndo).toBe(false);

    await edit(15);
    api.clearBaseline.mockResolvedValueOnce(makePlan({ version: 17 }));
    await call(() => result.current.clearBaseline());
    expect(result.current.canUndo).toBe(false);
    expect(result.current.plan?.version).toBe(17);
  });

  it('forgets undo when Update Project’s refetch finds someone else’s write', async () => {
    const { result } = await loaded();
    api.updateProject.mockResolvedValueOnce(makeOpsResult({ version: 6, inverse: [makeRestore('up')] }));
    api.getPlan.mockResolvedValueOnce(makePlan({ version: 8 }));
    await call(() => result.current.updateProject({ status_date: '2026-11-03' }));
    expect(result.current.plan?.version).toBe(8);
    expect(result.current.canUndo).toBe(false);
  });
});

describe('a controller the tab has moved on from', () => {
  it('does nothing to the next initiative’s plan', async () => {
    api.getPlan.mockResolvedValueOnce(makePlan());
    const { result, rerender } = renderHook(({ id }) => usePlan(id), { initialProps: { id: 'init-1' } });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const old = result.current;
    api.getPlan.mockResolvedValueOnce(makePlan({ id: 'plan-2', initiative_id: 'init-2', version: 1 }));
    rerender({ id: 'init-2' });
    await waitFor(() => expect(result.current.plan?.id).toBe('plan-2'));

    const res = await call(() => old.apply(rename, 'Rename'));
    await call(() => old.reload());
    await call(() => old.undo());
    await call(() => old.lock());
    expect(res).toMatchObject({ ok: false, kind: 'error', code: 'gone' });
    expect(api.postOps).not.toHaveBeenCalled();
    expect(api.lockPlan).not.toHaveBeenCalled();
    expect(api.getPlan).toHaveBeenCalledTimes(2);
    expect(result.current.plan?.id).toBe('plan-2');
  });

  it('a write still queued when the tab closes never posts', async () => {
    const { result, unmount } = await loaded();
    const first = deferred<OpsResult>();
    api.postOps.mockImplementationOnce(() => first.promise);
    let one!: Promise<ApplyResult>;
    let two!: Promise<ApplyResult>;
    act(() => {
      one = result.current.apply(rename, 'Rename');
      two = result.current.apply(relink, 'Predecessors');
    });
    await act(async () => { await Promise.resolve(); });
    expect(api.postOps).toHaveBeenCalledTimes(1);          // the first is posting
    unmount();
    first.resolve(makeOpsResult({ version: 6 }));
    const [r1, r2] = await Promise.all([one, two]);
    expect(r1).toMatchObject({ ok: true, notices: [], tempIds: {} });
    expect(r2).toEqual({ ok: false, kind: 'error', code: 'gone', message: '' });
    expect(api.postOps).toHaveBeenCalledTimes(1);
  });
});

describe('more undo coverage', () => {
  it('an undo pressed while its edit is still posting undoes that edit', async () => {
    const { result } = await loaded();
    const first = deferred<OpsResult>();
    api.postOps.mockImplementationOnce(() => first.promise);
    let applied!: Promise<ApplyResult>;
    let undone!: Promise<void>;
    act(() => {
      applied = result.current.apply(rename, 'Rename');
      undone = result.current.undo();
    });
    const inverse = [makeRestore('inv')];
    api.postOps.mockResolvedValueOnce(makeOpsResult({ version: 7, inverse: [makeRestore('redo')] }));
    first.resolve(makeOpsResult({ version: 6, inverse }));
    await call(() => Promise.all([applied, undone]));
    expect(api.postOps).toHaveBeenCalledTimes(2);
    expect(api.postOps.mock.calls[1]).toEqual(['plan-1', 6, inverse]);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(true);
  });

  it('keeps a redo the API refused on the redo side and says why', async () => {
    const { result } = await loaded();
    api.postOps
      .mockResolvedValueOnce(makeOpsResult({ version: 6 }))
      .mockResolvedValueOnce(makeOpsResult({ version: 7, inverse: [makeRestore('redo')] }));
    await call(() => result.current.apply(rename, 'Rename'));
    await call(() => result.current.undo());
    const before = result.current.plan;
    api.postOps.mockRejectedValueOnce(apiError(422, { code: 'bad_restore' }));
    await call(() => result.current.redo());
    expect(toast).toHaveBeenCalledWith('That change can’t be undone anymore, so reload the plan and try again.');
    expect(result.current.plan).toBe(before);
    expect(result.current.canRedo).toBe(true);
    expect(result.current.canUndo).toBe(false);
  });
});

describe('types', () => {
  it('leaves base_version to the controller', async () => {
    const { result } = await loaded();
    api.patchPlan.mockResolvedValueOnce(makePlan({ version: 6 }));
    // @ts-expect-error base_version is the controller's, never the caller's
    await call(() => result.current.patch({ base_version: 3, status_date: null }));
    expect(api.patchPlan).toHaveBeenCalledWith('plan-1', { status_date: null, base_version: 5 });
  });
});

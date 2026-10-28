/** The plan API client: each route's method, path and body, errors as
 *  ApiError, undo inverses sent back value for value, and the progress-only
 *  rule mirrored from the API (plans/ops.py, is_progress_only). */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Op, RestoreOp, TaskFields } from './api';

const http = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('../api', async (importActual) => ({
  ...(await importActual<typeof import('../api')>()),
  apiFetch: http.apiFetch,
}));

const { ApiError } = await import('../api');
const P = await import('./api');

type Call = { path: string; method: string; body: unknown };

const json = (body: unknown, status = 200) => (status === 204
  ? new Response(null, { status })
  : new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

function answer(response: () => Response): Call[] {
  const calls: Call[] = [];
  http.apiFetch.mockImplementation(async (path: string, init: RequestInit = {}) => {
    calls.push({
      path, method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return response();
  });
  return calls;
}

beforeEach(() => http.apiFetch.mockReset());

const SIGNED_RESTORE: RestoreOp = {
  op: 'restore',
  tasks: [{ id: 't-1', notes: null, percent_complete: 0, completed_at: null, completed_by: null }],
  links: [],
  assignments: [],
  remove_tasks: [],
  remove_links: [],
  sig: 'ab12',
};

// [name, call, method, path, body]
const CASES: [string, () => Promise<unknown>, string, string, unknown][] = [
  ['getPlan', () => P.getPlan('i 1'), 'GET', '/initiatives/i%201/plan', undefined],
  ['createPlan', () => P.createPlan('i1', { project_start: '2026-11-02' }), 'POST', '/initiatives/i1/plan',
    { project_start: '2026-11-02' }],
  ['deletePlan', () => P.deletePlan('i1'), 'DELETE', '/initiatives/i1/plan', undefined],
  ['postOps', () => P.postOps('p1', 7, [{ op: 'indent', ids: ['t1'] }]), 'POST', '/plans/p1/ops',
    { base_version: 7, ops: [{ op: 'indent', ids: ['t1'] }] }],
  ['patchPlan', () => P.patchPlan('p1', { base_version: 7, status_date: null }), 'PATCH', '/plans/p1',
    { base_version: 7, status_date: null }],
  ['lockPlan', () => P.lockPlan('p1'), 'POST', '/plans/p1/lock', undefined],
  ['unlockPlan', () => P.unlockPlan('p1'), 'DELETE', '/plans/p1/lock', undefined],
  ['setBaseline', () => P.setBaseline('p1', false), 'POST', '/plans/p1/baseline', { replace: false }],
  ['setBaseline replace', () => P.setBaseline('p1', true), 'POST', '/plans/p1/baseline', { replace: true }],
  ['clearBaseline', () => P.clearBaseline('p1'), 'DELETE', '/plans/p1/baseline', undefined],
  ['updateProject', () => P.updateProject('p1', { status_date: '2026-11-06', complete_through: null }),
    'POST', '/plans/p1/update-project', { status_date: '2026-11-06', complete_through: null }],
  ['getPlanVersion', () => P.getPlanVersion('p1'), 'GET', '/plans/p1/version', undefined],
];

describe('routes', () => {
  it.each(CASES)('%s', async (_name, call, method, path, body) => {
    const calls = answer(() => json({}));
    await call();
    expect(calls).toEqual([{ path, method, body }]);
  });

  it('sends JSON only with a body', async () => {
    answer(() => json({}));
    await P.lockPlan('p1');
    await P.postOps('p1', 1, [{ op: 'complete', ids: ['t1'] }]);
    const [[, bare], [, sent]] = http.apiFetch.mock.calls as [string, RequestInit][];
    expect(bare.headers).toBeUndefined();
    expect(sent.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('answers the parsed body, and nothing for a 204', async () => {
    answer(() => json({ version: 3, updated_at: '2026-11-02T13:00:00Z', updated_by_name: 'Pat' }));
    expect(await P.getPlanVersion('p1')).toEqual(
      { version: 3, updated_at: '2026-11-02T13:00:00Z', updated_by_name: 'Pat' });
    answer(() => json(null, 204));
    expect(await P.deletePlan('i1')).toBeUndefined();
  });
});

describe('errors', () => {
  it('throws an ApiError carrying plan_changed on a 409', async () => {
    answer(() => json({ detail: { code: 'plan_changed', version: 9 } }, 409));
    const err = await P.postOps('p1', 7, [{ op: 'indent', ids: ['t1'] }]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as InstanceType<typeof ApiError>).status).toBe(409);
    expect((err as InstanceType<typeof ApiError>).code).toBe('plan_changed');
    expect((err as InstanceType<typeof ApiError>).detail).toEqual({ code: 'plan_changed', version: 9 });
  });

  it('throws no_plan for an initiative without one', async () => {
    answer(() => json({ detail: { code: 'no_plan' } }, 404));
    await expect(P.getPlan('i1')).rejects.toMatchObject({ status: 404, code: 'no_plan' });
  });

  it('refuses an empty or oversized batch before sending it', async () => {
    answer(() => json({}));
    await expect(P.postOps('p1', 1, [])).rejects.toThrow(RangeError);
    const many = Array.from({ length: P.MAX_OPS + 1 }, () => ({ op: 'indent' as const, ids: ['t1'] }));
    await expect(P.postOps('p1', 1, many)).rejects.toThrow(RangeError);
    expect(http.apiFetch).not.toHaveBeenCalled();
    expect(P.MAX_OPS).toBe(5000);
  });
});

describe('undo inverses', () => {
  it('sends a restore back value for value', async () => {
    const restore = {
      ...SIGNED_RESTORE,
      tasks: [{ id: 'T-UPPER', name: 'Ünïcode', notes: null, position: 3, actual_start: null }],
      remove_links: ['L-2'],
    };
    const calls = answer(() => json({}));
    await P.postOps('p1', 4, [restore]);
    expect(calls[0].body).toEqual({ base_version: 4, ops: [restore] });
    // null keys stay, ids keep their case, numbers stay numbers
    expect(JSON.stringify(calls[0].body)).toContain('"notes":null');
    expect(JSON.stringify(calls[0].body)).toContain('"T-UPPER"');
    expect(JSON.stringify(calls[0].body)).toContain('"position":3');
  });
});

describe('isProgressOnly', () => {
  const update = (fields: TaskFields): Op => ({ op: 'update_task', id: 't1', fields });

  it('takes the progress ops whatever they carry', () => {
    expect(P.isProgressOnly([{ op: 'set_percent', ids: ['t1'], percent: 50 }])).toBe(true);
    expect(P.isProgressOnly([{ op: 'complete', ids: ['t1'], confirm: true }, { op: 'mark_on_track', ids: ['t2'] }]))
      .toBe(true);
  });

  it('takes an update_task of progress fields only', () => {
    expect(P.isProgressOnly([update({ percent_complete: 40, notes: null })])).toBe(true);
    expect(P.isProgressOnly([update({ actual_start: '2026-11-02', actual_finish: null })])).toBe(true);
    expect(P.isProgressOnly([update({ notes: 'x', name: 'y' })])).toBe(false);
    expect(P.isProgressOnly([update({})])).toBe(false);
    // a key left undefined is not sent
    expect(P.isProgressOnly([update({ notes: 'x', name: undefined })])).toBe(true);
  });

  it('takes a color: cosmetic, like the API’s PROGRESS_FIELDS (a locked plan still changes colors)', () => {
    expect(P.PROGRESS_FIELDS.has('color')).toBe(true);
    expect(P.isProgressOnly([update({ color: '#1e88e5' }), update({ color: null })])).toBe(true);
    expect(P.isProgressOnly([update({ color: '#1e88e5', name: 'y' })])).toBe(false);
    // and so is its undo
    expect(P.isProgressOnly([{ ...SIGNED_RESTORE, tasks: [{ id: 't1', color: null }] }])).toBe(true);
  });

  it('takes the signed restore that undoes a progress edit, and an empty one', () => {
    expect(P.isProgressOnly([SIGNED_RESTORE])).toBe(true);
    expect(P.isProgressOnly([{ ...SIGNED_RESTORE, tasks: [] }])).toBe(true);
    expect(P.isProgressOnly([{ ...SIGNED_RESTORE, tasks: [{ id: 't1' }] }])).toBe(false);
    expect(P.isProgressOnly([{ ...SIGNED_RESTORE, tasks: [{ id: 't1', name: 'x' }] }])).toBe(false);
    expect(P.isProgressOnly([{ ...SIGNED_RESTORE, remove_links: ['l1'] }])).toBe(false);
    expect(P.isProgressOnly([{ ...SIGNED_RESTORE, sig: '' }])).toBe(false);
  });

  it('refuses any other op, and an empty batch', () => {
    expect(P.isProgressOnly([])).toBe(false);
    expect(P.isProgressOnly([{ op: 'set_percent', ids: ['t1'], percent: 5 }, { op: 'indent', ids: ['t1'] }]))
      .toBe(false);
    expect(P.isProgressOnly([{ op: 'set_assignees', task_id: 't1', resources: [] }])).toBe(false);
  });
});

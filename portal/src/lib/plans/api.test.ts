/** The plan API client: each route's method, path and body, errors as
 *  ApiError, undo inverses sent back value for value, and the progress-only
 *  rule mirrored from the API (plans/ops.py, is_progress_only). */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Op, PlanImport, RestoreOp, TaskFields } from './api';

const http = vi.hoisted(() => ({ apiFetch: vi.fn(), saveBlob: vi.fn() }));
vi.mock('../api', async (importActual) => ({
  ...(await importActual<typeof import('../api')>()),
  apiFetch: http.apiFetch,
  saveBlob: http.saveBlob,
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

beforeEach(() => {
  http.apiFetch.mockReset();
  http.saveBlob.mockReset();
});

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
  ['getProjectPlanSettings', () => P.getProjectPlanSettings(), 'GET', '/system/project-plans', undefined],
  ['putProjectPlanSettings', () => P.putProjectPlanSettings({ critical_slack_days: 0.5 }), 'PUT',
    '/system/project-plans', { critical_slack_days: 0.5 }],
  ['getTimelineMilestones', () => P.getTimelineMilestones('2026-09-01', '2026-09-30'), 'GET',
    '/plans/timeline?from=2026-09-01&to=2026-09-30', undefined],
  ['createPlan from a template', () => P.createPlan('i1', { project_start: '2026-11-09', template_id: 't 1' }),
    'POST', '/initiatives/i1/plan', { project_start: '2026-11-09', template_id: 't 1' }],
  ['listPlanTemplates', () => P.listPlanTemplates(), 'GET', '/plan-templates', undefined],
  ['saveAsTemplate', () => P.saveAsTemplate('p 1', { name: 'Hall move', description: null }), 'POST',
    '/plans/p%201/save-as-template', { name: 'Hall move', description: null }],
  ['patchPlanTemplate', () => P.patchPlanTemplate('t/1', { name: 'Renamed' }), 'PATCH', '/plan-templates/t%2F1',
    { name: 'Renamed' }],
  ['deletePlanTemplate', () => P.deletePlanTemplate('t1'), 'DELETE', '/plan-templates/t1', undefined],
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

const sent = (n = 0) => http.apiFetch.mock.calls[n] as [string, RequestInit];

describe('import (MS Project XML, Excel, CSV)', () => {
  const OUT: PlanImport = {
    rows: [{ index: 1, name: 'Survey', action: 'create', problems: [], moved_days: null }],
    problems: [], summary: { created: 1, problems: 0 }, version: 4,
  };
  const xml = () => new File(['<Project/>'], 'hall.xml', { type: 'application/xml' });

  it('posts the file as the multipart `file`: a dry run with the mode, into the plan', async () => {
    answer(() => json(OUT));
    const file = xml();
    expect(await P.importPlanFile('p 1', file, { dryRun: true, mode: 'fill' })).toEqual(OUT);
    const [path, init] = sent();
    expect(path).toBe('/plans/p%201/import?dry_run=1&mode=fill');
    expect(init.method).toBe('POST');
    // no Content-Type: the browser writes the multipart boundary
    expect(init.headers).toBeUndefined();
    const part = (init.body as FormData).get('file') as File;
    expect([part.name, part.size, part.type]).toEqual([file.name, file.size, file.type]);
  });

  it('an apply sends dry_run=0 and the version its preview saw as base_version', async () => {
    answer(() => json({ ...OUT, version: 5 }));
    await P.importPlanFile('p1', xml(), { dryRun: false, mode: 'append', baseVersion: 4 });
    expect(sent()[0]).toBe('/plans/p1/import?dry_run=0&mode=append&base_version=4');
  });

  it('a new plan goes to the initiative: always a fill, no mode or version to send', async () => {
    answer(() => json({ ...OUT, version: null }));
    await P.importIntoNewPlan('i 1', xml(), { dryRun: true });
    await P.importIntoNewPlan('i 1', xml(), { dryRun: false });
    expect(sent(0)[0]).toBe('/initiatives/i%201/plan/import?dry_run=1');
    expect(sent(1)[0]).toBe('/initiatives/i%201/plan/import?dry_run=0');
    expect((sent(1)[1].body as FormData).get('file')).toBeInstanceOf(File);
  });

  it('throws the API’s refusal (a file it can’t read is 422 bad_file with a message)', async () => {
    answer(() => json({ detail: { code: 'bad_file', message: 'Save it as comma-separated.' } }, 422));
    await expect(P.importPlanFile('p1', xml(), { dryRun: true, mode: 'append' }))
      .rejects.toMatchObject({ status: 422, code: 'bad_file' });
  });
});

describe('export', () => {
  it('exportUrl: MS Project XML takes no columns; Excel sends the visible column keys, comma-joined', () => {
    expect(P.exportUrl('p 1', 'xml')).toBe('/plans/p%201/export.xml');
    expect(P.exportUrl('p1', 'xlsx', ['indicators', 'id', 'name', 'duration']))
      .toBe('/plans/p1/export.xlsx?columns=indicators,id,name,duration');
    expect(P.exportUrl('p1', 'xlsx')).toBe('/plans/p1/export.xlsx');
  });

  it('downloads the file under the name its Content-Disposition gives', async () => {
    answer(() => new Response('PK', {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="NAP11 - Project plan.xlsx"; '
          + "filename*=UTF-8''NAP11%20-%20Project%20plan.xlsx",
      },
    }));
    expect(await P.exportPlan('p1', 'xlsx', ['id', 'name'], 'Fallback.xlsx')).toBe('NAP11 - Project plan.xlsx');
    expect(sent()[0]).toBe('/plans/p1/export.xlsx?columns=id,name');
    const [blob, name] = http.saveBlob.mock.calls[0] as [Blob, string];
    expect(name).toBe('NAP11 - Project plan.xlsx');
    expect(await blob.text()).toBe('PK');
  });

  it('falls back to the given name when the header can’t be read', async () => {
    answer(() => new Response('<Project/>', { status: 200 }));
    expect(await P.exportPlan('p1', 'xml', undefined, 'Hall move - Project plan.xml'))
      .toBe('Hall move - Project plan.xml');
    expect(http.saveBlob.mock.calls[0][1]).toBe('Hall move - Project plan.xml');
  });

  it('a refusal throws, and nothing is saved', async () => {
    answer(() => json({ detail: { code: 'bad_field', field: 'columns' } }, 422));
    await expect(P.exportPlan('p1', 'xlsx', ['nope'], 'x.xlsx')).rejects.toMatchObject({ code: 'bad_field' });
    expect(http.saveBlob).not.toHaveBeenCalled();
  });
});

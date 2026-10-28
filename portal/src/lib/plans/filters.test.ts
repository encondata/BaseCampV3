// @vitest-environment jsdom
/**
 * lib/plans/filters.ts: the filter bar's rows. A filter or a search keeps
 * the outline: the tasks that match, plus their summary tasks as dimmed,
 * inert context rows (the initiatives tree's rule). Group by puts the
 * leaves under a band per resource or status, a task with two resources
 * under both, "Unassigned" last. The view (filter, search, group) is kept
 * per plan in localStorage `plans.view.<planId>`.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { PlanTask } from './api';
import {
  DEFAULT_VIEW, PLAN_FILTERS, VIEW_PREFIX, bandKey, filterRows, groupRows, groupedRows, isBandRow, readView,
  rowKey, taskMatches, taskOfRow, writeView,
} from './filters';
import { makeTask } from './planFixtures';

const ME = 'p-me';
/** Wed Nov 4 2026, noon: the plan's now (its status date, or its clock). */
const NOW = '2026-11-04T12:00';

/**
 *  1 Prep (summary)
 *    2 Order crates      done Mon, 0%       Jimmy          notes: "48 crates from Acme"
 *    3 Label racks       done Thu, 50%      Jimmy + Dana
 *  4 Move day (summary)
 *    5 Load out (summary)
 *      6 Lift racks      done Fri, critical  Dana
 *    7 Go live           milestone Fri
 *  8 Wrap up             done Mon Nov 9, 100%
 */
function outline(): PlanTask[] {
  const jimmy = { kind: 'person' as const, id: ME, name: 'Jimmy Henderson' };
  const dana = { kind: 'person' as const, id: 'p-dana', name: 'Dana Ortiz' };
  return [
    makeTask('s1', { name: 'Prep', is_summary: true, finish: '2026-11-05T17:00' }),
    makeTask('a', { name: 'Order crates', parent_id: 's1', finish: '2026-11-02T17:00', notes: '48 Crates from Acme',
      assignees: [jimmy], status: 'late' }),
    makeTask('b', { name: 'Label racks', parent_id: 's1', finish: '2026-11-05T17:00', percent_complete: 50,
      assignees: [jimmy, dana], status: 'in_progress' }),
    makeTask('s2', { name: 'Move day', is_summary: true, finish: '2026-11-06T17:00' }),
    makeTask('s3', { name: 'Load out', is_summary: true, parent_id: 's2', finish: '2026-11-06T17:00' }),
    makeTask('c', { name: 'Lift racks', parent_id: 's3', finish: '2026-11-06T17:00', is_critical: true,
      assignees: [dana] }),
    makeTask('m', { name: 'Go live', parent_id: 's2', is_milestone: true, start: '2026-11-06T17:00',
      finish: '2026-11-06T17:00' }),
    makeTask('w', { name: 'Wrap up', finish: '2026-11-09T17:00', percent_complete: 100, status: 'complete' }),
  ];
}

const tasks = outline();
const byId = new Map(tasks.map((t) => [t.id, t]));
const order = tasks.map((t) => t.id);
const rowsOf = (filter: Parameters<typeof filterRows>[2], search = '', me = ME, now = NOW) =>
  filterRows(order, byId, filter, search, me, now);

afterEach(() => localStorage.clear());

describe('filterRows', () => {
  it('All Tasks with no search is the outline as it is, with no context rows', () => {
    expect(rowsOf('all')).toEqual({ rows: order, context: new Set() });
  });

  it('late keeps an incomplete task whose finish is before now, and its summary as context', () => {
    const { rows, context } = rowsOf('late');
    expect(rows).toEqual(['s1', 'a']);
    expect([...context]).toEqual(['s1']);
  });

  it('late also counts a deadline before now (as the Status column does), and never a finished task', () => {
    const due = new Map(byId);
    due.set('c', { ...byId.get('c')!, deadline: '2026-11-03T17:00' });
    due.set('w', { ...byId.get('w')!, finish: '2026-11-02T17:00' });
    expect(filterRows(order, due, 'late', '', ME, NOW).rows).toEqual(['s1', 'a', 's2', 's3', 'c']);
  });

  it('mine matches the signed-in person’s assignments, two-resource tasks too', () => {
    expect(rowsOf('mine').rows).toEqual(['s1', 'a', 'b']);
    expect(rowsOf('mine', '', 'p-dana').rows).toEqual(['s1', 'b', 's2', 's3', 'c']);
    // nobody signed in: nobody's tasks
    expect(rowsOf('mine', '', '').rows).toEqual([]);
  });

  it('search "crate" finds a task by its notes, case-insensitively', () => {
    const { rows, context } = rowsOf('all', 'crate');
    // "Order crates" by its name as well; nothing else says crate
    expect(rows).toEqual(['s1', 'a']);
    expect([...context]).toEqual(['s1']);
    expect(rowsOf('all', 'ACME').rows).toEqual(['s1', 'a']);
    expect(taskMatches(byId.get('a')!, 'all', 'from acme', ME, NOW)).toBe(true);
  });

  it('search finds a task by its resource names, and combines with the filter', () => {
    expect(rowsOf('all', 'dana').rows).toEqual(['s1', 'b', 's2', 's3', 'c']);
    expect(rowsOf('critical', 'dana').rows).toEqual(['s2', 's3', 'c']);
    expect(rowsOf('all', '  ').rows).toEqual(order);
  });

  it('a matching summary is a result, not context; its subtasks that don’t match stay out', () => {
    const { rows, context } = rowsOf('all', 'move day');
    expect(rows).toEqual(['s2']);
    expect(context.size).toBe(0);
    const summaries = rowsOf('summary');
    expect(summaries.rows).toEqual(['s1', 's2', 's3']);
    expect(summaries.context.size).toBe(0);
  });

  it('incomplete, critical, milestones and due this week', () => {
    expect(rowsOf('incomplete').rows).toEqual(['s1', 'a', 'b', 's2', 's3', 'c', 'm']);
    expect(rowsOf('critical').rows).toEqual(['s2', 's3', 'c']);
    expect(rowsOf('milestones')).toEqual({ rows: ['s2', 'm'], context: new Set(['s2']) });
    // Monday-first: Wed Nov 4 is in the week of Mon Nov 2 to Sun Nov 8; Wrap up (Mon Nov 9) is next week's
    expect(rowsOf('due_week').rows).toEqual(['s1', 'a', 'b', 's2', 's3', 'c', 'm']);
    expect(rowsOf('due_week', '', ME, '2026-11-09T08:00').rows).toEqual([]);
    // a Sunday is the end of its Monday's week
    expect(rowsOf('due_week', '', ME, '2026-11-08T20:00').rows).toEqual(['s1', 'a', 'b', 's2', 's3', 'c', 'm']);
  });

  it('the filters are the spec’s, in its order, with MS Project’s names', () => {
    expect(PLAN_FILTERS.map((f) => f.value)).toEqual([
      'all', 'incomplete', 'late', 'critical', 'milestones', 'due_week', 'mine', 'summary',
    ]);
    expect(PLAN_FILTERS[0].label).toBe('All Tasks');
  });
});

describe('groupRows', () => {
  it('by assignee lists a two-assignee task under both people, leaves only, "Unassigned" last', () => {
    const groups = groupRows(order, byId, 'assignee');
    expect(groups.map((g) => [g.label, g.rows])).toEqual([
      ['Dana Ortiz', ['b', 'c']],
      ['Jimmy Henderson', ['a', 'b']],
      ['Unassigned', ['m', 'w']],
    ]);
    expect(groups.map((g) => g.key)).toEqual(['person:p-dana', `person:${ME}`, 'unassigned']);
  });

  it('by status: Late, In progress, Not started, Complete, each in outline order, empty ones left out', () => {
    const groups = groupRows(order, byId, 'status');
    expect(groups.map((g) => [g.label, g.rows])).toEqual([
      ['Late', ['a']],
      ['In progress', ['b']],
      ['Not started', ['c', 'm']],
      ['Complete', ['w']],
    ]);
  });

  it('none keeps the rows as they are, in one group', () => {
    expect(groupRows(order, byId, 'none')).toEqual([{ key: '', label: '', rows: order }]);
  });

  it('groupedRows: a band per group, then its rows, each row key naming its group and task', () => {
    const { rows, bands } = groupedRows(groupRows(['a', 'b'], byId, 'assignee'));
    expect(rows).toEqual([
      bandKey('person:p-dana'), rowKey('person:p-dana', 'b'),
      bandKey(`person:${ME}`), rowKey(`person:${ME}`, 'a'), rowKey(`person:${ME}`, 'b'),
    ]);
    expect(bands.get(bandKey(`person:${ME}`))).toEqual({ label: 'Jimmy Henderson', count: 2 });
    expect(rows.map(taskOfRow)).toEqual([null, 'b', null, 'a', 'b']);
    expect(rows.map(isBandRow)).toEqual([true, false, true, false, false]);
    // a plain row is its task's id
    expect(taskOfRow('a')).toBe('a');
    expect(taskOfRow('blank')).toBe('blank');
    expect(isBandRow('a')).toBe(false);
  });
});

describe('the view, kept per plan', () => {
  it('reads what was written, and the default for anything else', () => {
    expect(readView('plan-1')).toEqual(DEFAULT_VIEW);
    writeView('plan-1', { filter: 'late', search: 'crate', group: 'assignee' });
    expect(JSON.parse(localStorage.getItem(`${VIEW_PREFIX}plan-1`)!)).toEqual(
      { filter: 'late', search: 'crate', group: 'assignee' });
    expect(readView('plan-1')).toEqual({ filter: 'late', search: 'crate', group: 'assignee' });
    expect(readView('plan-2')).toEqual(DEFAULT_VIEW);
    localStorage.setItem(`${VIEW_PREFIX}plan-3`, '{"filter":"nope","search":7,"group":"assignee"}');
    expect(readView('plan-3')).toEqual({ ...DEFAULT_VIEW, group: 'assignee' });
    localStorage.setItem(`${VIEW_PREFIX}plan-4`, 'not json');
    expect(readView('plan-4')).toEqual(DEFAULT_VIEW);
  });

  it('storage that throws reads as the default and writes nothing', () => {
    const real = Storage.prototype.getItem;
    const realSet = Storage.prototype.setItem;
    Storage.prototype.getItem = () => { throw new Error('denied'); };
    Storage.prototype.setItem = () => { throw new Error('denied'); };
    try {
      expect(readView('plan-1')).toEqual(DEFAULT_VIEW);
      expect(() => writeView('plan-1', { ...DEFAULT_VIEW, filter: 'late' })).not.toThrow();
    } finally {
      Storage.prototype.getItem = real;
      Storage.prototype.setItem = realSet;
    }
  });
});

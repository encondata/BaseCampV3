/**
 * lib/plans/editOps.ts: what one cell edit in the task sheet sends. Each
 * column's text is checked locally first (a bad duration or predecessor
 * never reaches the API), an unchanged value sends nothing, the blank
 * new-task row adds a task, and which cells open an editor at all
 * (read-only, locked and summary rules).
 */
import { describe, expect, it } from 'vitest';

import { PROGRESS_FIELDS, type Op, type PlanTask } from './api';
import { COLUMN_BY_KEY, PLAN_COLUMNS } from './columns';
import { STANDARD_UNITS } from './durations';
import {
  LOCKED_COLUMNS, MULTILINE_NOTE_TITLE, canAddTasks, canEditCell, editLabel, editText, multiLineNote, noticeText,
  opsForCell, resourceKey, type EditContext,
} from './editOps';
import { makePlan, makeTask } from './planFixtures';

const col = (key: string) => COLUMN_BY_KEY.get(key)!;

function ctx(over: Partial<EditContext> = {}): EditContext {
  let n = 0;
  return {
    units: STANDARD_UNITS,
    validIds: new Set([1, 2, 3, 4]),
    displayIdOf: (id) => ({ a: 1, b: 2, c: 3, d: 4 } as Record<string, number>)[id] ?? null,
    tempId: () => { n += 1; return `new-${n}`; },
    appendParentId: null,
    ...over,
  };
}

const task = (over: Partial<PlanTask> = {}) => makeTask('b', { display_id: 2, ...over });
const ops = (edit: ReturnType<typeof opsForCell>): Op[] => {
  if ('error' in edit) throw new Error(`expected ops, got the error ${edit.error}`);
  return edit.ops;
};

describe('opsForCell: local checks', () => {
  it('a duration that does not parse is an error, sent nowhere', () => {
    const edit = opsForCell(task(), col('duration'), 'abc', ctx());
    expect(edit).toEqual({ error: expect.any(String) });
    expect((edit as { error: string }).error).not.toBe('');
  });

  it('a duration past ten years is an error', () => {
    expect(opsForCell(task(), col('duration'), '3000d', ctx())).toEqual({ error: expect.any(String) });
  });

  it('predecessors naming a task the plan does not have, or the task itself, are errors', () => {
    expect(opsForCell(task(), col('predecessors'), '9', ctx())).toEqual({ error: 'Task 9 does not exist in this plan.' });
    expect(opsForCell(task(), col('predecessors'), '2', ctx())).toEqual({ error: 'Task 2 cannot depend on itself.' });
  });

  it('a % Complete outside 0-100 or not a number is an error', () => {
    for (const text of ['101', '-5', 'half', '']) {
      expect(opsForCell(task(), col('percent'), text, ctx())).toEqual({ error: 'Enter a % Complete from 0 to 100.' });
    }
  });

  it('Start and Finish cannot be emptied', () => {
    expect(opsForCell(task(), col('start'), '', ctx())).toEqual({ error: 'Enter a Start date.' });
    expect(opsForCell(task(), col('finish'), '', ctx())).toEqual({ error: 'Enter a Finish date.' });
  });

  it('date text that is not a whole date is an error, never a clear', () => {
    const due = task({ deadline: '2026-11-09T17:00' });
    expect(opsForCell(due, col('deadline'), '2026-11', ctx())).toEqual({ error: 'Enter a full date.' });
    expect(opsForCell(due, col('deadline'), '2026-02-30', ctx())).toEqual({ error: 'Enter a full date.' });
    expect(opsForCell(null, col('start'), '11/5', ctx())).toEqual({ error: 'Enter a full date.' });
  });

  it('a select value the column does not offer is an error', () => {
    expect(opsForCell(task(), col('mode'), 'sometimes', ctx())).toEqual({ error: expect.any(String) });
  });
});

describe('opsForCell: the ops an edit sends', () => {
  it('Task Name updates the name, trimmed', () => {
    expect(ops(opsForCell(task(), col('name'), '  Pack crates ', ctx())))
      .toEqual([{ op: 'update_task', id: 'b', fields: { name: 'Pack crates' } }]);
  });

  it('Duration sends the duration text', () => {
    expect(ops(opsForCell(task(), col('duration'), ' 5d ', ctx())))
      .toEqual([{ op: 'update_task', id: 'b', fields: { duration: '5d' } }]);
  });

  it('Predecessors sends the text as typed', () => {
    expect(ops(opsForCell(task(), col('predecessors'), '3FS+2d', ctx())))
      .toEqual([{ op: 'update_task', id: 'b', fields: { predecessors: '3FS+2d' } }]);
  });

  it('emptying Predecessors removes every link into the task', () => {
    expect(ops(opsForCell(task({ predecessors: '1' }), col('predecessors'), '', ctx())))
      .toEqual([{ op: 'update_task', id: 'b', fields: { predecessors: '' } }]);
  });

  it('% Complete is a set_percent', () => {
    expect(ops(opsForCell(task(), col('percent'), '100', ctx())))
      .toEqual([{ op: 'set_percent', ids: ['b'], percent: 100 }]);
    expect(ops(opsForCell(task(), col('percent'), ' 45% ', ctx())))
      .toEqual([{ op: 'set_percent', ids: ['b'], percent: 45 }]);
  });

  it('a date alone stays a date alone (the calendar’s default time applies); a time is kept', () => {
    expect(ops(opsForCell(task(), col('start'), '2026-11-05', ctx())))
      .toEqual([{ op: 'update_task', id: 'b', fields: { start: '2026-11-05' } }]);
    expect(ops(opsForCell(task(), col('deadline'), '2026-11-09T13:30', ctx())))
      .toEqual([{ op: 'update_task', id: 'b', fields: { deadline: '2026-11-09T13:30' } }]);
  });

  it('emptying a date that can be cleared sends null', () => {
    expect(ops(opsForCell(task({ deadline: '2026-11-09T17:00' }), col('deadline'), '', ctx())))
      .toEqual([{ op: 'update_task', id: 'b', fields: { deadline: null } }]);
    expect(ops(opsForCell(task({ actual_start: '2026-11-02T08:00' }), col('actual_start'), '', ctx())))
      .toEqual([{ op: 'update_task', id: 'b', fields: { actual_start: null } }]);
  });

  it('Mode and Constraint Type send the option picked', () => {
    expect(ops(opsForCell(task(), col('mode'), 'manual', ctx())))
      .toEqual([{ op: 'update_task', id: 'b', fields: { mode: 'manual' } }]);
    expect(ops(opsForCell(task(), col('constraint_type'), 'mso', ctx())))
      .toEqual([{ op: 'update_task', id: 'b', fields: { constraint_type: 'mso' } }]);
  });

  it('Resource Names replaces the assignees', () => {
    const text = [resourceKey({ kind: 'person', id: 'p1' }), resourceKey({ kind: 'partner', id: 'x1' })].join(',');
    expect(ops(opsForCell(task(), col('resources'), text, ctx()))).toEqual([{
      op: 'set_assignees', task_id: 'b',
      resources: [{ kind: 'person', id: 'p1' }, { kind: 'partner', id: 'x1' }],
    }]);
    const assigned = task({ assignees: [{ kind: 'person', id: 'p1', name: 'Dana' }] });
    expect(ops(opsForCell(assigned, col('resources'), '', ctx())))
      .toEqual([{ op: 'set_assignees', task_id: 'b', resources: [] }]);
  });

  it('Notes sends the text, and null once emptied', () => {
    expect(ops(opsForCell(task(), col('notes'), 'call first', ctx())))
      .toEqual([{ op: 'update_task', id: 'b', fields: { notes: 'call first' } }]);
    expect(ops(opsForCell(task({ notes: 'call first' }), col('notes'), '  ', ctx())))
      .toEqual([{ op: 'update_task', id: 'b', fields: { notes: null } }]);
  });
});

describe('opsForCell: an unchanged value sends nothing', () => {
  it.each([
    ['name', { name: 'Pack' }, 'Pack'],
    ['duration', { duration_minutes: 480, duration_unit: 'd', duration_text: '1 day' }, '1d'],
    ['predecessors', { predecessors: '1' }, ' 1 '],
    ['percent', { percent_complete: 45 }, '45'],
    ['start', { start: '2026-11-02T08:00' }, '2026-11-02'],
    ['start', { start: '2026-11-02T08:00' }, '2026-11-02T08:00'],
    ['deadline', { deadline: null }, ''],
    ['mode', { mode: 'auto' }, 'auto'],
    ['notes', { notes: 'line one\nline two' }, 'line one line two'],
    ['resources', { assignees: [{ kind: 'person', id: 'p1', name: 'Dana' }] }, 'person:p1'],
  ] as const)('%s', (key, over, text) => {
    expect(opsForCell(task(over as Partial<PlanTask>), col(key), text, ctx())).toEqual({ ops: [] });
  });
});

describe('opsForCell: the blank new-task row', () => {
  it('a name adds a task at the end, under no parent', () => {
    expect(ops(opsForCell(null, col('name'), 'Survey site', ctx())))
      .toEqual([{ op: 'add_task', temp_id: 'new-1', parent_id: null, name: 'Survey site' }]);
  });

  it('the new task goes under the parent the sheet appends to', () => {
    expect(ops(opsForCell(null, col('name'), 'Label racks', ctx({ appendParentId: 's1' }))))
      .toEqual([{ op: 'add_task', temp_id: 'new-1', parent_id: 's1', name: 'Label racks' }]);
  });

  it('a duration or a date adds a task with it', () => {
    expect(ops(opsForCell(null, col('duration'), '3d', ctx())))
      .toEqual([{ op: 'add_task', temp_id: 'new-1', parent_id: null, duration: '3d' }]);
    expect(ops(opsForCell(null, col('start'), '2026-11-05', ctx())))
      .toEqual([{ op: 'add_task', temp_id: 'new-1', parent_id: null, start: '2026-11-05' }]);
  });

  it('nothing typed adds nothing', () => {
    expect(opsForCell(null, col('name'), '   ', ctx())).toEqual({ ops: [] });
    expect(opsForCell(null, col('start'), '', ctx())).toEqual({ ops: [] });
  });

  it('a bad duration is still an error', () => {
    expect(opsForCell(null, col('duration'), 'soon', ctx())).toEqual({ error: expect.any(String) });
  });
});

describe('editText (what F2 starts from)', () => {
  it('is the value as it can be typed back', () => {
    const t = task({
      name: 'Pack', duration_text: '2 days', predecessors: '1SS', percent_complete: 45,
      start: '2026-11-02T08:00', notes: 'one\ntwo', mode: 'manual',
      assignees: [{ kind: 'person', id: 'p1', name: 'Dana' }, { kind: 'partner', id: 'x', name: 'Acme' }],
    });
    expect(editText(t, col('name'), false)).toBe('Pack');
    expect(editText(t, col('duration'), false)).toBe('2 days');
    expect(editText(t, col('predecessors'), false)).toBe('1SS');
    expect(editText(t, col('percent'), false)).toBe('45');
    expect(editText(t, col('start'), false)).toBe('2026-11-02');
    expect(editText(t, col('start'), true)).toBe('2026-11-02T08:00');
    expect(editText(t, col('deadline'), false)).toBe('');
    expect(editText(t, col('notes'), false)).toBe('one two');
    expect(editText(t, col('mode'), false)).toBe('manual');
    expect(editText(t, col('resources'), false)).toBe('person:p1,partner:x');
    expect(editText(null, col('name'), false)).toBe('');
  });
});

describe('which cells open an editor', () => {
  const plan = makePlan();
  const locked = makePlan({ locked_at: '2026-10-28T15:30:00Z' });
  const readOnly = makePlan({ permissions: { view: true, add: false, change: false, delete: false } });

  it('locked: only the columns whose ops are progress edits (PROGRESS_FIELDS)', () => {
    expect([...LOCKED_COLUMNS].sort()).toEqual(['actual_finish', 'actual_start', 'notes', 'percent']);
    for (const key of LOCKED_COLUMNS) {
      expect(PROGRESS_FIELDS.has(key === 'percent' ? 'percent_complete' : key)).toBe(true);
    }
    expect(canEditCell(locked, task(), col('duration'))).toBe(false);
    expect(canEditCell(locked, task(), col('name'))).toBe(false);
    expect(canEditCell(locked, task(), col('percent'))).toBe(true);
    expect(canEditCell(locked, task(), col('notes'))).toBe(true);
  });

  it('read-only: none', () => {
    for (const c of PLAN_COLUMNS) expect(canEditCell(readOnly, task(), c)).toBe(false);
  });

  it('columns without an editor never open one', () => {
    for (const key of ['indicators', 'id', 'wbs', 'successors', 'slack', 'status', 'baseline_start', 'created']) {
      expect(canEditCell(plan, task(), col(key))).toBe(false);
    }
  });

  it('a summary’s duration and dates are its subtasks’: those cells do not open', () => {
    const summary = task({ is_summary: true });
    for (const key of ['duration', 'start', 'finish', 'actual_start', 'actual_finish']) {
      expect(canEditCell(plan, summary, col(key))).toBe(false);
    }
    for (const key of ['name', 'percent', 'predecessors', 'resources', 'notes', 'deadline']) {
      expect(canEditCell(plan, summary, col(key))).toBe(true);
    }
  });

  it('locked: a summary’s actuals still come from its subtasks; its % and notes open', () => {
    const summary = task({ is_summary: true });
    expect(canEditCell(locked, summary, col('actual_start'))).toBe(false);
    expect(canEditCell(locked, summary, col('actual_finish'))).toBe(false);
    expect(canEditCell(locked, summary, col('percent'))).toBe(true);
    expect(canEditCell(locked, summary, col('notes'))).toBe(true);
  });

  it('a note with a line break is edited in Task Information, not the cell', () => {
    expect(multiLineNote(task({ notes: 'call first\nthen pack' }))).toBe(true);
    expect(multiLineNote(task({ notes: 'one\r\ntwo' }))).toBe(true);
    expect(multiLineNote(task({ notes: 'call first' }))).toBe(false);
    expect(multiLineNote(task({ notes: null }))).toBe(false);
    expect(canEditCell(plan, task({ notes: 'call first\nthen pack' }), col('notes'))).toBe(false);
    expect(canEditCell(locked, task({ notes: 'call first\nthen pack' }), col('notes'))).toBe(false);
    expect(canEditCell(plan, task({ notes: 'call first' }), col('notes'))).toBe(true);
    expect(MULTILINE_NOTE_TITLE).toBe('Multi-line note — edit in Task Information');
  });

  it('the blank row: only fields a new task takes, and only while tasks can be added', () => {
    for (const key of ['name', 'duration', 'start', 'finish', 'mode', 'deadline', 'notes']) {
      expect(canEditCell(plan, null, col(key))).toBe(true);
    }
    for (const key of ['predecessors', 'resources', 'percent', 'constraint_type', 'actual_start']) {
      expect(canEditCell(plan, null, col(key))).toBe(false);
    }
    expect(canEditCell(locked, null, col('name'))).toBe(false);
    expect(canEditCell(makePlan({ permissions: { view: true, add: false, change: true, delete: true } }), null,
      col('name'))).toBe(false);
  });

  it('canAddTasks: add and change (the ops route needs change), never while locked', () => {
    expect(canAddTasks(plan)).toBe(true);
    expect(canAddTasks(locked)).toBe(false);
    expect(canAddTasks(makePlan({ permissions: { view: true, add: false, change: true, delete: true } }))).toBe(false);
    expect(canAddTasks(makePlan({ permissions: { view: true, add: true, change: false, delete: true } }))).toBe(false);
  });
});

describe('labels and notices', () => {
  it('an edit’s undo label names the column, a new row says so', () => {
    expect(editLabel(task(), col('duration'))).toBe('Edit Duration');
    expect(editLabel(null, col('name'))).toBe('New Task');
  });

  it('a notice reads with the constraint type it names', () => {
    expect(noticeText({ code: 'constraint_added', task_id: 'b', constraint_type: 'snet' }))
      .toBe('Start No Earlier Than constraint added');
    expect(noticeText({ code: 'constraint_added', task_id: 'b', constraint_type: 'fnet' }))
      .toBe('Finish No Earlier Than constraint added');
    expect(noticeText({ code: 'constraint_cleared', task_id: 'b' }))
      .toBe('Constraint set back to As Soon As Possible');
  });
});

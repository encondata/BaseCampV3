/**
 * lib/plans/paste.ts: clipboard text as Excel writes it, a copy of sheet
 * rows as TSV (and the tasks it re-creates when pasted back), and a
 * pasted grid as the ops it sends — cells filled from the active cell,
 * new tasks past the last row, and the second batch (Ruling B3) for
 * what has to name the new tasks.
 */
import { describe, expect, it } from 'vitest';

import type { AddTaskOp, Op, PlanTask } from './api';
import { COLUMN_BY_KEY, DEFAULT_VISIBLE, type PlanColumn } from './columns';
import { PLAN_ERRORS } from './errors';
import {
  copyRows, opsForInternalPaste, opsForPaste, parseClipboard, pasteDate, sameClipboard, toTsv, type PasteContext,
} from './paste';
import { flatTasks, makeLink, makePlan, makeTask } from './planFixtures';
import { selectCell } from './selection';

const COLUMNS: PlanColumn[] = DEFAULT_VISIBLE.map((k) => COLUMN_BY_KEY.get(k)!);

function ctx(over: Partial<PasteContext['plan']> = {}): PasteContext {
  let n = 0;
  return {
    plan: makePlan({
      tasks: flatTasks(['a', 'b', 'c']).map((t, i) => ({ ...t, name: ['Survey', 'Pack', 'Go live'][i] })),
      resources: [
        { kind: 'person', id: 'p1', name: 'Dana Reyes', group: 'team', has_email: true, has_account: true },
        { kind: 'partner', id: 'x1', name: 'Acme Freight', group: 'partner', has_email: true, has_account: false },
      ],
      ...over,
    }),
    tempId: () => `t${(n += 1)}`,
    appendParentId: null,
  };
}
const ROWS = ['a', 'b', 'c'];

describe('parseClipboard', () => {
  it('reads Excel TSV: CRLF rows, a quoted cell with a line break and doubled quotes, no trailing row', () => {
    const text = 'Survey\t2d\r\n"Pack the\n""big"" crates"\t3d\r\nGo live\t0\r\n';
    expect(parseClipboard(text)).toEqual([
      ['Survey', '2d'],
      ['Pack the\n"big" crates', '3d'],
      ['Go live', '0'],
    ]);
  });

  it('keeps empty cells, reads LF and CR rows, and a quote inside an unquoted cell as text', () => {
    expect(parseClipboard('a\t\tb\nc\rd')).toEqual([['a', '', 'b'], ['c'], ['d']]);
    expect(parseClipboard('12" pipe\t"x"')).toEqual([['12" pipe', 'x']]);
    expect(parseClipboard('"tab\there"\tz')).toEqual([['tab\there', 'z']]);
    expect(parseClipboard('')).toEqual([]);
    expect(parseClipboard('one')).toEqual([['one']]);
  });

  it('round-trips what toTsv writes', () => {
    const grid = [['plain', 'tab\tin', 'line\nbreak'], ['"quoted"', '', 'end']];
    const tsv = toTsv(grid);
    expect(tsv).toBe('plain\t"tab\tin"\t"line\nbreak"\r\n"""quoted"""\t\tend\r\n');
    expect(parseClipboard(tsv)).toEqual(grid);
  });
});

describe('pasteDate', () => {
  it('reads the sheet’s own dates, US dates and ISO dates, with or without a time', () => {
    expect(pasteDate('Mon 11/2/26')).toBe('2026-11-02');
    expect(pasteDate('11/2/2026')).toBe('2026-11-02');
    expect(pasteDate('Mon 11/2/26 1:30 PM')).toBe('2026-11-02T13:30');
    expect(pasteDate('12/1/26 12:00 AM')).toBe('2026-12-01T00:00');
    expect(pasteDate('2026-11-02')).toBe('2026-11-02');
    expect(pasteDate('2026-11-02 08:00:00')).toBe('2026-11-02T08:00');
    expect(pasteDate('2/30/26')).toBeNull();
    expect(pasteDate('soon')).toBeNull();
  });
});

describe('opsForPaste', () => {
  it('a 3×2 paste at Task Name on the last row fills that row and adds two tasks', () => {
    const grid = parseClipboard('Load trucks\t2d\r\nDrive\t1d\r\nUnload\t4h\r\n');
    const result = opsForPaste(grid, { id: 'c', col: 'name' }, COLUMNS, ROWS, ctx());
    if (!('ops' in result)) throw new Error(result.error);
    expect(result.ops.filter((op) => op.op === 'update_task')).toHaveLength(2);
    expect(result.ops.filter((op) => op.op === 'add_task')).toHaveLength(2);
    expect(result.ops).toEqual([
      { op: 'update_task', id: 'c', fields: { name: 'Load trucks' } },
      { op: 'update_task', id: 'c', fields: { duration: '2d' } },
      { op: 'add_task', temp_id: 't1', parent_id: null, name: 'Drive', duration: '1d' },
      { op: 'add_task', temp_id: 't2', parent_id: null, name: 'Unload', duration: '4h' },
    ]);
    expect(result.then).toBeUndefined();
  });

  it('new rows’ Predecessors and Resource Names go in a second batch, keyed by the ids the first one answers', () => {
    // from Task Name: Duration, Start, Finish, Predecessors, Resource Names
    const grid = [
      ['Crate', '2d', '', '', '3', 'Dana Reyes'],
      ['Load', '1d', 'Mon 11/9/26', '', '4', 'dana reyes, Acme Freight'],
      ['', '', '', '', '5', ''],
    ];
    const result = opsForPaste(grid, { id: 'blank', col: 'name' }, COLUMNS, ROWS, ctx());
    if (!('ops' in result)) throw new Error(result.error);
    expect(result.ops).toEqual([
      { op: 'add_task', temp_id: 't1', parent_id: null, name: 'Crate', duration: '2d' },
      { op: 'add_task', temp_id: 't2', parent_id: null, name: 'Load', duration: '1d', start: '2026-11-09' },
      { op: 'add_task', temp_id: 't3', parent_id: null },
    ]);
    expect(result.then?.({ t1: 'n1', t2: 'n2', t3: 'n3' })).toEqual([
      { op: 'update_task', id: 'n1', fields: { predecessors: '3' } },
      { op: 'set_assignees', task_id: 'n1', resources: [{ kind: 'person', id: 'p1' }] },
      { op: 'update_task', id: 'n2', fields: { predecessors: '4' } },
      { op: 'set_assignees', task_id: 'n2', resources: [{ kind: 'person', id: 'p1' }, { kind: 'partner', id: 'x1' }] },
      { op: 'update_task', id: 'n3', fields: { predecessors: '5' } },
    ]);
  });

  it('an existing row’s Predecessors waits for the new rows too (it may name them)', () => {
    // from Predecessors on Go live (3): its own row names the new row (4)
    const grid = [['4'], ['1']];
    const result = opsForPaste(grid, { id: 'c', col: 'predecessors' }, COLUMNS, ROWS, ctx());
    if (!('ops' in result)) throw new Error(result.error);
    expect(result.ops).toEqual([{ op: 'add_task', temp_id: 't1', parent_id: null }]);
    expect(result.then?.({ t1: 'n1' })).toEqual([
      { op: 'update_task', id: 'c', fields: { predecessors: '4' } },
      { op: 'update_task', id: 'n1', fields: { predecessors: '1' } },
    ]);
    // a 5 is no task, not even after the paste
    expect(opsForPaste([['5'], ['1']], { id: 'c', col: 'predecessors' }, COLUMNS, ROWS, ctx()))
      .toEqual({ error: 'Row 1, Predecessors: Task 5 does not exist in this plan.' });
  });

  it('read-only columns and empty cells are skipped; a summary’s derived dates too', () => {
    const tasks: PlanTask[] = [
      makeTask('s', { display_id: 1, is_summary: true, name: 'Prep' }),
      makeTask('k', { display_id: 2, parent_id: 's', outline_level: 2, name: 'Crates' }),
    ];
    // from ID: ID, Mode, Task Name, Duration
    const grid = [['9', '', 'Prep work', '5d'], ['8', 'Manually Scheduled', '', '3d']];
    const result = opsForPaste(grid, { id: 's', col: 'id' }, COLUMNS, ['s', 'k'], ctx({ tasks }));
    expect(result).toEqual({
      ops: [
        { op: 'update_task', id: 's', fields: { name: 'Prep work' } },
        { op: 'update_task', id: 'k', fields: { mode: 'manual' } },
        { op: 'update_task', id: 'k', fields: { duration: '3d' } },
      ],
    });
  });

  it('a value that doesn’t read is refused with its row and column, and nothing is sent', () => {
    expect(opsForPaste([['Crate', 'abc']], { id: 'a', col: 'name' }, COLUMNS, ROWS, ctx())).toEqual({
      error: 'Row 1, Duration: "abc" isn’t a duration. Try 5d, 4h or 3ed.',
    });
    expect(opsForPaste([['x', '', 'someday']], { id: 'a', col: 'name' }, COLUMNS, ROWS, ctx())).toEqual({
      error: 'Row 1, Start: Enter a date like 11/2/26.',
    });
    expect(opsForPaste([['Bob Smith']], { id: 'b', col: 'resources' }, COLUMNS, ROWS, ctx())).toEqual({
      error: 'Row 1, Resource Names: “Bob Smith” isn’t one of this plan’s resources.',
    });
  });

  it('a locked plan takes progress columns only, and adds no rows', () => {
    const locked = ctx({ locked_at: '2026-10-27T12:00:00Z' });
    expect(opsForPaste([['50%']], { id: 'a', col: 'percent' }, COLUMNS, ROWS, locked)).toEqual({
      ops: [{ op: 'set_percent', ids: ['a'], percent: 50 }],
    });
    expect(opsForPaste([['2d']], { id: 'a', col: 'duration' }, COLUMNS, ROWS, locked)).toEqual({
      error: `Row 1, Duration: ${PLAN_ERRORS.plan_locked}`,
    });
    expect(opsForPaste([['x'], ['y'], ['z'], ['w']], { id: 'a', col: 'name' }, COLUMNS, ROWS, locked))
      .toEqual({ error: PLAN_ERRORS.plan_locked });
  });

  it('a paste past the 5,000-op cap is refused, nothing sent', () => {
    // three rows renamed (their 1d is what they hold), 4,998 added: 5,001 in the first batch
    const grid = Array.from({ length: 5001 }, (_, i) => [`T${i}`, '1d']);
    expect(opsForPaste(grid, { id: 'a', col: 'name' }, COLUMNS, ROWS, ctx())).toEqual({
      error: 'That paste is too big to make in one change (5,001 edits; the most is 5,000). Paste fewer rows at a time.',
    });
    // the second batch counts too: 2,600 new rows with Predecessors and Resource Names
    const linked = Array.from({ length: 2600 }, () => ['T', '', '', '', '1', 'Dana Reyes']);
    expect(opsForPaste(linked, { id: 'blank', col: 'name' }, COLUMNS, ROWS, ctx())).toEqual({
      error: 'That paste is too big to make in one change (5,200 edits; the most is 5,000). Paste fewer rows at a time.',
    });
    // right at the cap goes
    const fits = Array.from({ length: 5000 }, (_, i) => [`T${i}`]);
    expect('ops' in opsForPaste(fits, { id: 'blank', col: 'name' }, COLUMNS, ROWS, ctx())).toBe(true);
  });
});

describe('copy and paste within the plan', () => {
  /** A, then S over S1 and S2, S1 → S2, S2 assigned. */
  function plan() {
    const tasks: PlanTask[] = [
      makeTask('A', { display_id: 1, name: 'Survey' }),
      makeTask('S', { display_id: 2, is_summary: true, name: 'Pack', duration_minutes: 960 }),
      makeTask('S1', { display_id: 3, parent_id: 'S', outline_level: 2, name: 'Crates', duration_minutes: 960,
        duration_text: '2 days' }),
      makeTask('S2', { display_id: 4, parent_id: 'S', outline_level: 2, name: 'Label', mode: 'manual',
        start: '2026-11-04T08:00', finish: '2026-11-04T12:00', duration_minutes: 240, duration_unit: 'h',
        assignees: [{ kind: 'person', id: 'p1', name: 'Dana Reyes' }], notes: 'Two\nlines' }),
    ];
    return ctx({ tasks, links: [makeLink('l1', 'S1', 'S2', { link_type: 'SS', lag_minutes: 120, lag_unit: 'h' })] });
  }

  it('copies the selected rows with their subtasks as TSV of the visible columns', () => {
    const c = plan();
    const shown = ['id', 'name', 'duration', 'notes'].map((k) => COLUMN_BY_KEY.get(k)!);
    const { text } = copyRows(new Set(['S']), shown, c.plan);
    // a note keeps its line breaks (quoted, as Excel writes them)
    expect(parseClipboard(text)).toEqual([
      ['2', 'Pack', '1 day', ''],
      ['3', 'Crates', '2 days', ''],
      ['4', 'Label', '1 day', 'Two\nlines'],
    ]);
    expect(sameClipboard(text.replace(/\r\n/g, '\n'), text)).toBe(true);
  });

  it('pasting the copy re-creates the tasks, their outline, links and resources (two batches)', () => {
    const c = plan();
    const { copy } = copyRows(new Set(['S']), COLUMNS, c.plan);
    const result = opsForInternalPaste(copy, selectCell('A', 'name'), c);
    if (!('ops' in result)) throw new Error(result.error);
    const adds = result.ops as AddTaskOp[];
    expect(adds).toEqual([
      { op: 'add_task', temp_id: 't1', before_id: 'A', name: 'Pack' },
      { op: 'add_task', temp_id: 't2', before_id: 'A', name: 'Crates', duration: '2d' },
      { op: 'add_task', temp_id: 't3', before_id: 'A', name: 'Label', mode: 'manual',
        start: '2026-11-04T08:00', finish: '2026-11-04T12:00', notes: 'Two\nlines' },
    ]);
    const second: Op[] = result.then!({ t1: 'n1', t2: 'n2', t3: 'n3' });
    expect(second).toEqual([
      { op: 'indent', ids: ['n2', 'n3'] },
      { op: 'add_link', predecessor_id: 'n2', successor_id: 'n3', link_type: 'SS', lag: '2h' },
      { op: 'set_assignees', task_id: 'n3', resources: [{ kind: 'person', id: 'p1' }] },
    ]);
  });
});

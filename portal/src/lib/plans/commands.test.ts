/**
 * lib/plans/commands.ts: the toolbar's and the keyboard map's task commands
 * as the ops they send (or the refusal the sheet can tell without asking
 * the API).
 */
import { describe, expect, it } from 'vitest';

import type { PlanTask } from './api';
import {
  SELECT_FIRST, deleteSelected, indentSelected, insertTask, linkSelected, markOnTrack, outdentSelected, selectedTasks,
  setColor, sharedColor, setMode, setPercent, toggleTimeline, unlinkSelected, type CommandContext,
} from './commands';
import { PLAN_ERRORS } from './errors';
import { flatTasks, makeLink, makeTask } from './planFixtures';
import { EMPTY_SELECTION, selectCell, toggleRow, type Selection } from './selection';

/** A, B, C at the top; S a summary over S1 and S2. */
function tasks(): PlanTask[] {
  const [a, b, c] = flatTasks(['A', 'B', 'C']);
  return [
    a, b, c,
    makeTask('S', { display_id: 4, wbs: '4', position: 3, is_summary: true, name: 'S' }),
    makeTask('S1', { display_id: 5, wbs: '4.1', outline_level: 2, parent_id: 'S', position: 0 }),
    makeTask('S2', { display_id: 6, wbs: '4.2', outline_level: 2, parent_id: 'S', position: 1, mode: 'manual' }),
  ];
}

function ctx(over: Partial<CommandContext['plan']> = {}): CommandContext {
  let n = 0;
  return {
    plan: { tasks: tasks(), links: [], ...over },
    tempId: () => `t${(n += 1)}`,
    appendParentId: null,
  };
}

/** Rows picked one by one, in that order (Ctrl-click). */
function pick(...ids: string[]): Selection {
  return ids.reduce((sel, id) => toggleRow(sel, id, 'name'), EMPTY_SELECTION);
}

describe('selectedTasks', () => {
  it('reads the rows in the order they were picked, and the active row without any', () => {
    expect(selectedTasks(pick('C', 'A'), ctx().plan).map((t) => t.id)).toEqual(['C', 'A']);
    const active: Selection = { active: { id: 'B', col: 'name' }, rows: new Set(), anchor: null };
    expect(selectedTasks(active, ctx().plan).map((t) => t.id)).toEqual(['B']);
    expect(selectedTasks(selectCell('blank', 'name'), ctx().plan)).toEqual([]);
  });
});

describe('linkSelected', () => {
  it('links the tasks Finish-to-Start in selection order', () => {
    expect(linkSelected(pick('A', 'B', 'C'), ctx())).toEqual({
      ops: [
        { op: 'add_link', predecessor_id: 'A', successor_id: 'B', link_type: 'FS' },
        { op: 'add_link', predecessor_id: 'B', successor_id: 'C', link_type: 'FS' },
      ],
    });
    // picked C first: C comes first
    expect(linkSelected(pick('C', 'A'), ctx())).toEqual({
      ops: [{ op: 'add_link', predecessor_id: 'C', successor_id: 'A', link_type: 'FS' }],
    });
  });

  it('skips a pair that is already linked, and needs two tasks', () => {
    const c = ctx({ links: [makeLink('l1', 'A', 'B')] });
    expect(linkSelected(pick('A', 'B', 'C'), c)).toEqual({
      ops: [{ op: 'add_link', predecessor_id: 'B', successor_id: 'C', link_type: 'FS' }],
    });
    expect(linkSelected(pick('A', 'B'), c)).toEqual({ ops: [] });
    expect(linkSelected(pick('A'), c)).toEqual({ error: 'Select two or more tasks to link.' });
  });
});

describe('unlinkSelected', () => {
  const links = [makeLink('ab', 'A', 'B'), makeLink('bc', 'B', 'C'), makeLink('cs1', 'C', 'S1')];

  it('removes every link among the selected tasks', () => {
    expect(unlinkSelected(pick('A', 'B', 'C'), ctx({ links }))).toEqual({
      ops: [{ op: 'delete_link', id: 'ab' }, { op: 'delete_link', id: 'bc' }],
    });
  });

  it('one task: every link into and out of it (MS Project)', () => {
    expect(unlinkSelected(pick('C'), ctx({ links }))).toEqual({
      ops: [{ op: 'delete_link', id: 'bc' }, { op: 'delete_link', id: 'cs1' }],
    });
  });
});

describe('indent and outdent', () => {
  it('indent on the first row is refused before anything is sent', () => {
    expect(indentSelected(pick('A'), ctx())).toEqual({ error: PLAN_ERRORS.cannot_indent });
    expect(indentSelected(pick('S1'), ctx())).toEqual({ error: PLAN_ERRORS.cannot_indent });
  });

  it('indents the selected tasks in outline order, leaving out what goes with a parent', () => {
    expect(indentSelected(pick('C', 'B'), ctx())).toEqual({ ops: [{ op: 'indent', ids: ['B', 'C'] }] });
    expect(indentSelected(pick('S', 'S2'), ctx())).toEqual({ ops: [{ op: 'indent', ids: ['S'] }] });
  });

  it('outdent at the top level is refused; a subtask outdents', () => {
    expect(outdentSelected(pick('A'), ctx())).toEqual({ error: PLAN_ERRORS.cannot_outdent });
    expect(outdentSelected(pick('S2'), ctx())).toEqual({ ops: [{ op: 'outdent', ids: ['S2'] }] });
  });

  it('nothing selected says so', () => {
    expect(indentSelected(EMPTY_SELECTION, ctx())).toEqual({ error: 'Select a task first.' });
  });
});

describe('insertTask', () => {
  it('a task goes right above the active row', () => {
    expect(insertTask(selectCell('B', 'duration'), 'task', ctx())).toEqual({
      ops: [{ op: 'add_task', temp_id: 't1', before_id: 'B', name: 'New Task' }],
      select: 't1',
    });
  });

  it('a milestone has a zero duration; on the blank row it goes at the end', () => {
    const c = { ...ctx(), appendParentId: 'S' };
    expect(insertTask(selectCell('blank', 'name'), 'milestone', c)).toEqual({
      ops: [{ op: 'add_task', temp_id: 't1', parent_id: 'S', name: 'New Milestone', duration: '0' }],
      select: 't1',
    });
  });

  it('a summary is a new task with a new subtask, indented in a second batch', () => {
    const result = insertTask(selectCell('C', 'name'), 'summary', ctx());
    expect(result).toMatchObject({
      ops: [
        { op: 'add_task', temp_id: 't1', before_id: 'C', name: 'New Summary Task' },
        { op: 'add_task', temp_id: 't2', before_id: 'C', name: 'New Task' },
      ],
      select: 't1',
    });
    if (!('ops' in result) || !result.then) throw new Error('expected a second batch');
    expect(result.then({ t1: 'real-1', t2: 'real-2' })).toEqual([{ op: 'indent', ids: ['real-2'] }]);
  });
});

describe('deleteSelected', () => {
  it('deletes the selected tasks; a summary among them asks first', () => {
    expect(deleteSelected(pick('A', 'C'), ctx())).toEqual({ ops: [{ op: 'delete_tasks', ids: ['A', 'C'] }] });
    expect(deleteSelected(pick('S', 'A'), ctx())).toEqual({
      ops: [{ op: 'delete_tasks', ids: ['A', 'S'] }],
      confirm: { tasks: 2, subtasks: 2 },
    });
  });
});

describe('progress and properties', () => {
  it('a % below 100 leaves summaries out (theirs is derived); 100 completes them', () => {
    expect(setPercent(pick('A', 'S'), 50, ctx())).toEqual({ ops: [{ op: 'set_percent', ids: ['A'], percent: 50 }] });
    expect(setPercent(pick('A', 'S'), 100, ctx())).toEqual({
      ops: [{ op: 'set_percent', ids: ['A', 'S'], percent: 100 }],
    });
    expect(setPercent(pick('S'), 25, ctx())).toEqual({ error: PLAN_ERRORS.summary_field });
  });

  it('Mark on Track sends the selection', () => {
    expect(markOnTrack(pick('B', 'S'), ctx())).toEqual({ ops: [{ op: 'mark_on_track', ids: ['B', 'S'] }] });
  });

  it('a mode goes to each task that does not have it yet', () => {
    expect(setMode(pick('S1', 'S2'), 'manual', ctx())).toEqual({
      ops: [{ op: 'update_task', id: 'S1', fields: { mode: 'manual' } }],
    });
    expect(setMode(pick('S2'), 'manual', ctx())).toEqual({ ops: [] });
  });

  it('Task color: one update_task per selected task, in one batch; null clears it', () => {
    expect(setColor(pick('A', 'S', 'S1'), '#1668a7', ctx())).toEqual({
      ops: [
        { op: 'update_task', id: 'A', fields: { color: '#1668a7' } },
        { op: 'update_task', id: 'S', fields: { color: '#1668a7' } },
        { op: 'update_task', id: 'S1', fields: { color: '#1668a7' } },
      ],
    });
    // a task that has it already is left out; None clears the others
    const colored = tasks().map((t) => (t.id === 'A' ? { ...t, color: '#1668a7' } : t));
    expect(setColor(pick('A', 'B'), '#1668a7', ctx({ tasks: colored }))).toEqual({
      ops: [{ op: 'update_task', id: 'B', fields: { color: '#1668a7' } }],
    });
    expect(setColor(pick('A', 'B'), null, ctx({ tasks: colored }))).toEqual({
      ops: [{ op: 'update_task', id: 'A', fields: { color: null } }],
    });
    expect(setColor(EMPTY_SELECTION, '#1668a7', ctx())).toEqual({ error: SELECT_FIRST });
  });

  it('the selection’s color: the one they share, null for none, undefined when they differ', () => {
    const [a, b, c] = [{ color: '#1668a7' }, { color: '#1668a7' }, { color: null }];
    expect(sharedColor([a, b])).toBe('#1668a7');
    expect(sharedColor([c])).toBeNull();
    expect(sharedColor([a, c])).toBeUndefined();
    expect(sharedColor([])).toBeUndefined();
  });

  it('Add to Timeline turns it on for all unless all have it, then off', () => {
    const on = tasks().map((t) => (t.id === 'A' ? { ...t, show_on_timeline: true } : t));
    expect(toggleTimeline(pick('A', 'B'), ctx({ tasks: on }))).toEqual({
      ops: [{ op: 'update_task', id: 'B', fields: { show_on_timeline: true } }],
    });
    expect(toggleTimeline(pick('A'), ctx({ tasks: on }))).toEqual({
      ops: [{ op: 'update_task', id: 'A', fields: { show_on_timeline: false } }],
    });
  });
});

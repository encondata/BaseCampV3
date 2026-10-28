/**
 * lib/plans/indicators.ts: the Indicators column — which icons a task shows
 * and the tooltip each one carries (MS Project vocabulary).
 */
import { describe, expect, it } from 'vitest';

import { indicatorsOf, noteExcerpt } from './indicators';
import { makeTask } from './planFixtures';

const CTX = { showTimes: false, locked: false };
const kinds = (over = {}, ctx = CTX) => indicatorsOf(makeTask('t', over), ctx).map((i) => i.kind);
const title = (kind: string, over = {}, ctx = CTX) =>
  indicatorsOf(makeTask('t', over), ctx).find((i) => i.kind === kind)?.title;

describe('indicatorsOf', () => {
  it('a plain task shows none', () => {
    expect(kinds()).toEqual([]);
  });

  it('a constraint names its type and date', () => {
    expect(title('constraint', { constraint_type: 'snet', constraint_date: '2026-11-05T08:00' }))
      .toBe('Start No Earlier Than Thu 11/5/26');
    expect(title('constraint', { constraint_type: 'mfo', constraint_date: '2026-11-06T17:00' },
      { showTimes: true, locked: false })).toBe('Must Finish On Fri 11/6/26 5:00 PM');
    expect(kinds({ constraint_type: 'asap' })).toEqual([]);
  });

  it('a missed deadline gives the finish and the deadline', () => {
    expect(title('deadline', {
      missed_deadline: true, finish: '2026-11-09T17:00', deadline: '2026-11-06T17:00',
    })).toBe('Missed deadline: finishes Mon 11/9/26, deadline Fri 11/6/26');
  });

  it('a scheduling conflict says which side gave way', () => {
    expect(title('conflict', { conflict: 'link' }))
      .toBe('Scheduling conflict: the constraint overrides a link');
    expect(title('conflict', { conflict: 'constraint' }))
      .toBe('Scheduling conflict: a link overrides the constraint');
  });

  it('a complete task says when and who marked it', () => {
    expect(title('complete', {
      percent_complete: 100, actual_finish: '2026-11-06T17:00', completed_by_name: 'Dana Reyes',
    })).toBe('Completed Fri 11/6/26 by Dana Reyes');
    // summaries are never stamped: complete from % alone
    expect(title('complete', { percent_complete: 100, is_summary: true })).toBe('Complete');
    expect(kinds({ percent_complete: 99 })).toEqual([]);
  });

  it('a note shows its text, its lines kept (blank runs closed up), cut short when long', () => {
    expect(title('note', { notes: 'Call the dock' })).toBe('Notes: Call the dock');
    expect(title('note', { notes: 'Call the\r\nloading   dock\n\n\n\nthen pack  ' }))
      .toBe('Notes:\nCall the\nloading dock\n\nthen pack');
    const long = title('note', { notes: 'x'.repeat(900) })!;
    expect(long.length).toBeLessThanOrEqual('Notes: '.length + 401);
    expect(long.endsWith('…')).toBe(true);
    const tall = title('note', { notes: Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') })!;
    expect(tall.split('\n')).toHaveLength(1 + 8);
    expect(tall.endsWith('line 8…')).toBe(true);
    expect(kinds({ notes: '   ' })).toEqual([]);
  });

  it('noteExcerpt: the note as a tooltip shows it', () => {
    expect(noteExcerpt('one\n\n\ntwo')).toBe('one\n\ntwo');
    expect(noteExcerpt(null)).toBe('');
  });

  it('a locked schedule marks every task', () => {
    expect(title('locked', {}, { showTimes: false, locked: true }))
      .toBe('Schedule locked — progress updates only');
  });

  it('lists them in a fixed order', () => {
    expect(kinds({
      percent_complete: 100, constraint_type: 'mso', constraint_date: '2026-11-05T08:00',
      conflict: 'link', missed_deadline: true, deadline: '2026-11-04T17:00', notes: 'n',
    }, { showTimes: false, locked: true })).toEqual(['complete', 'constraint', 'conflict', 'deadline', 'note', 'locked']);
  });
});

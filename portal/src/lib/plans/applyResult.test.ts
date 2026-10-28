/**
 * lib/plans/applyResult.ts: what a plan write answers its caller. The
 * completion 409s become their own kinds (the completion dialog reads
 * them), every other failure is plain-language text with its code and the
 * tasks it names; a resend after `completion_confirm` confirms every op
 * that completes something.
 */
import { describe, expect, it } from 'vitest';

import { ApiError } from '../api';
import type { Op } from './api';
import { failureOf, withConfirm } from './applyResult';
import { DurationError } from './durations';
import { makeRestore } from './planFixtures';

const apiError = (status: number, detail: Record<string, unknown>) =>
  new ApiError(status, String(detail.code), detail);

const blocker = { task_id: 't', display_id: 3, name: 'Rack', reason: 'predecessor' as const };

describe('failureOf', () => {
  it('reads completion_confirm, either list possibly empty or missing', () => {
    expect(failureOf(apiError(409, {
      code: 'completion_confirm', will_complete: [], open_predecessors: [blocker],
    }))).toEqual({ ok: false, kind: 'confirm', willComplete: [], openPredecessors: [blocker] });
    expect(failureOf(apiError(409, { code: 'completion_confirm', will_complete: [blocker] })))
      .toEqual({ ok: false, kind: 'confirm', willComplete: [blocker], openPredecessors: [] });
  });

  it('reads completion_blocked', () => {
    expect(failureOf(apiError(409, { code: 'completion_blocked', blockers: [blocker] })))
      .toEqual({ ok: false, kind: 'blocked', blockers: [blocker] });
  });

  it('words any other error and names its tasks', () => {
    expect(failureOf(apiError(422, { code: 'schedule_error', task_ids: ['a', 'b'], display_ids: [1, 2] })))
      .toEqual({
        ok: false, kind: 'error', code: 'schedule_error',
        message: 'The plan can’t be scheduled as it stands. Check tasks 1 and 2.', taskIds: ['a', 'b'],
      });
    expect(failureOf(apiError(422, { code: 'summary_field', task_id: 's' })))
      .toMatchObject({ code: 'summary_field', taskIds: ['s'] });
    expect(failureOf(apiError(409, { code: 'plan_locked' }))).not.toHaveProperty('taskIds');
  });

  it('words a failure that is not an API error', () => {
    expect(failureOf(new TypeError('Failed to fetch'))).toEqual({
      ok: false, kind: 'error', code: 'unknown_error', message: 'Something went wrong. Try again.',
    });
    expect(failureOf(new DurationError('“5x” isn’t a duration. Try 5d, 4h or 3ed.'))).toEqual({
      ok: false, kind: 'error', code: 'bad_duration', message: '“5x” isn’t a duration. Try 5d, 4h or 3ed.',
    });
    expect(failureOf(new ApiError(500, 'unknown_error'))).toMatchObject({ code: 'unknown_error' });
  });
});

describe('withConfirm', () => {
  it('confirms every op that completes something, and nothing else', () => {
    const restore = makeRestore('r');
    const ops: Op[] = [
      { op: 'set_percent', ids: ['a'], percent: 100 },
      { op: 'complete', ids: ['b'] },
      { op: 'mark_on_track', ids: ['c'] },
      { op: 'update_task', id: 'a', fields: { percent_complete: 100 } },
      { op: 'update_task', id: 'b', fields: { name: 'Racked' } },
      { op: 'add_link', predecessor_id: 'a', successor_id: 'b' },
      restore,
    ];
    const sent = withConfirm(ops);
    expect(sent.map((op) => ('confirm' in op ? op.confirm : undefined)))
      .toEqual([true, true, true, true, undefined, undefined, undefined]);
    expect(sent[4]).toBe(ops[4]);
    expect(sent[6]).toBe(restore);
    expect(ops[0]).not.toHaveProperty('confirm');
  });
});

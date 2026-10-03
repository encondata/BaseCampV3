import { expect, it } from 'vitest';

import { DEPLOYMENT_STATUS, STEP_STATUS, duration, sshTargets, stoppedStep } from './labels';
import { FAILED, RUNNING, SUCCEEDED, TARGETS } from './testData';

it('stoppedStep mirrors the API: the failed/cancelled/interrupted step, else the first not run', () => {
  expect(stoppedStep(FAILED.steps)).toBe(5);
  expect(stoppedStep(SUCCEEDED.steps)).toBeNull();
  expect(stoppedStep(RUNNING.steps)).toBeNull();
  const interruptedEarly = FAILED.steps.map((s) => (s.number >= 3 ? { ...s, status: 'not_run' as const } : s));
  expect(stoppedStep(interruptedEarly)).toBe(3);
});

it('duration reads seconds, then minutes', () => {
  expect(duration(null, null)).toBe('');
  expect(duration('2026-10-03T13:00:00Z', '2026-10-03T13:00:42Z')).toBe('42s');
  expect(duration('2026-10-03T13:00:00Z', '2026-10-03T13:01:05Z')).toBe('1m 05s');
  expect(duration('2026-10-03T13:00:00Z', null, Date.parse('2026-10-03T13:00:09Z'))).toBe('9s');
});

it('sshTargets keeps configured SSH targets only', () => {
  expect(sshTargets(TARGETS.targets).map((t) => t.id)).toEqual(['ssh:lab']);
});

it('the cancelled status reads in American English; the API value is unchanged', () => {
  expect(DEPLOYMENT_STATUS.cancelled).toEqual(['c-amber', 'Canceled']);
  expect(STEP_STATUS.cancelled).toEqual(['c-amber', 'Canceled']);
});

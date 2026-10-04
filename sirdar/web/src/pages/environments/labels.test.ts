import { expect, it } from 'vitest';

import {
  DEPLOYMENT_STATUS, MODE_LABEL, STEP_STATUS, dumpTakenAt, duration, formatBytes, snapshotLabel, sshTargets, stoppedStep,
} from './labels';
import { FAILED, RUNNING, SNAP, SUCCEEDED, TARGETS } from './testData';

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

it('formatBytes and snapshotLabel', () => {
  expect(formatBytes(null)).toBe('—');
  expect(formatBytes(512)).toBe('512 bytes');
  expect(formatBytes(1536)).toBe('1.5 KB');
  expect(formatBytes(552_000_000)).toBe('526.4 MB');
  expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB');
  expect(snapshotLabel(SNAP)).toBe('dev-2026-10-04 · mac-dev · migration 0089 · 526.4 MB');
});

it('every deployment mode has a label', () => {
  expect(MODE_LABEL.snapshot).toBe('Take snapshot');
  expect(MODE_LABEL.restore_dump).toBe('Restore backup');
  expect(MODE_LABEL.rollback).toBe('Roll back');
});

it('dumpTakenAt reads the UTC time out of a dump name or path', () => {
  expect(dumpTakenAt('20261003T130500Z.dump')).toBe('2026-10-03T13:05:00Z');
  expect(dumpTakenAt('/opt/serversherpa/uat/backups/20261004T010203Z.dump')).toBe('2026-10-04T01:02:03Z');
  expect(dumpTakenAt('/opt/serversherpa/uat/backups/pre-deploy-20261003.dump')).toBeNull();
  expect(dumpTakenAt(null)).toBeNull();
});

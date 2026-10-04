import { expect, it } from 'vitest';

import {
  CERT_STATE, DEPLOYMENT_STATUS, ENV_STATUS, GATED_MODES, MODE_LABEL, PUBLISH_STATE, RETRY_MODES, STEP_STATUS,
  deploymentRunning, dumpTakenAt, duration, envTargets, formatBytes, onProxmox, snapshotLabel, sshTargets,
  stoppedStep, vmNetwork, vmSize,
} from './labels';
import {
  ENV, FAILED, PUBLISHING, PX_ENV, PX_TARGETS, PX_VM, RUNNING, SNAP, SUCCEEDED, TARGETS, summary,
} from './testData';

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

it('labels the publish and delete modes, the deleting status and the publish states', () => {
  expect([MODE_LABEL.publish, MODE_LABEL.teardown]).toEqual(['Publish', 'Delete environment']);
  expect(ENV_STATUS.deleting).toEqual(['c-amber', 'Deleting']);
  expect(GATED_MODES).toEqual(['reset', 'restore_dump', 'rollback', 'teardown', 'vm_restore']);
  expect(RETRY_MODES).toEqual(['update', 'reset', 'restore_dump', 'rollback', 'publish', 'teardown', 'vm_restore']);
  expect(Object.keys(PUBLISH_STATE)).toEqual(['ok', 'update', 'create', 'claimable', 'conflict', 'unknown']);
  expect(PUBLISH_STATE.claimable).toEqual(['c-amber', "Not Sirdar's"]);
  expect(PUBLISH_STATE.conflict).toEqual(['c-red', 'Blocked']);
  expect(CERT_STATE.create).toEqual(['tag', 'Will request']);
});

it('deploymentRunning: deploying, deleting, or a latest deployment still running (a publish job)', () => {
  expect(deploymentRunning(ENV)).toBe(false);
  expect(deploymentRunning({ ...ENV, status: 'deploying' })).toBe(true);
  expect(deploymentRunning({ ...ENV, status: 'deleting' })).toBe(true);
  expect(deploymentRunning({ ...ENV, last_deployment: summary(PUBLISHING) })).toBe(true);
  expect(deploymentRunning({ ...ENV, last_deployment: summary({ ...PUBLISHING, status: 'succeeded' }) })).toBe(false);
  expect(deploymentRunning({ ...ENV, last_deployment: null })).toBe(false);
});

it('Proxmox: targets, the mode, and the VM in words', () => {
  expect(envTargets(TARGETS.targets).map((t) => t.id)).toEqual(['ssh:lab']);
  expect(envTargets(PX_TARGETS.targets).map((t) => t.id)).toEqual(['ssh:lab', 'proxmox']);
  expect(sshTargets(PX_TARGETS.targets).map((t) => t.id)).toEqual(['ssh:lab']);
  expect([onProxmox(ENV), onProxmox(PX_ENV)]).toEqual([false, true]);
  expect(MODE_LABEL.vm_restore).toBe('Restore VM snapshot');
  expect(GATED_MODES).toContain('vm_restore');
  expect(RETRY_MODES).toContain('vm_restore');
  expect(vmSize(PX_VM)).toBe('4 vCPU · 8 GB · 64 GB disk');
  expect(vmSize({ ...PX_VM, memory_mb: 12288 })).toBe('4 vCPU · 12 GB · 64 GB disk');
  expect(vmNetwork(PX_VM)).toBe('10.10.48.70/24 via 10.10.48.1');
  expect(vmNetwork({ ...PX_VM, ip_mode: 'dhcp', ip_cidr: null, gateway: null })).toBe('DHCP');
  expect(vmNetwork({ ...PX_VM, ip_cidr: null, gateway: null })).toBe('Static, no address yet');
  expect(vmNetwork({ ...PX_VM, gateway: null })).toBe('10.10.48.70/24');
});

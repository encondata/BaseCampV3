import { describe, expect, it } from 'vitest';

import { formatAge, formatUptime, statusMeta } from './system';

describe('statusMeta', () => {
  it('maps the three statuses', () => {
    expect(statusMeta('running')).toEqual(
      { label: 'Running', className: 'sys-dot-running' });
    expect(statusMeta('stopped')).toEqual(
      { label: 'Stopped', className: 'sys-dot-stopped' });
    expect(statusMeta('failed')).toEqual(
      { label: 'Failed', className: 'sys-dot-failed' });
    expect(statusMeta('weird')).toEqual(
      { label: 'weird', className: 'sys-dot-stopped' });
  });

  it('statusMeta knows paused', () => {
    expect(statusMeta('paused')).toEqual({ label: 'Paused', className: 'sys-dot-paused' });
  });
});

describe('formatAge', () => {
  const now = Date.parse('2026-08-26T12:00:00Z');
  it('renders humane ages', () => {
    expect(formatAge('2026-08-26T11:59:57Z', now)).toBe('3 s ago');
    expect(formatAge('2026-08-26T11:58:00Z', now)).toBe('2 min ago');
    expect(formatAge('2026-08-26T09:00:00Z', now)).toBe('3 h ago');
    expect(formatAge(null, now)).toBe('—');
  });
});

describe('formatUptime', () => {
  it('renders compact uptime', () => {
    expect(formatUptime(42)).toBe('42s');
    expect(formatUptime(3900)).toBe('1h 5m');
    expect(formatUptime(90 * 3600)).toBe('3d 18h');
    expect(formatUptime(null)).toBe('—');
  });
});

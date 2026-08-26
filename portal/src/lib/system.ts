/** Pure helpers for the System pages (processes list + log viewer). */

export function statusMeta(status: string): { label: string; className: string } {
  switch (status) {
    case 'running': return { label: 'Running', className: 'sys-dot-running' };
    case 'failed': return { label: 'Failed', className: 'sys-dot-failed' };
    case 'stopped': return { label: 'Stopped', className: 'sys-dot-stopped' };
    default: return { label: status, className: 'sys-dot-stopped' };
  }
}

export function formatAge(iso: string | null, nowMs: number): string {
  if (!iso) return '—';
  const seconds = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  return `${Math.floor(seconds / 3600)} h ago`;
}

export function formatUptime(seconds: number | null): string {
  if (seconds === null || seconds === undefined) return '—';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  }
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

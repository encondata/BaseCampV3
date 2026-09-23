/** Pure helpers for the System pages (processes list + log viewer). */

import type { ColumnDef } from './listTools';

/** System → Processes has no column picker: the seven tracks below are the
 *  list's whole registry, mirroring the header labels SystemProcesses.tsx
 *  renders, with the widths the `.sys-proc-grid` CSS template used to carry
 *  (system.css, deleted in favour of the inline template). Lives here, not
 *  in the page, so the fit test can import it without dragging the router,
 *  AuthContext, and the page's stylesheets into a unit test (recipe R7).
 *  Fit: default columns ≤ LIST_FIT.page (1172px — the list sits directly
 *  in .portal-page at a 1512px window, nav expanded). */
export const SYSTEM_PROCESS_COLUMNS: ColumnDef[] = [
  { key: 'status', label: 'Status', width: '170px', default: true },
  { key: 'name', label: 'Process', width: '1.2fr', default: true, min: 140 },
  { key: 'kind', label: 'Kind', width: '110px', default: true },
  { key: 'hostname', label: 'Host', width: '1fr', default: true, min: 110 },
  { key: 'pid', label: 'PID', width: '80px', default: true },
  { key: 'uptime', label: 'Uptime', width: '110px', default: true },
  { key: 'heartbeat', label: 'Last heartbeat', short: 'Heartbeat', width: '140px', default: true },
];

export function statusMeta(status: string): { label: string; className: string } {
  switch (status) {
    case 'running': return { label: 'Running', className: 'sys-dot-running' };
    case 'paused': return { label: 'Paused', className: 'sys-dot-paused' };
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

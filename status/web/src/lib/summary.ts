export type ServiceState = 'up' | 'down' | 'unknown';
export type Overall = 'operational' | 'degraded' | 'unknown';

export interface DayBar { day: string; ok: number | null; total: number | null }

export interface ServiceSummary {
  key: string;
  name: string;
  state: ServiceState;
  last_checked_at: string | null;
  latency_ms: number | null;
  uptime_90d: number | null;
  days: DayBar[];
}

export interface Summary {
  generated_at: string;
  overall: Overall;
  interval_seconds: number;
  failure_threshold: number;
  services: ServiceSummary[];
}

export const POLL_MS = 30_000;

export async function fetchSummary(signal?: AbortSignal): Promise<Summary> {
  const resp = await fetch('/api/summary', { cache: 'no-store', signal });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return (await resp.json()) as Summary;
}

/** Two decimals, truncated — 99.9999 must never read as 100%. */
export function formatUptime(pct: number | null): string {
  if (pct === null) return '—';
  if (pct >= 100) return '100%';
  return `${(Math.floor(pct * 100) / 100).toFixed(2)}%`;
}

export function barTone(bar: DayBar): 'up' | 'down' | 'none' {
  if (!bar.total) return 'none';
  return bar.ok === bar.total ? 'up' : 'down';
}

export function dayUptime(bar: DayBar): string {
  if (!bar.total) return 'No data';
  return formatUptime(((bar.ok ?? 0) / bar.total) * 100);
}

const DAY_FMT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const CLOCK_FMT = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });

/** Days are UTC calendar days; format them in UTC so they never shift. */
export function formatDay(day: string): string {
  return DAY_FMT.format(new Date(`${day}T00:00:00Z`));
}

/** The viewer's offset from UTC at that moment ("UTC-6", "UTC+5:30", "UTC"),
 *  so DST is right for the time shown. An offset, not a zone name. */
export function utcOffsetLabel(at: Date): string {
  const ahead = -at.getTimezoneOffset();
  if (ahead === 0) return 'UTC';
  const abs = Math.abs(ahead);
  const minutes = abs % 60;
  return `UTC${ahead > 0 ? '+' : '-'}${Math.floor(abs / 60)}${minutes ? `:${String(minutes).padStart(2, '0')}` : ''}`;
}

/** Clock time in the viewer's zone, labeled with its UTC offset. */
export function formatClock(at: string | Date): string {
  const date = typeof at === 'string' ? new Date(at) : at;
  return `${CLOCK_FMT.format(date)} ${utcOffsetLabel(date)}`;
}

/** The footer's "how this page works" line, driven by the configured
 * interval/threshold rather than hardcoded — so it never drifts from
 * what the checker is actually doing. */
export function footerCopy(intervalSeconds: number, failureThreshold: number): string {
  let cadence: string;
  if (intervalSeconds === 60) {
    cadence = 'every minute';
  } else if (intervalSeconds > 60 && intervalSeconds % 60 === 0) {
    const minutes = intervalSeconds / 60;
    cadence = `every ${minutes} minute${minutes === 1 ? '' : 's'}`;
  } else {
    cadence = `every ${intervalSeconds} second${intervalSeconds === 1 ? '' : 's'}`;
  }
  const checks = failureThreshold === 1 ? '1 failed check' : `${failureThreshold} failed checks`;
  return `Checks run ${cadence}. A service shows down after ${checks} in a row.`;
}

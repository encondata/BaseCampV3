/** Labels, status chips and small helpers shared by the environment pages. */
import type { DeployTarget, DeploymentStep, Snapshot } from '../../lib/sirdarApi';

/** status → [chip class, label] */
type ChipMap = Record<string, [string, string]>;

export const ENV_STATUS: ChipMap = {
  new: ['tag', 'New'], ready: ['c-green', 'Ready'], deploying: ['c-blue', 'Deploying'], failed: ['c-red', 'Failed'],
};
export const DEPLOYMENT_STATUS: ChipMap = {
  running: ['c-blue', 'Running'], succeeded: ['c-green', 'Succeeded'], failed: ['c-red', 'Failed'],
  cancelled: ['c-amber', 'Canceled'], interrupted: ['c-amber', 'Interrupted'], adopted: ['tag', 'Adopted'],
};
export const STEP_STATUS: ChipMap = {
  pending: ['tag', 'Pending'], running: ['c-blue', 'Running'], succeeded: ['c-green', 'Done'],
  failed: ['c-red', 'Failed'], skipped: ['tag', 'Skipped'], not_run: ['tag', 'Not run'],
  cancelled: ['c-amber', 'Canceled'], interrupted: ['c-amber', 'Interrupted'],
};
export const TYPE_LABEL: Record<string, string> = { dev: 'Dev', beta: 'Beta', custom: 'Custom' };
export const MODE_LABEL: Record<string, string> = {
  update: 'Update', reset: 'Reset data', adopt: 'Adopt', snapshot: 'Take snapshot',
  restore_dump: 'Restore backup', rollback: 'Roll back',
};
export const SNAPSHOT_STATUS: ChipMap = {
  pending: ['c-blue', 'Taking'], ready: ['c-green', 'Ready'], failed: ['c-red', 'Failed'],
};
/** Deployment statuses the API retries (pipeline.RETRYABLE_STATUSES). */
export const RETRYABLE = ['failed', 'cancelled', 'interrupted'];
/** Modes that replace data: they need deploy:change and the environment's name typed back
 *  (the API's GATED_MODES). A snapshot job is never retried. */
export const GATED_MODES = ['reset', 'restore_dump', 'rollback'];
export const RETRY_MODES = ['update', 'reset', 'restore_dump', 'rollback'];

/** 1,536 → "1.5 KB"; null → "—". Binary steps, as the file sizes people see. */
export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  const units = ['KB', 'MB', 'GB', 'TB'];
  if (n < 1024) return `${n} bytes`;
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(1)} ${units[i]}`;
}

/** One line for a snapshot in a picker. */
export const snapshotLabel = (s: Snapshot) =>
  `${s.name} · ${s.source} · migration ${s.alembic_revision ?? '—'} · ${formatBytes(s.size_bytes)}`;

export function StatusChip({ map, status }: { map: ChipMap; status: string }) {
  const [cls, label] = map[status] ?? ['tag', status];
  return <span className={`chip ${cls}`}>{label}</span>;
}

export const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '—');
export const shortSha = (sha: string | null | undefined) => (sha ? sha.slice(0, 8) : '—');

/** "42s" / "1m 05s"; a step still running counts up to `now`. */
export function duration(start: string | null, end: string | null, now = Date.now()): string {
  if (!start) return '';
  const secs = Math.max(0, Math.round(((end ? Date.parse(end) : now) - Date.parse(start)) / 1000));
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s`;
}

/** Where a deployment stopped, as the API's retry check works it out: its
 *  failed, cancelled or interrupted step, else its first step that didn't run. */
export function stoppedStep(steps: DeploymentStep[]): number | null {
  const ended = steps.find((s) => s.status === 'failed' || s.status === 'cancelled' || s.status === 'interrupted');
  if (ended) return ended.number;
  return steps.find((s) => s.status === 'not_run')?.number ?? null;
}

export const targetLabel = (targets: DeployTarget[], id: string) => targets.find((t) => t.id === id)?.label ?? id;

/** Targets an environment can use: the installer's and saved SSH targets that are configured. */
export const sshTargets = (targets: DeployTarget[]) =>
  targets.filter((t) => (t.id === 'ssh' || t.id.startsWith('ssh:')) && t.available && t.configured);

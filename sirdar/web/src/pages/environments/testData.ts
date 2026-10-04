/** Fixtures shaped like the /api/deploy environment and deployment endpoints. */
import type {
  Backup, Deployment, DeploymentStatus, DeploymentStep, DeploymentSummary, DeployTarget, Environment,
  EnvironmentDefaults, EnvService, Snapshot, StepStatus,
} from '../../lib/sirdarApi';

export const SHA = `e73b99ca${'1'.repeat(32)}`;
export const NEW_SHA = `f00dbabe${'2'.repeat(32)}`;

const svc = (service: string, port: number): EnvService => ({
  service, host_ip: '10.10.48.63', port, proxied: false,
  hostname: service === 'mailpit' ? null : `${service}.uat.serversherpa.com`,
});

export const ADOPTED: DeploymentSummary = {
  id: 'd0', mode: 'adopt', git_ref: 'main', sha: SHA, status: 'adopted', start_step: 1, retry_of: null,
  failed_step: null, dump_path: null, snapshot: null, restore_dump: null, rollback_available: false,
  previous_sha: null, error: null, actor_name: 'Jimmy Henderson',
  started_at: '2026-10-03T12:00:00Z', finished_at: '2026-10-03T12:00:00Z', created_at: '2026-10-03T12:00:00Z',
};

export const ENV: Environment = {
  id: 'e1', name: 'uat', type: 'dev', target: 'ssh:lab', base_domain: 'uat.serversherpa.com',
  env_dir: '/opt/serversherpa/uat', git_ref: 'main', current_sha: SHA, image_tag: 'e73b99ca',
  status: 'ready', proxy_ip: '10.10.48.6', bind_ip: '0.0.0.0', keep_dumps: 5,
  spaces_bucket: 'serversherpa', log_level: 'INFO',
  services: [svc('api', 8000), svc('portal', 8091), svc('kiosk', 8090), svc('wiki', 8096),
             svc('spaces', 9000), svc('status', 8095), svc('mailpit', 8025)],
  secrets_set: { SS_ANTHROPIC_API_KEY: true, SS_DB_TESTING_PASSWORD: false },
  seed_snapshot: null, last_deployment: ADOPTED, created_at: '2026-10-03T12:00:00Z', updated_at: '2026-10-03T12:00:00Z',
};

export const TARGETS = {
  targets: [
    { id: 'aws', label: 'AWS', kind: 'aws', available: false, configured: false },
    { id: 'ssh', label: 'Custom (SSH) · Installer', kind: 'ssh', source: 'installer', available: true, configured: false },
    { id: 'ssh:lab', label: 'Lab box', kind: 'ssh', source: 'saved', available: true, configured: true },
  ] as DeployTarget[],
  types: [], can_add_ssh: true, ssh_store_hint: null,
};

export const DEFAULTS: EnvironmentDefaults = {
  services: [
    { service: 'api', port: 8000, public: true }, { service: 'portal', port: 8091, public: true },
    { service: 'kiosk', port: 8090, public: true }, { service: 'wiki', port: 8096, public: true },
    { service: 'spaces', port: 9000, public: true }, { service: 'status', port: 8095, public: true },
    { service: 'mailpit', port: 8025, public: false },
  ],
  domain_suffix: 'serversherpa.com', env_root: '/opt/serversherpa', git_ref: 'main', bind_ip: '0.0.0.0',
  keep_dumps: 5, spaces_bucket: 'serversherpa', log_levels: ['DEBUG', 'INFO', 'WARNING', 'ERROR'],
  optional_secrets: ['SS_ANTHROPIC_API_KEY', 'SS_DB_TESTING_PASSWORD'],
};

const UPDATE_PLAN: [number, string, string][] = [
  [1, 'preflight', 'Preflight'], [2, 'bootstrap', 'Bootstrap'], [3, 'fetch', 'Fetch code'],
  [4, 'render', 'Render config'], [5, 'build', 'Build images'], [6, 'dump', 'Pre-deploy dump'],
  [10, 'up', 'Start services'],
];
const RESET_PLAN: [number, string, string][] = [
  [1, 'preflight', 'Preflight'], [2, 'bootstrap', 'Bootstrap'], [3, 'fetch', 'Fetch code'],
  [4, 'render', 'Render config'], [5, 'build', 'Build images'], [7, 'reset', 'Reset data'],
  [10, 'up', 'Start services'],
];
const RESTORE_DUMP_PLAN: [number, string, string][] = [
  [1, 'preflight', 'Preflight'], [3, 'fetch', 'Fetch code'], [4, 'render', 'Render config'],
  [5, 'build', 'Build images'], [8, 'data', 'Start data services'], [9, 'restore_dump', 'Restore backup'],
  [10, 'up', 'Start services'],
];
const ENDED: StepStatus[] = ['succeeded', 'failed', 'cancelled', 'interrupted'];

function steps(plan: [number, string, string][], statuses: StepStatus[], logs: Record<number, string>): DeploymentStep[] {
  return plan.map(([number, key, name], i) => {
    const status = statuses[i];
    const log = logs[number] ?? '';
    const ran = status !== 'pending' && status !== 'not_run' && status !== 'skipped';
    return { number, key, name, status, started_at: ran ? '2026-10-03T13:00:00Z' : null,
             finished_at: ENDED.includes(status) ? '2026-10-03T13:01:05Z' : null,
             log_size: log.length, log_tail: log };
  });
}

function deployment(status: DeploymentStatus, statuses: StepStatus[], logs: Record<number, string> = {},
                    extra: Partial<Deployment> = {}): Deployment {
  const mode = extra.mode ?? 'update';
  return {
    id: 'd1', mode, git_ref: 'main', sha: NEW_SHA, status, start_step: 1, retry_of: null, failed_step: null,
    dump_path: null, snapshot: null, restore_dump: null, rollback_available: false,
    previous_sha: SHA, error: null, actor_name: 'Jimmy Henderson',
    started_at: '2026-10-03T13:00:00Z', finished_at: status === 'running' ? null : '2026-10-03T13:10:00Z',
    created_at: '2026-10-03T13:00:00Z', environment: 'uat',
    steps: steps(mode === 'reset' ? RESET_PLAN : mode === 'restore_dump' ? RESTORE_DUMP_PLAN : UPDATE_PLAN,
                 statuses, logs), ...extra,
  };
}

const AT_STEP_3: StepStatus[] = ['succeeded', 'succeeded', 'running', 'pending', 'pending', 'pending', 'pending'];
const FAILED_AT_5: StepStatus[] = ['succeeded', 'succeeded', 'succeeded', 'succeeded', 'failed', 'not_run', 'not_run'];
const ALL_DONE: StepStatus[] = ['succeeded', 'succeeded', 'succeeded', 'succeeded', 'succeeded', 'succeeded', 'succeeded'];
const BUILD_FAILED = 'Step 5 (Build images) failed. See its log.';

export const RUNNING = deployment('running', AT_STEP_3, { 3: 'Cloning the repo\n' });
export const RUNNING_MORE = deployment('running', AT_STEP_3, { 3: 'Cloning the repo\nChecked out f00dbabe\n' });
export const SUCCEEDED = deployment('succeeded', ALL_DONE, {},
  { dump_path: '/opt/serversherpa/uat/backups/pre-deploy-20261003.dump' });
export const FAILED = deployment('failed', FAILED_AT_5, { 5: 'docker build exited 1\n' },
  { failed_step: 5, error: BUILD_FAILED });
export const RESET_FAILED = deployment('failed', FAILED_AT_5, { 5: 'docker build exited 1\n' },
  { id: 'd3', mode: 'reset', failed_step: 5, error: BUILD_FAILED });
const UP_FAILED: StepStatus[] = ['succeeded', 'succeeded', 'succeeded', 'succeeded', 'succeeded', 'succeeded', 'failed'];
/** A failed Update that can be rolled back: its dump exists and it has a previous commit. */
export const ROLLBACKABLE = deployment('failed', UP_FAILED, { 10: 'migrate exited 1\n' }, {
  id: 'd4', failed_step: 10, error: 'Step 10 (Start services) failed. See its log.',
  dump_path: '/opt/serversherpa/uat/backups/20261003T130500Z.dump', rollback_available: true,
});
export const RESTORE_FAILED = deployment('failed', ['succeeded', 'succeeded', 'succeeded', 'succeeded', 'succeeded', 'failed', 'not_run'],
  { 9: 'pg_restore failed\n' }, {
    id: 'd5', mode: 'restore_dump', sha: SHA, git_ref: SHA, failed_step: 9, restore_dump: '20261003T130500Z.dump',
    error: 'Step 9 (Restore backup) failed. See its log.',
  });

export const SNAP: Snapshot = {
  id: 's1', name: 'dev-2026-10-04', origin: 'upload', source: 'mac-dev', status: 'ready', alembic_revision: '0089',
  size_bytes: 552_000_000, checksum: 'ab'.repeat(32), object_count: 17_603, object_bytes: 526_000_000,
  notes: 'Seeded from the Mac dev stack', source_created_at: '2026-10-04T11:00:00Z',
  created_at: '2026-10-04T11:30:00Z', created_by_name: 'Jimmy Henderson', deployment_id: null,
};
export const SNAP_TAKING: Snapshot = {
  ...SNAP, id: 's2', name: 'uat-2026-10-04', origin: 'environment', source: 'uat', status: 'pending',
  alembic_revision: null, size_bytes: null, checksum: null, object_count: null, object_bytes: null, notes: '',
  source_created_at: null, created_at: '2026-10-04T12:00:00Z', deployment_id: 'd9',
};
export const BACKUPS: Backup[] = [
  { name: '20261004T010203Z.dump', size_bytes: 2_097_152, modified_at: '2026-10-04T01:02:03Z' },
  { name: '20261003T130500Z.dump', size_bytes: 1_048_576, modified_at: '2026-10-03T13:05:00Z' },
];

export function summary(d: Deployment): DeploymentSummary {
  return {
    id: d.id, mode: d.mode, git_ref: d.git_ref, sha: d.sha, status: d.status, start_step: d.start_step,
    retry_of: d.retry_of, failed_step: d.failed_step, dump_path: d.dump_path, snapshot: d.snapshot,
    restore_dump: d.restore_dump, rollback_available: d.rollback_available, previous_sha: d.previous_sha,
    error: d.error, actor_name: d.actor_name, started_at: d.started_at, finished_at: d.finished_at,
    created_at: d.created_at,
  };
}

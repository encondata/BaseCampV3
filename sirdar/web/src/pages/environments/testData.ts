/** Fixtures shaped like the /api/deploy environment and deployment endpoints. */
import type {
  Backup, Deployment, DeploymentStatus, DeploymentStep, DeploymentSummary, DeployTarget, EnvVm, Environment,
  EnvironmentDefaults, EnvService, IntegrationCheck, Integrations, PublishPlan, Snapshot, StepStatus, TlsCertificate,
  VmSnapshot,
} from '../../lib/sirdarApi';

export const SHA = `e73b99ca${'1'.repeat(32)}`;
export const NEW_SHA = `f00dbabe${'2'.repeat(32)}`;

const svc = (service: string, port: number): EnvService => ({
  service, host_ip: '10.10.48.63', port, proxied: false,
  hostname: service === 'mailpit' ? null : `${service}.uat.serversherpa.com`,
});

export const ADOPTED: DeploymentSummary = {
  id: 'd0', mode: 'adopt', git_ref: 'main', sha: SHA, status: 'adopted', start_step: 1, retry_of: null,
  failed_step: null, dump_path: null, snapshot: null, restore_dump: null, rollback_available: false, publish: false,
  vm: false, take_vm_snapshot: false, vm_snapshot: null,
  previous_sha: null, error: null, actor_name: 'Jimmy Henderson',
  started_at: '2026-10-03T12:00:00Z', finished_at: '2026-10-03T12:00:00Z', created_at: '2026-10-03T12:00:00Z',
};

export const ENV: Environment = {
  id: 'e1', name: 'uat', type: 'dev', target: 'ssh:lab', target_kind: 'ssh', vm: null,
  base_domain: 'uat.serversherpa.com',
  env_dir: '/opt/serversherpa/uat', git_ref: 'main', current_sha: SHA, image_tag: 'e73b99ca',
  status: 'ready', proxy_ip: '10.10.48.6', bind_ip: '0.0.0.0', keep_dumps: 5,
  spaces_bucket: 'serversherpa', log_level: 'INFO',
  services: [svc('api', 8000), svc('portal', 8091), svc('kiosk', 8090), svc('wiki', 8096),
             svc('spaces', 9000), svc('status', 8095), svc('mailpit', 8025)],
  secrets_set: { SS_ANTHROPIC_API_KEY: true, SS_DB_TESTING_PASSWORD: false },
  seed_snapshot: null, publish: false, managed_records: [],
  last_deployment: ADOPTED, created_at: '2026-10-03T12:00:00Z', updated_at: '2026-10-03T12:00:00Z',
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
  vm: { cores: 4, memory_mb: 8192, disk_gb: 64, keep_snapshots: 3,
        limits: { cores: [1, 64], memory_mb: [2048, 262144], disk_gb: [20, 4096], keep_snapshots: [1, 10] } },
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
    dump_path: null, snapshot: null, restore_dump: null, rollback_available: false, publish: false,
    vm: false, take_vm_snapshot: false, vm_snapshot: null,
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
  { name: '20261004T010203Z.dump', size_bytes: 2_097_152, modified_at: '2026-10-04T01:02:03Z', restorable: true, reason: null },
  { name: '20261003T130500Z.dump', size_bytes: 1_048_576, modified_at: '2026-10-03T13:05:00Z', restorable: true, reason: null },
];
export const KEYS_CHANGED_REASON = 'Taken before the sign-in keys changed (snapshot restore on 2026-10-03 20:00 UTC).';
/** A dump made under the old sign-in keys, before a snapshot restore. */
export const BLOCKED_BACKUP: Backup = {
  name: '20261002T090000Z.dump', size_bytes: 524_288, modified_at: '2026-10-02T09:00:00Z',
  restorable: false, reason: KEYS_CHANGED_REASON,
};

export function summary(d: Deployment): DeploymentSummary {
  return {
    id: d.id, mode: d.mode, git_ref: d.git_ref, sha: d.sha, status: d.status, start_step: d.start_step,
    retry_of: d.retry_of, failed_step: d.failed_step, dump_path: d.dump_path, snapshot: d.snapshot,
    restore_dump: d.restore_dump, rollback_available: d.rollback_available, publish: d.publish,
    vm: d.vm, take_vm_snapshot: d.take_vm_snapshot, vm_snapshot: d.vm_snapshot,
    previous_sha: d.previous_sha,
    error: d.error, actor_name: d.actor_name, started_at: d.started_at, finished_at: d.finished_at,
    created_at: d.created_at,
  };
}

export const INTEGRATIONS: Integrations = {
  secrets_key_configured: true,
  cloudflare: { configured: true, zone: 'serversherpa.com', public_ip: '203.0.113.7', token_set: true,
                updated_at: '2026-10-04T15:00:00Z', updated_by_name: 'Jimmy Henderson' },
  npm: { configured: true, url: 'http://10.10.48.6:81', identity: 'admin@example.com',
         letsencrypt_email: 'admin@example.com', password_set: true,
         updated_at: '2026-10-04T15:05:00Z', updated_by_name: 'Jimmy Henderson' },
  proxmox: { configured: true, url: 'https://10.10.48.5:8006', node: 'pve', pool: 'sirdar', storage: 'local-lvm',
             bridge: 'vmbr0', vlan_tag: null, template_vmid: 9000,
             tls_fingerprint: fingerprint(7),
             token_id: 'sirdar@pve!sirdar', token_set: true,
             updated_at: '2026-10-04T16:00:00Z', updated_by_name: 'Jimmy Henderson' },
  esxi: { configured: true, url: 'https://10.10.48.10', user: 'sirdar', datastore: 'datastore1', network: 'VM Network',
          resource_pool: null, source_vm: 'sirdar-ubuntu-2404-seed', dns_servers: [],
          tls_fingerprint: fingerprint(11), password_set: true,
          updated_at: '2026-10-05T15:00:00Z', updated_by_name: 'Jimmy Henderson' },
};
export const NO_INTEGRATIONS: Integrations = {
  secrets_key_configured: true,
  cloudflare: { configured: false, zone: null, public_ip: null, token_set: false, updated_at: null, updated_by_name: null },
  npm: { configured: false, url: null, identity: null, letsencrypt_email: null, password_set: false,
         updated_at: null, updated_by_name: null },
  proxmox: { configured: false, url: null, node: null, pool: null, storage: null, bridge: null, vlan_tag: null,
             template_vmid: null, tls_fingerprint: null, token_id: null, token_set: false, updated_at: null,
             updated_by_name: null },
  esxi: { configured: false, url: null, user: null, datastore: null, network: null, resource_pool: null,
          source_vm: null, dns_servers: [], tls_fingerprint: null, password_set: false, updated_at: null,
          updated_by_name: null },
};
export const CF_CHECK: IntegrationCheck = {
  ok: true, target: 'cloudflare',
  checks: [
    { label: 'Zone', status: 'pass', value: 'serversherpa.com (zone-1)' },
    { label: 'DNS records', status: 'pass', value: '40 records, 31 A' },
    { label: 'Public IP', status: 'pass', value: '203.0.113.7 · 12 A records point at it' },
  ],
  facts: { zone: 'serversherpa.com', zone_id: 'zone-1' },
};
/** uat as the Publish tab sees it: api made by hand, portal Sirdar's, kiosk blocked. */
export const PUBLISH_PLAN: PublishPlan = {
  publish: false, proxy_ip: '10.10.48.6',
  cloudflare: { configured: true, zone: 'serversherpa.com', public_ip: '203.0.113.7', error: null },
  npm: { configured: true, url: 'http://10.10.48.6:81', error: null },
  services: [
    { service: 'api', hostname: 'api.uat.serversherpa.com', forward: '10.10.48.63:8000',
      dns: { state: 'claimable', detail: 'A 203.0.113.7, made outside Sirdar.', origin: null, record_id: 'rec-1' },
      proxy: { state: 'claimable', detail: 'To 10.10.48.63:8000, made outside Sirdar.', origin: null, host_id: 4 },
      certificate: { state: 'ok', detail: 'Valid until 2026-12-03.', expires_on: '2026-12-03T10:00:00Z' } },
    { service: 'portal', hostname: 'portal.uat.serversherpa.com', forward: '10.10.48.63:8091',
      dns: { state: 'ok', detail: 'A 203.0.113.7', origin: 'created', record_id: 'rec-2' },
      proxy: { state: 'ok', detail: 'To 10.10.48.63:8091', origin: 'created', host_id: 5 },
      certificate: { state: 'ok', detail: 'Valid until 2026-12-20.', expires_on: '2026-12-20T10:00:00Z' } },
    { service: 'kiosk', hostname: 'kiosk.uat.serversherpa.com', forward: '10.10.48.63:8090',
      dns: { state: 'conflict', detail: 'A CNAME record already uses this name.', origin: null, record_id: null },
      proxy: { state: 'create', detail: 'Sirdar will create a proxy host to 10.10.48.63:8090.', origin: null, host_id: null },
      certificate: { state: 'create', detail: "Sirdar will request a Let's Encrypt certificate.", expires_on: null } },
  ],
  stale: [],
};
export const PUBLISHED_ENV: Environment = {
  ...ENV, publish: true,
  managed_records: [
    { service: 'api', kind: 'dns_record', name: 'api.uat.serversherpa.com', origin: 'claimed' },
    { service: 'portal', kind: 'certificate', name: 'portal.uat.serversherpa.com', origin: 'created' },
    { service: 'portal', kind: 'dns_record', name: 'portal.uat.serversherpa.com', origin: 'created' },
    { service: 'portal', kind: 'proxy_host', name: 'portal.uat.serversherpa.com', origin: 'created' },
  ],
};
const PUBLISH_STEPS: [number, string, string][] = [
  [12, 'dns', 'DNS records'], [13, 'proxy', 'Proxy hosts'], [14, 'smoke', 'Smoke test'],
];
const TEARDOWN_STEPS: [number, string, string][] = [
  [15, 'teardown', 'Remove environment'], [16, 'unproxy', 'Remove proxy hosts'], [17, 'undns', 'Remove DNS records'],
];
const STARTING: StepStatus[] = ['running', 'pending', 'pending'];
export const PUBLISHING = deployment('running', STARTING, {}, {
  id: 'd8', mode: 'publish', sha: SHA, start_step: 12, steps: steps(PUBLISH_STEPS, STARTING, {}),
});
export const TEARDOWN = deployment('running', STARTING, {}, {
  id: 'd7', mode: 'teardown', sha: '', start_step: 15, steps: steps(TEARDOWN_STEPS, STARTING, {}),
});

/* ---- Proxmox (phase 5) ---- */
/** A made-up SHA-256 fingerprint in Proxmox's format: 32 hex pairs, AB:CD:… (95 characters). */
function fingerprint(seed: number): string {
  return Array.from({ length: 32 }, (_, i) => ((i * seed + 17) % 256).toString(16).toUpperCase().padStart(2, '0'))
    .join(':');
}
export const PX_FINGERPRINT = INTEGRATIONS.proxmox.tls_fingerprint!;
/** What tls_untrusted describes: a new server's certificate. */
export const PX_CERT: TlsCertificate = {
  fingerprint: fingerprint(13),
  subject: 'pve.lab', issuer: 'Proxmox Virtual Environment', not_after: '2027-10-04T00:00:00+00:00',
  names: ['pve', 'pve.lab', '10.10.48.5'],
};
export const PX_TOKEN = 'sirdar@pve!sirdar=1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d';
export const PX_CHECK: IntegrationCheck = {
  ok: true, target: 'proxmox',
  checks: [
    { label: 'Proxmox', status: 'pass', value: 'Version 9.0.10' },
    { label: 'Node', status: 'pass', value: 'pve' },
    { label: 'Pool', status: 'pass', value: 'sirdar · 1 VMs' },
    { label: 'Template', status: 'pass', value: 'ubuntu-2404-template (9000)' },
    { label: 'Storage', status: 'pass', value: 'local-lvm · 500 GB free' },
    { label: 'Bridge', status: 'pass', value: 'vmbr0' },
  ],
  facts: { url: 'https://10.10.48.5:8006', node: 'pve', version: '9.0.10', token_id: 'sirdar@pve!sirdar' },
};
export const PX_TARGETS = {
  ...TARGETS,
  targets: [...TARGETS.targets,
            { id: 'proxmox', label: 'Proxmox', kind: 'proxmox', available: true, configured: true } as DeployTarget],
};
export const PX_VM: EnvVm = {
  kind: 'proxmox', stage: 'built', name: 'ss-uat3', host: 'pve', node: 'pve', vmid: 120, moref: null, cores: 4, memory_mb: 8192, disk_gb: 64, ip_mode: 'static',
  ip_cidr: '10.10.48.70/24', gateway: '10.10.48.1', ip: '10.10.48.70', keep_snapshots: 3, created: true,
};
/** uat3 on Proxmox, deployed. */
export const PX_ENV: Environment = {
  ...ENV, id: 'e3', name: 'uat3', target: 'proxmox', target_kind: 'proxmox', vm: PX_VM,
  base_domain: 'uat3.serversherpa.com', env_dir: '/opt/serversherpa/uat3', secrets_set: {},
  services: ENV.services.map((s) => ({
    ...s, host_ip: '10.10.48.70', hostname: s.hostname ? s.hostname.replace('.uat.', '.uat3.') : null })),
};
/** uat3 just created: no VM yet, never deployed. */
export const PX_NEW_ENV: Environment = {
  ...PX_ENV, status: 'new', current_sha: null, image_tag: null, last_deployment: null,
  vm: { ...PX_VM, vmid: null, ip: null, created: false, stage: 'none' },
};
export const VM_SNAPSHOTS: VmSnapshot[] = [
  { name: 'sirdar-20261004T120000Z', taken_at: '2026-10-04T12:00:00Z', sha: SHA, deployment_id: 'd10',
    description: 'Sirdar: before update of uat3', restorable: true, reason: null },
  { name: 'sirdar-20261002T080000Z', taken_at: '2026-10-02T08:00:00Z', sha: NEW_SHA, deployment_id: 'd9',
    description: 'Sirdar: before reset of uat3', restorable: false, reason: KEYS_CHANGED_REASON },
];
const VM_UPDATE_PLAN: [number, string, string][] = [[0, 'provision', 'Prepare VM'], ...UPDATE_PLAN];
const VM_UP_FAILED: StepStatus[] = [
  'succeeded', 'succeeded', 'succeeded', 'succeeded', 'succeeded', 'succeeded', 'succeeded', 'failed'];
/** A failed Update of uat3 whose step 0 took a VM snapshot (and that can also roll back its dump). */
export const VM_ROLLBACKABLE = deployment('failed', VM_UP_FAILED, { 10: 'migrate exited 1\n' }, {
  id: 'd11', environment: 'uat3', vm: true, take_vm_snapshot: true, vm_snapshot: 'sirdar-20261004T120000Z',
  failed_step: 10, error: 'Step 10 (Start services) failed. See its log.',
  dump_path: '/opt/serversherpa/uat3/backups/20261004T120500Z.dump', rollback_available: true,
  steps: steps(VM_UPDATE_PLAN, VM_UP_FAILED, { 10: 'migrate exited 1\n' }),
});

/* ---- VMware ESXi (phase 6) ---- */
export const ESXI_FINGERPRINT = INTEGRATIONS.esxi.tls_fingerprint!;
/** What tls_untrusted describes for an ESXi host: its default certificate names only its host name. */
export const ESXI_CERT: TlsCertificate = {
  fingerprint: fingerprint(19), subject: 'localhost.localdomain', issuer: 'localhost.localdomain',
  not_after: '2030-01-01T00:00:00+00:00', names: ['localhost.localdomain'],
};
export const ESXI_PASSWORD = 'esxi-PASSWORD-s3cr3t!';
export const ESXI_CHECK: IntegrationCheck = {
  ok: true, target: 'esxi',
  checks: [
    { label: 'ESXi', status: 'pass', value: 'VMware ESXi 7.0.3 build-21930508' },
    { label: 'License', status: 'pass', value: 'esx.enterprisePlus.cpuPackage' },
    { label: 'Datastore', status: 'pass', value: 'datastore1 · 800 GB free' },
    { label: 'Network', status: 'pass', value: 'VM Network' },
    { label: 'Resource pool', status: 'pass', value: "The host's root pool" },
    { label: 'Seed VM', status: 'pass',
      value: 'sirdar-ubuntu-2404-seed · [datastore1] sirdar-ubuntu-2404-seed/sirdar-ubuntu-2404-seed.vmdk · 3 GB' },
  ],
  facts: { url: 'https://10.10.48.10', version: '7.0.3', build: '21930508', user: 'sirdar' },
};
export const ESXI_TARGETS = {
  ...TARGETS,
  targets: [...TARGETS.targets,
            { id: 'esxi', label: 'VMware ESXi', kind: 'esxi', available: true, configured: true } as DeployTarget],
};
export const ESXI_VM: EnvVm = {
  kind: 'esxi', stage: 'built', name: 'ss-uat3', host: '10.10.48.10', node: null, vmid: null, moref: '12',
  cores: 4, memory_mb: 8192, disk_gb: 64, ip_mode: 'static', ip_cidr: '10.10.48.71/24', gateway: '10.10.48.1',
  ip: '10.10.48.71', keep_snapshots: 3, created: true,
};
/** uat3 on ESXi, deployed. */
export const ESXI_ENV: Environment = {
  ...PX_ENV, target: 'esxi', target_kind: 'esxi', vm: ESXI_VM,
  services: PX_ENV.services.map((s) => ({ ...s, host_ip: '10.10.48.71' })),
};
/** uat3 on ESXi just created: no VM yet, never deployed. */
export const ESXI_NEW_ENV: Environment = {
  ...ESXI_ENV, status: 'new', current_sha: null, image_tag: null, last_deployment: null,
  vm: { ...ESXI_VM, stage: 'none', moref: null, ip: null, created: false },
};

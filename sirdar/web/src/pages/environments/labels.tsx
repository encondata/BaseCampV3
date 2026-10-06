/** Labels, status chips and small helpers shared by the environment pages. */
import type {
  DeployTarget, DeploymentStep, DeploymentSummary, EnvVm, Environment, Snapshot, VmHostKind,
} from '../../lib/sirdarApi';

/** status → [chip class, label] */
type ChipMap = Record<string, [string, string]>;

export const ENV_STATUS: ChipMap = {
  new: ['tag', 'New'], ready: ['c-green', 'Ready'], deploying: ['c-blue', 'Deploying'], failed: ['c-red', 'Failed'],
  deleting: ['c-amber', 'Deleting'],
};
/** A deployment is running: the environment is deploying or deleting, or its
 *  latest deployment is still running (a publish or snapshot job leaves the
 *  environment's status as it was). The API refuses changes meanwhile. */
export const deploymentRunning = (env: Environment) =>
  env.status === 'deploying' || env.status === 'deleting' || env.last_deployment?.status === 'running';

export const DEPLOYMENT_STATUS: ChipMap = {
  running: ['c-blue', 'Running'], succeeded: ['c-green', 'Succeeded'], failed: ['c-red', 'Failed'],
  cancelled: ['c-amber', 'Canceled'], interrupted: ['c-amber', 'Interrupted'], adopted: ['tag', 'Adopted'],
};
export const STEP_STATUS: ChipMap = {
  pending: ['tag', 'Pending'], running: ['c-blue', 'Running'], succeeded: ['c-green', 'Done'],
  failed: ['c-red', 'Failed'], skipped: ['tag', 'Skipped'], not_run: ['tag', 'Not run'],
  cancelled: ['c-amber', 'Canceled'], interrupted: ['c-amber', 'Interrupted'],
};
export const TYPE_LABEL: Record<string, string> = { dev: 'Dev', beta: 'Beta', custom: 'Custom', production: 'Production' };
export const MODE_LABEL: Record<string, string> = {
  update: 'Update', reset: 'Reset data', adopt: 'Adopt', snapshot: 'Take snapshot',
  restore_dump: 'Restore backup', rollback: 'Roll back', publish: 'Publish', teardown: 'Delete environment',
  vm_restore: 'Restore VM snapshot', activate: 'Activate', renew: 'Renew certificate',
};
/** A Publish tab entry's state (the API's PublishPlan). */
export const PUBLISH_STATE: ChipMap = {
  ok: ['c-green', 'Up to date'], update: ['c-blue', 'Will update'], create: ['tag', 'Will create'],
  claimable: ['c-amber', "Not Sirdar's"], conflict: ['c-red', 'Blocked'], unknown: ['tag', 'Unknown'],
};
export const CERT_STATE: ChipMap = {
  ok: ['c-green', 'Valid'], update: ['c-blue', 'Will update'], create: ['tag', 'Will request'], unknown: ['tag', 'Unknown'],
};
export const SNAPSHOT_STATUS: ChipMap = {
  pending: ['c-blue', 'Taking'], ready: ['c-green', 'Ready'], failed: ['c-red', 'Failed'],
};
/** Deployment statuses the API retries (pipeline.RETRYABLE_STATUSES). */
export const RETRYABLE = ['failed', 'cancelled', 'interrupted'];
/** Modes that replace data: they need deploy:change and the environment's name typed back
 *  (the API's GATED_MODES). A snapshot job is never retried. */
export const GATED_MODES = ['reset', 'restore_dump', 'rollback', 'teardown', 'vm_restore'];
/** Modes that need deploy:change (the API's CHANGE_MODES). */
export const CHANGE_MODES = [...GATED_MODES, 'activate'];
export const RETRY_MODES = ['update', 'reset', 'restore_dump', 'rollback', 'publish', 'teardown', 'vm_restore',
  'activate', 'renew'];
/** Modes a DigitalOcean environment doesn't offer: both slots share the managed database. */
export const NOT_ON_DO = ['reset', 'restore_dump', 'rollback', 'vm_restore'];

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

/** A time for people to read; "—" when it's missing or not a date. */
export function when(iso: string | null | undefined): string {
  const at = iso ? new Date(iso) : null;
  return at && !Number.isNaN(at.getTime()) ? at.toLocaleString() : '—';
}
/** The file name at the end of a dump path. */
export const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
/** A pre-deploy dump is named for its UTC time, `YYYYMMDDTHHMMSSZ.dump`;
 *  that time as ISO, or null for any other name. */
export function dumpTakenAt(path: string | null | undefined): string | null {
  const m = path ? /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.dump$/.exec(baseName(path)) : null;
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : null;
}
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

export const VM_HOST_LABEL: Record<VmHostKind, string> = { proxmox: 'Proxmox', esxi: 'ESXi' };

/** A target whose host is a VM Sirdar builds. */
export const isVmTarget = (id: string) => id === 'proxmox' || id === 'esxi';

/** Targets a new environment can use: configured SSH targets, then the VM hosts and DigitalOcean once set up. */
export const envTargets = (targets: DeployTarget[]) =>
  [...sshTargets(targets),
   ...targets.filter((t) => (isVmTarget(t.id) || isDoTarget(t.id)) && t.available && t.configured)];

/** Its host is a VM Sirdar builds, on Proxmox or ESXi. */
export const onVmHost = (env: Environment) => env.target_kind === 'proxmox' || env.target_kind === 'esxi';
/** Its host is a VM Sirdar builds on Proxmox. */
export const onProxmox = (env: Environment) => env.target_kind === 'proxmox';
/** "Proxmox" or "ESXi" for a VM environment. */
/** ESXi can't grow a disk that has snapshots: step 0 deletes Sirdar's first,
 *  so a grow has no snapshot from before it, only one taken after. */
export const ESXI_GROW_NOTE = '(but on ESXi a disk grow replaces the snapshots, with a new one taken after the grow)';
export const hostLabel = (env: Environment) => (env.target_kind === 'esxi' ? 'ESXi' : 'Proxmox');

type StageOf = Pick<EnvVm, 'created' | 'vmid'> & Partial<Pick<EnvVm, 'stage'>>;
// none: no VM yet. partial: one exists (or an id is reserved) but the first build didn't finish. built.
export const vmStage = (vm: StageOf): 'none' | 'partial' | 'built' =>
  vm.stage ?? (vm.vmid === null ? 'none' : vm.created ? 'built' : 'partial');
/** Sirdar built the VM (an id reserved, or a VM half built, is not a VM yet). */
export const vmBuilt = (vm: StageOf) => vmStage(vm) === 'built';
/** "VM 120" (Proxmox) or "VM 12" (ESXi's managed object id); null before one exists. */
export const vmRef = (vm: Pick<EnvVm, 'vmid' | 'moref'>) =>
  vm.vmid !== null ? `VM ${vm.vmid}` : vm.moref ? `VM ${vm.moref}` : null;

/** Memory in GB as typed and shown (one decimal at most), and back to MB. */
export const gbOf = (mb: number) => String(Math.round((mb / 1024) * 10) / 10);
export const mbOf = (gb: string) => Math.round(Number(gb) * 1024);

/** "4 vCPU · 8 GB · 64 GB disk" */
export const vmSize = (vm: Pick<EnvVm, 'cores' | 'memory_mb' | 'disk_gb'>) =>
  `${vm.cores} vCPU · ${Math.round((vm.memory_mb / 1024) * 10) / 10} GB · ${vm.disk_gb} GB disk`;

/** "10.10.48.70/24 via 10.10.48.1", or "DHCP"; never "null" for a missing part. */
export const vmNetwork = (vm: Pick<EnvVm, 'ip_mode' | 'ip_cidr' | 'gateway'>) => {
  if (vm.ip_mode !== 'static') return 'DHCP';
  if (!vm.ip_cidr) return 'Static, no address yet';
  return vm.gateway ? `${vm.ip_cidr} via ${vm.gateway}` : vm.ip_cidr;
};

/** Its hosts are droplets Sirdar builds in a DigitalOcean account. */
export const onDo = (env: Pick<Environment, 'target_kind'>) => env.target_kind === 'digitalocean';
export const isDoTarget = (id: string) => id === 'digitalocean';
export const slotTitle = (slot: string | null | undefined) => (slot ? slot[0].toUpperCase() + slot.slice(1) : '');
/** The slot an Update deploys to (the API's do_envs.target_slot). */
export const idleSlot = (env: Pick<Environment, 'slots' | 'active_slot'>): string =>
  env.active_slot === null || env.slots.length < 2 ? env.slots[0]
    : env.slots.find((s) => s !== env.active_slot) ?? env.slots[0];
/** Whether an Update of `slot` goes live by itself (the API's do_envs.goes_live). */
export const goesLive = (env: Pick<Environment, 'slots' | 'active_slot' | 'auto_activate' | 'type'>, slot: string) =>
  env.active_slot === null || env.slots.length === 1 || env.active_slot === slot
  || (env.auto_activate && env.type !== 'production');
/** Whole days until a certificate expires; null without one. */
export function certDaysLeft(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : Math.floor((at - now) / 86_400_000);
}
/** "Update to Purple, not live", "Activate Green", "Deactivate", else the mode's label. */
export function deploymentLabel(d: Pick<DeploymentSummary, 'mode' | 'cloud' | 'slot' | 'go_live'>): string {
  if (d.mode === 'activate') return d.slot ? `Activate ${slotTitle(d.slot)}` : 'Deactivate';
  if (d.cloud && d.mode === 'update' && d.slot) return `Update to ${slotTitle(d.slot)}${d.go_live ? '' : ', not live'}`;
  return MODE_LABEL[d.mode] ?? d.mode;
}
/** A retry needs the environment's name typed: the modes that replace data, and production's Activate. */
export const retryNeedsName = (mode: string, env: Pick<Environment, 'type'>) =>
  GATED_MODES.includes(mode) || (mode === 'activate' && env.type === 'production');
/** What Delete removes on DigitalOcean, by do_resources kind. */
export const DO_RESOURCE_LABEL: Record<string, string> = {
  vpc: 'VPC', droplet: 'Droplet', database: 'Database', spaces_key: 'Spaces key', bucket: 'Bucket',
  certificate: 'Certificate', load_balancer: 'Load balancer', firewall: 'Cloud firewall',
};

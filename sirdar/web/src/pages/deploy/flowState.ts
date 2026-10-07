/** The Deploy page's step-by-step flow (spec 2026-10-07 §1): its state, each
 *  step's checks (the API's rules mirrored so a step can answer before a
 *  round trip; the API stays the authority), the create body, the traffic
 *  plan, and which step an API error belongs to. Pure: no React, no I/O. */
import { ipv4Problem, nameProblem, refProblem } from '../../lib/envRules';
import type {
  DeployTarget, DoAccount, DoAccountKey, EnvType, EnvironmentDefaults, Integrations, NewEnvironmentBody, Snapshot,
} from '../../lib/sirdarApi';
import { gbOf, isDoTarget, isVmTarget, mbOf, sshTargets } from '../environments/labels';

export type FlowStep = 'environment' | 'servers' | 'target' | 'extras' | 'traffic' | 'data' | 'review';
export const FLOW_STEPS: [FlowStep, string][] = [
  ['environment', 'Environment'], ['servers', 'Servers'], ['target', 'Target'], ['extras', 'Extras'],
  ['traffic', 'Traffic'], ['data', 'Data'], ['review', 'Review & Deploy'],
];
export const STEP_HINT: Record<FlowStep, string> = {
  environment: 'A new environment: its type and name.',
  servers: 'One server, or two (Blue/Green) with traffic moved between them by Activate.',
  target: 'Where Sirdar builds it, and that target\'s details.',
  extras: 'Optional apps, hosting options and integrations.',
  traffic: 'What will route traffic to the environment. Nothing to choose here.',
  data: 'Seed it from a snapshot, or start empty with a first super admin.',
  review: 'Every choice. Deploy creates the environment and starts its first deployment.',
};
export const KINDS: EnvType[] = ['production', 'dev', 'beta', 'custom'];
export const KIND_LABEL: Record<EnvType, string> = {
  production: 'Production', dev: 'Development', beta: 'UAT', custom: 'Custom',
};
/** The connection test's type for an environment type (routes/deploy.py DeployType). */
export const CONNECT_TYPE: Record<EnvType, 'blue' | 'dev' | 'beta' | 'custom'> = {
  production: 'blue', dev: 'dev', beta: 'beta', custom: 'custom',
};
export type Servers = 'single' | 'bluegreen';
export type OptionalApp = 'wiki' | 'kiosk' | 'status' | 'mailpit';
export const OPTIONAL_APPS: [OptionalApp, string][] = [
  ['wiki', 'Wiki'], ['kiosk', 'Kiosk'], ['status', 'Status page'], ['mailpit', 'Mailpit'],
];
export type TargetKind = 'esxi' | 'proxmox' | 'digitalocean' | 'ssh';
export const targetKind = (id: string): TargetKind | null =>
  (isVmTarget(id) ? (id as 'esxi' | 'proxmox') : isDoTarget(id) ? 'digitalocean'
    : id === 'ssh' || id.startsWith('ssh:') ? 'ssh' : null);

export interface FlowState {
  type: EnvType; name: string; gitRef: string; baseDomain: string;
  servers: Servers;
  target: string;
  /** LAN (VM or SSH): Nginx Proxy Manager's address, and where the ports bind. */
  proxyIp: string; bindIp: string;
  /** VM sizes (app VMs on Blue/Green) and the network: ipCidr is the VM's, or orange's. */
  cores: string; memoryGb: string; diskGb: string;
  ipMode: 'static' | 'dhcp'; ipCidr: string; gateway: string;
  purpleIpCidr: string; dataIpCidr: string; dataCores: string; dataMemoryGb: string; dataDiskGb: string;
  doAccount: DoAccountKey; dropletSize: string; dbSize: string; dbStandby: boolean; acmeStaging: boolean;
  autoActivate: boolean;
  publish: boolean;
  apps: Record<OptionalApp, boolean>;
  mailMode: 'mailpit' | 'smtp'; smtpHost: string; smtpPort: string; smtpUsername: string; smtpPassword: string;
  smtpFrom: string; smtpStarttls: boolean;
  aiKey: string;
  dataMode: 'empty' | 'snapshot'; snapshotId: string;
  adminFirst: string; adminLast: string; adminEmail: string; adminPasswordMode: 'typed' | 'invite';
  adminPassword: string; adminConfirm: string;
}
export interface FlowContext {
  targets: DeployTarget[];
  defaults: EnvironmentDefaults & { first_admin: { password_min_length: number; role: string; link_minutes: number } };
  integrations: Integrations | null;
  accounts: DoAccount[];
  snapshots: Snapshot[];
}

const npmHost = (i: Integrations | null): string => {
  if (!i?.npm.url) return '';
  try { return new URL(i.npm.url).hostname; } catch { return ''; }
};

export function initialState(ctx: FlowContext): FlowState {
  const d = ctx.defaults;
  const account = ctx.accounts.find((a) => a.configured && a.key === 'development')?.key
    ?? ctx.accounts.find((a) => a.configured)?.key ?? 'development';
  return {
    type: 'dev', name: '', gitRef: d.git_ref, baseDomain: '',
    servers: 'single', target: '',
    proxyIp: npmHost(ctx.integrations), bindIp: d.bind_ip,
    cores: String(d.vm.cores), memoryGb: gbOf(d.vm.memory_mb), diskGb: String(d.vm.disk_gb),
    ipMode: 'static', ipCidr: '', gateway: '', purpleIpCidr: '', dataIpCidr: '',
    dataCores: String(d.vm.cores), dataMemoryGb: gbOf(d.vm.memory_mb), dataDiskGb: String(d.vm.disk_gb),
    doAccount: account, dropletSize: d.do.droplet_size, dbSize: d.do.db_size, dbStandby: d.do.db_standby,
    acmeStaging: false, autoActivate: false,
    publish: !!(ctx.integrations?.cloudflare.configured && ctx.integrations?.npm.configured),
    apps: { wiki: true, kiosk: true, status: true, mailpit: true },
    mailMode: 'mailpit', smtpHost: '', smtpPort: String(d.mail.smtp_port), smtpUsername: '', smtpPassword: '',
    smtpFrom: '', smtpStarttls: true, aiKey: '',
    dataMode: 'empty', snapshotId: '',
    adminFirst: '', adminLast: '', adminEmail: '', adminPasswordMode: 'typed', adminPassword: '', adminConfirm: '',
  };
}

export interface TargetChoice { id: string; label: string; kind: TargetKind; ready: boolean; why: string }

/** Every target the flow can show for the type and servers chosen, with whether it can be picked now. */
export function targetChoices(s: FlowState, ctx: FlowContext): TargetChoice[] {
  const doReady = ctx.accounts.some((a) => a.configured && a.region);
  const npm = !!ctx.integrations?.npm.configured;
  const out: TargetChoice[] = [];
  if (s.type !== 'production') {
    for (const t of ctx.targets.filter((x) => isVmTarget(x.id))) {
      const ready = t.available && t.configured && (s.servers === 'single' || npm);
      out.push({ id: t.id, label: t.label, kind: t.id as 'esxi' | 'proxmox', ready,
                 why: ready ? '' : s.servers === 'bluegreen' && !npm
                   ? 'Blue/Green on the LAN needs Nginx Proxy Manager (Settings › Integrations).' : 'Not set up yet.' });
    }
  }
  out.push({ id: 'digitalocean', label: 'DigitalOcean', kind: 'digitalocean', ready: doReady,
             why: doReady ? '' : 'Set up a DigitalOcean account (token and region) in Settings › Integrations.' });
  if (s.type !== 'production' && s.servers === 'single') {
    for (const t of sshTargets(ctx.targets)) out.push({ id: t.id, label: t.label, kind: 'ssh', ready: true, why: '' });
  }
  return out;
}

/** The rules a choice imposes on the others (production lives on DigitalOcean with Blue and Green). */
export function withRules(s: FlowState, ctx: FlowContext): FlowState {
  let next = s;
  if (next.type === 'production') {
    const prodReady = ctx.accounts.find((a) => a.key === 'production')?.configured;
    next = { ...next, servers: 'bluegreen', autoActivate: false, acmeStaging: false,
             doAccount: prodReady ? 'production' : next.doAccount };
  }
  if (next.target && !targetChoices(next, ctx).some((t) => t.id === next.target)) next = { ...next, target: '' };
  if (next.servers === 'bluegreen' && next.ipMode === 'dhcp' && isVmTarget(next.target)) next = { ...next, ipMode: 'static' };
  return next;
}

export type Field = 'type' | 'name' | 'gitRef' | 'baseDomain' | 'servers' | 'target' | 'proxyIp' | 'bindIp'
  | 'machine' | 'cloud' | 'hosting' | 'publish' | 'apps' | 'mail' | 'aiKey' | 'data' | 'adminName' | 'adminEmail'
  | 'adminPassword' | 'form';
export type Errors = Partial<Record<Field, string>>;
const only = (e: Errors): Errors => Object.fromEntries(Object.entries(e).filter(([, v]) => v)) as Errors;

const CIDR_RE = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/;
const VM_IP_HELP = 'Use an address with its prefix, like 10.10.48.70/24.';
const VM_GATEWAY_HELP = "The gateway must be another address in the VM's network.";
const toInt = (ip: string) => ip.split('.').reduce((n, p) => n * 256 + Number(p), 0);
/** The API's check_network for a static address: '' when the API would accept it. */
export function vmNetworkProblem(cidr: string, gw: string): string {
  const m = CIDR_RE.exec(cidr.trim());
  const prefix = m ? Number(m[2]) : 0;
  if (!m || ipv4Problem(m[1], 'address') || prefix < 8 || prefix > 30) return VM_IP_HELP;
  const ip = toInt(m[1]);
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ip & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  const first = ip >>> 24;
  if (ip === network || ip === broadcast || first === 0 || first === 127 || first >= 224
      || (ip >>> 16) === 0xa9fe) return VM_IP_HELP;
  if (ipv4Problem(gw, 'gateway')) return VM_GATEWAY_HELP;
  const g = toInt(gw.trim());
  if (((g & mask) >>> 0) !== network || g === ip || g === network || g === broadcast) return VM_GATEWAY_HELP;
  return '';
}
/** A valid CIDR's network, like 10.10.48.0/24 (vms.check_bluegreen's vm_subnet_mismatch compares these). */
function networkOf(cidr: string): string {
  const [ip, prefix] = cidr.trim().split('/');
  const mask = (0xffffffff << (32 - Number(prefix))) >>> 0;
  return `${(toInt(ip) & mask) >>> 0}/${prefix}`;
}
const DROPLET_SIZE_RE = /^[a-z0-9][a-z0-9-]{2,39}$/;
const DB_SIZE_RE = /^db-[a-z0-9][a-z0-9-]{2,36}$/;
const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const EMAIL_RE = /^[^@\s]{1,64}@[^@\s]+\.[^@\s.]{2,}$/;
const USER_RE = /^[^\s"'$#`\\]{1,254}$/;
/** envfile.SECRET_VALUE_RE: what an optional secret in the .env may hold. */
const SECRET_RE = /^[A-Za-z0-9._~+/=:@%^*!?,;-]{1,1024}$/;
/** Control characters and line/paragraph separators (first_admins._clean refuses them). */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const SECRET_HELP = "can't be saved. Use letters, numbers and ._~+/=:@%^*!?,;- only, with no spaces or quotes.";

const whole = (raw: string) => (/^\d+$/.test(raw.trim()) ? Number(raw) : NaN);
const inRange = (n: number, [low, high]: [number, number]) => n >= low && n <= high;

function sizeProblem(cores: string, memoryGb: string, diskGb: string, ctx: FlowContext): string {
  const l = ctx.defaults.vm.limits;
  if (!inRange(whole(cores), l.cores)) return `Use ${l.cores[0]} to ${l.cores[1]} vCPUs.`;
  if (!/^\d+(\.\d)?$/.test(memoryGb.trim()) || !inRange(mbOf(memoryGb), l.memory_mb))
    return `Use ${gbOf(l.memory_mb[0])} to ${gbOf(l.memory_mb[1])} GB of memory.`;
  if (!inRange(whole(diskGb), l.disk_gb)) return `Use a disk of ${l.disk_gb[0]} to ${l.disk_gb[1]} GB.`;
  return '';
}

function machineProblem(s: FlowState, ctx: FlowContext): string {
  const sizes = sizeProblem(s.cores, s.memoryGb, s.diskGb, ctx);
  if (sizes) return sizes;
  if (s.servers === 'single') return s.ipMode === 'dhcp' ? '' : vmNetworkProblem(s.ipCidr, s.gateway);
  if (s.ipMode !== 'static') return 'Blue/Green needs a static address for each of the three VMs.';
  for (const cidr of [s.ipCidr, s.purpleIpCidr, s.dataIpCidr]) {
    const p = vmNetworkProblem(cidr, s.gateway);
    if (p) return p;
  }
  const data = sizeProblem(s.dataCores, s.dataMemoryGb, s.dataDiskGb, ctx);
  if (data) return `Data VM: ${data}`;
  if (new Set([s.ipCidr, s.purpleIpCidr, s.dataIpCidr].map(networkOf)).size !== 1)
    return 'The data VM and the two app VMs need addresses on the same network.';
  const ips = new Set([s.ipCidr, s.purpleIpCidr, s.dataIpCidr].map((c) => c.trim().split('/')[0]));
  return ips.size === 3 ? '' : 'The data VM and the two app VMs need three different addresses.';
}

export function stepErrors(step: FlowStep, s: FlowState, ctx: FlowContext): Errors {
  const kind = targetKind(s.target);
  switch (step) {
    case 'environment': {
      const name = s.name.trim();
      const prodBlocked = s.type === 'production' && !ctx.accounts.some((a) => a.configured);
      return only({
        name: name ? nameProblem(name) : 'Enter a name.',
        type: prodBlocked ? 'Production runs on DigitalOcean: set up a DigitalOcean account in Settings › Integrations first.' : '',
        gitRef: refProblem(s.gitRef),
        baseDomain: s.baseDomain.trim() && !DOMAIN_RE.test(s.baseDomain.trim().toLowerCase())
          ? "That domain isn't valid. Use a name like uat.serversherpa.com." : '',
      });
    }
    case 'target': {
      const choice = targetChoices(s, ctx).find((t) => t.id === s.target);
      if (!choice) return { target: 'Choose a target.' };
      if (!choice.ready) return { target: choice.why };
      if (kind === 'digitalocean') {
        const a = ctx.accounts.find((x) => x.key === s.doAccount);
        if (!a?.configured || !a.region) return { cloud: `Set up the ${a?.label ?? 'DigitalOcean'} account (token and region) in Settings › Integrations first.` };
        if (!DROPLET_SIZE_RE.test(s.dropletSize) || s.dropletSize.startsWith('db-')) return { cloud: "That isn't a DigitalOcean droplet size." };
        if (!DB_SIZE_RE.test(s.dbSize)) return { cloud: "That isn't a DigitalOcean database size." };
        return {};
      }
      return only({
        proxyIp: ipv4Problem(s.proxyIp, 'proxy IP'), bindIp: ipv4Problem(s.bindIp, 'bind IP'),
        machine: kind === 'esxi' || kind === 'proxmox' ? machineProblem(s, ctx) : '',
      });
    }
    case 'extras': {
      const errors: Errors = {};
      if (s.mailMode === 'mailpit' && !s.apps.mailpit)
        errors.apps = 'Mail goes to Mailpit unless SMTP is set up: turn Mailpit on, or choose SMTP.';
      if (s.mailMode === 'smtp') {
        const port = whole(s.smtpPort);
        errors.mail = !HOST_RE.test(s.smtpHost.trim()) ? "Enter the SMTP server's host name or address."
          : !inRange(port, [1, 65535]) ? 'Use an SMTP port from 1 to 65535.'
          : s.smtpUsername && !USER_RE.test(s.smtpUsername) ? "That SMTP user name can't be used: no spaces, quotes, $, # or backslashes."
          : s.smtpPassword && !SECRET_RE.test(s.smtpPassword) ? `That SMTP password ${SECRET_HELP}`
          : !EMAIL_RE.test(s.smtpFrom.trim()) ? 'Enter the address mail is sent from, like noreply@example.com.' : '';
      }
      if (s.aiKey && !SECRET_RE.test(s.aiKey)) errors.aiKey = `That key ${SECRET_HELP}`;
      return only(errors);
    }
    case 'data': {
      if (s.dataMode === 'snapshot') return s.snapshotId ? {} : { data: 'Choose a snapshot.' };
      const min = ctx.defaults.first_admin.password_min_length;
      const names = [s.adminFirst, s.adminLast].map((v) => v.trim());
      return only({
        // The first admin's email must not sit in Mailpit on production.
        data: s.type === 'production' && s.mailMode !== 'smtp'
          ? "On production the first admin's email goes out through SMTP: choose SMTP in Extras › Mail, or start from a snapshot." : '',
        adminName: names.some((n) => !n || n.length > 100 || CONTROL_RE.test(n))
          ? 'Enter a first and last name (up to 100 characters each).' : '',
        adminEmail: !EMAIL_RE.test(s.adminEmail.trim()) ? 'Enter a valid email address for the first admin.' : '',
        adminPassword: s.adminPasswordMode === 'invite' ? ''
          : !s.adminPassword.trim() || s.adminPassword.length < min ? `Use at least ${min} characters (ServerSherpa's password policy).`
          : CONTROL_RE.test(s.adminPassword) ? "The password can't contain line breaks or control characters."
          : s.adminPassword !== s.adminConfirm ? "The two passwords don't match." : '',
      });
    }
    default:
      return {};
  }
}

const ports = (ctx: FlowContext) => Object.fromEntries(ctx.defaults.services.map((sv) => [sv.service, sv.port]));

export function buildBody(s: FlowState, ctx: FlowContext): NewEnvironmentBody {
  const kind = targetKind(s.target);
  const production = s.type === 'production';
  const twoSlots = s.servers === 'bluegreen';
  const body: NewEnvironmentBody = {
    name: s.name.trim(), type: s.type, target: s.target, git_ref: s.gitRef.trim(),
    ...(s.baseDomain.trim() ? { base_domain: s.baseDomain.trim().toLowerCase() } : {}),
    ports: ports(ctx),
    apps: OPTIONAL_APPS.map(([a]) => a).filter((a) => s.apps[a]),
    mail: s.mailMode === 'smtp'
      ? { mode: 'smtp', host: s.smtpHost.trim(), port: Number(s.smtpPort), ...(s.smtpUsername ? { username: s.smtpUsername } : {}),
          ...(s.smtpPassword ? { password: s.smtpPassword } : {}), from_address: s.smtpFrom.trim(), starttls: s.smtpStarttls }
      : { mode: 'mailpit' },
    ...(s.aiKey ? { secrets: { SS_ANTHROPIC_API_KEY: s.aiKey } } : {}),
  };
  if (s.dataMode === 'snapshot') body.snapshot_id = s.snapshotId;
  else {
    body.first_admin = {
      first_name: s.adminFirst.trim(), last_name: s.adminLast.trim(), email: s.adminEmail.trim(),
      password_mode: s.adminPasswordMode, password: s.adminPasswordMode === 'typed' ? s.adminPassword : null,
    };
  }
  if (kind === 'digitalocean') {
    body.do = {
      account: s.doAccount, ...(production ? {} : { slots: twoSlots ? 2 : 1 }),
      droplet_size: s.dropletSize, db_size: s.dbSize, db_standby: s.dbStandby,
      ...(production ? {} : { acme_staging: s.acmeStaging }),
      ...(twoSlots && !production ? { auto_activate: s.autoActivate } : {}),
    };
    return body;
  }
  body.proxy_ip = s.proxyIp.trim();
  body.bind_ip = s.bindIp.trim();
  body.publish = s.publish;
  if (kind === 'esxi' || kind === 'proxmox') {
    const sizes = { cores: Number(s.cores), memory_mb: mbOf(s.memoryGb), disk_gb: Number(s.diskGb) };
    body.vm = twoSlots
      ? { ...sizes, ip_mode: 'static', ip_cidr: s.ipCidr.trim(), gateway: s.gateway.trim(), slots: 2,
          purple_ip_cidr: s.purpleIpCidr.trim(), data_ip_cidr: s.dataIpCidr.trim(),
          data: { cores: Number(s.dataCores), memory_mb: mbOf(s.dataMemoryGb), disk_gb: Number(s.dataDiskGb) },
          auto_activate: s.autoActivate }
      : { ...sizes, ip_mode: s.ipMode,
          ...(s.ipMode === 'static' ? { ip_cidr: s.ipCidr.trim(), gateway: s.gateway.trim() } : {}) };
  }
  return body;
}

/** API error code → the field (so the step) it belongs to; anything else stays on Review. */
export const CODE_FIELD: Record<string, Field> = {
  name_invalid: 'name', name_reserved: 'name', environment_exists: 'name', vm_name_invalid: 'name',
  vm_name_taken: 'name',
  type_invalid: 'type', production_exists: 'type',
  ref_invalid: 'gitRef', ref_not_found: 'gitRef', ref_lookup_failed: 'gitRef', base_domain_invalid: 'baseDomain', base_domain_not_in_zone: 'baseDomain',
  target_invalid: 'target', target_not_configured: 'target', integration_not_configured: 'target',
  vm_not_allowed: 'target', do_not_allowed: 'target', bluegreen_not_allowed: 'target',
  production_requires_digitalocean: 'target', integration_unreadable: 'target',
  proxy_ip_required: 'proxyIp', proxy_ip_invalid: 'proxyIp', bind_ip_invalid: 'bindIp',
  vm_invalid: 'machine', vm_cores_invalid: 'machine', vm_memory_invalid: 'machine', vm_disk_invalid: 'machine',
  vm_ip_mode_invalid: 'machine', vm_ip_invalid: 'machine', vm_gateway_invalid: 'machine', ip_in_use: 'machine',
  vm_static_required: 'machine', vm_ips_not_distinct: 'machine', vm_subnet_mismatch: 'machine', ssh_targets_unreadable: 'machine',
  dns_servers_invalid: 'machine',
  do_account_not_configured: 'cloud', do_invalid: 'cloud', do_slots_invalid: 'cloud', do_size_invalid: 'cloud',
  do_db_size_invalid: 'cloud', db_standby_size_invalid: 'cloud',
  auto_activate_not_allowed: 'hosting',
  apps_invalid: 'apps', mailpit_required: 'apps',
  mail_invalid: 'mail', smtp_host_invalid: 'mail', smtp_port_invalid: 'mail', smtp_username_invalid: 'mail',
  smtp_password_invalid: 'mail', smtp_from_invalid: 'mail', smtp_required_for_first_admin: 'mail',
  secret_invalid: 'aiKey', secret_not_editable: 'aiKey',
  snapshot_not_found: 'data', snapshot_not_ready: 'data', first_admin_with_seed: 'data', first_admin_invalid: 'data',
  first_admin_name_invalid: 'adminName', first_admin_email_invalid: 'adminEmail',
  first_admin_password_too_short: 'adminPassword', first_admin_password_invalid: 'adminPassword',
  first_admin_password_not_allowed: 'adminPassword',
};
export const FIELD_STEP: Record<Field, FlowStep> = {
  type: 'environment', name: 'environment', gitRef: 'environment', baseDomain: 'environment',
  servers: 'servers',
  target: 'target', proxyIp: 'target', bindIp: 'target', machine: 'target', cloud: 'target',
  hosting: 'extras', publish: 'extras', apps: 'extras', mail: 'extras', aiKey: 'extras',
  data: 'data', adminName: 'data', adminEmail: 'data', adminPassword: 'data',
  form: 'review',
};
export const stepOfCode = (code: string): FlowStep => FIELD_STEP[CODE_FIELD[code] ?? 'form'];

const ORDER = FLOW_STEPS.map(([s]) => s);
export const nextStep = (s: FlowStep): FlowStep => ORDER[Math.min(ORDER.indexOf(s) + 1, ORDER.length - 1)];
export const prevStep = (s: FlowStep): FlowStep => ORDER[Math.max(ORDER.indexOf(s) - 1, 0)];

export const effectiveDomain = (s: FlowState, ctx: FlowContext) =>
  s.baseDomain.trim().toLowerCase() || `${s.name.trim() || '<name>'}.${ctx.defaults.domain_suffix}`;

export interface TrafficRow { hostname: string; via: string; to: string }
/** What will route traffic, read-only (the Traffic step). */
export function trafficPlan(s: FlowState, ctx: FlowContext): { kind: 'load_balancer' | 'proxy'; rows: TrafficRow[] } {
  const domain = effectiveDomain(s, ctx);
  const kind = targetKind(s.target);
  const port = (svc: string) => ctx.defaults.services.find((x) => x.service === svc)?.port ?? 0;
  const publicApps = ctx.defaults.services.filter((x) => x.public)
    .map((x) => x.service).filter((svc) => !(svc in s.apps) || s.apps[svc as OptionalApp]);
  const ip = (cidr: string) => cidr.trim().split('/')[0];
  if (kind === 'digitalocean') {
    const first = s.type === 'production' ? 'Blue' : 'Orange';
    return { kind: 'load_balancer', rows: publicApps.filter((svc) => svc !== 'spaces').map((svc) => ({
      hostname: `${svc}.${domain}`, via: "The load balancer (HTTPS, Let's Encrypt)", to: `${first} droplet` })) };
  }
  const first = kind === 'ssh' ? "the SSH target's address"
    : s.ipMode === 'dhcp' && s.servers === 'single' ? "the VM's DHCP address" : ip(s.ipCidr) || 'the first VM';
  const via = `Nginx Proxy Manager${s.proxyIp ? ` (${s.proxyIp})` : ''}`;
  return { kind: 'proxy', rows: publicApps.map((svc) => ({
    hostname: `${svc}.${domain}`, via,
    to: svc === 'spaces' && s.servers === 'bluegreen' ? `${ip(s.dataIpCidr) || 'the data VM'}:${port(svc)}`
      : `${first}:${port(svc)}` })) };
}

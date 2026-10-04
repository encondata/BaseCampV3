/** Sirdar endpoints, through the portal's apiFetch (token refresh and
 *  session-ended handling come with it; VITE_API_URL=/api). */
import {
  ApiError, apiFetch, getProfileRequest, type AccessResourceOut, type EffectiveCell, type PersonDetail,
} from '@portal/lib/api';
import type { Action } from '@portal/lib/access';

/** /api/auth/me/profile — the portal's PersonDetail plus the sign-in email
 *  and where the account comes from (Sirdar can't provide avatar or badge). */
export interface SirdarProfile extends PersonDetail {
  login_email: string;
  source: 'portal' | 'local';
}
/** The portal client's getProfileRequest, typed with Sirdar's extra fields. */
export const getSirdarProfile = () => getProfileRequest() as Promise<SirdarProfile>;

export interface UserRow {
  person_id: string; display_name: string; email: string; source: 'portal' | 'local';
  roles: string[]; max_rank: number; totp_enrolled: boolean; totp_required: boolean;
  last_login_at: string | null; disabled_at: string | null; disabled_reason: string | null;
  last_imported_at: string | null;
}
export interface ImportRow {
  person_id: string | null; email: string; name: string;
  action: 'added' | 'updated' | 'unchanged' | 'disabled' | 'skipped';
  reason: string | null; roles: string[]; changes: string[];
}
export interface ImportRun {
  id: string; started_at: string; finished_at: string | null; trigger: string;
  status: 'running' | 'ok' | 'failed'; error: string | null; actor_name: string | null;
  added: number; updated: number; unchanged: number; disabled: number; skipped: number;
  rows: ImportRow[];
}
export interface SessionRow {
  id: string; family_id: string; created_at: string; expires_at: string;
  ip_address: string | null; user_agent: string | null;
}
export interface UserDetail {
  user: UserRow; first_name: string; last_name: string; preferred_name: string | null;
  job_title: string | null; cells: Record<string, Record<Action, EffectiveCell>>;
  overrides: Record<string, Partial<Record<Action, boolean>>>; sessions: SessionRow[];
  can_manage: boolean;
}
export interface SirdarRole {
  name: string; label: string; color: string | null; rank: number; member_count: number;
  matrix: Record<string, Record<Action, boolean>>;
}
export interface AccessSummary { resources: AccessResourceOut[]; roles: SirdarRole[] }
export interface AuditItem {
  id: number; at: string; action: string; entity_type: string; entity_id: string | null;
  ip: string | null; actor_id: string | null; actor_name: string | null;
  changes: Record<string, unknown>;
}
export interface SirdarSettings {
  env: string; source_configured: boolean; session_ttl_seconds: number;
  access_token_ttl_seconds: number; max_failed_logins: number; lockout_seconds: number;
}

export interface DeployTarget {
  /** 'aws' | 'gcp' | 'digitalocean' | 'ssh' (installer) | 'ssh:<slug>' (saved). */
  id: string; label: string; kind?: 'aws' | 'gcp' | 'digitalocean' | 'ssh';
  source?: 'installer' | 'saved'; available: boolean; configured: boolean;
}
export interface SshTarget {
  slug: string; name: string; host: string; port: number; user: string;
  key_path: string | null; password_set: boolean; passphrase_set: boolean; sudo_password_set: boolean;
}
/** Create body; on update every field is optional and a secret that is omitted is kept,
 *  "" is cleared and a value is set. */
export interface SshTargetBody {
  name: string; host: string; port: number; user: string;
  password?: string; key_path?: string; key_passphrase?: string; sudo_password?: string;
}
export interface DeployType { id: 'blue' | 'green' | 'dev' | 'beta' | 'custom'; label: string; description: string }
export interface DeployCheck { label: string; status: 'pass' | 'warn' | 'fail'; value: string }
export interface ConnectResult {
  ok: boolean; target: string; type: string; name?: string | null; checks: DeployCheck[]; facts: Record<string, unknown>;
}
export interface DoRegions { regions: { slug: string; name: string }[]; default: string | null }
export interface KnownHost {
  host: string; port: number; key_type: string; fingerprint: string;
  trusted_at: string; trusted_by_name: string | null;
}

async function errorOf(resp: Response): Promise<ApiError> {
  let code = `http_${resp.status}`;
  let detail: unknown;
  try {
    const body = await resp.json();
    detail = body?.detail;
    if (detail && typeof detail === 'object' && 'code' in detail) {
      code = String((detail as { code: unknown }).code);
    }
  } catch { /* not JSON */ }
  return new ApiError(resp.status, code, detail);
}

async function getJson<T>(path: string): Promise<T> {
  const resp = await apiFetch(path);
  if (!resp.ok) throw await errorOf(resp);
  return resp.json();
}

async function sendJson<T>(method: string, path: string, body?: unknown): Promise<T> {
  const resp = await apiFetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!resp.ok) throw await errorOf(resp);
  return resp.json();
}

const MESSAGES: Record<string, string> = {
  forbidden: "You don't have permission to do that.",
  rank_too_low: 'That person outranks you.',
  cannot_edit_own_role: "You can't change the permissions of a role you hold.",
  developer_role_locked: 'Only developers can change the developer role.',
  developer_role_core: 'The developer role always keeps Developer tools and Roles & access view/change.',
  cannot_target_self: "You can't change your own overrides.",
  grant_exceeds_own: "You can't grant a permission you don't have yourself.",
  developer_only_resource: 'Developer tools can only be granted to the developer role.',
  access_view_locked: 'Every role keeps view on Roles & access.',
  source_not_configured: 'The portal database is not configured for this Sirdar.',
  target_unavailable: "That target isn't available yet.",
  target_not_configured: "That target isn't configured. Set its keys in the .env file and re-run the installer.",
  custom_name_required: 'Enter a name for the custom environment.',
  custom_name_invalid: 'Use lowercase letters, numbers and hyphens, starting with a letter (2–32 characters, no trailing hyphen).',
  custom_name_reserved: 'That name is reserved. Choose a different one.',
  connect_failed: "Couldn't connect.",
  host_key_changed: "The server's key changed while you were looking. Try again.",
  host_key_unknown: "Sirdar doesn't trust this server yet.",
  host_key_mismatch: "The server's key doesn't match the one Sirdar trusted.",
  not_configured_host: "Only the configured SSH host can be trusted.",
  not_found: 'That host is no longer trusted.',
  target_not_found: 'That target no longer exists.',
  targets_file_unwritable: "Sirdar couldn't save deploy-targets.env. Check that it's writable; see the README.",
  targets_file_unreadable: "Sirdar couldn't read deploy-targets.env. Check that it's valid UTF-8; see the README.",
  value_invalid: "One of the values has a character that can't be saved. Remove line breaks and control characters.",
  name_taken: 'A target with that name already exists.',
  host_invalid: "That host isn't valid. Use a hostname or IP address.",
  user_invalid: "That user name isn't valid.",
  key_file_invalid: "That key file name isn't valid.",
  key_file_not_found: "That key file isn't in sirdar/deploy-keys/ on the Sirdar host.",
  auth_required: 'Add a password or choose a key file.',
  password_too_long: 'That password is too long.',
  passphrase_too_long: 'That passphrase is too long.',
  sudo_password_too_long: 'That sudo password is too long.',
  source_unavailable: "Couldn't reach the portal database. Nothing was changed.",
  // environments
  environment_exists: 'An environment with that name already exists.',
  environment_not_found: 'That environment no longer exists.',
  name_invalid: 'Use lowercase letters, numbers and hyphens, starting with a letter (2–32 characters, no trailing hyphen).',
  name_reserved: 'That name is reserved. Choose a different one.',
  type_invalid: 'Choose Dev, Beta or Custom.',
  target_invalid: 'Choose an SSH target.',
  ref_invalid: "That isn't a valid branch, tag or commit.",
  ref_not_found: 'The repository has no branch, tag or commit by that name.',
  git_missing: "git isn't installed on the target.",
  ref_lookup_failed: "The target couldn't list the repository's branches and tags.",
  base_domain_invalid: "That domain isn't valid. Use a name like uat.serversherpa.com.",
  proxy_ip_required: "Enter the proxy's IP address.",
  proxy_ip_invalid: 'The proxy IP must be an IPv4 address.',
  bind_ip_invalid: 'The bind IP must be an IPv4 address.',
  host_ip_invalid: 'Service addresses must be IPv4 addresses.',
  port_invalid: 'Use a port from 1 to 65535.',
  ports_conflict: "Two services can't use the same port.",
  service_unknown: "Sirdar doesn't know that service.",
  keep_dumps_invalid: 'Keep 1 to 100 dumps.',
  bucket_invalid: "That bucket name isn't valid (3–63 lowercase letters, numbers, dots and hyphens).",
  log_level_invalid: 'Choose DEBUG, INFO, WARNING or ERROR.',
  secret_invalid: "That value can't be saved. Use letters, numbers and ._~+/=:@%^*!?,;- only, with no spaces or quotes.",
  secret_not_editable: 'Only the optional secrets can be changed.',
  secrets_key_missing: "SIRDAR_SECRETS_KEY isn't set on the Sirdar host, so environments can't be created or deployed. Add it to sirdar/.env and restart Sirdar.",
  adopt_env_missing: "There's no .env in that environment's folder on the target.",
  adopt_env_too_large: "That environment's .env is too large to read.",
  adopt_env_mismatch: "That .env belongs to a different environment (its STACK_ENV doesn't match the name).",
  adopt_env_incomplete: 'That .env is missing required secrets.',
  adopt_value_invalid: "A value in that .env isn't valid.",
  adopt_repo_missing: "There's no git checkout in that environment's repo folder.",
  // deployments
  deploy_in_progress: 'A deployment of this environment is already running.',
  confirm_name_mismatch: "Type the environment's name exactly to confirm.",
  deployment_not_found: 'That deployment no longer exists.',
  not_running: "That deployment isn't running any more.",
  not_retryable: "That deployment can't be retried.",
  retry_not_latest: 'Only the most recent deployment can be retried.',
  from_step_invalid: 'Pick a step at or before the one where the deployment stopped.',
  invalid_start_step: "That step isn't part of this deployment.",
  // snapshots, backups and rollback
  snapshot_name_invalid: 'Use letters, numbers, dots, hyphens and underscores, starting with a letter or number (up to 64).',
  notes_too_long: 'Keep the notes under 2,000 characters.',
  snapshot_exists: 'A snapshot with that name already exists.',
  snapshot_too_large: 'That file is larger than Sirdar accepts.',
  http_413: 'That file is larger than the proxy in front of Sirdar accepts.',
  bundle_invalid: "That file isn't a snapshot bundle Sirdar can use.",
  snapshots_dir_unwritable: "Sirdar can't write its snapshots folder. It must be owned by uid 10001 with mode 700; see the README.",
  snapshot_keys_unreadable: "This snapshot's keys don't open with this Sirdar's SIRDAR_SECRETS_KEY.",
  snapshot_file_missing: "This snapshot's bundle is missing from Sirdar's snapshots folder.",
  snapshot_not_found: 'That snapshot no longer exists.',
  snapshot_not_ready: "That snapshot isn't ready yet.",
  snapshot_in_use: 'That snapshot is in use: a snapshot job or a deployment is running with it, or an environment that has not deployed yet starts from it.',
  snapshot_not_allowed: 'Only Reset data (or a new environment) can restore a snapshot.',
  not_deployed: "This environment hasn't been deployed yet.",
  backup_invalid: "That isn't one of this environment's backups.",
  backup_keys_changed: 'That backup was taken before the sign-in keys changed, so nobody could sign in after restoring it.',
  rollback_unavailable: "This deployment can't be rolled back: it needs a pre-deploy dump and a commit to go back to.",
  rollback_not_latest: 'Only the most recent deployment can be rolled back.',
  git_ref_not_allowed: 'Restore backup always uses the deployed commit.',
  upload_aborted: 'The upload was interrupted. Try again.',
  // integrations and publishing
  zone_invalid: "That zone isn't a valid domain, like serversherpa.com.",
  public_ip_invalid: 'The public IP must be an IPv4 address.',
  token_invalid: "That doesn't look like a Cloudflare API token (20–200 letters, digits, - or _).",
  secret_required: 'Enter the token or password: none is stored yet.',
  npm_url_invalid: 'Use the address of Nginx Proxy Manager, like http://10.10.48.6:81 (no path).',
  identity_invalid: 'Enter the email you sign in to Nginx Proxy Manager with.',
  letsencrypt_email_invalid: "That isn't a valid email address.",
  password_invalid: "That password can't be used: it's empty, too long, or has a line break.",
  integration_not_found: "Those credentials aren't stored any more.",
  integration_not_configured: 'Set up publishing in Settings › Integrations first.',
  integration_unreadable: "The stored credentials don't open with this Sirdar's SIRDAR_SECRETS_KEY. Enter them again.",
  nothing_to_claim: "There's nothing to claim.",
  claim_conflict: 'Someone else claimed that entry first. Reload the Publish tab.',
  publish_off: 'Publishing is off for this environment. Turn it on from the Publish tab, or retry from an earlier step.',
  publish_not_allowed: "Adopted environments start with publishing off; turn it on from the environment's Publish tab.",
};

export function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return MESSAGES[err.code] ?? fallback;
  return fallback;
}

/** The detail object of an API error (code plus extras such as a fingerprint). */
export function errorDetail<T extends object = Record<string, unknown>>(err: unknown): T | null {
  if (err instanceof ApiError && err.detail && typeof err.detail === 'object') return err.detail as T;
  return null;
}

/** errorText plus what deploy errors carry: a `reason` (connect and git
 *  failures) replaces the message; the missing .env keys, or the key or
 *  service a check named, are added in parentheses; an integration_not_configured
 *  names the integrations still to set up. */
export function deployErrorText(err: unknown, fallback: string): string {
  const d = errorDetail<{ reason?: unknown; missing?: unknown; key?: unknown; service?: unknown; kinds?: unknown }>(err);
  if (d && typeof d.reason === 'string' && d.reason) return d.reason;
  if (d && Array.isArray(d.kinds) && d.kinds.length && err instanceof ApiError
      && err.code === 'integration_not_configured') {
    const names = d.kinds.map((k) => INTEGRATION_LABEL[k as IntegrationKind] ?? String(k));
    return `Set up ${names.join(' and ')} in Settings › Integrations first.`;
  }
  const base = errorText(err, fallback);
  let extra = '';
  if (d && Array.isArray(d.missing) && d.missing.length) extra = d.missing.join(', ');
  else if (d && typeof d.key === 'string') extra = d.key;
  else if (d && typeof d.service === 'string') extra = d.service;
  if (!extra) return base;
  return base.endsWith('.') ? `${base.slice(0, -1)} (${extra}).` : `${base} (${extra})`;
}

export const listUsers = () => getJson<UserRow[]>('/users');
export const getUser = (id: string) => getJson<UserDetail>(`/users/${id}`);
export const getImportSource = () => getJson<{ configured: boolean }>('/users/import/source');
export const listImportRuns = () => getJson<ImportRun[]>('/users/import/runs');
export const runImport = () => sendJson<ImportRun>('POST', '/users/import');
export const revokeSessions = (id: string) =>
  sendJson<{ revoked: number }>('POST', `/users/${id}/sessions/revoke`);
export const getAccessSummary = () => getJson<AccessSummary>('/access/summary');
export const putRoleMatrix = (name: string, matrix: Record<string, Record<Action, boolean>>) =>
  sendJson<{ role: string; grants: number }>('PUT', `/access/roles/${name}/matrix`, { matrix });
export const getOverrides = (id: string) =>
  getJson<{ person_id: string; overrides: Record<string, Partial<Record<Action, boolean>>> }>(
    `/access/overrides/${id}`);
export const putOverrides = (id: string,
                             overrides: Record<string, Partial<Record<Action, boolean | null>>>) =>
  sendJson<{ person_id: string; overrides: number }>('PUT', `/access/overrides/${id}`, { overrides });
export function listAudit(q: { entity_type?: string; action?: string; offset?: number; limit?: number }) {
  const params = new URLSearchParams();
  Object.entries(q).forEach(([k, v]) => { if (v !== undefined && v !== '') params.set(k, String(v)); });
  return getJson<AuditItem[]>(`/audit?${params.toString()}`);
}
export const getAuditFacets = () =>
  getJson<{ entity_types: string[]; actions: string[] }>('/audit/facets');
export const getSettings = () => getJson<SirdarSettings>('/settings');

export const getDeployTargets = () =>
  getJson<{ targets: DeployTarget[]; types: DeployType[]; can_add_ssh?: boolean; ssh_store_hint?: string | null }>(
    '/deploy/targets');
export const getSshTarget = (slug: string) => getJson<SshTarget>(`/deploy/ssh-targets/${encodeURIComponent(slug)}`);
export const createSshTarget = (body: SshTargetBody) => sendJson<SshTarget>('POST', '/deploy/ssh-targets', body);
export const updateSshTarget = (slug: string, body: Partial<SshTargetBody>) =>
  sendJson<SshTarget>('PUT', `/deploy/ssh-targets/${encodeURIComponent(slug)}`, body);
export async function deleteSshTarget(slug: string): Promise<void> {
  const resp = await apiFetch(`/deploy/ssh-targets/${encodeURIComponent(slug)}`, { method: 'DELETE' });
  if (!resp.ok) throw await errorOf(resp);
}
export const listKeyFiles = () => getJson<{ files: string[] }>('/deploy/key-files');
export const connectDeploy = (target: string, type: string, region?: string, name?: string) =>
  sendJson<ConnectResult>('POST', '/deploy/connect',
    { target, type, ...(region ? { region } : {}), ...(name ? { name } : {}) });
export const getDoRegions = () => getJson<DoRegions>('/deploy/digitalocean/regions');
export const listKnownHosts = () => getJson<KnownHost[]>('/deploy/known-hosts');
export const trustKnownHost = (host: string, port: number, fingerprint: string, target?: string) =>
  sendJson<KnownHost>('POST', '/deploy/known-hosts', { host, port, fingerprint, ...(target ? { target } : {}) });
export async function forgetKnownHost(host: string, port: number): Promise<void> {
  const resp = await apiFetch(`/deploy/known-hosts?host=${encodeURIComponent(host)}&port=${port}`,
                              { method: 'DELETE' });
  if (!resp.ok) throw await errorOf(resp);
}

/* ---- Environments and deployments (/api/deploy, deploy step 2) ---- */
export type EnvType = 'dev' | 'beta' | 'custom';
export type EnvStatus = 'new' | 'ready' | 'deploying' | 'failed' | 'deleting';
/** Modes the Deploy modal starts. */
export type DeployMode = 'update' | 'reset' | 'restore_dump';
/** Every mode a deployment record can have (publish: steps 12–14 alone;
 *  teardown: Delete environment). */
export type DeploymentMode = DeployMode | 'adopt' | 'snapshot' | 'rollback' | 'publish' | 'teardown';
export type DeploymentStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'adopted';
export type StepStatus =
  'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'not_run' | 'cancelled' | 'interrupted';
export interface EnvService { service: string; host_ip: string; port: number; hostname: string | null; proxied: boolean }
export interface SnapshotRef { id: string; name: string }
export interface DeploymentSummary {
  id: string; mode: DeploymentMode; git_ref: string; sha: string; status: DeploymentStatus;
  start_step: number; retry_of: string | null; failed_step: number | null; dump_path: string | null;
  /** The snapshot a reset or first deploy restores, or the one a snapshot job takes. */
  snapshot: SnapshotRef | null;
  /** restore_dump and rollback: the backup's file name in <env-dir>/backups. */
  restore_dump: string | null;
  /** A stopped Update with a pre-deploy dump and a commit to go back to. */
  rollback_available: boolean;
  /** Its plan ends with steps 12–14 (DNS records, proxy hosts, smoke test). */
  publish: boolean;
  previous_sha: string | null; error: string | null; actor_name: string | null;
  started_at: string; finished_at: string | null; created_at: string;
}
export interface DeploymentStep {
  number: number; key: string; name: string; status: StepStatus;
  started_at: string | null; finished_at: string | null;
  /** Characters stored for the step; `log_tail` is its last `tail` (default 8000). */
  log_size: number; log_tail: string;
}
export interface Deployment extends DeploymentSummary { environment: string; steps: DeploymentStep[] }
export interface Environment {
  id: string; name: string; type: EnvType; target: string; base_domain: string; env_dir: string;
  git_ref: string; current_sha: string | null; image_tag: string | null; status: EnvStatus;
  proxy_ip: string; bind_ip: string; keep_dumps: number; spaces_bucket: string; log_level: string;
  services: EnvService[];
  /** Which optional (write-only) secrets are set. */
  secrets_set: Record<string, boolean>;
  /** The snapshot the first deploy restores (kept afterwards). */
  seed_snapshot: SnapshotRef | null;
  /** Deploys publish DNS records and proxy hosts (steps 12–14). */
  publish: boolean;
  /** What Sirdar manages for it in Cloudflare and Nginx Proxy Manager. */
  managed_records: ManagedRecordRef[];
  last_deployment: DeploymentSummary | null; created_at: string; updated_at: string;
}
export interface ManagedRecordRef {
  service: string; kind: 'dns_record' | 'proxy_host' | 'certificate'; name: string; origin: 'created' | 'claimed';
}
/** Adopt's answer adds what it read from the target's .env — names only. */
export interface AdoptedEnvironment extends Environment { ignored_keys: string[]; imported_secrets: string[] }
export interface EnvironmentDefaults {
  services: { service: string; port: number; public: boolean }[];
  domain_suffix: string; env_root: string; git_ref: string; bind_ip: string; keep_dumps: number;
  spaces_bucket: string; log_levels: string[]; optional_secrets: string[];
}
export interface NewEnvironmentBody {
  name: string; type: EnvType; target: string; git_ref: string; base_domain?: string;
  proxy_ip: string; bind_ip: string; ports: Record<string, number>;
  /** The first deploy restores this snapshot. */
  snapshot_id?: string;
  /** Deploys publish DNS records and proxy hosts (the API's default: true). */
  publish?: boolean;
}
export interface AdoptEnvironmentBody { name: string; type: EnvType; target: string; git_ref: string }
/** PATCH body: an omitted field is kept; a secret set to "" is cleared. */
export interface EnvironmentPatch {
  git_ref?: string; target?: string; base_domain?: string; proxy_ip?: string; bind_ip?: string;
  keep_dumps?: number; spaces_bucket?: string; log_level?: string;
  services?: Record<string, { port?: number; host_ip?: string; proxied?: boolean }>;
  secrets?: Record<string, string>;
  publish?: boolean;
}
export interface DeploymentBody {
  mode: DeployMode | 'publish' | 'teardown'; git_ref?: string; confirm_name?: string;
  /** Reset only. */
  snapshot_id?: string;
  /** Restore backup only: a file name from listBackups. */
  backup?: string;
}
export interface RetryBody { from_step?: number; confirm_name?: string }
export type SnapshotStatus = 'pending' | 'ready' | 'failed';
export interface Snapshot {
  id: string; name: string; origin: 'upload' | 'environment';
  /** The bundle's source (an environment's name, or what the Mac script was told). */
  source: string; status: SnapshotStatus; alembic_revision: string | null;
  size_bytes: number | null; checksum: string | null; object_count: number | null; object_bytes: number | null;
  notes: string; source_created_at: string | null; created_at: string; created_by_name: string | null;
  /** The snapshot job's deployment (taken snapshots only). */
  deployment_id: string | null;
}
/** `restorable` is false (with the `reason`) for a dump taken before a
 *  snapshot restore changed the sign-in keys. */
export interface Backup {
  name: string; size_bytes: number; modified_at: string; restorable: boolean; reason: string | null;
}

const envPath = (name: string) => `/deploy/environments/${encodeURIComponent(name)}`;
const depPath = (id: string) => `/deploy/deployments/${encodeURIComponent(id)}`;
export const listEnvironments = () => getJson<{ environments: Environment[] }>('/deploy/environments');
export const getEnvironment = (name: string) => getJson<Environment>(envPath(name));
export const getEnvironmentDefaults = () => getJson<EnvironmentDefaults>('/deploy/environment-defaults');
export const createEnvironment = (body: NewEnvironmentBody) =>
  sendJson<Environment>('POST', '/deploy/environments', { mode: 'new', ...body });
export const adoptEnvironment = (body: AdoptEnvironmentBody) =>
  sendJson<AdoptedEnvironment>('POST', '/deploy/environments', { mode: 'adopt', ...body });
export const updateEnvironment = (name: string, patch: EnvironmentPatch) =>
  sendJson<Environment>('PATCH', envPath(name), patch);
export const startDeployment = (name: string, body: DeploymentBody) =>
  sendJson<Deployment>('POST', `${envPath(name)}/deployments`, body);
export const listDeployments = (name: string, limit = 20) =>
  getJson<{ deployments: DeploymentSummary[] }>(`${envPath(name)}/deployments?limit=${limit}`);
export const getDeployment = (id: string) => getJson<Deployment>(depPath(id));
export const cancelDeployment = (id: string) =>
  sendJson<{ id: string; status: 'cancelling' | 'cancelled' }>('POST', `${depPath(id)}/cancel`);
export const retryDeployment = (id: string, body: RetryBody) =>
  sendJson<Deployment>('POST', `${depPath(id)}/retry`, body);
export const rollbackDeployment = (id: string, confirmName: string) =>
  sendJson<Deployment>('POST', `${depPath(id)}/rollback`, { confirm_name: confirmName });
export const listBackups = (name: string) => getJson<{ backups: Backup[] }>(`${envPath(name)}/backups`);

export const listSnapshots = () => getJson<{ snapshots: Snapshot[] }>('/deploy/snapshots');
/** The bundle goes up as the raw request body (streamed; no multipart). */
export async function uploadSnapshot(file: Blob, name: string, notes: string): Promise<Snapshot> {
  const params = new URLSearchParams({ name, notes });
  const resp = await apiFetch(`/deploy/snapshots?${params.toString()}`, {
    method: 'POST', headers: { 'Content-Type': 'application/gzip' }, body: file,
  });
  if (!resp.ok) throw await errorOf(resp);
  return resp.json();
}
export const takeSnapshot = (env: string, name: string, notes: string) =>
  sendJson<{ snapshot: Snapshot; deployment: Deployment }>('POST', `${envPath(env)}/snapshots`, { name, notes });
export async function deleteSnapshot(id: string): Promise<void> {
  const resp = await apiFetch(`/deploy/snapshots/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!resp.ok) throw await errorOf(resp);
}

/* ---- Publishing: integrations (Settings) and the Publish tab ---- */
export type IntegrationKind = 'cloudflare' | 'npm';
export const INTEGRATION_LABEL: Record<IntegrationKind, string> = {
  cloudflare: 'Cloudflare', npm: 'Nginx Proxy Manager',
};
export interface CloudflareIntegration {
  configured: boolean; zone: string | null; public_ip: string | null; token_set: boolean;
  updated_at: string | null; updated_by_name: string | null;
}
export interface NpmIntegration {
  configured: boolean; url: string | null; identity: string | null; letsencrypt_email: string | null;
  password_set: boolean; updated_at: string | null; updated_by_name: string | null;
}
export interface Integrations { secrets_key_configured: boolean; cloudflare: CloudflareIntegration; npm: NpmIntegration }
/** An omitted secret keeps the stored one. */
export interface CloudflareBody { zone: string; public_ip: string; token?: string }
export interface NpmBody { url: string; identity: string; letsencrypt_email?: string; password?: string }
export interface IntegrationCheck {
  ok: boolean; target: IntegrationKind; checks: DeployCheck[]; facts: Record<string, unknown>;
}
export type PublishEntryState = 'ok' | 'update' | 'create' | 'claimable' | 'conflict' | 'unknown';
export interface PublishEntry { state: PublishEntryState; detail: string; origin: 'created' | 'claimed' | null }
export interface PublishService {
  service: string; hostname: string; forward: string;
  dns: PublishEntry & { record_id: string | null };
  proxy: PublishEntry & { host_id: number | null };
  certificate: { state: 'ok' | 'update' | 'create' | 'unknown'; detail: string; expires_on: string | null };
}
export interface PublishPlan {
  publish: boolean; proxy_ip: string;
  cloudflare: { configured: boolean; zone: string | null; public_ip: string | null; error: string | null };
  npm: { configured: boolean; url: string | null; error: string | null };
  services: PublishService[];
  /** Managed entries under a name the environment no longer uses. */
  stale: ManagedRecordRef[];
}
const integrationPath = (kind: IntegrationKind) => `/deploy/integrations/${kind}`;
export const getIntegrations = () => getJson<Integrations>('/deploy/integrations');
export const saveIntegration = (kind: IntegrationKind, body: CloudflareBody | NpmBody) =>
  sendJson<Integrations>('PUT', integrationPath(kind), body);
export async function removeIntegration(kind: IntegrationKind): Promise<void> {
  const resp = await apiFetch(integrationPath(kind), { method: 'DELETE' });
  if (!resp.ok) throw await errorOf(resp);
}
/** No body: the saved settings. A body: those values unsaved (no secret = the stored one). */
export const testIntegration = (kind: IntegrationKind, body?: CloudflareBody | NpmBody) =>
  sendJson<IntegrationCheck>('POST', `${integrationPath(kind)}/test`, body);
export const getPublishPlan = (name: string) => getJson<PublishPlan>(`${envPath(name)}/publish`);
export const claimPublish = (name: string) =>
  sendJson<PublishPlan & { claimed: string[] }>('POST', `${envPath(name)}/publish/claim`);

/* ---- Dashboard (GET /api/dashboard) ---- */
export interface DashHealth { status: 'healthy' | 'degraded' | 'unknown' | string; label: string }
export interface DashSlot {
  id: 'blue' | 'green' | string; label: string;
  state: 'active' | 'standby' | 'empty' | string;
  health: 'healthy' | 'degraded' | 'unknown' | string;
  version: string | null; instances: { running: number; total: number }; traffic_pct: number;
}
export interface DashProduction {
  status: 'active' | 'inactive' | string; active_slot: string | null;
  traffic: { label: string; sub: string };
  load_balancer: { label: string; sub: string; present: boolean };
  slots: DashSlot[];
}
export interface DashEnvironment {
  /** The Sirdar environment's name, or "dev" / "beta" / a DigitalOcean env tag for a card with no environment. */
  id: string; label: string;
  /** The environment's type ("Development", "Beta", "Custom"); null on placeholder cards. */
  sub: string | null;
  state: 'active' | 'deploying' | 'failed' | 'empty' | string;
  version: string | null; last_release: string | null; last_release_at: string | null;
  action_label: string;
  /** The environment the card's action deploys; null means there's nothing to deploy yet. */
  environment: string | null;
}
export interface DashNode {
  id: string; name: string;
  kind: 'environment' | 'deployment' | 'group' | 'droplet' | 'database' | 'spaces' | 'load_balancer' | string;
  type_label: string; status: string; status_label: string; region: string; endpoint: string;
  badge: string | null; dot: 'green' | 'gray' | 'blue' | string | null;
  tone: 'shared' | null; children: DashNode[];
}
export interface DashboardData {
  demo: boolean; generated_at: string; health: DashHealth; production: DashProduction;
  environments: DashEnvironment[];
  infrastructure: { source: 'none' | 'digitalocean' | 'demo' | string; error: string | null; tree: DashNode[] };
}
export function getDashboard(opts: { demo?: boolean; refresh?: boolean } = {}) {
  const params = new URLSearchParams();
  if (opts.demo) params.set('demo', '1');
  if (opts.refresh) params.set('refresh', '1');
  const qs = params.toString();
  return getJson<DashboardData>(`/dashboard${qs ? `?${qs}` : ''}`);
}

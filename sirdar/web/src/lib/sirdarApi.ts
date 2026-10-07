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
  /** 'aws' | 'gcp' | 'digitalocean' | 'ssh' (installer) | 'ssh:<slug>' (saved) | 'proxmox' | 'esxi' (once set up). */
  id: string; label: string; kind?: 'aws' | 'gcp' | 'digitalocean' | 'ssh' | 'proxmox' | 'esxi';
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
/* ---- DigitalOcean accounts and environments (deploy phase 7) ---- */
export type DoAccountKey = 'production' | 'development';
export interface DoAccount {
  key: DoAccountKey; label: string; region: string | null; configured: boolean; token_set: boolean;
  source: 'stored' | 'environment' | null; renewal_token_set: boolean; team_name: string | null;
  /** Environments built in this account: it can't be cleared while any exist. */
  environments: string[]; updated_at: string | null; updated_by_name: string | null;
}
/** Omitted tokens keep the stored ones. */
export interface DoAccountBody {
  label: string; region: string | null; token?: string; renewal_token?: string; clear_renewal_token?: boolean;
}
export interface EnvDoSlot {
  slot: string; droplet_id: string | null; public_ip: string | null; private_ip: string | null;
  sha: string | null; image_tag: string | null; active: boolean;
  last_check_ok: boolean | null; last_check_at: string | null;
}
export interface EnvDo {
  account: DoAccountKey; account_label: string; region: string; droplet_size: string; db_size: string;
  db_standby: boolean; acme_staging: boolean; vpc_ip_range: string | null; lb_ip: string | null;
  db_host: string | null; bucket: string | null; cert_not_after: string | null;
  slots: EnvDoSlot[]; resources: { kind: string; name: string; slot: string | null }[];
}
export interface NewDo {
  account: DoAccountKey; slots?: 1 | 2; droplet_size?: string; db_size?: string; db_standby?: boolean;
  acme_staging?: boolean; auto_activate?: boolean;
}
export interface DoDefaults {
  droplet_size: string; db_size: string; db_standby: boolean;
  production_slots: string[]; one_slot: string[]; two_slots: string[];
}
/** PATCH `do`: sizes only grow (step 0 applies them on the next deploy). */
export interface DoSizes { droplet_size?: string; db_size?: string; db_standby?: boolean }
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
  target_not_configured: "That target isn't configured. Set it up in Settings › Integrations, or set its keys in the .env file and re-run the installer.",
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
  secrets_key_missing: "SIRDAR_SECRETS_KEY isn't set on the Sirdar host, so Sirdar can't read or store its secrets and tokens. Add it to sirdar/.env and restart Sirdar.",
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
  do_token_invalid: "That doesn't look like a DigitalOcean API token: dop_v1_ and 64 hex digits, or up to 200 characters with no spaces.",
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
  // VM hosts (Proxmox and ESXi)
  proxmox_url_invalid: 'Use the Proxmox address with https, like https://10.10.48.5:8006 (no path).',
  node_invalid: "That node name isn't valid.",
  pool_invalid: "That pool name isn't valid.",
  storage_invalid: "That storage name isn't valid, like local-lvm.",
  bridge_invalid: "That bridge name isn't valid, like vmbr0.",
  vlan_tag_invalid: 'Use a VLAN tag from 1 to 4094, or leave it empty.',
  template_vmid_invalid: "Use the template's VM id, a number from 100 up.",
  proxmox_token_invalid: "That doesn't look like a Proxmox API token (user@realm!tokenid=secret).",
  esxi_url_invalid: 'Use the ESXi host with https, like https://10.10.48.10 (no path).',
  esxi_user_invalid: "That user name isn't valid, like sirdar or root.",
  datastore_invalid: "That datastore name isn't valid, like datastore1.",
  network_invalid: "That port group name isn't valid, like VM Network.",
  resource_pool_invalid: "That resource pool name isn't valid. Leave it empty for the host's root pool.",
  source_vm_invalid: "That seed VM name isn't valid, like sirdar-ubuntu-2404-seed.",
  dns_servers_invalid: 'Use up to 3 IPv4 addresses, separated by commas, or leave it empty.',
  tls_untrusted: "Sirdar doesn't trust this server's certificate yet.",
  tls_mismatch: "The server's certificate doesn't match the one Sirdar trusted.",
  tls_fingerprint_invalid: 'Use a SHA-256 fingerprint: 64 hex digits, with or without colons.',
  integration_in_use: 'Environments still use it. Delete them first.',
  vm_invalid: "Those VM settings aren't valid.",
  vm_name_invalid: "The environment name can't be used as a VM host name.",
  vm_cores_invalid: 'Use 1 to 64 vCPUs.',
  vm_memory_invalid: 'Use 2 to 256 GB of memory.',
  vm_disk_invalid: 'Use a disk of 20 to 4096 GB.',
  vm_keep_snapshots_invalid: 'Keep 1 to 10 VM snapshots.',
  vm_ip_mode_invalid: 'Choose Static or DHCP.',
  vm_ip_invalid: 'Use an address with its prefix, like 10.10.48.70/24.',
  vm_gateway_invalid: "The gateway must be another address in the VM's network.",
  vm_not_allowed: 'Only an environment on a VM host has a VM.',
  vm_disk_shrink: "A VM's disk can grow but never shrink.",
  ip_in_use: 'That address is already used: by the proxy, an SSH target, a VM host or another environment.',
  ssh_targets_unreadable: "Sirdar couldn't read the saved SSH targets, so it can't check that address is free.",
  adopt_not_allowed: 'Only environments on SSH targets can be adopted. Sirdar builds environments on Proxmox, ESXi and '
    + "DigitalOcean itself, so they can't be adopted.",
  host_ip_managed: "A VM environment's services always run on its VM.",
  target_kind_locked: "An environment can't move between an SSH target and a VM host, or between VM hosts.",
  vm_snapshot_not_allowed: 'Only an environment on a VM host takes VM snapshots.',
  vm_snapshot_invalid: "That isn't one of this environment's VM snapshots.",
  vm_snapshot_not_found: "That VM snapshot isn't one Sirdar took for this environment.",
  vm_snapshot_keys_changed: 'That VM snapshot was taken before the sign-in keys changed, so nobody could sign in after restoring it.',
  not_vm_environment: "This environment isn't on a VM host.",
  vm_not_ready: "This environment's VM isn't built yet. Deploy it first.",
  vm_key_unreadable: "Sirdar's key for this VM doesn't open with the current SIRDAR_SECRETS_KEY.",
  // DigitalOcean environments
  base_domain_not_in_zone: "That base domain isn't in the Cloudflare zone Sirdar manages.",
  do_account_not_configured: "That DigitalOcean account has no API token yet. Add it in Settings › Integrations.",
  do_invalid: 'Those DigitalOcean settings are incomplete or not valid.',
  do_slots_invalid: 'Choose one droplet or two slots. Production always has blue and green.',
  do_size_invalid: "That isn't a DigitalOcean droplet size.",
  do_db_size_invalid: "That isn't a DigitalOcean database size.",
  db_standby_size_invalid: "That database size can't have a standby node. Choose a larger size first.",
  do_field_locked: "That can't change on a DigitalOcean environment after it's created.",
  do_not_allowed: 'DigitalOcean settings only apply to an environment on DigitalOcean.',
  do_not_ready: "Nothing is built on DigitalOcean for this environment yet. Deploy it first.",
  snapshot_slot_unreachable: "The droplet Sirdar would take the snapshot on isn't reachable. Untick 'Save a snapshot first' to delete without one.",
  do_account_invalid: 'That isn\'t one of the DigitalOcean accounts (Production or Development).',
  do_account_changed: 'An environment started using this account while it was being saved. Save it again.',
  label_invalid: 'Give the account a name of 1 to 40 characters, with no control characters.',
  region_invalid: "That isn't a DigitalOcean region slug, like nyc3.",
  do_team_changed: 'That token belongs to a different DigitalOcean team than the environments using this account.',
  do_token_shared: 'The Production and Development accounts need different tokens.',
  renewal_token_invalid: "That doesn't look like a DigitalOcean renewal token.",
  renewal_token_shared: "The renewal token can't be the same as an account token.",
  account_in_use: 'Environments still use this DigitalOcean account.',
  production_exists: 'Another production environment is already live. Mark it retiring first.',
  production_requires_digitalocean: 'A production environment must run on DigitalOcean.',
  retiring_not_allowed: 'Only a production environment can be marked retiring.',
  production_not_retiring: 'Mark this production environment retiring before deleting it.',
  production_slot_active: 'Deactivate this production environment before deleting it.',
  confirm_production_mismatch: 'Type "delete production" and the environment\'s name exactly.',
  snapshot_required: 'Deleting production always saves a snapshot first, and that snapshot is missing.',
  not_supported_on_digitalocean: "That isn't offered on DigitalOcean. Activate the other slot to go back.",
  seed_not_allowed: 'This environment already runs a deploy, so it can no longer be seeded from a snapshot.',
  slot_not_deployed: "That slot has never run a deploy. Deploy to it first.",
  not_digitalocean_environment: "This environment isn't on DigitalOcean.",
  slot_invalid: "That isn't one of this environment's slots.",
  slot_required: 'Choose the slot to activate.',
  slot_already_active: 'That slot is already live.',
  production_retiring: 'This production environment is retiring: it can only be deactivated.',
  already_inactive: 'No slot is live.',
  auto_activate_not_allowed: 'Only non-production DigitalOcean environments activate automatically.',
  slots_full: 'This environment already has two slots.',
  slot_not_allowed: 'Production always has its Blue and Green slots.',
  do_shrink_refused: 'Sizes can only grow.',
  // the first admin
  first_admin_not_allowed: 'The first admin is only for a new environment.',
  first_admin_with_seed: 'An environment seeded from a snapshot already has its users. Start empty to add a first admin.',
  first_admin_name_invalid: 'Enter a first and last name (up to 100 characters each).',
  first_admin_email_invalid: 'Enter a valid email address for the first admin.',
  first_admin_password_too_short: "The password is too short for ServerSherpa's password policy.",
  first_admin_password_invalid: "The password can't contain line breaks or control characters.",
  first_admin_password_not_allowed: 'An invite sends a set-password link: leave the password empty.',
  first_admin_invalid: "Those first-admin settings aren't valid.",
  first_admin_not_set: 'This environment has no first admin to change.',
  first_admin_done: 'The first admin was already created; change their password in the portal.',
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
  const d = errorDetail<{
    reason?: unknown; missing?: unknown; key?: unknown; service?: unknown; kinds?: unknown; environments?: unknown;
    production?: unknown; min_length?: unknown;
  }>(err);
  if (d && typeof d.reason === 'string' && d.reason) return d.reason;
  if (d && Array.isArray(d.environments) && d.environments.length && err instanceof ApiError
      && err.code === 'integration_in_use') {
    return `Environments still use it: ${d.environments.join(', ')}. Delete them first.`;
  }
  if (d && Array.isArray(d.kinds) && d.kinds.length && err instanceof ApiError
      && err.code === 'integration_not_configured') {
    const names = d.kinds.map((k) => INTEGRATION_LABEL[k as IntegrationKind] ?? String(k));
    return `Set up ${names.join(' and ')} in Settings › Integrations first.`;
  }
  if (d && d.production === true && err instanceof ApiError && err.code === 'snapshot_slot_unreachable') {
    return "The droplet Sirdar would take the snapshot on isn't reachable, and production never goes "
      + 'without its snapshot. Retry once the droplet is back.';
  }
  if (d && typeof (d as { min_length?: unknown }).min_length === 'number' && err instanceof ApiError
      && err.code === 'first_admin_password_too_short') {
    const n = (d as { min_length: number }).min_length;
    return `${errorText(err, fallback).replace(/\.$/, '')} (at least ${n} characters).`;
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
export const connectDeploy = (target: string, type: string, region?: string, name?: string, account?: DoAccountKey) =>
  sendJson<ConnectResult>('POST', '/deploy/connect',
    { target, type, ...(region ? { region } : {}), ...(name ? { name } : {}), ...(account ? { account } : {}) });
export const getDoRegions = (account: DoAccountKey = 'production') =>
  getJson<DoRegions>(`/deploy/digitalocean/regions?account=${account}`);
const doAccountPath = (key: DoAccountKey) => `/deploy/integrations/digitalocean/accounts/${key}`;
export const getDoAccounts = () => getJson<{ accounts: DoAccount[] }>('/deploy/integrations/digitalocean/accounts');
export const saveDoAccount = (key: DoAccountKey, body: DoAccountBody) =>
  sendJson<{ accounts: DoAccount[] }>('PUT', doAccountPath(key), body);
/** No body: the saved account. A body: those values unsaved (omitted tokens = the stored ones). */
export const testDoAccount = (key: DoAccountKey, body?: DoAccountBody) =>
  sendJson<IntegrationCheck>('POST', `${doAccountPath(key)}/test`, body);
export async function clearDoAccount(key: DoAccountKey): Promise<void> {
  const resp = await apiFetch(doAccountPath(key), { method: 'DELETE' });
  if (!resp.ok) throw await errorOf(resp);
}
export const listKnownHosts = () => getJson<KnownHost[]>('/deploy/known-hosts');
export const trustKnownHost = (host: string, port: number, fingerprint: string, target?: string) =>
  sendJson<KnownHost>('POST', '/deploy/known-hosts', { host, port, fingerprint, ...(target ? { target } : {}) });
export async function forgetKnownHost(host: string, port: number): Promise<void> {
  const resp = await apiFetch(`/deploy/known-hosts?host=${encodeURIComponent(host)}&port=${port}`,
                              { method: 'DELETE' });
  if (!resp.ok) throw await errorOf(resp);
}

/* ---- Environments and deployments (/api/deploy, deploy step 2) ---- */
export type EnvType = 'dev' | 'beta' | 'custom' | 'production';
export type EnvStatus = 'new' | 'ready' | 'deploying' | 'failed' | 'deleting';
/** Modes the Deploy modal starts. */
export type DeployMode = 'update' | 'reset' | 'restore_dump';
/** Every mode a deployment record can have (publish: steps 12–14 alone;
 *  teardown: Delete environment). */
export type DeploymentMode = DeployMode | 'adopt' | 'snapshot' | 'rollback' | 'publish' | 'teardown' | 'vm_restore'
  | 'activate' | 'renew';
export type DeploymentStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'adopted';
export type StepStatus =
  'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'not_run' | 'cancelled' | 'interrupted';
/** The first super admin step 11 of the first deploy creates (an environment that starts empty). */
export interface NewFirstAdmin {
  first_name: string; last_name: string; email: string; password_mode: 'typed' | 'invite';
  /** typed only; write-only */
  password?: string | null;
}
export interface EnvFirstAdmin {
  first_name: string; last_name: string; email: string; password_mode: 'typed' | 'invite'; done: boolean;
}
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
  /** Its plan has the VM steps (a VM environment): 0 Prepare VM, 0 Restore VM snapshot or 15 Destroy VM. */
  vm: boolean;
  /** Step 0 takes a VM snapshot before anything changes. */
  take_vm_snapshot: boolean;
  /** The VM snapshot it took — for vm_restore, the one it restores. */
  vm_snapshot: string | null;
  previous_sha: string | null; error: string | null; actor_name: string | null;
  started_at: string; finished_at: string | null; created_at: string;
  /** DigitalOcean: the slot it deploys or switches to, and whether it ends with Switch traffic. */
  cloud: boolean; slot: string | null; go_live: boolean;
  /** Its plan has step 11, Create the first admin. */
  first_admin: boolean;
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
  /** 'proxmox' | 'esxi': its host is a VM Sirdar builds (`vm`); 'ssh': a saved SSH target. */
  target_kind: 'ssh' | VmHostKind | 'digitalocean';
  vm: EnvVm | null;
  /** DigitalOcean: its slots, the one the load balancer sends traffic to, auto-activate, retiring (production),
   *  and what Sirdar built. */
  slots: string[]; active_slot: string | null; auto_activate: boolean; retiring: boolean; do: EnvDo | null;
  git_ref: string; current_sha: string | null; image_tag: string | null; status: EnvStatus;
  proxy_ip: string; bind_ip: string; keep_dumps: number; spaces_bucket: string; log_level: string;
  services: EnvService[];
  /** Which optional (write-only) secrets are set. */
  secrets_set: Record<string, boolean>;
  /** The snapshot the first deploy restores (kept afterwards). */
  seed_snapshot: SnapshotRef | null;
  /** An environment that starts empty: the first super admin its first deploy creates. */
  first_admin: EnvFirstAdmin | null;
  /** Deploys publish DNS records and proxy hosts (steps 12–14). */
  publish: boolean;
  /** What Sirdar manages for it in Cloudflare and Nginx Proxy Manager. */
  managed_records: ManagedRecordRef[];
  last_deployment: DeploymentSummary | null; created_at: string; updated_at: string;
}
export interface ManagedRecordRef {
  service: string; kind: 'dns_record' | 'proxy_host' | 'certificate'; name: string; origin: 'created' | 'claimed';
}
/** A VM environment's VM. `stage`: none before step 0 starts one, partial while it isn't finished, then built.
 *  `vmid`/`node` are Proxmox's, `moref` ESXi's; `ip` is null until the VM reports it. */
export interface EnvVm {
  kind: VmHostKind; stage: 'none' | 'partial' | 'built'; name: string;
  /** The Proxmox node, or the ESXi host's address. */
  host: string; node: string | null; vmid: number | null; moref: string | null;
  cores: number; memory_mb: number; disk_gb: number;
  ip_mode: 'static' | 'dhcp'; ip_cidr: string | null; gateway: string | null; ip: string | null;
  keep_snapshots: number; created: boolean;
}
export interface VmDefaults {
  cores: number; memory_mb: number; disk_gb: number; keep_snapshots: number;
  limits: Record<'cores' | 'memory_mb' | 'disk_gb' | 'keep_snapshots', [number, number]>;
}
export interface NewVm {
  cores?: number; memory_mb?: number; disk_gb?: number; ip_mode: 'static' | 'dhcp'; ip_cidr?: string; gateway?: string;
}
/** A VM snapshot Sirdar took (GET …/vm-snapshots): `sha` is the commit it holds. */
export interface VmSnapshot {
  name: string; taken_at: string; sha: string | null; deployment_id: string; description: string;
  restorable: boolean; reason: string | null;
}
/** Adopt's answer adds what it read from the target's .env — names only. */
export interface AdoptedEnvironment extends Environment { ignored_keys: string[]; imported_secrets: string[] }
export interface EnvironmentDefaults {
  services: { service: string; port: number; public: boolean }[];
  domain_suffix: string; env_root: string; git_ref: string; bind_ip: string; keep_dumps: number;
  spaces_bucket: string; log_levels: string[]; optional_secrets: string[];
  vm: VmDefaults;
  do: DoDefaults;
  first_admin: { password_min_length: number; role: string; link_minutes: number };
}
export interface NewEnvironmentBody {
  name: string; type: EnvType; target: string; git_ref: string; base_domain?: string;
  /** DigitalOcean sends neither. */
  proxy_ip?: string; bind_ip?: string; ports: Record<string, number>;
  /** The first deploy restores this snapshot. */
  snapshot_id?: string;
  /** An environment that starts empty: its first super admin. */
  first_admin?: NewFirstAdmin;
  /** Deploys publish DNS records and proxy hosts (the API's default: true). */
  publish?: boolean;
  /** a VM target ('proxmox' or 'esxi') only: the VM step 0 builds. */
  vm?: NewVm;
  /** target 'digitalocean' only. */
  do?: NewDo;
}
export interface AdoptEnvironmentBody { name: string; type: EnvType; target: string; git_ref: string }
/** PATCH body: an omitted field is kept; a secret set to "" is cleared. */
export interface EnvironmentPatch {
  git_ref?: string; target?: string; base_domain?: string; proxy_ip?: string; bind_ip?: string;
  keep_dumps?: number; spaces_bucket?: string; log_level?: string;
  services?: Record<string, { port?: number; host_ip?: string; proxied?: boolean }>;
  secrets?: Record<string, string>;
  publish?: boolean;
  vm?: { cores?: number; memory_mb?: number; disk_gb?: number; keep_snapshots?: number };
  /** Production only: mark it retiring, or un-retire it (both need confirm_name). */
  retiring?: boolean; confirm_name?: string;
  auto_activate?: boolean;
  do?: DoSizes;
}
export interface DeploymentBody {
  mode: DeployMode | 'publish' | 'teardown' | 'vm_restore'; git_ref?: string; confirm_name?: string;
  /** VM environments' update / reset / restore_dump: a VM snapshot first (the API's default: yes once deployed). */
  take_vm_snapshot?: boolean;
  /** vm_restore only: a name from listVmSnapshots. */
  vm_snapshot?: string;
  /** Reset only. */
  snapshot_id?: string;
  /** Restore backup only: a file name from listBackups. */
  backup?: string;
  /** DigitalOcean Delete: save a snapshot first (default yes; production always). */
  snapshot?: boolean;
  /** DigitalOcean production Delete: "delete production <name>". */
  confirm_production?: string;
}
export interface RetryBody { from_step?: number; confirm_name?: string; confirm_production?: string }
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
/** Blue/Green: smoke-test `slot` and move the load balancer to it; null deactivates (a retiring production).
 *  Production needs its name typed. */
export const activateSlot = (name: string, slot: string | null, confirmName?: string) =>
  sendJson<Deployment>('POST', `${envPath(name)}/activate`,
    confirmName === undefined ? { slot } : { slot, confirm_name: confirmName });
/** A one-slot environment's second slot; `deployment` deploys the running commit to it (null before any deploy). */
export const addSlot = (name: string) =>
  sendJson<{ environment: Environment; deployment: Deployment | null }>('POST', `${envPath(name)}/slots`);
/** Fix the first admin before step 11 uses it: a new typed password, or switch to an invite. */
export const setFirstAdmin = (name: string, body: NewFirstAdmin) =>
  sendJson<Environment>('PUT', `${envPath(name)}/first-admin`, body);
export const listBackups = (name: string) => getJson<{ backups: Backup[] }>(`${envPath(name)}/backups`);
export const listVmSnapshots = (name: string) =>
  getJson<{ snapshots: VmSnapshot[] }>(`${envPath(name)}/vm-snapshots`);

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
/** The integrations Sirdar publishes with. */
export type PublishKind = 'cloudflare' | 'npm';
/** The hosts Sirdar builds environments' VMs on. */
export type VmHostKind = 'proxmox' | 'esxi';
/** The cloud account the Deploy page and the dashboard read. */
export type CloudKind = 'digitalocean';
export type IntegrationKind = PublishKind | VmHostKind | CloudKind;
export const INTEGRATION_LABEL: Record<IntegrationKind, string> = {
  cloudflare: 'Cloudflare', npm: 'Nginx Proxy Manager', proxmox: 'Proxmox', esxi: 'VMware ESXi',
  digitalocean: 'DigitalOcean',
};
export interface CloudflareIntegration {
  configured: boolean; zone: string | null; public_ip: string | null; token_set: boolean;
  updated_at: string | null; updated_by_name: string | null;
}
export interface NpmIntegration {
  configured: boolean; url: string | null; identity: string | null; letsencrypt_email: string | null;
  password_set: boolean; updated_at: string | null; updated_by_name: string | null;
}
export interface ProxmoxIntegration {
  configured: boolean; url: string | null; node: string | null; pool: string | null; storage: string | null;
  bridge: string | null; vlan_tag: number | null; template_vmid: number | null;
  /** The pinned certificate's SHA-256 fingerprint, AB:CD:… */
  tls_fingerprint: string | null;
  /** user@realm!tokenid — the part of the token that isn't secret. */
  token_id: string | null; token_set: boolean; updated_at: string | null; updated_by_name: string | null;
}
export interface EsxiIntegration {
  configured: boolean; url: string | null; user: string | null; datastore: string | null; network: string | null;
  /** null: the host's root resource pool. */
  resource_pool: string | null;
  /** The powered-off VM whose disk every new VM copies. */
  source_vm: string | null;
  /** Empty: each VM uses its gateway. */
  dns_servers: string[];
  tls_fingerprint: string | null; password_set: boolean; updated_at: string | null; updated_by_name: string | null;
}
/** configured: a token is stored or SIRDAR_DEPLOY_DO_TOKEN is set; token_set: one is stored (it wins). */
export interface DigitalOceanIntegration {
  configured: boolean; token_set: boolean;
  /** Where the token Sirdar uses comes from: Settings (stored), the server's .env, or nowhere. */
  source: 'stored' | 'environment' | null;
  updated_at: string | null; updated_by_name: string | null;
}
export interface Integrations {
  secrets_key_configured: boolean; cloudflare: CloudflareIntegration; npm: NpmIntegration; proxmox: ProxmoxIntegration;
  esxi: EsxiIntegration; digitalocean: DigitalOceanIntegration;
}
/** An omitted secret keeps the stored one. */
export interface CloudflareBody { zone: string; public_ip: string; token?: string }
export interface NpmBody { url: string; identity: string; letsencrypt_email?: string; password?: string }
/** tls_fingerprint: the certificate the user trusted (null: show it first). An omitted token keeps the stored one. */
export interface ProxmoxBody {
  url: string; node: string; pool: string; storage: string; bridge: string; vlan_tag: number | null;
  template_vmid: number; tls_fingerprint: string | null; token?: string;
}
/** tls_fingerprint: the certificate the user trusted (null: show it first). An omitted password keeps the stored one. */
export interface EsxiBody {
  url: string; user: string; datastore: string; network: string; resource_pool: string | null; source_vm: string;
  dns_servers: string[]; tls_fingerprint: string | null; password?: string;
}
/** An omitted token keeps the stored one (a Test then uses the token Sirdar uses). */
export interface DigitalOceanBody { token?: string }
type IntegrationBody = CloudflareBody | NpmBody | ProxmoxBody | EsxiBody | DigitalOceanBody;
/** A VM host's certificate, as tls_untrusted describes it. */
export interface TlsCertificate { fingerprint: string; subject: string; issuer: string; not_after: string; names: string[] }
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
export const saveIntegration = (kind: IntegrationKind, body: IntegrationBody) =>
  sendJson<Integrations>('PUT', integrationPath(kind), body);
export async function removeIntegration(kind: IntegrationKind): Promise<void> {
  const resp = await apiFetch(integrationPath(kind), { method: 'DELETE' });
  if (!resp.ok) throw await errorOf(resp);
}
/** No body: the saved settings. A body: those values unsaved (no secret = the stored one). */
export const testIntegration = (kind: IntegrationKind, body?: IntegrationBody) =>
  sendJson<IntegrationCheck>('POST', `${integrationPath(kind)}/test`, body);
export const getPublishPlan = (name: string) => getJson<PublishPlan>(`${envPath(name)}/publish`);
export const claimPublish = (name: string) =>
  sendJson<PublishPlan & { claimed: string[] }>('POST', `${envPath(name)}/publish/claim`);

/* ---- Dashboard (GET /api/dashboard) ---- */
export interface DashHealth { status: 'healthy' | 'degraded' | 'unknown' | string; label: string }
/** One public hostname's certificate from Sirdar's live TLS check; `error` is set when it couldn't be read. */
export interface DashCertHost { hostname: string; expires_at: string | null; days_left: number | null; error: string | null }
/** The soonest expiry among an environment's public hostnames that answered; tone 'unknown' (dates null) when none did. */
export interface DashCert {
  days_left: number | null; expires_at: string | null; tone: 'ok' | 'warn' | 'bad' | 'unknown' | string;
  hosts: DashCertHost[];
}
export interface DashServer {
  /** A slot ("blue", "orange"…), "host" on the LAN, "none" on a placeholder. */
  id: string; label: string; sub: string;
  state: 'live' | 'idle' | 'empty' | string; health: 'healthy' | 'degraded' | 'unknown' | string;
  version: string | null;
  /** The slot has run a deploy: it can be activated. */
  deployed: boolean;
}
export interface DashFlow {
  kind: 'load_balancer' | 'proxy' | 'none' | string;
  middle: { label: string; sub: string; status: 'ok' | 'warn' | 'down' | 'unknown' | string };
  servers: DashServer[]; active_slot: string | null; certificate: DashCert | null;
  deploying_slot: string | null; failed_slot: string | null;
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
  /** A production environment, or the Production placeholder (a retiring production listed later too). */
  production: boolean;
  /** The Production card: true on the first card only. */
  primary: boolean;
  /** A production environment marked retiring: it can't be activated or deployed. */
  retiring: boolean;
  /** Any deployment of it is running, a renew included (its state may still read active). */
  running: boolean;
  /** The environment's portal address, opened from the spotlight's traffic box; null without one. */
  portal_url: string | null;
  flow: DashFlow;
}
export interface DashNode {
  id: string; name: string;
  kind: 'environment' | 'deployment' | 'group' | 'droplet' | 'database' | 'spaces' | 'load_balancer'
    | 'proxy' | 'server' | 'certificate' | string;
  type_label: string; status: string; status_label: string; region: string; endpoint: string;
  badge: string | null; dot: 'green' | 'gray' | 'blue' | string | null;
  tone: 'shared' | null; children: DashNode[];
}
export interface DashboardData {
  demo: boolean; generated_at: string; health: DashHealth;
  environments: DashEnvironment[];
  infrastructure: {
    source: 'none' | 'digitalocean' | 'demo' | string; error: string | null; tree: DashNode[];
    accounts?: { key: string; label: string; error: string | null }[];
  };
}
export function getDashboard(opts: { demo?: boolean; refresh?: boolean } = {}) {
  const params = new URLSearchParams();
  if (opts.demo) params.set('demo', '1');
  if (opts.refresh) params.set('refresh', '1');
  const qs = params.toString();
  return getJson<DashboardData>(`/dashboard${qs ? `?${qs}` : ''}`);
}

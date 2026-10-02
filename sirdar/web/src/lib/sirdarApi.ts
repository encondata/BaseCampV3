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
  key_path: string | null; password_set: boolean; passphrase_set: boolean;
}
/** Create body; on update every field is optional and a secret that is omitted is kept,
 *  "" is cleared and a value is set. */
export interface SshTargetBody {
  name: string; host: string; port: number; user: string;
  password?: string; key_path?: string; key_passphrase?: string;
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
  not_configured_host: "Only the configured SSH host can be trusted.",
  not_found: 'That host is no longer trusted.',
  target_not_found: 'That target no longer exists.',
  targets_file_unwritable: "Sirdar couldn't save deploy-targets.env. Check that it's writable; see the README.",
  targets_file_unreadable: "Sirdar couldn't read deploy-targets.env. Check that it's valid UTF-8; see the README.",
  source_unavailable: "Couldn't reach the portal database. Nothing was changed.",
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
  id: string; label: string; state: 'active' | 'empty' | string; version: string | null;
  last_release: string | null; action_label: string;
}
export interface DashNode {
  id: string; name: string;
  kind: 'environment' | 'deployment' | 'group' | 'droplet' | 'database' | 'spaces' | 'load_balancer' | string;
  type_label: string; status: string; status_label: string; region: string; endpoint: string;
  badge: string | null; dot: 'green' | 'gray' | 'blue' | string | null; children: DashNode[];
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

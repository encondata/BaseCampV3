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
  source_unavailable: "Couldn't reach the portal database. Nothing was changed.",
};

export function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return MESSAGES[err.code] ?? fallback;
  return fallback;
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

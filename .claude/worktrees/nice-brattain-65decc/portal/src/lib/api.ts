/**
 * API client with the session behavior committed to in the design:
 *
 * - The refresh token lives in an httpOnly cookie scoped to /auth; the
 *   access token lives only in memory here (never in storage — XSS-safe).
 * - Access-token expiry is a NON-EVENT: any 401 triggers exactly one
 *   silent refresh (single-flight, concurrent calls share it) and the
 *   original request retries.
 * - No timer-based refresh (browsers throttle timers in background tabs —
 *   the classic "kicked to login after minimizing" bug). Instead we
 *   refresh on demand and proactively on tab re-focus (visibilitychange).
 * - Only when the 24h absolute session genuinely ends do we notify the
 *   app, which redirects to login gracefully, preserving location.
 */

import type { Action, PermMap, ScopeInfo } from './access';

const API_URL: string =
  (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:8000';

export interface PersonOut {
  id: string;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
  display_name: string;
  email: string | null;
  job_title: string | null;
  avatar_key: string | null;
  avatar_url: string | null;   // presigned, short-lived
}

export interface NotifPrefs {
  critical: boolean;
  email: boolean;
  maint: boolean;
  digest: boolean;
}

export type NamedAccent = 'amber' | 'aqua' | 'blue' | 'violet' | 'pink' | 'green';

export interface UiPreferences {
  accent: string; // NamedAccent or a custom '#rrggbb'
  theme: 'light' | 'dark';
  density: 'comfortable' | 'compact';
  motion: boolean;
  notif: NotifPrefs;
}

export interface PersonDetail {
  id: string;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
  display_name: string;
  email: string | null;
  phone: string | null;
  job_title: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country: string;
  badge_uid: string;
  created_at: string;
  avatar_key: string | null;
  avatar_url: string | null;
}

export interface AttachmentOut {
  id: string;
  entity_type: string;
  entity_id: string;
  kind: string;
  storage_key: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  created_at: string;
  url: string | null;
}

export type ProfileUpdate = Partial<Omit<PersonDetail, 'id' | 'display_name' | 'badge_uid' | 'created_at'>>;

export interface SessionInfo {
  family_id: string;
  started_at: string;
  last_active_at: string;
  expires_at: string;
  ip_address: string | null;
  user_agent: string | null;
  current: boolean;
}

export interface SessionData {
  access_token: string;
  expires_in: number;
  session_expires_at: string;
  person: PersonOut;
  roles: string[];
  must_change_password: boolean;
  preferences: UiPreferences;
  perms: PermMap;
  max_rank: number;
  scope: ScopeInfo;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

async function errorFrom(resp: Response): Promise<ApiError> {
  let code = 'unknown_error';
  try {
    const body = await resp.json();
    code = body?.detail?.code ?? code;
  } catch {
    /* non-JSON error body */
  }
  return new ApiError(resp.status, code);
}

// ── in-memory session state ─────────────────────────────────────────

let accessToken: string | null = null;
let accessTokenExpiresAt = 0; // epoch ms
let sessionExpiresAt: string | null = null;

const sessionEndedListeners = new Set<() => void>();

export function onSessionEnded(listener: () => void): () => void {
  sessionEndedListeners.add(listener);
  return () => sessionEndedListeners.delete(listener);
}

function notifySessionEnded(): void {
  clearLocalSession();
  sessionEndedListeners.forEach((fn) => fn());
}

function storeSession(data: SessionData): void {
  accessToken = data.access_token;
  accessTokenExpiresAt = Date.now() + data.expires_in * 1000;
  sessionExpiresAt = data.session_expires_at;
}

export function clearLocalSession(): void {
  accessToken = null;
  accessTokenExpiresAt = 0;
  sessionExpiresAt = null;
}

export function getSessionExpiresAt(): string | null {
  return sessionExpiresAt;
}

function tokenIsStale(): boolean {
  // refresh a little early so in-flight requests never carry a dying token
  return !accessToken || Date.now() > accessTokenExpiresAt - 30_000;
}

// ── refresh (single-flight) ─────────────────────────────────────────

let refreshInFlight: Promise<SessionData | null> | null = null;

export function refreshSession(): Promise<SessionData | null> {
  refreshInFlight ??= (async () => {
    try {
      const resp = await fetch(`${API_URL}/auth/refresh`, {
        method: 'POST',
        credentials: 'include', // sends the httpOnly refresh cookie
      });
      if (!resp.ok) {
        clearLocalSession();
        return null;
      }
      const data: SessionData = await resp.json();
      storeSession(data);
      return data;
    } catch {
      // network hiccup: keep local state, caller's request will surface it
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

/** Re-focus of an idle/minimized tab: refresh BEFORE data requests fire. */
export function installVisibilityRefresh(): () => void {
  const handler = () => {
    if (document.visibilityState === 'visible' && sessionExpiresAt && tokenIsStale()) {
      void refreshSession();
    }
  };
  document.addEventListener('visibilitychange', handler);
  return () => document.removeEventListener('visibilitychange', handler);
}

// ── authenticated fetch ─────────────────────────────────────────────

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (tokenIsStale()) {
    await refreshSession();
  }

  const doFetch = () =>
    fetch(`${API_URL}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
    });

  let resp = await doFetch();
  if (resp.status === 401) {
    const refreshed = await refreshSession();
    if (refreshed) {
      resp = await doFetch();
    }
    if (!refreshed || resp.status === 401) {
      notifySessionEnded();
    }
  }
  return resp;
}

// ── auth endpoints ──────────────────────────────────────────────────

export async function loginRequest(email: string, password: string): Promise<SessionData> {
  const resp = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include', // receive the refresh cookie
    body: JSON.stringify({ email, password }),
  });
  if (!resp.ok) throw await errorFrom(resp);
  const data: SessionData = await resp.json();
  storeSession(data);
  return data;
}

export async function savePreferencesRequest(prefs: UiPreferences): Promise<void> {
  const resp = await apiFetch('/auth/me/preferences', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(prefs),
  });
  if (!resp.ok) throw await errorFrom(resp);
}

/** Global attachment upload — avatars now; asset photos, documents later.
 *  FormData: the browser sets the multipart boundary itself. */
export async function uploadAttachmentRequest(opts: {
  entityType: 'person' | 'client' | 'partner';
  entityId: string;
  kind: 'avatar' | 'photo' | 'document';
  file: File;
}): Promise<AttachmentOut> {
  const form = new FormData();
  form.set('entity_type', opts.entityType);
  form.set('entity_id', opts.entityId);
  form.set('kind', opts.kind);
  form.set('file', opts.file);
  const resp = await apiFetch('/attachments', { method: 'POST', body: form });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function getProfileRequest(): Promise<PersonDetail> {
  const resp = await apiFetch('/auth/me/profile');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function updateProfileRequest(patch: ProfileUpdate): Promise<PersonDetail> {
  const resp = await apiFetch('/auth/me/profile', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function getSessionsRequest(): Promise<SessionInfo[]> {
  const resp = await apiFetch('/auth/me/sessions');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function revokeSessionRequest(familyId: string): Promise<void> {
  const resp = await apiFetch(`/auth/me/sessions/${familyId}`, { method: 'DELETE' });
  if (!resp.ok && resp.status !== 404) throw await errorFrom(resp);
}

export async function changePasswordRequest(
  currentPassword: string, newPassword: string,
): Promise<void> {
  const resp = await apiFetch('/auth/me/password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
  });
  if (!resp.ok) throw await errorFrom(resp);
}

/* ── admin account actions (Users page) ────────────────────────── */

export async function adminResetPasswordRequest(
  personId: string, tempPassword: string, mustChange: boolean,
): Promise<void> {
  const resp = await apiFetch(`/users/${personId}/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ temp_password: tempPassword, must_change_password: mustChange }),
  });
  if (!resp.ok) throw await errorFrom(resp);
}

export async function adminAccountStateRequest(
  personId: string, action: 'disable' | 'enable' | 'unlock',
): Promise<void> {
  const resp = await apiFetch(`/users/${personId}/${action}`, { method: 'POST' });
  if (!resp.ok) throw await errorFrom(resp);
}

export async function adminSetRolesRequest(
  personId: string, roles: string[],
): Promise<string[]> {
  const resp = await apiFetch(`/users/${personId}/roles`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roles }),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function adminUpdateProfileRequest(
  personId: string, patch: ProfileUpdate,
): Promise<PersonDetail> {
  const resp = await apiFetch(`/users/${personId}/profile`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

/** Slim projection of GET /users for pickers (the Users page reads the
 *  full payload itself). */
export interface UserSummary {
  person_id: string;
  display_name: string;
  login_email: string | null;
  avatar_url: string | null;
}

export async function listUsers(): Promise<UserSummary[]> {
  const resp = await apiFetch('/users');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function logoutRequest(): Promise<void> {
  try {
    await fetch(`${API_URL}/auth/logout`, { method: 'POST', credentials: 'include' });
  } finally {
    clearLocalSession();
  }
}

/* ── access control (Access page) ──────────────────────────────── */

export interface AccessRole {
  name: string; label: string; color: string | null; description: string;
  rank: number; scope_anchor: 'global' | 'client' | 'partner' | 'self';
  is_system: boolean; member_count: number;
  matrix: Record<string, Record<Action, boolean>>;
}

export interface AccessGroupOut {
  id: string; name: string; description: string; icon: string;
  member_count: number;
  members: { person_id: string; display_name: string; avatar_url: string | null }[];
}

export interface AccessResourceOut {
  id: string; label: string; developer_only: boolean;
  always_viewable: boolean; gated_by: string[];
}

export interface AccessSummary {
  stats: {
    members: number; roles: number; groups: number;
    gated_resources: number; overrides: number;
  };
  resources: AccessResourceOut[];
  roles: AccessRole[];
  groups: AccessGroupOut[];
}

export interface EffectiveCell { value: boolean; source: 'role' | 'override' | 'gate' | 'hard_gate' | 'floor' }

export interface EffectiveOut {
  person_id: string; display_name: string; roles: string[]; max_rank: number;
  groups: { id: string; name: string }[];
  scope: ScopeInfo;
  cells: Record<string, Record<Action, EffectiveCell>>;
}

export async function getAccessSummary(): Promise<AccessSummary> {
  const resp = await apiFetch('/access/summary');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function putRoleMatrix(
  name: string, matrix: Record<string, Record<Action, boolean>>,
): Promise<void> {
  const resp = await apiFetch(`/access/roles/${name}/matrix`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ matrix }),
  });
  if (!resp.ok) throw await errorFrom(resp);
}

export async function cloneRole(
  body: { source: string; name: string; label: string; rank: number },
): Promise<void> {
  const resp = await apiFetch('/access/roles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
}

export async function deleteRole(name: string): Promise<void> {
  const resp = await apiFetch(`/access/roles/${name}`, { method: 'DELETE' });
  if (!resp.ok) throw await errorFrom(resp);
}

export async function createAccessGroup(
  body: { name: string; description?: string; icon?: string },
): Promise<{ id: string }> {
  const resp = await apiFetch('/access/groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function deleteAccessGroup(id: string): Promise<void> {
  const resp = await apiFetch(`/access/groups/${id}`, { method: 'DELETE' });
  if (!resp.ok) throw await errorFrom(resp);
}

export async function setGroupMembers(id: string, personIds: string[]): Promise<void> {
  const resp = await apiFetch(`/access/groups/${id}/members`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ person_ids: personIds }),
  });
  if (!resp.ok) throw await errorFrom(resp);
}

export async function setResourceGates(resource: string, groupIds: string[]): Promise<void> {
  const resp = await apiFetch(`/access/resources/${resource}/gates`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ group_ids: groupIds }),
  });
  if (!resp.ok) throw await errorFrom(resp);
}

export async function getOverrides(
  personId: string,
): Promise<{ overrides: Record<string, Record<Action, boolean>> }> {
  const resp = await apiFetch(`/access/overrides/${personId}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function putOverrides(
  personId: string, overrides: Record<string, Record<Action, boolean | null>>,
): Promise<void> {
  const resp = await apiFetch(`/access/overrides/${personId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ overrides }),
  });
  if (!resp.ok) throw await errorFrom(resp);
}

export async function getEffective(personId: string): Promise<EffectiveOut> {
  const resp = await apiFetch(`/access/effective/${personId}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

/** Slim org projection (id/name) for resolving a scope's client/partner
 *  ids to display names — Explorer tab's "Sees: {org names}" line. */
export interface OrgRef { id: string; name: string }

export async function listClients(): Promise<OrgRef[]> {
  const resp = await apiFetch('/clients');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function listPartners(): Promise<OrgRef[]> {
  const resp = await apiFetch('/partners');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

/** Full /users payload (Members tab needs roles + rank per person — richer
 *  than the slim UserSummary projection used by pickers). */
export interface MemberItem {
  person_id: string;
  display_name: string;
  job_title: string | null;
  login_email: string | null;
  status: string;
  roles: string[];
  max_rank: number;
  avatar_url: string | null;
}

export async function listMembers(): Promise<MemberItem[]> {
  const resp = await apiFetch('/users');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function setUserRoles(personId: string, roles: string[]): Promise<string[]> {
  return adminSetRolesRequest(personId, roles);
}

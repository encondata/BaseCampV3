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

// Default: same host the portal was loaded from, port 8000 — so LAN devices
// (phone/laptop hitting the dev box's IP) reach the API without extra config.
// Read per-request, never at import: module scope runs in test/SSR contexts
// where `window` does not exist, and reading it there breaks every importer.
export function apiUrl(): string {
  return (
    (import.meta.env.VITE_API_URL as string | undefined) ??
    `http://${window.location.hostname}:8000`
  );
}

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
  password_updated_at: string | null;
}

export interface MyActivityItem {
  id: string;
  at: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  ip: string | null;
  by_me: boolean;
  actor_name: string | null;
  changes: Record<string, unknown>;
  entity_name: string | null;
  entity_summary: Record<string, string>;
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
  password_min_length: number;
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
      const resp = await fetch(`${apiUrl()}/auth/refresh`, {
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
    fetch(`${apiUrl()}${path}`, {
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
  const resp = await fetch(`${apiUrl()}/auth/login`, {
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
  entityType: 'person' | 'client' | 'partner' | 'asset';
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

export async function getMyActivityRequest(): Promise<MyActivityItem[]> {
  const resp = await apiFetch('/auth/me/activity');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

// ── audit log (admin viewer) ────────────────────────────────────────

export interface AuditLogItem {
  id: string;
  at: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  ip: string | null;
  actor_id: string | null;
  actor_name: string | null;
  changes: Record<string, unknown>;
  entity_name: string | null;
  entity_summary: Record<string, string>;
}

export interface AuditQuery {
  entity_type?: string;
  action?: string;
  actor_id?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

export async function listAuditLog(query: AuditQuery): Promise<AuditLogItem[]> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const resp = await apiFetch(`/audit?${params.toString()}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function getAuditFacets(): Promise<{
  entity_types: string[]; actions: string[];
}> {
  const resp = await apiFetch('/audit/facets');
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

/** Create a login account for an EXISTING person (no-account external
 *  contacts promoted to portal users). */
export async function adminCreateAccountRequest(
  personId: string,
  body: { login_email: string; temp_password: string; must_change_password: boolean },
): Promise<void> {
  const resp = await apiFetch(`/users/${personId}/account`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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
    await fetch(`${apiUrl()}/auth/logout`, { method: 'POST', credentials: 'include' });
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
 *  ids to display names — Explorer tab's "Sees: {org names}" line.
 *  `archived_at` rides along on the raw /clients and /partners payloads
 *  (see External.tsx's loadAllOrgs) so callers that need to exclude
 *  archived orgs — e.g. a filter facet — don't need a second fetch. */
export interface OrgRef { id: string; name: string; archived_at?: string | null }

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

/* ── external directory (client/partner contacts + external role) ── */

export type ContactTier = 'owner' | 'admin' | 'viewer';
export type OrgKind = 'client' | 'partner';

export interface ExternalLinkItem {
  kind: OrgKind;
  org_id: string;
  org_name: string;
  tier: ContactTier;
  org_title: string | null;
  functions: string[];
}

export interface ExternalPersonItem {
  person_id: string;
  display_name: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  avatar_url: string | null;
  has_login: boolean;
  login_status: 'none' | 'active' | 'disabled';
  links: ExternalLinkItem[];
}

export interface ExternalDirectoryOut {
  people: ExternalPersonItem[];
  function_tags: string[];
}

export async function getExternal(): Promise<ExternalDirectoryOut> {
  const resp = await apiFetch('/external');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

function orgContactsBase(kind: OrgKind): string {
  return kind === 'client' ? '/clients' : '/partners';
}

export async function addContactLink(
  kind: OrgKind, orgId: string, personId: string, tier: ContactTier,
): Promise<void> {
  const resp = await apiFetch(`${orgContactsBase(kind)}/${orgId}/contacts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ person_id: personId, tier }),
  });
  if (!resp.ok) throw await errorFrom(resp);
}

export interface ContactUpdatePatch {
  tier?: ContactTier;
  org_title?: string | null;
  functions?: string[];
}

export async function patchContactLink(
  kind: OrgKind, orgId: string, personId: string, patch: ContactUpdatePatch,
): Promise<{ status: string; tier: ContactTier; org_title: string | null; functions: string[] }> {
  const resp = await apiFetch(`${orgContactsBase(kind)}/${orgId}/contacts/${personId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function removeContactLink(
  kind: OrgKind, orgId: string, personId: string,
): Promise<void> {
  const resp = await apiFetch(`${orgContactsBase(kind)}/${orgId}/contacts/${personId}`,
    { method: 'DELETE' });
  if (!resp.ok && resp.status !== 404) throw await errorFrom(resp);
}

/* ── sites (facilities) ──────────────────────────────────────────── */

export interface ClientRef { client_id: string; name: string }

export interface SiteItem {
  id: string; name: string; code: string | null;
  site_type: string | null; type_label: string | null; type_color: string | null;
  status: string; status_label: string; status_color: string;
  address_line1: string | null; address_line2: string | null;
  city: string | null; region: string | null; postal_code: string | null;
  country: string; latitude: number | null; longitude: number | null;
  timezone: string | null; dc_provider: string | null;
  partner_id: string | null; partner_name: string | null;
  notes: string | null; archived_at: string | null; created_at: string;
  clients: ClientRef[];
}

export interface SiteDetailOut extends SiteItem { survey_data: Record<string, unknown> }

export interface SiteLookup {
  key: string; label: string; description: string;
  sort_order: number; icon: string | null; color: string | null;
}

export interface SurveyFieldDef {
  key: string; label: string;
  kind: 'text' | 'textarea' | 'bool' | 'int' | 'select';
  options: string[];
}

export interface SurveySchema { groups: { key: string; label: string; fields: SurveyFieldDef[] }[] }

export async function listSites(): Promise<SiteItem[]> {
  const resp = await apiFetch('/sites');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function getSite(id: string): Promise<SiteDetailOut> {
  const resp = await apiFetch(`/sites/${id}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function createSite(body: Record<string, unknown>): Promise<SiteDetailOut> {
  const resp = await apiFetch('/sites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function updateSite(
  id: string, body: Record<string, unknown>,
): Promise<SiteDetailOut> {
  const resp = await apiFetch(`/sites/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function archiveSite(id: string, archived: boolean): Promise<void> {
  const resp = await apiFetch(
    `/sites/${id}/${archived ? 'archive' : 'unarchive'}`, { method: 'POST' });
  if (!resp.ok) throw await errorFrom(resp);
}

export async function setSiteClients(id: string, clientIds: string[]): Promise<void> {
  const resp = await apiFetch(`/sites/${id}/clients`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_ids: clientIds }),
  });
  if (!resp.ok) throw await errorFrom(resp);
}

export async function saveSiteSurvey(
  id: string, data: Record<string, unknown>,
): Promise<SiteDetailOut> {
  const resp = await apiFetch(`/sites/${id}/survey`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ survey_data: data }),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function getSurveySchema(): Promise<SurveySchema> {
  const resp = await apiFetch('/sites/survey-schema');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

// ── sites bulk import ───────────────────────────────────────────────

export interface BulkRowResult {
  row: number;
  name: string | null;
  action: 'create' | 'update' | 'unchanged' | 'error';
  errors: string[];
  diff: Record<
    string,
    { old?: unknown; new?: unknown; add?: string[]; remove?: string[] }
  > | null;
  site_id: string | null;
  data: Record<string, unknown> | null;
}

export interface BulkPreview {
  rows: BulkRowResult[];
  can_commit: boolean;
  update_allowed: boolean;
}

export async function getSiteBulkSample(): Promise<Record<string, string>[]> {
  const resp = await apiFetch('/sites/bulk-import/template?format=json');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

/** Pasted JSON rides the same multipart path as a real file: the caller
 * wraps it in a Blob named paste.json, so the API has one parsing entry. */
export async function previewSiteBulk(
  file: File | Blob, filename: string,
): Promise<BulkPreview> {
  const fd = new FormData();
  fd.append('file', file, filename);
  // no Content-Type header — the browser sets the multipart boundary
  const resp = await apiFetch('/sites/bulk-import/preview', {
    method: 'POST',
    body: fd,
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function commitSiteBulk(
  rows: Record<string, unknown>[], approved: string[], source: string,
): Promise<{ created: number; updated: number; unchanged: number }> {
  const resp = await apiFetch('/sites/bulk-import/commit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows, approved_updates: approved, source }),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function downloadSiteTemplate(format: 'csv' | 'xlsx'): Promise<void> {
  const resp = await apiFetch(`/sites/bulk-import/template?format=${format}`);
  if (!resp.ok) throw await errorFrom(resp);
  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sites-template.${format}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function listSiteTypes(): Promise<SiteLookup[]> {
  const resp = await apiFetch('/site-types');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

/** The site picker's statuses. Server filters to is_active and omits counts.
 *  SiteLookup is reused so existing callers need no change, but /status-values
 *  carries no `icon` (that's a site-TYPE concept) — don't read `.icon` here. */
export async function listSiteStatuses(): Promise<SiteLookup[]> {
  const resp = await apiFetch('/status-values?record_type=site');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export interface StatusValue {
  record_type: string;
  key: string;
  label: string;
  description: string;
  color: string;
  sort_order: number;
  is_active: boolean;
  usage_count: number | null;
}

/** The Workers page's status vocabulary — filter facet and edit select.
 *  Chips do NOT come from here: /workers denormalises status_label/status_color
 *  onto every row, as /sites does. Server filters to is_active, so a worker on a
 *  retired status is absent — see ProfileForm, which seeds it back from the row. */
export async function listWorkerStatuses(): Promise<StatusValue[]> {
  const resp = await apiFetch('/status-values?record_type=worker');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

/** PUT /workers/{id}/profile (routes/workers.py:upsert_profile) is a partial
 *  upsert — `exclude_unset=True` server-side means only the keys present in
 *  `body` are touched, so a single-field body (as god-edit sends) is a safe
 *  1:1 PATCH-equivalent despite the PUT verb. Returns 204 with no body, so
 *  callers reconstruct the updated row themselves — see lib/workers.ts's
 *  applyWorkerPatch. */
export async function updateWorkerProfile(
  id: string, body: Record<string, unknown>,
): Promise<void> {
  const resp = await apiFetch(`/workers/${id}/profile`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
}

// The Variables page's view: every record type, including inactive, with counts.
export async function listStatusValues(): Promise<StatusValue[]> {
  const resp = await apiFetch('/status-values');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function createStatusValue(
  body: Record<string, unknown>,
): Promise<StatusValue> {
  const resp = await apiFetch('/status-values', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function updateStatusValue(
  recordType: string, key: string, body: Record<string, unknown>,
): Promise<StatusValue> {
  const resp = await apiFetch(`/status-values/${recordType}/${key}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function updateSiteType(
  key: string, body: Record<string, unknown>,
): Promise<SiteLookup> {
  const resp = await apiFetch(`/site-types/${key}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export interface WorkerLevel {
  level: string;
  rank: number;
  title: string;
  description: string;
  expected_skills: string[];
  color: string;
}

export async function listWorkerLevels(): Promise<WorkerLevel[]> {
  const resp = await apiFetch('/worker-levels');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function updateWorkerLevel(
  level: string, body: Record<string, unknown>,
): Promise<WorkerLevel> {
  const resp = await apiFetch(`/worker-levels/${level}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function createSiteType(
  body: Record<string, unknown>,
): Promise<SiteLookup> {
  const resp = await apiFetch('/site-types', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function createWorkerLevel(
  body: Record<string, unknown>,
): Promise<WorkerLevel> {
  const resp = await apiFetch('/worker-levels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

/* ── assets ───────────────────────────────────────────────────────── */

export interface AssetModelRef {
  id: string; make: string; model: string;
  category: string | null; category_label: string | null;
  category_color: string | null; ru_size: number | null;
}

export interface AssetItem {
  id: string; serial_number: string | null; name: string | null;
  rfid_tag: string | null; model_id: string | null; model: AssetModelRef | null;
  client_id: string | null; client_name: string | null;
  site_id: string | null; site_name: string | null;
  location_detail: string; status: string; status_label: string;
  status_color: string; has_rails: boolean | null;
  last_seen_at: string | null; archived_at: string | null; created_at: string;
}

export interface AssetModelItem {
  id: string; make: string; model: string;
  category: string | null; category_label: string | null;
  category_color: string | null; ru_size: number | null;
  weight_lbs: number | null; weight_kg: number | null;
  length_in: number | null; width_in: number | null; height_in: number | null;
  length_cm: number | null; width_cm: number | null; height_cm: number | null;
  mount_type: string | null; rail_type: string | null;
  knowledge: string; aliases: string[]; created_at: string; updated_at: string;
}

export interface AssetCategoryOut {
  key: string; label: string; description: string;
  sort_order: number; color: string;
}

export interface NoteOut {
  id: string; entity_type: string; entity_id: string; body: string;
  created_by: string | null; author_name: string | null;
  created_at: string; updated_at: string;
}

export async function listAssets(): Promise<AssetItem[]> {
  const resp = await apiFetch('/assets');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function createAsset(body: Record<string, unknown>): Promise<AssetItem> {
  const resp = await apiFetch('/assets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function updateAsset(
  id: string, body: Record<string, unknown>,
): Promise<AssetItem> {
  const resp = await apiFetch(`/assets/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function archiveAsset(id: string, archived: boolean): Promise<void> {
  const resp = await apiFetch(
    `/assets/${id}/${archived ? 'archive' : 'unarchive'}`, { method: 'POST' });
  if (!resp.ok) throw await errorFrom(resp);
}

export async function listAssetStatuses(): Promise<StatusValue[]> {
  const resp = await apiFetch('/status-values?record_type=asset');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function listAssetModels(): Promise<AssetModelItem[]> {
  const resp = await apiFetch('/asset-models');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function createAssetModel(
  body: Record<string, unknown>,
): Promise<AssetModelItem> {
  const resp = await apiFetch('/asset-models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function updateAssetModel(
  id: string, body: Record<string, unknown>,
): Promise<AssetModelItem> {
  const resp = await apiFetch(`/asset-models/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function setAssetModelAliases(
  id: string, aliases: string[],
): Promise<AssetModelItem> {
  const resp = await apiFetch(`/asset-models/${id}/aliases`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ aliases }),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function listAssetCategories(): Promise<AssetCategoryOut[]> {
  const resp = await apiFetch('/asset-categories');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function createAssetCategory(
  body: Record<string, unknown>,
): Promise<AssetCategoryOut> {
  const resp = await apiFetch('/asset-categories', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function updateAssetCategory(
  key: string, body: Record<string, unknown>,
): Promise<AssetCategoryOut> {
  const resp = await apiFetch(`/asset-categories/${key}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function listNotes(entityType: string, entityId: string): Promise<NoteOut[]> {
  const resp = await apiFetch(`/notes?entity_type=${entityType}&entity_id=${entityId}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function createNote(
  entityType: string, entityId: string, body: string,
): Promise<NoteOut> {
  const resp = await apiFetch('/notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entity_type: entityType, entity_id: entityId, body }),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function updateNote(id: string, body: string): Promise<NoteOut> {
  const resp = await apiFetch(`/notes/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function deleteNote(id: string): Promise<void> {
  const resp = await apiFetch(`/notes/${id}`, { method: 'DELETE' });
  if (!resp.ok) throw await errorFrom(resp);
}

/** NEW: no list method existed for attachments before assets needed a
 *  panel view — GET /attachments?entity_type=&entity_id= (mirrors the
 *  notes list query shape; matches attachments.py's list_attachments). */
export async function listAttachments(
  entityType: string, entityId: string,
): Promise<AttachmentOut[]> {
  const resp = await apiFetch(
    `/attachments?entity_type=${entityType}&entity_id=${entityId}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function deleteAttachment(id: string): Promise<void> {
  const resp = await apiFetch(`/attachments/${id}`, { method: 'DELETE' });
  if (!resp.ok) throw await errorFrom(resp);
}

/* ── god mode (developer easter egg) ─────────────────────────────── */

/** Returns the nav colour on success, or null when refused. A refusal is
 *  indistinguishable from a wrong word by design — the caller must not
 *  surface it, or it becomes the signal the 404 exists to avoid. */
export async function unlockGodMode(word: string): Promise<string | null> {
  const resp = await apiFetch('/devtools/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ word }),
  });
  if (!resp.ok) return null;
  const data: { nav_color: string } = await resp.json();
  return data.nav_color;
}

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

import type { TagKey } from '../labels/tagTypes';
import type { Action, PermMap, ScopeInfo } from './access';
import type { OrgItem } from './orgs';
import { siblingOrigin } from './siblingOrigin';
import type { WorkerItem } from './workers';

// Default: same host the portal was loaded from, port 8000 — so LAN devices
// (phone/laptop hitting the dev box's IP) reach the API without extra config.
// Read per-request, never at import: module scope runs in test/SSR contexts
// where `window` does not exist, and reading it there breaks every importer.
export function apiUrl(): string {
  return (
    (import.meta.env.VITE_API_URL as string | undefined) ??
    // portal.dev.serversherpa.com → https://api.dev.serversherpa.com, so one
    // build serves any of the subdomain stacks; localhost and LAN IPs fall
    // through to the port below. See lib/siblingOrigin.ts.
    siblingOrigin('api', window.location) ??
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

export type NotificationSound = 'none' | 'chime' | 'ping' | 'pop' | 'bell';

export interface NotifPrefs {
  critical: boolean;
  email: boolean;
  maint: boolean;
  digest: boolean;
  sound: NotificationSound; // in-app sound for new inbox items
}

export type NamedAccent = 'amber' | 'aqua' | 'blue' | 'violet' | 'pink' | 'green';

export interface UiPreferences {
  accent: string; // NamedAccent or a custom '#rrggbb'
  theme: 'light' | 'dark';
  density: 'comfortable' | 'compact';
  list_size: 'small' | 'default' | 'large' | 'xlarge';
  motion: boolean;
  nav_mode: 'expanded' | 'rail' | 'hidden';
  nav_bg: string; // 'default' or a custom '#rrggbb'
  nav_size: 'small' | 'default' | 'large' | 'xlarge';
  notif: NotifPrefs;
  // Per-page list UI state (visible columns, sort, column filters), keyed by
  // page key — free-form on the wire; lib/columnMenu.tsx owns the shape it
  // reads/writes here and sanitizes on hydrate, so this stays loosely typed.
  list_prefs: Record<string, unknown>;
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

export const READ_ONLY_MESSAGE =
  "The portal is in read-only maintenance mode — changes are disabled until it's lifted.";

export class ApiError extends Error {
  // `detail` is the raw FastAPI error-detail object (e.g. { code, conflicts }
  // for the container-membership 409) — callers that need more than `code`
  // narrow it themselves, same as ContainerEditModal's mapError does.
  constructor(public status: number, public code: string, public detail?: unknown,
              message?: string) {
    super(message ?? code);
  }
}

async function errorFrom(resp: Response): Promise<ApiError> {
  let code = 'unknown_error';
  let detail: unknown;
  try {
    const body = await resp.json();
    detail = body?.detail;
    code = body?.detail?.code ?? code;
  } catch {
    /* non-JSON error body */
  }
  if (code === 'read_only_mode') {
    // the banner is the primary signal — make sure it appears at once
    refreshSystemStatus();
    return new ApiError(resp.status, code, detail, READ_ONLY_MESSAGE);
  }
  return new ApiError(resp.status, code, detail);
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

// ── public system status refresh bus (banners) ──────────────────────
const statusRefreshListeners = new Set<() => void>();

export function onSystemStatusRefresh(listener: () => void): () => void {
  statusRefreshListeners.add(listener);
  return () => statusRefreshListeners.delete(listener);
}

export function refreshSystemStatus(): void {
  statusRefreshListeners.forEach((fn) => fn());
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

/** Global attachment upload — avatars, asset photos, documents, plus the
 *  Site & Move Survey report's `survey_template` (report-definition-only
 *  xlsx — the template a run fills; NOT on partners) and `report_asset`
 *  (also report-definition-only, docx/pdf, e.g. the Transportation
 *  Standards document). FormData: the browser sets the multipart boundary
 *  itself. */
export async function uploadAttachmentRequest(opts: {
  entityType: 'person' | 'client' | 'partner' | 'asset' | 'report_definition';
  entityId: string;
  kind: 'avatar' | 'photo' | 'document' | 'survey_template' | 'report_asset';
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

/* ── user detail page (GET /users/{id}) ────────────────────────── */

export interface PersonRef { id: string; display_name: string }
export interface OrgRefOut { kind: 'client' | 'partner'; id: string; name: string }

export interface UserDetailPerson extends PersonDetail {
  source: string;
  source_ref: string | null;
  archived_at: string | null;
}

export interface UserDetailAccount {
  login_email: string | null;
  status: string;
  must_change_password: boolean;
  last_login_at: string | null;
  created_at: string;
  password_updated_at: string | null;
}

export interface UserRoleGrant {
  role: string; label: string; rank: number; scope_anchor: string;
  org: OrgRefOut | null; granted_by: PersonRef | null; granted_at: string;
}

export interface UserWorkerCard {
  trade: string | null; level: string | null; level_title: string | null;
  level_color: string | null; partner: { id: string; name: string } | null;
  status: string; status_label: string; status_color: string;
}

export interface UserNotificationGroup {
  id: string; name: string; channels: string[]; added_at: string;
}

export interface UserAccessGroupRow {
  id: string; name: string; description: string; gate_count: number;
  gated_pages: string[]; added_by: PersonRef | null; added_at: string;
}

export interface UserOverrideRow {
  resource: string; resource_label: string; action: string; allow: boolean;
  set_by: PersonRef | null; set_at: string;
}

export interface UserAccessBlock {
  groups: UserAccessGroupRow[];
  overrides: UserOverrideRow[];
  scope: ScopeInfo;
  scope_orgs: OrgRefOut[];
  cells: Record<string, Record<Action, EffectiveCell>>;
}

export interface UserSessionRow {
  family_id: string; started_at: string; last_active_at: string; expires_at: string;
  ip_address: string | null; user_agent: string | null;
}

export interface UserDetailOut {
  person: UserDetailPerson;
  account: UserDetailAccount;
  roles: UserRoleGrant[];
  max_rank: number;
  worker: UserWorkerCard | null;
  notification_groups: UserNotificationGroup[];
  access: UserAccessBlock | null;
  sessions: UserSessionRow[] | null;
}

export async function getUserDetail(personId: string): Promise<UserDetailOut> {
  const resp = await apiFetch(`/users/${personId}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function getUserActivity(personId: string): Promise<MyActivityItem[]> {
  const resp = await apiFetch(`/users/${personId}/activity`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function setUserAccessGroups(
  personId: string, groupIds: string[],
): Promise<string[]> {
  const resp = await apiFetch(`/users/${personId}/access-groups`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ group_ids: groupIds }),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return (await resp.json()).group_ids as string[];
}

export async function revokeAllUserSessions(personId: string): Promise<void> {
  const resp = await apiFetch(`/users/${personId}/sessions/revoke-all`, { method: 'POST' });
  if (!resp.ok) throw await errorFrom(resp);
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
export interface OrgRef {
  id: string; name: string; archived_at?: string | null;
  /** partners only: free-form function tags ("Logistics", "Cable", …) */
  partner_types?: string[];
}

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

/** GET /clients|partners/{id} — one org row, same OrgItem shape the
 *  directory list (lib/orgs.ts) already renders. Used by StakeholderDetail
 *  to load the org this page is about, distinctly from the list fetch. */
export async function getOrg(kind: OrgKind, id: string): Promise<OrgItem> {
  const resp = await apiFetch(`${orgContactsBase(kind)}/${id}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

/** A person linked to an organization via a scoped role grant — mirrors
 *  OrgDirectory.tsx's page-local ContactItem field-for-field (kept as a
 *  separate declaration there since that page doesn't import this one). */
export interface ContactItem {
  person_id: string;
  display_name: string;
  email: string | null;
  phone: string | null;
  job_title: string | null;
  avatar_url: string | null;
  has_account: boolean;
  granted_at: string;
  tier: ContactTier;
  org_title: string | null;
  functions: string[];
}

export async function listOrgContacts(kind: OrgKind, id: string): Promise<ContactItem[]> {
  const resp = await apiFetch(`${orgContactsBase(kind)}/${id}/contacts`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

/** GET /partners/{id}/workers — crews supplied by this partner (same
 *  WorkerItem shape /workers returns; see OrgDirectory.tsx's SuppliedWorker,
 *  a slimmer page-local read of the same endpoint). */
export async function listPartnerWorkers(id: string): Promise<WorkerItem[]> {
  const resp = await apiFetch(`/partners/${id}/workers`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
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

export type SiteDetailOut = SiteItem;

export interface SiteSurveyRow {
  field_key: string; label: string; group: string; group_label: string;
  kind: 'text' | 'textarea' | 'bool' | 'int' | 'select';
  options: string[];
  value: boolean | number | string | null;
  raw_id: number | null;
  updated_by: string | null;
  updated_by_name: string | null;
  updated_at: string | null;
}

export interface RawSurveyRow {
  id: number; field_key: string; registered: boolean;
  value: boolean | number | string | null;
  captured_at: string;
  submitted_by: string | null;
  submitted_by_name: string | null;
  device_id: string; source: string; created_at: string;
}

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

export async function listSiteSurvey(siteId: string): Promise<SiteSurveyRow[]> {
  const resp = await apiFetch(`/sites/${siteId}/survey`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function listSiteSurveyRaw(siteId: string): Promise<RawSurveyRow[]> {
  const resp = await apiFetch(`/sites/${siteId}/survey/raw`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function putSiteSurveyValue(
  siteId: string, fieldKey: string, value: boolean | number | string | null,
): Promise<SiteSurveyRow> {
  const resp = await apiFetch(`/sites/${siteId}/survey/${fieldKey}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function clearSiteSurveyValue(siteId: string, fieldKey: string): Promise<void> {
  const resp = await apiFetch(`/sites/${siteId}/survey/${fieldKey}`, { method: 'DELETE' });
  if (!resp.ok) throw await errorFrom(resp);
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
  progress_weight: number | null;
}

/** GET /workers — the full worker-directory projection (same shape the
 *  Workers page's row and this fetcher's `WorkerItem` describe). There is no
 *  single-worker GET; a detail page loads this list and finds its row by
 *  `person_id`, mirroring how MoveAssetDetail reads its row off the roster
 *  list rather than a dedicated endpoint. */
export async function listWorkers(): Promise<WorkerItem[]> {
  const resp = await apiFetch('/workers');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export interface CertItem {
  id: string;
  name: string;
  issuer: string | null;
  issued_on: string | null;
  expires_on: string | null;
}

export async function listWorkerCertifications(personId: string): Promise<CertItem[]> {
  const resp = await apiFetch(`/workers/${personId}/certifications`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
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
/** One entry of the API's frozen status-record-type registry — every entity
 *  that carries a status vocabulary. Served by the API so the Variables
 *  editor offers new record types the moment a deploy adds them. */
export interface StatusRecordType {
  id: string; label: string; resource: string; array: boolean;
}

export async function listStatusRecordTypes(): Promise<StatusRecordType[]> {
  const resp = await apiFetch('/status-values/record-types');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

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
  id: string; legacy_id: number | null; serial_number: string | null; name: string | null;
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

export async function getAsset(id: string): Promise<AssetItem> {
  const resp = await apiFetch(`/assets/${id}`);
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

/* ── containers ───────────────────────────────────────────────────── */

export interface ContainerItem {
  id: string; name: string; rfid_tag: string | null;
  container_type: string | null; type_label: string | null;
  type_color: string | null;
  status: string; status_label: string; status_color: string;
  site_id: string | null; site_name: string | null;
  location_detail: string; asset_count: number;
  last_audit_at: string | null; last_validated_at: string | null;
  archived_at: string | null; created_at: string;
  // Optional (rather than required) so existing `ContainerItem` fixtures
  // elsewhere in the codebase — outside this task's file scope — keep
  // compiling unchanged; the API always returns both (migration 0057).
  initiative_id?: string | null; initiative_name?: string | null;
  // Same optional-field precedent as initiative_id above (migration
  // 0058): the API always returns it, but fixtures elsewhere in the
  // codebase that predate this field shouldn't have to add it to compile.
  label_tag?: TagKey | null;
}

export interface ContainerAssetRow {
  asset_id: string; serial_number: string | null; name: string | null;
  model_name: string | null;
  status: string; status_label: string; status_color: string;
  added_at: string; added_by_name: string | null;
}

export async function listContainers(
  params: { initiative_id?: string } = {},
): Promise<ContainerItem[]> {
  const qs = new URLSearchParams();
  if (params.initiative_id) qs.set('initiative_id', params.initiative_id);
  const query = qs.toString();
  const resp = await apiFetch(`/containers${query ? `?${query}` : ''}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function createContainer(
  body: Record<string, unknown>,
): Promise<ContainerItem> {
  const resp = await apiFetch('/containers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function updateContainer(
  id: string, body: Record<string, unknown>,
): Promise<ContainerItem> {
  const resp = await apiFetch(`/containers/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function archiveContainer(
  id: string, archived: boolean,
): Promise<void> {
  const resp = await apiFetch(
    `/containers/${id}/${archived ? 'archive' : 'unarchive'}`,
    { method: 'POST' });
  if (!resp.ok) throw await errorFrom(resp);
}

export async function listContainerStatuses(): Promise<StatusValue[]> {
  const resp = await apiFetch('/status-values?record_type=container');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function listContainerTypes(): Promise<StatusValue[]> {
  const resp = await apiFetch('/status-values?record_type=container_type');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function listContainerAssets(
  id: string,
): Promise<ContainerAssetRow[]> {
  const resp = await apiFetch(`/containers/${id}/assets`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function addContainerAssets(
  id: string, assetIds: string[],
): Promise<ContainerAssetRow[]> {
  const resp = await apiFetch(`/containers/${id}/assets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ asset_ids: assetIds }),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function removeContainerAsset(
  id: string, assetId: string,
): Promise<void> {
  const resp = await apiFetch(`/containers/${id}/assets/${assetId}`,
    { method: 'DELETE' });
  if (!resp.ok) throw await errorFrom(resp);
}

export interface ContainerBulkRow {
  row: number; action: 'create' | 'error';
  data: Record<string, unknown>; errors: string[];
}

export async function previewContainerBulk(
  rows: Record<string, unknown>[],
): Promise<{ rows: ContainerBulkRow[] }> {
  const resp = await apiFetch('/containers/bulk-import/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows }),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function commitContainerBulk(
  rows: Record<string, unknown>[],
): Promise<{ created: number }> {
  const resp = await apiFetch('/containers/bulk-import/commit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows }),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function downloadContainerTemplate(): Promise<Blob> {
  const resp = await apiFetch('/containers/bulk-import/template?fmt=csv');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.blob();
}

/** `BulkContainersModal`'s numbered-batch create — distinct from the
 *  CSV/XLSX `bulk-import` flow above (`previewContainerBulk`/
 *  `commitContainerBulk`): one call, all-or-nothing (a `name_collision`
 *  422 carries `detail.names` and creates nothing). */
export async function bulkCreateContainers(body: {
  count: number;
  container_type: string;
  naming: { prefix: string; start: number; pad: number; suffix: string };
  initiative_id: string | null;
  site_id: string | null;
  status: string | null;
  tags: Record<string, number>;
}): Promise<{ created: ContainerItem[] }> {
  const resp = await apiFetch('/containers/bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

/* ── trucks ───────────────────────────────────────────────────────── */

export interface TruckLastUpdate {
  recorded_at: string;
  lat: number | null;
  lng: number | null;
  approximate_address: string;
}

export interface TruckItem {
  id: string;
  legacy_id: number | null;
  name: string;
  driver_name: string | null;
  co_driver_name: string | null;
  team_drive: boolean;
  contact_info: string;
  status: string;
  status_label: string;
  status_color: string;
  load_number: string | null;
  seal_id: string | null;
  tracking_type: Record<string, unknown>;
  initiative_id: string | null;
  initiative_name: string | null;
  start_site_id: string | null;
  start_site_name: string | null;
  end_site_id: string | null;
  end_site_name: string | null;
  container_count: number;
  last_update: TruckLastUpdate | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TruckContainerRow {
  id: string;
  name: string;
  status: string;
  status_label: string;
  status_color: string;
  asset_count: number;
}

export interface TruckDetail extends TruckItem {
  containers: TruckContainerRow[];
}

export interface TruckUpdate {
  id: string;
  truck_id: string;
  recorded_at: string;
  location: string;
  lat: number | null;
  lng: number | null;
  approximate_address: string;
  source: string;
}

export interface TruckTrailPoint {
  recorded_at: string;
  lat: number;
  lng: number;
}

export interface TruckMapPoint {
  id: string;
  name: string;
  status: string;
  status_label: string;
  status_color: string;
  driver_name: string | null;
  load_number: string | null;
  seal_id: string | null;
  last_update: TruckLastUpdate;
  trail: TruckTrailPoint[];
}

export async function listTrucks(includeArchived = false): Promise<TruckItem[]> {
  const resp = await apiFetch(
    `/trucks${includeArchived ? '?include_archived=true' : ''}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function getTruck(id: string): Promise<TruckDetail> {
  const resp = await apiFetch(`/trucks/${id}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function createTruck(
  body: Record<string, unknown>,
): Promise<TruckDetail> {
  const resp = await apiFetch('/trucks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function updateTruck(
  id: string, body: Record<string, unknown>,
): Promise<TruckDetail> {
  const resp = await apiFetch(`/trucks/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function archiveTruck(
  id: string, archived: boolean,
): Promise<void> {
  const resp = await apiFetch(
    `/trucks/${id}/${archived ? 'archive' : 'unarchive'}`,
    { method: 'POST' });
  if (!resp.ok) throw await errorFrom(resp);
}

export async function listTruckStatuses(): Promise<StatusValue[]> {
  const resp = await apiFetch('/status-values?record_type=truck');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function listTruckUpdates(id: string): Promise<TruckUpdate[]> {
  const resp = await apiFetch(`/trucks/${id}/updates`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function addTruckUpdate(
  id: string,
  body: {
    location: string; approximate_address?: string;
    recorded_at?: string; source?: string;
  },
): Promise<TruckUpdate> {
  const resp = await apiFetch(`/trucks/${id}/updates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function clearTruckUpdates(id: string): Promise<void> {
  const resp = await apiFetch(`/trucks/${id}/updates`, { method: 'DELETE' });
  if (!resp.ok) throw await errorFrom(resp);
}

export async function getTrucksMap(trails: boolean): Promise<TruckMapPoint[]> {
  const resp = await apiFetch(`/trucks/map?trails=${trails}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

/* ── warehouse ────────────────────────────────────────────────────── */

export interface AssetRef {
  id: string;
  legacy_id: number | null;
  serial_number: string | null;
  name: string | null;
  model_name: string | null;
  status: string;
  status_label: string;
  status_color: string;
  location_detail: string;
}

export interface StockLine {
  id: string;
  site_id: string;
  site_name: string;
  container_id: string | null;
  container_name: string | null;
  model_id: string | null;
  model_make: string | null;
  model_model: string | null;
  description: string;
  quantity: number;
  unit: string;
  location_detail: string;
  notes: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WarehouseSite {
  id: string;
  name: string;
  code: string | null;
  city: string | null;
  region: string | null;
  status: string;
  status_label: string;
  status_color: string;
  container_count: number;
  asset_count: number;
  stock_line_count: number;
  stock_units: number;
}

export interface WarehouseContainer {
  id: string;
  name: string;
  rfid_tag: string | null;
  container_type: string | null;
  type_label: string | null;
  type_color: string | null;
  status: string;
  status_label: string;
  status_color: string;
  location_detail: string;
  updated_at: string;
  assets: AssetRef[];
  stock: StockLine[];
}

export interface WarehouseInventory {
  site: WarehouseSite;
  containers: WarehouseContainer[];
  loose_assets: AssetRef[];
  loose_stock: StockLine[];
}

export async function listWarehouseSites(): Promise<WarehouseSite[]> {
  const resp = await apiFetch('/warehouse/sites');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function getWarehouseInventory(siteId: string): Promise<WarehouseInventory> {
  const resp = await apiFetch(`/warehouse/${siteId}/inventory`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function createStockLine(
  body: Record<string, unknown>,
): Promise<StockLine> {
  const resp = await apiFetch('/warehouse/stock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function updateStockLine(
  id: string, body: Record<string, unknown>,
): Promise<StockLine> {
  const resp = await apiFetch(`/warehouse/stock/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function archiveStockLine(
  id: string, archived: boolean,
): Promise<void> {
  const resp = await apiFetch(
    `/warehouse/stock/${id}/${archived ? 'archive' : 'unarchive'}`,
    { method: 'POST' });
  if (!resp.ok) throw await errorFrom(resp);
}

/* ── scans ────────────────────────────────────────────────────────── */

export interface RawScanRow {
  id: number; scanned_value: string;
  scan_type: string; scan_type_label: string; scan_type_color: string;
  status: string | null; status_label: string | null; status_color: string | null;
  scanned_at: string; device_id: string;
  operator_id: string | null; operator_name: string | null;
  site_id: string | null; site_name: string | null;
  location_detail: string; source: string; created_at: string;
}

export interface ProcessedScanRow {
  id: string; scanned_value: string;
  scan_type: string; scan_type_label: string; scan_type_color: string;
  status: string | null; status_label: string | null; status_color: string | null;
  scanned_at: string; device_id: string;
  operator_id: string | null; operator_name: string | null;
  site_id: string | null; site_name: string | null;
  location_detail: string; source: string;
  raw_scan_id: number | null;
  match_type: string; match_type_label: string; match_type_color: string;
  asset_id: string | null; container_id: string | null;
  person_id: string | null; matched_name: string | null;
  processed_at: string; archived_at: string | null; created_at: string;
}

export interface RawScanQuery {
  device_id?: string;
  operator_id?: string;
  site_id?: string;
  scan_type?: string;
  since?: string;
  until?: string;
  value?: string;
  limit?: number;
  offset?: number;
}

export async function listRawScans(query: RawScanQuery): Promise<RawScanRow[]> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const resp = await apiFetch(`/scans/raw?${params.toString()}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

/** When (and via what) a row's status became its current value — the
 *  payload behind status-chip hover popups (GET /status/provenance). */
export interface StatusProvenance {
  status: string;
  changed_at: string | null;
  source: 'scan' | 'edit' | null;
  scan_type: string | null;
  scan_type_label: string | null;
  scan_type_color: string | null;
  device_id: string | null;
  site_name: string | null;
  actor_name: string | null;
}

export async function getStatusProvenance(
  entityType: string, entityId: string, status: string,
): Promise<StatusProvenance> {
  const params = new URLSearchParams({
    entity_type: entityType, entity_id: entityId, status,
  });
  const resp = await apiFetch(`/status/provenance?${params.toString()}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

/** One UTC day's raw-scan count — zero-filled, oldest first. */
export interface ScanDailyStat { day: string; count: number }

export async function listScanDailyStats(days: number): Promise<ScanDailyStat[]> {
  const resp = await apiFetch(`/scans/stats/daily?days=${days}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function listProcessedScans(): Promise<ProcessedScanRow[]> {
  const resp = await apiFetch('/scans/processed');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function updateProcessedScan(
  id: string, body: Record<string, unknown>,
): Promise<ProcessedScanRow> {
  const resp = await apiFetch(`/scans/processed/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export interface AssetScanRow {
  id: string; scanned_value: string;
  scan_type: string; scan_type_label: string; scan_type_color: string;
  status: string | null; status_label: string | null; status_color: string | null;
  scanned_at: string; processed_at: string;
  device_id: string;
  operator_id: string | null; operator_name: string | null;
  site_id: string | null; site_name: string | null;
  location_detail: string; source: string;
}

export async function listAssetScans(
  assetId: string, limit?: number,
): Promise<AssetScanRow[]> {
  const qs = limit !== undefined ? `?limit=${limit}` : '';
  const resp = await apiFetch(`/scans/asset/${assetId}${qs}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

/** One move roster row an asset has appeared on. Compact by design — rack,
 *  RU, disposition and verification live on the move-row page. */
export interface AssetMoveRow {
  row_id: string;
  initiative_id: string;
  initiative_name: string;
  initiative_status: string;
  initiative_status_label: string;
  initiative_status_color: string;
  asset_status: string;
  asset_status_label: string;
  asset_status_color: string;
  /** date-only, midnight UTC — render with parseApiDay + longDateOf */
  scheduled_start: string | null;
  scheduled_end: string | null;
  added_at: string;
}

export async function listAssetMoves(assetId: string): Promise<AssetMoveRow[]> {
  const resp = await apiFetch(`/assets/${assetId}/moves`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

/* ── time ─────────────────────────────────────────────────────────── */

export interface TimeEntryItem {
  id: string; person_id: string; person_name: string;
  initiative_id: string | null; initiative_name: string | null;
  site_id: string | null; site_name: string | null;
  clock_in_at: string; clock_out_at: string | null;
  break_minutes: number; minutes: number;
  status: string; status_label: string; status_color: string;
  source: string; notes: string; adjusted: boolean; adjust_reason: string | null;
  approved_by: string | null; approved_by_name: string | null;
  approved_at: string | null; reject_reason: string | null;
  created_at: string; updated_at: string;
}

export interface TimeSummaryPerson {
  person_id: string; person_name: string;
  approved_minutes: number; pending_minutes: number; entry_count: number;
  last_entry_at: string | null;
}

export interface TimeSummaryOut {
  approved_minutes: number; pending_minutes: number;
  open_count: number; people: TimeSummaryPerson[];
}

export interface PunchOption { id: string; name: string }

export async function clockIn(
  body: { initiative_id?: string; site_id?: string; notes?: string },
): Promise<TimeEntryItem> {
  const resp = await apiFetch('/time/clock-in', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function clockOut(
  body: { notes?: string; break_minutes?: number },
): Promise<TimeEntryItem> {
  const resp = await apiFetch('/time/clock-out', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function getMyTime(
  limit?: number,
): Promise<{ open: TimeEntryItem | null; entries: TimeEntryItem[] }> {
  const qs = limit !== undefined ? `?limit=${limit}` : '';
  const resp = await apiFetch(`/time/me${qs}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function getPunchOptions(): Promise<{
  initiatives: PunchOption[]; sites: PunchOption[];
}> {
  const resp = await apiFetch('/time/punch-options');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function listTimeEntries(q: {
  person_id?: string; initiative_id?: string; status?: string;
  since?: string; until?: string; limit?: number; offset?: number;
}): Promise<TimeEntryItem[]> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(q)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const resp = await apiFetch(`/time/entries?${params.toString()}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function createTimeEntry(
  body: Record<string, unknown>,
): Promise<TimeEntryItem> {
  const resp = await apiFetch('/time/entries', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function updateTimeEntry(
  id: string, body: Record<string, unknown>,
): Promise<TimeEntryItem> {
  const resp = await apiFetch(`/time/entries/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function approveTimeEntry(id: string): Promise<TimeEntryItem> {
  const resp = await apiFetch(`/time/entries/${id}/approve`, { method: 'POST' });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function rejectTimeEntry(
  id: string, reason: string,
): Promise<TimeEntryItem> {
  const resp = await apiFetch(`/time/entries/${id}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function listActiveTimeEntries(): Promise<TimeEntryItem[]> {
  const resp = await apiFetch('/time/active');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function getTimeSummary(initiativeId: string): Promise<TimeSummaryOut> {
  const params = new URLSearchParams({ initiative_id: initiativeId });
  const resp = await apiFetch(`/time/summary?${params.toString()}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

/* ── initiatives ──────────────────────────────────────────────────── */

export interface InitiativeItem {
  id: string; name: string; description: string | null;
  initiative_type: string; type_label: string; type_color: string;
  sub_type: string | null; sub_type_label: string | null;
  sub_type_color: string | null;
  status: string; status_label: string; status_color: string;
  /** The initiative's own calendar color (`#rrggbb`), as stored — null
   *  means "never set", and every reader falls back to `status_color`
   *  itself rather than the API inventing one. */
  color: string | null;
  client_id: string | null; client_name: string | null;
  site_id: string | null; site_name: string | null;
  location: string | null;
  scheduled_start: string | null; scheduled_end: string | null;
  sky_command_project_id: string | null;
  origin_site_id: string | null; origin_site_name: string | null;
  destination_site_id: string | null; destination_site_name: string | null;
  real_start_at: string | null; real_end_at: string | null;
  priority_devices: boolean | null;
  shipping_types: string[];
  shipping_partner_id: string | null; shipping_partner_name: string | null;
  origin_tech_partner_id: string | null;
  origin_cable_partner_id: string | null;
  origin_logistics_partner_id: string | null;
  destination_tech_partner_id: string | null;
  destination_cable_partner_id: string | null;
  destination_logistics_partner_id: string | null;
  origin_vendor_involved: boolean | null;
  destination_vendor_involved: boolean | null;
  people_count: number; links_count: number;
  archived_at: string | null; created_at: string;
}

export interface InitiativePersonRow {
  id: string; person_id: string; person_name: string;
  work_type: string | null; work_type_label: string | null;
  work_type_color: string | null;
  site_worked_id: string | null; site_worked_name: string | null;
  rating: number | null; created_at: string;
}

/** Embedded read-only asset summary on a move-asset row — mirrors the API's
 *  InitiativeAssetSummary schema (routes/initiatives.py) field-for-field. */
export interface InitiativeAssetSummary {
  id: string; legacy_id: number | null; serial_number: string | null;
  name: string | null; rfid_tag: string | null;
  model_make: string | null; model_name: string | null;
  ru_size: number | null; location_detail: string | null;
  client_name: string | null;
  model_category: string | null; model_category_label: string | null;
  model_category_color: string | null;
  status: string; status_label: string; status_color: string;
}

/** One asset's join row on a move — mirrors the API's InitiativeAssetOut
 *  schema field-for-field. RU fields are plain numbers (the API serializes
 *  its Decimal columns as float). */
export interface InitiativeAssetRow {
  id: string; asset_id: string;
  priority_wave: string | null; disposition: string | null; owner: string | null;
  source_rack: string | null; source_ru: number | null;
  source_verified: boolean | null; source_position: string | null;
  destination_rack: string | null; destination_ru: number | null;
  destination_verified: boolean | null; destination_position: string | null;
  cable_info: string | null; vendor_involved: boolean | null;
  status: string; status_label: string; status_color: string;
  created_at: string; updated_at: string;
  asset: InitiativeAssetSummary;
}

export interface InitiativeLinkRow {
  id: string; other_id: string; other_name: string;
  other_type: string; other_type_label: string; other_type_color: string;
  other_status_label: string; other_status_color: string;
  role: string | null; sort_order: number | null; notes: string | null;
  created_at: string;
}

export interface InitiativeDetail extends InitiativeItem {
  people: InitiativePersonRow[];
  links_children: InitiativeLinkRow[];
  links_parents: InitiativeLinkRow[];
}

export async function listInitiatives(): Promise<InitiativeItem[]> {
  const resp = await apiFetch('/initiatives');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

/** GET /initiatives/next-color — the color a create would assign right
 *  now, so the create modal can open the wheel on it instead of springing
 *  the assignment after save. Needs `initiatives:add`. */
export async function getNextInitiativeColor(): Promise<string> {
  const resp = await apiFetch('/initiatives/next-color');
  if (!resp.ok) throw await errorFrom(resp);
  const data = await resp.json() as { color: string };
  return data.color;
}

export async function getInitiative(id: string): Promise<InitiativeDetail> {
  const resp = await apiFetch(`/initiatives/${id}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function createInitiative(
  body: Record<string, unknown>,
): Promise<InitiativeDetail> {
  const resp = await apiFetch('/initiatives', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function updateInitiative(
  id: string, body: Record<string, unknown>,
): Promise<InitiativeDetail> {
  const resp = await apiFetch(`/initiatives/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function archiveInitiative(
  id: string, archived: boolean,
): Promise<void> {
  const resp = await apiFetch(
    `/initiatives/${id}/${archived ? 'archive' : 'unarchive'}`,
    { method: 'POST' });
  if (!resp.ok) throw await errorFrom(resp);
}

async function statusValuesFor(recordType: string): Promise<StatusValue[]> {
  const resp = await apiFetch(`/status-values?record_type=${recordType}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export const listInitiativeStatuses = () => statusValuesFor('initiative');
export const listInitiativeTypes = () => statusValuesFor('initiative_type');
export const listInitiativeSubTypes = () =>
  statusValuesFor('initiative_sub_type');
export const listInitiativeWorkTypes = () =>
  statusValuesFor('initiative_work_type');
export const listShippingTypes = () => statusValuesFor('shipping_type');

/** The Partners picker's type vocabulary (Clients/Partners share OrgDirectory,
 *  but only Partners has a Type column/picker — see cfg.hasType). */
export const listPartnerTypes = () => statusValuesFor('partner_type');

export async function addInitiativePerson(
  id: string, body: Record<string, unknown>,
): Promise<InitiativePersonRow[]> {
  const resp = await apiFetch(`/initiatives/${id}/people`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function updateInitiativePerson(
  assocId: string, body: Record<string, unknown>,
): Promise<InitiativePersonRow> {
  const resp = await apiFetch(`/initiatives/people/${assocId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function removeInitiativePerson(assocId: string): Promise<void> {
  const resp = await apiFetch(`/initiatives/people/${assocId}`,
    { method: 'DELETE' });
  if (!resp.ok) throw await errorFrom(resp);
}

/** GET /initiatives/{id}/assets — the move's full asset roster (no
 *  pagination this slice, matching V3 list conventions). */
export async function listInitiativeAssets(
  id: string,
): Promise<InitiativeAssetRow[]> {
  const resp = await apiFetch(`/initiatives/${id}/assets`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

/** POST /initiatives/{id}/assets — attach assets to a move (bulk-import
 *  script + dev seeding path; no interactive picker in the portal). */
export async function addInitiativeAssets(
  id: string, assetIds: string[],
): Promise<InitiativeAssetRow[]> {
  const resp = await apiFetch(`/initiatives/${id}/assets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ asset_ids: assetIds }),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function updateInitiativeAsset(
  assocId: string, body: Record<string, unknown>,
): Promise<InitiativeAssetRow> {
  const resp = await apiFetch(`/initiatives/assets/${assocId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function removeInitiativeAsset(assocId: string): Promise<void> {
  const resp = await apiFetch(`/initiatives/assets/${assocId}`,
    { method: 'DELETE' });
  if (!resp.ok) throw await errorFrom(resp);
}

// ── move-assets bulk import jobs ─────────────────────────────────────
// The API queues the job; a separate worker process runs it. The portal
// polls getImportJob until the job reaches a terminal status.

export type ImportJobPhase = 'validate' | 'commit';
export type ImportJobStatus =
  'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface ImportRowDetail {
  row: number;
  serial_number: string;
  status: 'created' | 'updated' | 'review' | 'error';
  message: string;
  asset_id?: string | null;
  asset_created?: boolean;
  serial_generated?: boolean;
  match_method?: string;
  make_model_final?: string;
  make_model?: string;
  suggested_make?: string;
  suggested_model?: string;
}

export interface ImportJobResults {
  summary: Record<string, number>;
  details: ImportRowDetail[];
}

export interface ImportJobOut {
  id: string;
  initiative_id: string;
  kind: string;
  filename: string;
  options: {
    make_model_mode?: string; generate_serials?: boolean;
    // set on a reprocess child job — see reprocessImportJob below
    reprocess_of?: string; only_rows?: number[];
  };
  phase: ImportJobPhase;
  status: ImportJobStatus;
  total_rows: number;
  processed_rows: number;
  created_count: number;
  updated_count: number;
  error_count: number;
  results: ImportJobResults | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export async function createMoveAssetImportJob(
  initiativeId: string, file: File,
  opts: { makeModelMode: string; generateSerials: boolean },
): Promise<ImportJobOut> {
  const form = new FormData();
  form.append('file', file);
  form.append('make_model_mode', opts.makeModelMode);
  form.append('generate_serials', String(opts.generateSerials));
  const resp = await apiFetch(
    `/initiatives/${initiativeId}/assets/import-jobs`,
    { method: 'POST', body: form });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function getImportJob(jobId: string): Promise<ImportJobOut> {
  const resp = await apiFetch(`/initiatives/assets/import-jobs/${jobId}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function commitImportJob(jobId: string): Promise<ImportJobOut> {
  const resp = await apiFetch(
    `/initiatives/assets/import-jobs/${jobId}/commit`, { method: 'POST' });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function reprocessImportJob(jobId: string): Promise<ImportJobOut> {
  const resp = await apiFetch(
    `/initiatives/assets/import-jobs/${jobId}/reprocess`, { method: 'POST' });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function cancelImportJob(jobId: string): Promise<ImportJobOut> {
  const resp = await apiFetch(
    `/initiatives/assets/import-jobs/${jobId}/cancel`, { method: 'POST' });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function downloadMoveAssetTemplate(
  format: 'csv' | 'xlsx',
): Promise<void> {
  const resp = await apiFetch(
    `/initiatives/assets/import-template?format=${format}`);
  if (!resp.ok) throw await errorFrom(resp);
  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `move-assets-template.${format}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function addInitiativeLink(
  id: string, body: Record<string, unknown>,
): Promise<InitiativeDetail> {
  const resp = await apiFetch(`/initiatives/${id}/links`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function updateInitiativeLink(
  linkId: string, body: Record<string, unknown>,
): Promise<InitiativeLinkRow> {
  const resp = await apiFetch(`/initiatives/links/${linkId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function removeInitiativeLink(linkId: string): Promise<void> {
  const resp = await apiFetch(`/initiatives/links/${linkId}`,
    { method: 'DELETE' });
  if (!resp.ok) throw await errorFrom(resp);
}

/** Minimal person options for the assignment picker (GET /workers). */
export interface WorkerOption {
  person_id: string; display_name: string;
}

export async function listWorkerOptions(): Promise<WorkerOption[]> {
  const resp = await apiFetch('/workers');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
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

/* ── pending deletes ──────────────────────────────────────────────── */

export interface PendingDeleteItem {
  id: string;
  entity_type: string;
  entity_id: string;
  entity_label: string;
  marked_by: string | null;
  marked_by_name: string | null;
  marked_at: string;
}

export async function listPendingDeletes(): Promise<PendingDeleteItem[]> {
  const resp = await apiFetch('/devtools/pending-deletes');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function markPendingDelete(
  entityType: string, entityId: string, entityLabel: string,
): Promise<PendingDeleteItem> {
  const resp = await apiFetch('/devtools/pending-deletes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      entity_type: entityType, entity_id: entityId, entity_label: entityLabel,
    }),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

/** `markerId` is the pending-delete row's own id, not the entity's — the
 *  API keys the DELETE off the marker so callers must track that mapping
 *  themselves (see usePendingDeletes). */
export async function unmarkPendingDelete(markerId: string): Promise<void> {
  const resp = await apiFetch(`/devtools/pending-deletes/${markerId}`, { method: 'DELETE' });
  if (!resp.ok) throw await errorFrom(resp);
}

export interface PendingDeleteReference {
  table: string;
  column: string;
  nullable: boolean;
  /** pure association table: force deletes these rows instead of nulling */
  purgeable: boolean;
  /** a CHECK constraint keeps this column non-null even though it's
   *  nullable — force can't clear it (processed_scans match FKs) */
  check_guarded: boolean;
  /** the foreign key declares ON DELETE CASCADE or SET NULL, so the
   *  database clears it on delete — it never blocked anything */
  db_handled: boolean;
  count: number;
  labels: string[];
}

export interface PendingDeleteFailure {
  entity_type: string;
  entity_id: string;
  label: string;
  reason: string;
  references: PendingDeleteReference[];
}

export interface PendingDeleteReconcileOut {
  deleted: number;
  failed: PendingDeleteFailure[];
}

/** Hard-deletes every marked target. Each target runs in its own server-side
 *  savepoint, so a handful of FK violations don't block the rest of the
 *  batch — see routes/devtools.py:reconcile_pending_deletes. Failed rows
 *  keep their marker (for a later retry) and come back in `failed`. */
export async function reconcilePendingDeletes(): Promise<PendingDeleteReconcileOut> {
  const resp = await apiFetch('/devtools/pending-deletes/reconcile', { method: 'POST' });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

/** Single-marker variant — same semantics and summary shape, one target.
 *  `force` nulls every nullable reference to the target before deleting it
 *  (bulk reconcile has no such switch — see routes/devtools.py). */
export async function reconcilePendingDelete(
  markerId: string, force = false,
): Promise<PendingDeleteReconcileOut> {
  const resp = await apiFetch(
    `/devtools/pending-deletes/${markerId}/reconcile${force ? '?force=true' : ''}`,
    { method: 'POST' });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

/* ── cascade delete override ───────────────────────────────────── */

export interface CascadeStep {
  table: string;
  column: string;
  /** purge deletes the rows; clear nulls the column; db_* is the
   *  database's own ON DELETE rule doing it for us */
  action: 'purge' | 'clear' | 'db_cascade' | 'db_set_null';
  count: number;
  labels: string[];
  depth: number;
}

export interface CascadePlan {
  entity_type: string;
  entity_id: string;
  label: string;
  steps: CascadeStep[];
  /** non-empty means the delete will refuse to run, with these reasons */
  blocked: string[];
  total_rows_deleted: number;
  total_rows_cleared: number;
  /** rows the DATABASE destroys via ON DELETE CASCADE — not part of
   *  total_rows_deleted, which is only this walk's own DELETEs */
  total_rows_db_deleted: number;
}

/** Everything a cascade delete would destroy for one marker. Read-only —
 *  the server builds it with the same walk the delete runs. */
export async function getCascadePreview(markerId: string): Promise<CascadePlan> {
  const resp = await apiFetch(`/devtools/pending-deletes/${markerId}/cascade-preview`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

/** Irreversible. `confirmLabel` must equal the marker's own label or the
 *  server refuses with `label_mismatch`. */
export async function cascadeDelete(
  markerId: string, confirmLabel: string,
): Promise<PendingDeleteReconcileOut> {
  const resp = await apiFetch(`/devtools/pending-deletes/${markerId}/cascade-delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm_label: confirmLabel }),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

/* ── db backups ───────────────────────────────────────────────────── */

export interface DbBackupItem {
  id: string;
  filename: string;
  size_bytes: number;
  encrypted: boolean;
  created_at: string;
  created_by: string | null;
  created_by_name: string | null;
  // 'testing_snapshot' rows are made by the db-testing worker right before
  // a testing session goes active — the Backups tab tags them so they read
  // as machine-made safety nets, not a manual backup someone requested.
  purpose: 'manual' | 'testing_snapshot';
  // only populated by createDbBackup (a fresh presigned link) — list rows
  // leave this undefined, so downloading an older backup goes through
  // getDbBackupDownload for a freshly-signed URL instead.
  download_url?: string;
}

export async function listDbBackups(): Promise<DbBackupItem[]> {
  const resp = await apiFetch('/devtools/backups');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

/** Runs pg_dump server-side and encrypts the dump with the caller's OWN
 *  account password — the API never sees `password` again after this
 *  call. Errors: 403 `invalid_password`, 500 `pg_dump_unavailable` (or
 *  `pg_dump_failed`) — see ApiError.code. The returned item's
 *  `download_url` is a freshly presigned, attachment-disposition link. */
/** password = null creates a plain (unencrypted) dump. */
export async function createDbBackup(password: string | null): Promise<DbBackupItem> {
  const resp = await apiFetch('/devtools/backups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(password === null
      ? { encrypt: false }
      : { encrypt: true, password }),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function getDbBackupDownload(backupId: string): Promise<{ url: string }> {
  const resp = await apiFetch(`/devtools/backups/${backupId}/download`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function deleteDbBackup(backupId: string): Promise<void> {
  const resp = await apiFetch(`/devtools/backups/${backupId}`, { method: 'DELETE' });
  if (!resp.ok && resp.status !== 404) throw await errorFrom(resp);
}

/* ── db testing mode ──────────────────────────────────────────────── */

export type DbTestingSessionStatus = 'snapshotting' | 'active' | 'reverting' | 'ended' | 'failed';
export type DbTestingOutcome = 'reverted' | 'kept' | null;

export interface DbTestingSession {
  id: string;
  status: DbTestingSessionStatus;
  started_by_name: string | null;
  started_at: string;
  ended_at: string | null;
  ended_with: DbTestingOutcome;
  snapshot_filename: string | null;
  error: string | null;
}

export interface DbTestingTableDelta {
  table: string;
  before: number;
  after: number;
  delta: number;
}

export interface DbTestingChanges {
  audit_rows: number;
  tables: DbTestingTableDelta[];
  since: string;
}

export interface DbTestingStatusOut {
  // the current non-ended session, or null when idle.
  session: DbTestingSession | null;
  changes: DbTestingChanges | null;
  recent: DbTestingSession[];
  worker_online: boolean;
}

export async function getDbTestingStatus(): Promise<DbTestingStatusOut> {
  const resp = await apiFetch('/devtools/db-testing/status');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

/** Errors: 403 `invalid_testing_password`, 429 `too_many_attempts`,
 *  409 `session_active`, 503 `worker_offline`. */
export async function startDbTesting(password: string): Promise<DbTestingSession> {
  const resp = await apiFetch('/devtools/db-testing/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

/** revert=true tips the session into `reverting` (worker takes over);
 *  revert=false ends it immediately as `ended/kept`. 409 `session_not_active`
 *  when there is no active session to end. */
export async function endDbTesting(password: string, revert: boolean): Promise<DbTestingSession> {
  const resp = await apiFetch('/devtools/db-testing/end', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password, revert }),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

// ── system: process registry + logs ─────────────────────────────────

export interface SystemProcessOut {
  name: string;
  kind: 'service' | 'worker' | 'probe';
  status: 'running' | 'stopped' | 'failed';
  pid: number | null;
  hostname: string;
  started_at: string | null;
  heartbeat_at: string | null;
  stopped_at: string | null;
  uptime_seconds: number | null;
  meta: Record<string, unknown>;
}

export async function listSystemProcesses(): Promise<SystemProcessOut[]> {
  const resp = await apiFetch('/system/processes');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export interface SystemLogEntry {
  id: number;
  level: string;
  levelno: number;
  logger: string;
  message: string;
  at: string;
}

export interface SystemLogPage {
  entries: SystemLogEntry[];
  has_more: boolean;
}

export async function getProcessLogs(
  name: string,
  opts: { minLevel?: string; q?: string; beforeId?: number; limit?: number } = {},
): Promise<SystemLogPage> {
  const params = new URLSearchParams();
  if (opts.minLevel) params.set('min_level', opts.minLevel);
  if (opts.q) params.set('q', opts.q);
  if (opts.beforeId !== undefined) params.set('before_id', String(opts.beforeId));
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  const suffix = params.size ? `?${params}` : '';
  const resp = await apiFetch(`/system/processes/${name}/logs${suffix}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function clearProcessLogs(
  name: string,
): Promise<{ deleted: number }> {
  const resp = await apiFetch(`/system/processes/${name}/logs`,
    { method: 'DELETE' });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

/** The live-tail WebSocket URL. The access token is deliberately NOT in
 *  it: query strings land in access logs and proxy logs. Browsers cannot
 *  set Authorization on WebSockets, so the token rides the subprotocol
 *  list instead — see logStreamProtocols. */
export function logStreamUrl(
  name: string,
  opts: { minLevel?: string; q?: string } = {},
): string {
  const params = new URLSearchParams();
  if (opts.minLevel) params.set('min_level', opts.minLevel);
  if (opts.q) params.set('q', opts.q);
  const qs = params.toString();
  return `${apiUrl().replace(/^http/, 'ws')}/system/processes/${name}/logs/stream${qs ? `?${qs}` : ''}`;
}

/** The subprotocol list that authenticates the live tail — pass it as
 *  the second argument of `new WebSocket(url, protocols)`. The handshake
 *  sends it as `Sec-WebSocket-Protocol: ss-bearer, <token>`; the server
 *  accepts "ss-bearer" on success and closes 4401 otherwise. */
export function logStreamProtocols(token: string): string[] {
  return ['ss-bearer', token];
}

export function getAccessTokenForStream(): string | null {
  return accessToken;
}

// ── system config: logging section ──────────────────────────────────

export interface LoggingConfig {
  mode: 'local' | 'local_remote' | 'remote';
  local_max_rows_per_process: number;
  local_max_age_days: number;
  remote_buffer_rows: number;
  min_level: string;
  transport: 'loki' | 'syslog';
  loki: { url: string; username: string; password?: string;
          password_set?: boolean; tenant_id: string };
  syslog: { host: string; port: number; protocol: 'udp' | 'tcp' | 'tls' };
}

export async function getLoggingConfig(): Promise<LoggingConfig> {
  const resp = await apiFetch('/system/config/logging');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function putLoggingConfig(
  cfg: LoggingConfig,
): Promise<LoggingConfig> {
  const resp = await apiFetch('/system/config/logging', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function testLoggingConfig(): Promise<{
  logged: boolean; forwarded: boolean; error: string | null;
}> {
  const resp = await apiFetch('/system/config/logging/test',
    { method: 'POST' });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

// ── system config: env tab ──────────────────────────────────────────

/** One row of the repo .env, DB/Spaces keys hidden server-side. Secrets
 *  never carry `value` — only whether one is currently `set`. */
export interface EnvEntry {
  key: string;
  secret: boolean;
  set?: boolean;
  value?: string;
  description: string;
  /** The nearest preceding standalone-comment line's text, or "" if none
   *  precedes this key. Groups entries into ENV-tab section headers. */
  section: string;
}

export async function getEnvEntries(): Promise<{ entries: EnvEntry[] }> {
  const resp = await apiFetch('/system/env');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function putEnvConfig(config: {
  values: Record<string, string>;
  descriptions: Record<string, string>;
}): Promise<{ changed: string[] }> {
  const resp = await apiFetch('/system/env', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function restartProcesses(): Promise<{ restarting: boolean }> {
  const resp = await apiFetch('/system/env/restart', { method: 'POST' });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

// ── system config: admin controls (read-only mode + broadcast banner) ──

export interface AdminConfig {
  read_only: boolean; read_only_message: string; pause_workers: boolean;
  banner_enabled: boolean; banner_message: string;
}

export interface SecurityConfig { two_factor_enabled: boolean; two_factor_required: boolean; }

export async function getSecurityConfig(): Promise<SecurityConfig> {
  const resp = await apiFetch('/system/security');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function updateSecurityConfig(patch: Partial<SecurityConfig>): Promise<SecurityConfig> {
  const resp = await apiFetch('/system/security', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function revokeAllSessions(): Promise<{ revoked_sessions: number; revoked_people: number }> {
  const resp = await apiFetch('/system/sessions/revoke-all', { method: 'POST' });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function getAdminConfig(): Promise<AdminConfig> {
  const resp = await apiFetch('/system/admin');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function updateAdminConfig(patch: Partial<AdminConfig>): Promise<AdminConfig> {
  const resp = await apiFetch('/system/admin', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

/* ── notification groups ─────────────────────────────────────────────
 * Mirrors api/src/serversherpa/api/schemas.py's Notification*Out shapes.
 * Times ("quiet_start"/"quiet_end") serialize as "HH:MM:SS" strings. */

export interface NotificationGroup {
  id: string;
  name: string;
  description: string;
  channels: string[];
  quiet_start: string | null;
  quiet_end: string | null;
  timezone: string;
  active_days: string[];
  dnd_behavior: string;
  urgent_bypass: boolean;
  enabled: boolean;
  member_count: number;
  created_at: string;
}

export interface NotificationMemberOverrides {
  channels: string[] | null;
  quiet_mode: string | null;
  quiet_start: string | null;
  quiet_end: string | null;
  timezone: string | null;
  active_days: string[] | null;
  dnd_behavior: string | null;
  urgent_bypass: boolean | null;
}

export interface NotificationEffectiveSettings {
  channels: string[];
  quiet_start: string | null;
  quiet_end: string | null;
  timezone: string;
  active_days: string[];
  dnd_behavior: string;
  urgent_bypass: boolean;
}

export interface NotificationMember {
  person_id: string;
  display_name: string;
  job_title: string | null;
  avatar_url: string | null;
  email: string | null;
  phone: string | null;
  has_account: boolean;
  can_email: boolean;
  can_text: boolean;
  can_push: boolean;
  can_web: boolean;
  overrides: NotificationMemberOverrides;
  effective: NotificationEffectiveSettings;
  added_at: string;
}

export interface NotificationGroupDetail extends NotificationGroup {
  members: NotificationMember[];
}

export interface NotificationRecipient {
  person_id: string;
  display_name: string;
  job_title: string | null;
  avatar_url: string | null;
  email: string | null;
  phone: string | null;
  has_account: boolean;
  can_email: boolean;
  can_text: boolean;
  can_push: boolean;
  can_web: boolean;
}

/** Shared shape for group create/patch — all fields optional so callers can
 *  send a partial patch. */
export interface NotificationGroupSettingsIn {
  channels?: string[];
  quiet_start?: string | null;
  quiet_end?: string | null;
  timezone?: string;
  active_days?: string[];
  dnd_behavior?: string;
  urgent_bypass?: boolean;
}

export interface NotificationGroupCreateIn extends NotificationGroupSettingsIn {
  name: string;
  description?: string;
}

export interface NotificationGroupPatchIn extends NotificationGroupSettingsIn {
  name?: string;
  description?: string;
  enabled?: boolean;
}

export async function listNotificationGroups(): Promise<NotificationGroup[]> {
  const resp = await apiFetch('/notifications/groups');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function createNotificationGroup(
  body: NotificationGroupCreateIn,
): Promise<NotificationGroup> {
  const resp = await apiFetch('/notifications/groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function getNotificationGroup(id: string): Promise<NotificationGroupDetail> {
  const resp = await apiFetch(`/notifications/groups/${id}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function updateNotificationGroup(
  id: string, body: NotificationGroupPatchIn,
): Promise<NotificationGroup> {
  const resp = await apiFetch(`/notifications/groups/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function deleteNotificationGroup(id: string): Promise<void> {
  const resp = await apiFetch(`/notifications/groups/${id}`, { method: 'DELETE' });
  if (!resp.ok) throw await errorFrom(resp);
}

export async function addNotificationMember(
  groupId: string, personId: string,
): Promise<NotificationMember> {
  const resp = await apiFetch(`/notifications/groups/${groupId}/members`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ person_id: personId }),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function updateNotificationMember(
  groupId: string, personId: string, overrides: Partial<NotificationMemberOverrides>,
): Promise<NotificationMember> {
  const resp = await apiFetch(`/notifications/groups/${groupId}/members/${personId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(overrides),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function removeNotificationMember(
  groupId: string, personId: string,
): Promise<void> {
  const resp = await apiFetch(`/notifications/groups/${groupId}/members/${personId}`,
    { method: 'DELETE' });
  if (!resp.ok) throw await errorFrom(resp);
}

export async function listNotificationRecipients(): Promise<NotificationRecipient[]> {
  const resp = await apiFetch('/notifications/recipients');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

/* ── notification groups: self-service (My groups / Join a group) ────
 * Mirrors api/src/serversherpa/api/schemas.py's MyNotificationGroupOut /
 * MembershipRequestOut — the /auth/me self-service endpoints (any
 * signed-in person) and the /notifications/requests approval endpoints
 * (gated notifications:change). */

export interface MyPendingRequest {
  id: string;
  action: string; // 'join' | 'leave'
  note: string;
  created_at: string;
}

export interface MyNotificationGroup {
  id: string;
  name: string;
  description: string;
  channels: string[];
  quiet_start: string | null;
  quiet_end: string | null;
  timezone: string;
  active_days: string[];
  dnd_behavior: string;
  urgent_bypass: boolean;
  member_count: number;
  is_member: boolean;
  overrides: NotificationMemberOverrides | null;
  effective: NotificationEffectiveSettings | null;
  pending_request: MyPendingRequest | null;
}

export interface MembershipRequest {
  id: string;
  group_id: string;
  group_name: string;
  person_id: string;
  person_name: string;
  action: string; // 'join' | 'leave'
  status: string;
  note: string;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_note: string;
  created_at: string;
}

export async function listMyNotificationGroups(q = ''): Promise<MyNotificationGroup[]> {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  const resp = await apiFetch(`/auth/me/notification-groups?${params.toString()}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function updateMyGroupOverrides(
  groupId: string, body: Partial<NotificationMemberOverrides>,
): Promise<MyNotificationGroup> {
  const resp = await apiFetch(`/auth/me/notification-groups/${groupId}/overrides`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function requestGroupMembership(
  groupId: string, action: 'join' | 'leave', note = '',
): Promise<MembershipRequest> {
  const resp = await apiFetch(`/auth/me/notification-groups/${groupId}/requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, note }),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function cancelMembershipRequest(id: string): Promise<void> {
  const resp = await apiFetch(`/auth/me/notification-groups/requests/${id}`, { method: 'DELETE' });
  if (!resp.ok) throw await errorFrom(resp);
}

export async function listMembershipRequests(status = 'pending'): Promise<MembershipRequest[]> {
  const resp = await apiFetch(`/notifications/requests?status=${encodeURIComponent(status)}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function approveMembershipRequest(id: string, note = ''): Promise<MembershipRequest> {
  const resp = await apiFetch(`/notifications/requests/${id}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note }),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function rejectMembershipRequest(id: string, note = ''): Promise<MembershipRequest> {
  const resp = await apiFetch(`/notifications/requests/${id}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note }),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

/* ── status rules ─────────────────────────────────────────────────── */

export interface StatusRuleCondition { field: string; operator: string; value: string | null }
export interface StatusRuleAction { action_type: string; params: Record<string, unknown> }
export interface StatusRule {
  id: string; name: string; description: string;
  trigger_status: string; trigger_match_type: string;
  priority: number; enabled: boolean;
  conditions: StatusRuleCondition[]; actions: StatusRuleAction[];
  created_at: string; updated_at: string;
}
export interface StatusRuleIn {
  name: string; description: string; trigger_status: string;
  trigger_match_type: string; priority: number; enabled: boolean;
  conditions: StatusRuleCondition[]; actions: StatusRuleAction[];
}
export interface SchemaOption { value: string; label: string; color?: string }
export interface RuleSchemaOperator { key: string; label: string; needs_value: boolean }
export interface RuleSchemaField { key: string; label: string; type: string; options?: SchemaOption[] }
export interface RuleSchemaParam { name: string; type: string; options?: (string | SchemaOption)[] }
export interface RuleSchemaAction { key: string; label: string; params: RuleSchemaParam[] }
export interface StatusRuleSchema {
  trigger_statuses: SchemaOption[]; match_types: SchemaOption[];
  operators: RuleSchemaOperator[]; condition_fields: RuleSchemaField[];
  actions: RuleSchemaAction[]; sites: SchemaOption[];
}
export interface StatusRuleExecution {
  id: number; rule_id: string | null; rule_name: string;
  processed_scan_id: string | null; conditions_met: boolean;
  actions_applied: { action_type: string; applied: boolean; reason?: string }[];
  error: string | null; executed_at: string; duration_ms: number;
  scanned_value: string | null; scan_status: string | null;
}
export interface StatusRuleExecStat {
  rule_id: string; run_count: number; met_count: number;
  last_run_at: string | null; avg_duration_ms: number | null;
}

export async function listStatusRules(): Promise<StatusRule[]> {
  const resp = await apiFetch('/status-rules');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function createStatusRule(body: StatusRuleIn): Promise<StatusRule> {
  const resp = await apiFetch('/status-rules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function updateStatusRule(id: string, body: StatusRuleIn): Promise<StatusRule> {
  const resp = await apiFetch(`/status-rules/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function toggleStatusRule(id: string, enabled: boolean): Promise<StatusRule> {
  const resp = await apiFetch(`/status-rules/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function deleteStatusRule(id: string): Promise<void> {
  const resp = await apiFetch(`/status-rules/${id}`, { method: 'DELETE' });
  if (!resp.ok) throw await errorFrom(resp);
}

export async function getStatusRuleSchema(): Promise<StatusRuleSchema> {
  const resp = await apiFetch('/status-rules/schema');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function listStatusRuleExecutions(
  params: { ruleId?: string; limit?: number; offset?: number },
): Promise<StatusRuleExecution[]> {
  const qs = new URLSearchParams();
  if (params.ruleId != null) qs.set('rule_id', params.ruleId);
  if (params.limit != null) qs.set('limit', String(params.limit));
  if (params.offset != null) qs.set('offset', String(params.offset));
  const query = qs.toString();
  const resp = await apiFetch(`/status-rules/executions${query ? `?${query}` : ''}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function getStatusRuleExecStats(): Promise<StatusRuleExecStat[]> {
  const resp = await apiFetch('/status-rules/executions/stats');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

/* ── devices ───────────────────────────────────────────────────────── */

export interface DeviceItem {
  id: string; device_type: string; name: string;
  serial: string | null; mac: string | null;
  site_id: string | null; site_name: string | null;
  wan_ip: string | null; lan_ip: string | null;
  uptime_seconds: number | null; last_seen_at: string | null;
  raw_info: Record<string, unknown>; registered_at: string;
  vpn_status: string | null; token_expires_at: string | null;
  connected_count: number;
  model: string | null; antennas_connected: number | null;
  connection_type: string | null;
  scan_status: string | null; scan_status_label: string | null;
  scan_status_color: string | null;
  tags_read_24h: number;
  version: string | null; sub_type: string | null;
  current_initiative_id: string | null; current_initiative_name: string | null;
  session_person_id: string | null; session_person_name: string | null;
  session_login_method: string | null; session_started_at: string | null;
}

export async function listDevices(deviceType?: string): Promise<DeviceItem[]> {
  const qs = new URLSearchParams();
  if (deviceType) qs.set('device_type', deviceType);
  const query = qs.toString();
  const resp = await apiFetch(`/devices${query ? `?${query}` : ''}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export interface DeviceWrite {
  name?: string; sub_type?: string | null; mac?: string | null;
  lan_ip?: string | null; version?: string | null; site_id?: string | null;
  current_initiative_id?: string | null; scan_status?: string | null;
}

export async function createDevice(
  body: DeviceWrite & { device_type: string; name: string },
): Promise<DeviceItem> {
  const resp = await apiFetch('/devices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function patchDevice(id: string, body: DeviceWrite): Promise<DeviceItem> {
  const resp = await apiFetch(`/devices/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function registerDevice(id: string, days: number): Promise<DeviceItem> {
  const resp = await apiFetch(`/devices/${id}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ days }),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function deregisterDevice(id: string): Promise<DeviceItem> {
  const resp = await apiFetch(`/devices/${id}/deregister`, { method: 'POST' });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function deleteDevice(id: string): Promise<void> {
  const resp = await apiFetch(`/devices/${id}`, { method: 'DELETE' });
  if (!resp.ok) throw await errorFrom(resp);
}

export interface DeviceLease {
  id: string; mac: string; ip: string | null; hostname: string | null;
  reserved: boolean; up: boolean; last_seen_at: string | null;
}

export async function listDeviceLeases(deviceId: string): Promise<DeviceLease[]> {
  const resp = await apiFetch(`/devices/${deviceId}/leases`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

/* ── kiosk pairing — the phone side of the kiosk's "Link with phone" ─ */

export type PairStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface PairInfo {
  code: string;
  kiosk_name: string;
  serial: string;
  status: PairStatus;
  expires_at: string;
}

export async function getPairInfo(code: string): Promise<PairInfo> {
  const resp = await apiFetch(`/kiosk/pair/${encodeURIComponent(code)}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function approvePair(code: string): Promise<void> {
  const resp = await apiFetch(`/kiosk/pair/${encodeURIComponent(code)}/approve`, { method: 'POST' });
  if (!resp.ok) throw await errorFrom(resp);
}

export async function denyPair(code: string): Promise<void> {
  const resp = await apiFetch(`/kiosk/pair/${encodeURIComponent(code)}/deny`, { method: 'POST' });
  if (!resp.ok) throw await errorFrom(resp);
}

// ── Labels ───────────────────────────────────────────────────────────

export interface LabelVocab {
  kind: string; key: string; label: string; description: string;
  meta: Record<string, unknown>; sort_order: number; is_active: boolean;
  usage_count: number | null;
}

export interface LabelPlaceholder {
  key: string; label: string; description: string; sample_value: string;
  applies_to: string[]; sort_order: number; is_active: boolean;
  usage_count: number | null;
}

/** V2's `label_generation_code` port: position→token splits (1-based,
 *  applied to the raw destination/source location string split on ".")
 *  plus per-token length limits. Position/limit keys are strings on the
 *  wire (JSON object keys); see `lib/generateLabels.ts` for the editor's
 *  row-based form and its validation. */
export interface LabelGenerationRules {
  destination?: Record<string, string>;
  source?: Record<string, string>;
  length_limits?: Record<string, number>;
}

export interface LabelTemplate {
  id: string; name: string; description: string; label_type: string;
  size_key: string; dpi_key: string; language_key: string;
  kind: 'design' | 'code'; design: Record<string, unknown> | null;
  code: string | null; version: number; is_active: boolean;
  site_ids: string[];
  // Optional so existing fixtures/tests predating this field (which the
  // API always sends, defaulting to `{}`) don't need updating.
  generation_rules?: LabelGenerationRules;
  created_at: string; updated_at: string;
}

export async function listLabelVocab(kind?: string): Promise<LabelVocab[]> {
  const resp = await apiFetch(kind ? `/labels/vocab?kind=${kind}` : '/labels/vocab');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function createLabelVocab(
  body: Record<string, unknown>,
): Promise<LabelVocab> {
  const resp = await apiFetch('/labels/vocab', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function updateLabelVocab(
  kind: string, key: string, body: Record<string, unknown>,
): Promise<LabelVocab> {
  const resp = await apiFetch(`/labels/vocab/${kind}/${key}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function listLabelPlaceholders(): Promise<LabelPlaceholder[]> {
  const resp = await apiFetch('/labels/placeholders');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function createLabelPlaceholder(
  body: Record<string, unknown>,
): Promise<LabelPlaceholder> {
  const resp = await apiFetch('/labels/placeholders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function updateLabelPlaceholder(
  key: string, body: Record<string, unknown>,
): Promise<LabelPlaceholder> {
  const resp = await apiFetch(`/labels/placeholders/${key}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function listLabelTemplates(): Promise<LabelTemplate[]> {
  const resp = await apiFetch('/labels/templates');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function getLabelTemplate(id: string): Promise<LabelTemplate> {
  const resp = await apiFetch(`/labels/templates/${id}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function createLabelTemplate(
  body: Record<string, unknown>,
): Promise<LabelTemplate> {
  const resp = await apiFetch('/labels/templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function updateLabelTemplate(
  id: string, body: Record<string, unknown>,
): Promise<LabelTemplate> {
  const resp = await apiFetch(`/labels/templates/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function deleteLabelTemplate(id: string): Promise<void> {
  const resp = await apiFetch(`/labels/templates/${id}`, { method: 'DELETE' });
  if (!resp.ok) throw await errorFrom(resp);
}

export async function convertLabelTemplate(id: string): Promise<LabelTemplate> {
  const resp = await apiFetch(`/labels/templates/${id}/convert-to-code`, {
    method: 'POST',
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

// ── Label font library (Labels → Printers › Install Fonts) ───────────

export interface LabelFontUsedBy { template_id: string; template_name: string }

/** A TrueType font admins uploaded once; `name` is the Zebra object name
 *  it installs under on the printer's E: drive. */
export interface LabelFont {
  id: string; name: string; display_name: string; size_bytes: number; content_type: string;
  uploaded_by: string | null; uploaded_by_name: string | null; created_at: string;
  used_by: LabelFontUsedBy[];
}

export async function listLabelFonts(): Promise<LabelFont[]> {
  const resp = await apiFetch('/labels/fonts');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function uploadLabelFont(file: File, name?: string): Promise<LabelFont> {
  const form = new FormData();
  form.set('file', file);
  if (name) form.set('name', name);
  const resp = await apiFetch('/labels/fonts', { method: 'POST', body: form });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function deleteLabelFont(id: string): Promise<void> {
  const resp = await apiFetch(`/labels/fonts/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!resp.ok) throw await errorFrom(resp);
}

/** The TTF bytes, for pushing to a printer over WebUSB. */
export async function getLabelFontBytes(id: string): Promise<Uint8Array> {
  const resp = await apiFetch(`/labels/fonts/${encodeURIComponent(id)}/content`);
  if (!resp.ok) throw await errorFrom(resp);
  return new Uint8Array(await resp.arrayBuffer());
}

export async function compileLabel(body: {
  kind: 'design' | 'code';
  design?: Record<string, unknown> | null;
  code?: string | null;
  size_key: string; dpi_key: string; language_key: string;
  mode: 'placeholders' | 'sample';
}): Promise<{ code: string }> {
  const resp = await apiFetch('/labels/templates/compile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function previewZplRequest(body: {
  zpl: string; size_key: string; dpi_key: string;
}): Promise<Blob> {
  const resp = await apiFetch('/labels/preview/zpl', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.blob();
}

// ── Generate Labels (worker-driven runs) ──────────────────────────────

export type LabelRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled';

export interface LabelRunErrorDetail {
  item: string; label_type: string; type: string; message: string;
}

export interface LabelRun {
  id: string;
  initiative_id: string; initiative_name: string;
  label_types: string[];
  regenerate_existing: boolean;
  status: LabelRunStatus;
  cancel_requested: boolean;
  current_label_type: string | null;
  current_item: string | null;
  total: number; processed: number; generated: number; skipped: number; errors: number;
  error_summary: Record<string, number>;
  error_details: LabelRunErrorDetail[];
  error: string | null;
  requested_by: string; requested_by_name: string;
  notify: boolean;
  created_at: string; started_at: string | null; finished_at: string | null;
  progress_pct: number;
  // Optional so existing fixtures/tests predating this field (which the
  // API always sends, defaulting to `{}`) don't need updating — same
  // reasoning as `LabelTemplate.generation_rules`. Keyed by label type;
  // the runs list uses it to mark a chip "manual" when that run's
  // operator overrode (or hand-picked) that type's template.
  template_overrides?: Record<string, string>;
}

/** POST /labels/generate/runs — 404 `initiative_not_found`, 422
 *  `invalid_label_types`/`invalid_templates` (the latter's `err.detail`
 *  carries `problems: string[]` alongside `code`), 409 `run_active`
 *  (`err.detail` carries `run_id` alongside `code` for that one). */
export async function startLabelRun(body: {
  initiative_id: string; label_types: string[]; regenerate_existing: boolean; notify: boolean;
  /** Only the types the operator resolved themselves — an auto-matched
   *  type with no override never appears here. Omit entirely when empty
   *  rather than sending `{}`. */
  templates?: Record<string, string>;
}): Promise<LabelRun> {
  const resp = await apiFetch('/labels/generate/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function listLabelRuns(
  params: { initiative_id?: string; limit?: number } = {},
): Promise<LabelRun[]> {
  const qs = new URLSearchParams();
  if (params.initiative_id) qs.set('initiative_id', params.initiative_id);
  if (params.limit != null) qs.set('limit', String(params.limit));
  const query = qs.toString();
  const resp = await apiFetch(`/labels/generate/runs${query ? `?${query}` : ''}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function getLabelRun(id: string): Promise<LabelRun> {
  const resp = await apiFetch(`/labels/generate/runs/${id}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

/** A queued run flips straight to `canceled`; a running one finishes its
 *  current batch first. 409 when the run is no longer queued/running. */
export async function cancelLabelRun(id: string): Promise<LabelRun> {
  const resp = await apiFetch(`/labels/generate/runs/${id}/cancel`, { method: 'POST' });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

/** One template Generate Labels' per-type template line can offer the
 *  operator instead of (or in addition to) the auto-match: `scope`
 *  `'site'`/`'global'` mirror `template`'s own scope values, and `'other'`
 *  is a template linked only to sites outside this initiative (never
 *  auto-matched, but still pickable — `site_names` names those sites). */
export interface LabelTemplateCandidate {
  id: string; name: string; version: number;
  scope: 'site' | 'global' | 'other'; site_names: string[];
}

export interface LabelGeneratePreviewType {
  key: string; label: string;
  /** The server's own auto-match — `null` when nothing on the
   *  site/global scopes resolved (including when `candidates` holds only
   *  `'other'`-scope entries, which are never auto-matched). */
  template: { id: string; name: string; version: number; scope: 'site' | 'global' } | null;
  /** Every template of this type the operator could pick instead — the
   *  Label types card's template line shows a chooser from this list
   *  whenever `template` is null but this isn't empty. */
  candidates: LabelTemplateCandidate[];
  current: number; stale: number;
}

export interface LabelGeneratePreview {
  initiative: {
    id: string; name: string; client_name: string | null; status: string;
    scheduled_start: string | null; source_name: string | null; destination_name: string | null;
    asset_count: number;
  };
  types: LabelGeneratePreviewType[];
  active_run_id: string | null;
}

export async function getLabelGeneratePreview(initiativeId: string): Promise<LabelGeneratePreview> {
  const resp = await apiFetch(
    `/labels/generate/preview?initiative_id=${encodeURIComponent(initiativeId)}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export interface GeneratedLabel {
  id: string; entity_type: 'asset' | 'container'; entity_id: string;
  // the human Asset ID (assets.legacy_id, a BigInteger) — not a UUID.
  asset_id: number | null; serial_number: string | null; name: string | null;
  label_type: string; template_name: string; template_version: number;
  generated_at: string; stale: boolean; code: string;
}

export async function listGeneratedLabels(params: {
  initiative_id?: string; label_type?: string; limit?: number;
} = {}): Promise<GeneratedLabel[]> {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined) qs.set(k, String(v)); });
  const query = qs.toString();
  const resp = await apiFetch(`/labels/generated${query ? `?${query}` : ''}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

/** One row of a label bundle — `generated_labels` plus the template name,
 *  including the language/size/dpi keys the print page needs (a label
 *  compiled for a Brother printer must never be sent to a Zebra). */
export interface GeneratedLabelBundleItem {
  id: string; entity_type: 'asset' | 'container'; entity_id: string;
  template_id: string; template_name: string; template_version: number;
  language_key: string; size_key: string; dpi_key: string;
  stale: boolean; generated_at: string; code: string;
}

/** Every generated asset label of one type on one initiative — the Print
 *  Labels page's print payload and the unit its offline cache stores. */
export interface GeneratedLabelBundle {
  initiative_id: string; label_type: string; fetched_at: string;
  labels: GeneratedLabelBundleItem[];
}

export async function getGeneratedLabelBundle(
  initiativeId: string, labelType: string,
): Promise<GeneratedLabelBundle> {
  const qs = new URLSearchParams({ initiative_id: initiativeId, label_type: labelType });
  const resp = await apiFetch(`/labels/generated/bundle?${qs.toString()}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

// ── People dashboard ──────────────────────────────────────────────────

export interface TimeDayStat { day: string; minutes: number }

export interface TimeStatsSummary {
  clocked_in: number; pending_entries: number; minutes_today: number;
  days: TimeDayStat[];
}

export interface PeopleFlowEvent {
  person_id: string; display_name: string; avatar_url: string | null;
  device_id: string; site_name: string | null; scanned_at: string;
}

export interface PeopleFlowOut {
  events: PeopleFlowEvent[];
  distinct_people_today: number;
  person_scans_today: number;
}

export async function getTimeStatsSummary(): Promise<TimeStatsSummary> {
  const resp = await apiFetch('/time/stats/summary');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function getPeopleFlow(): Promise<PeopleFlowOut> {
  const resp = await apiFetch('/scans/people-flow');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

// ── Client dashboard ──

export interface ClientActivityItem {
  id: string; scanned_at: string; asset_id: string; asset_name: string | null;
  serial_number: string | null; status: string | null;
  status_label: string | null; status_color: string;
  site_name: string | null; device_id: string;
}

export interface ClientActivityOut {
  events: ClientActivityItem[];
  activity_7d: number;
}

export async function getClientActivity(clientId: string): Promise<ClientActivityOut> {
  const resp = await apiFetch(`/clients/${clientId}/activity`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

/* ── AI assistant ─────────────────────────────────────────────────── */

export type AiChatMessage = { role: 'user' | 'assistant'; content: string };
export type AiNavigate = { page: string; id?: string | null };
export type AiChatOut = { reply: string; navigate: AiNavigate | null };

export async function aiChatRequest(
  messages: AiChatMessage[],
): Promise<AiChatOut> {
  const resp = await apiFetch('/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
  });
  if (resp.status === 503) throw new Error('ai_offline');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

/* ── reports ──────────────────────────────────────────────────────── */

export type ReportRunStatus = 'queued' | 'running' | 'completed' | 'failed';

/** Definition options vary by report_type: Move Report's are all
 *  booleans (per-section toggles); Site & Move Survey's mixes a string
 *  (`company_name`) with three booleans — so this stays a loose
 *  `Record<string, unknown>` rather than `Record<string, boolean>`, and
 *  callers that know their type's shape narrow it themselves. */
export interface ReportDefinition {
  id: string; name: string; description: string; report_type: string;
  options: Record<string, unknown>; is_system: boolean; updated_at: string;
}

export interface ReportRun {
  id: string; definition_id: string; definition_name: string; report_type: string;
  // null when the run was generated without an initiative (e.g. a Site &
  // Move Survey run for a partner + manually chosen sites).
  initiative_id: string | null; initiative_name: string | null;
  options: Record<string, unknown>;
  status: ReportRunStatus; error: string | null;
  requested_by: string; requested_by_name: string; requested_rank: number; notify: boolean;
  filename: string | null; size_bytes: number | null;
  started_at: string | null; finished_at: string | null; created_at: string;
}

export async function listReportDefinitions(): Promise<ReportDefinition[]> {
  const resp = await apiFetch('/reports/definitions');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function cloneReportDefinition(id: string): Promise<ReportDefinition> {
  const resp = await apiFetch(`/reports/definitions/${id}/clone`, { method: 'POST' });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function updateReportDefinition(
  id: string, patch: { name?: string; description?: string; options?: Record<string, unknown> },
): Promise<ReportDefinition> {
  const resp = await apiFetch(`/reports/definitions/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function deleteReportDefinition(id: string): Promise<void> {
  const resp = await apiFetch(`/reports/definitions/${id}`, { method: 'DELETE' });
  if (!resp.ok) throw await errorFrom(resp);
}

export async function createReportRun(body: {
  definition_id: string; initiative_id: string | null; options: Record<string, unknown>; notify: boolean;
}): Promise<ReportRun> {
  const resp = await apiFetch('/reports/runs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

/** GET /reports/site-move-survey/partners — logistics partners only. Partners
 *  no longer carry a survey template (it lives on the report definition
 *  instead, alongside the `report_asset` docx — see uploadAttachmentRequest);
 *  the run's Options screen decides template readiness from the definition's
 *  attachments, not from this list. */
export interface SurveyPartnerOption { id: string; name: string }

export async function listSurveyPartners(): Promise<SurveyPartnerOption[]> {
  const resp = await apiFetch('/reports/site-move-survey/partners');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function listReportRuns(params: {
  status?: ReportRunStatus; report_type?: string; initiative_id?: string;
  before?: string; limit?: number;
} = {}): Promise<ReportRun[]> {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined) qs.set(k, String(v)); });
  const query = qs.toString();
  const resp = await apiFetch(`/reports/runs${query ? `?${query}` : ''}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function getReportRun(id: string): Promise<ReportRun> {
  const resp = await apiFetch(`/reports/runs/${id}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function getReportRunDownloadUrl(id: string): Promise<string> {
  const resp = await apiFetch(`/reports/runs/${id}/download`);
  if (!resp.ok) throw await errorFrom(resp);
  return (await resp.json() as { url: string }).url;
}

export async function setReportRunNotify(id: string, notify: boolean): Promise<ReportRun> {
  const resp = await apiFetch(`/reports/runs/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notify }),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

/** One status column in the Move Scan History preview — `all`-mode
 *  order, with `in_pipeline` so the modal can derive both column
 *  modes (see `moveScanHistory.ts`'s `columnsForMode`) without a
 *  second request. */
export interface ScanHistoryPreviewStatus {
  key: string; label: string; color: string | null;
  in_pipeline: boolean; scan_count: number;
}

export interface ScanHistoryPreview {
  initiative: {
    id: string; name: string; client_name: string | null;
    scheduled_start: string | null;
    source_name: string | null; destination_name: string | null;
  };
  total_assets: number; scanned_assets: number; completed: number; completion_pct: number;
  last_scan_at: string | null;
  statuses: ScanHistoryPreviewStatus[];
}

export async function getScanHistoryPreview(initiativeId: string): Promise<ScanHistoryPreview> {
  const resp = await apiFetch(
    `/reports/move-scan-history/preview?initiative_id=${encodeURIComponent(initiativeId)}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

/* ── in-app inbox ─────────────────────────────────────────────────── */

export interface InboxItem {
  id: string; kind: string; title: string; body: string; link: string | null;
  payload: Record<string, unknown>; created_at: string; read_at: string | null;
}
export interface Inbox { unread_count: number; items: InboxItem[] }

export async function listInbox(unreadOnly = false): Promise<Inbox> {
  const resp = await apiFetch(`/notifications/inbox${unreadOnly ? '?unread_only=true' : ''}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function markInboxRead(id: string): Promise<void> {
  const resp = await apiFetch(`/notifications/inbox/${id}/read`, { method: 'POST' });
  if (!resp.ok) throw await errorFrom(resp);
}

export async function markAllInboxRead(): Promise<void> {
  const resp = await apiFetch('/notifications/inbox/read-all', { method: 'POST' });
  if (!resp.ok) throw await errorFrom(resp);
}

export async function markInboxUnread(id: string): Promise<void> {
  const resp = await apiFetch(`/notifications/inbox/${id}/unread`, { method: 'POST' });
  if (!resp.ok) throw await errorFrom(resp);
}

/** Soft hide — the row keeps its dismissed_at server-side, it is not deleted. */
export async function hideInboxItem(id: string): Promise<void> {
  const resp = await apiFetch(`/notifications/inbox/${id}`, { method: 'DELETE' });
  if (!resp.ok) throw await errorFrom(resp);
}

export async function clearReadInbox(): Promise<void> {
  const resp = await apiFetch('/notifications/inbox/clear-read', { method: 'POST' });
  if (!resp.ok) throw await errorFrom(resp);
}

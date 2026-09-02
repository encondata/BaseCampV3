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
import type { OrgItem } from './orgs';
import type { WorkerItem } from './workers';

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

export class ApiError extends Error {
  // `detail` is the raw FastAPI error-detail object (e.g. { code, conflicts }
  // for the container-membership 409) — callers that need more than `code`
  // narrow it themselves, same as ContainerEditModal's mapError does.
  constructor(public status: number, public code: string, public detail?: unknown) {
    super(code);
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
}

export interface ContainerAssetRow {
  asset_id: string; serial_number: string | null; name: string | null;
  model_name: string | null;
  status: string; status_label: string; status_color: string;
  added_at: string; added_by_name: string | null;
}

export async function listContainers(): Promise<ContainerItem[]> {
  const resp = await apiFetch('/containers');
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
  options: { make_model_mode?: string; generate_serials?: boolean };
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

/* ── db backups ───────────────────────────────────────────────────── */

export interface DbBackupItem {
  id: string;
  filename: string;
  size_bytes: number;
  encrypted: boolean;
  created_at: string;
  created_by: string | null;
  created_by_name: string | null;
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

/** The live-tail WebSocket URL. Browsers cannot set Authorization on
 *  WebSockets, so the current access token rides a query param. */
export function logStreamUrl(
  name: string, token: string,
  opts: { minLevel?: string; q?: string } = {},
): string {
  const params = new URLSearchParams({ token });
  if (opts.minLevel) params.set('min_level', opts.minLevel);
  if (opts.q) params.set('q', opts.q);
  return `${apiUrl().replace(/^http/, 'ws')}/system/processes/${name}/logs/stream?${params}`;
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

export interface LabelTemplate {
  id: string; name: string; description: string; label_type: string;
  size_key: string; dpi_key: string; language_key: string;
  kind: 'design' | 'code'; design: Record<string, unknown> | null;
  code: string | null; version: number; is_active: boolean;
  site_ids: string[];
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

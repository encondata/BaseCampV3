/**
 * Kiosk API transport — the portal's session rules, restated for a
 * second app (see portal/src/lib/api.ts for the original reasoning):
 *
 * - The refresh token lives in the API's httpOnly cookie (path /auth);
 *   the access token lives only in this module's memory.
 * - Any 401 triggers exactly one silent refresh (single-flight) and one
 *   retry; only when that fails do we announce the session has ended.
 * - No timer-based refresh; refresh on demand and on tab re-focus.
 * - Login is tagged client:"kiosk" so the API applies the kiosk:view
 *   gate before minting a session.
 *
 * Types come from the portal (type-only imports are erased at build).
 */

import type { LabelVocab, PersonOut, SessionData, UiPreferences } from '@portal/lib/api';
import type { SystemStatus } from '@portal/lib/systemStatus';

import { apiUrl } from './config';

export type { PersonOut, SessionData, SystemStatus, UiPreferences };

export class ApiError extends Error {
  constructor(public status: number, public code: string, public detail?: unknown) {
    super(code);
  }
}

/** What a screen says when the laptop edge answers 403
 *  `cloud_sign_in_required`: the person signed in while the laptop was
 *  offline (or with the move password offline), so the edge holds no
 *  cloud session for them. Their edge session is still good — it is not a
 *  401, so they are never signed out — but this action needs the cloud. */
export const CLOUD_SIGN_IN_TEXT = 'Sign in again while online to do this.';

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
  // The laptop edge answers 503 edge_offline when the cloud is unreachable;
  // to every screen that is the same as the network being down.
  if (code === 'edge_offline') return new ApiError(0, 'network', detail);
  return new ApiError(resp.status, code, detail);
}

/** fetch that turns a thrown network failure into ApiError('network'). */
async function request(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw new ApiError(0, 'network');
  }
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
  return !accessToken || Date.now() > accessTokenExpiresAt - 30_000;
}

// ── refresh (single-flight) ─────────────────────────────────────────

let refreshInFlight: Promise<SessionData | null> | null = null;

export function refreshSession(): Promise<SessionData | null> {
  refreshInFlight ??= (async () => {
    try {
      const resp = await fetch(`${apiUrl()}/auth/refresh?client=kiosk`, { method: 'POST', credentials: 'include' });
      if (!resp.ok) {
        clearLocalSession();
        return null;
      }
      const data: SessionData = await resp.json();
      storeSession(data);
      return data;
    } catch {
      return null; // network hiccup: keep local state
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

/** Re-focus of an idle tab: refresh BEFORE data requests fire. */
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
  if (tokenIsStale()) await refreshSession();
  const doFetch = () =>
    request(`${apiUrl()}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
    });
  let resp = await doFetch();
  if (resp.status === 401) {
    const refreshed = await refreshSession();
    if (refreshed) resp = await doFetch();
    if (!refreshed || resp.status === 401) notifySessionEnded();
  }
  return resp;
}

async function jsonFrom<T>(resp: Response): Promise<T> {
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json() as Promise<T>;
}

// ── auth ────────────────────────────────────────────────────────────

export async function loginRequest(email: string, password: string): Promise<SessionData> {
  const resp = await request(`${apiUrl()}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email, password, client: 'kiosk' }),
  });
  const data = await jsonFrom<SessionData>(resp);
  storeSession(data);
  return data;
}

/** Sign in with a move's kiosk password (no person account involved). */
export async function moveLoginRequest(password: string): Promise<SessionData> {
  const resp = await request(`${apiUrl()}/kiosk/move-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ password }),
  });
  const data = await jsonFrom<SessionData>(resp);
  storeSession(data);
  return data;
}

export async function logoutRequest(): Promise<void> {
  try {
    await fetch(`${apiUrl()}/auth/logout?client=kiosk`, { method: 'POST', credentials: 'include' });
  } catch {
    /* offline logout still clears local state */
  } finally {
    clearLocalSession();
  }
}

// ── pairing (kiosk side) ────────────────────────────────────────────

export type PairStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface PairCreated {
  code: string;
  poll_token: string;
  link_url: string;
  expires_at: string;
}

export interface PairPoll {
  status: PairStatus;
  session: SessionData | null;
}

export async function createPairRequest(body: { serial: string; name: string }): Promise<PairCreated> {
  const resp = await request(`${apiUrl()}/kiosk/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return jsonFrom<PairCreated>(resp);
}

/** Polls a code. A 404 (unknown, cleaned up) reads as expired. An
 *  approved answer carries the session and sets the refresh cookie. */
export async function pollPair(code: string, pollToken: string): Promise<PairPoll> {
  const resp = await request(`${apiUrl()}/kiosk/pair/${encodeURIComponent(code)}/poll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ poll_token: pollToken }),
  });
  if (resp.status === 404) return { status: 'expired', session: null };
  const data = await jsonFrom<{ status: PairStatus; session?: SessionData | null }>(resp);
  if (data.status === 'approved' && data.session) storeSession(data.session);
  return { status: data.status, session: data.session ?? null };
}

// ── heartbeat ───────────────────────────────────────────────────────

export type RegistrationState = 'ok' | 'soon' | 'expired' | 'none';

export interface HeartbeatResult {
  device_id: string;
  name: string;
  registration: RegistrationState;
  token_expires_at: string | null;
  /** The address the cloud saw this kiosk's request come from (its WAN IP). */
  client_ip?: string | null;
  clear_setup?: string | null;
  /** The portal's clock (ISO, UTC): the kiosk keeps its offset from it. */
  server_time?: string | null;
  /** The portal's current config version (0: nothing stored yet). */
  config_version?: number | null;
  /** The whole stored config, sent while this kiosk is behind. */
  config?: Record<string, unknown> | null;
  /** The device's scan type, when the portal may share it with this kiosk. */
  scan_status?: string | null;
  scan_status_label?: string | null;
}

/** The settings-sync fields a beat may carry (kioskConfig.ts). */
export interface HeartbeatConfigFields {
  config?: Record<string, unknown>;
  config_changed_at?: string | null;
  config_applied_version: number | null;
}

export async function heartbeatRequest(body: {
  serial: string; name: string; mode: string; version: string | null; sign_in?: boolean;
  login_method?: 'password' | 'link'; setup_cleared?: string;
} & Partial<HeartbeatConfigFields>): Promise<HeartbeatResult> {
  const { sign_in, ...rest } = body;
  const resp = await apiFetch('/kiosk/heartbeat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sign_in ? { ...rest, sign_in } : rest),
  });
  return jsonFrom<HeartbeatResult>(resp);
}

// ── kiosk sounds (portal-backed) ───────────────────────────────────

export interface KioskSoundOut { id: string; name: string; content_type: string; size: number }

/** Uploads a sound to the portal (`POST /kiosk/sounds`); the config then
 *  names it by the returned id. Rejects with an ApiError (413
 *  `file_too_large`, 422 `not_audio` / `empty_file`, 0 `network`). */
export async function uploadKioskSound(file: Blob, name: string, serial: string): Promise<KioskSoundOut> {
  const form = new FormData();
  form.append('file', file, name);
  form.append('serial', serial);
  const resp = await apiFetch('/kiosk/sounds', { method: 'POST', body: form });
  return jsonFrom<KioskSoundOut>(resp);
}

/** Downloads a portal sound's bytes (`GET /kiosk/sounds/{id}`). */
export async function downloadKioskSound(id: string): Promise<Blob> {
  const resp = await apiFetch(`/kiosk/sounds/${encodeURIComponent(id)}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.blob();
}

/** Clears this kiosk's signed-in session on the server. Never throws —
 *  the kiosk is about to drop its own token either way, so a failed
 *  sign-out isn't worth surfacing to the person signing out. */
export async function signOutRequest(serial: string): Promise<void> {
  try {
    await apiFetch('/kiosk/sign-out', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serial }),
    });
  } catch {
    /* ignore — kiosk is signing out regardless */
  }
}

// ── kiosk setup wizard ──────────────────────────────────────────────

export interface SetupOptionSite { id: string; name: string }

export interface SetupOptionInitiative {
  id: string; name: string; status: string; status_label: string;
  client_name: string | null;
  scheduled_start: string | null;
  scheduled_end: string | null;
  source_site: SetupOptionSite | null;
  destination_site: SetupOptionSite | null;
}

/** One asset-status checkpoint the portal offers a kiosk — Kiosk
 *  Setup's scan type, and Settings › Admin's RFID Enroll checkpoint. */
export interface SetupOptionScanType { key: string; label: string; color: string }

export interface SetupOptions {
  initiatives: SetupOptionInitiative[];
  scan_types: SetupOptionScanType[];
  /** Every site, for a Time Clock station set up without a move. */
  sites: SetupOptionSite[];
}

export interface KioskSetupResult {
  device_id: string;
  /** Null for a Time Clock station set up without a move, site, or scan type. */
  initiative_id: string | null;
  initiative_name: string | null;
  site_id: string | null;
  site_name: string | null;
  site_role: 'source' | 'destination' | 'other' | null;
  scan_status: string | null;
  scan_status_label: string | null;
}

export async function getSetupOptions(): Promise<SetupOptions> {
  const resp = await apiFetch('/kiosk/setup-options');
  return jsonFrom<SetupOptions>(resp);
}

/** `station_type` is sent only by a laptop (Kiosk Setup's first step); for
 *  `rfid` the edge adds the paired reader itself — the browser never sends
 *  reader details. A `timeclock` station may leave out the move, the site,
 *  and the scan type. */
export async function submitKioskSetup(body: {
  serial: string; initiative_id: string | null; site_id: string | null; scan_status?: string;
  station_type?: 'label' | 'rfid' | 'timeclock';
}): Promise<KioskSetupResult> {
  const resp = await apiFetch('/kiosk/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return jsonFrom<KioskSetupResult>(resp);
}

// ── local-data sync (after Kiosk Setup) ─────────────────────────────

/** One roster asset. `label` is the label placeholder map the API built
 *  with the label generator's own resolver — the keys the label
 *  templates use (`asset_id`, `asset_name`, `serial_number`, `make`,
 *  `model`, `make_model`, `source_raw`/`source_ru`/`source_site`, the
 *  destination trio, `move_name`, `move_date`). */
export interface KioskAssetRow {
  id: string;
  asset_id: string;
  name: string | null;
  rfid: string | null;
  serial_number: string | null;
  make: string | null;
  model: string | null;
  make_model: string;
  label: Record<string, string>;
}

export interface KioskAssetsSync {
  initiative_id: string;
  initiative_name: string;
  generated_at: string;
  assets: KioskAssetRow[];
}

/** One cached person. The name parts ride along with `display_name` so
 *  the timeclock can match a typed name in any order (`peopleMatch.ts`)
 *  without re-splitting a formatted string. */
export interface KioskPersonRow {
  id: string;
  display_name: string;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
  rfid_tag: string | null;
  /** Badge UUID, matched by a scan of the printed badge. */
  badge_uid?: string;
  job_title?: string | null;
  external_id?: string | null;
  is_worker: boolean;
  has_account: boolean;
}

export interface KioskPeopleSync {
  generated_at: string;
  people: KioskPersonRow[];
}

/** One of the move's containers, as the kiosk caches it. `asset_count`
 *  is the count at sync time — the Containers screen keeps its own live
 *  count from there, and every pack/unpack answer carries a fresh one. */
export interface KioskContainerRow {
  id: string;
  name: string;
  rfid_tag: string | null;
  label_tag: string | null;
  container_type: string | null;
  status: string;
  status_label: string;
  site_id: string | null;
  site_name: string | null;
  asset_count: number;
}

export interface KioskContainersSync {
  initiative_id: string;
  generated_at: string;
  containers: KioskContainerRow[];
}

/** One of the move's trucks, as the kiosk caches it. Nothing here is a
 *  scannable key — a truck carries no RFID tag — so this is the card
 *  picker's row: what it shows, and the two fields its filter narrows on
 *  (`name`, `load_number`). `container_count` is the count at sync time;
 *  the Trucks screen keeps its own live count from there. */
export interface KioskTruckRow {
  id: string;
  name: string;
  load_number: string | null;
  status: string;
  status_label: string;
  driver_name: string | null;
  start_site_id: string | null;
  start_site_name: string | null;
  end_site_id: string | null;
  end_site_name: string | null;
  container_count: number;
}

export interface KioskTrucksSync {
  initiative_id: string;
  generated_at: string;
  trucks: KioskTruckRow[];
}

/** Why a template is in the move's set — one or more per template. */
export type KioskLabelTemplateReason =
  'destination_site' | 'source_site' | 'front' | 'generic' | 'container' | 'fallback' | 'global';

/** One label template from the move's set (`/kiosk/sync/label-templates`).
 *  `code` is the printer code at the template's own size and DPI with its
 *  `{placeholder}` tokens intact — a design template arrives already
 *  converted, except a label builder design (`schema_version` 2), whose
 *  `code` is `""`. When a design could not convert, `code` is `""` and
 *  `error` says why. `move_site_names` lists only the move's own origin and
 *  destination sites the template is linked to. */
export interface KioskLabelTemplate {
  id: string;
  name: string;
  /** The name without its trailing DPI marker; the DPI versions of one
   *  template share it. Missing from sets cached before it was added. */
  family?: string;
  label_type: string;
  size_key: string;
  dpi_key: string;
  language_key: string;
  version: number;
  updated_at: string;
  move_site_names: string[];
  reasons: KioskLabelTemplateReason[];
  code: string;
  generation_rules: Record<string, unknown>;
  width_in: number | null;
  height_in: number | null;
  dots: number | null;
  error: string | null;
  /** 'code' or 'design'. Missing from sets cached before it was added. */
  kind?: 'code' | 'design';
  /** A design template's stored design JSON (the laptop edge compiles it
   *  with the asset's values); null for a code template. */
  design?: Record<string, unknown> | null;
  /** How its site links relate to this move: 'global' when it has none. */
  scope?: 'destination' | 'source' | 'both' | 'global' | 'other';
  /** The design's schema (1 for code). A label builder child is 2, with
   *  `code` "" (the laptop edge renders its design); an edge that knows a
   *  lower schema reports its labels `template_unsupported`. Missing from
   *  sets cached before it was added. */
  schema_version?: number;
}

export interface KioskLabelTemplatesSync {
  initiative_id: string;
  generated_at: string;
  templates: KioskLabelTemplate[];
}

/** The whole roster in one response — the API does not page it. */
export async function fetchAssetsSync(initiativeId: string): Promise<KioskAssetsSync> {
  const resp = await apiFetch(`/kiosk/sync/assets?initiative_id=${encodeURIComponent(initiativeId)}`);
  return jsonFrom<KioskAssetsSync>(resp);
}

export async function fetchPeopleSync(): Promise<KioskPeopleSync> {
  const resp = await apiFetch('/kiosk/sync/people');
  return jsonFrom<KioskPeopleSync>(resp);
}

/** The move's unarchived containers, in one response like the roster. */
export async function fetchContainersSync(initiativeId: string): Promise<KioskContainersSync> {
  const resp = await apiFetch(
    `/kiosk/sync/containers?initiative_id=${encodeURIComponent(initiativeId)}`);
  return jsonFrom<KioskContainersSync>(resp);
}

/** The move's unarchived trucks, in one response like the crates. */
export async function fetchTrucksSync(initiativeId: string): Promise<KioskTrucksSync> {
  const resp = await apiFetch(
    `/kiosk/sync/trucks?initiative_id=${encodeURIComponent(initiativeId)}`);
  return jsonFrom<KioskTrucksSync>(resp);
}

/** The move's label template set — the whole set every time (no delta). */
export async function fetchLabelTemplatesSync(
  initiativeId: string,
): Promise<KioskLabelTemplatesSync> {
  const resp = await apiFetch(
    `/kiosk/sync/label-templates?initiative_id=${encodeURIComponent(initiativeId)}`);
  return jsonFrom<KioskLabelTemplatesSync>(resp);
}

// ── scan ingest ─────────────────────────────────────────────────────

/** One scan the kiosk already matched against its local copy of the
 *  move. `asset_id` is that local match — informational only; the server
 *  re-matches `scanned_value` itself. `site_id`/`initiative_id`/
 *  `scan_status` come from Kiosk Setup and default to the Device's own
 *  setup when omitted. */
export interface KioskScanIn {
  client_scan_id: string;
  scanned_value: string;
  scan_type: 'rfid' | 'barcode';
  scanned_at: string;
  asset_id?: string | null;
  site_id?: string | null;
  initiative_id?: string | null;
  scan_status?: string | null;
}

export interface KioskScanBatchOut {
  accepted: string[];
  rejected: { client_scan_id: string; code: string }[];
}

/** Posts 1-100 scans. Idempotent on `client_scan_id`, so a batch the
 *  kiosk retried because it never saw the response is accepted again
 *  rather than double-counted — which is what lets the outbox retry a
 *  timeout without thinking twice. Throws `ApiError` on anything but a
 *  200 (including 423 read-only and a network failure), which is the
 *  outbox's signal to back off and try the whole batch again. */
export async function postScans(
  body: { serial: string; scans: KioskScanIn[] },
): Promise<KioskScanBatchOut> {
  const resp = await apiFetch('/kiosk/scans', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return jsonFrom<KioskScanBatchOut>(resp);
}

// ── RFID enroll ─────────────────────────────────────────────────────

/** The tagged asset, as the portal now holds it. `rfid_tag` is the
 *  stored (24-character, zero-padded) value — trim it with
 *  `displayRfid` for display. `already_had_tag` means this asset was
 *  already carrying exactly this tag, so only the scan was recorded. */
export interface KioskRfidEnroll {
  asset_id: string;
  asset_name: string | null;
  asset_tag: string;
  serial_number: string | null;
  rfid_tag: string;
  already_had_tag: boolean;
}

/** Writes an RFID tag onto an asset and records the enrollment scan, in
 *  one server transaction. `rfid_tag` is padded here as well as on the
 *  server (see `lib/rfid.ts`) so the operator sees what will be stored;
 *  the server normalizes again and never trusts this value.
 *
 *  There is deliberately no outbox behind this: uniqueness can only be
 *  decided by the portal, so a save that does not reach it did not
 *  happen. Throws `ApiError` — 409 `rfid_in_use` (its `detail` carries
 *  the other asset's `asset_id` / `asset_name`), 422 `bad_rfid` /
 *  `rfid_too_long` / `bad_status`, 404 `asset_not_found` /
 *  `device_not_found`, 423 read-only, 0 `network`. */
export async function postRfidEnroll(body: {
  asset_id: string; serial: string; rfid_tag: string; scan_status: string;
  client_scan_id: string; site_id?: string | null; initiative_id?: string | null;
}): Promise<KioskRfidEnroll> {
  const { asset_id: assetId, ...rest } = body;
  const resp = await apiFetch(`/kiosk/assets/${encodeURIComponent(assetId)}/rfid`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(rest),
  });
  return jsonFrom<KioskRfidEnroll>(resp);
}

// ── containers: pack / unpack ───────────────────────────────────────

/** A container named in a pack/unpack answer — the one packed into, or
 *  the one an asset came out of. */
export interface KioskContainerRef { id: string; name: string }

export interface KioskContainerAssetResult {
  container: KioskContainerRef & { asset_count: number };
  asset: {
    id: string; name: string | null; asset_tag: string;
    serial_number: string | null; rfid: string | null;
  };
  action: 'pack' | 'unpack';
  moved_from: KioskContainerRef | null;
  already_there: boolean;
}

/** Packs an asset into a container (or unpacks it out of one) and
 *  records the scan that produced it, in one server transaction.
 *
 *  There is deliberately no outbox behind this: which container an asset
 *  is in is relational state only the portal can resolve — packing
 *  something already crated elsewhere MOVES it — so a call that does not
 *  reach the portal did not happen. Throws `ApiError` — 409
 *  `not_in_container` (its `detail` carries the `container_id` /
 *  `container_name` the asset is actually in, when it is in one), 404
 *  `container_not_found` / `asset_not_found` / `device_not_found`, 422
 *  `bad_status` / `bad_site` / `bad_initiative`, 423 read-only, 0
 *  `network`. */
export async function postContainerAsset(body: {
  container_id: string; serial: string; asset_id: string;
  action: 'pack' | 'unpack'; scanned_value: string; scan_type: 'rfid' | 'barcode';
  scan_status: string; client_scan_id: string;
  site_id?: string | null; initiative_id?: string | null;
}): Promise<KioskContainerAssetResult> {
  const { container_id: containerId, ...rest } = body;
  const resp = await apiFetch(
    `/kiosk/containers/${encodeURIComponent(containerId)}/assets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rest),
    });
  return jsonFrom<KioskContainerAssetResult>(resp);
}

// ── trucks: load / unload ───────────────────────────────────────────

/** A truck named in a load/unload answer — the one loaded, or the one a
 *  container came off / is actually on. */
export interface KioskTruckRef { id: string; name: string }

export interface KioskTruckContainerResult {
  truck: KioskTruckRef & { container_count: number };
  container: { id: string; name: string; asset_count: number };
  action: 'load' | 'unload';
  moved_from: KioskTruckRef | null;
  already_there: boolean;
}

/** Loads a container onto a truck (or unloads it off one) and records the
 *  scan that produced it, in one server transaction.
 *
 *  Trucks carry CONTAINERS: `truck_containers` is keyed on (truck_id,
 *  container_id) and there is no asset-to-truck link, so an asset the
 *  operator scanned is resolved to its container on the kiosk and this
 *  call only ever names a container. `scanned_value` still carries what
 *  was physically read.
 *
 *  There is deliberately no outbox behind this, for the same reason
 *  `postContainerAsset` has none: which truck carries a crate is
 *  relational state only the portal can resolve — loading one that is
 *  already riding another truck MOVES it. Throws `ApiError` — 409
 *  `not_on_truck` (its `detail` carries the `truck_id` / `truck_name` the
 *  container is actually on, when it is on one), 404 `truck_not_found` /
 *  `container_not_found` / `device_not_found`, 422 `bad_status` /
 *  `bad_scan_type` / `bad_site` / `bad_initiative`, 423 read-only, 0
 *  `network`. */
export async function postTruckContainer(body: {
  truck_id: string; serial: string; container_id: string;
  action: 'load' | 'unload'; scanned_value: string; scan_type: 'rfid' | 'barcode';
  scan_status: string; client_scan_id: string;
  site_id?: string | null; initiative_id?: string | null;
}): Promise<KioskTruckContainerResult> {
  const { truck_id: truckId, ...rest } = body;
  const resp = await apiFetch(
    `/kiosk/trucks/${encodeURIComponent(truckId)}/containers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rest),
    });
  return jsonFrom<KioskTruckContainerResult>(resp);
}

// ── printer maintenance ─────────────────────────────────────────────

/** One piece of printer maintenance this kiosk performed over WebUSB.
 *  `event` is an enum on the server too, so a later maintenance action
 *  joins this union rather than getting its own endpoint. */
export interface KioskPrinterEvent {
  serial: string;
  event: 'factory_reset';
  outcome: 'completed' | 'failed';
  printer_model?: string | null;
  printer_firmware?: string | null;
  calibrated?: boolean;
  failed_step?: string | null;
  error?: string | null;
}

/** Reports maintenance so it lands in the portal's audit log. Resolves
 *  to whether it was recorded and NEVER throws or rejects: the printer
 *  work already happened out at the kiosk, so a server that is down,
 *  slow, or unreachable must not break the flow that is reporting it —
 *  the caller shows a "couldn't record this" line and carries on. */
export async function postPrinterEvent(body: KioskPrinterEvent): Promise<boolean> {
  try {
    const resp = await apiFetch('/kiosk/printer-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

// ── public system status (login banners) ────────────────────────────

export const DEFAULT_SYSTEM_STATUS: SystemStatus = {
  read_only: false, read_only_message: '', workers_paused: false, banner: null, totp_trust_days: 7,
  email_enabled: false, password_reset_ttl_minutes: 15, password_min_length: 8,
};

export async function getSystemStatus(): Promise<SystemStatus> {
  const resp = await request(`${apiUrl()}/system/status`);
  return jsonFrom<SystemStatus>(resp);
}

// ── timeclock (the kiosk punch clock) ───────────────────────────────

/** Who the kiosk is punching, as the timeclock card shows them.
 *  `avatar_url` is presigned and short-lived — fetched with the status,
 *  never cached locally. */
export interface KioskTimeclockPerson {
  id: string;
  display_name: string;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
  avatar_url: string | null;
  rfid_tag: string | null;
  job_title: string | null;
  external_id: string | null;
}

/** The open entry, so the card can count up from `started_at` and name
 *  the move and site the punch belongs to. */
export interface KioskTimeclockEntry {
  id: string;
  started_at: string;
  initiative_id: string | null;
  initiative_name: string | null;
  site_id: string | null;
  site_name: string | null;
}

/** The entry a clock-out just closed — enough for "Clocked out ·
 *  3h 12m" without a second round trip. */
export interface KioskTimeclockLastEntry {
  id: string;
  started_at: string;
  ended_at: string;
  minutes: number;
}

export interface KioskTimeclockStatus {
  person: KioskTimeclockPerson;
  clocked_in: boolean;
  entry: KioskTimeclockEntry | null;
  last_entry: KioskTimeclockLastEntry | null;
  /** Minutes worked today (the site's day, else the kiosk's, else UTC's),
   *  open entry counted to now. */
  today_minutes: number;
  /** Today's entries, oldest first. */
  today_entries: { clock_in_at: string; clock_out_at: string | null; minutes: number }[];
}

/** Is this person on the clock right now, and since when? 404
 *  `person_not_found` for someone the portal no longer has (or has
 *  archived) — a kiosk holding a stale local copy is the likely cause.
 *  `serial` names the kiosk so "today" is its site's day; `tz` (the
 *  kiosk's own zone) is the day when the site has no zone. */
export async function fetchTimeclockStatus(
  personId: string, serial?: string, tz?: string,
): Promise<KioskTimeclockStatus> {
  const params = [
    serial ? `serial=${encodeURIComponent(serial)}` : '',
    tz ? `tz=${encodeURIComponent(tz)}` : '',
  ].filter(Boolean);
  const query = params.length ? `?${params.join('&')}` : '';
  const resp = await apiFetch(`/kiosk/timeclock/${encodeURIComponent(personId)}${query}`);
  return jsonFrom<KioskTimeclockStatus>(resp);
}

/** Opens an entry for the worker at the kiosk. Site and move come from
 *  Kiosk Setup; left out, the server falls back to the kiosk Device's
 *  own setup. Always stamped with the server's clock — there is no
 *  `at`, deliberately: back-dating a punch stays a portal action (see
 *  the spec's Timeclock security note). Throws `ApiError` — 409
 *  `already_clocked_in`, 422 `bad_site`/`bad_initiative`, 423
 *  read-only, 0 `network`. */
export async function postClockIn(body: {
  serial: string; person_id: string;
  site_id?: string | null; initiative_id?: string | null;
  /** The kiosk's own zone, as for `fetchTimeclockStatus`. */
  tz?: string;
}): Promise<KioskTimeclockStatus> {
  const resp = await apiFetch('/kiosk/timeclock/clock-in', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return jsonFrom<KioskTimeclockStatus>(resp);
}

/** Closes the worker's open entry; the answer carries `last_entry` with
 *  the minutes worked. 409 `not_clocked_in` when there is none. No
 *  `at` either, for the same reason as `postClockIn`. */
export async function postClockOut(body: {
  serial: string; person_id: string; tz?: string;
}): Promise<KioskTimeclockStatus> {
  const resp = await apiFetch('/kiosk/timeclock/clock-out', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return jsonFrom<KioskTimeclockStatus>(resp);
}

// ── label vocabulary ────────────────────────────────────────────────

/** Re-exported from the portal so the printer tools share one shape. */
export type { LabelVocab };

/** Label sizes, DPI, types, and languages for the printer tools.
 *  Deliberately NOT the portal's `/labels/vocab`: that gates on
 *  labels:view, which the `worker` role does not hold, so a worker at a
 *  kiosk could not size a test label. `/kiosk/labels/vocab` returns the
 *  same rows under kiosk:view (read-only reference data). */
export async function fetchLabelVocab(kind?: string): Promise<LabelVocab[]> {
  const resp = await apiFetch(kind
    ? `/kiosk/labels/vocab?kind=${encodeURIComponent(kind)}`
    : '/kiosk/labels/vocab');
  return jsonFrom<LabelVocab[]>(resp);
}

// ── laptop edge (kiosk_laptop/) ─────────────────────────────────────

export type OutboxStatus = 'queued' | 'sending' | 'sent' | 'rejected' | 'failed' | 'needs_sign_in';

export interface EdgeStatus {
  version: string;
  cloud: { online: boolean; last_contact: string | null };
  sync: { initiative_id: string | null; synced_at: string | null; last_error: string | null };
  outbox: Record<OutboxStatus, number>;
  waiting: { person_name: string; count: number }[];
  session: { offline: boolean } | null;
  identity: { serial: string; name: string };
}

/** Polled by the footer and the Login page, signed in or not — so it sends
 *  the token if there is one but never triggers a refresh. */
export async function getEdgeStatus(): Promise<EdgeStatus> {
  const resp = await request(`${apiUrl()}/edge/status`, {
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
  });
  return jsonFrom<EdgeStatus>(resp);
}

export async function edgeSyncNow(): Promise<EdgeStatus> {
  return jsonFrom<EdgeStatus>(await apiFetch('/edge/sync', { method: 'POST' }));
}

export async function edgeRetryFailed(): Promise<{ requeued: number }> {
  return jsonFrom<{ requeued: number }>(await apiFetch('/edge/outbox/retry', { method: 'POST' }));
}

/** 409 `outbox_not_empty` (detail.pending) until confirm is 'WIPE'. */
export async function edgeWipe(confirm?: string): Promise<{ cleared_move_data: boolean }> {
  const resp = await apiFetch('/edge/wipe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(confirm ? { confirm } : {}),
  });
  return jsonFrom<{ cleared_move_data: boolean }>(resp);
}

export async function renameLaptopKiosk(name: string): Promise<{ serial: string; name: string }> {
  const resp = await apiFetch('/edge/identity', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  return jsonFrom<{ serial: string; name: string }>(resp);
}

// ── RFID reader setup (laptop edge, Kiosk Setup's RFID steps) ───────
// Errors carry `detail.code`: reader_unreachable, reader_auth_failed,
// reader_not_iotc, reader_error (with detail.message), reader_verify_failed
// (502); reader_paired_elsewhere (409, with detail.name),
// host_network_unknown and reader_not_on_subnet (409);
// bad_ip (422); edge_offline (503: connect and pair need an online sign-in).

export interface ReaderVersions {
  readerApplication: string | null;
  radioFirmware: string | null;
  cloudAgentApplication: string | null;
}

/** One reader a scan found. `paired_with` names another kiosk holding it.
 *  A Zebra reader the scan didn't sign in to (no remembered password) has
 *  `needs_connect` and no model or serial yet: picking it goes to Connect. */
export interface FoundReader {
  ip: string;
  model: string | null;
  serial: string | null;
  paired_with: string | null;
  needs_connect?: boolean;
  scheme?: 'https' | 'http';
  port?: number;
}

export interface ReaderScan {
  scan_id: string | null;
  state: 'running' | 'done' | 'failed';
  probed: number;
  total: number;
  readers: FoundReader[];
  /** `fresh` is false when the laptop's own address isn't known. */
  host: { ips: string[]; fresh: boolean };
}

export interface ReaderInfo {
  ip: string;
  model: string;
  serial: string;
  versions: ReaderVersions;
  /** The reader's own /cloud/status body, passed through as-is. */
  status: Record<string, unknown> | null;
  paired_with: string | null;
}

export interface PairedReader {
  ip: string;
  serial: string;
  model: string;
  versions: ReaderVersions | null;
  paired_at: string;
  laptop_ip?: string | null;
  endpoint_url?: string | null;
}

export interface PairResult {
  paired: true;
  reader: Pick<PairedReader, 'ip' | 'serial' | 'model' | 'versions' | 'paired_at'>;
  /** Already redacted by the edge (the token shows as …). */
  endpoint_url: string;
}

function postJson(path: string, body: unknown): Promise<Response> {
  return apiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Starts a subnet scan (cancelling a running one). */
export async function startReaderScan(): Promise<{ scan_id: string }> {
  return jsonFrom<{ scan_id: string }>(await apiFetch('/edge/rfid/scan', { method: 'POST' }));
}

export async function getReaderScan(): Promise<ReaderScan> {
  return jsonFrom<ReaderScan>(await apiFetch('/edge/rfid/scan'));
}

export async function connectReader(ip: string): Promise<ReaderInfo> {
  return jsonFrom<ReaderInfo>(await postJson('/edge/rfid/connect', { ip }));
}

export async function pairReader(body: {
  ip: string; laptop_ip?: string; confirm_takeover?: boolean;
}): Promise<PairResult> {
  return jsonFrom<PairResult>(await postJson('/edge/rfid/pair', body));
}

/** The laptop's finished Kiosk Setup as the edge keeps it for every
 *  browser (D2): the setup answer's names plus, for an RFID station, the
 *  paired reader's summary. */
export interface EdgeSetup {
  /** The move, site, and scan fields are null only for a Time Clock station. */
  initiative_id: string | null;
  initiative_name: string | null;
  site_id: string | null;
  site_name: string | null;
  site_role: 'source' | 'destination' | 'other' | null;
  scan_status: string | null;
  scan_status_label: string | null;
  station_type: 'label' | 'rfid' | 'timeclock' | null;
  reader: { ip: string; serial: string; model: string; versions: Partial<ReaderVersions> } | null;
  /** A Label Station's saved printer settings; null until step 5 saves them. */
  label_station?: LabelStationSettings | null;
  updated_at: string;
}

/** The laptop's shared setup, or null when it has never been set up. */
export async function getEdgeSetup(): Promise<EdgeSetup | null> {
  return jsonFrom<EdgeSetup | null>(await apiFetch('/edge/setup'));
}

/** The laptop's kiosk config as the edge holds it for every browser:
 *  `version` counts changes on the edge (not the portal's version). */
export interface EdgeConfig {
  doc: Record<string, unknown> | null;
  version: number;
  changed_at: string | null;
}

export async function getEdgeConfig(): Promise<EdgeConfig> {
  return jsonFrom<EdgeConfig>(await apiFetch('/edge/config'));
}

/** Writes this browser's document. `seed`: only when the edge has none
 *  (not a change). Otherwise `base_version` is the edge version it started
 *  from; a stale one is 409 `config_changed` with the current copy in the
 *  error's detail (`doc`, `version`, `changed_at`). */
export async function putEdgeConfig(body: {
  doc: Record<string, unknown>; base_version?: number; seed?: boolean;
}): Promise<EdgeConfig> {
  return jsonFrom<EdgeConfig>(await apiFetch('/edge/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

// ── RFID Network check and reader reading (laptop edge) ─────────────

export type CheckName = 'reader' | 'router' | 'portal' | 'registration' | 'setup' | 'uploads';

export interface CheckResult {
  name: CheckName;
  ok: boolean;
  state: 'ok' | 'fail' | 'unknown';
  detail: string;
  info?: Record<string, string | boolean | null>;
}

/** One connectivity check. Always answers 200; a failing check says so in `state`. */
export async function runCheck(name: CheckName): Promise<CheckResult> {
  return jsonFrom<CheckResult>(await apiFetch(`/edge/rfid/checks/${name}`));
}

export interface ReaderStatus {
  reader: { ip: string; serial: string; model: string; endpoint_url: string | null } | null;
  reachable?: boolean;
  reading?: boolean;
  radio?: string | null;
  /** Antenna ports reported connected, sorted; empty when unknown. */
  antennas?: string[];
  /** The edge was busy with another reader call and didn't ask the reader. */
  busy?: boolean;
}

/** One line of the edge's RFID event log, newest first. */
export interface RfidEvent {
  id: number;
  at: string;
  kind: string;
  title: string;
  detail: string;
}

export async function getRfidEvents(limit = 50): Promise<{ events: RfidEvent[] }> {
  return jsonFrom<{ events: RfidEvent[] }>(await apiFetch(`/edge/rfid/events?limit=${limit}`));
}

/** One recent tag read, matched to an asset by its RFID tag when known. */
export interface RfidRead {
  /** raw_tag_reads.id: unique per stored read, newest first. */
  id: number;
  epc: string;
  received_at: string;
  antenna: number | null;
  peak_rssi: number | null;
  asset: { serial_number: string | null; name: string | null; make_model: string | null } | null;
}

/** The dashboard's tag-read summary: today's unique tags, move progress, newest reads. */
export interface RfidReads {
  tags_today: number;
  move_total: number | null;
  move_seen: number | null;
  recent: RfidRead[];
  last_received_at: string | null;
}

export async function getRfidReads(tz: string): Promise<RfidReads> {
  return jsonFrom<RfidReads>(await apiFetch(`/edge/rfid/reads?tz=${encodeURIComponent(tz)}`));
}

/* ── Asset Not Part Of Move alarm (edge, RFID Station only) ─────────── */

/** Until someone dismisses it, or for `timed_seconds` after the last raise. */
export type AlarmMode = 'until_dismissed' | 'timed';

/** The station's alarm settings, kept on the edge. `timed_seconds` is
 *  3–600 and is always sent, even in `until_dismissed` mode. */
export interface AlarmSettings {
  mode: AlarmMode;
  timed_seconds: number;
}

/** One open alarm row: an off-move asset read by this station. Any field
 *  but `id` and `raised_at` may be null (an older portal sends no make/model). */
export interface OffMoveAlarmRow {
  id: number;
  make_model: string | null;
  name: string | null;
  serial: string | null;
  rfid: string | null;
  raised_at: string;
}

/** GET /edge/rfid/alarm. `alarms` is ordered by id; `latest_id` is the
 *  highest shown (null when none); `expires_at` is set only in timed mode
 *  while alarms are open. A laptop that isn't an RFID Station answers
 *  with no alarms. */
export interface OffMoveAlarmState extends AlarmSettings {
  alarms: OffMoveAlarmRow[];
  latest_id: number | null;
  expires_at: string | null;
}

export async function getOffMoveAlarm(): Promise<OffMoveAlarmState> {
  return jsonFrom<OffMoveAlarmState>(await apiFetch('/edge/rfid/alarm'));
}

/** Clears the open alarms with id <= `upToId` — the latest the screen
 *  showed, so an asset raised after the last poll stays open. */
export async function dismissOffMoveAlarm(upToId: number): Promise<{ dismissed: number }> {
  return jsonFrom<{ dismissed: number }>(await apiFetch('/edge/rfid/alarm/dismiss', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ up_to_id: upToId }),
  }));
}

export async function getAlarmSettings(): Promise<AlarmSettings> {
  return jsonFrom<AlarmSettings>(await apiFetch('/edge/rfid/alarm/settings'));
}

/** Saves the mode and seconds; 422 `invalid_alarm_settings` when out of range. */
export async function saveAlarmSettings(s: AlarmSettings): Promise<AlarmSettings> {
  return jsonFrom<AlarmSettings>(await apiFetch('/edge/rfid/alarm/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: s.mode, timed_seconds: s.timed_seconds }),
  }));
}

export async function startReader(): Promise<{ reading: boolean }> {
  return jsonFrom<{ reading: boolean }>(await apiFetch('/edge/rfid/start', { method: 'POST' }));
}

export async function stopReader(): Promise<{ reading: boolean }> {
  return jsonFrom<{ reading: boolean }>(await apiFetch('/edge/rfid/stop', { method: 'POST' }));
}

export async function getReaderStatus(): Promise<ReaderStatus> {
  return jsonFrom<ReaderStatus>(await apiFetch('/edge/rfid/status'));
}

/** The reader snapshot the edge builds every minute. Any key may be absent
 *  (the reader didn't report it). */
export interface ReaderSnapshot {
  serial?: string | null;
  make?: string | null;
  model?: string | null;
  name?: string | null;
  mac?: string | null;
  ip?: string | null;
  firmware?: string | null;
  uptime_seconds?: number | null;
  antennas_connected?: number | null;
  antennas_total?: number | null;
  reading?: boolean | null;
  tags_24h?: number | null;
  reachable?: boolean | null;
  taken_at?: string | null;
}

/** GET /edge/rfid/device: the paired reader, its latest snapshot (null when
 *  stale or missing, even while paired), and the newest tag read's time.
 *  Unpaired answers `{reader: null}` only. Never contacts the reader. */
export interface ReaderDevice {
  reader: { serial: string; model: string; ip: string; paired_at: string } | null;
  snapshot?: ReaderSnapshot | null;
  last_read_at?: string | null;
}

export async function getReaderDevice(): Promise<ReaderDevice> {
  return jsonFrom<ReaderDevice>(await apiFetch('/edge/rfid/device'));
}

// ── Label Station printing (Kiosk Setup steps 4-5) ──────────────────
// The kiosk font + test-render routes (kiosk:view, scoped to the move's
// own templates), and the laptop edge's network printer transport and
// station settings. Printer errors carry `detail.code`: bad_printer_ip
// (422), printer_unreachable (502), printer_timeout (504),
// font_name_mismatch (409), font_not_found (404), cloud_sign_in_required
// (403), not_label_station (409).

export type LabelKind = 'top' | 'front';

/** The station's label settings as the edge keeps them in the laptop's
 *  shared setup (and reports as the config section `label_station`). */
export interface LabelStationSettings {
  label_kind: LabelKind;
  printer: { type: 'usb' | 'network'; ip: string | null; model: string | null; serial: string | null };
  dpi: number;
  offset_x: number;
  offset_y: number;
  /** Print peel-off (`^MMP` on every label): step 5 found a peeler. The
   *  edge reads settings saved before this as false (tear off). */
  peel: boolean;
}

/** One font from the portal's library that the move's templates use.
 *  `resident`: built into Zebra printers; the station checks it is there
 *  and never installs it (its content route refuses it). */
export interface KioskLabelFont { id: string; name: string; size: number; resident?: boolean }

/** `missing`: fonts the move's templates use that aren't in the library. */
export interface KioskLabelFonts { fonts: KioskLabelFont[]; missing: string[] }

export async function fetchKioskLabelFonts(initiativeId: string): Promise<KioskLabelFonts> {
  return jsonFrom<KioskLabelFonts>(await apiFetch(
    `/kiosk/labels/fonts?initiative_id=${encodeURIComponent(initiativeId)}`));
}

/** The font's TrueType bytes. */
export async function fetchKioskFontContent(fontId: string, initiativeId: string): Promise<Uint8Array> {
  const resp = await apiFetch(`/kiosk/labels/fonts/${encodeURIComponent(fontId)}/content`
    + `?initiative_id=${encodeURIComponent(initiativeId)}`);
  if (!resp.ok) throw await errorFrom(resp);
  return new Uint8Array(await resp.arrayBuffer());
}

/** One template filled with the portal's mock values by the portal's own
 *  renderer — finished ZPL, never filled in on the kiosk. */
export async function postTestRender(body: {
  initiative_id: string; template_id: string; dpi_key: string;
}): Promise<{ zpl: string; template_name: string }> {
  return jsonFrom<{ zpl: string; template_name: string }>(await postJson('/kiosk/labels/test-render', body));
}

export interface PrinterScan {
  scan_id: string | null;
  state: 'running' | 'done' | 'failed';
  probed: number;
  total: number;
  printers: FoundPrinter[];
}

/** One 9100 host the scan found, with what its `~HI` said (nulls when it
 *  didn't answer one). */
export interface FoundPrinter {
  ip: string;
  model: string | null;
  firmware: string | null;
  dpi: number | null;
}

/** Starts a scan of the laptop's subnets for TCP 9100 (cancelling a running one). */
export async function startPrinterScan(): Promise<{ scan_id: string }> {
  return jsonFrom<{ scan_id: string }>(await apiFetch('/edge/printers/scan', { method: 'POST' }));
}

export async function getPrinterScan(): Promise<PrinterScan> {
  return jsonFrom<PrinterScan>(await apiFetch('/edge/printers/scan'));
}

/** Sends a command to a LAN printer on 9100 and returns its reply. */
export async function printerQuery(ip: string, command: string): Promise<{ response: string; truncated: boolean }> {
  return jsonFrom<{ response: string; truncated: boolean }>(await postJson('/edge/printers/query', { ip, command }));
}

export async function printerSend(ip: string, zpl: string): Promise<void> {
  await jsonFrom<{ ok: true }>(await postJson('/edge/printers/send', { ip, zpl }));
}

/** The edge downloads the font from the kiosk font route and sends it with `~DY`. */
export async function printerSendFont(body: {
  ip: string; font_id: string; name: string; initiative_id: string;
}): Promise<void> {
  await jsonFrom<{ ok: true }>(await postJson('/edge/printers/send-font', body));
}

/** The station's saved label settings, or null when none are saved. */
export async function getLabelStation(): Promise<LabelStationSettings | null> {
  return jsonFrom<LabelStationSettings | null>(await apiFetch('/edge/label-station'));
}

export async function putLabelStation(settings: LabelStationSettings): Promise<LabelStationSettings> {
  return jsonFrom<LabelStationSettings>(await apiFetch('/edge/label-station', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  }));
}

// ── Label Station printing (/edge/labels) ───────────────────────────
// Every route needs the edge session; a move-locked session on another
// move gets 403 move_locked.

/** The edge's label run. `reason` keeps the last run's value while idle:
 *  only `state` says whether a run is going. `unsupported` counts the
 *  templates (not labels) too new for this laptop's edge to print; an
 *  older edge leaves it out. */
export interface LabelRunStatus {
  state: 'idle' | 'running';
  reason: 'setup' | 'updates' | null;
  total: number;
  done: number;
  ready: number;
  errors: number;
  unsupported?: number;
}

export async function getLabelRunStatus(): Promise<LabelRunStatus> {
  return jsonFrom<LabelRunStatus>(await apiFetch('/edge/labels/status'));
}

export interface LabelPlanTemplate { id: string; name: string; family: string; dpi_key: string; version: number }

/** Which template the station would print with. `template` is null when
 *  none of the kind is at that DPI; `notes` say which steps fell through.
 *  `fonts`: the E: fonts that template prints with (a label builder
 *  design's `code` is "", so they can't be read off the template); an
 *  older edge leaves it out. `available_dpis`, with no template: the DPIs
 *  at which the move's downloaded set has one of the kind (natural order;
 *  [] for none); an older edge leaves it out. */
export interface LabelPlan {
  template: LabelPlanTemplate | null;
  notes: string[];
  fonts?: string[];
  available_dpis?: string[];
}

/** The plan for the saved settings, or for `dpi` / `kind` when given.
 *  404 not_label_station; 422 for a bad dpi or kind. */
export async function getLabelPlan(opts: { dpi?: number; kind?: LabelKind } = {}): Promise<LabelPlan> {
  const params = new URLSearchParams();
  if (opts.dpi !== undefined) params.set('dpi', String(opts.dpi));
  if (opts.kind !== undefined) params.set('kind', opts.kind);
  const query = params.toString();
  return jsonFrom<LabelPlan>(await apiFetch(`/edge/labels/plan${query ? `?${query}` : ''}`));
}

/** One asset's finished label. `zpl` is null (with `error`) when it
 *  couldn't be generated: `no_template_at_dpi`, `template_failed`, or
 *  `template_unsupported` (a design newer than this laptop's edge). */
export interface StationLabel {
  asset_id: string;
  zpl: string | null;
  error: string | null;
  template_name: string;
  dpi: number;
  label_kind: LabelKind;
}

/** Throws ApiError `label_not_found` (404) or `labels_regenerating` (409). */
export async function getStationLabel(assetId: string): Promise<StationLabel> {
  return jsonFrom<StationLabel>(await apiFetch(`/edge/labels/asset/${encodeURIComponent(assetId)}`));
}

/** Queues a Labeled scan once a label was sent. Throws ApiError
 *  `label_not_found` / `not_label_station` (409) or `scan_value_mismatch` (422). */
/** Queues the printed label's Labeled scan; resolves to its client_scan_id. */
export async function postLabelPrinted(body: {
  asset_id: string; scanned_value: string; scanned_at: string;
}): Promise<string> {
  const r = await jsonFrom<{ queued: true; client_scan_id: string }>(
    await postJson('/edge/labels/printed', body));
  return r.client_scan_id;
}

/** Which of these Labeled scans the portal has accepted (at most 100 ids). */
export async function getRecordedScans(ids: string[]): Promise<string[]> {
  const resp = await apiFetch(`/edge/labels/recorded?ids=${encodeURIComponent(ids.join(','))}`);
  return (await jsonFrom<{ recorded: string[] }>(resp)).recorded;
}

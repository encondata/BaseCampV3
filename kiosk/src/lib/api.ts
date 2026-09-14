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
      const resp = await fetch(`${apiUrl()}/auth/refresh`, { method: 'POST', credentials: 'include' });
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

export async function logoutRequest(): Promise<void> {
  try {
    await fetch(`${apiUrl()}/auth/logout`, { method: 'POST', credentials: 'include' });
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
}

export async function heartbeatRequest(body: {
  serial: string; name: string; mode: string; version: string | null; sign_in?: boolean;
  login_method?: 'password' | 'link';
}): Promise<HeartbeatResult> {
  const { sign_in, ...rest } = body;
  const resp = await apiFetch('/kiosk/heartbeat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sign_in ? { ...rest, sign_in } : rest),
  });
  return jsonFrom<HeartbeatResult>(resp);
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

export interface SetupOptions {
  initiatives: SetupOptionInitiative[];
  scan_types: { key: string; label: string; color: string }[];
}

export interface KioskSetupResult {
  device_id: string;
  initiative_id: string;
  initiative_name: string;
  site_id: string;
  site_name: string;
  site_role: 'source' | 'destination';
  scan_status: string;
  scan_status_label: string;
}

export async function getSetupOptions(): Promise<SetupOptions> {
  const resp = await apiFetch('/kiosk/setup-options');
  return jsonFrom<SetupOptions>(resp);
}

export async function submitKioskSetup(body: {
  serial: string; initiative_id: string; site_id: string; scan_status: string;
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
  is_worker: boolean;
  has_account: boolean;
}

export interface KioskPeopleSync {
  generated_at: string;
  people: KioskPersonRow[];
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
  read_only: false, read_only_message: '', workers_paused: false, banner: null,
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
}

/** Is this person on the clock right now, and since when? 404
 *  `person_not_found` for someone the portal no longer has (or has
 *  archived) — a kiosk holding a stale local copy is the likely cause. */
export async function fetchTimeclockStatus(personId: string): Promise<KioskTimeclockStatus> {
  const resp = await apiFetch(`/kiosk/timeclock/${encodeURIComponent(personId)}`);
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
  serial: string; person_id: string;
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

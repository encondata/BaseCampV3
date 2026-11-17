/**
 * The Linux laptop's kiosk helper (kiosk_laptop/installer/kiosk_session.py),
 * on 127.0.0.1:8092, which the page calls directly. Its waiting page hands
 * this page a per-session token in the URL fragment (#kh=…). The fragment is
 * never sent to the edge; captureHelperToken moves it into sessionStorage and
 * strips it from the address before React renders. The helper answers only
 * this origin (http://localhost:8090) carrying that token.
 *
 * lockdownAvailable() gates every lockdown UI part: a laptop (config.js mode),
 * opened on the laptop itself (not lanAccess), that hostnet.sh reported as
 * Linux (hostOs), holding a token. So Android, iOS, the web kiosk, Mac and
 * Windows laptops, and a phone on the LAN never show any of it.
 */

import { isLaptop } from './platform';

export const HELPER_ORIGIN = 'http://127.0.0.1:8092';
export const HELPER_TOKEN_KEY = 'ss-kiosk-helper-token';
const FRAGMENT = /^#kh=([A-Za-z0-9_-]{20,128})$/;

export function captureHelperToken(): void {
  if (typeof window === 'undefined') return;
  const m = FRAGMENT.exec(window.location.hash);
  if (!m) return;
  try { sessionStorage.setItem(HELPER_TOKEN_KEY, m[1]); } catch { /* storage off: no lockdown UI */ }
  window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
}

export function helperToken(): string | null {
  try { return sessionStorage.getItem(HELPER_TOKEN_KEY); } catch { return null; }
}

export function lockdownAvailable(): boolean {
  if (typeof window === 'undefined') return false;
  const cfg = window.__KIOSK_CONFIG__;
  return isLaptop() && cfg?.lanAccess !== true && cfg?.hostOs === 'linux' && helperToken() !== null;
}

export interface Wired { connected: boolean; device: string }
export interface HostSystem {
  battery: { percent: number; charging: boolean } | null;
  wifi: { ssid: string; signal: number } | null;
  wired: Wired | null;
  network: 'wifi' | 'wired' | 'none';
}
export interface WifiNetwork { ssid: string; signal: number; secure: boolean; active: boolean }

/** `code`: the helper's error ("wrong_pin", "wrong_password", …), or
 *  "unreachable" when the helper didn't answer, "failed" otherwise. */
export class HelperError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = 'HelperError';
  }
}

async function call<T>(path: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}, timeoutMs = 8000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const headers: Record<string, string> = { 'X-Kiosk-Token': helperToken() ?? '' };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`${HELPER_ORIGIN}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: 'no-store',
      signal: ctrl.signal,
    });
  } catch {
    throw new HelperError('unreachable');
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => null) as { error?: string } | null;
  if (!res.ok) throw new HelperError(typeof data?.error === 'string' ? data.error : 'failed');
  return data as T;
}

export const getHostSystem = () => call<HostSystem>('/v1/system');
export const getWifiNetworks = () => call<{ networks: WifiNetwork[]; wired: Wired | null }>('/v1/wifi', {}, 25_000);
export const joinWifi = (ssid: string, password: string) =>
  call<{ ok: true }>('/v1/wifi/join', { method: 'POST', body: { ssid, password } }, 65_000);
export const exitKiosk = (pin: string) => call<{ ok: true }>('/v1/exit', { method: 'POST', body: { pin } });

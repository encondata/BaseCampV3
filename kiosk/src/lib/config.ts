/**
 * Runtime configuration. Resolved per call (never at module scope — the
 * same reason as the portal's apiUrl(): tests and SSR have no window).
 *   1. window.__KIOSK_CONFIG__ (written by the Docker entrypoint)
 *   2. VITE_API_URL / VITE_PORTAL_URL (build-time env)
 *   3. http://<this host>:8000 and :5173 (dev box on the LAN)
 */

import { siblingOrigin } from '@portal/lib/siblingOrigin';

declare global {
  interface Window {
    __KIOSK_CONFIG__?: { apiUrl?: string; portalUrl?: string };
  }
}

function trim(url: string | undefined): string | undefined {
  const v = url?.trim().replace(/\/+$/, '');
  return v ? v : undefined;
}

function fromWindow(key: 'apiUrl' | 'portalUrl'): string | undefined {
  if (typeof window === 'undefined') return undefined;
  return trim(window.__KIOSK_CONFIG__?.[key]);
}

export function apiUrl(): string {
  return (
    fromWindow('apiUrl') ??
    trim(import.meta.env.VITE_API_URL as string | undefined) ??
    // kiosk.dev.serversherpa.com → https://api.dev.serversherpa.com; localhost
    // and LAN IPs fall through to the port below.
    siblingOrigin('api', window.location) ??
    `http://${window.location.hostname}:8000`
  );
}

export function portalUrl(): string {
  return (
    fromWindow('portalUrl') ??
    trim(import.meta.env.VITE_PORTAL_URL as string | undefined) ??
    siblingOrigin('portal', window.location) ??
    `http://${window.location.hostname}:5173`
  );
}

export function kioskVersion(): string {
  return trim(import.meta.env.VITE_KIOSK_VERSION as string | undefined) ?? __KIOSK_VERSION__;
}

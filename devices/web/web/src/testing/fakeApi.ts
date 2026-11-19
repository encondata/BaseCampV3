/** Test helpers: a stubbed devices API (global fetch), a stand-in for the
 *  browser's XMLHttpRequest (the presigned upload PUT), and sample apps. */
import { vi } from 'vitest';

export function json(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

/** `body` is a JSON body parsed; `raw` is the body as sent (a FormData, say). */
export interface ApiCall { method: string; path: string; search: string; body: unknown; raw: unknown }
type Handler = (call: ApiCall) => Response | Promise<Response>;

/** Stubs fetch: `routes` maps "METHOD /path" (no query) to a handler or to
 *  a JSON body answered with 200. Unknown routes answer 404. Returns the
 *  calls made, in order. */
export function stubApi(routes: Record<string, Handler | unknown>): ApiCall[] {
  const calls: ApiCall[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, 'http://devices.test');
    const method = (init.method ?? 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const call = { method, path: url.pathname, search: url.search, body, raw: init.body };
    calls.push(call);
    const route = routes[`${method} ${url.pathname}`];
    if (route === undefined) return json(404, { detail: { code: 'not_found', message: 'Not found.' } });
    return typeof route === 'function' ? (route as Handler)(call) : json(200, route);
  }));
  return calls;
}

/** The presigned PUT: records each request and finishes it at once,
 *  reporting progress on the way. */
export class FakeXhr {
  static sent: { method: string; url: string; headers: Record<string, string>; body: unknown }[] = [];
  static status = 200;

  upload = { onprogress: null as ((e: { loaded: number; total: number; lengthComputable: boolean }) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  status = 0;
  private method = '';
  private url = '';
  private headers: Record<string, string> = {};

  open(method: string, url: string) { this.method = method; this.url = url; }
  setRequestHeader(name: string, value: string) { this.headers[name] = value; }
  send(body: unknown) {
    FakeXhr.sent.push({ method: this.method, url: this.url, headers: this.headers, body });
    setTimeout(() => {
      this.upload.onprogress?.({ loaded: 50, total: 100, lengthComputable: true });
      this.status = FakeXhr.status;
      this.onload?.();
    }, 0);
  }
  abort() {}
}

export function version(over: Record<string, unknown> = {}) {
  return {
    id: 'v-1', version_name: '0.1.1', build: '2', notes: 'QR label changes', size: 23_400_000,
    uploaded_at: '2026-11-09T14:05:00Z', uploaded_by_name: 'J. Henderson', is_current: true,
    ...over,
  };
}

export function androidApp(over: Record<string, unknown> = {}) {
  return {
    id: 'app-a', platform: 'android', identifier: 'com.serversherpa.kiosk', name: 'ServerSherpa Kiosk',
    icon_url: '/api/apps/app-a/icon', current: version(), ios_state: null, ...over,
  };
}

export function iosApp(over: Record<string, unknown> = {}) {
  return {
    id: 'app-i', platform: 'ios', identifier: 'com.serversherpa.kiosk', name: 'ServerSherpa Kiosk',
    icon_url: null, current: version({ id: 'v-i1', version_name: '1.0', build: '5' }),
    ios_state: { state: 'register_first', message: "This iPhone isn't registered." }, ...over,
  };
}

/** `can` for a role holding exactly these app_distribution actions. */
export function grants(...actions: string[]) {
  return (resource: string, action = 'view') => resource === 'app_distribution' && actions.includes(action);
}

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  captureHelperToken, exitKiosk, HELPER_ORIGIN, HELPER_TOKEN_KEY, helperToken, getHostSystem, lockdownAvailable,
} from './hostHelper';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const LINUX = { mode: 'laptop', lanAccess: false, hostOs: 'linux' };

beforeEach(() => { sessionStorage.clear(); window.history.replaceState(null, '', '/'); });
afterEach(() => { delete window.__KIOSK_CONFIG__; vi.unstubAllGlobals(); });

describe('captureHelperToken', () => {
  it('keeps the token from the fragment and strips it from the address', () => {
    window.history.replaceState(null, '', `/login?next=1#kh=${TOKEN}`);
    captureHelperToken();
    expect(helperToken()).toBe(TOKEN);
    expect(window.location.hash).toBe('');
    expect(window.location.pathname + window.location.search).toBe('/login?next=1');
  });

  it('leaves any other fragment alone', () => {
    window.history.replaceState(null, '', '/#section');
    captureHelperToken();
    expect(helperToken()).toBeNull();
    expect(window.location.hash).toBe('#section');
  });
});

describe('lockdownAvailable', () => {
  it('needs a Linux laptop, opened on the laptop itself, holding the token', () => {
    sessionStorage.setItem(HELPER_TOKEN_KEY, TOKEN);
    window.__KIOSK_CONFIG__ = LINUX;
    expect(lockdownAvailable()).toBe(true);
    for (const cfg of [{ ...LINUX, mode: undefined }, { ...LINUX, lanAccess: true },
      { ...LINUX, hostOs: null }, { ...LINUX, hostOs: 'macos' }]) {
      window.__KIOSK_CONFIG__ = cfg;
      expect(lockdownAvailable()).toBe(false);
    }
    window.__KIOSK_CONFIG__ = LINUX;
    sessionStorage.clear();
    expect(lockdownAvailable()).toBe(false);
  });
});

describe('helper calls', () => {
  it('sends the token and JSON, and maps an error body to its code', async () => {
    sessionStorage.setItem(HELPER_TOKEN_KEY, TOKEN);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'wrong_pin' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(exitKiosk('nope')).rejects.toMatchObject({ code: 'wrong_pin' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${HELPER_ORIGIN}/v1/exit`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X-Kiosk-Token']).toBe(TOKEN);
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ pin: 'nope' });
  });

  it('is "unreachable" when the helper is not there', async () => {
    sessionStorage.setItem(HELPER_TOKEN_KEY, TOKEN);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(getHostSystem()).rejects.toMatchObject({ code: 'unreachable' });
  });
});

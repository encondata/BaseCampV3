// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SYSTEM_STATUS, getSystemStatus } from './systemStatus';

afterEach(() => vi.unstubAllGlobals());

describe('getSystemStatus', () => {
  it('fetches /system/status without auth and returns the body', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      read_only: true, read_only_message: 'Cutover', workers_paused: false, banner: 'Hi',
    })));
    vi.stubGlobal('fetch', fetchMock);
    const status = await getSystemStatus();
    expect(status).toEqual({ read_only: true, read_only_message: 'Cutover',
                             workers_paused: false, banner: 'Hi' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit?];
    expect(url).toMatch(/\/system\/status$/);
    expect(init?.headers).toBeUndefined();
  });
  it('throws on a non-2xx so the provider keeps its last value', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 500 })));
    await expect(getSystemStatus()).rejects.toThrow();
    expect(DEFAULT_SYSTEM_STATUS.read_only).toBe(false);
  });
});

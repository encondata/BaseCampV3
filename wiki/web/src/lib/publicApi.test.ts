import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@portal/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@portal/lib/api')>()),
  apiFetch: vi.fn(),
  apiUrl: () => 'http://api.test',
}));

import { apiFetch } from '@portal/lib/api';

import { getPublicShare, PublicShareError } from './publicApi';

const fetchSpy = vi.fn();

beforeEach(() => {
  fetchSpy.mockReset();
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('getPublicShare', () => {
  it('reads /wiki/public/<token> with no credentials, outside the signed-in client', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ kind: 'file' }), { status: 200 }));
    await expect(getPublicShare('a/b c')).resolves.toEqual({ kind: 'file' });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://api.test/wiki/public/a%2Fb%20c');
    expect(init.credentials).toBe('omit');
    expect(new Headers(init.headers).has('Authorization')).toBe(false);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('marks a re-read of an open link as a refresh (not another view)', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ kind: 'file' }), { status: 200 }));
    await getPublicShare('tok', { refresh: true });
    expect(fetchSpy.mock.calls[0][0]).toBe('http://api.test/wiki/public/tok?refresh=1');
  });

  it('throws with the status for anything else', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('{}', { status: 404 }));
    const err = await getPublicShare('t').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublicShareError);
    expect((err as PublicShareError).status).toBe(404);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@portal/lib/api', () => ({
  getAccessTokenForStream: vi.fn(),
  refreshSession: vi.fn(),
}));

import { getAccessTokenForStream, refreshSession } from '@portal/lib/api';

import { currentAccessToken } from './session';

/** An unsigned JWT-shaped token expiring `inSeconds` from now. */
function jwt(inSeconds: number): string {
  const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${b64({ alg: 'HS256' })}.${b64({ sub: 'p-1', exp: Math.floor(Date.now() / 1000) + inSeconds })}.sig`;
}

const session = (token: string) => ({ access_token: token }) as Awaited<ReturnType<typeof refreshSession>>;

beforeEach(() => {
  vi.mocked(getAccessTokenForStream).mockReset();
  vi.mocked(refreshSession).mockReset();
});

describe('currentAccessToken', () => {
  it('hands over the in-memory token while it has time left', async () => {
    const token = jwt(600);
    vi.mocked(getAccessTokenForStream).mockReturnValue(token);
    await expect(currentAccessToken()).resolves.toBe(token);
    expect(refreshSession).not.toHaveBeenCalled();
  });

  it('refreshes when there is no token yet', async () => {
    const fresh = jwt(900);
    vi.mocked(getAccessTokenForStream).mockReturnValue(null);
    vi.mocked(refreshSession).mockResolvedValue(session(fresh));
    await expect(currentAccessToken()).resolves.toBe(fresh);
  });

  it('refreshes a token about to expire', async () => {
    const fresh = jwt(900);
    vi.mocked(getAccessTokenForStream).mockReturnValue(jwt(10));
    vi.mocked(refreshSession).mockResolvedValue(session(fresh));
    await expect(currentAccessToken()).resolves.toBe(fresh);
  });

  it('passes an opaque token through untouched', async () => {
    vi.mocked(getAccessTokenForStream).mockReturnValue('opaque-token');
    await expect(currentAccessToken()).resolves.toBe('opaque-token');
    expect(refreshSession).not.toHaveBeenCalled();
  });

  it('keeps the old token when a refresh fails, and throws when there is none', async () => {
    const stale = jwt(5);
    vi.mocked(getAccessTokenForStream).mockReturnValue(stale);
    vi.mocked(refreshSession).mockResolvedValue(null);
    await expect(currentAccessToken()).resolves.toBe(stale);

    vi.mocked(getAccessTokenForStream).mockReturnValue(null);
    await expect(currentAccessToken()).rejects.toThrow(/signed in/i);
  });
});

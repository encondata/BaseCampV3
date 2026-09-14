// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

import { approvePair, denyPair, getPairInfo } from './api';

const SESSION = {
  access_token: 't', expires_in: 900, session_expires_at: '2030-01-01T00:00:00Z',
  person: {}, roles: [], must_change_password: false, preferences: {}, perms: {},
  max_rank: 40, scope: { global: true, client_ids: [], partner_ids: [] }, password_min_length: 8,
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

it('getPairInfo GETs /kiosk/pair/{code}; approve and deny POST their actions', async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/auth/refresh')) return json(SESSION);
    if (init?.method === 'POST') return new Response(null, { status: 204 });
    return json({ code: 'ABCD2345', kiosk_name: 'Dock 3', serial: 's',
                  status: 'pending', expires_at: '2030-01-01T00:00:00Z' });
  });
  vi.stubGlobal('fetch', fetchMock);

  const info = await getPairInfo('abcd-2345');
  expect(info.kiosk_name).toBe('Dock 3');
  expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/kiosk/pair/abcd-2345'))).toBe(true);

  await approvePair('ABCD2345');
  expect(fetchMock.mock.calls.some(([u, i]) =>
    String(u).endsWith('/kiosk/pair/ABCD2345/approve') && i?.method === 'POST')).toBe(true);
  await denyPair('ABCD2345');
  expect(fetchMock.mock.calls.some(([u, i]) =>
    String(u).endsWith('/kiosk/pair/ABCD2345/deny') && i?.method === 'POST')).toBe(true);
});

it('surfaces the API error code', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) =>
    String(url).endsWith('/auth/refresh') ? json(SESSION) : json({ detail: { code: 'pair_not_found' } }, 404)));
  await expect(getPairInfo('NOPE0000')).rejects.toMatchObject({ code: 'pair_not_found', status: 404 });
});

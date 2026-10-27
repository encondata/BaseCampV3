// @vitest-environment jsdom
/** The Time Clock station's edge client: the signed-out reads and punches
 *  go out as plain same-origin fetches (never apiFetch, which would treat
 *  a 401 as a session ending); only arming the display rides the session. */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, ...apiMock };
});

import { ApiError } from '../lib/api';
import {
  armDisplay, getStationInfo, stationClockIn, stationClockOut, stationLearningLink,
  stationLearningOverride, stationPeople, stationStatus, useStationInfo,
} from './stationApi';

const INFO = {
  timeclock: true, ready: true, paused: false, armed: true,
  initiative_name: null, site_name: 'NAP22 Hall',
};
const STATUS = {
  person: { id: 'p-1', display_name: 'Alex Worker' }, clocked_in: true, entry: null,
  last_entry: null, today_minutes: 0, today_entries: [],
};

const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  apiMock.apiFetch.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete window.__KIOSK_CONFIG__;
});

it('getStationInfo reads the public station info same-origin', async () => {
  fetchMock.mockResolvedValue(json(200, INFO));
  expect(await getStationInfo()).toEqual(INFO);
  expect(fetchMock).toHaveBeenCalledWith('/edge/timeclock/station', {
    credentials: 'same-origin', signal: expect.any(AbortSignal),
  });
  expect(apiMock.apiFetch).not.toHaveBeenCalled();
});

it('getStationInfo returns null on a 500', async () => {
  fetchMock.mockResolvedValue(json(500, { detail: { code: 'boom' } }));
  expect(await getStationInfo()).toBeNull();
});

it('getStationInfo returns null when the request fails or the body is not JSON', async () => {
  fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
  expect(await getStationInfo()).toBeNull();
  fetchMock.mockResolvedValueOnce(new Response('<html>', { status: 200 }));
  expect(await getStationInfo()).toBeNull();
});

it('armDisplay posts through apiFetch so the session rides along', async () => {
  apiMock.apiFetch.mockResolvedValue(new Response(null, { status: 204 }));
  await armDisplay();
  expect(apiMock.apiFetch).toHaveBeenCalledWith('/edge/timeclock/arm', { method: 'POST' });
  expect(fetchMock).not.toHaveBeenCalled();
});

it('armDisplay throws the edge code', async () => {
  apiMock.apiFetch.mockResolvedValue(json(409, { detail: { code: 'not_timeclock_station' } }));
  const err = await armDisplay().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).code).toBe('not_timeclock_station');
  expect((err as ApiError).status).toBe(409);
});

it('stationPeople returns the cached people list', async () => {
  const people = [{ id: 'p-1', display_name: 'Alex Worker' }];
  fetchMock.mockResolvedValue(json(200, { generated_at: '2026-10-20T00:00:00Z', people }));
  expect(await stationPeople()).toEqual(people);
  expect(fetchMock).toHaveBeenCalledWith('/edge/timeclock/people', {
    credentials: 'same-origin', signal: expect.any(AbortSignal),
  });
});

it('stationStatus reads one person, in the kiosk zone', async () => {
  fetchMock.mockResolvedValue(json(200, STATUS));
  expect(await stationStatus('p-1')).toEqual(STATUS);
  expect(fetchMock).toHaveBeenCalledWith(`/edge/timeclock/status/p-1?tz=${encodeURIComponent(ZONE)}`, {
    credentials: 'same-origin', signal: expect.any(AbortSignal),
  });
});

it.each([
  ['stationStatus', () => stationStatus('p-1')],
  ['stationPeople', () => stationPeople()],
] as const)('%s gives up after 10 s as a network error', async (_name, call) => {
  vi.useFakeTimers();
  try {
    fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const pending = (call() as Promise<unknown>).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(9_999);
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const err = await pending;
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('network');
    expect((err as ApiError).status).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  ['clock-in', stationClockIn],
  ['clock-out', stationClockOut],
] as const)('%s posts the person id and the kiosk zone as JSON', async (route, call) => {
  fetchMock.mockResolvedValue(json(200, STATUS));
  expect(await call('p-1')).toEqual(STATUS);
  expect(fetchMock).toHaveBeenCalledWith(`/edge/timeclock/${route}`, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ person_id: 'p-1', tz: ZONE }),
  });
});

it('stationClockIn carries the learning override id when it has one', async () => {
  fetchMock.mockResolvedValue(json(200, STATUS));
  await stationClockIn('p-1', 'ovr-1');
  const init = fetchMock.mock.calls[0][1] as RequestInit;
  expect(JSON.parse(String(init.body))).toEqual({ person_id: 'p-1', tz: ZONE, learning_override_id: 'ovr-1' });
});

it('stationLearningLink posts the person and the zone to the edge', async () => {
  fetchMock.mockResolvedValue(json(200, { sent: true }));
  expect(await stationLearningLink('p-1')).toEqual({ sent: true });
  expect(fetchMock).toHaveBeenCalledWith('/edge/timeclock/learning-link', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ person_id: 'p-1', tz: ZONE }),
  });
});

it('stationLearningOverride posts the admin form beside the person, signed out (never apiFetch)', async () => {
  fetchMock.mockResolvedValue(json(200, { override_id: 'ovr-1' }));
  const form = {
    admin_email: 'laura@example.com', admin_password: 'pw', totp_code: '123456',
    reason: 'other' as const, reason_text: 'forgot phone', scope: 'day' as const,
  };
  expect(await stationLearningOverride('p-1', form)).toEqual({ override_id: 'ovr-1' });
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe('/edge/timeclock/learning-override');
  expect(JSON.parse(String(init.body))).toEqual({ person_id: 'p-1', tz: ZONE, ...form });
  expect(apiMock.apiFetch).not.toHaveBeenCalled();
});

it.each([
  [403, 'override_credentials_invalid'], [403, 'totp_required'], [403, 'override_rank'],
  [409, 'totp_seed_unreadable'], [422, 'reason_text_required'], [429, 'rate_limited'],
])('an override refusal keeps its status and code (%i %s)', async (status, code) => {
  fetchMock.mockResolvedValue(json(status, { detail: { code } }));
  const err = await stationLearningOverride('p-1', {
    admin_email: 'a@x.com', admin_password: 'pw', reason: 'no_phone', scope: 'punch',
  }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect(err).toMatchObject({ status, code });
});

it('a punch error keeps the edge code and status, edge_offline included', async () => {
  fetchMock.mockResolvedValueOnce(json(503, { detail: { code: 'edge_offline' } }));
  const offline = await stationClockIn('p-1').catch((e: unknown) => e);
  expect(offline).toBeInstanceOf(ApiError);
  expect((offline as ApiError).code).toBe('edge_offline');
  expect((offline as ApiError).status).toBe(503);

  fetchMock.mockResolvedValueOnce(json(409, { detail: { code: 'already_clocked_in' } }));
  const raced = await stationClockIn('p-1').catch((e: unknown) => e);
  expect((raced as ApiError).code).toBe('already_clocked_in');
  expect((raced as ApiError).status).toBe(409);
});

it('a punch that never reaches the edge is a network error', async () => {
  fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
  const err = await stationClockOut('p-1').catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).code).toBe('network');
  expect((err as ApiError).status).toBe(0);
});

it('useStationInfo asks nothing in web mode', () => {
  const { result } = renderHook(() => useStationInfo());
  expect(result.current.loading).toBe(false);
  expect(result.current.info).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});

it('useStationInfo loads on a laptop and refresh() reads again without going back to loading', async () => {
  window.__KIOSK_CONFIG__ = { mode: 'laptop' };
  fetchMock.mockResolvedValueOnce(json(200, INFO));
  const { result } = renderHook(() => useStationInfo());
  expect(result.current.loading).toBe(true);
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.info).toEqual(INFO);

  fetchMock.mockResolvedValueOnce(json(200, { ...INFO, paused: true }));
  act(() => result.current.refresh());
  expect(result.current.loading).toBe(false);
  await waitFor(() => expect(result.current.info?.paused).toBe(true));
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

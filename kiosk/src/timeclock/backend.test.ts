import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAll: vi.fn(), fetchTimeclockStatus: vi.fn(), postClockIn: vi.fn(), postClockOut: vi.fn(),
  postLearningLink: vi.fn(), postLearningOverride: vi.fn(),
}));
vi.mock('../lib/localDb', () => ({ getAll: mocks.getAll }));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    fetchTimeclockStatus: mocks.fetchTimeclockStatus,
    postClockIn: mocks.postClockIn,
    postClockOut: mocks.postClockOut,
    postLearningLink: mocks.postLearningLink,
    postLearningOverride: mocks.postLearningOverride,
  };
});

import { ApiError } from '../lib/api';
import { sessionBackend, stationBackend } from './backend';

const STATUS = { person: { id: 'p-1' }, clocked_in: false };
// The browser's own zone: "today" on the portal when the site has none.
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const fetchMock = vi.fn();

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset());
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

it('sessionBackend reads people from the local people store', async () => {
  mocks.getAll.mockResolvedValue([{ id: 'p-1' }]);
  expect(await sessionBackend('SER1').people()).toEqual([{ id: 'p-1' }]);
  expect(mocks.getAll).toHaveBeenCalledWith('people');
});

it('sessionBackend.status passes the serial and the kiosk zone', async () => {
  mocks.fetchTimeclockStatus.mockResolvedValue(STATUS);
  expect(await sessionBackend('SER1').status('p-1')).toBe(STATUS);
  expect(mocks.fetchTimeclockStatus).toHaveBeenCalledWith('p-1', 'SER1', ZONE);
});

it('sessionBackend punches carry the serial, the person and the kiosk zone', async () => {
  mocks.postClockIn.mockResolvedValue(STATUS);
  mocks.postClockOut.mockResolvedValue(STATUS);
  const b = sessionBackend('SER1');
  await b.clockIn('p-1');
  await b.clockOut('p-1');
  expect(mocks.postClockIn).toHaveBeenCalledWith({ serial: 'SER1', person_id: 'p-1', tz: ZONE });
  expect(mocks.postClockOut).toHaveBeenCalledWith({ serial: 'SER1', person_id: 'p-1', tz: ZONE });
});

it('sessionBackend.clockIn names the learning override only when it has one', async () => {
  mocks.postClockIn.mockResolvedValue(STATUS);
  const b = sessionBackend('SER1');
  await b.clockIn('p-1', 'ovr-1');
  expect(mocks.postClockIn).toHaveBeenLastCalledWith({
    serial: 'SER1', person_id: 'p-1', tz: ZONE, learning_override_id: 'ovr-1',
  });
});

it('sessionBackend learning calls carry the serial, the person and the kiosk zone', async () => {
  mocks.postLearningLink.mockResolvedValue({ sent: true });
  mocks.postLearningOverride.mockResolvedValue({ override_id: 'ovr-1' });
  const b = sessionBackend('SER1');
  expect(await b.learningLink('p-1')).toEqual({ sent: true });
  expect(mocks.postLearningLink).toHaveBeenCalledWith({ serial: 'SER1', person_id: 'p-1', tz: ZONE });
  const form = { admin_email: 'a@x.com', admin_password: 'pw', reason: 'no_phone' as const, scope: 'punch' as const };
  expect(await b.learningOverride('p-1', form)).toEqual({ override_id: 'ovr-1' });
  expect(mocks.postLearningOverride).toHaveBeenCalledWith({ ...form, serial: 'SER1', person_id: 'p-1', tz: ZONE });
});

it('stationBackend learning calls go to the edge', async () => {
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ sent: true, override_id: 'o' }), { status: 200 }));
  await stationBackend().learningLink('p-1');
  await stationBackend().learningOverride('p-1', {
    admin_email: 'a@x.com', admin_password: 'pw', reason: 'no_phone', scope: 'punch',
  });
  expect(fetchMock.mock.calls[0][0]).toBe('/edge/timeclock/learning-link');
  expect(fetchMock.mock.calls[1][0]).toBe('/edge/timeclock/learning-override');
});

it('stationBackend reads through the edge', async () => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ generated_at: 'x', people: [{ id: 'p-2' }] }), { status: 200 }));
  expect(await stationBackend().people()).toEqual([{ id: 'p-2' }]);
  expect(fetchMock.mock.calls[0][0]).toBe('/edge/timeclock/people');
});

it('stationBackend punches post the person and the kiosk zone to the edge', async () => {
  fetchMock.mockImplementation(async () => new Response(JSON.stringify(STATUS), { status: 200 }));
  await stationBackend().clockIn('p-1');
  await stationBackend().clockOut('p-1');
  expect(fetchMock.mock.calls[0][0]).toBe('/edge/timeclock/clock-in');
  expect(fetchMock.mock.calls[1][0]).toBe('/edge/timeclock/clock-out');
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ person_id: 'p-1', tz: ZONE });
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ person_id: 'p-1', tz: ZONE });
});

it('stationBackend.status asks the edge with the kiosk zone', async () => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify(STATUS), { status: 200 }));
  await stationBackend().status('p-1');
  expect(fetchMock.mock.calls[0][0]).toBe(`/edge/timeclock/status/p-1?tz=${encodeURIComponent(ZONE)}`);
});

it('stationBackend maps an edge_offline 503 to ApiError edge_offline', async () => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ detail: { code: 'edge_offline' } }), { status: 503 }));
  const err = await stationBackend().status('p-1').catch((e) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect(err).toMatchObject({ code: 'edge_offline', status: 503 });
});

it('stationBackend maps a thrown fetch to network', async () => {
  fetchMock.mockRejectedValue(new TypeError('offline'));
  const err = await stationBackend().clockOut('p-1').catch((e) => e);
  expect(err).toMatchObject({ code: 'network', status: 0 });
});

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAll: vi.fn(), fetchTimeclockStatus: vi.fn(), postClockIn: vi.fn(), postClockOut: vi.fn(),
}));
vi.mock('../lib/localDb', () => ({ getAll: mocks.getAll }));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    fetchTimeclockStatus: mocks.fetchTimeclockStatus,
    postClockIn: mocks.postClockIn,
    postClockOut: mocks.postClockOut,
  };
});

import { ApiError } from '../lib/api';
import { sessionBackend, stationBackend } from './backend';

const STATUS = { person: { id: 'p-1' }, clocked_in: false };
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

it('sessionBackend.status passes the serial', async () => {
  mocks.fetchTimeclockStatus.mockResolvedValue(STATUS);
  expect(await sessionBackend('SER1').status('p-1')).toBe(STATUS);
  expect(mocks.fetchTimeclockStatus).toHaveBeenCalledWith('p-1', 'SER1');
});

it('sessionBackend punches carry the serial and the person', async () => {
  mocks.postClockIn.mockResolvedValue(STATUS);
  mocks.postClockOut.mockResolvedValue(STATUS);
  const b = sessionBackend('SER1');
  await b.clockIn('p-1');
  await b.clockOut('p-1');
  expect(mocks.postClockIn).toHaveBeenCalledWith({ serial: 'SER1', person_id: 'p-1' });
  expect(mocks.postClockOut).toHaveBeenCalledWith({ serial: 'SER1', person_id: 'p-1' });
});

it('stationBackend reads through the edge', async () => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ generated_at: 'x', people: [{ id: 'p-2' }] }), { status: 200 }));
  expect(await stationBackend().people()).toEqual([{ id: 'p-2' }]);
  expect(fetchMock.mock.calls[0][0]).toBe('/edge/timeclock/people');
});

it('stationBackend punches post the person to the edge', async () => {
  fetchMock.mockImplementation(async () => new Response(JSON.stringify(STATUS), { status: 200 }));
  await stationBackend().clockIn('p-1');
  await stationBackend().clockOut('p-1');
  expect(fetchMock.mock.calls[0][0]).toBe('/edge/timeclock/clock-in');
  expect(fetchMock.mock.calls[1][0]).toBe('/edge/timeclock/clock-out');
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ person_id: 'p-1' });
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

// @vitest-environment jsdom
/** The scan outbox: an IndexedDB queue, its 500 ms batching window, and
 *  the 2s/4s/15s/60s retry ladder. Only setTimeout/clearTimeout are
 *  faked — fake-indexeddb drives its own events off setImmediate, which
 *  must stay real or every await here would hang. */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ postScans: vi.fn() }));
vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return { ...actual, postScans: api.postScans };
});

// `putRows` is wrapped so a single test can force a storage write to
// fail mid-flush; everything else (the rest of localDb, real
// fake-indexeddb) stays untouched.
const localDb = vi.hoisted(() => ({ putRows: vi.fn() }));
vi.mock('./localDb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./localDb')>();
  localDb.putRows.mockImplementation(
    (...args: Parameters<typeof actual.putRows>) => actual.putRows(...args));
  return { ...actual, putRows: localDb.putRows };
});

import { ApiError } from './api';
import { closeDb, getAll } from './localDb';
import {
  BACKOFF, clearSent, discardFailed, enqueueScan, flushOutbox, loadOutbox, readOutbox,
  resetOutboxForTest, retryFailed, senderIdle, startSender, stopSender, type OutboxRow,
} from './outbox';

const SETUP = { site_id: 'site-1', initiative_id: 'init-1', scan_status: 'cage_exit' };

const ASSET = {
  id: 'a-1', asset_id: '10042', name: 'Rack 4 switch', rfid: '000000000000100348',
  serial_number: 'SN-4242', make_model: 'Cisco Nexus 9000',
};

function matched(value = 'SN-4242') {
  return { scanned_value: value, scan_type: 'barcode' as const, asset: ASSET, ...SETUP };
}

beforeEach(async () => {
  // Date is faked alongside setTimeout so the outbox's `next_attempt_at`
  // comparisons move with the timers the retries are scheduled on;
  // fake-indexeddb drives its events off setImmediate, which stays real.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-09-14T12:00:00Z'));
  closeDb();
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  resetOutboxForTest();
  api.postScans.mockReset();
  api.postScans.mockResolvedValue({ accepted: [], rejected: [] });
  localDb.putRows.mockClear();     // keep the delegating impl, drop call history
  await loadOutbox();
});

afterEach(() => {
  stopSender();
  vi.useRealTimers();
});

/** Runs the timers the sender scheduled and waits for the flush they
 *  started (plus any flush it chained) to settle. */
async function tick(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  await senderIdle();
}

const ids = (rows: readonly OutboxRow[]) => rows.map((r) => r.scanned_value);

it('enqueues a matched scan as queued and lists newest first', async () => {
  await enqueueScan(matched('SN-1'));
  await enqueueScan(matched('SN-2'));

  const { rows, counts } = readOutbox();
  expect(ids(rows)).toEqual(['SN-2', 'SN-1']);
  expect(rows[0]).toMatchObject({
    status: 'queued', matched: true, attempts: 0, scan_type: 'barcode', ...SETUP,
  });
  expect(rows[0].client_scan_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(counts).toMatchObject({ queued: 2, accepted: 0, failed: 0 });
  expect(await getAll('outbox')).toHaveLength(2);
});

it('an unmatched scan is stored as nomatch and is never sent', async () => {
  startSender();
  await enqueueScan({ scanned_value: 'nope123', scan_type: 'barcode', asset: null, ...SETUP });
  await tick(1000);

  expect(api.postScans).not.toHaveBeenCalled();
  const { rows, counts } = readOutbox();
  expect(rows[0]).toMatchObject({ status: 'nomatch', matched: false, asset: null });
  expect(counts).toMatchObject({ nomatch: 1, queued: 0 });
});

it('waits 500 ms for more scans, then sends the batch as ONE post', async () => {
  startSender();
  await enqueueScan(matched('SN-1'));
  await vi.advanceTimersByTimeAsync(400);
  await enqueueScan(matched('SN-2'));
  expect(api.postScans).not.toHaveBeenCalled();

  await tick(600);
  expect(api.postScans).toHaveBeenCalledTimes(1);
  const body = api.postScans.mock.calls[0][0];
  expect(body.serial).toBeTruthy();
  expect(body.scans).toHaveLength(2);
  expect(body.scans[0]).toMatchObject({
    scanned_value: 'SN-1', scan_type: 'barcode', asset_id: 'a-1',
    site_id: 'site-1', initiative_id: 'init-1', scan_status: 'cage_exit',
  });
  expect(typeof body.scans[0].scanned_at).toBe('string');
});

it('marks each scan from the response — accepted green, rejected failed with its code', async () => {
  startSender();
  await enqueueScan(matched('SN-1'));
  await enqueueScan(matched('SN-2'));
  const pending = await getAll<OutboxRow>('outbox');
  const bad = pending.find((r) => r.scanned_value === 'SN-2')!;
  const good = pending.find((r) => r.scanned_value === 'SN-1')!;
  api.postScans.mockResolvedValue({
    accepted: [good.client_scan_id],
    rejected: [{ client_scan_id: bad.client_scan_id, code: 'bad_site' }],
  });

  await tick(600);
  const { rows, counts } = readOutbox();
  expect(rows.find((r) => r.scanned_value === 'SN-1')).toMatchObject({ status: 'accepted' });
  expect(rows.find((r) => r.scanned_value === 'SN-2'))
    .toMatchObject({ status: 'failed', last_error: 'bad_site' });
  expect(counts).toMatchObject({ accepted: 1, failed: 1, queued: 0 });
});

it('a thrown ApiError retries at 2s, 4s, 15s and 60s, then gives up', async () => {
  expect(BACKOFF).toEqual([2000, 4000, 15000, 60000]);
  api.postScans.mockRejectedValue(new ApiError(0, 'network'));
  startSender();
  await enqueueScan(matched('SN-1'));

  await tick(600);
  expect(api.postScans).toHaveBeenCalledTimes(1);
  expect(readOutbox().rows[0]).toMatchObject({ status: 'retrying', attempts: 1, last_error: 'network' });

  for (const [i, wait] of BACKOFF.entries()) {
    await tick(wait - 1);
    expect(api.postScans).toHaveBeenCalledTimes(i + 1);   // not due yet
    await tick(1);
    expect(api.postScans).toHaveBeenCalledTimes(i + 2);   // the retry fired on schedule
  }

  // The fourth wait (60 s) was the last one the ladder has: the attempt
  // after it fails for good rather than retrying forever.
  expect(readOutbox().rows[0]).toMatchObject({ status: 'failed', last_error: 'network' });
  expect(readOutbox().counts).toMatchObject({ failed: 1, queued: 0 });
});

it('retryFailed puts failed rows back at the front of the queue', async () => {
  api.postScans.mockRejectedValue(new ApiError(503, 'unavailable'));
  startSender();
  await enqueueScan(matched('SN-1'));
  await tick(600);
  for (const wait of BACKOFF) await tick(wait);
  expect(readOutbox().rows[0].status).toBe('failed');

  api.postScans.mockResolvedValue({ accepted: [], rejected: [] });
  await retryFailed();
  expect(readOutbox().rows[0]).toMatchObject({ status: 'queued', attempts: 0 });

  api.postScans.mockImplementation((body: { scans: { client_scan_id: string }[] }) =>
    Promise.resolve({ accepted: body.scans.map((s) => s.client_scan_id), rejected: [] }));
  await tick(600);
  expect(readOutbox().rows[0].status).toBe('accepted');
});

it('clearSent removes accepted and nomatch rows but keeps failed and work in flight', async () => {
  api.postScans.mockRejectedValue(new ApiError(503, 'unavailable'));
  startSender();
  await enqueueScan(matched('SN-failed'));
  await tick(600);
  for (const wait of BACKOFF) await tick(wait);
  expect(readOutbox().rows.find((r) => r.scanned_value === 'SN-failed'))
    .toMatchObject({ status: 'failed' });

  api.postScans.mockImplementation((body: { scans: { client_scan_id: string }[] }) =>
    Promise.resolve({ accepted: body.scans.map((s) => s.client_scan_id), rejected: [] }));
  await enqueueScan(matched('SN-sent'));
  await tick(600);
  await enqueueScan({ scanned_value: 'nope', scan_type: 'barcode', asset: null, ...SETUP });
  stopSender();
  await enqueueScan(matched('SN-waiting'));      // sender stopped: stays queued

  expect(readOutbox().rows).toHaveLength(4);
  await clearSent();
  expect(ids(readOutbox().rows)).toEqual(['SN-waiting', 'SN-failed']);
  expect(await getAll('outbox')).toHaveLength(2);
});

it('discardFailed removes only failed rows, and leaves everything else untouched', async () => {
  api.postScans.mockRejectedValue(new ApiError(503, 'unavailable'));
  startSender();
  await enqueueScan(matched('SN-failed'));
  await tick(600);
  for (const wait of BACKOFF) await tick(wait);
  expect(readOutbox().rows[0]).toMatchObject({ status: 'failed' });

  stopSender();
  await enqueueScan(matched('SN-waiting'));

  await discardFailed();
  expect(ids(readOutbox().rows)).toEqual(['SN-waiting']);
  expect(await getAll('outbox')).toHaveLength(1);
});

it('a storage failure while marking a batch `sending` recovers it to `queued` instead of stranding it', async () => {
  api.postScans.mockImplementation((body: { scans: { client_scan_id: string }[] }) =>
    Promise.resolve({ accepted: body.scans.map((s) => s.client_scan_id), rejected: [] }));
  startSender();
  await enqueueScan(matched('SN-1'));

  // The batch's first write — flipping the row to `sending` before the
  // POST — fails; `dueRows` only ever picks up `queued`/`retrying`, so
  // without recovery this row would sit `sending` forever.
  localDb.putRows.mockRejectedValueOnce(new Error('storage'));
  await tick(600);

  // Recovered to `queued`, rescheduled, and this time it goes through.
  expect(readOutbox().rows[0]).toMatchObject({ status: 'accepted', attempts: 0 });
});

it('resumes queued and retrying rows left behind by a reload', async () => {
  await enqueueScan(matched('SN-1'));          // no sender running yet
  expect(api.postScans).not.toHaveBeenCalled();

  resetOutboxForTest();                        // a fresh page load, same database
  startSender();
  await loadOutbox();
  await tick(600);

  expect(api.postScans).toHaveBeenCalledTimes(1);
  expect(api.postScans.mock.calls[0][0].scans[0].scanned_value).toBe('SN-1');
});

it('sends at most 100 scans in one batch', async () => {
  for (let i = 0; i < 140; i += 1) await enqueueScan(matched(`SN-${i}`));
  startSender();
  await flushOutbox();
  expect(api.postScans.mock.calls[0][0].scans).toHaveLength(100);
});

it('caps the rendered list at 200 rows while the counts see everything', async () => {
  for (let i = 0; i < 205; i += 1) await enqueueScan(matched(`SN-${i}`));
  const { rows, counts } = readOutbox();
  expect(rows).toHaveLength(200);
  expect(counts.queued).toBe(205);
});

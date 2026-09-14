/**
 * The scan outbox — every scan the kiosk takes, queued in IndexedDB
 * until the API has acknowledged it.
 *
 * The kiosk scans against its local copy of the move, so scanning keeps
 * working with no network at all; what needs care is the trip back to
 * the portal. Hence a durable queue rather than a fetch per scan:
 *
 * - **IndexedDB, not memory.** A kiosk that loses power mid-shift must
 *   not lose the scans it already took. `startSender()` picks `queued`
 *   and `retrying` rows back up on the next load, and a row left
 *   `sending` by a reload is reset to `queued` (the POST is idempotent
 *   on `client_scan_id`, so re-sending one that did land is free).
 * - **Batched.** A scan schedules a flush 500 ms out and a scan that
 *   arrives inside that window rides along instead of pushing it back,
 *   so a person waving tags at a reader produces a few POSTs rather
 *   than a few hundred — and no scan waits longer than the window.
 * - **Backed off, not hammered.** A thrown `ApiError` (network, 5xx,
 *   423 read-only) puts the whole batch back with the next wait off
 *   `BACKOFF`; a row that exhausts the ladder is `failed` and waits for
 *   the operator's "Retry failed". A *rejected* scan (the API answered
 *   200 and named it `bad_site`/`bad_initiative`/`bad_status`) is
 *   failed immediately — retrying a reference the server does not know
 *   would just fail the same way.
 * - **Unmatched scans never leave the kiosk.** They are stored
 *   `nomatch` purely so the operator sees the tag they just waved did
 *   not resolve; the ingest endpoint only takes scans the kiosk matched.
 */

import { useSyncExternalStore } from 'react';

import { ApiError, postScans, type KioskScanIn } from './api';
import { getIdentity, uuid } from './identity';
import { deleteRows, getAll, putRows } from './localDb';

/** The waits between retries of a batch the API never accepted. The
 *  ladder is walked with the row's pre-increment `attempts`, so the
 *  first failure waits 2 s and the attempt after the last (60 s) wait
 *  fails for good. */
export const BACKOFF = [2000, 4000, 15000, 60000] as const;

/** The API takes 1-100 scans per batch. */
export const MAX_BATCH = 100;

/** How long a scan waits for company before its batch goes out. */
export const BATCH_DELAY = 500;

/** How many rows the Scanning list renders; the counts see all of them. */
export const LIST_CAP = 200;

/** A `nomatch` row older than this is swept off the list — it never went
 *  anywhere, and past this point it is just clutter from a tag that did
 *  not resolve. */
export const NOMATCH_TTL_MS = 120_000;

/** How often the sender checks for expired `nomatch` rows while running.
 *  Combined with `NOMATCH_TTL_MS`, a row lives on screen at most ~130 s. */
export const NOMATCH_SWEEP_MS = 10_000;

export type OutboxStatus =
  | 'queued' | 'sending' | 'accepted' | 'retrying' | 'failed' | 'nomatch';

/** The matched asset, denormalized onto the row: the list has to keep
 *  showing serial/name/RFID/make-model after the local database is
 *  re-synced (or cleared) out from under it. */
export interface OutboxAsset {
  id: string;
  asset_id: string;
  name: string | null;
  rfid: string | null;
  serial_number: string | null;
  make_model: string;
}

export interface OutboxRow {
  client_scan_id: string;
  /** Monotonic per-kiosk counter. The list is ordered by this, not by
   *  `scanned_at`: a reader firing twice inside one millisecond would
   *  otherwise show its two scans in an arbitrary order. Persisted, so
   *  a reload keeps the order it had. */
  seq: number;
  scanned_value: string;
  scan_type: 'rfid' | 'barcode';
  scanned_at: string;
  asset: OutboxAsset | null;
  matched: boolean;
  status: OutboxStatus;
  attempts: number;
  next_attempt_at?: number;
  last_error?: string;
  site_id: string;
  initiative_id: string;
  scan_status: string;
}

export interface EnqueueInput {
  scanned_value: string;
  scan_type: 'rfid' | 'barcode';
  asset: OutboxAsset | null;
  site_id: string;
  initiative_id: string;
  scan_status: string;
}

export interface OutboxCounts {
  queued: number;      // queued + sending + retrying — "still on its way"
  accepted: number;
  failed: number;
  nomatch: number;
  total: number;
}

export interface OutboxSnapshot {
  rows: OutboxRow[];
  counts: OutboxCounts;
}

const EMPTY: OutboxSnapshot = {
  rows: [],
  counts: { queued: 0, accepted: 0, failed: 0, nomatch: 0, total: 0 },
};

// ── store ───────────────────────────────────────────────────────────

type Listener = () => void;

const listeners = new Set<Listener>();

let all: OutboxRow[] = [];
let snapshot: OutboxSnapshot = EMPTY;
let nextSeq = 1;

function rebuild(): void {
  // Newest first is what the operator watches: the scan they just took
  // is the one they care about.
  all = [...all].sort((a, b) => b.seq - a.seq);
  const counts: OutboxCounts = {
    queued: 0, accepted: 0, failed: 0, nomatch: 0, total: all.length,
  };
  for (const row of all) {
    if (row.status === 'accepted') counts.accepted += 1;
    else if (row.status === 'failed') counts.failed += 1;
    else if (row.status === 'nomatch') counts.nomatch += 1;
    else counts.queued += 1;
  }
  snapshot = { rows: all.slice(0, LIST_CAP), counts };
  listeners.forEach((fn) => fn());
}

export function readOutbox(): OutboxSnapshot {
  return snapshot;
}

export function subscribeOutbox(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The newest `LIST_CAP` rows plus counts over the whole queue. */
export function useOutbox(): OutboxSnapshot {
  return useSyncExternalStore(subscribeOutbox, readOutbox, readOutbox);
}

/** Persists `rows` and refreshes the snapshot from what is in memory —
 *  the cache and the database are written from the same objects, so a
 *  re-read after every write would only cost a round trip. */
async function save(rows: OutboxRow[]): Promise<void> {
  await putRows('outbox', rows);
  const byId = new Map(rows.map((r) => [r.client_scan_id, r]));
  all = all.map((r) => byId.get(r.client_scan_id) ?? r);
  for (const row of rows) {
    if (!all.some((r) => r.client_scan_id === row.client_scan_id)) all.push(row);
  }
  rebuild();
}

/** Reads the queue off disk. Any row left `sending` belonged to a page
 *  that went away mid-POST; it goes back to `queued` (ingest is
 *  idempotent, so re-sending one that actually landed changes nothing). */
export async function loadOutbox(): Promise<void> {
  let rows: OutboxRow[];
  try {
    rows = await getAll<OutboxRow>('outbox');
  } catch {
    return;                            // no local database: nothing queued
  }
  const stranded = rows.filter((r) => r.status === 'sending');
  for (const row of stranded) row.status = 'queued';
  all = rows;
  nextSeq = rows.reduce((max, r) => Math.max(max, r.seq ?? 0), 0) + 1;
  rebuild();
  if (stranded.length) await putRows('outbox', stranded);
}

// ── enqueue ─────────────────────────────────────────────────────────

export async function enqueueScan(input: EnqueueInput): Promise<OutboxRow> {
  const matched = input.asset !== null;
  const row: OutboxRow = {
    client_scan_id: uuid(),
    seq: nextSeq++,
    scanned_value: input.scanned_value,
    scan_type: input.scan_type,
    scanned_at: new Date().toISOString(),
    asset: input.asset,
    matched,
    status: matched ? 'queued' : 'nomatch',
    attempts: 0,
    site_id: input.site_id,
    initiative_id: input.initiative_id,
    scan_status: input.scan_status,
  };
  await save([row]);
  if (matched) scheduleFlush(BATCH_DELAY);
  return row;
}

// ── sender ──────────────────────────────────────────────────────────

let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let timerDueAt = Infinity;
let inFlight: Promise<void> | null = null;
let sweepTimer: ReturnType<typeof setTimeout> | null = null;
let sweepInFlight: Promise<number> | null = null;

/** Runs `expireNoMatch`, tracked the same way `flushOutbox` tracks its own
 *  work — so `senderIdle` (and the tests that lean on it) see the sweep
 *  through to completion instead of racing its IndexedDB delete — then
 *  reschedules itself. A self-rescheduling `setTimeout` rather than
 *  `setInterval`: the sender's other timer (`scheduleFlush`) is a
 *  `setTimeout` too, and only `setTimeout`/`clearTimeout` are faked in
 *  tests. */
function scheduleSweep(): void {
  sweepTimer = setTimeout(() => {
    sweepInFlight = expireNoMatch().finally(() => { sweepInFlight = null; });
    if (running) scheduleSweep();
  }, NOMATCH_SWEEP_MS);
}

/** Deletes every `nomatch` row scanned more than `NOMATCH_TTL_MS` ago.
 *  Never touches any other status — a row still `queued`/`retrying`/
 *  `failed`/`accepted` stays no matter how old. Returns the number
 *  removed. */
export async function expireNoMatch(now: number = Date.now()): Promise<number> {
  const cutoff = now - NOMATCH_TTL_MS;
  const stale = all.filter(
    (r) => r.status === 'nomatch' && new Date(r.scanned_at).getTime() < cutoff);
  if (!stale.length) return 0;
  await deleteRows('outbox', stale.map((r) => r.client_scan_id));
  const dropped = new Set(stale.map((r) => r.client_scan_id));
  all = all.filter((r) => !dropped.has(r.client_scan_id));
  rebuild();
  return stale.length;
}

/** Schedules a flush `delay` from now, never later than one already
 *  pending: a scan arriving inside another scan's batching window rides
 *  along with it rather than pushing everyone's wait out again. */
function scheduleFlush(delay: number): void {
  if (!running) return;
  const dueAt = Date.now() + delay;
  if (timer !== null && timerDueAt <= dueAt) return;
  if (timer !== null) clearTimeout(timer);
  timerDueAt = dueAt;
  timer = setTimeout(() => {
    timer = null;
    timerDueAt = Infinity;
    void flushOutbox();
  }, delay);
}

export function startSender(): void {
  if (running) return;
  running = true;
  void loadOutbox().then(() => {
    sweepInFlight = expireNoMatch().finally(() => { sweepInFlight = null; });
    scheduleFlush(BATCH_DELAY);
  });
  scheduleSweep();
}

export function stopSender(): void {
  running = false;
  if (timer !== null) clearTimeout(timer);
  timer = null;
  timerDueAt = Infinity;
  if (sweepTimer !== null) clearTimeout(sweepTimer);
  sweepTimer = null;
}

/** Resolves once the flush in flight (and anything it chained), plus any
 *  `nomatch` sweep in flight, is done — the seam the tests await instead
 *  of guessing at timings. */
export async function senderIdle(): Promise<void> {
  while (inFlight || sweepInFlight) {
    if (inFlight) await inFlight;
    if (sweepInFlight) await sweepInFlight;
  }
}

function dueRows(now: number): OutboxRow[] {
  return all
    .filter((r) => r.status === 'queued'
      || (r.status === 'retrying' && (r.next_attempt_at ?? 0) <= now))
    // Oldest first: scans reach the portal in the order they were taken.
    .sort((a, b) => a.seq - b.seq)
    .slice(0, MAX_BATCH);
}

/** Wakes the sender when the earliest `retrying` row comes due. */
function scheduleNextRetry(): void {
  const waits = all
    .filter((r) => r.status === 'retrying' && r.next_attempt_at !== undefined)
    .map((r) => (r.next_attempt_at as number) - Date.now());
  if (!waits.length) return;
  scheduleFlush(Math.max(0, Math.min(...waits)));
}

/** One pass: take the due rows, POST them, and record what came back. */
async function flushOnce(): Promise<void> {
  const batch = dueRows(Date.now());
  if (!batch.length) return;

  for (const row of batch) row.status = 'sending';
  await save(batch);

  const scans: KioskScanIn[] = batch.map((row) => ({
    client_scan_id: row.client_scan_id,
    scanned_value: row.scanned_value,
    scan_type: row.scan_type,
    scanned_at: row.scanned_at,
    asset_id: row.asset?.id ?? null,
    site_id: row.site_id,
    initiative_id: row.initiative_id,
    scan_status: row.scan_status,
  }));

  try {
    const result = await postScans({ serial: getIdentity().serial, scans });
    const accepted = new Set(result.accepted);
    const rejected = new Map(result.rejected.map((r) => [r.client_scan_id, r.code]));
    for (const row of batch) {
      if (accepted.has(row.client_scan_id)) {
        row.status = 'accepted';
        delete row.next_attempt_at;
        delete row.last_error;
      } else {
        // A named rejection is permanent — the server does not know that
        // site/move/checkpoint, and the same batch would be rejected the
        // same way forever. An id the response mentioned in neither list
        // is treated the same rather than retried against an endpoint
        // that ignored it.
        row.status = 'failed';
        row.last_error = rejected.get(row.client_scan_id) ?? 'no_ack';
      }
    }
  } catch (err) {
    const code = err instanceof ApiError ? (err.code || 'timeout') : 'timeout';
    const now = Date.now();
    for (const row of batch) {
      const wait = BACKOFF[row.attempts];   // indexed BEFORE the increment
      row.attempts += 1;
      row.last_error = code;
      if (wait === undefined) {
        row.status = 'failed';              // the ladder is spent
        delete row.next_attempt_at;
      } else {
        row.status = 'retrying';
        row.next_attempt_at = now + wait;
      }
    }
  }
  await save(batch);
}

/** One flush, single-flight: a second caller gets the pass already in
 *  flight rather than sending the same rows twice. `inFlight` is
 *  cleared in a `.then` on the promise — not in the async body's own
 *  `finally`, which would run before the assignment below and leave a
 *  settled promise wedged in place forever. */
export function flushOutbox(): Promise<void> {
  if (inFlight) return inFlight;
  const run = flushOnce()
    .catch(() => {
      // Storage failures must not kill the sender — but a batch left
      // `sending` would never be picked up again (`dueRows` only takes
      // `queued`/`retrying`), stranding it for good. Put it back to
      // `queued` (attempts untouched: this was not a network attempt)
      // so the check below schedules it straight back onto the queue.
      const stranded = all.filter((r) => r.status === 'sending');
      if (!stranded.length) return;
      for (const row of stranded) row.status = 'queued';
      rebuild();
    })
    .then(() => {
      inFlight = null;
      // More than one batch's worth waiting? Go again straight away;
      // otherwise wake up when the earliest retry comes due.
      if (dueRows(Date.now()).length) scheduleFlush(0);
      else scheduleNextRetry();
    });
  inFlight = run;
  return run;
}

// ── operator actions ────────────────────────────────────────────────

/** "Retry failed" — back to the front of the queue with a clean slate. */
export async function retryFailed(): Promise<void> {
  const rows = all.filter((r) => r.status === 'failed');
  if (!rows.length) return;
  for (const row of rows) {
    row.status = 'queued';
    row.attempts = 0;
    delete row.next_attempt_at;
    delete row.last_error;
  }
  await save(rows);
  scheduleFlush(0);
}

/** Removes every row matching `pred` in one write, shared by `clearSent`
 *  and `discardFailed` below. */
async function dropRows(pred: (row: OutboxRow) => boolean): Promise<void> {
  const drop = all.filter(pred);
  if (!drop.length) return;
  await deleteRows('outbox', drop.map((r) => r.client_scan_id));
  const dropped = new Set(drop.map((r) => r.client_scan_id));
  all = all.filter((r) => !dropped.has(r.client_scan_id));
  rebuild();
}

/** "Clear sent" — drops what settled cleanly (accepted, and the
 *  unmatched scans that were never going anywhere) and keeps whatever
 *  is still on its way OR needs the operator's attention. `failed` rows
 *  are deliberately NOT included: they are scans the portal never
 *  received, and clearing them silently would look identical to a
 *  clean send from the operator's side. See `discardFailed`. */
export function clearSent(): Promise<void> {
  return dropRows((r) => r.status === 'accepted' || r.status === 'nomatch');
}

/** "Discard failed" — the operator has confirmed these scans are being
 *  abandoned, not just tidied off the screen; the page asks first
 *  because, unlike `clearSent`, this throws away scans that never
 *  reached the portal. */
export function discardFailed(): Promise<void> {
  return dropRows((r) => r.status === 'failed');
}

/** Test seam: drops the in-memory queue and every timer, as if the page
 *  had just loaded. Leaves the database alone. */
export function resetOutboxForTest(): void {
  stopSender();
  inFlight = null;
  sweepInFlight = null;
  all = [];
  nextSeq = 1;
  snapshot = EMPTY;
  rebuild();
}

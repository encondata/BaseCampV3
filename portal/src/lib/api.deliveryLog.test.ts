// @vitest-environment jsdom
/** The Delivery log's API calls: getDeliveryLogPage (query string for
 *  usePagedList — repeated `event`, blanks dropped), checkDelivery (`owner_copy`
 *  only when asked for; the answer comes back as the API sent it) and
 *  listNotificationKinds (each kind with whether it is critical and locked). */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  ApiError, checkDelivery, getDeliveryLogPage, listNotificationKinds, type DeliveryLogQuery,
} from './api';

const SESSION = {
  status: 'ok', access_token: 'tok', expires_in: 900, session_expires_at: '2030-01-01T00:00:00Z',
  person: { id: 'p1' }, roles: [], must_change_password: false, preferences: {},
  perms: {}, max_rank: 0, scope: { global: true, client_ids: [], partner_ids: [] },
  password_min_length: 8,
  totp: { enrolled: false, enrolled_at: null, required: false, backup_codes_remaining: 0 },
};

/** apiFetch refreshes the session first (no token yet): answer that, and give
 *  every other call `answer`. Returns the non-refresh calls. */
function mockFetch(answer: () => Response) {
  const fn = vi.fn(async (url: string, _init?: RequestInit) => (String(url).includes('/auth/refresh')
    ? new Response(JSON.stringify(SESSION), { status: 200, headers: { 'Content-Type': 'application/json' } })
    : answer()));
  vi.stubGlobal('fetch', fn);
  return () => fn.mock.calls.filter(([u]) => !String(u).includes('/auth/refresh'));
}

const json = (body: unknown, status = 200) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const urlOf = (calls: () => unknown[][], i = 0) => new URL((calls()[i] as [string])[0]);

const EMPTY: DeliveryLogQuery = { events: [], channel: null, category: null, since: null };

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => vi.unstubAllGlobals());

it('asks for a page of 100 newest first and returns rows, cursor and total as given', async () => {
  const row = { id: 7, at: '2026-11-01T12:00:00Z', event: 'email_sent' };
  const calls = mockFetch(json({ rows: [row], next_cursor: '7', total: 31 }));
  const page = await getDeliveryLogPage({ ...EMPTY, search: '', cursor: null });
  expect(page).toEqual({ rows: [row], next_cursor: '7', total: 31 });
  const u = urlOf(calls);
  expect(u.pathname).toMatch(/\/notifications\/log$/);
  expect([...u.searchParams.entries()]).toEqual([['limit', '100']]);   // no blank params
});

it('sends every filter that is set: q, each event, channel, category, since, cursor and the trail ids', async () => {
  const calls = mockFetch(json({ rows: [], next_cursor: null, total: 0 }));
  await getDeliveryLogPage({
    events: ['email_sent', 'email_failed'], channel: 'email', category: 'wiki',
    since: '2026-10-25T12:00:00.000Z', notificationId: 'n1', outboxId: 'o1',
    search: '  Ada ', cursor: '42',
  });
  const u = urlOf(calls);
  expect(u.searchParams.getAll('event')).toEqual(['email_sent', 'email_failed']);
  expect(u.searchParams.get('q')).toBe('Ada');
  expect(u.searchParams.get('channel')).toBe('email');
  expect(u.searchParams.get('category')).toBe('wiki');
  expect(u.searchParams.get('since')).toBe('2026-10-25T12:00:00.000Z');
  expect(u.searchParams.get('notification_id')).toBe('n1');
  expect(u.searchParams.get('outbox_id')).toBe('o1');
  expect(u.searchParams.get('cursor')).toBe('42');
});

it('sends the held and summary events like any other', async () => {
  const calls = mockFetch(json({ rows: [], next_cursor: null, total: 0 }));
  await getDeliveryLogPage({ ...EMPTY, events: ['email_held', 'email_summarized'], search: '', cursor: null });
  expect(urlOf(calls).searchParams.getAll('event')).toEqual(['email_held', 'email_summarized']);
});

it('passes the abort signal through', async () => {
  const calls = mockFetch(json({ rows: [], next_cursor: null, total: 0 }));
  const ctrl = new AbortController();
  await getDeliveryLogPage({ ...EMPTY, search: '', cursor: null }, ctrl.signal);
  const [, init] = calls()[0] as [string, RequestInit];
  expect(init.signal).toBe(ctrl.signal);
});

it('throws the API error, e.g. the 403 below super admin', async () => {
  mockFetch(json({ detail: { code: 'forbidden' } }, 403));
  await expect(getDeliveryLogPage({ ...EMPTY, search: '', cursor: null }))
    .rejects.toMatchObject({ status: 403, code: 'forbidden' });
});

it('checkDelivery sends owner_copy only when it is given', async () => {
  const calls = mockFetch(json({ person_id: 'p1', outcome: 'now' }));
  await checkDelivery('p1', 'report_ready');
  await checkDelivery('p1', 'password_expiring', false);
  await checkDelivery('p1', 'password_expiring', true);

  const plain = urlOf(calls, 0);
  expect(plain.pathname).toMatch(/\/notifications\/check$/);
  expect([...plain.searchParams.entries()]).toEqual([['person_id', 'p1'], ['kind', 'report_ready']]);
  expect(urlOf(calls, 1).searchParams.get('owner_copy')).toBe('false');
  expect(urlOf(calls, 2).searchParams.get('owner_copy')).toBe('true');
});

it('checkDelivery returns the answer as sent: switches, schedule, critical and the summary time', async () => {
  const answer = {
    person_id: 'p1', person_name: 'Ada Lovelace', kind: 'report_ready', kind_label: 'Report ready',
    category: 'reports', owner_copy: false, active: true, has_account: true,
    inbox: 'written', inbox_source: 'default', email_enabled: true, critical: false,
    switches: { inbox: { on: true, source: 'default' }, email: { on: true, source: 'own' } },
    schedule: {
      timezone: 'America/Chicago', days: ['mon', 'tue'], quiet_start: '21:00', quiet_end: '07:00',
      state: 'quiet_hours',
    },
    outcome: 'held', send_at: null, summary_at: '2026-11-02T12:00:00Z', reason: 'quiet_hours',
    address: 'ada@example.com', address_source: 'contact',
  };
  mockFetch(json(answer));
  const check = await checkDelivery('p1', 'report_ready');
  expect(check).toEqual(answer);
  expect(check.switches.email.source).toBe('own');
  expect(check.schedule.state).toBe('quiet_hours');
  expect(check.summary_at).toBe('2026-11-02T12:00:00Z');
});

it('checkDelivery surfaces the 404 for a person that is gone', async () => {
  mockFetch(json({ detail: { code: 'person_not_found' } }, 404));
  const err = await checkDelivery('p9', 'report_ready').catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect(err).toMatchObject({ status: 404, code: 'person_not_found' });
});

it('listNotificationKinds reads the registry, with whether each kind is critical and locked', async () => {
  const kinds = [
    { kind: 'report_ready', label: 'Report ready', category: 'reports',
      email: true, owner_always: false, critical: false, locked: false },
    { kind: 'password_expiring', label: 'Password expiring', category: 'security',
      email: true, owner_always: true, critical: true, locked: true },
  ];
  const calls = mockFetch(json(kinds));
  expect(await listNotificationKinds()).toEqual(kinds);
  expect(urlOf(calls).pathname).toMatch(/\/notifications\/kinds$/);
});

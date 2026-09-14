// @vitest-environment jsdom
/** The Timeclock page against a real (fake) IndexedDB and stubbed
 *  timeclock endpoints: finding a worker, the status card, and the one
 *  action button that punches them in or out. */
import 'fake-indexeddb/auto';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IDBFactory } from 'fake-indexeddb';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  fetchTimeclockStatus: vi.fn(), postClockIn: vi.fn(), postClockOut: vi.fn(),
}));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, ...api };
});

// The page never reads the auth context itself, but KioskShell's
// provider isn't mounted here — stub it so nothing further down can.
vi.mock('../auth/KioskAuthContext', () => ({
  useKioskAuth: () => ({ status: 'authed', person: { display_name: 'Alex Worker' }, can: () => true }),
}));

// jsdom has no Web Audio API; what this page owes the Sound tab is the
// call, not the noise (lib/sound.test.ts covers the tones).
const sound = vi.hoisted(() => ({ playScanSound: vi.fn() }));
vi.mock('../lib/sound', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/sound')>();
  return { ...actual, playScanSound: sound.playScanSound };
});

import { ApiError, type KioskPersonRow } from '../lib/api';
import { DEFAULT_APPEARANCE, hslCss } from '../lib/appearance';
import { clearFlash, readFlash } from '../lib/flash';
import { getIdentity } from '../lib/identity';
import { writeKioskSetup } from '../lib/kioskSetup';
import { closeDb, replaceAll } from '../lib/localDb';
import Timeclock from './Timeclock';

const JIMMY: KioskPersonRow = {
  id: 'p-jimmy', display_name: 'Jimmy Henderson', first_name: 'James', last_name: 'Henderson',
  preferred_name: 'Jimmy', rfid_tag: '000000000000100348', is_worker: true, has_account: true,
};
const TINA: KioskPersonRow = {
  id: 'p-tina', display_name: 'Tina Tanaka', first_name: 'Tina', last_name: 'Tanaka',
  preferred_name: null, rfid_tag: '4821', is_worker: true, has_account: false,
};
const SHORT_TAG: KioskPersonRow = {
  id: 'p-short', display_name: 'Short Tag', first_name: 'Short', last_name: 'Tag',
  preferred_name: null, rfid_tag: '1003', is_worker: true, has_account: false,
};
const LONG_TAG: KioskPersonRow = {
  id: 'p-long', display_name: 'Long Tag', first_name: 'Long', last_name: 'Tag',
  preferred_name: null, rfid_tag: '100348', is_worker: true, has_account: false,
};

const SETUP = {
  initiativeId: 'init-1', initiativeName: 'NAP11 Hall Migration',
  siteId: 'site-1', siteName: 'ACC4', siteRole: 'source' as const,
  scanStatus: 'cage_exit', scanLabel: 'RFID 1 - Cage Exit',
};

const person = (p: KioskPersonRow) => ({
  id: p.id, display_name: p.display_name, first_name: p.first_name, last_name: p.last_name,
  preferred_name: p.preferred_name, avatar_url: null, rfid_tag: p.rfid_tag,
});

const clockedIn = (p: KioskPersonRow = JIMMY, minutesAgo = 134) => ({
  person: person(p),
  clocked_in: true,
  entry: {
    id: 'e-1', started_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    initiative_id: 'init-1', initiative_name: 'NAP11 Hall Migration',
    site_id: 'site-1', site_name: 'ACC4',
  },
  last_entry: null,
});

const clockedOut = (p: KioskPersonRow = JIMMY) => ({
  person: person(p), clocked_in: false, entry: null,
  last_entry: {
    id: 'e-0', started_at: '2026-09-13T12:00:00Z',
    ended_at: '2026-09-13T17:00:00Z', minutes: 300,
  },
});

const render_ = () => render(<MemoryRouter><Timeclock /></MemoryRouter>);

beforeEach(async () => {
  localStorage.clear();
  closeDb();
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  await replaceAll('people', [JIMMY, TINA]);
  writeKioskSetup(SETUP);
  api.fetchTimeclockStatus.mockReset().mockResolvedValue(clockedOut());
  api.postClockIn.mockReset().mockResolvedValue(clockedIn(JIMMY, 0));
  api.postClockOut.mockReset().mockResolvedValue({
    person: person(JIMMY), clocked_in: false, entry: null,
    last_entry: {
      id: 'e-1', started_at: '2026-09-14T12:00:00Z',
      ended_at: '2026-09-14T15:12:00Z', minutes: 192,
    },
  });
});

afterEach(() => { cleanup(); clearFlash(); vi.clearAllMocks(); });

const input = () => screen.getByLabelText('Badge, ID, or name') as HTMLInputElement;

/** The box is disabled until the people list is read out of IndexedDB
 *  (a few milliseconds), and a scanner typing into a disabled input is
 *  simply dropped — so every typing test waits for it first. */
async function ready(): Promise<HTMLInputElement> {
  const el = await screen.findByLabelText('Badge, ID, or name') as HTMLInputElement;
  await waitFor(() => expect(el.disabled).toBe(false));
  return el;
}

async function typeAndPick(text: string, name: RegExp) {
  await userEvent.type(await ready(), text);
  await userEvent.click(await screen.findByRole('button', { name }));
}

it('focuses the input on mount and shows the move and site', async () => {
  render_();
  await waitFor(() => expect(document.activeElement).toBe(input()));
  expect(screen.getByText('NAP11 Hall Migration · ACC4')).toBeTruthy();
});

it('filters as typed, in either name order', async () => {
  render_();
  await userEvent.type(await ready(), 'hen jim');
  expect(await screen.findByRole('button', { name: /Jimmy Henderson/ })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Tina Tanaka/ })).toBeNull();

  await userEvent.clear(input());
  await userEvent.type(input(), 'tanaka t');
  expect(await screen.findByRole('button', { name: /Tina Tanaka/ })).toBeTruthy();
});

it('clicking a result loads the portal status and shows the card', async () => {
  api.fetchTimeclockStatus.mockResolvedValue(clockedIn());
  render_();
  await typeAndPick('jimmy', /Jimmy Henderson/);

  await waitFor(() => expect(api.fetchTimeclockStatus).toHaveBeenCalledWith('p-jimmy'));
  expect(await screen.findByText(/Clocked in for/)).toBeTruthy();
  expect(screen.getByText('2h 14m')).toBeTruthy();
  expect(screen.getByText(/^since .+ · NAP11 Hall Migration · ACC4$/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Clock out' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Clock in' })).toBeNull();
});

it('clocks a worker out, flashes, sounds, and returns to the entry state with a toast', async () => {
  api.fetchTimeclockStatus.mockResolvedValue(clockedIn());
  render_();
  await typeAndPick('jimmy', /Jimmy Henderson/);
  await userEvent.click(await screen.findByRole('button', { name: 'Clock out' }));

  await waitFor(() => expect(api.postClockOut).toHaveBeenCalledWith({
    serial: getIdentity().serial, person_id: 'p-jimmy',
  }));
  expect(sound.playScanSound).toHaveBeenCalledWith('good');
  expect(readFlash()?.color).toBe(hslCss(DEFAULT_APPEARANCE.good_scan));
  expect(await screen.findByText('Clocked out — Jimmy Henderson · 3h 12m')).toBeTruthy();
  expect(input()).toBeTruthy();                       // back to the entry state
  expect(screen.queryByRole('table')).toBeNull();     // the kiosk keeps no punch history
});

it('clocks a worker in when they are not on the clock', async () => {
  api.postClockIn.mockResolvedValue(clockedIn(TINA, 0));
  render_();
  await typeAndPick('tina', /Tina Tanaka/);

  expect(await screen.findByText('Not clocked in')).toBeTruthy();
  expect(screen.getByText(/Last clock-out/)).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Clock in' }));

  await waitFor(() => expect(api.postClockIn).toHaveBeenCalledWith({
    serial: getIdentity().serial, person_id: 'p-tina',
    site_id: 'site-1', initiative_id: 'init-1',
  }));
  expect(await screen.findByText('Clocked in — Tina Tanaka')).toBeTruthy();
  expect(screen.queryByRole('table')).toBeNull();
});

it('an RFID with leading zeros selects the worker without Enter', async () => {
  api.fetchTimeclockStatus.mockResolvedValue(clockedIn());
  render_();
  await userEvent.type(await ready(), '000000000000100348');

  await waitFor(() => expect(api.fetchTimeclockStatus).toHaveBeenCalledWith('p-jimmy'));
  expect(await screen.findByText(/Clocked in for/)).toBeTruthy();
});

it('Enter on an unknown value flashes not-found and says so', async () => {
  render_();
  await userEvent.type(await ready(), 'nope123{Enter}');

  expect(await screen.findByText('No worker found for "nope123".')).toBeTruthy();
  expect(sound.playScanSound).toHaveBeenCalledWith('not_found');
  expect(readFlash()?.color).toBe(hslCss(DEFAULT_APPEARANCE.not_found_scan));
  expect(api.fetchTimeclockStatus).not.toHaveBeenCalled();
});

it('already_clocked_in shows its copy and re-fetches the status', async () => {
  api.postClockIn.mockRejectedValue(new ApiError(409, 'already_clocked_in'));
  render_();
  await typeAndPick('tina', /Tina Tanaka/);
  await userEvent.click(await screen.findByRole('button', { name: 'Clock in' }));

  expect(await screen.findByText('They are already clocked in. Refreshing…')).toBeTruthy();
  expect(sound.playScanSound).toHaveBeenCalledWith('not_found');
  await waitFor(() => expect(api.fetchTimeclockStatus).toHaveBeenCalledTimes(2));
  expect(screen.getByRole('button', { name: /Clock/ })).toBeTruthy();   // still on the card
});

it('a network failure says the punch was not recorded', async () => {
  api.postClockIn.mockRejectedValue(new ApiError(0, 'network'));
  render_();
  await typeAndPick('tina', /Tina Tanaka/);
  await userEvent.click(await screen.findByRole('button', { name: 'Clock in' }));

  expect(await screen.findByText("Can't reach the portal. The punch was not recorded."))
    .toBeTruthy();
});

it('Cancel returns to the entry state', async () => {
  render_();
  await typeAndPick('tina', /Tina Tanaka/);
  await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

  expect(input()).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Clock in' })).toBeNull();
});

it('with no people synced, says so and disables the input', async () => {
  await replaceAll('people', []);
  render_();
  expect(await screen.findByText('No people on this kiosk. Sync from Kiosk Setup.')).toBeTruthy();
  await waitFor(() => expect(input().disabled).toBe(true));
});

it('Cancel clears a lingering punch error, so it never greets the next worker', async () => {
  api.postClockIn.mockRejectedValue(new ApiError(0, 'network'));
  render_();
  await typeAndPick('tina', /Tina Tanaka/);
  await userEvent.click(await screen.findByRole('button', { name: 'Clock in' }));
  expect(await screen.findByText("Can't reach the portal. The punch was not recorded."))
    .toBeTruthy();

  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByText("Can't reach the portal. The punch was not recorded.")).toBeNull();
});

it('a punch error auto-dismisses on its own, like the not-found error', async () => {
  api.postClockIn.mockRejectedValue(new ApiError(0, 'network'));
  render_();
  await typeAndPick('tina', /Tina Tanaka/);
  await userEvent.click(await screen.findByRole('button', { name: 'Clock in' }));
  expect(await screen.findByText("Can't reach the portal. The punch was not recorded."))
    .toBeTruthy();

  await waitFor(() => expect(
    screen.queryByText("Can't reach the portal. The punch was not recorded.")).toBeNull(),
  { timeout: 4000 });
}, 6000);

it('a value that is also a prefix of a longer RFID waits rather than auto-selecting', async () => {
  await replaceAll('people', [SHORT_TAG, LONG_TAG]);
  api.fetchTimeclockStatus.mockResolvedValue(clockedIn(LONG_TAG, 0));
  render_();
  const el = await ready();
  await userEvent.type(el, '1003');

  // "1003" is SHORT_TAG's whole tag but also a strict prefix of
  // LONG_TAG's — too soon to tell, so it must stay on the entry screen.
  expect(input()).toBeTruthy();
  expect(api.fetchTimeclockStatus).not.toHaveBeenCalled();

  await userEvent.type(el, '48');
  await waitFor(() => expect(api.fetchTimeclockStatus).toHaveBeenCalledWith('p-long'));
});

it('Enter still selects the exact match even though it is an ambiguous prefix', async () => {
  await replaceAll('people', [SHORT_TAG, LONG_TAG]);
  api.fetchTimeclockStatus.mockResolvedValue(clockedIn(SHORT_TAG, 0));
  render_();
  await userEvent.type(await ready(), '1003{Enter}');

  await waitFor(() => expect(api.fetchTimeclockStatus).toHaveBeenCalledWith('p-short'));
});

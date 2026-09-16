// @vitest-environment jsdom
/** RFID Enroll against a real (fake) IndexedDB and a stubbed enroll
 *  endpoint: finding the asset by serial or asset ID, the padded tag
 *  preview, the save, and what each failure says. */
import 'fake-indexeddb/auto';
import {
  cleanup, render, screen, waitFor, within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IDBFactory } from 'fake-indexeddb';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ postRfidEnroll: vi.fn() }));
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

import { ApiError } from '../lib/api';
import { DEFAULT_APPEARANCE, hslCss } from '../lib/appearance';
import { writeCheckpoint } from '../lib/checkpointSettings';
import { clearEnrollLog } from '../lib/enrollLog';
import { clearFlash, readFlash } from '../lib/flash';
import { getIdentity } from '../lib/identity';
import { writeKioskSetup } from '../lib/kioskSetup';
import { closeDb, getAll, replaceAll } from '../lib/localDb';
import type { ScanAsset } from '../lib/scanMatch';
import Enroll from './Enroll';

const SWITCH: ScanAsset = {
  id: 'a-1', asset_id: '10042', name: 'Rack 4 switch', rfid: null,
  serial_number: 'SN-4242', make: 'Cisco', model: 'Nexus 9000',
  make_model: 'Cisco Nexus 9000',
};
const TAGGED: ScanAsset = {
  id: 'a-2', asset_id: '10043', name: 'Patch panel', rfid: '000000000000000000100348',
  serial_number: 'FDO2140X9ZZ', make: null, model: null, make_model: '',
};

const SETUP = {
  initiativeId: 'init-1', initiativeName: 'NAP11 Hall Migration',
  siteId: 'site-1', siteName: 'ACC4', siteRole: 'source' as const,
  scanStatus: 'cage_exit', scanLabel: 'RFID 1 - Cage Exit',
};

/** A free tag: 100348 belongs to TAGGED, and the local gate refuses it
 *  before the endpoint is ever called (its own tests, below). */
const FREE = '900100';
const PADDED = '0'.repeat(18) + FREE;

const enrolled = (over: Record<string, unknown> = {}) => ({
  asset_id: SWITCH.id, asset_name: SWITCH.name, asset_tag: SWITCH.asset_id,
  serial_number: SWITCH.serial_number, rfid_tag: PADDED, already_had_tag: false,
  ...over,
});

const render_ = () => render(<MemoryRouter><Enroll /></MemoryRouter>);

beforeEach(async () => {
  localStorage.clear();
  clearEnrollLog();     // module-level: it outlives a render on purpose
  closeDb();
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  await replaceAll('assets', [SWITCH, TAGGED]);
  writeKioskSetup(SETUP);
  api.postRfidEnroll.mockReset().mockResolvedValue(enrolled());
});

afterEach(() => { cleanup(); clearFlash(); vi.clearAllMocks(); });

/** The asset box is disabled until the roster is read out of IndexedDB
 *  (a few milliseconds), and a scanner typing into a disabled input is
 *  simply dropped — so every typing test waits for it first. */
async function assetInput(): Promise<HTMLInputElement> {
  const el = await screen.findByLabelText('Asset serial or ID') as HTMLInputElement;
  await waitFor(() => expect(el.disabled).toBe(false));
  return el;
}

async function scanAsset(value: string): Promise<void> {
  const user = userEvent.setup();
  const el = await assetInput();
  await user.type(el, `${value}{Enter}`);
}

const tagInput = () => screen.getByLabelText('RFID tag') as HTMLInputElement;

/** An asset that already carries a tag stops on the confirmation card;
 *  the tag box only opens on a deliberate press. */
async function pressUpdate(): Promise<void> {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Update RFID Value' }));
  await screen.findByLabelText('RFID tag');
}

it('opens on the asset step with that input focused and empty', async () => {
  render_();
  const el = await assetInput();
  await waitFor(() => expect(document.activeElement).toBe(el));
  expect(el.value).toBe('');
  expect(screen.queryByLabelText('RFID tag')).toBeNull();
});

it('a serial match moves to the tag step, showing the asset card and focusing the tag box', async () => {
  render_();
  await scanAsset('sn-4242');

  const el = await screen.findByLabelText('RFID tag');
  await waitFor(() => expect(document.activeElement).toBe(el));
  expect(screen.getByText('Rack 4 switch')).toBeTruthy();
  expect(screen.getByText('SN-4242')).toBeTruthy();
  expect(screen.getByText('10042')).toBeTruthy();
  expect(screen.getByText('Cisco Nexus 9000')).toBeTruthy();
  expect(screen.queryByLabelText('Asset serial or ID')).toBeNull();
});

it('an asset ID match moves to the tag step too', async () => {
  render_();
  await scanAsset('10042');
  expect(await screen.findByLabelText('RFID tag')).toBeTruthy();
  expect(screen.getByText('Rack 4 switch')).toBeTruthy();
});

it('an asset that already has a tag stops on the confirmation card, not the tag box', async () => {
  render_();
  await scanAsset('10043');

  const card = await screen.findByRole('group', { name: 'Asset already tagged' });
  expect(within(card).getByText('Patch panel')).toBeTruthy();
  expect(within(card).getByText('100348')).toBeTruthy();        // trimmed
  expect(within(card).getByText('FDO2140X9ZZ')).toBeTruthy();
  expect(screen.getByText(/This asset already has a tag\./)).toBeTruthy();
  // The gate: nowhere for a second scan to land, and nothing for its
  // Enter to press.
  expect(screen.queryByLabelText('RFID tag')).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(card));
});

it('Update RFID Value opens the tag box, still showing the tag being replaced', async () => {
  render_();
  await scanAsset('10043');
  await pressUpdate();
  expect(screen.getByText('100348')).toBeTruthy();
  expect(screen.getByText('Scanning a new tag replaces the one above.')).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(tagInput()));
});

it('Cancel on the confirmation card returns to the asset step, untouched', async () => {
  const user = userEvent.setup();
  render_();
  await scanAsset('10043');
  await screen.findByRole('group', { name: 'Asset already tagged' });

  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  const el = await assetInput();
  await waitFor(() => expect(document.activeElement).toBe(el));
  expect(screen.queryByLabelText('RFID tag')).toBeNull();
  expect(api.postRfidEnroll).not.toHaveBeenCalled();
});

it('re-scanning an asset this session tagged says so, and flashes the duplicate color', async () => {
  const user = userEvent.setup();
  render_();
  await scanAsset('SN-4242');
  await user.type(tagInput(), `${FREE}{Enter}`);
  await screen.findByText(`Enrolled Rack 4 switch → ${FREE}`);
  clearFlash();

  await scanAsset('SN-4242');
  await screen.findByRole('group', { name: 'Asset already tagged' });
  expect(screen.getByText(/^This kiosk tagged it at /)).toBeTruthy();
  expect(readFlash()?.color).toBe(hslCss(DEFAULT_APPEARANCE.duplicate_scan));
  expect(sound.playScanSound).toHaveBeenLastCalledWith('duplicate');
});

it('scanning an RFID tag at the asset step says so and stays put', async () => {
  render_();
  await scanAsset('100348');       // TAGGED's tag, zero-stripped
  expect(await screen.findByText(
    "That's an RFID tag. Scan the asset's serial or ID first.",
  )).toBeTruthy();
  expect(screen.queryByLabelText('RFID tag')).toBeNull();
  expect((await assetInput()).value).toBe('');
});

it('an unknown value flashes not-found and stays on the asset step', async () => {
  render_();
  await scanAsset('nope-123');
  expect(await screen.findByText('No asset found for "nope-123".')).toBeTruthy();
  expect(readFlash()?.color).toBe(hslCss(DEFAULT_APPEARANCE.not_found_scan));
  expect(sound.playScanSound).toHaveBeenCalledWith('not_found');
  expect(screen.queryByLabelText('RFID tag')).toBeNull();
});

it('previews the padded tag as it is typed and posts the padded value', async () => {
  const user = userEvent.setup();
  writeCheckpoint('enroll', 'staged');
  render_();
  await scanAsset('SN-4242');
  await screen.findByLabelText('RFID tag');

  await user.type(tagInput(), FREE);
  expect(screen.getByText(PADDED)).toBeTruthy();

  await user.type(tagInput(), '{Enter}');
  await waitFor(() => expect(api.postRfidEnroll).toHaveBeenCalledTimes(1));
  const body = api.postRfidEnroll.mock.calls[0][0];
  expect(body).toMatchObject({
    asset_id: 'a-1',
    serial: getIdentity().serial,
    rfid_tag: PADDED,
    scan_status: 'staged',
    site_id: 'site-1',
    initiative_id: 'init-1',
  });
  expect(body.client_scan_id).toMatch(/^[0-9a-f-]{36}$/i);
});

it('defaults to the pre_stage checkpoint when the Admin tab has not set one', async () => {
  const user = userEvent.setup();
  render_();
  await scanAsset('SN-4242');
  await screen.findByLabelText('RFID tag');
  await user.type(tagInput(), `${FREE}{Enter}`);
  await waitFor(() => expect(api.postRfidEnroll).toHaveBeenCalledTimes(1));
  expect(api.postRfidEnroll.mock.calls[0][0].scan_status).toBe('pre_stage');
});

it('a saved tag flashes, sounds, toasts, updates the local roster, and returns to the asset step', async () => {
  const user = userEvent.setup();
  render_();
  await scanAsset('SN-4242');
  await screen.findByLabelText('RFID tag');
  await user.type(tagInput(), `${FREE}{Enter}`);

  expect(await screen.findByText(`Enrolled Rack 4 switch → ${FREE}`)).toBeTruthy();
  expect(readFlash()?.color).toBe(hslCss(DEFAULT_APPEARANCE.good_scan));
  expect(sound.playScanSound).toHaveBeenCalledWith('good');

  const el = await assetInput();
  await waitFor(() => expect(document.activeElement).toBe(el));
  expect(el.value).toBe('');

  await waitFor(async () => {
    const rows = await getAll<ScanAsset>('assets');
    expect(rows.find((a) => a.id === 'a-1')?.rfid).toBe(PADDED);
  });
});

it('the enrolled tag is recognized at the asset step straight away', async () => {
  const user = userEvent.setup();
  api.postRfidEnroll.mockResolvedValue(enrolled({ rfid_tag: '0'.repeat(18) + '200500' }));
  render_();
  await scanAsset('SN-4242');
  await screen.findByLabelText('RFID tag');
  await user.type(tagInput(), '200500{Enter}');
  await screen.findByText('Enrolled Rack 4 switch → 200500');

  // The roster in hand now knows the tag, so scanning it is the "that's
  // an RFID tag" case rather than a miss.
  await scanAsset('200500');
  expect(await screen.findByText(
    "That's an RFID tag. Scan the asset's serial or ID first.",
  )).toBeTruthy();
});

it('a tag the synced roster has on another asset never reaches the portal', async () => {
  const user = userEvent.setup();
  render_();
  await scanAsset('SN-4242');
  await screen.findByLabelText('RFID tag');
  await user.type(tagInput(), '100348{Enter}');      // Patch panel's tag

  expect(await screen.findByText('That tag is already on Patch panel.')).toBeTruthy();
  expect(api.postRfidEnroll).not.toHaveBeenCalled();
  const el = tagInput();
  expect(el.value).toBe('');
  await waitFor(() => expect(document.activeElement).toBe(el));
  expect(readFlash()?.color).toBe(hslCss(DEFAULT_APPEARANCE.not_found_scan));

  const rows = await getAll<ScanAsset>('assets');
  expect(rows.find((a) => a.id === 'a-1')?.rfid).toBeNull();
});

it("scanning the asset's own barcode into the tag box is refused by name", async () => {
  const user = userEvent.setup();
  render_();
  await scanAsset('SN-4242');
  await screen.findByLabelText('RFID tag');

  await user.type(tagInput(), '10042{Enter}');       // its own asset ID
  expect(await screen.findByText(
    "That's this asset's own asset ID, not an RFID tag.",
  )).toBeTruthy();
  expect(api.postRfidEnroll).not.toHaveBeenCalled();

  await user.type(tagInput(), '10043{Enter}');       // and another asset's
  expect(await screen.findByText(
    "That's the asset ID for Patch panel, not an RFID tag.",
  )).toBeTruthy();
  expect(api.postRfidEnroll).not.toHaveBeenCalled();
});

it('a tag the kiosk did not know about is refused by the portal, then locally', async () => {
  const user = userEvent.setup();
  api.postRfidEnroll.mockRejectedValue(new ApiError(409, 'rfid_in_use', {
    code: 'rfid_in_use', asset_id: 'a-9', asset_name: 'Rack 9 PDU',
  }));
  render_();
  await scanAsset('SN-4242');
  await screen.findByLabelText('RFID tag');
  await user.type(tagInput(), '777123{Enter}');

  expect(await screen.findByText('That tag is already on Rack 9 PDU.')).toBeTruthy();
  expect(api.postRfidEnroll).toHaveBeenCalledTimes(1);

  // The refusal is remembered: the same tag again costs no round trip.
  await user.type(tagInput(), '777123{Enter}');
  expect(await screen.findByText('That tag is already on Rack 9 PDU.')).toBeTruthy();
  expect(api.postRfidEnroll).toHaveBeenCalledTimes(1);
});

it('an unreachable portal says the tag was not saved', async () => {
  const user = userEvent.setup();
  api.postRfidEnroll.mockRejectedValue(new ApiError(0, 'network'));
  render_();
  await scanAsset('SN-4242');
  await screen.findByLabelText('RFID tag');
  await user.type(tagInput(), `${FREE}{Enter}`);
  expect(await screen.findByText(
    "Can't reach the portal. The tag was not saved.",
  )).toBeTruthy();
});

it('read-only mode says to try again shortly', async () => {
  const user = userEvent.setup();
  api.postRfidEnroll.mockRejectedValue(new ApiError(423, 'read_only_mode'));
  render_();
  await scanAsset('SN-4242');
  await screen.findByLabelText('RFID tag');
  await user.type(tagInput(), `${FREE}{Enter}`);
  expect(await screen.findByText(
    'The portal is in read-only mode. Try again shortly.',
  )).toBeTruthy();
});

it('a tag that is too long or not alphanumeric is refused before the portal is called', async () => {
  const user = userEvent.setup();
  render_();
  await scanAsset('SN-4242');
  await screen.findByLabelText('RFID tag');

  await user.type(tagInput(), `${'1'.repeat(25)}{Enter}`);
  expect(await screen.findByText('That tag is longer than 24 characters.')).toBeTruthy();
  expect(api.postRfidEnroll).not.toHaveBeenCalled();

  await user.clear(tagInput());
  await user.type(tagInput(), 'E200-4321{Enter}');
  expect(await screen.findByText(
    "That tag has characters we can't store — letters and numbers only.",
  )).toBeTruthy();
  expect(api.postRfidEnroll).not.toHaveBeenCalled();
});

it('Cancel returns to the asset step with nothing saved', async () => {
  const user = userEvent.setup();
  render_();
  await scanAsset('SN-4242');
  await screen.findByLabelText('RFID tag');

  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  const el = await assetInput();
  await waitFor(() => expect(document.activeElement).toBe(el));
  expect(screen.queryByLabelText('RFID tag')).toBeNull();
  expect(api.postRfidEnroll).not.toHaveBeenCalled();
});

it('shows no session list before the first enrollment', async () => {
  render_();
  await assetInput();
  expect(screen.queryByRole('table')).toBeNull();
});

it('a saved enrollment appears in the session list with name, serial, and the trimmed tag', async () => {
  const user = userEvent.setup();
  render_();
  await scanAsset('SN-4242');
  await screen.findByLabelText('RFID tag');
  await user.type(tagInput(), `${FREE}{Enter}`);
  await screen.findByText(`Enrolled Rack 4 switch → ${FREE}`);

  const table = await screen.findByRole('table');
  const row = within(table).getByText('Rack 4 switch').closest('tr');
  expect(row).toBeTruthy();
  expect(within(row as HTMLElement).getByText('SN-4242')).toBeTruthy();
  const tagCell = within(row as HTMLElement).getByText(FREE);
  expect(tagCell.title).toBe(PADDED);
});

it('a second enrollment appears above the first, newest first', async () => {
  const user = userEvent.setup();
  api.postRfidEnroll
    .mockResolvedValueOnce(enrolled())
    .mockResolvedValueOnce({
      asset_id: TAGGED.id,
      asset_name: TAGGED.name,
      asset_tag: TAGGED.asset_id,
      serial_number: TAGGED.serial_number,
      rfid_tag: `${'0'.repeat(18)}200500`,
      already_had_tag: false,
    });
  render_();
  await scanAsset('SN-4242');
  await screen.findByLabelText('RFID tag');
  await user.type(tagInput(), `${FREE}{Enter}`);
  await screen.findByText(`Enrolled Rack 4 switch → ${FREE}`);

  await scanAsset('10043');
  await pressUpdate();
  await user.type(tagInput(), '200500{Enter}');
  await screen.findByText('Enrolled Patch panel → 200500');

  const table = await screen.findByRole('table');
  const rows = within(table).getAllByRole('row').slice(1); // drop the header row
  expect(within(rows[0]).getByText('Patch panel')).toBeTruthy();
  expect(within(rows[1]).getByText('Rack 4 switch')).toBeTruthy();
});

it('enrolling a new tag onto an asset that already had one shows a replaced chip', async () => {
  const user = userEvent.setup();
  api.postRfidEnroll.mockResolvedValue({
    asset_id: TAGGED.id,
    asset_name: TAGGED.name,
    asset_tag: TAGGED.asset_id,
    serial_number: TAGGED.serial_number,
    rfid_tag: `${'0'.repeat(18)}200500`,
    already_had_tag: false,
  });
  render_();
  await scanAsset('10043');
  await pressUpdate();
  await user.type(tagInput(), '200500{Enter}');
  await screen.findByText('Enrolled Patch panel → 200500');

  const table = await screen.findByRole('table');
  const row = within(table).getByText('Patch panel').closest('tr');
  expect(within(row as HTMLElement).getByText('replaced')).toBeTruthy();
});

it('a failed save adds no row to the session list', async () => {
  const user = userEvent.setup();
  api.postRfidEnroll.mockRejectedValue(new ApiError(0, 'network'));
  render_();
  await scanAsset('SN-4242');
  await screen.findByLabelText('RFID tag');
  await user.type(tagInput(), `${FREE}{Enter}`);
  await screen.findByText("Can't reach the portal. The tag was not saved.");
  expect(screen.queryByRole('table')).toBeNull();
});

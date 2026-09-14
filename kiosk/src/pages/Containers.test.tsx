// @vitest-environment jsdom
/** Containers against a real (fake) IndexedDB and a stubbed pack/unpack
 *  endpoint: finding the crate, the header card and its live count, what
 *  Pack and Unpack send, the moved-from note, and what a refusal says. */
import 'fake-indexeddb/auto';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IDBFactory } from 'fake-indexeddb';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ postContainerAsset: vi.fn() }));
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
import type { ContainerRow } from '../lib/containerMatch';
import { clearFlash, readFlash } from '../lib/flash';
import { getIdentity } from '../lib/identity';
import { writeKioskSetup } from '../lib/kioskSetup';
import { closeDb, replaceAll } from '../lib/localDb';
import type { ScanAsset } from '../lib/scanMatch';
import Containers from './Containers';

const CRATE: ContainerRow = {
  id: 'c-1', name: 'SC-DAL_PAL-001', rfid_tag: '0'.repeat(18) + '100348',
  label_tag: 'priority', container_type: 'shipping_container', status: 'available',
  status_label: 'Available', site_id: 'site-1', site_name: 'ACC4', asset_count: 2,
};
const CRATE_2: ContainerRow = {
  ...CRATE, id: 'c-2', name: 'SC-DAL_PAL-002', rfid_tag: null, label_tag: null,
  asset_count: 0,
};

const SWITCH: ScanAsset = {
  id: 'a-1', asset_id: '10042', name: 'Rack 4 switch', rfid: null,
  serial_number: 'SN-4242', make: 'Cisco', model: 'Nexus 9000',
  make_model: 'Cisco Nexus 9000',
};
const PANEL: ScanAsset = {
  id: 'a-2', asset_id: '10043', name: 'Patch panel', rfid: '0'.repeat(20) + 'ABCD',
  serial_number: 'FDO2140X9ZZ', make: null, model: null, make_model: '',
};

const SETUP = {
  initiativeId: 'init-1', initiativeName: 'NAP11 Hall Migration',
  siteId: 'site-1', siteName: 'ACC4', siteRole: 'source' as const,
  scanStatus: 'cage_exit', scanLabel: 'RFID 1 - Cage Exit',
};

const packed = (over: Record<string, unknown> = {}) => ({
  container: { id: CRATE.id, name: CRATE.name, asset_count: 3 },
  asset: {
    id: SWITCH.id, name: SWITCH.name, asset_tag: SWITCH.asset_id,
    serial_number: SWITCH.serial_number, rfid: null,
  },
  action: 'pack',
  moved_from: null,
  already_there: false,
  ...over,
});

const render_ = () => render(<MemoryRouter><Containers /></MemoryRouter>);

beforeEach(async () => {
  localStorage.clear();
  closeDb();
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  await replaceAll('containers', [CRATE, CRATE_2]);
  await replaceAll('assets', [SWITCH, PANEL]);
  writeKioskSetup(SETUP);
  api.postContainerAsset.mockReset().mockResolvedValue(packed());
});

afterEach(() => { cleanup(); clearFlash(); vi.clearAllMocks(); });

/** The container box is disabled until the crates are read out of
 *  IndexedDB, and a scanner typing into a disabled input is simply
 *  dropped — so every typing test waits for it first. */
async function containerInput(): Promise<HTMLInputElement> {
  const el = await screen.findByLabelText('Container tag or name') as HTMLInputElement;
  await waitFor(() => expect(el.disabled).toBe(false));
  return el;
}

async function scanContainer(value: string): Promise<void> {
  const user = userEvent.setup();
  const el = await containerInput();
  await user.type(el, `${value}{Enter}`);
}

const assetInput = () => screen.getByLabelText('Asset tag, ID, or serial') as HTMLInputElement;

async function scanAsset(value: string): Promise<void> {
  const user = userEvent.setup();
  await user.type(assetInput(), `${value}{Enter}`);
}

const count = () => screen.getByTestId('container-asset-count').textContent;

it('opens on the container step with that input focused and empty', async () => {
  render_();
  const el = await containerInput();
  await waitFor(() => expect(document.activeElement).toBe(el));
  expect(el.value).toBe('');
  expect(el.getAttribute('placeholder')).toBe('Scan a container tag or type its name');
  expect(screen.queryByLabelText('Asset tag, ID, or serial')).toBeNull();
});

it('a container RFID advances to the asset step with the card and its count', async () => {
  render_();
  await scanContainer('100348');            // the same tag without its padding

  const el = await screen.findByLabelText('Asset tag, ID, or serial');
  await waitFor(() => expect(document.activeElement).toBe(el));
  expect(screen.getByText('SC-DAL_PAL-001')).toBeTruthy();
  expect(screen.getByText('shipping_container')).toBeTruthy();
  expect(screen.getByText('Available')).toBeTruthy();
  expect(screen.getByText('ACC4')).toBeTruthy();
  expect(count()).toBe('2');
  expect(screen.queryByLabelText('Container tag or name')).toBeNull();
});

it('an exact name works too, and an ambiguous partial offers a tappable list', async () => {
  const user = userEvent.setup();
  render_();
  await scanContainer('sc-dal_pal');        // both crates share the prefix

  expect(screen.queryByLabelText('Asset tag, ID, or serial')).toBeNull();
  const choices = screen.getAllByRole('button');
  expect(choices.map((b) => b.textContent)).toEqual([
    expect.stringContaining('SC-DAL_PAL-001'),
    expect.stringContaining('SC-DAL_PAL-002'),
  ]);

  await user.click(choices[1]);
  expect(await screen.findByLabelText('Asset tag, ID, or serial')).toBeTruthy();
  expect(screen.getByText('SC-DAL_PAL-002')).toBeTruthy();
  expect(count()).toBe('0');
});

it('a container that matches nothing flashes and names the value', async () => {
  render_();
  await scanContainer('NOT-A-CRATE');

  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent', 'No container found for "NOT-A-CRATE".');
  expect(readFlash()?.color).toBe(hslCss(DEFAULT_APPEARANCE.not_found_scan));
  expect(sound.playScanSound).toHaveBeenCalledWith('not_found');
  expect(screen.queryByLabelText('Asset tag, ID, or serial')).toBeNull();
});

it('Pack sends the pack checkpoint and the setup\'s site and move, flashes, counts, and lists', async () => {
  writeCheckpoint('containerPack', 'in_container');
  render_();
  await scanContainer('SC-DAL_PAL-001');
  await scanAsset('sn-4242');

  await waitFor(() => expect(api.postContainerAsset).toHaveBeenCalledTimes(1));
  expect(api.postContainerAsset.mock.calls[0][0]).toMatchObject({
    container_id: 'c-1',
    serial: getIdentity().serial,
    asset_id: 'a-1',
    action: 'pack',
    scanned_value: 'sn-4242',
    scan_type: 'barcode',
    scan_status: 'in_container',
    site_id: 'site-1',
    initiative_id: 'init-1',
  });
  expect(api.postContainerAsset.mock.calls[0][0].client_scan_id).toBeTruthy();

  await waitFor(() => expect(count()).toBe('3'));
  expect(readFlash()?.color).toBe(hslCss(DEFAULT_APPEARANCE.good_scan));
  expect(sound.playScanSound).toHaveBeenCalledWith('good');

  const row = within(screen.getByRole('table')).getAllByRole('row')[1];
  expect(row.textContent).toContain('Rack 4 switch');
  expect(row.textContent).toContain('SN-4242');
  expect(row.textContent).toContain('Pack');
  expect(assetInput().value).toBe('');
});

it('a moved_from answer shows the note on that row', async () => {
  api.postContainerAsset.mockResolvedValue(packed({
    moved_from: { id: 'c-2', name: 'SC-DAL_PAL-002' },
  }));
  render_();
  await scanContainer('SC-DAL_PAL-001');
  await scanAsset('10042');

  expect(await screen.findByText('moved from SC-DAL_PAL-002')).toBeTruthy();
  // Matched on the asset ID, so the scan says so.
  expect(api.postContainerAsset.mock.calls[0][0]).toMatchObject({
    scanned_value: '10042', scan_type: 'barcode',
  });
});

it('an RFID scan of an asset is a legitimate way to name it here', async () => {
  render_();
  await scanContainer('SC-DAL_PAL-001');
  await scanAsset('ABCD');

  await waitFor(() => expect(api.postContainerAsset).toHaveBeenCalledTimes(1));
  expect(api.postContainerAsset.mock.calls[0][0]).toMatchObject({
    asset_id: 'a-2', scanned_value: 'ABCD', scan_type: 'rfid',
  });
});

it('switching to Unpack clears the box and sends the unpack checkpoint', async () => {
  const user = userEvent.setup();
  writeCheckpoint('containerUnpack', 'un_pack');
  api.postContainerAsset.mockResolvedValue(packed({
    action: 'unpack', container: { id: 'c-1', name: CRATE.name, asset_count: 1 },
  }));
  render_();
  await scanContainer('SC-DAL_PAL-001');

  await user.type(assetInput(), 'half-typed');
  const toggle = screen.getByRole('radiogroup', { name: 'Pack or unpack' });
  const unpack = within(toggle).getByRole('radio', { name: 'Unpack' });
  expect(within(toggle).getByRole('radio', { name: 'Pack' }).getAttribute('aria-checked')).toBe('true');

  await user.click(unpack);
  expect(unpack.getAttribute('aria-checked')).toBe('true');
  expect(assetInput().value).toBe('');
  await waitFor(() => expect(document.activeElement).toBe(assetInput()));

  await scanAsset('sn-4242');
  await waitFor(() => expect(api.postContainerAsset).toHaveBeenCalledTimes(1));
  expect(api.postContainerAsset.mock.calls[0][0]).toMatchObject({
    action: 'unpack', scan_status: 'un_pack',
  });
  await waitFor(() => expect(count()).toBe('1'));
  expect(within(screen.getByRole('table')).getAllByRole('row')[1].textContent)
    .toContain('Unpack');
});

it('not_in_container says which crate holds it, and adds no row', async () => {
  api.postContainerAsset.mockRejectedValue(new ApiError(409, 'not_in_container', {
    code: 'not_in_container', container_id: 'c-2', container_name: 'SC-DAL_PAL-002',
  }));
  render_();
  await scanContainer('SC-DAL_PAL-001');
  await scanAsset('sn-4242');

  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent', 'That asset is in SC-DAL_PAL-002, not this container.');
  expect(readFlash()?.color).toBe(hslCss(DEFAULT_APPEARANCE.not_found_scan));
  expect(sound.playScanSound).toHaveBeenCalledWith('not_found');
  expect(screen.queryByRole('table')).toBeNull();
  expect(count()).toBe('2');       // the count did not move
});

it('an asset the kiosk does not know never reaches the portal', async () => {
  render_();
  await scanContainer('SC-DAL_PAL-001');
  await scanAsset('NOPE-123');

  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent', 'No asset found for "NOPE-123".');
  expect(api.postContainerAsset).not.toHaveBeenCalled();
});

it('maps the portal\'s other refusals to their own copy', async () => {
  const cases: [ApiError, string][] = [
    [new ApiError(404, 'container_not_found'), 'That container is gone — scan it again.'],
    [new ApiError(423, 'read_only_mode'), 'The portal is in read-only mode. Try again shortly.'],
    [new ApiError(0, 'network'), "Can't reach the portal. That scan was not recorded."],
    [new ApiError(500, 'server_error'), "Couldn't record that (server_error)."],
  ];
  for (const [err, text] of cases) {
    api.postContainerAsset.mockReset().mockRejectedValue(err);
    render_();
    // eslint-disable-next-line no-await-in-loop -- each case is its own render
    await scanContainer('SC-DAL_PAL-001');
    // eslint-disable-next-line no-await-in-loop
    await scanAsset('sn-4242');
    // eslint-disable-next-line no-await-in-loop
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', text);
    cleanup();
  }
});

it('Done returns to the container step with everything cleared', async () => {
  const user = userEvent.setup();
  render_();
  await scanContainer('SC-DAL_PAL-001');
  await scanAsset('sn-4242');
  await waitFor(() => expect(count()).toBe('3'));

  await user.click(screen.getByRole('button', { name: 'Done' }));

  const el = await containerInput();
  await waitFor(() => expect(document.activeElement).toBe(el));
  expect(el.value).toBe('');
  expect(screen.queryByTestId('container-asset-count')).toBeNull();
  expect(screen.queryByLabelText('Asset tag, ID, or serial')).toBeNull();
  // The list goes too: it is this crate's context, and leaving it under
  // the next crate's card would read as "these are in here".
  expect(screen.queryByRole('table')).toBeNull();
});

it('says so when this kiosk has no containers downloaded', async () => {
  await replaceAll('containers', []);
  render_();
  expect(await screen.findByText('No containers on this kiosk. Sync them from Kiosk Setup.'))
    .toBeTruthy();
  expect((await screen.findByLabelText('Container tag or name') as HTMLInputElement).disabled)
    .toBe(true);
});

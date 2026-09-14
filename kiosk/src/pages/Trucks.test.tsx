// @vitest-environment jsdom
/** Trucks against a real (fake) IndexedDB and a stubbed load/unload
 *  endpoint: the step-one card picker and its filter, the header card and
 *  its live container count, what Load and Unload send, resolving an
 *  asset through to its container, the moved-from note, and what a
 *  refusal says. */
import 'fake-indexeddb/auto';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IDBFactory } from 'fake-indexeddb';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ postTruckContainer: vi.fn() }));
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
import type { TruckRow } from '../lib/truckMatch';
import Trucks from './Trucks';

const TRUCK: TruckRow = {
  id: 't-1', name: 'TRUCK-1', load_number: 'L-1042', status: 'in_transit',
  status_label: 'In Transit', driver_name: 'Dana Driver',
  start_site_id: 's-1', start_site_name: 'NAP11',
  end_site_id: 's-2', end_site_name: 'ACC4', container_count: 2,
};
const TRUCK_2: TruckRow = {
  ...TRUCK, id: 't-2', name: 'TRUCK-2', load_number: 'L-1043',
  driver_name: null, container_count: 0,
};
const SPARE: TruckRow = {
  ...TRUCK_2, id: 't-3', name: 'Spare Trailer', load_number: null,
};

const CRATE: ContainerRow = {
  id: 'c-1', name: 'SC-DAL_PAL-001', rfid_tag: '0'.repeat(18) + '100348',
  label_tag: 'priority', container_type: 'shipping_container', status: 'available',
  status_label: 'Available', site_id: 's-1', site_name: 'NAP11', asset_count: 4,
};
const CRATE_2: ContainerRow = {
  ...CRATE, id: 'c-2', name: 'SC-DAL_PAL-002', rfid_tag: null, label_tag: null,
  asset_count: 0,
};

/** Packed in CRATE — the "scan an asset, load its crate" path. */
const SWITCH: ScanAsset = {
  id: 'a-1', asset_id: '10042', name: 'Rack 4 switch', rfid: null,
  serial_number: 'SN-4242', make: 'Cisco', model: 'Nexus 9000',
  make_model: 'Cisco Nexus 9000', container_id: 'c-1',
} as ScanAsset;
/** In no container at all — the "pack it first" path. */
const LOOSE: ScanAsset = {
  id: 'a-2', asset_id: '10043', name: 'Loose panel', rfid: '0'.repeat(20) + 'ABCD',
  serial_number: 'FDO2140X9ZZ', make: null, model: null, make_model: '',
} as ScanAsset;

const SETUP = {
  initiativeId: 'init-1', initiativeName: 'NAP11 Hall Migration',
  siteId: 'site-1', siteName: 'ACC4', siteRole: 'source' as const,
  scanStatus: 'cage_exit', scanLabel: 'RFID 1 - Cage Exit',
};

const loaded = (over: Record<string, unknown> = {}) => ({
  truck: { id: TRUCK.id, name: TRUCK.name, container_count: 3 },
  container: { id: CRATE.id, name: CRATE.name, asset_count: 4 },
  action: 'load',
  moved_from: null,
  already_there: false,
  ...over,
});

const render_ = () => render(<MemoryRouter><Trucks /></MemoryRouter>);

beforeEach(async () => {
  localStorage.clear();
  closeDb();
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  await replaceAll('trucks', [TRUCK, TRUCK_2, SPARE]);
  await replaceAll('containers', [CRATE, CRATE_2]);
  await replaceAll('assets', [SWITCH, LOOSE]);
  writeKioskSetup(SETUP);
  api.postTruckContainer.mockReset().mockResolvedValue(loaded());
});

afterEach(() => { cleanup(); clearFlash(); vi.clearAllMocks(); });

/** The filter box is disabled until the trucks are read out of
 *  IndexedDB, so every typing test waits for it first. */
async function filterInput(): Promise<HTMLInputElement> {
  const el = await screen.findByLabelText('Filter trucks') as HTMLInputElement;
  await waitFor(() => expect(el.disabled).toBe(false));
  return el;
}

const truckCards = () => screen.getAllByRole('option');

async function pickTruck(name: string): Promise<void> {
  const user = userEvent.setup();
  await filterInput();
  await user.click(screen.getByRole('option', { name: new RegExp(name) }));
}

const scanBox = () => screen.getByLabelText('Container tag or asset') as HTMLInputElement;

async function scan(value: string): Promise<void> {
  const user = userEvent.setup();
  await user.type(scanBox(), `${value}{Enter}`);
}

const count = () => screen.getByTestId('truck-container-count').textContent;

it('opens on the truck picker with one card per synced truck and the filter focused', async () => {
  render_();
  const el = await filterInput();
  await waitFor(() => expect(document.activeElement).toBe(el));
  expect(truckCards()).toHaveLength(3);
  const first = truckCards()[0];
  expect(first.textContent).toContain('TRUCK-1');
  expect(first.textContent).toContain('L-1042');
  expect(first.textContent).toContain('In Transit');
  expect(first.textContent).toContain('Dana Driver');
  expect(first.textContent).toContain('NAP11 → ACC4');
  expect(first.textContent).toContain('2 containers');
  expect(screen.queryByLabelText('Container tag or asset')).toBeNull();
});

it('the filter narrows the cards by name or load number', async () => {
  const user = userEvent.setup();
  render_();
  const el = await filterInput();

  await user.type(el, 'trailer');
  expect(truckCards().map((c) => c.textContent)).toEqual([
    expect.stringContaining('Spare Trailer'),
  ]);

  await user.clear(el);
  await user.type(el, '1043');
  expect(truckCards().map((c) => c.textContent)).toEqual([
    expect.stringContaining('TRUCK-2'),
  ]);

  await user.clear(el);
  await user.type(el, 'nothing here');
  expect(screen.queryAllByRole('option')).toHaveLength(0);
});

it('typing an exact name or load number and pressing Enter selects that truck', async () => {
  const user = userEvent.setup();
  render_();
  const el = await filterInput();

  await user.type(el, 'l-1043{Enter}');
  expect(await screen.findByLabelText('Container tag or asset')).toBeTruthy();
  expect(screen.getByText('TRUCK-2')).toBeTruthy();
});

it('picking a truck shows its header card and live container count', async () => {
  render_();
  await pickTruck('TRUCK-1');

  const el = await screen.findByLabelText('Container tag or asset');
  await waitFor(() => expect(document.activeElement).toBe(el));
  expect(el.getAttribute('placeholder')).toBe('Scan a container, or an asset inside one');
  expect(screen.getByText('TRUCK-1')).toBeTruthy();
  expect(screen.getByText('L-1042')).toBeTruthy();
  expect(screen.getByText('In Transit')).toBeTruthy();
  expect(screen.getByText('NAP11 → ACC4')).toBeTruthy();
  expect(count()).toBe('2');
  expect(screen.queryByLabelText('Filter trucks')).toBeNull();
});

it('Load sends the load checkpoint and the setup\'s site and move, flashes, counts, and lists', async () => {
  writeCheckpoint('truckLoad', 'on_truck');
  render_();
  await pickTruck('TRUCK-1');
  await scan('SC-DAL_PAL-001');

  await waitFor(() => expect(api.postTruckContainer).toHaveBeenCalledTimes(1));
  expect(api.postTruckContainer.mock.calls[0][0]).toMatchObject({
    truck_id: 't-1',
    serial: getIdentity().serial,
    container_id: 'c-1',
    action: 'load',
    scanned_value: 'SC-DAL_PAL-001',
    scan_type: 'barcode',
    scan_status: 'on_truck',
    site_id: 'site-1',
    initiative_id: 'init-1',
  });
  expect(api.postTruckContainer.mock.calls[0][0].client_scan_id).toBeTruthy();

  await waitFor(() => expect(count()).toBe('3'));
  expect(readFlash()?.color).toBe(hslCss(DEFAULT_APPEARANCE.good_scan));
  expect(sound.playScanSound).toHaveBeenCalledWith('good');

  const row = within(screen.getByRole('table')).getAllByRole('row')[1];
  expect(row.textContent).toContain('SC-DAL_PAL-001');
  expect(row.textContent).toContain('4');
  expect(row.textContent).toContain('Load');
  expect(scanBox().value).toBe('');
});

it('an asset scan resolves through to its container and says so on the row', async () => {
  render_();
  await pickTruck('TRUCK-1');
  await scan('sn-4242');

  await waitFor(() => expect(api.postTruckContainer).toHaveBeenCalledTimes(1));
  // The crate is what moves; the scan still carries what was read.
  expect(api.postTruckContainer.mock.calls[0][0]).toMatchObject({
    container_id: 'c-1', scanned_value: 'sn-4242', scan_type: 'barcode',
  });
  expect(await screen.findByText('via asset Rack 4 switch')).toBeTruthy();
});

it('an asset in no container is refused on the kiosk, and nothing is sent', async () => {
  render_();
  await pickTruck('TRUCK-1');
  await scan('ABCD');

  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent', "That asset isn't in a container yet — pack it first.");
  expect(readFlash()?.color).toBe(hslCss(DEFAULT_APPEARANCE.not_found_scan));
  expect(sound.playScanSound).toHaveBeenCalledWith('not_found');
  expect(api.postTruckContainer).not.toHaveBeenCalled();
});

it('a value matching nothing at all flashes and names it', async () => {
  render_();
  await pickTruck('TRUCK-1');
  await scan('NOPE-123');

  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent', 'No container or asset found for "NOPE-123".');
  expect(api.postTruckContainer).not.toHaveBeenCalled();
});

it('a moved_from answer shows the note on that row', async () => {
  api.postTruckContainer.mockResolvedValue(loaded({
    moved_from: { id: 't-2', name: 'TRUCK-2' },
  }));
  render_();
  await pickTruck('TRUCK-1');
  await scan('100348');                     // the crate's tag without its padding

  expect(await screen.findByText('moved from TRUCK-2')).toBeTruthy();
  expect(api.postTruckContainer.mock.calls[0][0]).toMatchObject({
    container_id: 'c-1', scan_type: 'rfid',
  });
});

/* ── a repeat scan: nothing happened ──────────────────────────────── */

/** A crate rides one truck, so loading it where it already is changes
 *  nothing. The count the duplicate answer carries is deliberately wrong
 *  so the header proves it does not move on a no-op. */
const again = (over: Record<string, unknown> = {}) => loaded({
  already_there: true,
  truck: { id: TRUCK.id, name: TRUCK.name, container_count: 99 },
  ...over,
});

const rowsOf = () => within(screen.getByRole('table')).getAllByRole('row').slice(1);

it('a repeat load flashes amber, sounds different, and marks the row instead of adding one', async () => {
  api.postTruckContainer.mockReset()
    .mockResolvedValueOnce(loaded())
    .mockResolvedValue(again());
  render_();
  await pickTruck('TRUCK-1');
  await scan('SC-DAL_PAL-001');
  await waitFor(() => expect(count()).toBe('3'));

  await scan('SC-DAL_PAL-001');

  expect(await screen.findByRole('status')).toHaveProperty(
    'textContent', 'SC-DAL_PAL-001 is already on this truck.');
  expect(readFlash()?.color).toBe(hslCss(DEFAULT_APPEARANCE.duplicate_scan));
  expect(readFlash()?.ms).toBe(DEFAULT_APPEARANCE.flash_ms);
  expect(sound.playScanSound).toHaveBeenLastCalledWith('duplicate');

  const rows = rowsOf();
  expect(rows).toHaveLength(1);
  expect(rows[0].textContent).toContain('Load');
  expect(rows[0].textContent).toContain('scanned again');
  expect(rows[0].textContent).not.toContain('×');
  expect(count()).toBe('3');            // nothing happened, so nothing moved
});

it('a third scan of the same container counts the repeats', async () => {
  api.postTruckContainer.mockReset()
    .mockResolvedValueOnce(loaded())
    .mockResolvedValue(again());
  render_();
  await pickTruck('TRUCK-1');
  await scan('SC-DAL_PAL-001');
  await waitFor(() => expect(count()).toBe('3'));

  await scan('SC-DAL_PAL-001');
  expect(await screen.findByText('scanned again')).toBeTruthy();
  await scan('SC-DAL_PAL-001');

  expect(await screen.findByText('scanned again ×2')).toBeTruthy();
  expect(rowsOf()).toHaveLength(1);
  expect(count()).toBe('3');
});

it('a repeat for a container with no row of its own lists it as already on', async () => {
  api.postTruckContainer.mockReset().mockResolvedValue(again());
  render_();
  await pickTruck('TRUCK-1');
  await scan('SC-DAL_PAL-001');

  expect(await screen.findByRole('status')).toHaveProperty(
    'textContent', 'SC-DAL_PAL-001 is already on this truck.');
  const rows = rowsOf();
  expect(rows).toHaveLength(1);
  expect(rows[0].textContent).toContain('SC-DAL_PAL-001');
  expect(rows[0].textContent).toContain('already on');
  expect(rows[0].textContent).not.toContain('Load');
  expect(count()).toBe('2');            // the header never moved
});

it('an asset whose crate is already aboard is the same nothing-happened event', async () => {
  api.postTruckContainer.mockReset().mockResolvedValue(again());
  render_();
  await pickTruck('TRUCK-1');
  await scan('sn-4242');                // the asset, not the crate

  expect(await screen.findByRole('status')).toHaveProperty(
    'textContent', 'SC-DAL_PAL-001 is already on this truck.');
  const rows = rowsOf();
  expect(rows).toHaveLength(1);
  expect(rows[0].textContent).toContain('already on');
  // The row still says how the crate was named, because that is what
  // the operator actually scanned.
  expect(within(rows[0]).getByText('via asset Rack 4 switch')).toBeTruthy();
  expect(count()).toBe('2');
});

it('switching to Unload clears the box and sends the unload checkpoint', async () => {
  const user = userEvent.setup();
  writeCheckpoint('truckUnload', 'received');
  api.postTruckContainer.mockResolvedValue(loaded({
    action: 'unload', truck: { id: 't-1', name: TRUCK.name, container_count: 1 },
  }));
  render_();
  await pickTruck('TRUCK-1');

  await user.type(scanBox(), 'half-typed');
  const toggle = screen.getByRole('radiogroup', { name: 'Load or unload' });
  const unload = within(toggle).getByRole('radio', { name: 'Unload' });
  expect(within(toggle).getByRole('radio', { name: 'Load' }).getAttribute('aria-checked')).toBe('true');

  await user.click(unload);
  expect(unload.getAttribute('aria-checked')).toBe('true');
  expect(scanBox().value).toBe('');
  await waitFor(() => expect(document.activeElement).toBe(scanBox()));

  await scan('SC-DAL_PAL-001');
  await waitFor(() => expect(api.postTruckContainer).toHaveBeenCalledTimes(1));
  expect(api.postTruckContainer.mock.calls[0][0]).toMatchObject({
    action: 'unload', scan_status: 'received',
  });
  await waitFor(() => expect(count()).toBe('1'));
  expect(within(screen.getByRole('table')).getAllByRole('row')[1].textContent)
    .toContain('Unload');
});

it('not_on_truck says which truck has it, and adds no row', async () => {
  api.postTruckContainer.mockRejectedValue(new ApiError(409, 'not_on_truck', {
    code: 'not_on_truck', truck_id: 't-2', truck_name: 'TRUCK-2',
  }));
  render_();
  await pickTruck('TRUCK-1');
  await scan('SC-DAL_PAL-001');

  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent', 'That container is on TRUCK-2, not this truck.');
  expect(readFlash()?.color).toBe(hslCss(DEFAULT_APPEARANCE.not_found_scan));
  expect(screen.queryByRole('table')).toBeNull();
  expect(count()).toBe('2');       // the count did not move
});

it('not_on_truck with no truck named says so instead', async () => {
  api.postTruckContainer.mockRejectedValue(new ApiError(409, 'not_on_truck', {
    code: 'not_on_truck',
  }));
  render_();
  await pickTruck('TRUCK-1');
  await scan('SC-DAL_PAL-001');

  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent', "That container isn't on a truck.");
});

it('maps the portal\'s other refusals to their own copy', async () => {
  const cases: [ApiError, string][] = [
    [new ApiError(404, 'container_not_found'), 'That container is gone — scan it again.'],
    [new ApiError(404, 'truck_not_found'), 'That truck is gone — pick it again.'],
    [new ApiError(423, 'read_only_mode'), 'The portal is in read-only mode. Try again shortly.'],
    [new ApiError(0, 'network'), "Can't reach the portal. That scan was not recorded."],
    [new ApiError(500, 'server_error'), "Couldn't record that (server_error)."],
  ];
  for (const [err, text] of cases) {
    api.postTruckContainer.mockReset().mockRejectedValue(err);
    render_();
    // eslint-disable-next-line no-await-in-loop -- each case is its own render
    await pickTruck('TRUCK-1');
    // eslint-disable-next-line no-await-in-loop
    await scan('SC-DAL_PAL-001');
    // eslint-disable-next-line no-await-in-loop
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', text);
    cleanup();
  }
});

it('Done returns to the truck picker with everything cleared', async () => {
  const user = userEvent.setup();
  render_();
  await pickTruck('TRUCK-1');
  await scan('SC-DAL_PAL-001');
  await waitFor(() => expect(count()).toBe('3'));

  await user.click(screen.getByRole('button', { name: 'Done' }));

  const el = await filterInput();
  await waitFor(() => expect(document.activeElement).toBe(el));
  expect(el.value).toBe('');
  expect(truckCards()).toHaveLength(3);
  expect(screen.queryByTestId('truck-container-count')).toBeNull();
  expect(screen.queryByLabelText('Container tag or asset')).toBeNull();
  // The list goes too: it is this truck's context, and leaving it under
  // the next truck's card would read as "these are on it".
  expect(screen.queryByRole('table')).toBeNull();
});

it('says so when this kiosk has no trucks downloaded', async () => {
  await replaceAll('trucks', []);
  render_();
  expect(await screen.findByText(
    'No trucks on this move. Ask a coordinator to add one.')).toBeTruthy();
  expect((await screen.findByLabelText('Filter trucks') as HTMLInputElement).disabled).toBe(true);
});

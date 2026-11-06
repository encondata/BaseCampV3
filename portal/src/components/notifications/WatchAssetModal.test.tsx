// @vitest-environment jsdom
/**
 * WatchAssetModal — "Watch…" on an asset: choose Next update or Status becomes (a status picked
 * from the active asset statuses, the one it has now left out), then Watch. Opened on a watch the
 * person already has, it shows Save and Stop watching. Its words, choices and buttons are the
 * spec's "The Watch modal"; a refused save says why beside the buttons, and a watch that was set
 * or ended elsewhere meanwhile is taken as it now is.
 */

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  ApiError, READ_ONLY_MESSAGE, type AssetWatch, type AssetWatchState, type StatusValue,
} from '../../lib/api';

const api = vi.hoisted(() => ({
  listAssetStatuses: vi.fn(),
  getAssetWatchState: vi.fn(),
  createMyAssetWatch: vi.fn(),
  updateMyAssetWatch: vi.fn(),
  deleteMyAssetWatch: vi.fn(),
}));

vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

const { default: WatchAssetModal } = await import('./WatchAssetModal');

const ASSET_ID = '11111111-1111-4111-8111-111111111111';
const INITIATIVE_ID = '22222222-2222-4222-8222-222222222222';
const WATCH_ID = '33333333-3333-4333-8333-333333333333';

const HINT = "You'll get one notification the first time this happens. Then the watch ends.";
const NEXT_UPDATE_HINT = 'Any scan, status change or edit, or a move into or out of a container or truck.';
const AT_STATUS = 'It already has that status. Pick another one, or watch for its next update.';
const ENDED = 'This watch has already ended. Press Watch to set a new one.';

const status = (key: string, label: string): StatusValue => ({
  record_type: 'asset', key, label, description: '', color: '#888888', sort_order: 0,
  is_active: true, usage_count: null, progress_weight: null,
});

// As GET /status-values?record_type=asset lists them: the active ones. In storage is what the
// asset in these tests has now.
const STATUSES = [
  status('in_storage', 'In storage'), status('in_transit', 'In transit'),
  status('shipped', 'Shipped'), status('delivered', 'Delivered'),
];

/** A watch of the asset on its own, for its next update. */
const WATCH: AssetWatch = {
  id: WATCH_ID, asset_id: ASSET_ID, asset_name: 'SN-1001',
  initiative_id: null, initiative_name: null, initiative_asset_id: null,
  condition: 'next_update', status: null, status_label: null,
  current_status: 'in_storage', current_status_label: 'In storage',
  link: `/assets/${ASSET_ID}`, created_at: '2026-11-05T12:00:00Z',
};

/** A watch for Shipped. */
const STATUS_WATCH: AssetWatch = {
  ...WATCH, condition: 'status', status: 'shipped', status_label: 'Shipped',
};

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

type Props = ComponentProps<typeof WatchAssetModal>;

const onClose = vi.fn();
const onSaved = vi.fn();

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();   // jsdom has none; ComboBox scrolls its active option
  api.listAssetStatuses.mockResolvedValue(STATUSES);
  api.getAssetWatchState.mockResolvedValue({ watching: false, watch: null });
  api.createMyAssetWatch.mockResolvedValue(WATCH);
  api.updateMyAssetWatch.mockResolvedValue(WATCH);
  api.deleteMyAssetWatch.mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function open(over: Partial<Props> = {}) {
  render(
    <WatchAssetModal assetId={ASSET_ID} assetName="SN-1001" currentStatus="in_storage"
                     currentStatusLabel="In storage" watch={null}
                     onClose={onClose} onSaved={onSaved} {...over} />,
  );
  return screen.getByRole('dialog', { name: `Watch ${over.assetName ?? 'SN-1001'}` });
}

const choice = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const footer = () => screen.getByRole('dialog').querySelector('.modal-foot') as HTMLElement;
const inFooter = (name: string) => within(footer()).getByRole('button', { name }) as HTMLButtonElement;
const picker = () => screen.getByRole('combobox', { name: 'Status' }) as HTMLInputElement;

/** What the open picker offers, by name (the menu portals out of the dialog). */
const offered = () => [...document.querySelectorAll('.combo-menu .kbar-item')].map((o) => o.textContent);

/** Open the picker once its list is in (it is off until then). */
async function openPicker(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => expect(picker().disabled).toBe(false));
  await user.click(picker());
}

/** Pick a status in the picker by its label. */
async function pickStatus(user: ReturnType<typeof userEvent.setup>, label: string) {
  await openPicker(user);
  await user.click(await screen.findByText(label, { selector: '.kbar-item' }));
}

// ── the header ──────────────────────────────────────────────────────────

it('wears the standard header: the eyebrow "Watch asset", the title "Watch {asset}" and the hint', () => {
  const dialog = open();

  expect(dialog.querySelector('.eyebrow')?.textContent).toBe('Watch asset');
  expect(within(dialog).getByRole('heading', { name: 'Watch SN-1001', level: 3 })).toBeTruthy();
  expect(dialog.querySelector('p.page-hint')?.textContent).toBe(HINT);
  expect(dialog.classList.contains('nm-card')).toBe(true);
  expect(dialog.classList.contains('rgm-card')).toBe(true);
});

it('names the asset it is given in the title', () => {
  const dialog = open({ assetName: 'Server abc123' });

  expect(within(dialog).getByRole('heading', { name: 'Watch Server abc123', level: 3 })).toBeTruthy();
});

it('on an initiative, a line under the hint names it: "On {initiative}."', () => {
  const dialog = open({ initiativeId: INITIATIVE_ID, initiativeName: 'Initiative A' });

  const hint = dialog.querySelector('p.page-hint') as HTMLElement;
  expect(hint.textContent).toBe(`${HINT} On Initiative A.`);
  expect(hint.querySelector('br')).not.toBeNull();      // its own line, under the hint
});

it('uses house controls only: no select', () => {
  const dialog = open();

  expect(dialog.querySelector('select')).toBeNull();
});

// ── the choice ──────────────────────────────────────────────────────────

it('the "Watch for" strip offers Next update and Status becomes, each with aria-pressed', () => {
  const dialog = open();

  const strip = within(dialog).getByRole('group', { name: 'Watch for' });
  expect(strip.classList.contains('segmented')).toBe(true);
  const buttons = within(strip).getAllByRole('button');
  expect(buttons.map((b) => b.textContent)).toEqual(['Next update', 'Status becomes']);
  for (const b of buttons) expect(b.hasAttribute('aria-pressed')).toBe(true);
});

it('opens on Next update, with its hint and no picker', () => {
  open();

  expect(choice('Next update').getAttribute('aria-pressed')).toBe('true');
  expect(choice('Status becomes').getAttribute('aria-pressed')).toBe('false');
  expect(screen.getByText(NEXT_UPDATE_HINT)).toBeTruthy();
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(screen.queryByText(/Its status/)).toBeNull();
});

it('Status becomes shows the status picker and the status it has now, and takes the Next update hint away', async () => {
  const user = userEvent.setup();
  open();

  await user.click(choice('Status becomes'));

  expect(choice('Status becomes').getAttribute('aria-pressed')).toBe('true');
  expect(choice('Next update').getAttribute('aria-pressed')).toBe('false');
  expect(picker().getAttribute('placeholder')).toBe('Search statuses…');
  expect(screen.getByText('Its status is In storage now.')).toBeTruthy();
  expect(screen.queryByText(NEXT_UPDATE_HINT)).toBeNull();
});

it('the picker\'s label is tied to it', async () => {
  const user = userEvent.setup();
  const dialog = open();
  await user.click(choice('Status becomes'));

  const label = within(dialog).getByText('Status', { selector: 'label' });
  expect(label.getAttribute('for')).toBe(picker().id);
  expect(picker().id).not.toBe('');
});

it('on an initiative the hint says so: "Its status on this initiative is {label} now."', async () => {
  const user = userEvent.setup();
  open({
    initiativeId: INITIATIVE_ID, initiativeName: 'Initiative A',
    currentStatus: 'in_transit', currentStatusLabel: 'In transit',
  });

  await user.click(choice('Status becomes'));

  expect(screen.getByText('Its status on this initiative is In transit now.')).toBeTruthy();
  expect(screen.queryByText('Its status is In transit now.')).toBeNull();
});

it('offers the active asset statuses, by label, and leaves the status it has now out', async () => {
  const user = userEvent.setup();
  open();

  await user.click(choice('Status becomes'));
  await openPicker(user);

  expect(api.listAssetStatuses).toHaveBeenCalledTimes(1);
  expect(offered()).toEqual(['In transit', 'Shipped', 'Delivered']);
});

it('leaves out the status the row has on an initiative, whatever the asset\'s own status is', async () => {
  const user = userEvent.setup();
  open({
    initiativeId: INITIATIVE_ID, initiativeName: 'Initiative A',
    currentStatus: 'shipped', currentStatusLabel: 'Shipped',
  });

  await user.click(choice('Status becomes'));
  await openPicker(user);

  expect(offered()).toEqual(['In storage', 'In transit', 'Delivered']);
});

it('with no current status the hint is left out and nothing is left out of the picker', async () => {
  const user = userEvent.setup();
  open({ currentStatus: null, currentStatusLabel: null });

  await user.click(choice('Status becomes'));
  await openPicker(user);

  expect(offered()).toEqual(['In storage', 'In transit', 'Shipped', 'Delivered']);
  expect(screen.queryByText(/Its status/)).toBeNull();
});

it('names a status it has no label for by its key', async () => {
  const user = userEvent.setup();
  open({ currentStatus: 'in_storage', currentStatusLabel: null });

  await user.click(choice('Status becomes'));

  expect(screen.getByText('Its status is in_storage now.')).toBeTruthy();
});

it('keeps the picker off until the status list is in', async () => {
  const pending = deferred<StatusValue[]>();
  api.listAssetStatuses.mockReturnValue(pending.promise);
  const user = userEvent.setup();
  open();

  await user.click(choice('Status becomes'));
  expect(picker().disabled).toBe(true);

  await act(async () => { pending.resolve(STATUSES); });
  expect(picker().disabled).toBe(false);
});

it('a status list that does not load is told beside the buttons, for Status becomes only, and Next update still works', async () => {
  api.listAssetStatuses.mockRejectedValue(new Error('Failed to fetch'));
  const user = userEvent.setup();
  open();
  await waitFor(() => expect(api.listAssetStatuses).toHaveBeenCalledTimes(1));
  await act(async () => { await Promise.resolve(); });
  expect(screen.queryByRole('alert')).toBeNull();               // not while Next update is chosen

  await user.click(choice('Status becomes'));

  const notice = await screen.findByRole('alert');
  expect(notice.textContent).toBe('Could not load the status list.');
  expect(footer().contains(notice)).toBe(true);
  expect(picker().disabled).toBe(true);
  expect(inFooter('Watch').disabled).toBe(true);

  await user.click(choice('Next update'));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(inFooter('Watch').disabled).toBe(false);
});

// ── a new watch ─────────────────────────────────────────────────────────

it('for a new watch the footer is Watch (btn-solid) and Cancel (mini-btn), with no Stop watching', () => {
  open();

  expect(inFooter('Watch').className).toBe('btn-solid');
  expect(inFooter('Watch').getAttribute('type')).toBe('button');
  expect(inFooter('Cancel').className).toBe('mini-btn');
  expect(within(footer()).queryByRole('button', { name: 'Stop watching' })).toBeNull();
  expect(within(footer()).queryByRole('button', { name: 'Save' })).toBeNull();
});

it('Watch for the next update creates the watch with no status, then hands it over and closes', async () => {
  const created: AssetWatch = { ...WATCH, id: 'created' };
  api.createMyAssetWatch.mockResolvedValue(created);
  const user = userEvent.setup();
  open();

  await user.click(inFooter('Watch'));

  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(api.createMyAssetWatch).toHaveBeenCalledTimes(1);
  expect(api.createMyAssetWatch).toHaveBeenCalledWith({
    asset_id: ASSET_ID, initiative_id: null, condition: 'next_update', status: null,
  });
  expect(onSaved).toHaveBeenCalledTimes(1);
  expect(onSaved).toHaveBeenCalledWith(created);
  expect(onSaved.mock.invocationCallOrder[0]).toBeLessThan(onClose.mock.invocationCallOrder[0]);
  expect(api.updateMyAssetWatch).not.toHaveBeenCalled();
  expect(api.deleteMyAssetWatch).not.toHaveBeenCalled();
});

it('Watch for a status on an initiative sends the initiative and the status picked', async () => {
  const user = userEvent.setup();
  open({
    initiativeId: INITIATIVE_ID, initiativeName: 'Initiative A',
    currentStatus: 'in_transit', currentStatusLabel: 'In transit',
  });

  await user.click(choice('Status becomes'));
  await pickStatus(user, 'Shipped');
  await user.click(inFooter('Watch'));

  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(api.createMyAssetWatch).toHaveBeenCalledWith({
    asset_id: ASSET_ID, initiative_id: INITIATIVE_ID, condition: 'status', status: 'shipped',
  });
});

it('Status becomes with nothing picked leaves Watch off, and a status picked turns it on', async () => {
  const user = userEvent.setup();
  open();

  await user.click(choice('Status becomes'));
  expect(inFooter('Watch').disabled).toBe(true);
  await user.click(inFooter('Watch'));
  expect(api.createMyAssetWatch).not.toHaveBeenCalled();

  await pickStatus(user, 'Delivered');
  expect(picker().value).toBe('Delivered');
  expect(inFooter('Watch').disabled).toBe(false);
});

it('a status picked and then Next update sends no status: the API refuses one with a Next update', async () => {
  const user = userEvent.setup();
  open();
  await user.click(choice('Status becomes'));
  await pickStatus(user, 'Shipped');

  await user.click(choice('Next update'));
  await user.click(inFooter('Watch'));

  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(api.createMyAssetWatch).toHaveBeenCalledWith({
    asset_id: ASSET_ID, initiative_id: null, condition: 'next_update', status: null,
  });
});

it('Next update turns Watch back on after Status becomes was left with nothing picked', async () => {
  const user = userEvent.setup();
  open();
  await user.click(choice('Status becomes'));
  expect(inFooter('Watch').disabled).toBe(true);

  await user.click(choice('Next update'));

  expect(inFooter('Watch').disabled).toBe(false);
});

it('keeps the status picked while the person looks at Next update and comes back', async () => {
  const user = userEvent.setup();
  open();
  await user.click(choice('Status becomes'));
  await pickStatus(user, 'Shipped');

  await user.click(choice('Next update'));
  await user.click(choice('Status becomes'));

  expect(picker().value).toBe('Shipped');
  expect(inFooter('Watch').disabled).toBe(false);
});

it('Cancel closes the dialog and sends nothing', async () => {
  const user = userEvent.setup();
  open();

  await user.click(inFooter('Cancel'));

  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onSaved).not.toHaveBeenCalled();
  expect(api.createMyAssetWatch).not.toHaveBeenCalled();
});

// ── a watch the person already has ──────────────────────────────────────

it('opened on a watch, the footer is Save (btn-solid), Cancel (mini-btn) and Stop watching (danger)', () => {
  open({ watch: WATCH });

  expect(inFooter('Save').className).toBe('btn-solid');
  expect(inFooter('Cancel').className).toBe('mini-btn');
  expect(inFooter('Stop watching').className).toBe('mini-btn danger');
  expect(inFooter('Stop watching').getAttribute('type')).toBe('button');
  expect(within(footer()).queryByRole('button', { name: 'Watch' })).toBeNull();
});

it('opened on a Next update watch, it is selected', () => {
  open({ watch: WATCH });

  expect(choice('Next update').getAttribute('aria-pressed')).toBe('true');
  expect(choice('Status becomes').getAttribute('aria-pressed')).toBe('false');
  expect(inFooter('Save').disabled).toBe(false);
});

it('opened on a Status becomes watch, that and its status are preselected once the list is in', async () => {
  const pending = deferred<StatusValue[]>();
  api.listAssetStatuses.mockReturnValue(pending.promise);
  open({ watch: STATUS_WATCH });

  expect(choice('Status becomes').getAttribute('aria-pressed')).toBe('true');
  expect(choice('Next update').getAttribute('aria-pressed')).toBe('false');
  expect(picker().disabled).toBe(true);
  expect(inFooter('Save').disabled).toBe(true);               // its status is not known to be on offer yet

  await act(async () => { pending.resolve(STATUSES); });

  expect(picker().value).toBe('Shipped');
  expect(inFooter('Save').disabled).toBe(false);
});

it('a Status becomes watch for the status it has now (which the picker leaves out) has nothing picked, and Save is off', async () => {
  const user = userEvent.setup();
  open({
    watch: STATUS_WATCH, currentStatus: 'shipped', currentStatusLabel: 'Shipped',
  });

  await waitFor(() => expect(picker().disabled).toBe(false));
  expect(picker().value).toBe('');
  expect(inFooter('Save').disabled).toBe(true);

  await pickStatus(user, 'Delivered');
  expect(inFooter('Save').disabled).toBe(false);
});

it('Save sends the watch\'s new condition and status to it by its id, then hands it over and closes', async () => {
  const updated: AssetWatch = { ...STATUS_WATCH, status: 'delivered', status_label: 'Delivered' };
  api.updateMyAssetWatch.mockResolvedValue(updated);
  const user = userEvent.setup();
  open({ watch: STATUS_WATCH });
  await waitFor(() => expect(picker().value).toBe('Shipped'));

  await pickStatus(user, 'Delivered');
  await user.click(inFooter('Save'));

  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(api.updateMyAssetWatch).toHaveBeenCalledTimes(1);
  expect(api.updateMyAssetWatch).toHaveBeenCalledWith(WATCH_ID, { condition: 'status', status: 'delivered' });
  expect(onSaved).toHaveBeenCalledWith(updated);
  expect(onSaved.mock.invocationCallOrder[0]).toBeLessThan(onClose.mock.invocationCallOrder[0]);
  expect(api.createMyAssetWatch).not.toHaveBeenCalled();
  expect(api.deleteMyAssetWatch).not.toHaveBeenCalled();
});

it('Save for the next update sends no status, even when the watch had one', async () => {
  const user = userEvent.setup();
  open({ watch: STATUS_WATCH });
  await waitFor(() => expect(picker().value).toBe('Shipped'));

  await user.click(choice('Next update'));
  await user.click(inFooter('Save'));

  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(api.updateMyAssetWatch).toHaveBeenCalledWith(WATCH_ID, { condition: 'next_update', status: null });
});

it('Stop watching ends the watch by its id, then tells the caller it was stopped (null) and closes', async () => {
  const user = userEvent.setup();
  open({ watch: WATCH });

  await user.click(inFooter('Stop watching'));

  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(api.deleteMyAssetWatch).toHaveBeenCalledTimes(1);
  expect(api.deleteMyAssetWatch).toHaveBeenCalledWith(WATCH_ID);
  expect(onSaved).toHaveBeenCalledTimes(1);
  expect(onSaved).toHaveBeenCalledWith(null);
  expect(api.deleteMyAssetWatch.mock.invocationCallOrder[0])
    .toBeLessThan(onSaved.mock.invocationCallOrder[0]);
  expect(onSaved.mock.invocationCallOrder[0]).toBeLessThan(onClose.mock.invocationCallOrder[0]);
  expect(api.updateMyAssetWatch).not.toHaveBeenCalled();
});

// ── while a request is on its way ───────────────────────────────────────

it('while Watch is on its way nothing else can be pressed or closed, and a second click sends nothing', async () => {
  const pending = deferred<AssetWatch>();
  api.createMyAssetWatch.mockReturnValue(pending.promise);
  const user = userEvent.setup();
  open();

  await user.click(inFooter('Watch'));
  await waitFor(() => expect(inFooter('Watch').disabled).toBe(true));

  expect(inFooter('Cancel').disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(inFooter('Watch'));
  expect(api.createMyAssetWatch).toHaveBeenCalledTimes(1);
  expect(onClose).not.toHaveBeenCalled();

  await act(async () => { pending.resolve(WATCH); });
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('while Stop watching is on its way Save, Cancel and Stop watching are off', async () => {
  const pending = deferred<void>();
  api.deleteMyAssetWatch.mockReturnValue(pending.promise);
  const user = userEvent.setup();
  open({ watch: WATCH });

  await user.click(inFooter('Stop watching'));
  await waitFor(() => expect(inFooter('Stop watching').disabled).toBe(true));

  expect(inFooter('Save').disabled).toBe(true);
  expect(inFooter('Cancel').disabled).toBe(true);
  await user.click(inFooter('Stop watching'));
  expect(api.deleteMyAssetWatch).toHaveBeenCalledTimes(1);

  await act(async () => { pending.resolve(); });
  expect(onSaved).toHaveBeenCalledWith(null);
  expect(onClose).toHaveBeenCalledTimes(1);
});

// ── a refused save ──────────────────────────────────────────────────────

it('the error line is a pf-error span with role alert, in the footer beside the buttons', async () => {
  api.createMyAssetWatch.mockRejectedValue(new ApiError(404, 'thing_not_found'));
  const user = userEvent.setup();
  open();

  await user.click(inFooter('Watch'));

  const error = await screen.findByRole('alert');
  expect(error.tagName).toBe('SPAN');
  expect(error.classList.contains('pf-error')).toBe(true);
  expect(footer().contains(error)).toBe(true);
});

it.each([
  ['already_at_status', 422, AT_STATUS],
  ['thing_not_found', 404, "You can't watch this asset."],
  ['not_on_initiative', 422, 'This asset is no longer on this initiative.'],
  ['read_only_mode', 423, READ_ONLY_MESSAGE],
  ['invalid_status', 422, 'Request failed (invalid_status).'],
  ['status_required', 422, 'Request failed (status_required).'],
])('a refused Watch (%s) says "%s" beside the buttons and leaves the dialog open', async (code, httpStatus, message) => {
  api.createMyAssetWatch.mockRejectedValue(
    new ApiError(httpStatus, code, { code }, code === 'read_only_mode' ? READ_ONLY_MESSAGE : undefined));
  const user = userEvent.setup();
  open();

  await user.click(inFooter('Watch'));

  expect((await screen.findByRole('alert')).textContent).toBe(message);
  expect(onSaved).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  await waitFor(() => expect(inFooter('Watch').disabled).toBe(false));
  expect(inFooter('Cancel').disabled).toBe(false);
});

it.each([
  ['already_at_status', 422, AT_STATUS],
  ['thing_not_found', 404, "You can't watch this asset."],
  ['not_on_initiative', 422, 'This asset is no longer on this initiative.'],
])('a refused Save (%s) says the same, and leaves the dialog open on the watch', async (code, httpStatus, message) => {
  api.updateMyAssetWatch.mockRejectedValue(new ApiError(httpStatus, code));
  const user = userEvent.setup();
  open({ watch: WATCH });

  await user.click(inFooter('Save'));

  expect((await screen.findByRole('alert')).textContent).toBe(message);
  expect(onSaved).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  await waitFor(() => expect(inFooter('Save').disabled).toBe(false));
  expect(inFooter('Stop watching')).toBeTruthy();
});

it('a failure that is not an API answer (no connection, a bug) is the plain sentence', async () => {
  api.createMyAssetWatch.mockRejectedValue(new Error('Failed to fetch'));
  const user = userEvent.setup();
  open();

  await user.click(inFooter('Watch'));

  expect((await screen.findByRole('alert')).textContent).toBe("Couldn't update your watch.");
  expect(onClose).not.toHaveBeenCalled();
});

it('any change to the choice takes the old reason away', async () => {
  api.createMyAssetWatch.mockRejectedValue(new ApiError(422, 'already_at_status'));
  const user = userEvent.setup();
  open();
  await user.click(choice('Status becomes'));
  await pickStatus(user, 'Shipped');
  await user.click(inFooter('Watch'));
  await screen.findByRole('alert');

  await pickStatus(user, 'Delivered');
  expect(screen.queryByRole('alert')).toBeNull();

  await user.click(inFooter('Watch'));
  await screen.findByRole('alert');
  await user.click(choice('Next update'));
  expect(screen.queryByRole('alert')).toBeNull();
});

it('a second try starts with the old reason gone', async () => {
  const retry = deferred<AssetWatch>();
  api.createMyAssetWatch.mockRejectedValueOnce(new ApiError(404, 'thing_not_found'))
    .mockReturnValueOnce(retry.promise);
  const user = userEvent.setup();
  open();
  await user.click(inFooter('Watch'));
  await screen.findByRole('alert');

  await user.click(inFooter('Watch'));

  await waitFor(() => expect(api.createMyAssetWatch).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole('alert')).toBeNull();
  await act(async () => { retry.resolve(WATCH); });
});

// ── a watch set or ended somewhere else meanwhile ───────────────────────

it('Watch answered already_watching reads the state again, hands over what is there, and closes with no error', async () => {
  const there: AssetWatch = { ...STATUS_WATCH, id: 'elsewhere' };
  api.createMyAssetWatch.mockRejectedValue(new ApiError(409, 'already_watching'));
  api.getAssetWatchState.mockResolvedValue({ watching: true, watch: there } satisfies AssetWatchState);
  const user = userEvent.setup();
  open();

  await user.click(inFooter('Watch'));

  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(api.getAssetWatchState).toHaveBeenCalledTimes(1);
  expect(api.getAssetWatchState).toHaveBeenCalledWith(ASSET_ID, null);
  expect(onSaved).toHaveBeenCalledTimes(1);
  expect(onSaved).toHaveBeenCalledWith(there);
  expect(screen.queryByRole('alert')).toBeNull();
});

it('reads the state again for the initiative the watch is on', async () => {
  api.createMyAssetWatch.mockRejectedValue(new ApiError(409, 'already_watching'));
  api.getAssetWatchState.mockResolvedValue({ watching: true, watch: WATCH });
  const user = userEvent.setup();
  open({ initiativeId: INITIATIVE_ID, initiativeName: 'Initiative A' });

  await user.click(inFooter('Watch'));

  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(api.getAssetWatchState).toHaveBeenCalledWith(ASSET_ID, INITIATIVE_ID);
});

it('already_watching with a state that cannot be read again says so, and leaves the dialog open', async () => {
  api.createMyAssetWatch.mockRejectedValue(new ApiError(409, 'already_watching'));
  api.getAssetWatchState.mockRejectedValue(new Error('Failed to fetch'));
  const user = userEvent.setup();
  open();

  await user.click(inFooter('Watch'));

  expect((await screen.findByRole('alert')).textContent).toBe("You're already watching this.");
  expect(onSaved).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  await waitFor(() => expect(inFooter('Watch').disabled).toBe(false));
});

it('Save answered watch_not_found (the check ended the watch): the caller hears null, the dialog stays as a new watch, and says so', async () => {
  api.updateMyAssetWatch.mockRejectedValue(new ApiError(404, 'watch_not_found'));
  const user = userEvent.setup();
  open({ watch: WATCH });

  await user.click(inFooter('Save'));

  expect((await screen.findByRole('alert')).textContent).toBe(ENDED);
  expect(onSaved).toHaveBeenCalledTimes(1);
  expect(onSaved).toHaveBeenCalledWith(null);
  expect(onClose).not.toHaveBeenCalled();
  expect(inFooter('Watch').className).toBe('btn-solid');      // now the primary button is Watch
  expect(within(footer()).queryByRole('button', { name: 'Save' })).toBeNull();
  expect(within(footer()).queryByRole('button', { name: 'Stop watching' })).toBeNull();
  await waitFor(() => expect(inFooter('Watch').disabled).toBe(false));
});

it('then Watch sets a new watch with the choice that was made, and closes', async () => {
  const fresh: AssetWatch = { ...STATUS_WATCH, id: 'fresh' };
  api.updateMyAssetWatch.mockRejectedValue(new ApiError(404, 'watch_not_found'));
  api.createMyAssetWatch.mockResolvedValue(fresh);
  const user = userEvent.setup();
  open({ watch: STATUS_WATCH });
  await waitFor(() => expect(picker().value).toBe('Shipped'));
  await user.click(inFooter('Save'));
  await screen.findByRole('alert');
  onSaved.mockClear();

  await user.click(inFooter('Watch'));

  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(api.updateMyAssetWatch).toHaveBeenCalledTimes(1);   // the one that was refused
  expect(api.createMyAssetWatch).toHaveBeenCalledWith({
    asset_id: ASSET_ID, initiative_id: null, condition: 'status', status: 'shipped',
  });
  expect(onSaved).toHaveBeenCalledTimes(1);
  expect(onSaved).toHaveBeenCalledWith(fresh);
});

it('the "ended" reason goes away with any change to the choice, since the buttons now say it', async () => {
  api.updateMyAssetWatch.mockRejectedValue(new ApiError(404, 'watch_not_found'));
  const user = userEvent.setup();
  open({ watch: WATCH });
  await user.click(inFooter('Save'));
  await screen.findByRole('alert');

  await user.click(choice('Status becomes'));

  expect(screen.queryByRole('alert')).toBeNull();
  expect(inFooter('Watch')).toBeTruthy();
});

it('Stop watching answered watch_not_found counts as stopped: the caller hears null and the dialog closes with no error', async () => {
  api.deleteMyAssetWatch.mockRejectedValue(new ApiError(404, 'watch_not_found'));
  const user = userEvent.setup();
  open({ watch: WATCH });

  await user.click(inFooter('Stop watching'));

  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(onSaved).toHaveBeenCalledTimes(1);
  expect(onSaved).toHaveBeenCalledWith(null);
  expect(screen.queryByRole('alert')).toBeNull();
});

it('a Stop watching that is refused otherwise says why, keeps the watch and enables the buttons again', async () => {
  api.deleteMyAssetWatch.mockRejectedValue(
    new ApiError(423, 'read_only_mode', { code: 'read_only_mode' }, READ_ONLY_MESSAGE));
  const user = userEvent.setup();
  open({ watch: WATCH });

  await user.click(inFooter('Stop watching'));

  expect((await screen.findByRole('alert')).textContent).toBe(READ_ONLY_MESSAGE);
  expect(onSaved).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  await waitFor(() => expect(inFooter('Stop watching').disabled).toBe(false));
  expect(inFooter('Save').disabled).toBe(false);
});

it('a Stop watching that fails with no API answer is the plain sentence', async () => {
  api.deleteMyAssetWatch.mockRejectedValue(new Error('Failed to fetch'));
  const user = userEvent.setup();
  open({ watch: WATCH });

  await user.click(inFooter('Stop watching'));

  expect((await screen.findByRole('alert')).textContent).toBe("Couldn't update your watch.");
  expect(onClose).not.toHaveBeenCalled();
});

// @vitest-environment jsdom
/**
 * AssetWatchButton — the Watch / Watching button in the header of the asset page and the move
 * asset page. It looks like the Watch button of an initiative, site or truck page, but a click
 * opens the Watch modal instead of toggling: an asset watch has a choice to make. It reads
 * whether the person watches the asset in that place, renders nothing until that is known (a
 * failure to read it counts as not watching), and takes what the modal saved or stopped.
 */

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  ApiError, type AssetWatch, type AssetWatchState, type StatusValue,
} from '../../lib/api';

const api = vi.hoisted(() => ({
  getAssetWatchState: vi.fn(),
  createMyAssetWatch: vi.fn(),
  updateMyAssetWatch: vi.fn(),
  deleteMyAssetWatch: vi.fn(),
  listAssetStatuses: vi.fn(),
}));

vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

const { default: AssetWatchButton } = await import('./AssetWatchButton');

const ASSET_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ASSET_ID = '22222222-2222-4222-8222-222222222222';
const INITIATIVE_ID = '33333333-3333-4333-8333-333333333333';
const WATCH_ID = '44444444-4444-4444-8444-444444444444';

const status = (key: string, label: string): StatusValue => ({
  record_type: 'asset', key, label, description: '', color: '#888888', sort_order: 0,
  is_active: true, usage_count: null, progress_weight: null,
});
const STATUSES = [
  status('in_storage', 'In storage'), status('in_transit', 'In transit'), status('shipped', 'Shipped'),
];

/** The person's watch of the asset on its own, for its next update. */
const WATCH: AssetWatch = {
  id: WATCH_ID, asset_id: ASSET_ID, asset_name: 'SN-1001',
  initiative_id: null, initiative_name: null, initiative_asset_id: null,
  condition: 'next_update', status: null, status_label: null,
  current_status: 'in_storage', current_status_label: 'In storage',
  link: `/assets/${ASSET_ID}`, created_at: '2026-11-05T12:00:00Z',
};

/** The same watch after it was changed to wait for Shipped. */
const STATUS_WATCH: AssetWatch = {
  ...WATCH, condition: 'status', status: 'shipped', status_label: 'Shipped',
};

const NOT_WATCHING: AssetWatchState = { watching: false, watch: null };
const WATCHING: AssetWatchState = { watching: true, watch: WATCH };

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

type Props = ComponentProps<typeof AssetWatchButton>;

const PROPS: Props = {
  assetId: ASSET_ID, assetName: 'SN-1001', currentStatus: 'in_storage', currentStatusLabel: 'In storage',
};

const view = (over: Partial<Props> = {}) => <AssetWatchButton {...PROPS} {...over} />;

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();   // jsdom has none; ComboBox scrolls its active option
  api.getAssetWatchState.mockResolvedValue(NOT_WATCHING);
  api.createMyAssetWatch.mockResolvedValue(WATCH);
  api.updateMyAssetWatch.mockResolvedValue(STATUS_WATCH);
  api.deleteMyAssetWatch.mockResolvedValue(undefined);
  api.listAssetStatuses.mockResolvedValue(STATUSES);
});

afterEach(cleanup);

/** The button in the page header (the modal has its own "Watch"). */
const headerButton = (container: HTMLElement) => container.querySelector('button.watch-btn') as HTMLButtonElement;
const dialog = () => screen.getByRole('dialog');
const inDialog = (name: string) => within(dialog()).getByRole('button', { name }) as HTMLButtonElement;

it('renders nothing until the watch state is known', async () => {
  const pending = deferred<AssetWatchState>();
  api.getAssetWatchState.mockReturnValue(pending.promise);
  const { container } = render(view());

  expect(container.innerHTML).toBe('');
  expect(screen.queryByRole('button')).toBeNull();

  await act(async () => { pending.resolve(NOT_WATCHING); });
  expect(headerButton(container)).toBeTruthy();
});

it('asks for the state of the asset on its own, with no initiative', async () => {
  render(view());
  await screen.findByRole('button', { name: 'Watch' });

  expect(api.getAssetWatchState).toHaveBeenCalledTimes(1);
  expect(api.getAssetWatchState).toHaveBeenCalledWith(ASSET_ID, null);
});

it('asks for the state of the asset on an initiative when it is on one', async () => {
  render(view({ initiativeId: INITIATIVE_ID, initiativeName: 'Initiative A' }));
  await screen.findByRole('button', { name: 'Watch' });

  expect(api.getAssetWatchState).toHaveBeenCalledTimes(1);
  expect(api.getAssetWatchState).toHaveBeenCalledWith(ASSET_ID, INITIATIVE_ID);
});

it('is the house ghost button with the eye, "Watch" and not pressed, when the person is not watching', async () => {
  render(view());
  const watch = await screen.findByRole('button', { name: 'Watch' }) as HTMLButtonElement;

  expect(watch.type).toBe('button');
  expect(watch.className).toBe('btn-ghost watch-btn');
  expect(watch.getAttribute('aria-pressed')).toBe('false');
  expect(watch.disabled).toBe(false);
  expect(watch.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  expect(watch.textContent).toBe('Watch');
});

it('reads "Watching", pressed and amber (.on), when the person already watches it', async () => {
  api.getAssetWatchState.mockResolvedValue(WATCHING);
  render(view());
  const watching = await screen.findByRole('button', { name: 'Watching' }) as HTMLButtonElement;

  expect(watching.className).toBe('btn-ghost watch-btn on');
  expect(watching.getAttribute('aria-pressed')).toBe('true');
  expect(watching.textContent).toBe('Watching');
});

it('a load failure reads as not watching', async () => {
  api.getAssetWatchState.mockRejectedValue(new Error('Failed to fetch'));
  render(view());

  const watch = await screen.findByRole('button', { name: 'Watch' });
  expect(watch.getAttribute('aria-pressed')).toBe('false');
});

it('a click opens the Watch modal for the asset, and watches nothing yet', async () => {
  const user = userEvent.setup();
  render(view());

  expect(screen.queryByRole('dialog')).toBeNull();
  await user.click(await screen.findByRole('button', { name: 'Watch' }));

  expect(dialog().getAttribute('aria-label')).toBe('Watch SN-1001');
  expect(inDialog('Next update').getAttribute('aria-pressed')).toBe('true');
  expect(api.createMyAssetWatch).not.toHaveBeenCalled();
  expect(api.deleteMyAssetWatch).not.toHaveBeenCalled();
});

it('opens the modal in the enclosing portal shell, outside the header\'s action row, so its buttons keep their size', async () => {
  // `.idet-header-actions .mini-btn` resizes any mini-btn inside the row (initiatives.css); the
  // shell holds the theme tokens.
  const user = userEvent.setup();
  render(
    <div className="portal-shell">
      <div className="idet-header-actions">{view()}</div>
    </div>,
  );

  await user.click(await screen.findByRole('button', { name: 'Watch' }));

  const shell = document.querySelector('.portal-shell') as HTMLElement;
  expect(shell.contains(dialog())).toBe(true);
  expect(dialog().closest('.idet-header-actions')).toBeNull();
  expect(shell.querySelector('.idet-header-actions')?.contains(dialog())).toBe(false);
});

it('opens the modal under the page when there is no portal shell', async () => {
  const user = userEvent.setup();
  const { container } = render(view());

  await user.click(await screen.findByRole('button', { name: 'Watch' }));

  expect(document.body.contains(dialog())).toBe(true);
  expect(container.contains(dialog())).toBe(false);
});

it('gives the modal the initiative and the status it is on: the "On" line and the status hint', async () => {
  const user = userEvent.setup();
  render(view({
    initiativeId: INITIATIVE_ID, initiativeName: 'Initiative A',
    currentStatus: 'in_transit', currentStatusLabel: 'In transit',
  }));

  await user.click(await screen.findByRole('button', { name: 'Watch' }));
  expect(dialog().querySelector('p.page-hint')?.textContent).toContain('On Initiative A.');

  await user.click(inDialog('Status becomes'));
  expect(within(dialog()).getByText('Its status on this initiative is In transit now.')).toBeTruthy();
});

it('while the person watches, a click opens the modal on that watch: Save and Stop watching', async () => {
  api.getAssetWatchState.mockResolvedValue(WATCHING);
  const user = userEvent.setup();
  render(view());

  await user.click(await screen.findByRole('button', { name: 'Watching' }));

  expect(inDialog('Save')).toBeTruthy();
  expect(inDialog('Stop watching')).toBeTruthy();
  expect(within(dialog()).queryByRole('button', { name: 'Watch' })).toBeNull();
  expect(api.deleteMyAssetWatch).not.toHaveBeenCalled();   // opening is not stopping
});

it('Watch in the modal creates the watch, closes the modal and reads "Watching"', async () => {
  const user = userEvent.setup();
  const { container } = render(view());
  await user.click(await screen.findByRole('button', { name: 'Watch' }));

  await user.click(inDialog('Watch'));

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(api.createMyAssetWatch).toHaveBeenCalledTimes(1);
  expect(headerButton(container).textContent).toBe('Watching');
  expect(headerButton(container).getAttribute('aria-pressed')).toBe('true');
  expect(headerButton(container).className).toBe('btn-ghost watch-btn on');
});

it('Stop watching in the modal ends the watch, closes the modal and reads "Watch"', async () => {
  api.getAssetWatchState.mockResolvedValue(WATCHING);
  const user = userEvent.setup();
  const { container } = render(view());
  await user.click(await screen.findByRole('button', { name: 'Watching' }));

  await user.click(inDialog('Stop watching'));

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(api.deleteMyAssetWatch).toHaveBeenCalledWith(WATCH_ID);
  expect(headerButton(container).textContent).toBe('Watch');
  expect(headerButton(container).getAttribute('aria-pressed')).toBe('false');
});

it('Save in the modal keeps "Watching", and the next click opens the modal on what was saved', async () => {
  api.getAssetWatchState.mockResolvedValue(WATCHING);
  const user = userEvent.setup();
  const { container } = render(view());
  await user.click(await screen.findByRole('button', { name: 'Watching' }));
  await user.click(inDialog('Status becomes'));
  const picker = within(dialog()).getByRole('combobox', { name: 'Status' }) as HTMLInputElement;
  await waitFor(() => expect(picker.disabled).toBe(false));
  await user.click(picker);
  await user.click(await screen.findByText('Shipped', { selector: '.kbar-item' }));

  await user.click(inDialog('Save'));

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(api.updateMyAssetWatch).toHaveBeenCalledWith(WATCH_ID, { condition: 'status', status: 'shipped' });
  expect(headerButton(container).textContent).toBe('Watching');
  await user.click(headerButton(container));
  expect(inDialog('Status becomes').getAttribute('aria-pressed')).toBe('true');
  expect((within(dialog()).getByRole('combobox', { name: 'Status' }) as HTMLInputElement).value)
    .toBe('Shipped');
});

it('Cancel closes the modal and leaves the button as it was', async () => {
  const user = userEvent.setup();
  const { container } = render(view());
  await user.click(await screen.findByRole('button', { name: 'Watch' }));

  await user.click(inDialog('Cancel'));

  expect(screen.queryByRole('dialog')).toBeNull();
  expect(headerButton(container).textContent).toBe('Watch');
  expect(api.createMyAssetWatch).not.toHaveBeenCalled();
});

it('a watch the check ended while the modal was open: the button reads "Watch" and the modal stays, as a new watch', async () => {
  api.getAssetWatchState.mockResolvedValue(WATCHING);
  api.updateMyAssetWatch.mockRejectedValue(new ApiError(404, 'watch_not_found'));
  const user = userEvent.setup();
  const { container } = render(view());
  await user.click(await screen.findByRole('button', { name: 'Watching' }));

  await user.click(inDialog('Save'));

  await waitFor(() => expect(headerButton(container).textContent).toBe('Watch'));
  expect(headerButton(container).getAttribute('aria-pressed')).toBe('false');
  expect(inDialog('Watch')).toBeTruthy();                       // still open, now for a new watch
  expect(within(dialog()).queryByRole('button', { name: 'Stop watching' })).toBeNull();
});

it('reads the state again for another asset, and is gone until that is known', async () => {
  const next = deferred<AssetWatchState>();
  const { rerender, container } = render(view());
  await screen.findByRole('button', { name: 'Watch' });

  api.getAssetWatchState.mockReturnValue(next.promise);
  rerender(view({ assetId: OTHER_ASSET_ID }));

  expect(api.getAssetWatchState).toHaveBeenLastCalledWith(OTHER_ASSET_ID, null);
  expect(container.innerHTML).toBe('');
  await act(async () => { next.resolve(WATCHING); });
  expect(headerButton(container).textContent).toBe('Watching');
});

it('reads the state again for the same asset on another initiative', async () => {
  const { rerender } = render(view());
  await screen.findByRole('button', { name: 'Watch' });

  rerender(view({ initiativeId: INITIATIVE_ID, initiativeName: 'Initiative A' }));

  await waitFor(() => expect(api.getAssetWatchState).toHaveBeenCalledTimes(2));
  expect(api.getAssetWatchState).toHaveBeenLastCalledWith(ASSET_ID, INITIATIVE_ID);
});

it('drops the state answer of the asset it was on when the page has moved to another', async () => {
  const first = deferred<AssetWatchState>();
  const second = deferred<AssetWatchState>();
  api.getAssetWatchState.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const { rerender, container } = render(view());
  rerender(view({ assetId: OTHER_ASSET_ID }));

  await act(async () => { second.resolve(NOT_WATCHING); });
  await screen.findByRole('button', { name: 'Watch' });
  await act(async () => { first.resolve(WATCHING); });          // late answer for the first asset

  expect(headerButton(container).getAttribute('aria-pressed')).toBe('false');
  expect(screen.queryByRole('button', { name: 'Watching' })).toBeNull();
});

it('closes the modal when the page moves to another asset, and does not bring it back', async () => {
  const user = userEvent.setup();
  const { rerender } = render(view());
  await user.click(await screen.findByRole('button', { name: 'Watch' }));
  expect(screen.getByRole('dialog')).toBeTruthy();

  rerender(view({ assetId: OTHER_ASSET_ID, assetName: 'SN-2002' }));
  await screen.findByRole('button', { name: 'Watch' });

  expect(screen.queryByRole('dialog')).toBeNull();
});

it('drops a save that comes back after the page has moved to another asset', async () => {
  const pending = deferred<AssetWatch>();
  api.createMyAssetWatch.mockReturnValue(pending.promise);
  const user = userEvent.setup();
  const { rerender, container } = render(view());
  await user.click(await screen.findByRole('button', { name: 'Watch' }));
  await user.click(inDialog('Watch'));

  rerender(view({ assetId: OTHER_ASSET_ID, assetName: 'SN-2002' }));
  await screen.findByRole('button', { name: 'Watch' });
  await act(async () => { pending.resolve(WATCH); });         // the first asset's watch, saved late

  expect(headerButton(container).getAttribute('aria-pressed')).toBe('false');
  expect(headerButton(container).textContent).toBe('Watch');
  expect(screen.queryByRole('dialog')).toBeNull();
});

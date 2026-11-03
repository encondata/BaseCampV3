// @vitest-environment jsdom
/**
 * WatchButton — the Watch / Watching toggle on an initiative, site or truck page.
 * It reads whether the person watches the thing themselves (a group's watch of it
 * does not count), renders nothing until that is known, and toggles their own watch.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError, READ_ONLY_MESSAGE, type Watch, type WatchState } from '../../lib/api';

const api = vi.hoisted(() => ({
  getWatchState: vi.fn(),
  createMyWatch: vi.fn(),
  deleteMyWatch: vi.fn(),
}));

vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

const toast = vi.hoisted(() => vi.fn());

vi.mock('../../lib/notificationsContext', () => ({ useToast: () => toast }));

const { default: WatchButton } = await import('./WatchButton');

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const WATCH_ID = '33333333-3333-4333-8333-333333333333';

const NOT_WATCHING: WatchState = { watching: false, watch_id: null, kinds: [] };
const WATCHING: WatchState = { watching: true, watch_id: WATCH_ID, kinds: [] };

const CREATED: Watch = {
  id: WATCH_ID, thing: 'initiative', thing_id: ID, thing_name: 'Initiative A',
  link: `/initiatives/${ID}`, kinds: [], via: { type: 'you', id: null, name: null },
  created_at: '2026-11-02T12:00:00Z',
};

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getWatchState.mockResolvedValue(NOT_WATCHING);
  api.createMyWatch.mockResolvedValue(CREATED);
  api.deleteMyWatch.mockResolvedValue(undefined);
});

afterEach(cleanup);

const button = (name: 'Watch' | 'Watching') => screen.getByRole('button', { name }) as HTMLButtonElement;

it('renders nothing until the watch state is known', async () => {
  const pending = deferred<WatchState>();
  api.getWatchState.mockReturnValue(pending.promise);
  const { container } = render(<WatchButton thing="initiative" id={ID} />);

  expect(container.innerHTML).toBe('');
  expect(screen.queryByRole('button')).toBeNull();

  await act(async () => { pending.resolve(NOT_WATCHING); });
  expect(button('Watch')).toBeTruthy();
});

it('asks for the state of the thing it is on', async () => {
  render(<WatchButton thing="truck" id={ID} />);
  await screen.findByRole('button', { name: 'Watch' });

  expect(api.getWatchState).toHaveBeenCalledTimes(1);
  expect(api.getWatchState).toHaveBeenCalledWith('truck', ID);
});

it('is the house ghost button with the eye, "Watch" and not pressed, when the person is not watching', async () => {
  render(<WatchButton thing="initiative" id={ID} />);
  const watch = await screen.findByRole('button', { name: 'Watch' }) as HTMLButtonElement;

  expect(watch.type).toBe('button');
  expect(watch.className).toBe('btn-ghost watch-btn');
  expect(watch.getAttribute('aria-pressed')).toBe('false');
  expect(watch.getAttribute('title')).toBe('Get notified about changes here');
  expect(watch.disabled).toBe(false);
  expect(watch.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  expect(watch.textContent).toBe('Watch');
});

/** The declarations of the rule in styles/`file` (comments left out) whose selector list holds
 *  `selector`, by property. */
function declarationsOf(file: string, selector: string): Record<string, string> {
  const css = readFileSync(join(__dirname, '../../styles', file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectors.split(',').some((s) => s.trim() === selector)) continue;
    return Object.fromEntries(
      body.split(';').map((d) => d.trim()).filter(Boolean)
        .map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()]));
  }
  throw new Error(`${file} has no rule for ${selector}`);
}

it('is the size of the buttons beside it in a page header: Edit (.btn-solid) and Import assets', () => {
  // A 34px toolbar ghost would read smaller than its siblings. In the header's action row it takes
  // the box metrics `.idet-header-actions .mini-btn` (Import assets) is given to match `.btn-solid`.
  const initiativeAndSite = declarationsOf('notifications.css', '.idet-header-actions .watch-btn');
  const truck = declarationsOf('notifications.css', '.truck-hero-actions .watch-btn');
  const importAssets = declarationsOf('initiatives.css', '.idet-header-actions .mini-btn');
  const edit = declarationsOf('profile.css', '.btn-solid');

  expect(truck).toEqual(initiativeAndSite);
  expect(initiativeAndSite.height).toBe('auto');
  expect(importAssets.height).toBe('auto');
  for (const property of ['padding', 'font-size', 'font-weight']) {
    expect(initiativeAndSite[property], property).toBe(importAssets[property]);
    expect(initiativeAndSite[property], property).toBe(edit[property]);
  }
});

it('reads "Watching", pressed and amber (.on), when the person already watches it', async () => {
  api.getWatchState.mockResolvedValue(WATCHING);
  render(<WatchButton thing="initiative" id={ID} />);
  const watching = await screen.findByRole('button', { name: 'Watching' }) as HTMLButtonElement;

  expect(watching.className).toBe('btn-ghost watch-btn on');
  expect(watching.getAttribute('aria-pressed')).toBe('true');
  expect(watching.getAttribute('title')).toBe('Stop watching');
  expect(watching.textContent).toBe('Watching');
});

it('a click on "Watch" creates the person\'s watch of every event, then reads "Watching"', async () => {
  const user = userEvent.setup();
  render(<WatchButton thing="initiative" id={ID} />);

  await user.click(await screen.findByRole('button', { name: 'Watch' }));

  expect(api.createMyWatch).toHaveBeenCalledTimes(1);
  expect(api.createMyWatch).toHaveBeenCalledWith({ thing: 'initiative', id: ID, kinds: [] });
  const watching = await screen.findByRole('button', { name: 'Watching' });
  expect(watching.getAttribute('aria-pressed')).toBe('true');
  expect(api.deleteMyWatch).not.toHaveBeenCalled();
  expect(toast).not.toHaveBeenCalled();
});

it('a click on "Watching" deletes that watch by its id, then reads "Watch"', async () => {
  api.getWatchState.mockResolvedValue(WATCHING);
  const user = userEvent.setup();
  render(<WatchButton thing="initiative" id={ID} />);

  await user.click(await screen.findByRole('button', { name: 'Watching' }));

  expect(api.deleteMyWatch).toHaveBeenCalledTimes(1);
  expect(api.deleteMyWatch).toHaveBeenCalledWith(WATCH_ID);
  const watch = await screen.findByRole('button', { name: 'Watch' });
  expect(watch.getAttribute('aria-pressed')).toBe('false');
  expect(api.createMyWatch).not.toHaveBeenCalled();
  expect(toast).not.toHaveBeenCalled();
});

it('can watch again after stopping, and stop again after that, using the new watch\'s id', async () => {
  const NEW_ID = '44444444-4444-4444-8444-444444444444';
  api.getWatchState.mockResolvedValue(WATCHING);
  api.createMyWatch.mockResolvedValue({ ...CREATED, id: NEW_ID });
  const user = userEvent.setup();
  render(<WatchButton thing="initiative" id={ID} />);

  await user.click(await screen.findByRole('button', { name: 'Watching' }));
  await user.click(await screen.findByRole('button', { name: 'Watch' }));
  await user.click(await screen.findByRole('button', { name: 'Watching' }));

  expect(api.deleteMyWatch.mock.calls).toEqual([[WATCH_ID], [NEW_ID]]);
  expect(api.createMyWatch).toHaveBeenCalledTimes(1);
});

it('a load failure reads as not watching', async () => {
  api.getWatchState.mockRejectedValue(new Error('Failed to fetch'));
  render(<WatchButton thing="site" id={ID} />);

  const watch = await screen.findByRole('button', { name: 'Watch' });
  expect(watch.getAttribute('aria-pressed')).toBe('false');
  expect(toast).not.toHaveBeenCalled();
});

it('is disabled while its request is on the way, and a second click sends nothing more', async () => {
  const pending = deferred<Watch>();
  api.createMyWatch.mockReturnValue(pending.promise);
  const user = userEvent.setup();
  render(<WatchButton thing="initiative" id={ID} />);

  const watch = await screen.findByRole('button', { name: 'Watch' }) as HTMLButtonElement;
  await user.click(watch);
  await waitFor(() => expect(watch.disabled).toBe(true));
  await user.click(watch);
  expect(api.createMyWatch).toHaveBeenCalledTimes(1);

  await act(async () => { pending.resolve(CREATED); });
  const watching = await screen.findByRole('button', { name: 'Watching' }) as HTMLButtonElement;
  expect(watching.disabled).toBe(false);
});

it('a failed create toasts the plain sentence, leaves the button as it was, and enables it again', async () => {
  api.createMyWatch.mockRejectedValue(new Error('Failed to fetch'));
  const user = userEvent.setup();
  render(<WatchButton thing="initiative" id={ID} />);

  await user.click(await screen.findByRole('button', { name: 'Watch' }));

  await waitFor(() => expect(toast).toHaveBeenCalledWith("Couldn't update your watch."));
  expect(toast).toHaveBeenCalledTimes(1);
  const watch = button('Watch');
  expect(watch.getAttribute('aria-pressed')).toBe('false');
  await waitFor(() => expect(watch.disabled).toBe(false));
  expect(screen.queryByRole('button', { name: 'Watching' })).toBeNull();
});

it('a failed delete toasts, leaves the button on "Watching", and enables it again', async () => {
  api.getWatchState.mockResolvedValue(WATCHING);
  api.deleteMyWatch.mockRejectedValue(new Error('Failed to fetch'));
  const user = userEvent.setup();
  render(<WatchButton thing="initiative" id={ID} />);

  await user.click(await screen.findByRole('button', { name: 'Watching' }));

  await waitFor(() => expect(toast).toHaveBeenCalledWith("Couldn't update your watch."));
  const watching = button('Watching');
  expect(watching.getAttribute('aria-pressed')).toBe('true');
  await waitFor(() => expect(watching.disabled).toBe(false));
});

it('read-only maintenance toasts the error\'s own message', async () => {
  api.createMyWatch.mockRejectedValue(
    new ApiError(423, 'read_only_mode', { code: 'read_only_mode' }, READ_ONLY_MESSAGE));
  const user = userEvent.setup();
  render(<WatchButton thing="initiative" id={ID} />);

  await user.click(await screen.findByRole('button', { name: 'Watch' }));

  await waitFor(() => expect(toast).toHaveBeenCalledWith(READ_ONLY_MESSAGE));
  expect(toast).toHaveBeenCalledTimes(1);
  expect(button('Watch').getAttribute('aria-pressed')).toBe('false');
  expect(api.getWatchState).toHaveBeenCalledTimes(1);          // only the first read: nothing to correct
});

it('already_watching reads the state again and shows it, with no toast', async () => {
  // The watch was made somewhere else after the page loaded: the button said "Watch".
  api.getWatchState.mockResolvedValueOnce(NOT_WATCHING).mockResolvedValueOnce(WATCHING);
  api.createMyWatch.mockRejectedValue(new ApiError(409, 'already_watching'));
  const user = userEvent.setup();
  render(<WatchButton thing="truck" id={ID} />);

  await user.click(await screen.findByRole('button', { name: 'Watch' }));

  const watching = await screen.findByRole('button', { name: 'Watching' }) as HTMLButtonElement;
  expect(watching.getAttribute('aria-pressed')).toBe('true');
  await waitFor(() => expect(watching.disabled).toBe(false));
  expect(api.getWatchState.mock.calls).toEqual([['truck', ID], ['truck', ID]]);
  expect(toast).not.toHaveBeenCalled();
  // and the next click stops that watch, by the id the second read gave
  await user.click(watching);
  await waitFor(() => expect(api.deleteMyWatch).toHaveBeenCalledWith(WATCH_ID));
});

it('watch_not_found reads the state again and shows it, with no toast', async () => {
  // The watch was ended somewhere else after the page loaded: the button said "Watching".
  api.getWatchState.mockResolvedValueOnce(WATCHING).mockResolvedValueOnce(NOT_WATCHING);
  api.deleteMyWatch.mockRejectedValue(new ApiError(404, 'watch_not_found'));
  const user = userEvent.setup();
  render(<WatchButton thing="site" id={ID} />);

  await user.click(await screen.findByRole('button', { name: 'Watching' }));

  const watch = await screen.findByRole('button', { name: 'Watch' }) as HTMLButtonElement;
  expect(watch.getAttribute('aria-pressed')).toBe('false');
  await waitFor(() => expect(watch.disabled).toBe(false));
  expect(api.getWatchState.mock.calls).toEqual([['site', ID], ['site', ID]]);
  expect(toast).not.toHaveBeenCalled();
});

it('stays disabled while the state is read again, and is enabled when it is shown', async () => {
  const reread = deferred<WatchState>();
  api.getWatchState.mockResolvedValueOnce(NOT_WATCHING).mockReturnValueOnce(reread.promise);
  api.createMyWatch.mockRejectedValue(new ApiError(409, 'already_watching'));
  const user = userEvent.setup();
  render(<WatchButton thing="initiative" id={ID} />);
  const watch = await screen.findByRole('button', { name: 'Watch' }) as HTMLButtonElement;

  await user.click(watch);
  await waitFor(() => expect(api.getWatchState).toHaveBeenCalledTimes(2));

  expect(watch.disabled).toBe(true);
  await user.click(watch);
  expect(api.createMyWatch).toHaveBeenCalledTimes(1);
  await act(async () => { reread.resolve(WATCHING); });
  const watching = await screen.findByRole('button', { name: 'Watching' }) as HTMLButtonElement;
  expect(watching.disabled).toBe(false);
});

it('a state that cannot be read again toasts the plain sentence and leaves the button as it was', async () => {
  api.getWatchState.mockResolvedValueOnce(NOT_WATCHING).mockRejectedValueOnce(new Error('Failed to fetch'));
  api.createMyWatch.mockRejectedValue(new ApiError(409, 'already_watching'));
  const user = userEvent.setup();
  render(<WatchButton thing="initiative" id={ID} />);

  await user.click(await screen.findByRole('button', { name: 'Watch' }));

  await waitFor(() => expect(toast).toHaveBeenCalledWith("Couldn't update your watch."));
  expect(toast).toHaveBeenCalledTimes(1);
  const watch = button('Watch');
  expect(watch.getAttribute('aria-pressed')).toBe('false');
  await waitFor(() => expect(watch.disabled).toBe(false));
});

it('drops the state it read again when the page has moved to another thing meanwhile', async () => {
  const reread = deferred<WatchState>();
  api.getWatchState.mockResolvedValueOnce(NOT_WATCHING).mockReturnValueOnce(reread.promise)
    .mockResolvedValueOnce(NOT_WATCHING);
  api.createMyWatch.mockRejectedValue(new ApiError(409, 'already_watching'));
  const user = userEvent.setup();
  const { rerender } = render(<WatchButton thing="initiative" id={ID} />);
  await user.click(await screen.findByRole('button', { name: 'Watch' }));
  await waitFor(() => expect(api.getWatchState).toHaveBeenCalledTimes(2));

  rerender(<WatchButton thing="initiative" id={OTHER_ID} />);
  const other = await screen.findByRole('button', { name: 'Watch' }) as HTMLButtonElement;
  await act(async () => { reread.resolve(WATCHING); });     // the first thing's state, late

  expect(other.getAttribute('aria-pressed')).toBe('false');
  expect(other.disabled).toBe(false);
  expect(screen.queryByRole('button', { name: 'Watching' })).toBeNull();
  expect(toast).not.toHaveBeenCalled();
});

it('does not read the state of a thing the page has already left when its request is refused', async () => {
  const pending = deferred<Watch>();
  api.createMyWatch.mockReturnValue(pending.promise);
  const user = userEvent.setup();
  const { rerender } = render(<WatchButton thing="initiative" id={ID} />);
  await user.click(await screen.findByRole('button', { name: 'Watch' }));

  rerender(<WatchButton thing="initiative" id={OTHER_ID} />);
  await screen.findByRole('button', { name: 'Watch' });
  await act(async () => { pending.reject(new ApiError(409, 'already_watching')); });

  // the first thing's read, then the other's: nothing more
  expect(api.getWatchState.mock.calls).toEqual([['initiative', ID], ['initiative', OTHER_ID]]);
  expect(toast).not.toHaveBeenCalled();
});

it('any other API error toasts the plain sentence, not its code', async () => {
  api.createMyWatch.mockRejectedValue(new ApiError(404, 'thing_not_found'));
  const user = userEvent.setup();
  render(<WatchButton thing="site" id={ID} />);

  await user.click(await screen.findByRole('button', { name: 'Watch' }));

  await waitFor(() => expect(toast).toHaveBeenCalledWith("Couldn't update your watch."));
  expect(toast).toHaveBeenCalledTimes(1);
  expect(button('Watch').getAttribute('aria-pressed')).toBe('false');
  expect(api.getWatchState).toHaveBeenCalledTimes(1);          // not a case for reading the state again
});

it('a refused delete other than watch_not_found toasts the plain sentence and keeps "Watching"', async () => {
  api.getWatchState.mockResolvedValue(WATCHING);
  api.deleteMyWatch.mockRejectedValue(new ApiError(500, 'server_error'));
  const user = userEvent.setup();
  render(<WatchButton thing="initiative" id={ID} />);

  await user.click(await screen.findByRole('button', { name: 'Watching' }));

  await waitFor(() => expect(toast).toHaveBeenCalledWith("Couldn't update your watch."));
  expect(button('Watching').getAttribute('aria-pressed')).toBe('true');
  expect(api.getWatchState).toHaveBeenCalledTimes(1);
});

it('reads the state again for another thing, and is gone until that is known', async () => {
  const next = deferred<WatchState>();
  const { rerender, container } = render(<WatchButton thing="initiative" id={ID} />);
  await screen.findByRole('button', { name: 'Watch' });

  api.getWatchState.mockReturnValue(next.promise);
  rerender(<WatchButton thing="initiative" id={OTHER_ID} />);

  expect(api.getWatchState).toHaveBeenLastCalledWith('initiative', OTHER_ID);
  expect(container.innerHTML).toBe('');
  await act(async () => { next.resolve(WATCHING); });
  expect(button('Watching')).toBeTruthy();
});

it('drops the state answer of the thing it was on when the page has moved to another', async () => {
  const first = deferred<WatchState>();
  const second = deferred<WatchState>();
  api.getWatchState.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const { rerender } = render(<WatchButton thing="initiative" id={ID} />);
  rerender(<WatchButton thing="initiative" id={OTHER_ID} />);

  await act(async () => { second.resolve(NOT_WATCHING); });
  await screen.findByRole('button', { name: 'Watch' });
  await act(async () => { first.resolve(WATCHING); });          // late answer for the first thing

  expect(button('Watch').getAttribute('aria-pressed')).toBe('false');
  expect(screen.queryByRole('button', { name: 'Watching' })).toBeNull();
});

it('drops a create that comes back after the page has moved to another thing', async () => {
  const pending = deferred<Watch>();
  api.createMyWatch.mockReturnValue(pending.promise);
  const user = userEvent.setup();
  const { rerender } = render(<WatchButton thing="initiative" id={ID} />);
  await user.click(await screen.findByRole('button', { name: 'Watch' }));

  rerender(<WatchButton thing="initiative" id={OTHER_ID} />);
  const other = await screen.findByRole('button', { name: 'Watch' }) as HTMLButtonElement;
  await act(async () => { pending.resolve(CREATED); });       // the first thing's watch, done late

  expect(other.getAttribute('aria-pressed')).toBe('false');
  expect(other.disabled).toBe(false);
  expect(screen.queryByRole('button', { name: 'Watching' })).toBeNull();
});

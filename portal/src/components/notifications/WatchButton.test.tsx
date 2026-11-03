// @vitest-environment jsdom
/**
 * WatchButton — the Watch / Watching toggle on an initiative, site or truck page.
 * It reads whether the person watches the thing themselves (a group's watch of it
 * does not count), renders nothing until that is known, and toggles their own watch.
 */

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
  expect(button('Watch').getAttribute('aria-pressed')).toBe('false');
});

it('already_watching toasts that, and leaves the button as it was', async () => {
  api.createMyWatch.mockRejectedValue(new ApiError(409, 'already_watching'));
  const user = userEvent.setup();
  render(<WatchButton thing="truck" id={ID} />);

  await user.click(await screen.findByRole('button', { name: 'Watch' }));

  await waitFor(() => expect(toast).toHaveBeenCalledWith("You're already watching this."));
  expect(button('Watch').getAttribute('aria-pressed')).toBe('false');
});

it('any other API error toasts the house fallback with its code', async () => {
  api.createMyWatch.mockRejectedValue(new ApiError(404, 'thing_not_found'));
  const user = userEvent.setup();
  render(<WatchButton thing="site" id={ID} />);

  await user.click(await screen.findByRole('button', { name: 'Watch' }));

  await waitFor(() => expect(toast).toHaveBeenCalledWith('Request failed (thing_not_found).'));
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

// @vitest-environment jsdom
/** Settings › RFID: the Dock's Crate window row — loads from the edge,
 *  saves on blur or Enter under the signed-in role's rule (admins whole
 *  seconds 1–10, developers above 0 up to 3600), locked for everyone else. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({
  getDockWindow: vi.fn(),
  saveDockWindow: vi.fn(),
}));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, ...apiMock };
});

const auth = vi.hoisted(() => ({ status: 'authed', isAdmin: true, isDeveloper: false }));
vi.mock('../auth/KioskAuthContext', () => ({ useKioskAuth: () => auth }));

import { ApiError } from '../lib/api';
import RfidPanel from './RfidPanel';

const HINT = 'Devices read within this many seconds before or after a crate tag go into that crate. '
  + 'Two crates read within twice this time are both flagged, and nothing in them packs. '
  + 'A change applies from the next crate.';
const ADMIN_INVALID = 'Enter a whole number of seconds from 1 to 10.';
const DEV_INVALID = 'Enter a number of seconds above 0, up to 3600.';
const LOCKED = 'Only an admin can change this.';
const SAVE_FAILED = "Couldn't save the crate window. The last saved value is still in use.";

async function flush() {
  await act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); });
}

function field() {
  return screen.getByLabelText('Crate window in seconds') as HTMLInputElement;
}

async function renderPanel(saved = 5) {
  apiMock.getDockWindow.mockResolvedValue({ window_s: saved });
  render(<RfidPanel />);
  await flush();
}

function typeAndBlur(value: string) {
  fireEvent.change(field(), { target: { value } });
  fireEvent.blur(field());
}

beforeEach(() => {
  auth.status = 'authed';
  auth.isAdmin = true;
  auth.isDeveloper = false;
  apiMock.saveDockWindow.mockImplementation(async (n: number) => ({ window_s: n }));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('shows the saved window and its hint', async () => {
  await renderPanel(5);
  expect(apiMock.getDockWindow).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Crate window')).toBeTruthy();
  expect(field().value).toBe('5');
  expect(field().disabled).toBe(false);
  expect(screen.getByText('seconds')).toBeTruthy();
  expect(screen.getByText(HINT)).toBeTruthy();
  expect(screen.queryByText(LOCKED)).toBeNull();
});

it('an admin saves a whole number from 1 to 10 on blur and on Enter', async () => {
  await renderPanel(5);
  typeAndBlur('7');
  await flush();
  expect(apiMock.saveDockWindow).toHaveBeenCalledTimes(1);
  expect(apiMock.saveDockWindow).toHaveBeenLastCalledWith(7);

  fireEvent.change(field(), { target: { value: '3' } });
  fireEvent.keyDown(field(), { key: 'Enter' });
  await flush();
  expect(apiMock.saveDockWindow).toHaveBeenCalledTimes(2);
  expect(apiMock.saveDockWindow).toHaveBeenLastCalledWith(3);
  expect(field().value).toBe('3');
});

it("an admin can't save 0.5, 11 or text, and sees why", async () => {
  await renderPanel(5);
  for (const bad of ['0.5', '11', 'abc', '', '0']) {
    typeAndBlur(bad);
    await flush();
    expect(apiMock.saveDockWindow).not.toHaveBeenCalled();
    expect(screen.getByText(ADMIN_INVALID)).toBeTruthy();
    expect(field().getAttribute('aria-invalid')).toBe('true');
  }
  typeAndBlur('10');
  await flush();
  expect(apiMock.saveDockWindow).toHaveBeenCalledWith(10);
  expect(screen.queryByText(ADMIN_INVALID)).toBeNull();
});

it("a developer can save 0.5 and 30 but not 0 or 3601", async () => {
  auth.isDeveloper = true;
  await renderPanel(5);
  typeAndBlur('0.5');
  await flush();
  expect(apiMock.saveDockWindow).toHaveBeenLastCalledWith(0.5);
  expect(field().value).toBe('0.5');
  typeAndBlur('30');
  await flush();
  expect(apiMock.saveDockWindow).toHaveBeenLastCalledWith(30);
  expect(apiMock.saveDockWindow).toHaveBeenCalledTimes(2);

  for (const bad of ['0', '3601', 'abc', '-1']) {
    typeAndBlur(bad);
    await flush();
    expect(screen.getByText(DEV_INVALID)).toBeTruthy();
  }
  expect(apiMock.saveDockWindow).toHaveBeenCalledTimes(2);
  typeAndBlur('3600');
  await flush();
  expect(apiMock.saveDockWindow).toHaveBeenLastCalledWith(3600);
});

it("an admin sees a developer's value and leaving it saves nothing", async () => {
  await renderPanel(30);
  expect(field().value).toBe('30');
  expect(field().disabled).toBe(false);
  fireEvent.focus(field());
  fireEvent.blur(field());
  fireEvent.keyDown(field(), { key: 'Enter' });
  await flush();
  expect(apiMock.saveDockWindow).not.toHaveBeenCalled();
  expect(screen.queryByText(ADMIN_INVALID)).toBeNull();
  expect(field().getAttribute('aria-invalid')).toBeNull();
});

it('a worker sees the value locked', async () => {
  auth.isAdmin = false;
  await renderPanel(5);
  expect(field().value).toBe('5');
  expect(field().disabled).toBe(true);
  expect(screen.getByText(LOCKED)).toBeTruthy();
  fireEvent.keyDown(field(), { key: 'Enter' });
  fireEvent.blur(field());
  await flush();
  expect(apiMock.saveDockWindow).not.toHaveBeenCalled();
});

it('a failed save restores the last saved value and says so', async () => {
  await renderPanel(5);
  apiMock.saveDockWindow.mockRejectedValueOnce(new Error('offline'));
  typeAndBlur('8');
  await flush();
  expect(field().value).toBe('5');
  expect(screen.getByRole('alert').textContent).toBe(SAVE_FAILED);

  // A fresh edit clears the message and saves.
  typeAndBlur('9');
  await flush();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(field().value).toBe('9');
});

it('a 403 says only an admin can change this', async () => {
  await renderPanel(5);
  apiMock.saveDockWindow.mockRejectedValueOnce(new ApiError(403, 'forbidden'));
  typeAndBlur('8');
  await flush();
  expect(field().value).toBe('5');
  expect(screen.getByRole('alert').textContent).toBe(LOCKED);
});

it('a failed read leaves the field disabled and says so', async () => {
  apiMock.getDockWindow.mockRejectedValue(new Error('401'));
  render(<RfidPanel />);
  await flush();
  expect(field().disabled).toBe(true);
  expect(screen.getByRole('alert').textContent)
    .toBe("Couldn't read the crate window from this laptop.");
  fireEvent.keyDown(field(), { key: 'Enter' });
  await flush();
  expect(apiMock.saveDockWindow).not.toHaveBeenCalled();
});

it('the field stays disabled until the window loads', async () => {
  let finish: (v: unknown) => void = () => undefined;
  apiMock.getDockWindow.mockImplementation(() => new Promise((done) => { finish = done; }));
  render(<RfidPanel />);
  await flush();
  expect(field().disabled).toBe(true);
  await act(async () => { finish({ window_s: 6 }); });
  await flush();
  expect(field().disabled).toBe(false);
  expect(field().value).toBe('6');
});

it('a stale save result never overwrites a newer save', async () => {
  const pending: { ok: (v: unknown) => void; fail: (e: unknown) => void }[] = [];
  apiMock.saveDockWindow.mockImplementation(() => new Promise((ok, fail) => {
    pending.push({ ok, fail });
  }));
  await renderPanel(5);
  typeAndBlur('6');   // save 1
  typeAndBlur('7');   // save 2 (newer)
  expect(apiMock.saveDockWindow).toHaveBeenCalledTimes(2);
  await act(async () => { pending[1].ok({ window_s: 7 }); });
  await act(async () => { pending[0].fail(new Error('offline')); });
  await flush();
  expect(field().value).toBe('7');
  expect(screen.queryByRole('alert')).toBeNull();
});

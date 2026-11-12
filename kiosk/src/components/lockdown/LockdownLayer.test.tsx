// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const helper = vi.hoisted(() => ({
  available: true,
  exitKiosk: vi.fn(),
}));
vi.mock('../../lib/hostHelper', async (orig) => ({
  ...(await orig<typeof import('../../lib/hostHelper')>()),
  lockdownAvailable: () => helper.available,
  exitKiosk: helper.exitKiosk,
}));

import { HelperError } from '../../lib/hostHelper';
import LockdownLayer from './LockdownLayer';

beforeEach(() => {
  helper.available = true;
  helper.exitKiosk.mockReset();
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const esc = () => act(() => {
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
});

it('Esc opens the PIN pad; a wrong PIN says so; the right one closes the kiosk', async () => {
  render(<LockdownLayer />);
  expect(screen.queryByRole('dialog')).toBeNull();
  esc();
  const dialog = screen.getByRole('dialog', { name: 'Exit the kiosk' });
  expect(dialog.closest('.kiosk-pin-host')).not.toBeNull();
  helper.exitKiosk.mockRejectedValueOnce(new HelperError('wrong_pin'));
  await userEvent.type(screen.getByLabelText('PIN'), 'abc');
  await userEvent.click(screen.getByRole('button', { name: 'Exit kiosk' }));
  expect((await screen.findByRole('alert')).textContent).toBe("That PIN isn't right.");
  expect((screen.getByLabelText('PIN') as HTMLInputElement).value).toBe('');
  helper.exitKiosk.mockResolvedValueOnce({ ok: true });
  await userEvent.type(screen.getByLabelText('PIN'), 'csg');
  await userEvent.click(screen.getByRole('button', { name: 'Exit kiosk' }));
  expect(helper.exitKiosk).toHaveBeenLastCalledWith('csg');
  expect((await screen.findByRole('status')).textContent).toBe('Closing the kiosk…');
});

it('Esc closes the PIN pad instead of opening a second one', () => {
  render(<LockdownLayer />);
  esc();
  esc();
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('renders nothing off a Linux laptop', () => {
  helper.available = false;
  render(<LockdownLayer />);
  esc();
  expect(screen.queryByRole('dialog')).toBeNull();
});

const pinField = () => screen.getByLabelText('PIN') as HTMLInputElement;

it('Cancel, the close button and a scrim click each close the PIN pad', async () => {
  render(<LockdownLayer />);
  esc();
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  esc();
  await userEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  esc();
  const scrim = screen.getByRole('dialog').closest('.modal-scrim') as HTMLElement;
  fireEvent.mouseDown(scrim);
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('a helper that does not answer gets the unreachable copy', async () => {
  render(<LockdownLayer />);
  esc();
  helper.exitKiosk.mockRejectedValueOnce(new HelperError('unreachable'));
  await userEvent.type(pinField(), 'csg{Enter}');
  expect((await screen.findByRole('alert')).textContent)
    .toBe("Couldn't reach the kiosk helper. Press Alt+F4 to close this window.");
});

it('a stale token (forbidden) says to close the window instead of retrying', async () => {
  render(<LockdownLayer />);
  esc();
  helper.exitKiosk.mockRejectedValueOnce(new HelperError('forbidden'));
  await userEvent.type(pinField(), 'csg{Enter}');
  expect((await screen.findByRole('alert')).textContent)
    .toBe('This kiosk window is out of date. Close it with Alt+F4 and it will reopen.');
});

it('Esc is ignored while the request is in flight', async () => {
  render(<LockdownLayer />);
  esc();
  let reject!: (e: unknown) => void;
  helper.exitKiosk.mockReturnValueOnce(new Promise((_, r) => { reject = r; }));
  await userEvent.type(pinField(), 'csg{Enter}');
  esc();
  expect(screen.getByRole('dialog')).toBeTruthy();
  await act(async () => { reject(new HelperError('wrong_pin')); });
  await screen.findByRole('alert');
});

it('focus stays in the PIN field after a failed attempt, so the retry is typed there', async () => {
  render(<LockdownLayer />);
  esc();
  helper.exitKiosk.mockRejectedValueOnce(new HelperError('wrong_pin'));
  await userEvent.type(pinField(), 'abc{Enter}');
  await screen.findByRole('alert');
  expect(document.activeElement).toBe(pinField());
  // Submitting with the button moves focus to it; the error still brings
  // focus back to the field.
  helper.exitKiosk.mockRejectedValueOnce(new HelperError('wrong_pin'));
  await userEvent.keyboard('abd');
  await userEvent.click(screen.getByRole('button', { name: 'Exit kiosk' }));
  await waitFor(() => expect(helper.exitKiosk).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(document.activeElement).toBe(pinField()));
  helper.exitKiosk.mockResolvedValueOnce({ ok: true });
  await userEvent.keyboard('csg{Enter}');          // no click on the field first
  expect(helper.exitKiosk).toHaveBeenLastCalledWith('csg');
});

it('re-enables Cancel and says so when the kiosk has not closed after 10 s', async () => {
  vi.useFakeTimers();
  try {
    render(<LockdownLayer />);
    esc();
    helper.exitKiosk.mockResolvedValueOnce({ ok: true });
    fireEvent.change(pinField(), { target: { value: 'csg' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Exit kiosk' })); });
    expect(screen.getByRole('status').textContent).toBe('Closing the kiosk…');
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(screen.getByRole('alert').textContent).toBe("The kiosk didn't close. Try again.");
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it('returns focus to where it was on close, and traps Tab inside the dialog', async () => {
  const before = document.createElement('button');
  before.textContent = 'behind';
  document.body.appendChild(before);
  before.focus();
  render(<LockdownLayer />);
  esc();
  expect(document.activeElement).toBe(pinField());
  await userEvent.type(pinField(), 'x');
  const dialog = screen.getByRole('dialog');
  for (let i = 0; i < 6; i += 1) {
    await userEvent.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
  }
  await userEvent.tab({ shift: true });
  expect(dialog.contains(document.activeElement)).toBe(true);
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(document.activeElement).toBe(before);
  before.remove();
});

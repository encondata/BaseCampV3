// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
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

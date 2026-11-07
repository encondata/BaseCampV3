// @vitest-environment jsdom
/** Clear Setup's confirm step: what it says will go and stay, the unsent
 *  count, and what happens on Clear, Cancel and a failed laptop wipe. */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  heartbeatNow: vi.fn(() => Promise.resolve()),
  logout: vi.fn(() => Promise.resolve()),
}));
vi.mock('../auth/KioskAuthContext', () => ({ useKioskAuth: () => auth }));

const reset = vi.hoisted(() => ({
  countUnsent: vi.fn(() => Promise.resolve(0)),
  runClearSetup: vi.fn(() => Promise.resolve()),
}));
vi.mock('../lib/factoryReset', () => reset);

const platform = vi.hoisted(() => ({ laptop: false }));
vi.mock('../lib/platform', async (importActual) => ({
  ...(await importActual<typeof import('../lib/platform')>()),
  isLaptop: () => platform.laptop,
}));

import ClearSetupModal from './ClearSetupModal';

beforeEach(() => {
  platform.laptop = false;
  reset.countUnsent.mockReset().mockResolvedValue(0);
  reset.runClearSetup.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

it('says what goes and what stays', async () => {
  render(<ClearSetupModal onClose={vi.fn()} onDone={vi.fn()} />);
  expect(screen.getByRole('dialog', { name: 'Clear Setup' })).toBeTruthy();
  expect(screen.getByText('The setup: move, site, scan type and station.')).toBeTruthy();
  expect(screen.getByText(/All local data/)).toBeTruthy();
  expect(screen.getByText(/Every setting, back to its default, here and in the portal/)).toBeTruthy();
  expect(screen.getByText(/name and serial, so the portal still sees the same kiosk/)).toBeTruthy();
  expect(await screen.findByText('No unsent scans.')).toBeTruthy();
  // the laptop's own data is only mentioned on a laptop
  expect(screen.queryByText(/On this laptop/)).toBeNull();
});

it('warns how many unsent scans will be erased', async () => {
  reset.countUnsent.mockResolvedValue(3);
  render(<ClearSetupModal onClose={vi.fn()} onDone={vi.fn()} />);
  expect(await screen.findByText('3 unsent scans will be erased.')).toBeTruthy();
});

it('says the laptop is cleared too, on a laptop', async () => {
  platform.laptop = true;
  render(<ClearSetupModal onClose={vi.fn()} onDone={vi.fn()} />);
  expect(screen.getByText(/On this laptop, its own copy of the move/)).toBeTruthy();
  await screen.findByText('No unsent scans.');
});

it('Clear Setup stays disabled until the unsent count is known, and Cancel is the focus', async () => {
  let release: (n: number) => void = () => {};
  reset.countUnsent.mockReturnValue(new Promise((r) => { release = r; }));
  render(<ClearSetupModal onClose={vi.fn()} onDone={vi.fn()} />);
  const clear = screen.getByRole('button', { name: 'Clear Setup' }) as HTMLButtonElement;
  expect(clear.disabled).toBe(true);
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
  release(0);
  await screen.findByText('No unsent scans.');
  expect(clear.disabled).toBe(false);
});

it('Cancel closes without clearing anything', async () => {
  const onClose = vi.fn();
  render(<ClearSetupModal onClose={onClose} onDone={vi.fn()} />);
  await screen.findByText('No unsent scans.');
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onClose).toHaveBeenCalled();
  expect(reset.runClearSetup).not.toHaveBeenCalled();
});

it('Clear Setup runs the reset with the session’s report and sign-out, then leaves', async () => {
  const onDone = vi.fn();
  render(<ClearSetupModal onClose={vi.fn()} onDone={onDone} />);
  await screen.findByText('No unsent scans.');
  await userEvent.click(screen.getByRole('button', { name: 'Clear Setup' }));
  expect(reset.runClearSetup).toHaveBeenCalledWith({ heartbeatNow: auth.heartbeatNow, logout: auth.logout });
  expect(onDone).toHaveBeenCalled();
});

it('a failed laptop wipe says what happened and lets them try again', async () => {
  reset.runClearSetup.mockRejectedValueOnce(new Error('edge down'));
  const onDone = vi.fn();
  render(<ClearSetupModal onClose={vi.fn()} onDone={onDone} />);
  await screen.findByText('No unsent scans.');
  await userEvent.click(screen.getByRole('button', { name: 'Clear Setup' }));
  expect(await screen.findByText(/Couldn't clear the laptop, so its setup and data were left as they were/)).toBeTruthy();
  expect(onDone).not.toHaveBeenCalled();
  expect((screen.getByRole('button', { name: 'Clear Setup' }) as HTMLButtonElement).disabled).toBe(false);
});

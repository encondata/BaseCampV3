// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  totpRegenerateBackupCodes: vi.fn(async () => ({
    backup_codes: ['aaaaa-11111', 'bbbbb-22222', 'ccccc-33333', 'ddddd-44444',
                   'eeeee-55555', 'fffff-66666', 'ggggg-77777', 'hhhhh-88888'],
  })),
  ApiError: class ApiError extends Error { constructor(public status: number, public code: string) { super(code); } },
}));
vi.mock('../../lib/api', () => api);

const { default: RegenerateCodesModal } = await import('./RegenerateCodesModal');

afterEach(() => {
  cleanup();
  api.totpRegenerateBackupCodes.mockClear();
});

it('has a dialog role and label', () => {
  render(<RegenerateCodesModal onClose={() => {}} onRegenerated={() => {}} />);
  expect(screen.getByRole('dialog', { name: /regenerate backup codes/i })).toBeTruthy();
});

it('before submitting, a scrim mousedown closes the modal', () => {
  const onClose = vi.fn();
  const { container } = render(<RegenerateCodesModal onClose={onClose} onRegenerated={() => {}} />);
  const scrim = container.querySelector('.modal-scrim') as HTMLElement;
  fireEvent.mouseDown(scrim, { target: scrim });
  expect(onClose).toHaveBeenCalled();
});

it('a wrong code shows the error and keeps the modal open', async () => {
  const user = userEvent.setup();
  api.totpRegenerateBackupCodes.mockRejectedValueOnce(new api.ApiError(400, 'totp_invalid'));
  const onClose = vi.fn();
  render(<RegenerateCodesModal onClose={onClose} onRegenerated={() => {}} />);
  await user.type(screen.getAllByRole('textbox')[0], '000000');
  expect(await screen.findByText(/didn.t match/i)).toBeTruthy();
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog', { name: /regenerate backup codes/i })).toBeTruthy();
});

it('a right code shows the codes, blocks dismissal, and reports the count on Done', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const onRegenerated = vi.fn();
  const { container } = render(<RegenerateCodesModal onClose={onClose} onRegenerated={onRegenerated} />);
  await user.type(screen.getAllByRole('textbox')[0], '123456');
  await waitFor(() => expect(api.totpRegenerateBackupCodes).toHaveBeenCalledWith('123456'));
  expect(await screen.findByText('aaaaa-11111')).toBeTruthy();

  // Close button is gone once codes are showing.
  expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();

  // A scrim click is ignored while the codes are on screen.
  const scrim = container.querySelector('.modal-scrim') as HTMLElement;
  fireEvent.mouseDown(scrim, { target: scrim });
  expect(onClose).not.toHaveBeenCalled();

  // userEvent.setup() attaches a getter-only navigator.clipboard stub, so
  // Object.assign would throw here — redefine the property instead (same
  // workaround as TotpEnrollModal.test.tsx / EnrollFlow.test.tsx).
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn(async () => {}) }, configurable: true, writable: true,
  });
  fireEvent.click(screen.getByRole('button', { name: /copy/i }));
  const done = screen.getByRole('button', { name: /done/i });
  await waitFor(() => expect((done as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(done);
  expect(onRegenerated).toHaveBeenCalledWith(8);
});

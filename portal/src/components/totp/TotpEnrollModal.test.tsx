// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  totpEnrollStart: vi.fn(async () => ({ secret: 'JBSWY3DPEHPK3PXP', otpauth_uri: 'otpauth://x' })),
  totpEnrollConfirm: vi.fn(async () => ({ backup_codes: ['aaaaa-bbbbb'], session: null })),
  ApiError: class ApiError extends Error { constructor(public status: number, public code: string) { super(code); } },
}));
vi.mock('../../lib/api', () => api);
vi.mock('../../lib/qr', () => ({ qrDataUrl: () => 'data:qr' }));

const { default: TotpEnrollModal } = await import('./TotpEnrollModal');

afterEach(cleanup);

it('has the report-generate header, walks the flow, and reports enrollment', async () => {
  const user = userEvent.setup();
  const onEnrolled = vi.fn();
  render(<TotpEnrollModal email="ada@x.test" onClose={() => {}} onEnrolled={onEnrolled} />);
  expect(screen.getByText('Security')).toBeTruthy();           // eyebrow
  expect(screen.getByRole('heading', { name: /set up two-factor/i })).toBeTruthy();
  expect(screen.getByRole('dialog', { name: /set up two-factor authentication/i })).toBeTruthy();
  await waitFor(() => expect(api.totpEnrollStart).toHaveBeenCalledWith());
  await user.type(screen.getAllByRole('textbox')[0], '123456');
  await waitFor(() => expect(api.totpEnrollConfirm).toHaveBeenCalledWith('123456', {}));
  expect(await screen.findByText('aaaaa-bbbbb')).toBeTruthy();

  // Once codes are on screen, the X close button is gone — Done is the
  // only way out.
  expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();

  // userEvent.setup() attaches a getter-only navigator.clipboard stub, so
  // Object.assign would throw here — redefine the property instead (same
  // workaround as EnrollFlow.test.tsx).
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn(async () => {}) }, configurable: true, writable: true,
  });
  fireEvent.click(screen.getByRole('button', { name: /copy/i }));
  const done = screen.getByRole('button', { name: /done/i });
  await waitFor(() => expect((done as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(done);
  expect(onEnrolled).toHaveBeenCalledWith(1);
});

it('ignores a scrim click once backup codes are showing', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const { container } = render(<TotpEnrollModal email="ada@x.test" onClose={onClose} onEnrolled={() => {}} />);
  await waitFor(() => expect(api.totpEnrollStart).toHaveBeenCalledWith());
  await user.type(screen.getAllByRole('textbox')[0], '123456');
  expect(await screen.findByText('aaaaa-bbbbb')).toBeTruthy();

  const scrim = container.querySelector('.modal-scrim') as HTMLElement;
  fireEvent.mouseDown(scrim, { target: scrim });
  expect(onClose).not.toHaveBeenCalled();
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../../lib/qr', () => ({ qrDataUrl: (t: string) => `data:qr,${encodeURIComponent(t)}` }));

import EnrollFlow from './EnrollFlow';

afterEach(cleanup);

it('walks Scan → Confirm → Save codes and acknowledges', async () => {
  const user = userEvent.setup();
  const start = vi.fn(async () => ({ secret: 'JBSWY3DPEHPK3PXP', otpauth_uri: 'otpauth://totp/x' }));
  const confirm = vi.fn(async () => ({ backup_codes: ['aaaaa-bbbbb', 'ccccc-ddddd'] }));
  const done = vi.fn();
  render(<EnrollFlow email="ada@x.test" start={start} confirm={confirm} onDone={done} />);
  await waitFor(() => expect(start).toHaveBeenCalled());
  expect((screen.getByAltText(/scan this/i) as HTMLImageElement).src).toContain('otpauth');
  expect(screen.getByText(/JBSW Y3DP EHPK 3PXP/)).toBeTruthy();
  const boxes = screen.getAllByRole('textbox');
  await user.type(boxes[0], '123456');
  await waitFor(() => expect(confirm).toHaveBeenCalledWith('123456'));
  expect(await screen.findByText('aaaaa-bbbbb')).toBeTruthy();
  const ack = screen.getByRole('button', { name: /saved my codes/i }) as HTMLButtonElement;
  expect(ack.disabled).toBe(true);
  // userEvent.setup() attaches a getter-only navigator.clipboard stub, so
  // Object.assign would throw here — redefine the property instead.
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn(async () => {}) }, configurable: true, writable: true,
  });
  fireEvent.click(screen.getByRole('button', { name: /copy/i }));
  await waitFor(() => expect(ack.disabled).toBe(false));
  fireEvent.click(ack);
  expect(done).toHaveBeenCalled();
});

it('a wrong confirm code shows the error and keeps the QR step reachable', async () => {
  const user = userEvent.setup();
  const err = Object.assign(new Error('x'), { code: 'totp_invalid' });
  const start = vi.fn(async () => ({ secret: 'S', otpauth_uri: 'otpauth://totp/x' }));
  const confirm = vi.fn(async () => { throw err; });
  render(<EnrollFlow email="a@x" start={start} confirm={confirm} onDone={() => {}} />);
  await waitFor(() => expect(start).toHaveBeenCalled());
  await user.type(screen.getAllByRole('textbox')[0], '000000');
  expect(await screen.findByText(/didn.t match/i)).toBeTruthy();
});

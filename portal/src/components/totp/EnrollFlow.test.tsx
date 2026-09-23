// @vitest-environment jsdom
import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../../lib/qr', () => ({ qrDataUrl: (t: string) => `data:qr,${encodeURIComponent(t)}` }));

// The module is NOT mocked wholesale here — EnrollFlow.tsx reads
// `err instanceof ApiError`, so tests throw the real class too, same as
// Login.test.tsx.
import { ApiError } from '../../lib/api';
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
  const err = new ApiError(401, 'totp_invalid');
  const start = vi.fn(async () => ({ secret: 'S', otpauth_uri: 'otpauth://totp/x' }));
  const confirm = vi.fn(async () => { throw err; });
  render(<EnrollFlow email="a@x" start={start} confirm={confirm} onDone={() => {}} />);
  await waitFor(() => expect(start).toHaveBeenCalled());
  const boxes = screen.getAllByRole('textbox');
  await user.type(boxes[0], '000000');
  expect(await screen.findByText(/didn.t match/i)).toBeTruthy();
  // refocuses box 1 after the wrong code, same as the login page's card
  await waitFor(() => expect(document.activeElement).toBe(screen.getAllByRole('textbox')[0]));
});

it('the newest start() call wins even when its response resolves first out of order', async () => {
  // React.StrictMode double-invokes the mount effect (mount → cleanup →
  // mount), so loadSecret fires twice before either has resolved — each
  // call mints a fresh seed server-side, where the last SERVER write
  // wins, but the two RESPONSES can resolve in either order. Whichever
  // call fired LAST must win on screen, regardless of which response
  // arrives first (a plain "still mounted?" guard doesn't distinguish
  // stale-but-still-mounted from current).
  let resolveFirst!: (v: { secret: string; otpauth_uri: string }) => void;
  let resolveSecond!: (v: { secret: string; otpauth_uri: string }) => void;
  const first = new Promise<{ secret: string; otpauth_uri: string }>((r) => { resolveFirst = r; });
  const second = new Promise<{ secret: string; otpauth_uri: string }>((r) => { resolveSecond = r; });
  const start = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
  const confirm = vi.fn();

  render(
    <StrictMode>
      <EnrollFlow email="a@x" start={start} confirm={confirm} onDone={() => {}} />
    </StrictMode>,
  );
  await waitFor(() => expect(start).toHaveBeenCalledTimes(2));

  // The SECOND (newest) call's response resolves FIRST, out of order.
  resolveSecond({ secret: 'SECONDSECRET', otpauth_uri: 'otpauth://totp/second' });
  await screen.findByAltText(/scan this/i);
  // The stale FIRST call's response resolves after — must be ignored.
  resolveFirst({ secret: 'FIRSTSECRET', otpauth_uri: 'otpauth://totp/first' });

  await waitFor(() => expect(
    (screen.getByAltText(/scan this/i) as HTMLImageElement).src,
  ).toContain('second'));
  expect(screen.queryByText(/FIRS TSEC RET/)).toBeNull();
});

it('start() failing shows a Try again button that re-runs it', async () => {
  const user = userEvent.setup();
  const start = vi.fn()
    .mockRejectedValueOnce(new ApiError(500, 'unknown_error'))
    .mockResolvedValueOnce({ secret: 'JBSWY3DPEHPK3PXP', otpauth_uri: 'otpauth://totp/x' });
  const confirm = vi.fn();
  render(<EnrollFlow email="a@x" start={start} confirm={confirm} onDone={() => {}} />);
  await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
  const retry = await screen.findByRole('button', { name: /try again/i });
  expect(screen.queryByAltText(/scan this/i)).toBeNull();

  await user.click(retry);
  await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
  expect(await screen.findByAltText(/scan this/i)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
});

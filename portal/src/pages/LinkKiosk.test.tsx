// @vitest-environment jsdom
/** /link — code entry navigates to /link/:code; /link/:code loads the
 *  pair info, approves or denies, and shows the done/expired/not-allowed
 *  copy from the spec. */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ can: vi.fn(() => true) }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ can: auth.can, person: { display_name: 'Jimmy Henderson' } }),
}));

const api = vi.hoisted(() => ({
  getPairInfo: vi.fn(), approvePair: vi.fn(), denyPair: vi.fn(),
}));
vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

import { ApiError } from '../lib/api';
import LinkKiosk from './LinkKiosk';

const INFO = { code: 'ABCD2345', kiosk_name: 'Dock 3', serial: 'kiosk-web-1',
               status: 'pending', expires_at: '2030-01-01T00:00:00Z' };

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/link" element={<LinkKiosk />} />
        <Route path="/link/:code" element={<LinkKiosk />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  auth.can.mockReturnValue(true);
  api.getPairInfo.mockResolvedValue(INFO);
  api.approvePair.mockResolvedValue(undefined);
  api.denyPair.mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('code entry normalizes and navigates to /link/:code', async () => {
  renderAt('/link');
  const input = screen.getByLabelText('Code');
  await userEvent.type(input, 'abcd-2345');
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(api.getPairInfo).toHaveBeenCalledWith('ABCD2345'));
  expect(await screen.findByText('Dock 3')).toBeTruthy();
});

it('continue is disabled until eight characters are entered', async () => {
  renderAt('/link');
  const button = screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  await userEvent.type(screen.getByLabelText('Code'), 'abc');
  expect(button.disabled).toBe(true);
});

it('shows the kiosk, names the signer, and approves', async () => {
  renderAt('/link/ABCD2345');
  expect(await screen.findByText('Dock 3')).toBeTruthy();
  expect(screen.getByText(/signs the kiosk in as Jimmy Henderson/)).toBeTruthy();
  expect(screen.getByText('kiosk-web-1')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
  expect(api.approvePair).toHaveBeenCalledWith('ABCD2345');
  expect(await screen.findByText(/Dock 3 is signing in/)).toBeTruthy();
});

it('denies', async () => {
  renderAt('/link/ABCD2345');
  await screen.findByText('Dock 3');
  await userEvent.click(screen.getByRole('button', { name: 'Deny' }));
  expect(api.denyPair).toHaveBeenCalledWith('ABCD2345');
  expect(await screen.findByText('Declined.')).toBeTruthy();
});

it('shows the expired copy for an unknown or used code', async () => {
  api.getPairInfo.mockRejectedValue(new ApiError(404, 'pair_not_found'));
  renderAt('/link/ZZZZZZZZ');
  expect(await screen.findByText(/expired or was already used/)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Enter a different code' })).toBeTruthy();
});

it('a race with another approver lands on the expired copy', async () => {
  api.approvePair.mockRejectedValue(new ApiError(409, 'pair_not_pending'));
  renderAt('/link/ABCD2345');
  await screen.findByText('Dock 3');
  await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
  expect(await screen.findByText(/expired or was already used/)).toBeTruthy();
});

it('refuses accounts without kiosk access', async () => {
  auth.can.mockReturnValue(false);
  renderAt('/link/ABCD2345');
  expect(await screen.findByText(/isn't allowed to sign in to kiosks/)).toBeTruthy();
  expect(api.getPairInfo).not.toHaveBeenCalled();
});

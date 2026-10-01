// @vitest-environment jsdom
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** EdgePanel navigates to /login after a wipe, so it needs a router. */
const render = (ui: ReactElement) => rtlRender(<MemoryRouter>{ui}</MemoryRouter>);

const status = {
  version: '1.2.3',
  cloud: { online: false, last_contact: '2026-10-01T12:00:00+00:00' },
  sync: { initiative_id: 'm-1', synced_at: '2026-10-01T11:00:00+00:00', last_error: null },
  outbox: { queued: 3, sending: 0, sent: 10, rejected: 1, failed: 2, needs_sign_in: 3 },
  waiting: [{ person_name: 'Jane Doe', count: 3 }],
  session: { offline: true }, identity: { serial: 's', name: 'n' },
};
const refresh = vi.fn(async () => {});
vi.mock('../lib/edgeStatus', () => ({ useEdgeStatus: () => ({ status, refresh }) }));
const api = vi.hoisted(() => ({
  edgeSyncNow: vi.fn(), edgeRetryFailed: vi.fn(), edgeWipe: vi.fn(),
}));
vi.mock('../lib/api', async (orig) => ({ ...(await orig<object>()), ...api }));
const auth = vi.hoisted(() => ({ isAdmin: false, logout: vi.fn(async () => {}) }));
vi.mock('../auth/KioskAuthContext', () => ({ useKioskAuth: () => auth }));
vi.mock('../lib/localDb', () => ({ clearDb: vi.fn(async () => {}) }));
vi.mock('../lib/sync', () => ({ resetSyncStatus: vi.fn() }));

import EdgePanel from './EdgePanel';

beforeEach(() => { vi.clearAllMocks(); auth.isAdmin = false; });
afterEach(cleanup);

describe('EdgePanel', () => {
  it('shows cloud, sync and queue state with the waiting list', () => {
    render(<EdgePanel />);
    expect(screen.getByText('1.2.3')).toBeTruthy();
    expect(screen.getByText('Offline')).toBeTruthy();
    expect(screen.getByText(/3 scans waiting for Jane Doe to sign in online/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Wipe this laptop' })).toBeNull();
  });

  it('Sync now and Retry failed call the edge then refresh', async () => {
    api.edgeSyncNow.mockResolvedValue(status);
    api.edgeRetryFailed.mockResolvedValue({ requeued: 5 });
    render(<EdgePanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));
    // Both buttons disable while one action runs, so wait for the first to finish.
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Retry failed' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Retry failed' }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    expect(api.edgeSyncNow).toHaveBeenCalledTimes(1);
    expect(api.edgeRetryFailed).toHaveBeenCalledTimes(1);
  });

  it('admin wipe asks for WIPE when uploads are pending', async () => {
    auth.isAdmin = true;
    const { ApiError } = await import('../lib/api');
    api.edgeWipe.mockRejectedValueOnce(new ApiError(409, 'outbox_not_empty', { code: 'outbox_not_empty', pending: 6 }))
      .mockResolvedValueOnce({ cleared_move_data: true });
    render(<EdgePanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Wipe this laptop' }));
    await screen.findByText(/6 queued items have not reached the portal/);
    fireEvent.change(screen.getByLabelText('Type WIPE to confirm'), { target: { value: 'WIPE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Wipe anyway' }));
    await waitFor(() => expect(api.edgeWipe).toHaveBeenLastCalledWith('WIPE'));
    await waitFor(() => expect(auth.logout).toHaveBeenCalled());
  });
});

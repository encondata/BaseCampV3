// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getAdminConfig: vi.fn(),
  updateAdminConfig: vi.fn(),
  refreshSystemStatus: vi.fn(),
}));
vi.mock('../../lib/api', async (orig) => ({
  ...(await orig<typeof import('../../lib/api')>()),
  ...api,
}));

import AdminControls from './AdminControls';

const base = { read_only: false, read_only_message: '', pause_workers: false,
               banner_enabled: false, banner_message: '' };

beforeEach(() => {
  vi.clearAllMocks();
  api.getAdminConfig.mockResolvedValue({ ...base });
  api.updateAdminConfig.mockImplementation(async (patch) => ({ ...base, ...patch }));
});
afterEach(cleanup);

const switches = () => screen.getAllByRole('checkbox') as HTMLInputElement[];

describe('AdminControls', () => {
  it('toggling read-only PUTs immediately and refreshes the banners', async () => {
    render(<AdminControls />);
    await waitFor(() => expect(api.getAdminConfig).toHaveBeenCalled());
    fireEvent.click(switches()[0]);
    await waitFor(() => expect(api.updateAdminConfig).toHaveBeenCalledWith({ read_only: true }));
    expect(api.refreshSystemStatus).toHaveBeenCalled();
  });

  it('pause sub-toggle is disabled until read-only is on; Resume appears when paused', async () => {
    api.getAdminConfig.mockResolvedValue({ ...base, read_only: true, pause_workers: true });
    render(<AdminControls />);
    await screen.findByText('Resume workers');
    expect(switches()[1].disabled).toBe(false);
    fireEvent.click(screen.getByText('Resume workers'));
    await waitFor(() => expect(api.updateAdminConfig)
      .toHaveBeenCalledWith({ pause_workers: false }));
  });

  it('pause sub-toggle disabled when read-only is off', async () => {
    render(<AdminControls />);
    await waitFor(() => expect(api.getAdminConfig).toHaveBeenCalled());
    expect(switches()[1].disabled).toBe(true);
    expect(screen.queryByText('Resume workers')).toBeNull();
  });

  it('message Save appears when dirty and PUTs the trimmed text', async () => {
    render(<AdminControls />);
    await waitFor(() => expect(api.getAdminConfig).toHaveBeenCalled());
    expect(screen.queryByText('Save')).toBeNull();
    const input = screen.getByPlaceholderText(/Cutover in progress/);
    fireEvent.change(input, { target: { value: '  Back at 14:00 ' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(api.updateAdminConfig)
      .toHaveBeenCalledWith({ read_only_message: 'Back at 14:00' }));
  });

  it('refuses to enable the broadcast banner with a blank message', async () => {
    render(<AdminControls />);
    await waitFor(() => expect(api.getAdminConfig).toHaveBeenCalled());
    fireEvent.click(switches()[2]);
    expect(await screen.findByText('Enter a message first.')).toBeTruthy();
    expect(api.updateAdminConfig).not.toHaveBeenCalled();
    expect(switches()[2].checked).toBe(false);
  });

  it('surfaces a PUT failure inline', async () => {
    const { ApiError } = await import('../../lib/api');
    api.updateAdminConfig.mockRejectedValue(new ApiError(500, 'unknown_error'));
    api.getAdminConfig.mockResolvedValue({ ...base, banner_message: 'x' });
    render(<AdminControls />);
    await waitFor(() => expect(api.getAdminConfig).toHaveBeenCalled());
    fireEvent.click(switches()[2]);
    expect(await screen.findByText(/could not save/i)).toBeTruthy();
  });
});

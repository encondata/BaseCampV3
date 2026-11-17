// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const helper = vi.hoisted(() => ({
  available: true,
  getHostSystem: vi.fn(),
  getWifiNetworks: vi.fn(),
  joinWifi: vi.fn(),
}));
vi.mock('../../lib/hostHelper', async (orig) => ({
  ...(await orig<typeof import('../../lib/hostHelper')>()),
  lockdownAvailable: () => helper.available,
  getHostSystem: helper.getHostSystem,
  getWifiNetworks: helper.getWifiNetworks,
  joinWifi: helper.joinWifi,
}));

import { HelperError } from '../../lib/hostHelper';
import SystemTray, { signalBars } from './SystemTray';

const SYSTEM = {
  battery: { percent: 87, charging: true },
  wifi: { ssid: 'CSG-Ops', signal: 72 },
  wired: { connected: false, device: 'enp0s31f6' },
  network: 'wifi' as const,
};
const NETWORKS = {
  networks: [
    { ssid: 'CSG-Ops', signal: 72, secure: true, active: true },
    { ssid: 'Warehouse', signal: 51, secure: true, active: false },
    { ssid: 'Lobby', signal: 40, secure: false, active: false },
  ],
  wired: { connected: false, device: 'enp0s31f6' },
};

beforeEach(() => {
  helper.available = true;
  helper.getHostSystem.mockReset().mockResolvedValue(SYSTEM);
  helper.getWifiNetworks.mockReset().mockResolvedValue(NETWORKS);
  helper.joinWifi.mockReset();
  document.body.innerHTML = '<div class="portal-shell kiosk-shell"></div>';
});
afterEach(() => { cleanup(); });

const renderTray = () => render(<SystemTray />, { container: document.querySelector('.kiosk-shell')! });

it('shows the battery and the Wi-Fi network', async () => {
  renderTray();
  expect(await screen.findByText('87%')).toBeTruthy();
  expect(screen.getByTitle('Battery 87%, charging')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Network: CSG-Ops' })).toBeTruthy();
});

it('the Network modal lists Wi-Fi and the wired status, and joins with the password', async () => {
  renderTray();
  await userEvent.click(await screen.findByRole('button', { name: 'Network: CSG-Ops' }));
  const dialog = await screen.findByRole('dialog', { name: 'Network' });
  expect(dialog.closest('.kiosk-top')).toBeNull();                 // portaled out of the top bar
  expect(await within(dialog).findByText('Not connected (enp0s31f6)')).toBeTruthy();
  await userEvent.click(within(dialog).getByRole('radio', { name: /Warehouse/ }));
  helper.joinWifi.mockRejectedValueOnce(new HelperError('wrong_password'));
  await userEvent.type(within(dialog).getByLabelText('Password'), 'nope');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Join' }));
  expect(helper.joinWifi).toHaveBeenLastCalledWith('Warehouse', 'nope');
  expect((await within(dialog).findByRole('alert')).textContent)
    .toBe("Couldn't join Warehouse. Check the password and try again.");
  expect((within(dialog).getByLabelText('Password') as HTMLInputElement).value).toBe('');
  helper.joinWifi.mockResolvedValueOnce({ ok: true });
  await userEvent.type(within(dialog).getByLabelText('Password'), 'right-one');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Join' }));
  expect((await within(dialog).findByRole('status')).textContent).toBe('Connected to Warehouse.');
});

it('any failed join clears the password', async () => {
  renderTray();
  await userEvent.click(await screen.findByRole('button', { name: 'Network: CSG-Ops' }));
  const dialog = await screen.findByRole('dialog', { name: 'Network' });
  await userEvent.click(await within(dialog).findByRole('radio', { name: /Warehouse/ }));
  helper.joinWifi.mockRejectedValueOnce(new HelperError('unreachable'));
  await userEvent.type(within(dialog).getByLabelText('Password'), 'secret');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Join' }));
  expect((await within(dialog).findByRole('alert')).textContent)
    .toBe("Couldn't reach the kiosk helper on this laptop. Try again.");
  expect((within(dialog).getByLabelText('Password') as HTMLInputElement).value).toBe('');
});

it('an open network has no password field', async () => {
  renderTray();
  await userEvent.click(await screen.findByRole('button', { name: 'Network: CSG-Ops' }));
  const dialog = await screen.findByRole('dialog', { name: 'Network' });
  await userEvent.click(await within(dialog).findByRole('radio', { name: /Lobby/ }));
  expect(within(dialog).queryByLabelText('Password')).toBeNull();
});

it('renders nothing off a Linux laptop', () => {
  helper.available = false;
  renderTray();
  expect(screen.queryByRole('button')).toBeNull();
  expect(helper.getHostSystem).not.toHaveBeenCalled();
});

it('signal bars', () => {
  expect([0, 1, 33, 34, 66, 67, 100].map(signalBars)).toEqual([0, 1, 1, 2, 2, 3, 3]);
});

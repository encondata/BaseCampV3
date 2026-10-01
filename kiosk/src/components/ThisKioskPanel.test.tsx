// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  isAdmin: false,
  status: 'authed', person: null, perms: null, preferences: null, mustChangePassword: false,
  sessionExpiresAt: null, registration: null, heartbeatNow: vi.fn(() => Promise.resolve()),
  login: vi.fn(), completePair: vi.fn(), logout: vi.fn(), can: () => true,
}));
vi.mock('../auth/KioskAuthContext', () => ({ useKioskAuth: () => auth }));

const api = vi.hoisted(() => ({ renameLaptopKiosk: vi.fn() }));
vi.mock('../lib/api', async (orig) => ({ ...(await orig<object>()), ...api }));

import { ApiError } from '../lib/api';
import { getIdentity } from '../lib/identity';
import ThisKioskPanel from './ThisKioskPanel';

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('shows the identity and saves a new name, re-beating when signed in', async () => {
  render(<ThisKioskPanel />);
  const serial = getIdentity().serial;
  expect((screen.getByLabelText('Serial') as HTMLInputElement).value).toBe(serial);
  expect((screen.getByLabelText('Mode') as HTMLInputElement).value).toBe('Web');
  const name = screen.getByLabelText('Kiosk name') as HTMLInputElement;
  await userEvent.clear(name);
  await userEvent.type(name, 'Dock 3');
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('Kiosk name saved.')).toBeTruthy();
  expect(getIdentity().name).toBe('Dock 3');
  expect(auth.heartbeatNow).toHaveBeenCalledTimes(1);
});

it('rejects a blank name', async () => {
  render(<ThisKioskPanel />);
  await userEvent.clear(screen.getByLabelText('Kiosk name'));
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('Enter a name between 1 and 80 characters.')).toBeTruthy();
  expect(auth.heartbeatNow).not.toHaveBeenCalled();
});

it('does not save or re-beat when signed out', async () => {
  auth.status = 'anon';
  render(<ThisKioskPanel />);
  await userEvent.clear(screen.getByLabelText('Kiosk name'));
  await userEvent.type(screen.getByLabelText('Kiosk name'), 'Dock 9');
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('Kiosk name saved.')).toBeTruthy();
  expect(auth.heartbeatNow).not.toHaveBeenCalled();
  auth.status = 'authed';
});

it('renders no Back button — the Settings tabs replace it', () => {
  render(<ThisKioskPanel />);
  expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
});

describe('laptop mode', () => {
  beforeEach(() => {
    window.__KIOSK_CONFIG__ = { mode: 'laptop', identity: { serial: 'kiosk-laptop-1', name: 'Kiosk 0001' } };
  });
  afterEach(() => { delete window.__KIOSK_CONFIG__; auth.isAdmin = false; });

  it('a non-admin sees a read-only name and a hint', () => {
    render(<ThisKioskPanel />);
    expect((screen.getByLabelText('Kiosk name') as HTMLInputElement).readOnly).toBe(true);
    expect(screen.getByText('Only an admin can rename this laptop.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('an admin saves through the edge, then re-beats', async () => {
    auth.isAdmin = true;
    api.renameLaptopKiosk.mockResolvedValue({ serial: 'kiosk-laptop-1', name: 'Dock 9' });
    render(<ThisKioskPanel />);
    const name = screen.getByLabelText('Kiosk name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Dock 9');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Kiosk name saved.')).toBeTruthy();
    expect(api.renameLaptopKiosk).toHaveBeenCalledWith('Dock 9');
    expect(auth.heartbeatNow).toHaveBeenCalled();
  });

  it('says the edge is unreachable when the rename cannot reach it', async () => {
    auth.isAdmin = true;
    const cases: [ApiError, string][] = [
      [new ApiError(0, 'network'), "Can't reach this laptop's edge service. Try again."],
      [new ApiError(503, 'edge_offline'), "Can't reach this laptop's edge service. Try again."],
      [new ApiError(403, 'forbidden'), 'Only an admin can rename this laptop.'],
      [new ApiError(401, 'not_authenticated'), 'Only an admin can rename this laptop.'],
      [new ApiError(422, 'bad_name'), 'Enter a name between 1 and 80 characters.'],
    ];
    for (const [err, text] of cases) {
      api.renameLaptopKiosk.mockReset().mockRejectedValue(err);
      render(<ThisKioskPanel />);
      // eslint-disable-next-line no-await-in-loop -- each case is its own render
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      // eslint-disable-next-line no-await-in-loop
      expect(await screen.findByRole('alert')).toHaveProperty('textContent', text);
      cleanup();
    }
  });
});

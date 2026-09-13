// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  status: 'authed', person: null, perms: null, preferences: null, mustChangePassword: false,
  sessionExpiresAt: null, registration: null, heartbeatNow: vi.fn(() => Promise.resolve()),
  login: vi.fn(), completePair: vi.fn(), logout: vi.fn(), can: () => true,
}));
vi.mock('../auth/KioskAuthContext', () => ({ useKioskAuth: () => auth }));

import { getIdentity } from '../lib/identity';
import KioskSettings from './KioskSettings';

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('shows the identity and saves a new name, re-beating when signed in', async () => {
  render(<MemoryRouter><KioskSettings /></MemoryRouter>);
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
  render(<MemoryRouter><KioskSettings /></MemoryRouter>);
  await userEvent.clear(screen.getByLabelText('Kiosk name'));
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('Enter a name between 1 and 80 characters.')).toBeTruthy();
  expect(auth.heartbeatNow).not.toHaveBeenCalled();
});

// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  status: 'authed', person: { display_name: 'Alex Worker' }, perms: null, preferences: null,
  mustChangePassword: false, sessionExpiresAt: '2030-01-01T00:00:00Z', registration: 'ok',
  heartbeatNow: vi.fn(() => Promise.resolve()),
  login: vi.fn(), completePair: vi.fn(), logout: vi.fn(), can: () => true,
}));
vi.mock('../auth/KioskAuthContext', () => ({ useKioskAuth: () => auth }));

import { writeDevMode } from '../lib/devMode';
import { FEATURES } from '../lib/features';
import { writeSetupState } from '../lib/setupState';
import FeaturePage from './FeaturePage';
import Home from './Home';

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function renderRouted() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<Home />} />
        {FEATURES.map((f) => (
          <Route key={f.id} path={f.path} element={<FeaturePage feature={f} />} />
        ))}
      </Routes>
    </MemoryRouter>,
  );
}

it('renders a tile link for each feature, Kiosk Setup first and Settings last', () => {
  writeSetupState('complete');
  renderRouted();
  const links = screen.getAllByRole('link');
  expect(links).toHaveLength(6);
  expect(links[0].textContent).toContain('Kiosk Setup');
  expect(links[0].getAttribute('href')).toBe('/setup');
  expect(screen.getByRole('link', { name: /Scanning/ }).getAttribute('href')).toBe('/scan');
  // RFID Enroll sits immediately after Scanning
  expect(links[2].textContent).toContain('RFID Enroll');
  expect(links[2].getAttribute('href')).toBe('/enroll');
  expect(screen.getByRole('link', { name: /Label Printing/ }).getAttribute('href')).toBe('/labels');
  expect(screen.getByRole('link', { name: /Timeclock/ }).getAttribute('href')).toBe('/timeclock');
  expect(links[5].textContent).toContain('Settings');
  expect(links[5].getAttribute('href')).toBe('/settings');
});

it('renders the launcher tiles only, with no facts list', () => {
  writeSetupState('complete');
  renderRouted();
  expect(screen.getByRole('link', { name: /Kiosk Setup/ })).toBeTruthy();
  expect(screen.getByRole('link', { name: /Scanning/ })).toBeTruthy();
  expect(screen.getByRole('link', { name: /RFID Enroll/ })).toBeTruthy();
  expect(screen.getByRole('link', { name: /Label Printing/ })).toBeTruthy();
  expect(screen.getByRole('link', { name: /Timeclock/ })).toBeTruthy();
  expect(screen.getByRole('link', { name: /Settings/ })).toBeTruthy();
  expect(document.querySelector('dl')).toBeNull();
});

it('navigates to the placeholder and back', async () => {
  writeSetupState('complete');
  renderRouted();
  await userEvent.click(screen.getByRole('link', { name: /Timeclock/ }));
  expect(await screen.findByText('This feature is not available yet.')).toBeTruthy();
  await userEvent.click(screen.getByRole('link', { name: 'Back to home' }));
  expect(await screen.findByText('What would you like to do?')).toBeTruthy();
});

it('when setup is incomplete, greys out every tile except Kiosk Setup and Settings, and shows the banner', async () => {
  renderRouted();
  for (const name of [/Scanning/, /RFID Enroll/, /Label Printing/, /Timeclock/]) {
    const tile = screen.getByRole('link', { name });
    expect(tile.getAttribute('aria-disabled')).toBe('true');
  }
  const setup = screen.getByRole('link', { name: /^Kiosk Setup/ });
  const settings = screen.getByRole('link', { name: /^Settings/ });
  expect(setup.getAttribute('aria-disabled')).toBeNull();
  expect(settings.getAttribute('aria-disabled')).toBeNull();

  await userEvent.click(screen.getByRole('link', { name: /Scanning/ }));
  expect(screen.queryByText('This feature is not available yet.')).toBeNull();

  expect(screen.getByText('Kiosk setup is incomplete. Only Kiosk Setup and Settings are available.')).toBeTruthy();
});

it('when setup is complete, no tile is disabled and no banner is shown', () => {
  writeSetupState('complete');
  renderRouted();
  for (const f of FEATURES) {
    const tile = screen.getByRole('link', { name: new RegExp(f.title) });
    expect(tile.getAttribute('aria-disabled')).toBeNull();
  }
  expect(screen.queryByText(/Kiosk setup is incomplete/)).toBeNull();
  expect(screen.queryByText(/Kiosk setup failed/)).toBeNull();
});

it('when setup failed, shows the failed copy on the banner and lock lines', () => {
  writeSetupState('failed');
  renderRouted();
  expect(screen.getByText('Kiosk setup failed. Open Kiosk Setup to try again.')).toBeTruthy();
  expect(screen.getAllByText('Kiosk setup failed — open Kiosk Setup.').length).toBeGreaterThan(0);
});

it('when setup is incomplete and developer mode is on, no tile is disabled and the dev note replaces the normal banner', () => {
  writeDevMode(true);
  renderRouted();
  for (const f of FEATURES) {
    const tile = screen.getByRole('link', { name: new RegExp(f.title) });
    expect(tile.getAttribute('aria-disabled')).toBeNull();
  }
  expect(screen.getByText('Developer mode: all features are available while kiosk setup is incomplete.')).toBeTruthy();
  expect(screen.queryByText('Kiosk setup is incomplete. Only Kiosk Setup and Settings are available.')).toBeNull();
});

it('when setup failed and developer mode is on, no tile is disabled and the dev note reflects the failed state', () => {
  writeSetupState('failed');
  writeDevMode(true);
  renderRouted();
  for (const f of FEATURES) {
    const tile = screen.getByRole('link', { name: new RegExp(f.title) });
    expect(tile.getAttribute('aria-disabled')).toBeNull();
  }
  expect(screen.getByText('Developer mode: all features are available while kiosk setup is failed.')).toBeTruthy();
  expect(screen.queryByText('Kiosk setup failed. Open Kiosk Setup to try again.')).toBeNull();
});

it('when setup is complete and developer mode is on, no dev note is shown', () => {
  writeSetupState('complete');
  writeDevMode(true);
  renderRouted();
  expect(screen.queryByText(/Developer mode: all features are available/)).toBeNull();
});

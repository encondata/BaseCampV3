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
import { writeKioskSetup, type StationType } from '../lib/kioskSetup';
import { writeSetupState } from '../lib/setupState';
import FeaturePage from './FeaturePage';
import Home from './Home';

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.clearAllMocks(); delete window.__KIOSK_CONFIG__; });

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
  expect(links).toHaveLength(8);
  expect(links[0].textContent).toContain('Kiosk Setup');
  expect(links[0].getAttribute('href')).toBe('/setup');
  expect(screen.getByRole('link', { name: /Scanning/ }).getAttribute('href')).toBe('/scan');
  // RFID Enroll sits immediately after Scanning, Containers after it
  expect(links[2].textContent).toContain('RFID Enroll');
  expect(links[2].getAttribute('href')).toBe('/enroll');
  expect(links[3].textContent).toContain('Containers');
  expect(links[3].getAttribute('href')).toBe('/containers');
  // Trucks is Containers' sibling, so it sits immediately after it.
  expect(links[4].textContent).toContain('Trucks');
  expect(links[4].getAttribute('href')).toBe('/trucks');
  expect(screen.getByRole('link', { name: /Label Printing/ }).getAttribute('href')).toBe('/labels');
  expect(screen.getByRole('link', { name: /Timeclock/ }).getAttribute('href')).toBe('/timeclock');
  expect(links[7].textContent).toContain('Settings');
  expect(links[7].getAttribute('href')).toBe('/settings');
});

it('renders the launcher tiles only, with no facts list', () => {
  writeSetupState('complete');
  renderRouted();
  expect(screen.getByRole('link', { name: /Kiosk Setup/ })).toBeTruthy();
  expect(screen.getByRole('link', { name: /Scanning/ })).toBeTruthy();
  expect(screen.getByRole('link', { name: /RFID Enroll/ })).toBeTruthy();
  expect(screen.getByRole('link', { name: /Containers/ })).toBeTruthy();
  expect(screen.getByRole('link', { name: /Trucks/ })).toBeTruthy();
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
  for (const name of [/Scanning/, /RFID Enroll/, /Trucks/, /Label Printing/, /Timeclock/]) {
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

// -- the RFID Reader tile (laptop + RFID station only) --------------------

function saveSetup(stationType?: StationType) {
  writeKioskSetup({
    initiativeId: 'i1', initiativeName: 'Move', siteId: 's1', siteName: 'Site', siteRole: 'source',
    scanStatus: 'staged', scanLabel: 'RFID 1', ...(stationType ? { stationType } : {}),
  });
}

it('shows an RFID Reader tile first, linking to /rfid_status, for a laptop with an RFID setup', () => {
  window.__KIOSK_CONFIG__ = { mode: 'laptop' };
  writeSetupState('complete');
  saveSetup('rfid');
  renderRouted();
  const links = screen.getAllByRole('link');
  expect(links[0].textContent).toContain('RFID Reader');
  expect(links[0].textContent).toContain('Start or stop the reader and watch live activity.');
  expect(links[0].getAttribute('href')).toBe('/rfid_status');
  expect(links[1].textContent).toContain('Kiosk Setup');
});

const tileTitles = () => Array.from(document.querySelectorAll('.kiosk-tile-title')).map((n) => n.textContent);

it('an RFID Station shows only RFID Reader, Kiosk Setup and Settings', () => {
  window.__KIOSK_CONFIG__ = { mode: 'laptop' };
  writeSetupState('complete');
  saveSetup('rfid');
  renderRouted();
  expect(tileTitles()).toEqual(['RFID Reader', 'Kiosk Setup', 'Settings']);
});

it('a Label Station shows only Kiosk Setup, Label Printing and Settings', () => {
  window.__KIOSK_CONFIG__ = { mode: 'laptop' };
  writeSetupState('complete');
  saveSetup('label');
  renderRouted();
  expect(tileTitles()).toEqual(['Kiosk Setup', 'Label Printing', 'Settings']);
});

it('web mode and an unset laptop still show every feature', () => {
  writeSetupState('complete');
  saveSetup('rfid');
  renderRouted();
  expect(tileTitles()).toHaveLength(8);
  cleanup();
  window.__KIOSK_CONFIG__ = { mode: 'laptop' };
  saveSetup();
  renderRouted();
  expect(tileTitles()).toHaveLength(8);
});

it('hides the RFID Reader tile for a Label Station', () => {
  window.__KIOSK_CONFIG__ = { mode: 'laptop' };
  writeSetupState('complete');
  saveSetup('label');
  renderRouted();
  expect(screen.queryByRole('link', { name: /RFID Reader/ })).toBeNull();
});

it('hides the RFID Reader tile in web mode, even with an RFID setup saved', () => {
  writeSetupState('complete');
  saveSetup('rfid');
  renderRouted();
  expect(screen.queryByRole('link', { name: /RFID Reader/ })).toBeNull();
});

it('hides the RFID Reader tile on a laptop with no saved setup', () => {
  window.__KIOSK_CONFIG__ = { mode: 'laptop' };
  writeSetupState('complete');
  renderRouted();
  expect(screen.queryByRole('link', { name: /RFID Reader/ })).toBeNull();
});

it('greys out the RFID Reader tile while setup is incomplete, like the other tiles', () => {
  window.__KIOSK_CONFIG__ = { mode: 'laptop' };
  saveSetup('rfid');
  renderRouted();
  expect(screen.getByRole('link', { name: /RFID Reader/ }).getAttribute('aria-disabled')).toBe('true');
});

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
import { writeWebLabelKind, writeWebLabelPrintingOff } from '../lib/webLabelSettings';
import FeaturePage from './FeaturePage';
import Home from './Home';

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.clearAllMocks(); delete window.__KIOSK_CONFIG__; });

const tileTitles = () => Array.from(document.querySelectorAll('.kiosk-tile-title')).map((n) => n.textContent);

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
  expect(links).toHaveLength(10);
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
  expect(links[5].textContent).toContain('Asset Lookup');
  expect(links[5].getAttribute('href')).toBe('/lookup');
  expect(screen.getByRole('link', { name: /Label Printing/ }).getAttribute('href')).toBe('/labels');
  expect(screen.getByRole('link', { name: /Timeclock/ }).getAttribute('href')).toBe('/timeclock');
  expect(links[8].textContent).toContain('Troubleshooting');
  expect(links[8].getAttribute('href')).toBe('/troubleshooting');
  expect(links[9].textContent).toContain('Settings');
  expect(links[9].getAttribute('href')).toBe('/settings');
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

it('when setup is incomplete, hides every tile except Kiosk Setup, Troubleshooting and Settings, and shows the banner', () => {
  renderRouted();
  expect(tileTitles()).toEqual(['Kiosk Setup', 'Troubleshooting', 'Settings']);
  expect(screen.getByRole('link', { name: /^Troubleshooting/ }).getAttribute('href')).toBe('/troubleshooting');
  expect(screen.getByRole('link', { name: /^Kiosk Setup/ }).getAttribute('href')).toBe('/setup');
  expect(screen.getByRole('link', { name: /^Settings/ }).getAttribute('href')).toBe('/settings');
  expect(screen.getByText('Kiosk setup is incomplete. Only Kiosk Setup, Troubleshooting and Settings are available.')).toBeTruthy();
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

it('when setup failed, shows the failed copy and only Kiosk Setup, Troubleshooting and Settings', () => {
  writeSetupState('failed');
  renderRouted();
  expect(screen.getByText('Kiosk setup failed. Open Kiosk Setup to try again.')).toBeTruthy();
  expect(tileTitles()).toEqual(['Kiosk Setup', 'Troubleshooting', 'Settings']);
});

it('when setup is incomplete and developer mode is on, no tile is disabled and the dev note replaces the normal banner', () => {
  writeDevMode(true);
  renderRouted();
  for (const f of FEATURES) {
    const tile = screen.getByRole('link', { name: new RegExp(f.title) });
    expect(tile.getAttribute('aria-disabled')).toBeNull();
  }
  expect(screen.getByText('Developer mode: all features are available while kiosk setup is incomplete.')).toBeTruthy();
  expect(screen.queryByText('Kiosk setup is incomplete. Only Kiosk Setup, Troubleshooting and Settings are available.')).toBeNull();
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

it('an RFID Station shows only RFID Reader, Kiosk Setup, Troubleshooting and Settings', () => {
  window.__KIOSK_CONFIG__ = { mode: 'laptop' };
  writeSetupState('complete');
  saveSetup('rfid');
  renderRouted();
  expect(tileTitles()).toEqual(['RFID Reader', 'Kiosk Setup', 'Troubleshooting', 'Settings']);
});

it('a Label Station shows Label Printing first, then Kiosk Setup, Troubleshooting and Settings', () => {
  window.__KIOSK_CONFIG__ = { mode: 'laptop' };
  writeSetupState('complete');
  saveSetup('label');
  renderRouted();
  expect(tileTitles()).toEqual(['Label Printing', 'Kiosk Setup', 'Troubleshooting', 'Settings']);
});

it('a Time Clock station shows only Time Clock, Kiosk Setup and Settings, Time Clock linking to its start page', () => {
  window.__KIOSK_CONFIG__ = { mode: 'laptop' };
  writeSetupState('complete');
  saveSetup('timeclock');
  renderRouted();
  expect(tileTitles()).toEqual(['Time Clock', 'Kiosk Setup', 'Troubleshooting', 'Settings']);
  expect(screen.getAllByRole('link')[0].getAttribute('href')).toBe('/timeclock/station');
});

it('web mode and an unset laptop still show every feature', () => {
  writeSetupState('complete');
  saveSetup('rfid');
  renderRouted();
  expect(tileTitles()).toHaveLength(10);
  cleanup();
  window.__KIOSK_CONFIG__ = { mode: 'laptop' };
  saveSetup();
  renderRouted();
  expect(tileTitles()).toHaveLength(10);
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

it('hides the RFID Reader tile while setup is incomplete, like the other tiles', () => {
  window.__KIOSK_CONFIG__ = { mode: 'laptop' };
  saveSetup('rfid');
  renderRouted();
  expect(tileTitles()).toEqual(['Kiosk Setup', 'Troubleshooting', 'Settings']);
});

// -- a web kiosk set up not to print labels ---------------------------------

it('a web kiosk set up not to print labels has no Label Printing tile', () => {
  writeSetupState('complete');
  writeWebLabelPrintingOff();
  renderRouted();
  expect(tileTitles()).toHaveLength(9);
  expect(screen.queryByRole('link', { name: /Label Printing/ })).toBeNull();
});

it('Label Printing comes back once the web kiosk says it prints labels again', () => {
  writeSetupState('complete');
  writeWebLabelPrintingOff();
  writeWebLabelKind('top');
  renderRouted();
  expect(screen.getByRole('link', { name: /Label Printing/ })).toBeTruthy();
});

it('a laptop Label Station keeps Label Printing whatever the web kiosk answer says', () => {
  window.__KIOSK_CONFIG__ = { mode: 'laptop' };
  writeSetupState('complete');
  writeWebLabelPrintingOff();
  saveSetup('label');
  renderRouted();
  expect(tileTitles()).toEqual(['Label Printing', 'Kiosk Setup', 'Troubleshooting', 'Settings']);
});

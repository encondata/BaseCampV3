// @vitest-environment jsdom
/** The Label Printing sections through the app's real routes (KioskGuard,
 *  SetupGate, `LabelSectionRoute`): which page each `/labels/*` path gets
 *  on a web kiosk and on a laptop. The pages themselves are stand-ins;
 *  their own tests cover them. */
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../auth/KioskAuthContext', () => {
  const auth = {
    status: 'authed', mustChangePassword: false, mustChangeReason: null, logout: async () => {},
  };
  return {
    KioskAuthProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
    useKioskAuth: () => auth,
  };
});
vi.mock('../layout/KioskShell', () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('./PrintingStation', () => ({ default: () => <p>Printing Station page</p> }));
vi.mock('./PrinterTools', () => ({ default: () => <p>Printer tools page</p> }));

import App from '../App';
import { writeKioskSetup } from '../lib/kioskSetup';
import { writeSetupState } from '../lib/setupState';

const SETUP = {
  initiativeId: 'i-1', initiativeName: 'NAP11 Hall Migration', siteId: 's-1', siteName: 'ACC4',
  siteRole: 'source' as const, scanStatus: 'k', scanLabel: 'Dock',
};

const PLACEHOLDER = 'This section is not available yet.';

function open(path: string) {
  window.history.replaceState(null, '', path);
  render(<App />);
}

beforeEach(() => {
  localStorage.clear();
  writeKioskSetup(SETUP);
  writeSetupState('complete');
});
afterEach(() => {
  cleanup();
  delete window.__KIOSK_CONFIG__;
  localStorage.clear();
});

it('web /labels/station renders the Printing Station, not the placeholder', async () => {
  open('/labels/station');
  expect(await screen.findByText('Printing Station page')).toBeTruthy();
  expect(screen.queryByText(PLACEHOLDER)).toBeNull();
});

it('/labels/bulk is still the placeholder', async () => {
  open('/labels/bulk');
  expect(await screen.findByRole('heading', { name: 'Bulk Print' })).toBeTruthy();
  expect(screen.getByText(PLACEHOLDER)).toBeTruthy();
  expect(screen.queryByText('Printing Station page')).toBeNull();
});

it('/labels/printers is Printer Setup on the web', async () => {
  open('/labels/printers');
  expect(await screen.findByText('Printer tools page')).toBeTruthy();
});

it('a laptop that is not a Label Station keeps the Printing Station placeholder', async () => {
  window.__KIOSK_CONFIG__ = { mode: 'laptop' };
  open('/labels/station');
  expect(await screen.findByText(PLACEHOLDER)).toBeTruthy();
  expect(screen.queryByText('Printing Station page')).toBeNull();
});

it('a laptop Label Station gets the Printing Station', async () => {
  window.__KIOSK_CONFIG__ = { mode: 'laptop' };
  writeKioskSetup({ ...SETUP, stationType: 'label' });
  open('/labels/station');
  expect(await screen.findByText('Printing Station page')).toBeTruthy();
});

// @vitest-environment jsdom
/** KioskShell's top bar shows a section label for the current feature
 *  route and nothing for /. */
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useNavigate, useSearchParams } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// applyPreferences reads prefers-reduced-motion; jsdom has no matchMedia.
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }));
});

const syncMock = vi.hoisted(() => ({
  status: { phase: 'idle' } as { phase: string; assets?: number; people?: number; containers?: number; trucks?: number; syncedAt?: string; error?: string },
}));
vi.mock('../lib/sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/sync')>();
  return { ...actual, useSyncStatus: () => syncMock.status };
});

const auth = vi.hoisted(() => ({
  status: 'authed' as 'authed' | 'anon',
  person: { display_name: 'Alex Worker' } as { display_name: string } | null,
  registration: 'ok' as 'ok' | 'soon' | 'expired' | 'none' | null,
  preferences: null as unknown,
  sessionExpiresAt: '2026-09-14T19:00:42.000Z' as string | null,
  kioskMove: null as { initiative_id: string; name: string } | null,
  logout: vi.fn(() => Promise.resolve()),
  setupRedirectPending: false,
  consumeSetupRedirect: vi.fn(),
  can: (_resource: string, _action: string) => true as boolean,
}));
vi.mock('../auth/KioskAuthContext', () => ({ useKioskAuth: () => auth }));

const edgeMock = vi.hoisted(() => ({
  status: null as null | {
    cloud: { online: boolean; last_contact: string | null };
    outbox: { queued: number; sending: number; needs_sign_in: number };
    session: { offline: boolean };
  },
}));
vi.mock('../lib/edgeStatus', () => ({
  useEdgeStatus: () => ({ status: edgeMock.status, refresh: async () => {} }),
}));

const laptopSetupMock = vi.hoisted(() => ({
  hydrateLaptopSetup: vi.fn((_lockedMove?: string | null) => Promise.resolve(false)),
}));
vi.mock('../lib/laptopSetup', () => laptopSetupMock);

import { clearFlash, flash } from '../lib/flash';
import { getIdentity } from '../lib/identity';
import { writeKioskSetup } from '../lib/kioskSetup';
import { writeSetupState } from '../lib/setupState';
import { DEFAULT_PREFERENCES } from '@portal/lib/settings';

import KioskShell from './KioskShell';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  auth.status = 'authed';
  auth.person = { display_name: 'Alex Worker' };
  auth.registration = 'ok';
  auth.sessionExpiresAt = '2026-09-14T19:00:42.000Z';
  auth.can = () => true;
  auth.kioskMove = null;
  auth.setupRedirectPending = false;
  syncMock.status = { phase: 'idle' };
  localStorage.clear();
});

it('shows the feature title in .kiosk-section at a feature route', () => {
  render(
    <MemoryRouter initialEntries={['/timeclock']}>
      <KioskShell><div /></KioskShell>
    </MemoryRouter>,
  );
  const section = document.querySelector('.kiosk-section');
  expect(section?.textContent).toBe('Timeclock');
});

it('has no help button, even for someone with wiki:view', () => {
  // Kiosk sessions are route-scoped (they skip 2FA) and are refused on
  // every /wiki/* route, so a guide could never be looked up or opened
  // from here. The portal keeps its ? button; the kiosk gets one once
  // there's a kiosk-safe way to show a guide.
  render(
    <MemoryRouter initialEntries={['/enroll']}>
      <KioskShell><div /></KioskShell>
    </MemoryRouter>,
  );
  expect(screen.queryByRole('button', { name: 'Help for this page' })).toBeNull();
  expect(document.querySelector('.kiosk-help')).toBeNull();
});

it('shows no section label at /', () => {
  render(
    <MemoryRouter initialEntries={['/']}>
      <KioskShell><div /></KioskShell>
    </MemoryRouter>,
  );
  expect(document.querySelector('.kiosk-section')).toBeNull();
});

it('shows "Label Printing" as the section label at a /labels sub-route', () => {
  render(
    <MemoryRouter initialEntries={['/labels/bulk']}>
      <KioskShell><div /></KioskShell>
    </MemoryRouter>,
  );
  const section = document.querySelector('.kiosk-section');
  expect(section?.textContent).toBe('Label Printing');
});

it('shows "Kiosk Setup" as the section label at /setup', () => {
  render(
    <MemoryRouter initialEntries={['/setup']}>
      <KioskShell><div /></KioskShell>
    </MemoryRouter>,
  );
  const section = document.querySelector('.kiosk-section');
  expect(section?.textContent).toBe('Kiosk Setup');
});

it('shows "Settings" as the section label at /settings', () => {
  render(
    <MemoryRouter initialEntries={['/settings']}>
      <KioskShell><div /></KioskShell>
    </MemoryRouter>,
  );
  const section = document.querySelector('.kiosk-section');
  expect(section?.textContent).toBe('Settings');
});

function SettingsStub() {
  const [params] = useSearchParams();
  return <div>SETTINGS tab={params.get('tab')}</div>;
}

it('the kiosk-name button navigates to the This Kiosk settings tab', async () => {
  render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<KioskShell><div /></KioskShell>} />
        <Route path="/settings" element={<SettingsStub />} />
      </Routes>
    </MemoryRouter>,
  );
  await userEvent.click(screen.getByRole('button', { name: getIdentity().name }));
  expect(await screen.findByText('SETTINGS tab=this-kiosk')).toBeTruthy();
});

it('footer carries context, and never repeats what the top bar shows', () => {
  render(
    <MemoryRouter initialEntries={['/']}>
      <KioskShell><div /></KioskShell>
    </MemoryRouter>,
  );
  const text = screen.getByRole('contentinfo').textContent ?? '';
  expect(text).toContain('Web');
  expect(text).toContain('0.1.0');
  expect(text).toContain('Data Sync');
  // the kiosk name, the person, the registration chip and the session's end
  // all live in the top bar now — the last of them as a hover on the person
  expect(text).not.toContain(getIdentity().name);
  expect(text).not.toContain('Alex Worker');
  expect(text).not.toContain('Registered');
  expect(text).not.toContain('Session ends');
});

it('the session end hovers on the signed-in person instead', () => {
  render(
    <MemoryRouter initialEntries={['/']}>
      <KioskShell><div /></KioskShell>
    </MemoryRouter>,
  );
  const person = document.querySelector('.kiosk-person') as HTMLElement;
  expect(person.textContent).toBe('Alex Worker');
  expect(person.title).toMatch(/^Session ends /);
});

it('footer carries no registration state, signed in or out', () => {
  auth.status = 'anon';
  auth.person = null;
  auth.registration = null;
  render(
    <MemoryRouter initialEntries={['/setup']}>
      <KioskShell><div /></KioskShell>
    </MemoryRouter>,
  );
  const footer = screen.getByRole('contentinfo');
  const text = footer.textContent ?? '';
  expect(text).toContain('Web');
  expect(text).not.toContain('Alex Worker');
  expect(text).not.toContain('Registered');   // nothing to register against while signed out
});

it('footer shows "Dev mode" when developer mode is on', () => {
  localStorage.setItem('ss.kiosk.devMode', 'true');
  render(
    <MemoryRouter initialEntries={['/']}>
      <KioskShell><div /></KioskShell>
    </MemoryRouter>,
  );
  const footer = screen.getByRole('contentinfo');
  expect(footer.textContent ?? '').toContain('Dev mode');
});

it('footer omits "Dev mode" when developer mode is off', () => {
  render(
    <MemoryRouter initialEntries={['/']}>
      <KioskShell><div /></KioskShell>
    </MemoryRouter>,
  );
  const footer = screen.getByRole('contentinfo');
  expect(footer.textContent ?? '').not.toContain('Dev mode');
});

it('footer shows "Dev mode" signed out too (kiosk-local, not tied to the session)', () => {
  auth.status = 'anon';
  auth.person = null;
  auth.registration = null;
  localStorage.setItem('ss.kiosk.devMode', 'true');
  render(
    <MemoryRouter initialEntries={['/setup']}>
      <KioskShell><div /></KioskShell>
    </MemoryRouter>,
  );
  const footer = screen.getByRole('contentinfo');
  expect(footer.textContent ?? '').toContain('Dev mode');
});

it('footer carries no setup state — the launcher already says so', () => {
  render(
    <MemoryRouter initialEntries={['/']}>
      <KioskShell><div /></KioskShell>
    </MemoryRouter>,
  );
  const text = screen.getByRole('contentinfo').textContent ?? '';
  expect(text).not.toContain('Incomplete');
  expect(document.querySelector('.kiosk-foot-setup')).toBeNull();

  writeSetupState('complete');
  expect(screen.getByRole('contentinfo').textContent ?? '').not.toContain('Complete');
});

it('footer shows Move + Site + Scan items after Setup when a selection is saved', () => {
  writeKioskSetup({
    initiativeId: 'i-1', initiativeName: 'NAP11 Hall Migration (demo)',
    siteId: 's-1', siteName: 'NAP11 Hall', siteRole: 'source',
    scanStatus: 'rfid_1_cage_exit', scanLabel: 'RFID 1 - Cage Exit',
  });
  render(
    <MemoryRouter initialEntries={['/']}>
      <KioskShell><div /></KioskShell>
    </MemoryRouter>,
  );
  const footer = screen.getByRole('contentinfo');
  const text = footer.textContent ?? '';
  expect(text).toContain('NAP11 Hall Migration (demo)');
  expect(text).toContain('NAP11 Hall');
  expect(text).toContain('RFID 1 - Cage Exit');
});

it('footer omits Move + Scan items when no selection is saved', () => {
  render(
    <MemoryRouter initialEntries={['/']}>
      <KioskShell><div /></KioskShell>
    </MemoryRouter>,
  );
  const footer = screen.getByRole('contentinfo');
  expect(footer.textContent ?? '').not.toContain('NAP11 Hall Migration (demo)');
});

it('footer shows the move a move-password session is locked to, before any setup', () => {
  auth.kioskMove = { initiative_id: 'i1', name: 'Las Vegas 3' };
  render(
    <MemoryRouter initialEntries={['/']}>
      <KioskShell><div /></KioskShell>
    </MemoryRouter>,
  );
  const items = [...document.querySelectorAll('.kiosk-foot-item')].map((el) => el.textContent ?? '');
  expect(items.some((t) => t.includes('Move') && t.includes('Las Vegas 3'))).toBe(true);
});

it('the saved setup names the move once it exists, with no duplicate', () => {
  auth.kioskMove = { initiative_id: 'i1', name: 'Las Vegas 3' };
  writeKioskSetup({
    initiativeId: 'i1', initiativeName: 'Las Vegas 3 (setup)',
    siteId: 's-1', siteName: 'NAP11 Hall', siteRole: 'source',
    scanStatus: 'x', scanLabel: 'X',
  });
  render(
    <MemoryRouter initialEntries={['/']}>
      <KioskShell><div /></KioskShell>
    </MemoryRouter>,
  );
  const text = screen.getByRole('contentinfo').textContent ?? '';
  expect(text).toContain('Las Vegas 3 (setup)');
  expect(text.match(/Move/g)).toHaveLength(1);
});

it('Data Sync is one green word after a sync, with the counts on hover', () => {
  syncMock.status = { phase: 'done', assets: 15, people: 4, containers: 6, syncedAt: '2026-09-13T18:14:00Z' };
  render(
    <MemoryRouter initialEntries={['/']}>
      <KioskShell><div /></KioskShell>
    </MemoryRouter>,
  );
  const text = screen.getByRole('contentinfo').textContent ?? '';
  expect(text).toContain('Data Sync');
  expect(text).not.toContain('15 assets');          // the counts moved to the tooltip
  const item = [...document.querySelectorAll('.kiosk-foot-item.is-status')]
    .find((el) => el.textContent === 'Data Sync') as HTMLElement;
  expect(item.className).toContain('is-good');
  expect(item.title).toContain('15 assets · 4 people · 6 containers');
});

it('Data Sync is red before any sync, and says how to fix it on hover', () => {
  render(
    <MemoryRouter initialEntries={['/']}>
      <KioskShell><div /></KioskShell>
    </MemoryRouter>,
  );
  expect(screen.getByRole('contentinfo').textContent ?? '').toContain('Data Sync');
  const bad = [...document.querySelectorAll('.kiosk-foot-item.is-status.is-bad')] as HTMLElement[];
  expect(bad.some((el) => el.title.includes('sync it from Kiosk Setup'))).toBe(true);
});

it('Data Sync turns red when the last sync failed', () => {
  syncMock.status = { phase: 'error', error: 'network', assets: 15, people: 4 };
  render(
    <MemoryRouter initialEntries={['/']}>
      <KioskShell><div /></KioskShell>
    </MemoryRouter>,
  );
  const bad = [...document.querySelectorAll('.kiosk-foot-item.is-status.is-bad')] as HTMLElement[];
  expect(bad.some((el) => el.title.includes('Last sync failed (network)'))).toBe(true);
});

it('the registration chip stays in the top bar, and follows the state', () => {
  const { unmount } = render(
    <MemoryRouter initialEntries={['/']}>
      <KioskShell><div /></KioskShell>
    </MemoryRouter>,
  );
  let chip = document.querySelector('.kiosk-user .chip') as HTMLElement;
  expect(chip.textContent).toContain('Registered');
  expect(chip.className).toContain('c-green');
  unmount();

  auth.registration = 'none';
  render(
    <MemoryRouter initialEntries={['/']}>
      <KioskShell><div /></KioskShell>
    </MemoryRouter>,
  );
  chip = document.querySelector('.kiosk-user .chip') as HTMLElement;
  expect(chip.textContent).toContain('Unregistered');
  expect(screen.getByRole('contentinfo').textContent ?? '').not.toContain('Registered');
});

it('renders the scan flash overlay, which paints once a flash fires', () => {
  render(<MemoryRouter><KioskShell><p>body</p></KioskShell></MemoryRouter>);
  expect(document.querySelector('.scan-flash')).toBeNull();
  act(() => { flash('hsl(150 60% 45%)', 350); });
  // jsdom normalizes the inline hsl() background to its rgb() equivalent.
  expect((document.querySelector('.scan-flash') as HTMLElement).style.background)
    .toBe('rgb(46, 184, 115)');
  act(() => { clearFlash(); });
});

it('laptop mode: the footer shows a bad Cloud item and Sign-in Offline', () => {
  edgeMock.status = {
    cloud: { online: false, last_contact: null },
    outbox: { queued: 2, sending: 0, needs_sign_in: 1 },
    session: { offline: true },
  };
  render(<MemoryRouter><KioskShell><p>body</p></KioskShell></MemoryRouter>);
  const cloud = screen.getByText('Cloud').closest('.kiosk-foot-item') as HTMLElement;
  expect(cloud.className).toContain('is-bad');
  expect(cloud.title).toContain('3 queued');
  expect(screen.getByText('Sign-in')).toBeTruthy();
  expect(screen.getByText('Offline')).toBeTruthy();
  edgeMock.status = null;
});

it('web mode (no edge status): no Cloud or Sign-in item', () => {
  edgeMock.status = null;
  render(<MemoryRouter><KioskShell><p>body</p></KioskShell></MemoryRouter>);
  expect(screen.queryByText('Cloud')).toBeNull();
  expect(screen.queryByText('Sign-in')).toBeNull();
});

const SAVED = {
  initiativeId: 'i-1', initiativeName: 'NAP11', siteId: 's-1', siteName: 'Hall',
  siteRole: 'source' as const, scanStatus: 'k', scanLabel: 'Dock',
};

it('laptop mode: the top bar chip names the station type once setup saved one', () => {
  window.__KIOSK_CONFIG__ = { mode: 'laptop', identity: { serial: 'kiosk-laptop-1', name: 'Kiosk 0001' } };
  const chip = () => (document.querySelector('.kiosk-mode') as HTMLElement).textContent;
  try {
    writeKioskSetup({ ...SAVED, stationType: 'rfid',
                      reader: { ip: '10.0.0.5', serial: '1234ABCD', model: 'FX9600' } });
    render(<MemoryRouter><KioskShell><p>body</p></KioskShell></MemoryRouter>);
    expect(chip()).toBe('RFID · Laptop');
    cleanup();

    writeKioskSetup({ ...SAVED, stationType: 'label' });
    render(<MemoryRouter><KioskShell><p>body</p></KioskShell></MemoryRouter>);
    expect(chip()).toBe('Label Station · Laptop');
    cleanup();

    writeKioskSetup(SAVED);
    render(<MemoryRouter><KioskShell><p>body</p></KioskShell></MemoryRouter>);
    expect(chip()).toBe('Kiosk · Laptop');
  } finally {
    delete window.__KIOSK_CONFIG__;
  }
});

it('laptop mode: the footer mode names the station type once setup saved one', () => {
  window.__KIOSK_CONFIG__ = { mode: 'laptop', identity: { serial: 'kiosk-laptop-1', name: 'Kiosk 0001' } };
  try {
    writeKioskSetup({ ...SAVED, stationType: 'rfid',
                      reader: { ip: '10.0.0.5', serial: '1234ABCD', model: 'FX9600' } });
    render(<MemoryRouter><KioskShell><p>body</p></KioskShell></MemoryRouter>);
    const mode = screen.getByText('Mode').closest('.kiosk-foot-item') as HTMLElement;
    expect(mode.textContent).toBe('ModeRFID · Laptop');
    cleanup();

    writeKioskSetup({ ...SAVED, stationType: 'label' });
    render(<MemoryRouter><KioskShell><p>body</p></KioskShell></MemoryRouter>);
    expect((screen.getByText('Mode').closest('.kiosk-foot-item') as HTMLElement).textContent)
      .toBe('ModeLabel Station · Laptop');
    cleanup();

    writeKioskSetup(SAVED);
    render(<MemoryRouter><KioskShell><p>body</p></KioskShell></MemoryRouter>);
    expect((screen.getByText('Mode').closest('.kiosk-foot-item') as HTMLElement).textContent)
      .toBe('ModeLaptop');
  } finally {
    delete window.__KIOSK_CONFIG__;
  }
});


it('signed in, the shell loads the laptop\'s shared setup; signed out it does not', () => {
  render(<MemoryRouter><KioskShell><div /></KioskShell></MemoryRouter>);
  expect(laptopSetupMock.hydrateLaptopSetup).toHaveBeenCalledTimes(1);
  expect(laptopSetupMock.hydrateLaptopSetup).toHaveBeenLastCalledWith(null);
  cleanup();
  laptopSetupMock.hydrateLaptopSetup.mockClear();
  // a move-password session passes its locked move
  auth.kioskMove = { initiative_id: 'i-7', name: 'Move 7' };
  render(<MemoryRouter><KioskShell><div /></KioskShell></MemoryRouter>);
  expect(laptopSetupMock.hydrateLaptopSetup).toHaveBeenLastCalledWith('i-7');
  cleanup();
  laptopSetupMock.hydrateLaptopSetup.mockClear();
  auth.status = 'anon';
  render(<MemoryRouter><KioskShell><div /></KioskShell></MemoryRouter>);
  expect(laptopSetupMock.hydrateLaptopSetup).not.toHaveBeenCalled();
});

function GoHome() {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate('/')}>go home</button>;
}

it('/rfid_status renders dark even when the person prefers light, and restores on leaving', async () => {
  auth.preferences = { ...DEFAULT_PREFERENCES, theme: 'light' };
  render(
    <MemoryRouter initialEntries={['/rfid_status']}>
      <KioskShell><GoHome /></KioskShell>
    </MemoryRouter>,
  );
  const shell = document.querySelector('.portal-shell') as HTMLElement;
  expect(shell.getAttribute('data-theme')).toBe('dark');
  await userEvent.setup().click(screen.getByRole('button', { name: 'go home' }));
  expect(shell.getAttribute('data-theme')).toBe('light');
  auth.preferences = null;
});

it('other routes keep the person\'s theme', () => {
  auth.preferences = { ...DEFAULT_PREFERENCES, theme: 'light' };
  render(
    <MemoryRouter initialEntries={['/timeclock']}>
      <KioskShell><div /></KioskShell>
    </MemoryRouter>,
  );
  expect(document.querySelector('.portal-shell')?.getAttribute('data-theme')).toBe('light');
  auth.preferences = null;
});

function clearSetupUi(initial: string) {
  return (
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="/scan" element={<KioskShell><div>Scan page</div></KioskShell>} />
        <Route path="/setup" element={<KioskShell><div>Setup page</div></KioskShell>} />
      </Routes>
    </MemoryRouter>
  );
}

it('a pending Clear Setup redirect sends the signed-in person to /setup, once', async () => {
  const { rerender } = render(clearSetupUi('/scan'));
  expect(await screen.findByText('Scan page')).toBeTruthy();
  expect(auth.consumeSetupRedirect).not.toHaveBeenCalled();
  auth.setupRedirectPending = true;
  rerender(clearSetupUi('/scan'));   // a fresh element: the mocked hook isn't a context, so re-render explicitly
  expect(await screen.findByText('Setup page')).toBeTruthy();
  expect(screen.queryByText('Scan page')).toBeNull();
  expect(auth.consumeSetupRedirect).toHaveBeenCalledTimes(1);
});

it('a shell mounted after the redirect was consumed (pending false) stays put', async () => {
  // KioskShell remounts when the route tree changes shape; the redirect
  // must not fire again for a clear that was already honored.
  render(clearSetupUi('/scan'));
  expect(await screen.findByText('Scan page')).toBeTruthy();
  expect(screen.queryByText('Setup page')).toBeNull();
  expect(auth.consumeSetupRedirect).not.toHaveBeenCalled();
});

it('a pending redirect while already on /setup is consumed without navigating', async () => {
  auth.setupRedirectPending = true;
  render(clearSetupUi('/setup'));
  expect(await screen.findByText('Setup page')).toBeTruthy();
  expect(auth.consumeSetupRedirect).toHaveBeenCalledTimes(1);
});

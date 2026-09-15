// @vitest-environment jsdom
/** KioskShell's top bar shows a section label for the current feature
 *  route and nothing for /. */
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useSearchParams } from 'react-router-dom';
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
  preferences: null,
  sessionExpiresAt: '2026-09-14T19:00:42.000Z' as string | null,
  logout: vi.fn(() => Promise.resolve()),
}));
vi.mock('../auth/KioskAuthContext', () => ({ useKioskAuth: () => auth }));

import { clearFlash, flash } from '../lib/flash';
import { getIdentity } from '../lib/identity';
import { writeKioskSetup } from '../lib/kioskSetup';
import { writeSetupState } from '../lib/setupState';
import KioskShell from './KioskShell';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  auth.status = 'authed';
  auth.person = { display_name: 'Alex Worker' };
  auth.registration = 'ok';
  auth.sessionExpiresAt = '2026-09-14T19:00:42.000Z';
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

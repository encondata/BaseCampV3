// @vitest-environment jsdom
/** KioskShell's top bar shows a section label for the current feature
 *  route and nothing for / or /settings. */
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
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

const auth = vi.hoisted(() => ({
  status: 'authed' as 'authed' | 'anon',
  person: { display_name: 'Alex Worker' } as { display_name: string } | null,
  registration: 'ok' as 'ok' | 'soon' | 'expired' | 'none' | null,
  preferences: null,
  sessionExpiresAt: '2026-09-14T19:00:42.000Z' as string | null,
  logout: vi.fn(() => Promise.resolve()),
}));
vi.mock('../auth/KioskAuthContext', () => ({ useKioskAuth: () => auth }));

import { getIdentity } from '../lib/identity';
import KioskShell from './KioskShell';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  auth.status = 'authed';
  auth.person = { display_name: 'Alex Worker' };
  auth.registration = 'ok';
  auth.sessionExpiresAt = '2026-09-14T19:00:42.000Z';
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

it('shows "Kiosk Setup" as the section label at /settings', () => {
  render(
    <MemoryRouter initialEntries={['/settings']}>
      <KioskShell><div /></KioskShell>
    </MemoryRouter>,
  );
  const section = document.querySelector('.kiosk-section');
  expect(section?.textContent).toBe('Kiosk Setup');
});

it('footer shows the kiosk facts when signed in', () => {
  render(
    <MemoryRouter initialEntries={['/']}>
      <KioskShell><div /></KioskShell>
    </MemoryRouter>,
  );
  const footer = screen.getByRole('contentinfo');
  const text = footer.textContent ?? '';
  expect(text).toContain(getIdentity().name);
  expect(text).toContain('Web');
  expect(text).toContain('0.1.0');
  expect(text).toContain('Alex Worker');
  expect(text).toContain('Registered');
  expect(text).toContain('Session ends');
});

it('footer shows only kiosk/mode/version when signed out', () => {
  auth.status = 'anon';
  auth.person = null;
  auth.registration = null;
  render(
    <MemoryRouter initialEntries={['/settings']}>
      <KioskShell><div /></KioskShell>
    </MemoryRouter>,
  );
  const footer = screen.getByRole('contentinfo');
  const text = footer.textContent ?? '';
  expect(text).toContain(getIdentity().name);
  expect(text).toContain('Web');
  expect(text).not.toContain('Alex Worker');
});

// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_PREFERENCES } from '@portal/lib/settings';

type Auth = {
  status: 'loading' | 'authed' | 'anon';
  mustChangePassword: boolean;
  person: Record<string, unknown> | null;
  roles: string[];
  preferences: typeof DEFAULT_PREFERENCES;
  can: (resource: string, action?: string) => boolean;
  logout: () => Promise<void>;
};

const auth = vi.hoisted(() => ({ value: null as unknown as Auth }));
vi.mock('@portal/auth/AuthContext', () => ({ useAuth: () => auth.value }));
vi.mock('@portal/pages/Login', () => ({
  default: ({ eyebrow }: { eyebrow?: string }) => <p>portal sign-in ({eyebrow})</p>,
}));

// the pages load their lists: no network
vi.mock('@portal/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@portal/lib/api')>()),
  accessTokenForService: vi.fn(async () => 'tok'),
  refreshSession: vi.fn(async () => null),
}));

import App from './App';

/** `can` for a role holding exactly these app_distribution actions. */
function grants(...actions: string[]) {
  return (resource: string, action = 'view') => resource === 'app_distribution' && actions.includes(action);
}

function signedIn(over: Partial<Auth> = {}): Auth {
  return {
    status: 'authed',
    mustChangePassword: false,
    person: { display_name: 'Sam Staff', email: 'sam@example.com', avatar_url: null },
    roles: ['staff'],
    preferences: DEFAULT_PREFERENCES,
    can: grants('view'),
    logout: vi.fn(async () => {}),
    ...over,
  };
}

function stubViewport(mobile: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: mobile && query === '(max-width: 900px)', media: query,
    addEventListener: () => {}, removeEventListener: () => {},
  }));
}

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function renderAt(at: string) {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <App />
      <Where />
    </MemoryRouter>,
  );
}

const nav = () => screen.getByRole('navigation', { name: 'Primary' });

beforeEach(() => {
  auth.value = signedIn();
  stubViewport(false);
  // an empty catalog and device list
  vi.stubGlobal('fetch', vi.fn(async (path: string) => new Response(
    path.startsWith('/api/devices') ? '{"devices":[],"counts":[]}' : '[]',
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('App', () => {
  it('renders the portal sign-in at /login with the Devices eyebrow', () => {
    auth.value = { ...signedIn(), status: 'anon', person: null };
    renderAt('/login');
    expect(screen.getByText('portal sign-in (Devices)')).toBeTruthy();
  });

  it('sends a signed-out visitor to the sign-in page', () => {
    auth.value = { ...signedIn(), status: 'anon', person: null };
    renderAt('/devices');
    expect(screen.getByText('portal sign-in (Devices)')).toBeTruthy();
    expect(screen.getByTestId('where').textContent).toBe('/login');
  });

  it('renders nothing while the session is restored', () => {
    auth.value = { ...signedIn(), status: 'loading' };
    const { container } = renderAt('/');
    expect(container.querySelector('.portal-nav')).toBeNull();
    expect(screen.queryByText(/portal sign-in/)).toBeNull();
  });

  it('brings staff to the shell with Apps and Devices, and no Apple settings', () => {
    const { container } = renderAt('/');
    expect(container.querySelector('.portal-nav .logo-tag')?.textContent).toBe('Devices');
    const links = within(nav()).getAllByRole('link');
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Apps', '/'], ['Devices', '/devices'],
    ]);
    expect(within(nav()).queryByRole('link', { name: 'Apple settings' })).toBeNull();
    expect(container.querySelector('.topbar .crumbs')?.textContent).toBe('Devices/Apps');
  });

  it('shows Apple settings to a role that may change app distribution', () => {
    auth.value = signedIn({ roles: ['admin'], can: grants('view', 'add', 'change', 'delete') });
    renderAt('/apple');
    expect(within(nav()).getByRole('link', { name: 'Apple settings' }).getAttribute('href')).toBe('/apple');
    expect(screen.getByRole('heading', { name: 'Apple settings' })).toBeTruthy();
  });

  it('a staff user who types /apple sees the no-permission notice', () => {
    renderAt('/apple');
    expect(screen.getByText("You don't have access to Apple settings")).toBeTruthy();
    expect(screen.queryByLabelText('Team ID')).toBeNull();
  });

  it('tells a signed-in user without view permission they have no access', () => {
    auth.value = signedIn({ roles: ['crew'], can: () => false });
    const { container } = renderAt('/');
    expect(screen.getByText("You don't have access to Devices")).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to portal' }).getAttribute('href')).toBe('http://localhost:5173');
    expect(container.querySelector('.portal-nav')).toBeNull();
  });

  it('sends a temporary password to the portal first', () => {
    auth.value = signedIn({ mustChangePassword: true });
    renderAt('/');
    expect(screen.getByText('Set a new password first')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the portal' })).toBeTruthy();
  });

  it("the no-access notice follows the user's theme", () => {
    auth.value = signedIn({ can: () => false, preferences: { ...DEFAULT_PREFERENCES, theme: 'dark' } });
    const { container } = renderAt('/');
    expect(screen.getByText("You don't have access to Devices")).toBeTruthy();
    expect(container.querySelector('.portal-shell')?.getAttribute('data-theme')).toBe('dark');
  });

  it("the set-a-new-password notice follows the user's theme", () => {
    auth.value = signedIn({ mustChangePassword: true, preferences: { ...DEFAULT_PREFERENCES, theme: 'dark' } });
    const { container } = renderAt('/');
    expect(screen.getByText('Set a new password first')).toBeTruthy();
    expect(container.querySelector('.portal-shell')?.getAttribute('data-theme')).toBe('dark');
  });

  it("follows the user's theme and nav mode preferences", () => {
    auth.value = signedIn({ preferences: { ...DEFAULT_PREFERENCES, theme: 'dark', nav_mode: 'rail' } });
    const { container } = renderAt('/');
    const shell = container.querySelector('.portal-shell');
    expect(shell?.getAttribute('data-theme')).toBe('dark');
    expect(shell?.getAttribute('data-nav-mode')).toBe('rail');
    // the rail shows section icons, not the accordion
    expect(container.querySelector('.portal-nav.docked .nav-sec-body')).toBeNull();
    expect(within(nav()).getByRole('button', { name: 'Devices' }).getAttribute('title')).toBe('Devices');
  });

  it('opens the nav as an overlay from the hamburger under the mobile breakpoint', async () => {
    stubViewport(true);
    const { container } = renderAt('/');
    expect(container.querySelector('.portal-nav.overlay')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    const overlay = container.querySelector<HTMLElement>('.portal-nav.overlay')!;
    expect(overlay).toBeTruthy();
    await userEvent.click(within(overlay).getByRole('link', { name: 'Devices' }));
    expect(container.querySelector('.portal-nav.overlay')).toBeNull();
    expect(screen.getByTestId('where').textContent).toBe('/devices');
  });

  it('the chip menu goes back to the portal or signs out', async () => {
    renderAt('/devices');
    await userEvent.click(screen.getByRole('button', { name: /Sam Staff/ }));
    const menu = screen.getByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Back to portal' }).getAttribute('href'))
      .toBe('http://localhost:5173');
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Sign out' }));
    expect(auth.value.logout).toHaveBeenCalled();
    expect(screen.getByTestId('where').textContent).toBe('/login');
  });
});

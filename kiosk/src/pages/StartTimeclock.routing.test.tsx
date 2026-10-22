// @vitest-environment jsdom
/** Start Time Clock through the app's real routes: KioskGuard around the
 *  page, StationRoot at `/`, and an auth provider whose logout flips the
 *  status to anon the way KioskAuthProvider's does. A sign-out must land
 *  on the station Welcome, never on (or through) the sign-in page. */
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const visited = vi.hoisted(() => [] as string[]);
const authMock = vi.hoisted(() => ({ logoutFails: false, startAnon: false }));
vi.mock('../auth/KioskAuthContext', async () => {
  const React = await import('react');
  const Ctx = React.createContext<unknown>(null);
  function KioskAuthProvider({ children }: { children: ReactNode }) {
    const [status, setStatus] = React.useState<'authed' | 'anon'>(authMock.startAnon ? 'anon' : 'authed');
    const value = React.useMemo(() => ({
      status,
      mustChangePassword: false,
      mustChangeReason: null,
      // Like the real provider: the sign-out requests resolve in a later
      // task, then the status flips to anon.
      logout: async () => {
        await new Promise((r) => setTimeout(r, 0));
        if (authMock.logoutFails) throw new Error('storage unavailable');
        setStatus('anon');
      },
    }), [status]);
    return React.createElement(Ctx.Provider, { value }, children);
  }
  return { KioskAuthProvider, useKioskAuth: () => React.useContext(Ctx) };
});

const stationMock = vi.hoisted(() => ({
  armDisplay: vi.fn(async () => {}),
  info: null as null | Record<string, unknown>,
  armed: {
    timeclock: true, ready: true, paused: false, armed: true, key_missing: false,
    initiative_name: null, site_name: 'ACC4',
  },
}));
vi.mock('../timeclock/stationApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../timeclock/stationApi')>();
  return {
    ...actual,
    armDisplay: stationMock.armDisplay,
    useStationInfo: () => ({ loading: false, info: stationMock.info, refresh: () => {} }),
    stationPeople: vi.fn(async () => []),
  };
});

vi.mock('../layout/KioskShell', () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('./Home', () => ({ default: () => <div>Home page</div> }));
vi.mock('./Login', () => ({
  default: () => {
    visited.push('login');
    return <div>Login page</div>;
  },
}));

import App from '../App';

// jsdom leaves the last dispatched event on window.event, so React reads
// the sign-out's state change as part of the click and renders it at once.
// In a browser there is no event by then: the change renders at default
// priority, after the page's own navigate() has been queued — the order
// that let KioskGuard's sign-in redirect win live.
const eventDescriptor = Object.getOwnPropertyDescriptor(window, 'event');
beforeEach(() => {
  Object.defineProperty(window, 'event', { configurable: true, get: () => undefined });
  visited.length = 0;
  authMock.logoutFails = false;
  authMock.startAnon = false;
  stationMock.info = { ...stationMock.armed };
  stationMock.armDisplay.mockReset().mockImplementation(async () => {});
  window.history.replaceState(null, '', '/timeclock/station');
});
afterEach(() => {
  cleanup();
  if (eventDescriptor) Object.defineProperty(window, 'event', eventDescriptor);
  else delete (window as { event?: unknown }).event;
});

/** Let any queued redirect run before reading where the app ended up. */
async function settle() {
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
}

it('a successful arm + sign-out ends on / with Welcome, never on sign-in', async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getByRole('button', { name: 'Start Time Clock' }));
  await settle();
  expect(window.location.pathname).toBe('/');
  expect(screen.getByRole('heading', { name: 'Welcome!' })).toBeTruthy();
  expect(visited).not.toContain('login');
});

it('a failed sign-out stays on the page with its message', async () => {
  authMock.logoutFails = true;
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getByRole('button', { name: 'Start Time Clock' }));
  expect((await screen.findByRole('alert')).textContent).toBe("Couldn't sign you out. Try again.");
  await settle();
  expect(window.location.pathname).toBe('/timeclock/station');
  expect(visited).not.toContain('login');
});

it('nobody signed in on a kiosk that is not armed still reaches sign-in', async () => {
  authMock.startAnon = true;
  stationMock.info = { ...stationMock.armed, armed: false };
  render(<App />);
  await settle();
  expect(window.location.pathname).toBe('/login');
  expect(screen.getByText('Login page')).toBeTruthy();
});

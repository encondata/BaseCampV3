// @vitest-environment jsdom
/** `/`: the signed-out Time Clock Welcome on an armed Time Clock station,
 *  otherwise the guarded Home exactly as before. */
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ status: 'anon' as 'loading' | 'anon' | 'authed', mustChangePassword: false }));
vi.mock('../auth/KioskAuthContext', () => ({ useKioskAuth: () => auth }));

const station = vi.hoisted(() => ({
  value: { loading: false, info: null as null | Record<string, unknown>, refresh: () => {} },
}));
vi.mock('../timeclock/stationApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../timeclock/stationApi')>();
  return {
    ...actual,
    useStationInfo: () => station.value,
    stationPeople: vi.fn(async () => []),
  };
});

vi.mock('../layout/KioskShell', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../pages/Home', () => ({ default: () => <div>Home page</div> }));

import StationRoot from './StationRoot';

const INFO = {
  timeclock: true, ready: true, paused: false, armed: true, initiative_name: null, site_name: 'ACC4',
};

function renderRoot() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<StationRoot />} />
        <Route path="/login" element={<div>Login page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  auth.status = 'anon';
  station.value = { loading: false, info: { ...INFO }, refresh: () => {} };
});
afterEach(() => cleanup());

it('renders nothing while the station info loads', () => {
  station.value = { loading: true, info: null, refresh: () => {} };
  const { container } = renderRoot();
  expect(container.textContent).toBe('');
});

it('anon + an armed time clock shows the Welcome screen', async () => {
  renderRoot();
  expect(await screen.findByRole('heading', { name: 'Welcome!' })).toBeTruthy();
});

it('an armed station that is not ready shows Welcome paused', async () => {
  station.value = { loading: false, info: { ...INFO, ready: false, paused: true }, refresh: () => {} };
  renderRoot();
  expect(await screen.findByText(/This time clock is paused\./)).toBeTruthy();
});

it('anon + a time clock that is not armed goes to sign-in', async () => {
  station.value = { loading: false, info: { ...INFO, armed: false }, refresh: () => {} };
  renderRoot();
  expect(await screen.findByText('Login page')).toBeTruthy();
});

it('anon on a kiosk that is not a time clock goes to sign-in', async () => {
  station.value = { loading: false, info: null, refresh: () => {} };
  renderRoot();
  expect(await screen.findByText('Login page')).toBeTruthy();
});

it('signed in shows Home, even on an armed time clock', async () => {
  auth.status = 'authed';
  renderRoot();
  expect(await screen.findByText('Home page')).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Welcome!' })).toBeNull();
});

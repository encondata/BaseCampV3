// @vitest-environment jsdom
/** The sign-in page on an armed Time Clock station: the station Welcome's
 *  gear lands here, so a signed-out visitor gets a way back to the time
 *  clock, and an untouched page returns there by itself after a minute.
 *  Everywhere else the page is unchanged. */
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  status: 'anon' as 'anon' | 'authed' | 'loading',
  login: vi.fn(), loginWithMovePassword: vi.fn(), completePair: vi.fn(),
}));
vi.mock('../auth/KioskAuthContext', () => ({ useKioskAuth: () => auth }));
vi.mock('../components/PairPanel', () => ({ default: () => <div>PAIR PANEL</div> }));
vi.mock('../components/KioskBanners', () => ({ default: () => null }));
vi.mock('../lib/edgeStatus', () => ({ useEdgeStatus: () => ({ status: null, refresh: async () => {} }) }));

const station = vi.hoisted(() => ({ info: null as null | Record<string, unknown> }));
vi.mock('../timeclock/stationApi', () => ({
  useStationInfo: () => ({ loading: false, info: station.info, refresh: () => {} }),
}));

import Login from './Login';

const ARMED = {
  timeclock: true, ready: true, paused: false, armed: true, initiative_name: null, site_name: null,
};
const BACK = 'Back to the time clock';

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<div>TIME CLOCK</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  auth.status = 'anon';
  station.info = { ...ARMED };
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('on an armed time clock, signed out', () => {
  it('offers a way back to the time clock', async () => {
    renderLogin();
    await userEvent.click(screen.getByRole('button', { name: BACK }));
    expect(screen.getByText('TIME CLOCK')).toBeTruthy();
  });

  it('returns to the time clock on its own after 60 s untouched, and typing keeps it here', () => {
    vi.useFakeTimers();
    renderLogin();
    act(() => { vi.advanceTimersByTime(50_000); });
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' })); });
    act(() => { vi.advanceTimersByTime(50_000); });
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeTruthy();
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(screen.getByText('TIME CLOCK')).toBeTruthy();
  });
});

it.each([
  ['the station is not armed', () => { station.info = { ...ARMED, armed: false }; }],
  ['the kiosk is not a time clock', () => { station.info = null; }],
  ['someone is signed in', () => { auth.status = 'authed'; }],
])('nothing changes when %s', (_label, arrange) => {
  arrange();
  vi.useFakeTimers();
  renderLogin();
  expect(screen.queryByRole('button', { name: BACK })).toBeNull();
  act(() => { vi.advanceTimersByTime(120_000); });
  expect(screen.getByRole('heading', { name: 'Sign in' })).toBeTruthy();
});

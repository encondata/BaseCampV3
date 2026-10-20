// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => [] as string[]);
const auth = vi.hoisted(() => ({ status: 'authed', logout: vi.fn() }));
vi.mock('../auth/KioskAuthContext', () => ({ useKioskAuth: () => auth }));

const stationMock = vi.hoisted(() => ({ armDisplay: vi.fn() }));
vi.mock('../timeclock/stationApi', () => stationMock);

import { ApiError } from '../lib/api';
import StartTimeclock from './StartTimeclock';

beforeEach(() => {
  calls.length = 0;
  stationMock.armDisplay.mockReset().mockImplementation(async () => { calls.push('arm'); });
  auth.logout.mockReset().mockImplementation(async () => { calls.push('logout'); });
});
afterEach(() => { cleanup(); });

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/timeclock/station']}>
      <Routes>
        <Route path="/timeclock/station" element={<StartTimeclock />} />
        <Route path="/" element={<div>Welcome route</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

it('explains what starting does', () => {
  renderPage();
  expect(screen.getByRole('heading', { name: 'Start the time clock' })).toBeTruthy();
  expect(screen.getByText('This signs you out and shows the Welcome screen for workers.')).toBeTruthy();
});

it('Start Time Clock arms the display, signs out, then goes to /', async () => {
  const user = userEvent.setup();
  renderPage();
  await user.click(screen.getByRole('button', { name: 'Start Time Clock' }));
  expect(await screen.findByText('Welcome route')).toBeTruthy();
  expect(calls).toEqual(['arm', 'logout']);
});

it.each([
  ['not_timeclock_station', 409, "This kiosk isn't set up as a Time Clock station yet. Run Kiosk Setup first."],
  ['move_locked', 403, "A move password can't start the time clock. Sign in with your own account."],
  ['network', 0, "Couldn't start the time clock. Try again."],
  ['unknown_error', 500, "Couldn't start the time clock. Try again."],
])('%s shows its message and stays signed in', async (code, status, message) => {
  stationMock.armDisplay.mockRejectedValue(new ApiError(status, code));
  const user = userEvent.setup();
  renderPage();
  await user.click(screen.getByRole('button', { name: 'Start Time Clock' }));
  expect((await screen.findByRole('alert')).textContent).toBe(message);
  expect(auth.logout).not.toHaveBeenCalled();
  expect(screen.queryByText('Welcome route')).toBeNull();
  // The button is usable again for another try.
  await waitFor(() => expect(
    (screen.getByRole('button', { name: 'Start Time Clock' }) as HTMLButtonElement).disabled,
  ).toBe(false));
});

it('a non-API failure shows the generic message', async () => {
  stationMock.armDisplay.mockRejectedValue(new Error('boom'));
  const user = userEvent.setup();
  renderPage();
  await user.click(screen.getByRole('button', { name: 'Start Time Clock' }));
  expect((await screen.findByRole('alert')).textContent).toBe("Couldn't start the time clock. Try again.");
});

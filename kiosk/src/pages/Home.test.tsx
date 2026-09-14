// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  status: 'authed', person: { display_name: 'Alex Worker' }, perms: null, preferences: null,
  mustChangePassword: false, sessionExpiresAt: '2030-01-01T00:00:00Z', registration: 'ok',
  heartbeatNow: vi.fn(() => Promise.resolve()),
  login: vi.fn(), completePair: vi.fn(), logout: vi.fn(), can: () => true,
}));
vi.mock('../auth/KioskAuthContext', () => ({ useKioskAuth: () => auth }));

import { FEATURES } from '../lib/features';
import { getIdentity } from '../lib/identity';
import FeaturePage from './FeaturePage';
import Home from './Home';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

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

it('renders a tile link for each feature', () => {
  renderRouted();
  expect(screen.getByRole('link', { name: /Scanning/ }).getAttribute('href')).toBe('/scan');
  expect(screen.getByRole('link', { name: /Label Printing/ }).getAttribute('href')).toBe('/labels');
  expect(screen.getByRole('link', { name: /Timeclock/ }).getAttribute('href')).toBe('/timeclock');
});

it('still shows the facts strip with the kiosk name', () => {
  renderRouted();
  const facts = document.querySelector('.kiosk-facts-compact');
  expect(facts).toBeTruthy();
  expect(facts!.textContent).toContain(getIdentity().name);
  expect(screen.getByText('Alex Worker')).toBeTruthy();
});

it('navigates to the placeholder and back', async () => {
  renderRouted();
  await userEvent.click(screen.getByRole('link', { name: /Timeclock/ }));
  expect(await screen.findByText('This feature is not available yet.')).toBeTruthy();
  await userEvent.click(screen.getByRole('link', { name: 'Back to home' }));
  expect(await screen.findByText('What would you like to do?')).toBeTruthy();
});

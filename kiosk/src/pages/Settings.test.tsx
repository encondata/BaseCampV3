// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ isAdmin: false, isDeveloper: false }));
vi.mock('../auth/KioskAuthContext', () => ({ useKioskAuth: () => auth }));

import Settings from './Settings';

afterEach(() => {
  cleanup();
  auth.isAdmin = false;
  auth.isDeveloper = false;
});

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Settings />
    </MemoryRouter>,
  );
}

it('a worker sees exactly Appearance, Sound, and Devices — no Admin or Developer text', () => {
  renderAt('/settings');
  expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Appearance', 'Sound', 'Devices']);
  expect(screen.queryByText('Admin')).toBeNull();
  expect(screen.queryByText('Developer')).toBeNull();
});

it('a developer sees all five tabs', () => {
  auth.isAdmin = true;
  auth.isDeveloper = true;
  renderAt('/settings');
  expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
    'Appearance', 'Sound', 'Devices', 'Admin', 'Developer',
  ]);
});

it('clicking Sound selects it and shows its panel', async () => {
  renderAt('/settings');
  await userEvent.click(screen.getByRole('tab', { name: 'Sound' }));
  expect(screen.getByRole('tab', { name: 'Sound' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByRole('tab', { name: 'Appearance' }).getAttribute('aria-selected')).toBe('false');
  expect(screen.getByRole('heading', { name: 'Sound' })).toBeTruthy();
});

it('a worker requesting the hidden admin tab falls back to Appearance', () => {
  renderAt('/settings?tab=admin');
  expect(screen.getByRole('tab', { name: 'Appearance' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByRole('heading', { name: 'Appearance' })).toBeTruthy();
});

it('an admin requesting ?tab=admin sees Admin selected', () => {
  auth.isAdmin = true;
  renderAt('/settings?tab=admin');
  expect(screen.getByRole('tab', { name: 'Admin' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByRole('heading', { name: 'Admin' })).toBeTruthy();
});

// @vitest-environment jsdom
/**
 * ⌘K palette: the two notification destinations. "All notifications" opens
 * the full inbox page; "Notification settings" (it used to read "My
 * notifications") opens the person's delivery settings.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

// One stable object: the palette resets its search whenever `can` changes identity.
const auth = vi.hoisted(() => ({
  can: () => false, preferences: { theme: 'light' }, updatePreferences: () => {},
  godMode: false, enableGodMode: () => {}, maxRank: 0, scope: { global: true },
}));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => auth }));
const topbar = vi.hoisted(() => ({ paletteOpen: true, setPaletteOpen: () => {} }));
vi.mock('../lib/topbar', () => ({ useTopbar: () => topbar }));
vi.mock('../lib/api', () => ({
  apiFetch: vi.fn(() => new Promise(() => {})),
  unlockGodMode: vi.fn(() => Promise.resolve(null)),
}));

const { default: CommandPalette } = await import('./CommandPalette');

afterEach(cleanup);

function renderPalette() {
  render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<CommandPalette />} />
        <Route path="/notifications" element={<div>all notifications page</div>} />
        <Route path="/me/notifications" element={<div>settings page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

const labels = () => [...document.querySelectorAll('.kbar-item')].map((b) => b.textContent);

it('lists All notifications and Notification settings; "My notifications" is gone', async () => {
  const user = userEvent.setup();
  renderPalette();
  await user.type(screen.getByPlaceholderText('Search commands and people…'), 'notif');
  expect(labels()).toEqual(['All notifications', 'Notification settings']);
  expect(screen.queryByText('My notifications')).toBeNull();
});

it('All notifications opens /notifications', async () => {
  const user = userEvent.setup();
  renderPalette();
  await user.click(screen.getByRole('button', { name: 'All notifications' }));
  await waitFor(() => expect(screen.getByText('all notifications page')).toBeTruthy());
});

it('Notification settings opens /me/notifications', async () => {
  const user = userEvent.setup();
  renderPalette();
  await user.click(screen.getByRole('button', { name: 'Notification settings' }));
  await waitFor(() => expect(screen.getByText('settings page')).toBeTruthy());
});

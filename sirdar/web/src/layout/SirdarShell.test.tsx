// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

const updatePreferences = vi.fn().mockResolvedValue(true);
vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({
    person: { display_name: 'Alice Anderson', email: 'a@b.co', avatar_url: null },
    roles: ['admin'], logout: vi.fn(), updatePreferences, can: () => true,
    preferences: { nav_mode: 'expanded', nav_bg: 'default', nav_size: 'default', accent: 'amber',
                   theme: 'light', density: 'comfortable', list_size: 'default', motion: true,
                   notif: {}, list_prefs: {} },
  }),
}));

import SirdarShell from './SirdarShell';

// jsdom has no matchMedia; applyPreferences reads prefers-reduced-motion.
window.matchMedia = ((q: string) => ({
  matches: false, media: q, onchange: null,
  addEventListener: () => {}, removeEventListener: () => {},
  addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

afterEach(cleanup);

it('renders the Sirdar-tagged nav and the page', () => {
  render(<MemoryRouter><SirdarShell><p>content</p></SirdarShell></MemoryRouter>);
  expect(screen.getAllByText('Sirdar').length).toBeGreaterThan(0);
  expect(screen.getByText('Users')).toBeTruthy();
  expect(screen.getByText('content')).toBeTruthy();
});

it('Ctrl+B cycles the nav mode through preferences', () => {
  render(<MemoryRouter><SirdarShell><p>content</p></SirdarShell></MemoryRouter>);
  fireEvent.keyDown(document, { key: 'b', ctrlKey: true });
  expect(updatePreferences).toHaveBeenCalledWith(expect.objectContaining({ nav_mode: 'rail' }));
});

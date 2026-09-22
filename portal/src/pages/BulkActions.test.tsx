// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

const authMock = vi.hoisted(() => ({ canSites: true }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    person: { id: 'me-1', display_name: 'Me' }, roles: ['admin'], maxRank: 60, godMode: false,
    can: (resource: string) => (resource === 'sites' ? authMock.canSites : true),
    preferences: { list_prefs: {} }, updatePreferences: vi.fn(),
  }),
}));
afterEach(() => {
  cleanup();
  authMock.canSites = true;
});
const { default: BulkActions } = await import('./BulkActions');

it('renders the empty state until tools are added', () => {
  authMock.canSites = false;
  render(<MemoryRouter><BulkActions /></MemoryRouter>);
  expect(screen.getByRole('heading', { name: 'Bulk Actions' })).toBeTruthy();
  expect(screen.getByText('Nothing here yet')).toBeTruthy();
  expect(screen.getByText('Bulk tools will appear here as they are added.')).toBeTruthy();
});

it('lists the sites card when the viewer can add sites', () => {
  render(<MemoryRouter><BulkActions /></MemoryRouter>);
  expect(screen.getByText('Add or update sites in bulk')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy();
});

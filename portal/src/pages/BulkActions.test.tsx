// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    person: { id: 'me-1', display_name: 'Me' }, roles: ['admin'], maxRank: 60, godMode: false,
    can: () => true, preferences: { list_prefs: {} }, updatePreferences: vi.fn(),
  }),
}));
afterEach(cleanup);
const { default: BulkActions } = await import('./BulkActions');

it('renders the empty state until tools are added', () => {
  render(<MemoryRouter><BulkActions /></MemoryRouter>);
  expect(screen.getByRole('heading', { name: 'Bulk Actions' })).toBeTruthy();
  expect(screen.getByText('Nothing here yet')).toBeTruthy();
  expect(screen.getByText('Bulk tools will appear here as they are added.')).toBeTruthy();
});

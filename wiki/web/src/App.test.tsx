// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({ status: 'anon', mustChangePassword: false, can: () => false, preferences: {} }),
}));
vi.mock('@portal/pages/Login', () => ({ default: () => <div>portal sign-in</div> }));

import App from './App';

afterEach(cleanup);

describe('App', () => {
  it('sends a signed-out visitor from any wiki route to the sign-in page', () => {
    render(<MemoryRouter initialEntries={['/n/abc']}><App /></MemoryRouter>);
    expect(screen.getByText('portal sign-in')).toBeTruthy();
  });
});

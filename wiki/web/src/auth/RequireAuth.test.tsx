// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@portal/auth/AuthContext', () => ({ useAuth: vi.fn() }));

import { useAuth } from '@portal/auth/AuthContext';

import RequireAuth from './RequireAuth';

type Auth = ReturnType<typeof useAuth>;

function authAs(state: { status: Auth['status']; canView?: boolean; mustChangePassword?: boolean }) {
  const can = vi.fn((resource: string, action = 'view') =>
    resource === 'wiki' && action === 'view' && !!state.canView);
  vi.mocked(useAuth).mockReturnValue({
    status: state.status,
    mustChangePassword: !!state.mustChangePassword,
    can,
  } as unknown as Auth);
  return can;
}

function LoginProbe() {
  const location = useLocation();
  const from = (location.state as { from?: { pathname: string; search: string } } | null)?.from;
  return <div>login page, from {from ? `${from.pathname}${from.search}` : 'nowhere'}</div>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<LoginProbe />} />
        <Route path="*" element={<RequireAuth><div>wiki content</div></RequireAuth>} />
      </Routes>
    </MemoryRouter>,
  );
}

// jsdom serves the test page from http://localhost, so the portal link
// falls back to the portal's dev port
afterEach(cleanup);

describe('RequireAuth', () => {
  it('renders nothing while the session is being restored', () => {
    authAs({ status: 'loading' });
    const { container } = renderAt('/n/abc');
    expect(container.innerHTML).toBe('');
  });

  it('sends a signed-out visitor to /login, remembering where they were headed', () => {
    authAs({ status: 'anon' });
    renderAt('/n/abc?tab=history');
    expect(screen.getByText('login page, from /n/abc?tab=history')).toBeTruthy();
    expect(screen.queryByText('wiki content')).toBeNull();
  });

  it('shows the wiki to someone with wiki view access', () => {
    const can = authAs({ status: 'authed', canView: true });
    renderAt('/');
    expect(screen.getByText('wiki content')).toBeTruthy();
    expect(can).toHaveBeenCalledWith('wiki', 'view');
  });

  it('explains the missing access and links back to the portal', () => {
    authAs({ status: 'authed', canView: false });
    renderAt('/');
    expect(screen.queryByText('wiki content')).toBeNull();
    expect(screen.getByRole('heading', { name: "You don't have access to the wiki" })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to the portal' }).getAttribute('href'))
      .toBe('http://localhost:5173');
  });

  it('sends an account that must change its password to the portal first', () => {
    authAs({ status: 'authed', canView: true, mustChangePassword: true });
    renderAt('/');
    expect(screen.queryByText('wiki content')).toBeNull();
    expect(screen.getByRole('link', { name: 'Open the portal' }).getAttribute('href'))
      .toBe('http://localhost:5173');
  });
});

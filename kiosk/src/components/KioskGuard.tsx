/** The kiosk's ProtectedRoute: wait for the cookie restore, bounce to
 *  /login when anonymous, and hold temp-password accounts on a notice
 *  (the kiosk hosts no change-password form). */

import type { ReactNode } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';

import { useKioskAuth } from '../auth/KioskAuthContext';
import KioskShell from '../layout/KioskShell';
import { portalUrl } from '../lib/config';

export default function KioskGuard({ children }: { children: ReactNode }) {
  const { status, mustChangePassword, logout } = useKioskAuth();
  const location = useLocation();
  const navigate = useNavigate();

  if (status === 'loading') return null;
  if (status === 'anon') return <Navigate to="/login" replace state={{ from: location }} />;
  if (mustChangePassword) {
    return (
      <KioskShell>
        <div className="portal-page">
          <div className="eyebrow">Kiosk</div>
          <h1 className="page-title">Password change required</h1>
          <p className="page-hint">
            Your password needs to be changed before you can use a kiosk. Sign in to the portal
            at {portalUrl()} to change it, then sign in here again.
          </p>
          <button type="button" className="btn-solid"
                  onClick={() => void logout().then(() => navigate('/login'))}>
            Sign out
          </button>
        </div>
      </KioskShell>
    );
  }
  return <>{children}</>;
}

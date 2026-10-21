/** The kiosk's ProtectedRoute: wait for the cookie restore, bounce to
 *  /login when anonymous (or to `anonTo`), and hold accounts that must set
 *  a new password (temporary or expired) on a notice (the kiosk hosts no
 *  change-password form). */

import type { ReactNode } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';

import { useKioskAuth } from '../auth/KioskAuthContext';
import KioskShell from '../layout/KioskShell';
import { portalUrl } from '../lib/config';

export default function KioskGuard({ children, anonTo }: {
  children: ReactNode;
  /** Where an anonymous visitor goes instead of /login. Start Time Clock
   *  uses `/`: its own sign-out turns the session anon while it is still
   *  on screen, and the station Welcome — not sign-in — is where that
   *  sign-out belongs. `/` still sends anyone else on to sign-in. */
  anonTo?: string;
}) {
  const { status, mustChangePassword, mustChangeReason, logout } = useKioskAuth();
  const location = useLocation();
  const navigate = useNavigate();

  if (status === 'loading') return null;
  if (status === 'anon') {
    return anonTo
      ? <Navigate to={anonTo} replace />
      : <Navigate to="/login" replace state={{ from: location }} />;
  }
  if (mustChangePassword) {
    return (
      <KioskShell>
        <div className="portal-page">
          <div className="eyebrow">Kiosk</div>
          <h1 className="page-title">
            {mustChangeReason === 'expired' ? 'Your password has expired' : 'Password change required'}
          </h1>
          <p className="page-hint">
            {mustChangeReason === 'expired'
              ? <>Sign in to the portal at {portalUrl()} to choose a new one, then sign in here again.</>
              : <>Your password needs to be changed before you can use a kiosk. Sign in to the portal
                  at {portalUrl()} to change it, then sign in here again.</>}
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

/** The devices app's route guard — the portal's ProtectedRoute rules (the
 *  wiki's RequireAuth), plus the app's own gate (`app_distribution:view`). */
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';

import { useAuth } from '@portal/auth/AuthContext';

import { portalOrigin } from '../lib/origins';

function Notice({ title, hint, link }: { title: string; hint: string; link: string }) {
  return (
    <div className="portal-shell devices-notice">
      <div className="portal-page">
        <div className="eyebrow">ServerSherpa Devices</div>
        <h1 className="page-title">{title}</h1>
        <p className="page-hint">{hint}</p>
        <p className="page-hint"><a href={portalOrigin()}>{link}</a></p>
      </div>
    </div>
  );
}

export default function RequireAccess({ children }: { children: ReactNode }) {
  const { status, mustChangePassword, can } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return null; // session restore in flight — brief, no flash of the login page
  }
  if (status === 'anon') {
    // Login sends them back here once they're signed in
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  if (mustChangePassword) {
    // the portal owns the forced password change
    return (
      <Notice
        title="Set a new password first"
        hint="Your account is using a temporary password. Set your own in the portal, then come back."
        link="Open the portal"
      />
    );
  }
  if (!can('app_distribution', 'view')) {
    return (
      <Notice
        title="You don't have access to Devices"
        hint="Ask an administrator for Devices access."
        link="Back to portal"
      />
    );
  }
  return <>{children}</>;
}

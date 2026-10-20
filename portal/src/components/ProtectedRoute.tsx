import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import ForceChangePassword from './ForceChangePassword';

/** `fallback`: where an account below `minRank` is sent instead of the
 *  No access page (a page it may still read, e.g. the templates list). */
export default function ProtectedRoute({
  children, resource, minRank, fallback,
}: { children: ReactNode; resource?: string; minRank?: number; fallback?: string }) {
  const { status, mustChangePassword, can, maxRank } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return null; // session restore in flight — brief, no flash of login page
  }
  if (status === 'anon') {
    // preserve where the user was headed; Login sends them back after auth
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  if (mustChangePassword) {
    // temp-password accounts set their own password before anything else
    return <ForceChangePassword />;
  }
  if (resource && !can(resource, 'view')) {
    return (
      <div className="portal-page">
        <div className="eyebrow">Access control</div>
        <h1 className="page-title">No access</h1>
        <p className="page-hint">You don&apos;t have permission to view this page.</p>
      </div>
    );
  }
  if (minRank !== undefined && maxRank < minRank) {
    if (fallback) return <Navigate to={fallback} replace />;
    return (
      <div className="portal-page">
        <div className="eyebrow">Access control</div>
        <h1 className="page-title">No access</h1>
        <p className="page-hint">You don&apos;t have permission to view this page.</p>
      </div>
    );
  }
  return <>{children}</>;
}

import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';

import { useAuth } from '@portal/auth/AuthContext';

export default function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return null;
  if (status === 'anon') return <Navigate to="/login" state={{ from: location }} replace />;
  return <>{children}</>;
}

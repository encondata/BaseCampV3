import type { ReactNode } from 'react';

import { useAuth } from '@portal/auth/AuthContext';

/** Renders children only when the signed-in user can view `resource`. */
export default function Gate({ resource, children }: { resource: string; children: ReactNode }) {
  const { can } = useAuth();
  if (can(resource, 'view')) return <>{children}</>;
  return (
    <div className="portal-page">
      <p className="page-hint">You don't have access to this page.</p>
    </div>
  );
}

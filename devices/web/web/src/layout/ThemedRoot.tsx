import { useEffect, type ReactNode } from 'react';

import { useAuth } from '@portal/auth/AuthContext';
import { applyPreferences } from '@portal/lib/settings';

/** A `.portal-shell` carrying the portal's design tokens and the signed-in
 *  user's theme, accent, density, list-size and nav preferences
 *  (applyPreferences sets them on it): the shell's grid, and the full-page
 *  notices (no access, set a new password), so those follow the theme too. */
export default function ThemedRoot({ className, children }: { className: string; children: ReactNode }) {
  const { preferences } = useAuth();
  useEffect(() => { applyPreferences(preferences); }, [preferences]);
  return <div className={`portal-shell ${className}`}>{children}</div>;
}

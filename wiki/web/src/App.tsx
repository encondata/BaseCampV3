import { useEffect, type ReactNode } from 'react';
import { Route, Routes } from 'react-router-dom';

import { useAuth } from '@portal/auth/AuthContext';
import { applyPreferences } from '@portal/lib/settings';
import Login from '@portal/pages/Login';

import RequireAuth from './auth/RequireAuth';

/** Carries the portal's design tokens and the signed-in user's theme,
 *  accent, density and list-size preferences. */
function ThemedRoot({ children }: { children: ReactNode }) {
  const { preferences } = useAuth();
  useEffect(() => { applyPreferences(preferences); }, [preferences]);
  return <div className="portal-shell wiki-root">{children}</div>;
}

/** Placeholder until the wiki shell lands (Task 11). */
function WikiShell() {
  return <div className="wiki-shell">Wiki</div>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="*"
        element={(
          <RequireAuth>
            <ThemedRoot>
              <WikiShell />
            </ThemedRoot>
          </RequireAuth>
        )}
      />
    </Routes>
  );
}

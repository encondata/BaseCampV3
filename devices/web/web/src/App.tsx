import { useEffect, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import { useAuth } from '@portal/auth/AuthContext';
import { applyPreferences } from '@portal/lib/settings';
import Login from '@portal/pages/Login';

import RequireAccess from './auth/RequireAccess';
import DevicesShell from './layout/DevicesShell';

/** Carries the portal's design tokens and the signed-in user's theme,
 *  accent, density, list-size and nav preferences (applyPreferences sets
 *  them on this `.portal-shell`, the shell's grid). */
function ThemedRoot({ children }: { children: ReactNode }) {
  const { preferences } = useAuth();
  useEffect(() => { applyPreferences(preferences); }, [preferences]);
  return <div className="portal-shell devices-shell">{children}</div>;
}

/** A page's frame until its content lands (the Apps, Devices and Apple
 *  settings pages are built in later steps). */
function Page({ title }: { title: string }) {
  return (
    <div className="portal-page">
      <div className="eyebrow">Devices</div>
      <h1 className="page-title">{title}</h1>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login eyebrow="Devices" />} />
      <Route
        element={(
          <RequireAccess>
            <ThemedRoot>
              <DevicesShell />
            </ThemedRoot>
          </RequireAccess>
        )}
      >
        <Route path="/" element={<Page title="Apps" />} />
        <Route path="/apps/:id" element={<Page title="Apps" />} />
        <Route path="/devices" element={<Page title="Devices" />} />
        <Route path="/apple" element={<Page title="Apple settings" />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

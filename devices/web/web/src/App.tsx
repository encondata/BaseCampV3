import { Navigate, Route, Routes } from 'react-router-dom';

import Login from '@portal/pages/Login';

import RequireAccess from './auth/RequireAccess';
import DevicesShell from './layout/DevicesShell';
import ThemedRoot from './layout/ThemedRoot';
import AppDetailPage from './pages/AppDetailPage';
import AppleSettingsPage from './pages/AppleSettingsPage';
import AppsPage from './pages/AppsPage';
import DevicesPage from './pages/DevicesPage';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login eyebrow="Devices" />} />
      <Route
        element={(
          <RequireAccess>
            <ThemedRoot className="devices-shell">
              <DevicesShell />
            </ThemedRoot>
          </RequireAccess>
        )}
      >
        <Route path="/" element={<AppsPage />} />
        <Route path="/apps/:id" element={<AppDetailPage />} />
        <Route path="/devices" element={<DevicesPage />} />
        {/* the page itself holds the `change` gate */}
        <Route path="/apple" element={<AppleSettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

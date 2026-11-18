import { Navigate, Route, Routes } from 'react-router-dom';

import Login from '@portal/pages/Login';

import RequireAccess from './auth/RequireAccess';
import DevicesShell from './layout/DevicesShell';
import ThemedRoot from './layout/ThemedRoot';
import AppDetailPage from './pages/AppDetailPage';
import AppsPage from './pages/AppsPage';

/** A page's frame until its content lands (the Devices and Apple
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
            <ThemedRoot className="devices-shell">
              <DevicesShell />
            </ThemedRoot>
          </RequireAccess>
        )}
      >
        <Route path="/" element={<AppsPage />} />
        <Route path="/apps/:id" element={<AppDetailPage />} />
        <Route path="/devices" element={<Page title="Devices" />} />
        <Route path="/apple" element={<Page title="Apple settings" />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

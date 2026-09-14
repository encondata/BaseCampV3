import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { KioskAuthProvider } from './auth/KioskAuthContext';
import KioskGuard from './components/KioskGuard';
import SetupGate from './components/SetupGate';
import KioskShell from './layout/KioskShell';
import { FEATURES } from './lib/features';
import FeaturePage from './pages/FeaturePage';
import Home from './pages/Home';
import KioskSettings from './pages/KioskSettings';
import Login from './pages/Login';
import Settings from './pages/Settings';

export default function App() {
  return (
    <KioskAuthProvider>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/setup" element={<KioskShell><KioskSettings /></KioskShell>} />
          <Route path="/settings" element={<KioskGuard><KioskShell><Settings /></KioskShell></KioskGuard>} />
          <Route path="/" element={<KioskGuard><KioskShell><Home /></KioskShell></KioskGuard>} />
          {FEATURES.filter((f) => f.placeholder).map((f) => (
            <Route
              key={f.id}
              path={f.path}
              element={(
                <KioskGuard>
                  <SetupGate feature={f}>
                    <KioskShell><FeaturePage feature={f} /></KioskShell>
                  </SetupGate>
                </KioskGuard>
              )}
            />
          ))}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </KioskAuthProvider>
  );
}

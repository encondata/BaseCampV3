import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { KioskAuthProvider } from './auth/KioskAuthContext';
import KioskGuard from './components/KioskGuard';
import SetupGate from './components/SetupGate';
import KioskShell from './layout/KioskShell';
import { FEATURES } from './lib/features';
import FeaturePage from './pages/FeaturePage';
import Home from './pages/Home';
import Login from './pages/Login';
import Settings from './pages/Settings';

const SETUP_FEATURE = FEATURES.find((f) => f.id === 'setup')!;

export default function App() {
  return (
    <KioskAuthProvider>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Routes>
          <Route path="/login" element={<Login />} />
          {/* /setup and /settings work signed in or out — never behind
              KioskGuard. Kiosk Setup is a placeholder for the real setup
              flow; its variables now live on Settings › This Kiosk. */}
          <Route path="/setup" element={<KioskShell><FeaturePage feature={SETUP_FEATURE} /></KioskShell>} />
          <Route path="/settings" element={<KioskShell><Settings /></KioskShell>} />
          <Route path="/" element={<KioskGuard><KioskShell><Home /></KioskShell></KioskGuard>} />
          {FEATURES.filter((f) => f.placeholder && f.id !== 'setup').map((f) => (
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

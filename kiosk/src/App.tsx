import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { KioskAuthProvider } from './auth/KioskAuthContext';
import KioskGuard from './components/KioskGuard';
import KioskShell from './layout/KioskShell';
import { FEATURES } from './lib/features';
import FeaturePage from './pages/FeaturePage';
import Home from './pages/Home';
import KioskSettings from './pages/KioskSettings';
import Login from './pages/Login';

export default function App() {
  return (
    <KioskAuthProvider>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/settings" element={<KioskShell><KioskSettings /></KioskShell>} />
          <Route path="/" element={<KioskGuard><KioskShell><Home /></KioskShell></KioskGuard>} />
          {FEATURES.filter((f) => f.placeholder).map((f) => (
            <Route
              key={f.id}
              path={f.path}
              element={<KioskGuard><KioskShell><FeaturePage feature={f} /></KioskShell></KioskGuard>}
            />
          ))}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </KioskAuthProvider>
  );
}

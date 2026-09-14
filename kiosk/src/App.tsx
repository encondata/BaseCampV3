import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { KioskAuthProvider } from './auth/KioskAuthContext';
import KioskGuard from './components/KioskGuard';
import SetupGate from './components/SetupGate';
import KioskShell from './layout/KioskShell';
import { FEATURES } from './lib/features';
import { LABEL_SECTIONS } from './lib/labelSections';
import FeaturePage from './pages/FeaturePage';
import Home from './pages/Home';
import KioskSetup from './pages/KioskSetup';
import LabelSectionPage from './pages/LabelSectionPage';
import Labels from './pages/Labels';
import Login from './pages/Login';
import Scan from './pages/Scan';
import Settings from './pages/Settings';

const SCAN = FEATURES.find((f) => f.id === 'scan')!;
const LABELS = FEATURES.find((f) => f.id === 'labels')!;

export default function App() {
  return (
    <KioskAuthProvider>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Routes>
          <Route path="/login" element={<Login />} />
          {/* /settings works signed in or out — never behind KioskGuard.
              /setup requires a signed-in person (it stamps a Device row on
              their behalf), so it sits behind KioskGuard like the launcher
              features, but stays alwaysAvailable in featureAvailable. */}
          <Route path="/setup" element={<KioskGuard><KioskShell><KioskSetup /></KioskShell></KioskGuard>} />
          <Route path="/settings" element={<KioskShell><Settings /></KioskShell>} />
          <Route path="/" element={<KioskGuard><KioskShell><Home /></KioskShell></KioskGuard>} />
          {/* Scanning is a real screen now, so it gets its own route
              rather than the placeholder map below — same guards. */}
          <Route
            path={SCAN.path}
            element={(
              <KioskGuard>
                <SetupGate feature={SCAN}>
                  <KioskShell><Scan /></KioskShell>
                </SetupGate>
              </KioskGuard>
            )}
          />
          {/* Label Printing opens on its own three-card entry screen, so
              it gets explicit routes rather than the placeholder map
              below — same guards. */}
          <Route
            path={LABELS.path}
            element={(
              <KioskGuard>
                <SetupGate feature={LABELS}>
                  <KioskShell><Labels /></KioskShell>
                </SetupGate>
              </KioskGuard>
            )}
          />
          {LABEL_SECTIONS.map((s) => (
            <Route
              key={s.id}
              path={s.path}
              element={(
                <KioskGuard>
                  <SetupGate feature={LABELS}>
                    <KioskShell><LabelSectionPage section={s} /></KioskShell>
                  </SetupGate>
                </KioskGuard>
              )}
            />
          ))}
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

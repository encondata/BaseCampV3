import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { KioskAuthProvider } from './auth/KioskAuthContext';
import KioskGuard from './components/KioskGuard';
import SetupGate from './components/SetupGate';
import KioskShell from './layout/KioskShell';
import { FEATURES } from './lib/features';
import { LABEL_SECTIONS } from './lib/labelSections';
import Containers from './pages/Containers';
import Enroll from './pages/Enroll';
import FeaturePage from './pages/FeaturePage';
import Home from './pages/Home';
import KioskSetup from './pages/KioskSetup';
import LabelSectionPage from './pages/LabelSectionPage';
import Labels from './pages/Labels';
import Login from './pages/Login';
import PrinterTools from './pages/PrinterTools';
import Scan from './pages/Scan';
import Settings from './pages/Settings';
import Timeclock from './pages/Timeclock';

const SCAN = FEATURES.find((f) => f.id === 'scan')!;
const ENROLL = FEATURES.find((f) => f.id === 'enroll')!;
const CONTAINERS = FEATURES.find((f) => f.id === 'containers')!;
const LABELS = FEATURES.find((f) => f.id === 'labels')!;
const TIMECLOCK = FEATURES.find((f) => f.id === 'timeclock')!;

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
          {/* RFID Enroll is a real screen too — same guards as Scanning. */}
          <Route
            path={ENROLL.path}
            element={(
              <KioskGuard>
                <SetupGate feature={ENROLL}>
                  <KioskShell><Enroll /></KioskShell>
                </SetupGate>
              </KioskGuard>
            )}
          />
          {/* Containers is a real screen too — same guards as Scanning. */}
          <Route
            path={CONTAINERS.path}
            element={(
              <KioskGuard>
                <SetupGate feature={CONTAINERS}>
                  <KioskShell><Containers /></KioskShell>
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
          {/* Printer Setup / Troubleshooting is a real screen now; the
              other two sections keep the placeholder page. The section
              entry still owns the title and blurb either way. */}
          {LABEL_SECTIONS.map((s) => (
            <Route
              key={s.id}
              path={s.path}
              element={(
                <KioskGuard>
                  <SetupGate feature={LABELS}>
                    <KioskShell>
                      {s.id === 'printers' ? <PrinterTools /> : <LabelSectionPage section={s} />}
                    </KioskShell>
                  </SetupGate>
                </KioskGuard>
              )}
            />
          ))}
          {/* Timeclock is a real screen too — same guards as Scanning. */}
          <Route
            path={TIMECLOCK.path}
            element={(
              <KioskGuard>
                <SetupGate feature={TIMECLOCK}>
                  <KioskShell><Timeclock /></KioskShell>
                </SetupGate>
              </KioskGuard>
            )}
          />
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

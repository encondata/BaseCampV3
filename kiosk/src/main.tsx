import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import { installConfigTracking } from './lib/kioskConfig';
// Portal design system first (tokens, shell, login theme, primitives), then
// the kiosk's own rules. Order matters: kiosk.css only adds and scopes.
import '@portal/styles/base.css';
import '@portal/styles/portal-theme.css';
import '@portal/styles/auth-theme.css';
import '@portal/styles/directory.css';
import '@portal/styles/chrome.css';
import '@portal/styles/profile.css';
// Printer tools (/labels/printers): reports.css carries the modal
// header/steps and choice cards the ported modals use (rgm-*),
// printers.css the printer card, tool rows, and modal bodies (zp-*).
import '@portal/styles/reports.css';
import '@portal/styles/printers.css';
import './styles/kiosk.css';
// The time clock flow: full screen, always light, scoped under .tcx.
import './styles/timeclock.css';

// Settings edits count as local changes from the first render on, so a
// change made before the heartbeat starts is still reported to the portal.
installConfigTracking();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

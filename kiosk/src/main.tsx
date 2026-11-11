import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import { captureHelperToken } from './lib/hostHelper';
import { installConfigTracking } from './lib/kioskConfig';
import { isLaptop } from './lib/platform';
import { installLabelBuild } from './lib/webLabels/labelBuild';
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

// The Linux laptop's kiosk helper token (#kh=…): kept, and off the address bar, before anything reads the URL.
captureHelperToken();

// Settings edits count as local changes from the first render on, so a
// change made before the heartbeat starts is still reported to the portal.
installConfigTracking();

// A web kiosk builds its move's labels itself, ahead of any scan (on start,
// after each sync, and when the label kind or printer DPI changes). The
// laptop's labels come from its edge: nothing of this runs there.
if (!isLaptop()) installLabelBuild();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

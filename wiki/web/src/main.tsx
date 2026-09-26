import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { AuthProvider } from '@portal/auth/AuthContext';
import { NotificationsProvider } from '@portal/lib/notificationsContext';
import { SystemStatusProvider } from '@portal/lib/systemStatusContext';
import '@portal/styles/base.css';
import '@portal/styles/portal-theme.css';
import '@portal/styles/chrome.css';
import '@portal/styles/directory.css';
import '@portal/styles/profile.css';
import '@portal/styles/reports.css';

import App from './App';
import './styles/wiki.css';

// Same nesting as the portal: the system status (read-only / broadcast
// banners, also shown on the sign-in page) and AuthProvider (which also
// installs the tab-refocus token refresh) sit outside the router, and the
// notifications provider (which carries the toasts) inside AuthProvider.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SystemStatusProvider>
      <AuthProvider>
        <NotificationsProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </NotificationsProvider>
      </AuthProvider>
    </SystemStatusProvider>
  </StrictMode>,
);

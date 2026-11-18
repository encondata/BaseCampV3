/** The devices app's providers, nested as the wiki nests them: the system
 *  status (read-only / broadcast banners, also shown on the sign-in page)
 *  and the portal AuthProvider (the portal account sign-in; it also
 *  installs the tab-refocus token refresh) outside the router, the
 *  notifications provider inside AuthProvider, and everything inside an
 *  ErrorBoundary, so a crash shows its error instead of a blank page. */
import { BrowserRouter } from 'react-router-dom';

import { AuthProvider } from '@portal/auth/AuthContext';
import { NotificationsProvider } from '@portal/lib/notificationsContext';
import { SystemStatusProvider } from '@portal/lib/systemStatusContext';

import App from './App';
import ErrorBoundary from './components/ErrorBoundary';

export default function Root() {
  return (
    <ErrorBoundary>
      <SystemStatusProvider>
        <AuthProvider>
          <NotificationsProvider>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </NotificationsProvider>
        </AuthProvider>
      </SystemStatusProvider>
    </ErrorBoundary>
  );
}

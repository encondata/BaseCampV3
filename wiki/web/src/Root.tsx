/** Picks the app for the address the page was loaded at. A public share
 *  link (`/p/<token>`) gets `PublicApp` on its own — no system-status,
 *  session or notification providers, so it never calls an authenticated
 *  endpoint (not even the sign-in refresh) and works in a fresh private
 *  window. Everything else is the signed-in wiki, nested as the portal
 *  nests it: the system status (read-only / broadcast banners, also shown
 *  on the sign-in page) and AuthProvider (which also installs the
 *  tab-refocus token refresh) outside the router, and the notifications
 *  provider (which carries the toasts) inside AuthProvider. */
import { BrowserRouter } from 'react-router-dom';

import { AuthProvider } from '@portal/auth/AuthContext';
import { NotificationsProvider } from '@portal/lib/notificationsContext';
import { SystemStatusProvider } from '@portal/lib/systemStatusContext';

import App from './App';
import PublicApp, { isPublicPath } from './public/PublicApp';

export default function Root({ pathname }: { pathname: string }) {
  if (isPublicPath(pathname)) {
    return <BrowserRouter><PublicApp /></BrowserRouter>;
  }
  return (
    <SystemStatusProvider>
      <AuthProvider>
        <NotificationsProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </NotificationsProvider>
      </AuthProvider>
    </SystemStatusProvider>
  );
}

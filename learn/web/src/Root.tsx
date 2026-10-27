/** The learn app's providers, nested as the wiki nests them: the system
 *  status (read-only / broadcast banners on the account sign-in) and the
 *  portal AuthProvider (account sign-in; it also installs the tab-refocus
 *  token refresh) outside the router, everything inside an ErrorBoundary.
 *  A worker signed in with a code never touches AuthProvider's session:
 *  their token lives in lib/session.ts. */
import { BrowserRouter } from 'react-router-dom';

import { AuthProvider } from '@portal/auth/AuthContext';
import { SystemStatusProvider } from '@portal/lib/systemStatusContext';

import App from './App';
import ErrorBoundary from './components/ErrorBoundary';

export default function Root() {
  return (
    <ErrorBoundary>
      <SystemStatusProvider>
        <AuthProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </AuthProvider>
      </SystemStatusProvider>
    </ErrorBoundary>
  );
}

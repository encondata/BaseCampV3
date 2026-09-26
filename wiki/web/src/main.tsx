import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { AuthProvider } from '@portal/auth/AuthContext';
import '@portal/styles/base.css';
import '@portal/styles/portal-theme.css';
import '@portal/styles/directory.css';

import App from './App';
import './styles/wiki.css';

// Same nesting as the portal: AuthProvider (which also installs the
// tab-refocus token refresh) sits outside the router.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </AuthProvider>
  </StrictMode>,
);

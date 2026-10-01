import { BrowserRouter } from 'react-router-dom';

import { AuthProvider } from '@portal/auth/AuthContext';
import { SystemStatusProvider } from '@portal/lib/systemStatusContext';

import App from './App';

export default function Root() {
  return (
    <SystemStatusProvider>
      <AuthProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </AuthProvider>
    </SystemStatusProvider>
  );
}

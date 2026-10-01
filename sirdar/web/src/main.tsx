import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@portal/styles/base.css';
import '@portal/styles/portal-theme.css';
import '@portal/styles/chrome.css';
import '@portal/styles/directory.css';
import '@portal/styles/profile.css';
import '@portal/styles/settings.css';
import '@portal/styles/access.css';
import '@portal/styles/reports.css';
import Root from './Root';
import './styles/sirdar.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);

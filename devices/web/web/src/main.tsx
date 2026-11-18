import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@portal/styles/base.css';
import '@portal/styles/portal-theme.css';
import '@portal/styles/chrome.css';
// the pages: .dir-head, chips, lists (.data-table), forms (.pf-form) and buttons
import '@portal/styles/directory.css';
import '@portal/styles/profile.css';

import Root from './Root';
import './styles/devices.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);

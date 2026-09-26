import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@portal/styles/base.css';
import '@portal/styles/portal-theme.css';
import '@portal/styles/chrome.css';
import '@portal/styles/directory.css';
import '@portal/styles/profile.css';
import '@portal/styles/reports.css';

import Root from './Root';
import './styles/wiki.css';
import './styles/editor.css';

// a public share link (/p/<token>) is decided once, at load: it never
// navigates into the signed-in wiki (see Root)
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root pathname={window.location.pathname} />
  </StrictMode>,
);

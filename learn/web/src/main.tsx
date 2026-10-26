import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@portal/styles/base.css';
import '@portal/styles/portal-theme.css';

import Root from './Root';
import './styles/learn.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);

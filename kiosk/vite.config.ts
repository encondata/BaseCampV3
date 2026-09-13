import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The kiosk imports stylesheets and React-free helpers from the portal
// through this alias (kiosk/src/portalImports.test.ts enforces the rule).
// dedupe keeps a single React/gsap even though shared files resolve their
// own imports from portal/node_modules.
const portalSrc = fileURLToPath(new URL('../portal/src', import.meta.url));
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  plugins: [react()],
  define: {
    __KIOSK_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.0.0'),
  },
  resolve: {
    alias: { '@portal': portalSrc },
    dedupe: ['react', 'react-dom', 'gsap'],
  },
  server: {
    port: 5174,
    host: true,
    fs: { allow: [repoRoot] },
  },
  test: {
    // node by default (the portal-import guardrail needs a file URL); DOM tests carry their own @vitest-environment jsdom pragma
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**', '**/._*'],
    // react-router-dom logs its "future flag" deprecation notices the
    // moment a <MemoryRouter> mounts without opting in; they're aimed at
    // app wiring (Task 11), not at these component tests, so they're
    // filtered here to keep the run's output pristine.
    onConsoleLog: (log) => !log.includes('React Router Future Flag Warning'),
  },
});

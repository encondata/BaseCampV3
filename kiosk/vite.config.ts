import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { configDefaults } from 'vitest/config';

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
    host: true,   // bind 0.0.0.0 — a proxy or a phone on the LAN has to reach it
    // Vite 5.4 blocks requests whose Host header it doesn't recognize, so
    // the dev subdomains have to be named. A leading dot allows the host
    // and everything under it.
    allowedHosts: ['.serversherpa.com', 'localhost'],
    // Behind a TLS-terminating proxy (nginx on :443 forwarding to this
    // port), the browser must be told to open the HMR socket on 443 over
    // wss — otherwise it tries ws://<host>:PORT directly, which an HTTPS
    // page blocks as mixed content and which never reaches the proxy.
    // Opt in with SS_PUBLIC_HTTPS=1; unset, localhost HMR is unchanged.
    // The host is left to default to the page's own hostname, so the same
    // setting serves portal.* and kiosk.* without naming either.
    ...(process.env.SS_PUBLIC_HTTPS ? { hmr: { protocol: 'wss' as const, clientPort: 443 } } : {}),
    fs: { allow: [repoRoot] },
  },
  test: {
    // node by default (the portal-import guardrail needs a file URL); DOM tests carry their own @vitest-environment jsdom pragma
    environment: 'node',
    exclude: [...configDefaults.exclude, '**/._*'],
    // react-router-dom logs its "future flag" deprecation notices the
    // moment a <MemoryRouter> mounts without opting in; they're aimed at
    // app wiring (Task 11), not at these component tests, so they're
    // filtered here to keep the run's output pristine.
    onConsoleLog: (log) => !log.includes('React Router Future Flag Warning'),
  },
});

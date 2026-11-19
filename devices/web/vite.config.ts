import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';

import { dedupe } from './dedupe';

// The devices SPA (devices.serversherpa.com) lives in web/. Like the wiki
// and learn, it imports stylesheets, React-free helpers and an allowlisted
// set of portal React modules (sign-in, the nav, modals, lists) through
// the @portal alias; web/src/portalImports.test.ts enforces the allowlist.
// It is served from the same origin as the devices API, so its calls go to
// /api on this host (the dev server proxies them to the API on :8099).
const devicesWebRoot = fileURLToPath(new URL('.', import.meta.url));
const webRoot = fileURLToPath(new URL('./web', import.meta.url));
const portalSrc = fileURLToPath(new URL('../../portal/src', import.meta.url));
// the portal's Login page loads its logo and artwork from /images/
const portalPublic = fileURLToPath(new URL('../../portal/public', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

// the devices API's dev server (devices serve --reload)
const DEVICES_API = 'http://localhost:8099';

export default defineConfig({
  root: webRoot,
  publicDir: portalPublic,
  plugins: [react()],
  resolve: {
    alias: { '@portal': portalSrc },
    // one React/router even though shared files resolve their own imports
    // from portal/node_modules
    dedupe,
  },
  server: {
    // Pinned, not "preferred": a moved port is a different origin (and the
    // proxy host points at this exact one), so failing to start beats
    // silently serving somewhere else.
    port: 5180,
    strictPort: true,
    host: true,   // bind 0.0.0.0 — a proxy or a phone on the LAN has to reach it
    // Vite 5.4 blocks requests whose Host header it doesn't recognize; a
    // leading dot allows the host and everything under it.
    allowedHosts: ['.serversherpa.com', 'localhost'],
    // Behind a TLS-terminating proxy, tell the browser to open the HMR
    // socket on 443 over wss (opt in with SS_PUBLIC_HTTPS=1).
    ...(process.env.SS_PUBLIC_HTTPS ? { hmr: { protocol: 'wss' as const, clientPort: 443 } } : {}),
    // same origin as the API: the JSON API, the add-this-iPhone profile,
    // the iOS install manifests and the package downloads
    proxy: {
      '/api': DEVICES_API,
      '/enroll': DEVICES_API,
      '/ota': DEVICES_API,
      '/dl': DEVICES_API,
    },
    fs: { allow: [repoRoot] },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  test: {
    root: devicesWebRoot,
    include: ['web/src/**/*.test.{ts,tsx}'],
    // node by default (the portal-import guardrail); DOM tests carry their
    // own @vitest-environment jsdom pragma
    environment: 'node',
    exclude: [...configDefaults.exclude, '**/._*'],
    // react-router-dom logs its "future flag" notices whenever a router
    // mounts without opting in; they're aimed at app wiring, not tests
    onConsoleLog: (log) => !log.includes('React Router Future Flag Warning'),
  },
});

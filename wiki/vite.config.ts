import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';

import { dedupe } from './dedupe';

// The wiki SPA lives in web/ (the collab/render server in server/ shares
// this package so the editor schema has one copy of @tiptap/* and yjs).
// It imports stylesheets, React-free helpers and an allowlisted set of
// portal React modules (sign-in) through the @portal alias;
// web/src/portalImports.test.ts enforces the allowlist.
const wikiRoot = fileURLToPath(new URL('.', import.meta.url));
const webRoot = fileURLToPath(new URL('./web', import.meta.url));
const portalSrc = fileURLToPath(new URL('../portal/src', import.meta.url));
// the portal's Login page loads its logo and artwork from /images/
const portalPublic = fileURLToPath(new URL('../portal/public', import.meta.url));
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  root: webRoot,
  publicDir: portalPublic,
  plugins: [react()],
  resolve: {
    alias: { '@portal': portalSrc },
    // one React/router/gsap even though shared files resolve their own
    // imports from portal/node_modules
    dedupe,
  },
  server: {
    // Pinned, not "preferred": a moved port is a different origin (and
    // the Nginx Proxy Manager host forwards to this exact one), so failing
    // to start beats silently serving somewhere else.
    port: 5176,
    strictPort: true,
    host: true,   // bind 0.0.0.0 — a proxy or a phone on the LAN has to reach it
    // Vite 5.4 blocks requests whose Host header it doesn't recognize; a
    // leading dot allows the host and everything under it.
    allowedHosts: ['.serversherpa.com', 'localhost'],
    // Behind a TLS-terminating proxy, tell the browser to open the HMR
    // socket on 443 over wss (opt in with SS_PUBLIC_HTTPS=1).
    ...(process.env.SS_PUBLIC_HTTPS ? { hmr: { protocol: 'wss' as const, clientPort: 443 } } : {}),
    fs: { allow: [repoRoot] },
    // the wiki server (npm run dev:server) owns live editing and rendering
    proxy: {
      '/collab': { target: 'ws://localhost:5177', ws: true },
      '/internal': { target: 'http://localhost:5177' },
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  test: {
    root: wikiRoot,
    include: ['web/src/**/*.test.{ts,tsx}', 'server/src/**/*.test.ts'],
    // node by default (the portal-import guardrail and the shared schema
    // run server-side); DOM tests carry their own @vitest-environment jsdom pragma
    environment: 'node',
    exclude: [...configDefaults.exclude, '**/._*'],
    // react-router-dom logs its "future flag" notices whenever a router
    // mounts without opting in; they're aimed at app wiring, not tests
    onConsoleLog: (log) => !log.includes('React Router Future Flag Warning'),
  },
});

import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { configDefaults, defineConfig } from 'vitest/config';

import { dedupe } from './dedupe';

// The learn SPA (learn.serversherpa.com) lives in web/. Like the wiki, it
// imports stylesheets, React-free helpers and an allowlisted set of portal
// React modules (sign-in, the login scene) through the @portal alias;
// web/src/portalImports.test.ts enforces the allowlist.
const learnRoot = fileURLToPath(new URL('.', import.meta.url));
const webRoot = fileURLToPath(new URL('./web', import.meta.url));
const portalSrc = fileURLToPath(new URL('../portal/src', import.meta.url));
// the portal's Login page loads its logo and artwork from /images/
const portalPublic = fileURLToPath(new URL('../portal/public', import.meta.url));
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** index.html loads /config.js before the bundle; the Docker entrypoint
 *  writes it from LEARN_API_URL. The dev server answers with an empty
 *  config, so lib/api.ts falls back to VITE_API_URL and the host's :8000. */
function devConfigJs(): Plugin {
  return {
    name: 'learn-dev-config',
    configureServer(server) {
      server.middlewares.use('/config.js', (_req, res) => {
        res.setHeader('Content-Type', 'text/javascript');
        res.setHeader('Cache-Control', 'no-store');
        res.end('window.__LEARN_CONFIG__ = {};\n');
      });
    },
  };
}

export default defineConfig({
  root: webRoot,
  publicDir: portalPublic,
  plugins: [react(), devConfigJs()],
  resolve: {
    alias: { '@portal': portalSrc },
    // one React/router/gsap even though shared files resolve their own
    // imports from portal/node_modules
    dedupe,
  },
  server: {
    // Pinned, not "preferred": a moved port is a different origin (and
    // the invite links and the proxy host point at this exact one), so
    // failing to start beats silently serving somewhere else.
    port: 5179,
    strictPort: true,
    host: true,   // bind 0.0.0.0 — a proxy or a phone on the LAN has to reach it
    // Vite 5.4 blocks requests whose Host header it doesn't recognize; a
    // leading dot allows the host and everything under it.
    allowedHosts: ['.serversherpa.com', 'localhost'],
    // Behind a TLS-terminating proxy, tell the browser to open the HMR
    // socket on 443 over wss (opt in with SS_PUBLIC_HTTPS=1).
    ...(process.env.SS_PUBLIC_HTTPS ? { hmr: { protocol: 'wss' as const, clientPort: 443 } } : {}),
    fs: { allow: [repoRoot] },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  test: {
    root: learnRoot,
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

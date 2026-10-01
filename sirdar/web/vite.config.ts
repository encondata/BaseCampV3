import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';

import { dedupe } from './dedupe';

// Sirdar's SPA reuses portal styles and an allowlisted set of portal React
// modules (sign-in, nav, tables) through @portal; src/portalImports.test.ts
// enforces the allowlist. The portal's API client is reused against
// Sirdar's own API by pinning VITE_API_URL to /api (same origin: Vite
// proxies it in dev, the API serves the SPA in production).
const webRoot = fileURLToPath(new URL('.', import.meta.url));
const portalSrc = fileURLToPath(new URL('../../portal/src', import.meta.url));
const portalPublic = fileURLToPath(new URL('../../portal/public', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  root: webRoot,
  publicDir: portalPublic,
  plugins: [react()],
  define: { 'import.meta.env.VITE_API_URL': JSON.stringify('/api') },
  resolve: { alias: { '@portal': portalSrc }, dedupe },
  server: {
    port: 5178,
    strictPort: true,
    host: true,
    allowedHosts: ['.serversherpa.com', 'localhost'],
    ...(process.env.SS_PUBLIC_HTTPS ? { hmr: { protocol: 'wss' as const, clientPort: 443 } } : {}),
    fs: { allow: [repoRoot] },
    proxy: { '/api': { target: 'http://localhost:8097' } },
  },
  build: { outDir: 'dist', emptyOutDir: true },
  test: {
    root: webRoot,
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
    exclude: [...configDefaults.exclude, '**/._*'],
    onConsoleLog: (log) => !log.includes('React Router Future Flag Warning'),
  },
});

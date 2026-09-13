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
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**', '**/._*'],
  },
});

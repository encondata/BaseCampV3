import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { configDefaults } from 'vitest/config';

// The page borrows the portal's stylesheets (tokens, fonts, panels) through
// this alias so it can never drift from the portal's look. Only CSS is
// imported from the portal — no components, no portal node_modules.
const portalSrc = fileURLToPath(new URL('../../portal/src', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@portal': portalSrc } },
  server: {
    port: 5176,
    strictPort: true,
    fs: { allow: [repoRoot] },
    // `npm run dev` against a locally running status server
    proxy: { '/api': 'http://localhost:8080' },
  },
  test: {
    environment: 'jsdom',
    css: false,
    // Testing Library's auto-cleanup-between-tests hook only registers
    // itself when `afterEach` is available as a global (its own check),
    // which requires Vitest's globals mode even though every test file
    // imports its own `describe`/`it`/`expect` explicitly.
    globals: true,
    exclude: [...configDefaults.exclude, '**/._*'],
  },
});

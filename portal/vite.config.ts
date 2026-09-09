import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  test: {
    // macOS writes ._* AppleDouble sidecars on exFAT/network volumes; vitest
    // would otherwise try to run them as test files when they shadow *.test.*
    exclude: ['**/node_modules/**', '**/dist/**', '**/._*'],
    // Vitest stubs every CSS import as "" by default (its `vitest:css-disable`
    // plugin matches `.css` even with a `?raw` query), which would silently
    // empty the stylesheet the report renderer inlines into its SVG. Opt just
    // that one file into real CSS processing so `?raw` yields the actual
    // rules — every other CSS import stays stubbed as before.
    css: { include: [/rack-svg\.css/] },
  },
});

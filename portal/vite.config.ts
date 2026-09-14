import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,   // bind 0.0.0.0 — a proxy or a phone on the LAN has to reach it
    // Vite 5.4 blocks requests whose Host header it doesn't recognize, so
    // the dev subdomains have to be named. A leading dot allows the host
    // and everything under it.
    allowedHosts: ['.serversherpa.com', 'localhost'],
  },
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

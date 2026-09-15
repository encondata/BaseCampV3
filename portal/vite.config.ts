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
    // Behind a TLS-terminating proxy (nginx on :443 forwarding to this
    // port), the browser must be told to open the HMR socket on 443 over
    // wss — otherwise it tries ws://<host>:PORT directly, which an HTTPS
    // page blocks as mixed content and which never reaches the proxy.
    // Opt in with SS_PUBLIC_HTTPS=1; unset, localhost HMR is unchanged.
    // The host is left to default to the page's own hostname, so the same
    // setting serves portal.* and kiosk.* without naming either.
    ...(process.env.SS_PUBLIC_HTTPS ? { hmr: { protocol: 'wss' as const, clientPort: 443 } } : {}),
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

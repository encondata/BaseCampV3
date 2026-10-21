import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

// The label generator as ONE self-contained script for the Android kiosk,
// which runs it in a JavaScriptEngine sandbox (kiosk/src/labelgen/index.ts
// installs `globalThis.labelgen`). Committed to the app's assets; rebuild
// with `npm --prefix kiosk run build:labelgen` whenever labelgen changes
// (kiosk/src/labelgen/bundle.test.ts fails until the file is fresh).
// The output is deterministic: no hashes, no timestamps, no minifier.
export default defineConfig({
  configFile: false,
  publicDir: false,
  logLevel: 'warn',
  build: {
    lib: {
      entry: fileURLToPath(new URL('./src/labelgen/index.ts', import.meta.url)),
      // the IIFE's own result, NOT `labelgen`: index.ts sets globalThis.labelgen
      name: 'labelgenModule',
      formats: ['iife'],
      fileName: () => 'labelgen.js',
    },
    outDir: fileURLToPath(new URL('../Android_Kiosk_App/app/src/main/assets', import.meta.url)),
    emptyOutDir: false,
    copyPublicDir: false,
    minify: false,
    sourcemap: false,
    reportCompressedSize: false,
    target: 'es2020',
  },
});

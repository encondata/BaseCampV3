import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  test: {
    // macOS writes ._* AppleDouble sidecars on exFAT/network volumes; vitest
    // would otherwise try to run them as test files when they shadow *.test.*
    exclude: ['**/node_modules/**', '**/dist/**', '**/._*'],
  },
});

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// SSR library build of the rack renderer: one self-contained ESM file
// (React + ReactDOMServer bundled) that Node 20 can run with no
// node_modules next to it.
export default defineConfig({
  plugins: [react()],
  publicDir: false,
  build: {
    outDir: 'dist-node',
    emptyOutDir: true,
    ssr: 'src/reports/renderRack.tsx',
    target: 'node20',
    minify: false,
    rollupOptions: { output: { entryFileNames: 'render-rack.js', format: 'es' } },
  },
  ssr: { noExternal: true },
});

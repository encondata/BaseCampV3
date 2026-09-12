import { defineConfig } from 'vite';

// SSR library build of the container label renderer: one self-contained
// ESM file (jsPDF + bwip-js's Node build bundled) that Node 20 can run with
// no node_modules next to it. Mirrors vite.rack-renderer.config.ts;
// `emptyOutDir: false` so this build doesn't delete render-rack.js (and
// vice versa) since both share `dist-node`.
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist-node',
    emptyOutDir: false,
    ssr: 'src/labels/renderContainerLabels.ts',
    target: 'node20',
    minify: false,
    rollupOptions: { output: { entryFileNames: 'render-container-labels.js', format: 'es' } },
  },
  ssr: { noExternal: true },
});

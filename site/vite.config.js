import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/mochi/',
  plugins: [react()],
  build: {
    outDir: '../docs',
    emptyOutDir: false, // repo's real docs/*.md live here too
    rollupOptions: {
      input: {
        index: 'index.html',
        docs: 'docs.html',
        benchmarks: 'benchmarks.html',
        changelog: 'changelog.html',
        source: 'source.html',
      },
    },
  },
});

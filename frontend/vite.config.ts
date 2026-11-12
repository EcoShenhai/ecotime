import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// No inline scripts or styles in the output, so nginx can send a strict CSP.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: false, assetsInlineLimit: 0, target: 'es2022', modulePreload: { polyfill: false } },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:4027' } },
});

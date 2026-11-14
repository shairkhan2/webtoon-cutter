import { defineConfig } from 'vite';

const api = `http://127.0.0.1:${process.env.WSC_PORT ?? 8787}`;

export default defineConfig({
  root: 'viewer',
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
  server: { proxy: { '/api': api, '/files': api } },
});

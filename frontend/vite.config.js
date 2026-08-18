import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    // Dev only. In production Express serves the built assets from one process
    // on one port, the same shape as NEURO.
    proxy: { '/api': 'http://localhost:3006' },
  },
});

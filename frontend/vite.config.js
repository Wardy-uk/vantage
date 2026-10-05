import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolveBuildLabel, buildVersionPlugin } from './build-version.mjs';

export default defineConfig({
  // version.json beside the build: the status bar turns amber when a newer
  // build is being served than the open tab (5 Oct 2026, after NOVA).
  plugins: [react(), buildVersionPlugin(resolveBuildLabel())],
  // Served under a path, not at a host root.
  //
  // Tailscale Funnel only permits ports 443, 8443 and 10000, and all three were
  // already taken on this Pi (NEURO, SARA, and one other). So VANTAGE lives at
  // /vantage on 443, the same pattern /quest already uses. Tailscale strips the
  // prefix before proxying, so Express still serves from its own root — but the
  // browser needs asset URLs that include it.
  //
  // Override with VANTAGE_BASE=/ when serving from a host root, which is what a
  // future vantage.nickward.co.uk would want.
  base: process.env.VANTAGE_BASE || '/vantage/',
  server: {
    port: 5174,
    // Dev only. In production Express serves the built assets from one process
    // on one port, the same shape as NEURO.
    proxy: { '/api': 'http://localhost:3006' },
  },
});

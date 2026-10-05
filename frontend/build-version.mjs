// COPY of nuero/shared/build-version.mjs (5 Oct 2026). Separate repos deploy separately
// (Netlify builds this frontend alone), so it cannot be imported. Keep in step.
/**
 * The build id, and a version.json beside the built app (5 Oct 2026).
 *
 * NOVA's status bar turns amber when the tab is running an older bundle than
 * the server holds — a tab left open across a deploy looks entirely normal
 * while being releases behind, and twice that was read as a failed deploy.
 * NEURO, SAiM and VANTAGE get the same: the build id is baked into the bundle
 * AND written to version.json; the page re-reads version.json and says so
 * when they differ. Static file, so it needs no server route on any host
 * (Express on the Pi, Netlify, the kiosk's saim/backend).
 *
 * Build id: an explicit VITE_BUILD_LABEL, else Netlify's COMMIT_REF, else the
 * working commit. A rebuild of the same commit is the same build — correct,
 * since nothing the page runs has changed.
 */
import { execSync } from 'node:child_process';

export function resolveBuildLabel({ devPrefix = '' } = {}) {
  if (process.env.VITE_BUILD_LABEL) return process.env.VITE_BUILD_LABEL;
  if (process.env.COMMIT_REF) return process.env.COMMIT_REF.slice(0, 7);
  try {
    return `${devPrefix}${execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()}`;
  } catch {
    return 'dev';
  }
}

/** Vite plugin: defines __APP_BUILD__ / __APP_BUILT_AT__ and emits version.json. */
export function buildVersionPlugin(label) {
  const builtAt = new Date().toISOString();
  return {
    name: 'neuro-build-version',
    config() {
      return { define: { __APP_BUILD__: JSON.stringify(label), __APP_BUILT_AT__: JSON.stringify(builtAt) } };
    },
    // `entry` is the hashed entry chunk's file name: it changes when (and only
    // when) the app's code changes, since the entry references every lazy
    // chunk by its content hash. That, not the commit, decides "newer" — a
    // backend-only deploy changes the commit and leaves the page current.
    generateBundle(_opts, bundle) {
      const entry = Object.values(bundle).find((c) => c.type === 'chunk' && c.isEntry);
      this.emitFile({ type: 'asset', fileName: 'version.json',
        source: JSON.stringify({ build: label, builtAt, entry: entry ? entry.fileName.split('/').pop() : null }) });
    },
  };
}

import path from 'node:path';

import svgr from 'vite-plugin-svgr';
import { defineConfig, type Plugin } from 'vitest/config';

/**
 * FE-hosted real-browser suite (WP2 separation; executed in WP3).
 *
 * Requires an explicit authorised application root:
 *
 *   MAKEIT_ARTWORK_APP_ROOT=/path/to/FE-build pnpm test:browser
 *
 * Not part of the no-FE acceptance surface.
 */
const appRoot = process.env.MAKEIT_ARTWORK_APP_ROOT;
if (!appRoot) {
  throw new Error(
    'test:browser requires MAKEIT_ARTWORK_APP_ROOT pointing at an authorised compatible FE checkout.',
  );
}

export default defineConfig({
  root: import.meta.dirname,
  plugins: [svgr({ include: '**/*.svg' }) as unknown as Plugin],
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: { '@': path.resolve(appRoot, 'src') },
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/browser/**/*.{test,spec}.ts'],
    testTimeout: 360_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});

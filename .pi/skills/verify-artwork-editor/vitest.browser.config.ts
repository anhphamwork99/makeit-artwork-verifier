import { fileURLToPath } from 'node:url';

import tsconfigPaths from 'vite-tsconfig-paths';
import svgr from 'vite-plugin-svgr';
import { defineConfig, type Plugin } from 'vitest/config';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * Dedicated Vitest configuration for real-browser runtime proofs (TS-4/TS-5).
 *
 * These tests launch one owned Next.js server and a fresh Chromium context, so
 * they run in the Node environment, sequentially, with generous bounded
 * timeouts. They are intentionally separate from the fast foundation/integration
 * suite and are run explicitly through `pnpm test:verify:browser`.
 *
 * The repository `@/` path alias and the SVG-import transform are required by
 * the WP5 Slice 5-F proofs: the product-owned `normalizedMeaning` seam and the
 * real serializer/restorer pull product modules that use the alias and import
 * `.svg` assets. They are shared with the foundation configuration so the two
 * suites resolve the same source of truth.
 */
export default defineConfig({
  root: repoRoot,
  plugins: [
    tsconfigPaths() as unknown as Plugin,
    svgr({ include: '**/*.svg' }) as unknown as Plugin,
  ],
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    globals: false,
    include: ['.pi/skills/verify-artwork-editor/tests/browser/**/*.{test,spec}.ts'],
    testTimeout: 360_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});

import { fileURLToPath } from 'node:url';

import tsconfigPaths from 'vite-tsconfig-paths';
import svgr from 'vite-plugin-svgr';
import { defineConfig, type Plugin } from 'vitest/config';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * Dedicated Vitest configuration for the production verification foundation.
 *
 * The repository root configuration (`vitest.config.ts`) includes only
 * `src/**`, so the verification toolkit's tests under `.pi/**` are invisible to
 * `pnpm test` by design. This configuration keeps the toolkit's public contract
 * suite runnable in isolation (`pnpm test:foundation`) without widening the
 * application suite.
 *
 * It reuses the repository's alias/svg/esbuild resolution so foundation tests
 * can import the real application source of truth for the application-kind
 * inventory (`@/lib/artwork/layers/registry`) exactly as the app resolves it.
 */
export default defineConfig({
  root: repoRoot,
  plugins: [
    tsconfigPaths() as unknown as Plugin,
    svgr({ include: '**/*.svg' }) as unknown as Plugin,
  ],
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'jsdom',
    globals: false,
    include: [
      '.pi/skills/verify-artwork-editor/tests/foundation/**/*.{test,spec}.{ts,tsx}',
      '.pi/skills/verify-artwork-editor/tests/integration/**/*.{test,spec}.{ts,tsx}',
    ],
    css: false,
  },
});

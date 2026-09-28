import path from 'node:path';

import svgr from 'vite-plugin-svgr';
import { defineConfig, type Plugin } from 'vitest/config';

/**
 * FE-hosted suite (WP2 separation; executed in WP3).
 *
 * These tests import the application `@/` alias, an owned Next.js instance, or
 * the read-only verification bridge. They are retained unmodified from the
 * approved snapshot and cannot run in a toolkit-only checkout. They require an
 * explicit application root:
 *
 *   MAKEIT_ARTWORK_APP_ROOT=/path/to/FE-build pnpm test:fe-hosted
 *
 * The toolkit repository stays the Vitest root so the transferred test paths
 * resolve here; only the `@` alias points into the application, matching its
 * tsconfig. This configuration is not part of the no-FE acceptance surface.
 */
const appRoot = process.env.MAKEIT_ARTWORK_APP_ROOT;
if (!appRoot) {
  throw new Error(
    'test:fe-hosted requires MAKEIT_ARTWORK_APP_ROOT pointing at an authorised FE-build checkout.',
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
    include: [
  'tests/browser/tracer-text-move.browser.test.ts',
  'tests/browser/tracer-warped-text-move.browser.test.ts',
  'tests/browser/wp5f-guarded-escape.browser.test.ts',
  'tests/browser/wp5f-history-outcomes.browser.test.ts',
  'tests/browser/wp5f-restore-outcomes.browser.test.ts',
  'tests/foundation/budget.test.ts',
  'tests/foundation/correctness-profile-foundation.test.ts',
  'tests/foundation/crossword-generator-contract.test.ts',
  'tests/foundation/geometry-v2.test.ts',
  'tests/foundation/governance-child-reader.test.ts',
  'tests/foundation/p7b-b0-contract-ownership.test.ts',
  'tests/foundation/p7b-b1e-crossword-kernel.test.ts',
  'tests/foundation/p7b-b2b4-crossword-live-facts.test.ts',
  'tests/foundation/p7b-precutover-joint.test.ts',
  'tests/foundation/prepared-execution-seam.test.ts',
  'tests/foundation/qualification-runtime.test.ts',
  'tests/foundation/registry.test.ts',
  'tests/foundation/release-ledger.test.ts',
  'tests/foundation/release-runtime.test.ts',
  'tests/foundation/retention.test.ts',
  'tests/foundation/setup-seam.test.ts',
  'tests/foundation/wp5b-binding-matrix.test.ts',
  'tests/foundation/wp5c-image.test.ts',
  'tests/foundation/wp5d-negative-normalization.test.ts',
  'tests/foundation/wp5d-purpose-scoped.test.ts',
  'tests/foundation/wp5e-crossword.test.ts',
  'tests/foundation/wp5f-history-runtime.test.ts',
  'tests/foundation/wp5f-history-settle.test.ts',
  'tests/foundation/wp5f-normalized-meaning.test.ts',
  'tests/foundation/wp5f-normalized-split.test.ts',
  'tests/foundation/wp5f-suite.test.ts',
  'tests/integration/allocation.test.ts',
  'tests/integration/budget-retention-cli.test.ts',
  'tests/integration/cleanup-authority.test.ts',
  'tests/integration/cli.test.ts',
  'tests/integration/cold-agent-evidence.test.ts',
  'tests/integration/diagnostic-cli.test.ts',
  'tests/integration/doctor-bridge-contract.test.ts',
  'tests/integration/doctor-browser-close.test.ts',
  'tests/integration/manifest-cli.test.ts',
  'tests/integration/p8b-evidence-cli.test.ts',
  'tests/integration/package7-completeness-ledger.test.ts',
  'tests/integration/production-absence-cli.test.ts',
  'tests/integration/qualification-cli.test.ts',
  'tests/integration/release-cli.test.ts',
  'tests/integration/retention-cli.test.ts',
  'tests/integration/stdout-capture-isolation.test.ts',
  'tests/integration/suite-cli.test.ts',
  'tests/integration/termination.test.ts',
  'tests/integration/wp5d-negative-normalization.test.ts',
      'tests/browser/**/*.{test,spec}.ts',
    ],
    testTimeout: 360_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});

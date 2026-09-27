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
  '.pi/skills/verify-artwork-editor/tests/browser/tracer-text-move.browser.test.ts',
  '.pi/skills/verify-artwork-editor/tests/browser/tracer-warped-text-move.browser.test.ts',
  '.pi/skills/verify-artwork-editor/tests/browser/wp5f-guarded-escape.browser.test.ts',
  '.pi/skills/verify-artwork-editor/tests/browser/wp5f-history-outcomes.browser.test.ts',
  '.pi/skills/verify-artwork-editor/tests/browser/wp5f-restore-outcomes.browser.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/budget.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/correctness-profile-foundation.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/crossword-generator-contract.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/geometry-v2.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/governance-child-reader.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/p7b-b0-contract-ownership.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/p7b-b1e-crossword-kernel.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/p7b-b2b4-crossword-live-facts.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/p7b-precutover-joint.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/prepared-execution-seam.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/qualification-runtime.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/registry.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/release-ledger.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/release-runtime.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/retention.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/setup-seam.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/wp5b-binding-matrix.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/wp5c-image.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/wp5d-negative-normalization.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/wp5d-purpose-scoped.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/wp5e-crossword.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/wp5f-history-runtime.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/wp5f-history-settle.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/wp5f-normalized-meaning.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/wp5f-normalized-split.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/wp5f-suite.test.ts',
  '.pi/skills/verify-artwork-editor/tests/integration/allocation.test.ts',
  '.pi/skills/verify-artwork-editor/tests/integration/budget-retention-cli.test.ts',
  '.pi/skills/verify-artwork-editor/tests/integration/cleanup-authority.test.ts',
  '.pi/skills/verify-artwork-editor/tests/integration/cli.test.ts',
  '.pi/skills/verify-artwork-editor/tests/integration/cold-agent-evidence.test.ts',
  '.pi/skills/verify-artwork-editor/tests/integration/diagnostic-cli.test.ts',
  '.pi/skills/verify-artwork-editor/tests/integration/doctor-bridge-contract.test.ts',
  '.pi/skills/verify-artwork-editor/tests/integration/doctor-browser-close.test.ts',
  '.pi/skills/verify-artwork-editor/tests/integration/manifest-cli.test.ts',
  '.pi/skills/verify-artwork-editor/tests/integration/p8b-evidence-cli.test.ts',
  '.pi/skills/verify-artwork-editor/tests/integration/package7-completeness-ledger.test.ts',
  '.pi/skills/verify-artwork-editor/tests/integration/production-absence-cli.test.ts',
  '.pi/skills/verify-artwork-editor/tests/integration/qualification-cli.test.ts',
  '.pi/skills/verify-artwork-editor/tests/integration/release-cli.test.ts',
  '.pi/skills/verify-artwork-editor/tests/integration/retention-cli.test.ts',
  '.pi/skills/verify-artwork-editor/tests/integration/stdout-capture-isolation.test.ts',
  '.pi/skills/verify-artwork-editor/tests/integration/suite-cli.test.ts',
  '.pi/skills/verify-artwork-editor/tests/integration/termination.test.ts',
  '.pi/skills/verify-artwork-editor/tests/integration/wp5d-negative-normalization.test.ts',
      '.pi/skills/verify-artwork-editor/tests/browser/**/*.{test,spec}.ts',
    ],
    testTimeout: 360_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});

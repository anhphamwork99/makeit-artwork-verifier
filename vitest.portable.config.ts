import { configDefaults, defineConfig } from 'vitest/config';

/**
 * No-FE portable contract suite (WP2).
 *
 * Runs the transferred toolkit tests whose transitive imports never reference
 * the application `@/` alias and that do not read an application checkout or
 * excluded historical evidence, so they load and run without any FE-build
 * checkout.
 *
 * Two exclusions are applied, and both files stay in the repository unmodified:
 *  - `FE_COUPLED` — transitively imports the application `@/` alias
 *    (`src/runtime/execute-history-plan.ts` / `execute-restore-plan.ts`).
 *  - `APP_OR_EVIDENCE_DEPENDENT` — statically loadable, but asserts against an
 *    application checkout (`resolveRepoRoot()` / Next config / product source)
 *    or against historical `evidence/` that is intentionally not transferred.
 *
 * `root` stays the toolkit repository root so the transferred helpers that
 * resolve `.pi/skills/verify-artwork-editor` from `process.cwd()` keep working.
 * Both excluded groups run through `vitest.fe-hosted.config.ts` (WP3).
 */
const FE_COUPLED = [
  '.pi/skills/verify-artwork-editor/tests/browser/tracer-text-move.browser.test.ts',
  '.pi/skills/verify-artwork-editor/tests/browser/tracer-warped-text-move.browser.test.ts',
  '.pi/skills/verify-artwork-editor/tests/browser/wp5f-guarded-escape.browser.test.ts',
  '.pi/skills/verify-artwork-editor/tests/browser/wp5f-history-outcomes.browser.test.ts',
  '.pi/skills/verify-artwork-editor/tests/browser/wp5f-restore-outcomes.browser.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/budget.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/correctness-profile-foundation.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/crossword-generator-contract.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/executable-selection-manifest.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/geometry-v2.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/governance-child-reader.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/p7b-b0-contract-ownership.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/p7b-b1a-final-contracts.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/p7b-b1a-outcome-precedence.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/p7b-b1b-text-kernels.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/p7b-b1c-nested-object-kernel.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/p7b-b1d-image-kernel.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/p7b-b1e-crossword-kernel.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/p7b-b1f1-history-kernel.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/p7b-b1f2-restore-kernel.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/p7b-b1g-command-contexts.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/p7b-b2-joint-preactivation.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/p7b-b2b1-text-live-facts.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/p7b-b2b2-object-live-facts.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/p7b-b2b3-image-live-facts.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/p7b-b2b4-crossword-live-facts.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/p7b-b2b5-history-live-facts.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/p7b-b2b5-restore-live-facts.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/p7b-b2c-strict-v4-record.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/p7b-b2d1-orchestration.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/p7b-b2d2-command-orchestration.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/p7b-b2e1-final-public-evidence.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/p7b-b2e2-final-active-path.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/p7b-precutover-joint.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/p8b-integrity-verifier.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/package7-completeness-ledger.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/package7-correctness-catalogue.test.ts',
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
];

const APP_OR_EVIDENCE_DEPENDENT = [
  '.pi/skills/verify-artwork-editor/tests/foundation/p7a-typecheck-baseline.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/p7b-b2a-execution-materialization.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/p7b-b2e2r-producer-suite-switch-closure.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/p8a-dormant-closure.test.ts',
  '.pi/skills/verify-artwork-editor/tests/foundation/planner-coverage.test.ts',
  '.pi/skills/verify-artwork-editor/tests/integration/doctor-failure.test.ts',
  '.pi/skills/verify-artwork-editor/tests/integration/next-dist-dir-guard.test.ts',
];

export default defineConfig({
  root: import.meta.dirname,
  test: {
    environment: 'jsdom',
    globals: false,
    include: [
      '.pi/skills/verify-artwork-editor/tests/portable/**/*.test.ts',
      '.pi/skills/verify-artwork-editor/tests/foundation/**/*.test.ts',
      '.pi/skills/verify-artwork-editor/tests/integration/**/*.test.ts',
    ],
    exclude: [...configDefaults.exclude, ...FE_COUPLED, ...APP_OR_EVIDENCE_DEPENDENT],
    css: false,
  },
});

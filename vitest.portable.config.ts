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
  'tests/browser/tracer-text-move.browser.test.ts',
  'tests/browser/tracer-warped-text-move.browser.test.ts',
  'tests/browser/wp5f-guarded-escape.browser.test.ts',
  'tests/browser/wp5f-history-outcomes.browser.test.ts',
  'tests/browser/wp5f-restore-outcomes.browser.test.ts',
  'tests/foundation/budget.test.ts',
  'tests/foundation/correctness-profile-foundation.test.ts',
  'tests/foundation/crossword-generator-contract.test.ts',
  'tests/foundation/executable-selection-manifest.test.ts',
  'tests/foundation/geometry-v2.test.ts',
  'tests/foundation/governance-child-reader.test.ts',
  'tests/foundation/p7b-b0-contract-ownership.test.ts',
  'tests/foundation/p7b-b1a-final-contracts.test.ts',
  'tests/foundation/p7b-b1a-outcome-precedence.test.ts',
  'tests/foundation/p7b-b1b-text-kernels.test.ts',
  'tests/foundation/p7b-b1c-nested-object-kernel.test.ts',
  'tests/foundation/p7b-b1d-image-kernel.test.ts',
  'tests/foundation/p7b-b1e-crossword-kernel.test.ts',
  'tests/foundation/p7b-b1f1-history-kernel.test.ts',
  'tests/foundation/p7b-b1f2-restore-kernel.test.ts',
  'tests/foundation/p7b-b1g-command-contexts.test.ts',
  'tests/foundation/p7b-b2-joint-preactivation.test.ts',
  'tests/foundation/p7b-b2b1-text-live-facts.test.ts',
  'tests/foundation/p7b-b2b2-object-live-facts.test.ts',
  'tests/foundation/p7b-b2b3-image-live-facts.test.ts',
  'tests/foundation/p7b-b2b4-crossword-live-facts.test.ts',
  'tests/foundation/p7b-b2b5-history-live-facts.test.ts',
  'tests/foundation/p7b-b2b5-restore-live-facts.test.ts',
  'tests/foundation/p7b-b2c-strict-v4-record.test.ts',
  'tests/foundation/p7b-b2d1-orchestration.test.ts',
  'tests/foundation/p7b-b2d2-command-orchestration.test.ts',
  'tests/foundation/p7b-b2e1-final-public-evidence.test.ts',
  'tests/foundation/p7b-b2e2-final-active-path.test.ts',
  'tests/foundation/p7b-precutover-joint.test.ts',
  'tests/foundation/p8b-integrity-verifier.test.ts',
  'tests/foundation/package7-completeness-ledger.test.ts',
  'tests/foundation/package7-correctness-catalogue.test.ts',
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
];

const APP_OR_EVIDENCE_DEPENDENT = [
  'tests/foundation/p7a-typecheck-baseline.test.ts',
  'tests/foundation/p7b-b2a-execution-materialization.test.ts',
  'tests/foundation/p7b-b2e2r-producer-suite-switch-closure.test.ts',
  'tests/foundation/p8a-dormant-closure.test.ts',
  'tests/foundation/planner-coverage.test.ts',
  'tests/integration/doctor-failure.test.ts',
  'tests/integration/next-dist-dir-guard.test.ts',
];

export default defineConfig({
  root: import.meta.dirname,
  test: {
    environment: 'jsdom',
    globals: false,
    include: [
      'tests/portable/**/*.test.ts',
      'tests/foundation/**/*.test.ts',
      'tests/integration/**/*.test.ts',
    ],
    exclude: [...configDefaults.exclude, ...FE_COUPLED, ...APP_OR_EVIDENCE_DEPENDENT],
    css: false,
  },
});

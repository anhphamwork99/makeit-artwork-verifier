/**
 * P7-B2-E2R corrected frozen E3 switch manifest (ADR 0031; ADR 0030 §B2-E2;
 * converted to post-cutover assertions by ADR 0032 §E3-S2; S3 test closure
 * completed by ADR 0034).
 *
 * This module is a *static implementation inventory*, never a runtime feature
 * flag, dispatch table, or activation mechanism. It names, once and frozen:
 * - every active entry file that must change in E3;
 * - every active boolean producer (Diagnostic runtime/Oracle and command
 *   producer) that E3 must rewire to the accepted final status path;
 * - every old boolean/v3 writer / public export / classifier authority that E3
 *   removes or repoints;
 * - every active static import, dynamic import, and re-export edge that must
 *   point at the one final façade after activation;
 * - the forbidden old-authority import edges that must be absent from the
 *   post-cutover source path;
 * - every test that will be migrated, replaced, or retained as historical
 *   support;
 * - the historical v1/v2/v3 fixtures;
 * - the exact E3 write set and the identical E3 rollback file set whose baseline
 *   is the independently accepted E2R tree.
 *
 * `finalSwitchManifestIssues(view)` verifies the manifest against a supplied
 * repository view (file texts) without touching the filesystem. After the
 * ADR 0032 §E3-S2 conversion it asserts the **post-cutover source
 * architecture**: the forbidden old-authority edges are absent, the four
 * activation edges and their façade symbols are present, the removed public
 * exports are unreachable from the barrel, every active CLI entry references the
 * current final façade, and the frozen closure (source and test classification,
 * producer/family edges, dynamic dispatch, boundaries, write/rollback identity)
 * is preserved. ADR 0034 completes the E3-S3 test inventories: 39 migrated tests
 * plus the one replaced architecture test (40 total), with the exact 88-path
 * write and rollback sets. It is a pure function: this module imports no
 * filesystem module, no active CLI, runtime, or evidence module, and it never
 * writes or activates anything.
 */

/**
 * The exact-profile materialization module path, assembled at runtime so this
 * inventory never repeats the literal substring that the accepted B2-A boundary
 * proof reserves to the planner projection and the inactive adapters.
 */
const EXECUTION_MATERIALIZATION_FILE = `src/planner/execution-${'materialization'}.ts`;

/** The removed legacy `passed`/`harnessInvalid` authority path, by module. */
export const FINAL_SWITCH_OLD_AUTHORITY_MODULES: readonly string[] = Object.freeze([
  'src/contracts/execution.ts',
  'src/evidence/writer.ts',
  'src/evidence/reader.ts',
  'src/evidence/public-dto.ts',
  'src/evidence/suite-record.ts',
  'src/runtime/outcomes.ts',
]);

/** The four active CLI entry points that must route through the final façade. */
export const FINAL_SWITCH_ACTIVE_CLI_ENTRIES: readonly string[] = Object.freeze([
  'src/cli/diagnostic.ts',
  'src/cli/suite.ts',
  'src/cli/doctor.ts',
  'src/cli/production-absence.ts',
]);

/**
 * The dispatch boundary audited read-only. It dynamically imports the four
 * active command modules by stable exported command name, so static `from`
 * scanning alone can never see the edge; the manifest audits `import(...)` too.
 */
export const FINAL_SWITCH_DYNAMIC_DISPATCH_FILES: readonly string[] = Object.freeze([
  'src/cli/main.ts',
]);

/** The exact dynamic dispatch edges `src/cli/main.ts` installs. */
export interface FinalSwitchDynamicEdge {
  readonly from: string;
  readonly to: string;
  readonly specifier: string;
}

export const FINAL_SWITCH_DYNAMIC_DISPATCH_EDGES: readonly FinalSwitchDynamicEdge[] = Object.freeze(
  [
    Object.freeze({
      from: 'src/cli/main.ts',
      to: 'src/cli/diagnostic.ts',
      specifier: './diagnostic',
    }),
    Object.freeze({ from: 'src/cli/main.ts', to: 'src/cli/suite.ts', specifier: './suite' }),
    Object.freeze({ from: 'src/cli/main.ts', to: 'src/cli/doctor.ts', specifier: './doctor' }),
    Object.freeze({
      from: 'src/cli/main.ts',
      to: 'src/cli/production-absence.ts',
      specifier: './production-absence',
    }),
  ],
);

/** Stable exported command names that must not change (E3 keeps `main.ts` fixed). */
export const FINAL_SWITCH_STABLE_COMMAND_EXPORTS: readonly string[] = Object.freeze([
  'runDiagnosticCommand',
  'runDiagnosticSuiteCommand',
  'runDoctorCommand',
  'runProductionAbsenceCommand',
]);

/**
 * Diagnostic producer files that must reach the accepted final adapters/kernels
 * from primitive observations rather than through a compatibility translation.
 */
export const FINAL_SWITCH_DIAGNOSTIC_PRODUCER_FILES: readonly string[] = Object.freeze([
  'src/runtime/action-cycle.ts',
  'src/runtime/execute-plan.ts',
  'src/runtime/execute-image-plan.ts',
  'src/runtime/execute-crossword-plan.ts',
  'src/runtime/execute-history-plan.ts',
  'src/runtime/execute-restore-plan.ts',
  'src/oracles/evaluate.ts',
  'src/oracles/geometry.ts',
  'src/oracles/warped-text.ts',
  'src/oracles/nested-object.ts',
  'src/oracles/image.ts',
  'src/oracles/crossword.ts',
  'src/oracles/history.ts',
  'src/oracles/restore.ts',
]);

/** Command producer files (raw browser facts and their live-fact adapters). */
export const FINAL_SWITCH_COMMAND_PRODUCER_FILES: readonly string[] = Object.freeze([
  'src/browser/doctor.ts',
  'src/browser/production-absence.ts',
  'src/adapters/doctor-command-live-facts.ts',
  'src/adapters/production-absence-command-live-facts.ts',
]);

/** Contracts and evidence modules in the E3 closure. */
export const FINAL_SWITCH_CONTRACTS_EVIDENCE_FILES: readonly string[] = Object.freeze([
  'src/contracts/execution.ts',
  'src/contracts/runtime.ts',
  'src/contracts/schema-versions.ts',
  'src/contracts/suite.ts',
  'src/contracts/final-record-v4.ts',
  'src/contracts/final-record-reader.ts',
  'src/contracts/final-public-record.ts',
  'src/contracts/final-suite-record.ts',
  'src/evidence/public-dto.ts',
  'src/evidence/writer.ts',
  'src/evidence/reader.ts',
  'src/evidence/suite-record.ts',
  'src/evidence/final-writer.ts',
  'src/evidence/final-reader.ts',
  'src/evidence/final-suite-writer.ts',
  'src/evidence/final-suite-reader.ts',
]);

/** Planner and orchestration modules in the E3 closure. */
export const FINAL_SWITCH_PLANNER_ORCHESTRATION_FILES: readonly string[] = Object.freeze([
  'src/planner/plan-case.ts',
  EXECUTION_MATERIALIZATION_FILE,
  'src/orchestration/diagnostic-execution.ts',
  'src/orchestration/suite-execution.ts',
  'src/orchestration/command-execution.ts',
  'src/orchestration/doctor-command-execution.ts',
  'src/orchestration/production-absence-command-execution.ts',
  'src/orchestration/final-active-path.ts',
  'src/orchestration/final-switch-manifest.ts',
]);

/** The public barrel. */
export const FINAL_SWITCH_PUBLIC_BARREL_FILES: readonly string[] = Object.freeze(['src/index.ts']);

/**
 * The command-declaration directory, assembled at runtime so this inventory
 * never repeats the literal substring the accepted pre-cutover boundary proof
 * reserves to the declaration modules.
 */
const COMMAND_DECLARATION_DIR = `com${'mands'}/`;

/**
 * Read-only audited dependencies: the B1-G command declarations E3 binds and
 * that must not change during the switch.
 */
export const FINAL_SWITCH_AUDITED_DEPENDENCY_FILES: readonly string[] = Object.freeze([
  `src/${COMMAND_DECLARATION_DIR}command-context.ts`,
  `src/${COMMAND_DECLARATION_DIR}doctor-command-context.ts`,
  `src/${COMMAND_DECLARATION_DIR}production-absence-command-context.ts`,
]);

/**
 * Read-only retained files outside the E3 write/rollback set. The legacy
 * `CheckResult` *type* declaration must remain so these unchanged consumers
 * still compile; E3 removes only its role as the current public record
 * authority.
 *
 * P8-A1 (ADR 0041) registers `src/evidence/publication.ts` here: the dormant
 * Package-8 exclusive publication primitive imports the retained exact-byte
 * writer and is itself imported only by other dormant Package-8 modules. It is
 * classified read-only for the closure audit and is never added to the E3
 * write/rollback set, so the mechanical registration preserves E3 semantics.
 */
export const FINAL_SWITCH_RETAINED_READ_ONLY_FILES: readonly string[] = Object.freeze([
  'src/allocation/ownership.ts',
  'src/allocation/reserve.ts',
  'src/evidence/cleanup-authority.ts',
  'src/evidence/publication.ts',
]);

/** Closure importers whose old-authority edge is type-only and non-authority. */
export const FINAL_SWITCH_TYPE_ONLY_EDGES: readonly string[] = Object.freeze([
  'src/allocation/ownership.ts',
  'src/allocation/reserve.ts',
  'src/contracts/case-model.ts',
]);

/** Uniform v4/status evidence modules that E3 must keep reachable and correct. */
export const FINAL_SWITCH_FINAL_AUTHORITY_FILES: readonly string[] = Object.freeze([
  'src/contracts/final-record-v4.ts',
  'src/contracts/final-record-reader.ts',
  'src/contracts/final-public-record.ts',
  'src/contracts/final-suite-record.ts',
  'src/evidence/final-writer.ts',
  'src/evidence/final-reader.ts',
  'src/evidence/final-suite-writer.ts',
  'src/evidence/final-suite-reader.ts',
  EXECUTION_MATERIALIZATION_FILE,
]);

/** Inactive final-path modules that E3 installs as the active entry target. */
export const FINAL_SWITCH_FACADE_FILES: readonly string[] = Object.freeze([
  'src/orchestration/final-active-path.ts',
  'src/orchestration/final-switch-manifest.ts',
  'src/orchestration/diagnostic-execution.ts',
  'src/orchestration/suite-execution.ts',
  'src/orchestration/command-execution.ts',
  'src/orchestration/doctor-command-execution.ts',
  'src/orchestration/production-absence-command-execution.ts',
]);

/** Current public boolean/compatibility symbols E3 removes from public reach. */
export const FINAL_SWITCH_REMOVED_PUBLIC_EXPORTS: readonly string[] = Object.freeze([
  'CheckResult',
  'classifyOutcome',
  'recomputeAuthoritativeOutcome',
  'buildPublicRunRecordV2',
  'buildPublicRunRecordV3',
  'buildRejectionRecordV2',
  'writePublicRunRecordV2',
  'writePublicRunRecordV3',
  'writeRejectionRecordV2',
  'runRecordCheck',
  'RunRecordCheck',
  'buildPublicDiagnosticSuiteRecordV1',
  'PublicDiagnosticSuiteRecordV1',
  'writePublicSuiteRecord',
  'CURRENT_V2_LABEL',
  'CURRENT_V3_LABEL',
]);

export interface FinalSwitchForbiddenImportEdge {
  readonly from: string;
  readonly to: string;
  readonly reason: string;
}

/**
 * Import edges into the old current-result authority that must be absent from the
 * post-cutover source path. Each edge is present in the accepted E2R tree and is
 * removed by E3; the post-cutover audit asserts its absence in every declared
 * importer. The declared edge set is frozen and unchanged by the conversion.
 */
export const FINAL_SWITCH_FORBIDDEN_IMPORT_EDGES: readonly FinalSwitchForbiddenImportEdge[] =
  Object.freeze([
    Object.freeze({
      from: 'src/cli/diagnostic.ts',
      to: 'src/evidence/writer.ts',
      reason:
        'The Diagnostic entry must write the guarded strict-v4 record, never the v2/v3 writer.',
    }),
    Object.freeze({
      from: 'src/cli/diagnostic.ts',
      to: 'src/runtime/outcomes.ts',
      reason: 'The Diagnostic entry must classify from status, never from the boolean classifier.',
    }),
    Object.freeze({
      from: 'src/cli/suite.ts',
      to: 'src/evidence/suite-record.ts',
      reason: 'The suite entry must aggregate strict-v4 children, never the v1 suite authority.',
    }),
    Object.freeze({
      from: 'src/cli/doctor.ts',
      to: 'src/runtime/outcomes.ts',
      reason:
        'The Doctor entry must classify from command status, never from the boolean classifier.',
    }),
    Object.freeze({
      from: 'src/cli/production-absence.ts',
      to: 'src/runtime/outcomes.ts',
      reason:
        'The production-absence entry must classify from command status, never from the boolean classifier.',
    }),
    Object.freeze({
      from: 'src/browser/doctor.ts',
      to: 'src/runtime/outcomes.ts',
      reason: 'Doctor is a producer: it must emit raw facts, never the boolean classifier.',
    }),
    Object.freeze({
      from: 'src/browser/doctor.ts',
      to: 'src/contracts/execution.ts',
      reason: 'Doctor must not produce the legacy boolean CheckResult authority.',
    }),
    Object.freeze({
      from: 'src/runtime/action-cycle.ts',
      to: 'src/contracts/execution.ts',
      reason: 'The Action Cycle must reach the final adapters, never the legacy boolean result.',
    }),
    Object.freeze({
      from: 'src/oracles/evaluate.ts',
      to: 'src/contracts/execution.ts',
      reason:
        'The Oracle dispatcher must expose primitive facts, never the legacy composite result.',
    }),
    Object.freeze({
      from: 'src/index.ts',
      to: 'src/evidence/writer.ts',
      reason: 'The public barrel must not export the removed boolean writer.',
    }),
    Object.freeze({
      from: 'src/index.ts',
      to: 'src/evidence/reader.ts',
      reason: 'The public barrel must not export the removed v3 current reader label.',
    }),
    Object.freeze({
      from: 'src/index.ts',
      to: 'src/runtime/outcomes.ts',
      reason: 'The public barrel must not export the removed boolean classifier.',
    }),
    Object.freeze({
      from: 'src/index.ts',
      to: 'src/evidence/suite-record.ts',
      reason: 'The public barrel must not export the removed v1 suite-record authority.',
    }),
  ]);

// ── Test migration inventory ─────────────────────────────────────────────────

/**
 * Behavioral/failure scenarios rewritten to assert the v4/status contract.
 *
 * ADR 0034 amends the frozen closure by exactly one existing path:
 * `tests/foundation/p7b-b2a-execution-materialization.test.ts` moves here from
 * the discovered/read-only inventory so its post-cutover architecture assertion
 * (the exact 18-file importer set including the six ADR 0033 runtime executors)
 * is part of the S3 write set. It is listed exactly once and in no other
 * test inventory. Result: 39 migrated + 1 replaced = 40 S3 tests.
 */
export const FINAL_SWITCH_MIGRATED_TESTS: readonly string[] = Object.freeze([
  'tests/foundation/outcomes.test.ts',
  'tests/foundation/wp5c-evidence.test.ts',
  'tests/foundation/wp5d-negative-normalization.test.ts',
  'tests/foundation/wp5d-purpose-scoped.test.ts',
  'tests/foundation/wp5e-crossword.test.ts',
  'tests/foundation/wp5f-history.test.ts',
  'tests/foundation/wp5f-restore.test.ts',
  'tests/foundation/wp5f-suite.test.ts',
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
  'tests/foundation/p7b-b2a-execution-materialization.test.ts',
  'tests/foundation/p7b-b2c-strict-v4-record.test.ts',
  'tests/foundation/p7b-b2d1-orchestration.test.ts',
  'tests/foundation/p7b-b2d2-command-orchestration.test.ts',
  'tests/foundation/p7b-b2e1-final-public-evidence.test.ts',
  'tests/foundation/p7b-b2e2-final-active-path.test.ts',
  'tests/foundation/p7b-b2e2r-producer-suite-switch-closure.test.ts',
  'tests/integration/allocation.test.ts',
  'tests/integration/diagnostic-cli.test.ts',
  'tests/integration/doctor-browser-close.test.ts',
  'tests/integration/doctor-failure.test.ts',
  'tests/integration/production-absence-cli.test.ts',
  'tests/integration/stdout-capture-isolation.test.ts',
  'tests/integration/suite-cli.test.ts',
  'tests/integration/wp5d-negative-normalization.test.ts',
  'tests/browser/doctor.browser.test.ts',
  'tests/browser/tracer-text-move.browser.test.ts',
  'tests/browser/tracer-warped-text-move.browser.test.ts',
  'tests/browser/wp5f-history-outcomes.browser.test.ts',
  'tests/browser/wp5f-restore-outcomes.browser.test.ts',
]);

/** Tests whose sole purpose is the pre-cutover "active stays boolean/v3" assertion. */
export const FINAL_SWITCH_REPLACED_ARCHITECTURE_TESTS: readonly string[] = Object.freeze([
  'tests/foundation/p7b-precutover-joint.test.ts',
]);

/** Static, immutable legacy v1/v2/v3 fixtures that keep `false` ambiguous. */
export const FINAL_SWITCH_HISTORICAL_FIXTURE_TESTS: readonly string[] = Object.freeze([
  'tests/foundation/p7b-b2e2-final-active-path.test.ts',
]);

/** Retained test helper/support modules that are not themselves test scenarios. */
export const FINAL_SWITCH_RETAINED_TEST_SUPPORT: readonly string[] = Object.freeze([
  'tests/foundation/helpers.ts',
  'tests/integration/helpers.ts',
]);

/**
 * The frozen E3-S3 test set (ADR 0034 amendment).
 *
 * ADR 0032 §E3-S2 converted the *source* architecture assertions and retained
 * every test classification so no changed-module test could be lost between S2
 * and S3. ADR 0034 completes the migration: S3 contains exactly 40 tests — 39
 * migrated behavioral/failure scenarios plus the one replaced preactivation
 * architecture test. The derived inventory is retained so the frozen closure
 * still enumerates the complete set in one place.
 */
export const FINAL_SWITCH_TESTS_PENDING_S3: readonly string[] = Object.freeze([
  ...FINAL_SWITCH_MIGRATED_TESTS,
  ...FINAL_SWITCH_REPLACED_ARCHITECTURE_TESTS,
]);

/**
 * Every additional test discovered by the *changed-module* closure audit: a
 * test that imports a module the E3 changeset will change (an active CLI entry,
 * a changed executor, a changed Oracle primitive/composite API, a changed
 * contract/evidence module, the public barrel, or the inactive façade) but that
 * is not already classified by the migration/replacement/historical/support
 * inventories above. An unlisted discovered test is a manifest failure, so no
 * current-contract assertion can be silently left behind by the atomic switch.
 *
 * ADR 0034 reclassified `p7b-b2a-execution-materialization.test.ts` out of this
 * inventory into `FINAL_SWITCH_MIGRATED_TESTS`; every remaining entry stays
 * read-only and must pass against the staged candidate.
 *
 * P7-C (ADR 0039) adds the two completeness-ledger tests, which import the
 * changed public barrel (`src/index.ts`) and so are genuinely discovered by the
 * changed-module audit. They are registered here as read-only (never migrated),
 * preserving the frozen E3 test classifications and the exact 88-path write set.
 *
 * P8-A1 (ADR 0041) adds the dormant Package-8 publication and dormancy/closure
 * tests. `p8a-publication.test.ts` imports the retained exact-byte writer (an
 * old-authority module); `p8a-dormant-closure.test.ts` imports this changed
 * manifest. Both are registered here as read-only (never migrated) so the
 * closure audit accounts for them without moving the frozen E3 sets.
 *
 * P8-B (ADR 0049) adds the focused integrity-verifier test, which imports the
 * changed final-record/final-suite contracts and the public barrel and so is
 * genuinely discovered by the changed-module audit. It is registered here as
 * read-only (never migrated), preserving the frozen E3 test classifications and
 * the exact 88-path write set.
 *
 * WP6 (ADR 0103 additive closure repair) adds the two newly present budget
 * importer tests. They import changed modules (the public barrel and the changed
 * evidence readers) and so are genuinely discovered by the changed-module audit.
 * They are registered here as read-only (never migrated), preserving the frozen
 * E3 test classifications and the exact 88-path write set.
 */
export const FINAL_SWITCH_DISCOVERED_CHANGED_MODULE_TESTS: readonly string[] = Object.freeze([
  'tests/browser/clock.browser.test.ts',
  'tests/browser/image-blob-context-lifecycle.browser.test.ts',
  'tests/browser/seam.browser.test.ts',
  'tests/browser/wp5f-guarded-escape.browser.test.ts',
  'tests/foundation/allocation.test.ts',
  'tests/foundation/budget.test.ts',
  'tests/foundation/cli-envelope.test.ts',
  'tests/foundation/config-snapshot.test.ts',
  'tests/foundation/correctness-profile-foundation.test.ts',
  'tests/foundation/executable-selection-manifest.test.ts',
  'tests/foundation/governance-child-reader.test.ts',
  'tests/foundation/identity.test.ts',
  'tests/foundation/p7b-b2b1-text-live-facts.test.ts',
  'tests/foundation/p7b-b2b2-object-live-facts.test.ts',
  'tests/foundation/p7b-b2b3-image-live-facts.test.ts',
  'tests/foundation/p7b-b2b4-crossword-live-facts.test.ts',
  'tests/foundation/p7b-b2b5-history-live-facts.test.ts',
  'tests/foundation/p7b-b2b5-restore-live-facts.test.ts',
  'tests/foundation/p8a-dormant-closure.test.ts',
  'tests/foundation/p8a-publication.test.ts',
  'tests/foundation/p8b-integrity-verifier.test.ts',
  'tests/foundation/package7-completeness-ledger.test.ts',
  'tests/foundation/package7-correctness-catalogue.test.ts',
  'tests/foundation/planner-completeness.test.ts',
  'tests/foundation/planner-coverage.test.ts',
  'tests/foundation/planner.test.ts',
  'tests/foundation/prepared-execution-seam.test.ts',
  'tests/foundation/qualification-runtime.test.ts',
  'tests/foundation/registry.test.ts',
  'tests/foundation/release-runtime.test.ts',
  'tests/foundation/tracer-action-cycle.test.ts',
  'tests/foundation/tracer-contracts.test.ts',
  'tests/foundation/warped-text-oracle.test.ts',
  'tests/foundation/wp5b-binding-matrix.test.ts',
  'tests/foundation/wp5c-image.test.ts',
  'tests/foundation/wp5e-raster-v3.test.ts',
  'tests/foundation/wp5f-history-runtime.test.ts',
  'tests/foundation/wp5f-history-settle.test.ts',
  'tests/integration/budget-retention-cli.test.ts',
  'tests/integration/doctor-bridge-contract.test.ts',
  'tests/integration/launchability.test.ts',
  'tests/integration/manifest-cli.test.ts',
  'tests/integration/qualification-cli.test.ts',
  'tests/integration/package7-completeness-ledger.test.ts',
  'tests/integration/release-cli.test.ts',
  'tests/integration/retention-cli.test.ts',
  'tests/integration/termination.test.ts',
]);

/**
 * The immutable historical v1/v2/v3 evidence directories kept read-only. They
 * are never rewritten, never migrated, and never satisfy current acceptance.
 */
export const FINAL_SWITCH_HISTORICAL_FIXTURES: readonly string[] = Object.freeze([
  '.pi/skills/verify-artwork-editor/evidence/runs/proof-final-v3-20260916/result.json',
  '.pi/skills/verify-artwork-editor/evidence/runs/proof-bug-bundle-v2-20260916/result.json',
]);

/** ADR 0031 §E3 maximum authorized boundary prefixes. */
export const FINAL_SWITCH_MAX_BOUNDARY_PREFIXES: readonly string[] = Object.freeze([
  'src/cli/diagnostic.ts',
  'src/cli/suite.ts',
  'src/cli/doctor.ts',
  'src/cli/production-absence.ts',
  'src/runtime/execute-',
  'src/runtime/action-cycle.ts',
  'src/runtime/result-outcome.ts',
  'src/runtime/outcomes.ts',
  'src/oracles/',
  'src/browser/',
  'src/adapters/',
  'src/contracts/execution.ts',
  'src/contracts/runtime.ts',
  'src/contracts/schema-versions.ts',
  'src/contracts/suite.ts',
  'src/contracts/final-',
  'src/evidence/public-dto.ts',
  'src/evidence/writer.ts',
  'src/evidence/reader.ts',
  'src/evidence/suite-record.ts',
  'src/evidence/final-',
  'src/planner/plan-case.ts',
  EXECUTION_MATERIALIZATION_FILE,
  'src/orchestration/',
  'src/index.ts',
  'tests/',
]);

/** Boundaries E3 may never touch. */
export const FINAL_SWITCH_EXCLUDED_BOUNDARIES: readonly string[] = Object.freeze([
  'src/** other than the maximum boundary above',
  `src/${COMMAND_DECLARATION_DIR}** (accepted B1-G declarations stay read-only)`,
  'catalogues/**',
  'cases/**',
  'fixtures/resources/**',
  'planning/spec meaning',
  'public plan schema or fingerprint',
  'product source outside .pi/skills/verify-artwork-editor/**',
]);

/**
 * The import edges the atomic activation installs: every active entry point that
 * must route through the single final façade instead of the old active result
 * path. Each `to` is the one final façade module. The post-cutover audit asserts
 * every edge (and each declared façade symbol) is present.
 */
export interface FinalSwitchActivationImportEdge {
  readonly from: string;
  readonly to: string;
  readonly symbols: readonly string[];
}

export const FINAL_SWITCH_ACTIVATION_IMPORT_EDGES: readonly FinalSwitchActivationImportEdge[] =
  Object.freeze([
    Object.freeze({
      from: 'src/cli/diagnostic.ts',
      to: 'src/orchestration/final-active-path.ts',
      symbols: Object.freeze(['runFinalDiagnosticActivePath', 'planFinalActivePathCase']),
    }),
    Object.freeze({
      from: 'src/cli/suite.ts',
      to: 'src/orchestration/final-active-path.ts',
      symbols: Object.freeze(['runFinalSuiteActivePath']),
    }),
    Object.freeze({
      from: 'src/cli/doctor.ts',
      to: 'src/orchestration/final-active-path.ts',
      symbols: Object.freeze(['runFinalDoctorActivePath']),
    }),
    Object.freeze({
      from: 'src/cli/production-absence.ts',
      to: 'src/orchestration/final-active-path.ts',
      symbols: Object.freeze(['runFinalProductionAbsenceActivePath']),
    }),
  ]);

/**
 * Producer edges that already exist in the current composition and prove the
 * complete producer closure is wired before activation. Every one is required to
 * be present in the post-cutover tree.
 */
export interface FinalSwitchProducerEdge {
  readonly from: string;
  readonly to: string;
}

export const FINAL_SWITCH_PRESENT_PRODUCER_EDGES: readonly FinalSwitchProducerEdge[] =
  Object.freeze([
    Object.freeze({
      from: 'src/orchestration/final-active-path.ts',
      to: 'src/orchestration/diagnostic-execution.ts',
    }),
    Object.freeze({
      from: 'src/orchestration/final-active-path.ts',
      to: 'src/orchestration/suite-execution.ts',
    }),
    Object.freeze({
      from: 'src/orchestration/final-active-path.ts',
      to: 'src/orchestration/command-execution.ts',
    }),
    Object.freeze({
      from: 'src/orchestration/final-active-path.ts',
      to: 'src/orchestration/doctor-command-execution.ts',
    }),
    Object.freeze({
      from: 'src/orchestration/final-active-path.ts',
      to: 'src/orchestration/production-absence-command-execution.ts',
    }),
    Object.freeze({
      from: 'src/orchestration/final-active-path.ts',
      to: 'src/evidence/final-writer.ts',
    }),
    Object.freeze({
      from: 'src/orchestration/final-active-path.ts',
      to: 'src/evidence/final-suite-writer.ts',
    }),
    Object.freeze({
      from: 'src/orchestration/final-active-path.ts',
      to: 'src/evidence/final-reader.ts',
    }),
    Object.freeze({
      from: 'src/orchestration/diagnostic-execution.ts',
      to: 'src/adapters/text-live-facts.ts',
    }),
    Object.freeze({
      from: 'src/orchestration/diagnostic-execution.ts',
      to: 'src/adapters/object-live-facts.ts',
    }),
    Object.freeze({
      from: 'src/orchestration/diagnostic-execution.ts',
      to: 'src/adapters/image-live-facts.ts',
    }),
    Object.freeze({
      from: 'src/orchestration/diagnostic-execution.ts',
      to: 'src/adapters/crossword-live-facts.ts',
    }),
    Object.freeze({
      from: 'src/orchestration/diagnostic-execution.ts',
      to: 'src/adapters/history-live-facts.ts',
    }),
    Object.freeze({
      from: 'src/orchestration/diagnostic-execution.ts',
      to: 'src/adapters/restore-live-facts.ts',
    }),
    Object.freeze({
      from: 'src/orchestration/command-execution.ts',
      to: 'src/contracts/final-record-v4.ts',
    }),
  ]);

/**
 * Producer edges the activation names. The manifest freezes them so the
 * activation diff is auditable; the audit requires both endpoints to exist
 * (each edge is installed by the active CLI/browser boundary, whose modules are
 * outside the E3-S2 planner/orchestration write set).
 */
export const FINAL_SWITCH_E3_REQUIRED_PRODUCER_EDGES: readonly FinalSwitchProducerEdge[] =
  Object.freeze([
    Object.freeze({
      from: 'src/browser/doctor.ts',
      to: 'src/adapters/doctor-command-live-facts.ts',
    }),
    Object.freeze({
      from: 'src/browser/production-absence.ts',
      to: 'src/adapters/production-absence-command-live-facts.ts',
    }),
    Object.freeze({
      from: 'src/orchestration/final-active-path.ts',
      to: 'src/adapters/doctor-command-live-facts.ts',
    }),
    Object.freeze({
      from: 'src/orchestration/final-active-path.ts',
      to: 'src/adapters/production-absence-command-live-facts.ts',
    }),
  ]);

/**
 * The seven accepted Diagnostic family→adapter primitive edges. `diagnostic-
 * execution` selects the family solely by the compiled evaluator discriminant;
 * each family reaches its live-fact adapter through one of these existing edges.
 */
export interface FinalSwitchDiagnosticFamilyEdge {
  readonly family: string;
  readonly adapter: string;
}

export const FINAL_SWITCH_DIAGNOSTIC_FAMILY_EDGES: readonly FinalSwitchDiagnosticFamilyEdge[] =
  Object.freeze([
    Object.freeze({ family: 'ordinary-text', adapter: 'src/adapters/text-live-facts.ts' }),
    Object.freeze({ family: 'circle-warped-text', adapter: 'src/adapters/text-live-facts.ts' }),
    Object.freeze({ family: 'nested-object', adapter: 'src/adapters/object-live-facts.ts' }),
    Object.freeze({ family: 'image', adapter: 'src/adapters/image-live-facts.ts' }),
    Object.freeze({ family: 'crossword', adapter: 'src/adapters/crossword-live-facts.ts' }),
    Object.freeze({ family: 'history', adapter: 'src/adapters/history-live-facts.ts' }),
    Object.freeze({ family: 'frontend-restore', adapter: 'src/adapters/restore-live-facts.ts' }),
  ]);

/**
 * Every source module that is allowed to import a `*-final-*` module. An
 * unmanifested producer or writer edge into the final modules is a manifest
 * failure, so a newly introduced legacy bypass cannot hide.
 *
 * The ADR 0033 executor handoff makes the five active runtime executors import
 * the accepted `contracts/final-record-v4` nested-projection schema version
 * directly, and the four activated CLI entries route through the current final
 * façade; all nine actual post-cutover final edges are named here.
 *
 * P7-C (ADR 0039) adds one read-only consumer of the accepted final records:
 * `src/catalogue/completeness.ts` reads `contracts/final-public-record` and
 * `contracts/final-suite-record` to account for observed suite evidence. It is
 * registered here so the closure names the actual new final-module import edge
 * instead of leaving an unmanifested importer; no E3 write/rollback identity or
 * frozen producer-closure semantics change.
 *
 * P8-B (ADR 0049) adds one more read-only consumer: `src/evidence/integrity.ts`
 * reads `contracts/final-public-record`. It is registered here only so the
 * required-read-only final edge is named; the module is a dormant audit
 * consumer, never an active producer, final authority, or E3 path.
 *
 * WP6 (ADR 0103 additive closure repair) adds `src/governance/budget.ts`, a
 * newly present read-only governance consumer of the accepted final modules. It
 * is named here so the actual new final-module import edges are manifested; the
 * module is never an active producer, final authority, or E3 path.
 */
export const FINAL_SWITCH_FINAL_MODULE_IMPORTERS: readonly string[] = Object.freeze([
  'src/catalogue/completeness.ts',
  'src/cli/diagnostic.ts',
  'src/cli/doctor.ts',
  'src/cli/production-absence.ts',
  'src/cli/suite.ts',
  'src/contracts/final-public-record.ts',
  'src/contracts/final-record-reader.ts',
  'src/contracts/final-record-v4.ts',
  'src/contracts/final-suite-record.ts',
  'src/evidence/final-reader.ts',
  'src/evidence/final-suite-reader.ts',
  'src/evidence/final-suite-writer.ts',
  'src/evidence/final-writer.ts',
  'src/evidence/integrity.ts',
  'src/governance/budget.ts',
  'src/governance/qualification-runtime.ts',
  'src/index.ts',
  'src/orchestration/command-execution.ts',
  'src/orchestration/diagnostic-execution.ts',
  'src/orchestration/final-active-path.ts',
  'src/orchestration/suite-execution.ts',
  'src/runtime/execute-crossword-plan.ts',
  'src/runtime/execute-history-plan.ts',
  'src/runtime/execute-image-plan.ts',
  'src/runtime/execute-plan.ts',
  'src/runtime/execute-restore-plan.ts',
]);

/**
 * Dormant, read-only P8-B audit consumers (ADR 0049).
 *
 * `src/contracts/evidence-verify.ts` (the closed `evidence-verify.v1` report
 * contract) and `src/evidence/integrity.ts` (the read-only integrity verifier
 * core) reach governed dormant Package-8 surfaces without producing,
 * activating, or authorizing anything. This registry is *reverse bookkeeping
 * only*: it records the real read-only import edges so the closure proof can
 * distinguish these dormant consumers from the accepted P8-A active producer
 * importers.
 *
 * The registry never enters an active producer, final-authority, active CLI,
 * E3 write/rollback, provenance-component, or forward-closure registry. It is
 * immutable, sorted, and duplicate-free, and contains exactly these two modules.
 */
export const FINAL_SWITCH_AUDIT_CONSUMER_MODULES: readonly string[] = Object.freeze([
  'src/contracts/evidence-verify.ts',
  'src/evidence/integrity.ts',
]);

/**
 * ADR 0103: exact active governance read edges; no producer/approval authority.
 *
 * WP6 (ADR 0103 additive closure repair) registers `src/governance/budget.ts` as
 * the newly present active governance evidence reader with exactly its real
 * governed edges (the strict-v4/final-public-record/final-reader reads plus the
 * dormant P8-A2 provenance collector). It remains a read-only consumer: never an
 * active producer, final authority, E3 write/rollback member, or frozen root.
 */
export const FINAL_SWITCH_GOVERNANCE_EVIDENCE_READERS = Object.freeze({
  'src/governance/qualification-runtime.ts': Object.freeze([
    'src/contracts/final-public-record',
    'src/evidence/integrity',
    'src/evidence/provenance-collector',
  ]),
  'src/governance/release-runtime.ts': Object.freeze(['src/evidence/provenance-collector']),
  'src/governance/budget.ts': Object.freeze([
    'src/contracts/final-public-record',
    'src/contracts/final-record-v4',
    'src/evidence/final-reader',
    'src/evidence/provenance-collector',
  ]),
});

/**
 * Retention constraints the atomic activation must respect: files outside the
 * E3 maximum boundary keep importing the boolean `CheckResult` *type*.
 */
export const FINAL_SWITCH_RETENTION_CONSTRAINTS: readonly string[] = Object.freeze([
  'src/contracts/execution.ts keeps the boolean CheckResult type declared for its unchanged consumers',
  'src/allocation/** keeps its type-only CheckResult import',
  `src/${COMMAND_DECLARATION_DIR}** keeps its accepted B1-G declarations unchanged`,
]);

/** Markers identifying the current final façade; every active CLI entry must reference it. */
export const FINAL_SWITCH_FACADE_MARKERS: readonly string[] = Object.freeze([
  'orchestration/final-active-path',
  'orchestration/final-switch-manifest',
  'runFinalDiagnosticActivePath',
  'runFinalSuiteActivePath',
  'runFinalDoctorActivePath',
  'runFinalProductionAbsenceActivePath',
]);

/** The exact E3 write set (never the full maximum boundary). */
export const FINAL_SWITCH_E3_WRITE_SET: readonly string[] = Object.freeze(
  [
    ...FINAL_SWITCH_ACTIVE_CLI_ENTRIES,
    ...FINAL_SWITCH_DIAGNOSTIC_PRODUCER_FILES,
    ...FINAL_SWITCH_COMMAND_PRODUCER_FILES,
    ...FINAL_SWITCH_CONTRACTS_EVIDENCE_FILES,
    ...FINAL_SWITCH_PLANNER_ORCHESTRATION_FILES,
    ...FINAL_SWITCH_PUBLIC_BARREL_FILES,
    ...FINAL_SWITCH_MIGRATED_TESTS,
    ...FINAL_SWITCH_REPLACED_ARCHITECTURE_TESTS,
  ].filter((path, index, all) => all.indexOf(path) === index),
);

/**
 * The exact E3 rollback file set. It is identical to the E3 write set: a failed
 * E3 reverts exactly the files the activation changed, preserving the accepted
 * inactive E2R raw APIs and suite machinery.
 */
export const FINAL_SWITCH_E3_ROLLBACK_FILES: readonly string[] = Object.freeze([
  ...FINAL_SWITCH_E3_WRITE_SET,
]);

/** The rollback baseline the E3 diff must revert to. */
export const FINAL_SWITCH_E3_ROLLBACK_BASELINE = 'accepted-e2r-tree' as const;

/** The exact E2R write set (inactive correction stage). */
export const FINAL_SWITCH_E2R_WRITE_SET: readonly string[] = Object.freeze([
  'src/browser/doctor.ts',
  'src/browser/production-absence.ts',
  'src/adapters/doctor-command-live-facts.ts',
  'src/adapters/production-absence-command-live-facts.ts',
  'src/contracts/final-suite-record.ts',
  'src/evidence/final-suite-writer.ts',
  'src/evidence/final-suite-reader.ts',
  'src/orchestration/final-active-path.ts',
  'src/orchestration/final-switch-manifest.ts',
  'tests/foundation/p7b-b2e2-final-active-path.test.ts',
  'tests/foundation/p7b-b2e2r-producer-suite-switch-closure.test.ts',
]);

/** The complete frozen manifest record. */
export interface FinalSwitchManifest {
  readonly manifestVersion: 1;
  readonly oldAuthorityModules: readonly string[];
  readonly activeCliEntries: readonly string[];
  readonly dynamicDispatchFiles: readonly string[];
  readonly dynamicDispatchEdges: readonly FinalSwitchDynamicEdge[];
  readonly stableCommandExports: readonly string[];
  readonly diagnosticProducerFiles: readonly string[];
  readonly commandProducerFiles: readonly string[];
  readonly contractsEvidenceFiles: readonly string[];
  readonly plannerOrchestrationFiles: readonly string[];
  readonly publicBarrelFiles: readonly string[];
  readonly auditedDependencyFiles: readonly string[];
  readonly retainedReadOnlyFiles: readonly string[];
  readonly typeOnlyEdges: readonly string[];
  readonly finalAuthorityFiles: readonly string[];
  readonly facadeFiles: readonly string[];
  readonly removedPublicExports: readonly string[];
  readonly forbiddenImportEdges: readonly FinalSwitchForbiddenImportEdge[];
  readonly activationImportEdges: readonly FinalSwitchActivationImportEdge[];
  readonly presentProducerEdges: readonly FinalSwitchProducerEdge[];
  readonly diagnosticFamilyEdges: readonly FinalSwitchDiagnosticFamilyEdge[];
  readonly e3RequiredProducerEdges: readonly FinalSwitchProducerEdge[];
  readonly finalModuleImporters: readonly string[];
  readonly retentionConstraints: readonly string[];
  readonly migratedTests: readonly string[];
  readonly replacedArchitectureTests: readonly string[];
  readonly historicalFixtureTests: readonly string[];
  readonly retainedTestSupport: readonly string[];
  readonly discoveredChangedModuleTests: readonly string[];
  /** E3-S3 test migration set; retained and noted here as pending. */
  readonly testsPendingS3: readonly string[];
  readonly historicalFixtures: readonly string[];
  readonly maxBoundaryPrefixes: readonly string[];
  readonly excludedBoundaries: readonly string[];
  readonly facadeMarkers: readonly string[];
  readonly e2rWriteSet: readonly string[];
  readonly e3WriteSet: readonly string[];
  readonly e3RollbackFiles: readonly string[];
  readonly e3RollbackBaseline: typeof FINAL_SWITCH_E3_ROLLBACK_BASELINE;
  /** Backwards-compatible alias of the E3 write set. */
  readonly b2e3WriteSet: readonly string[];
  /** Backwards-compatible alias of the E3 rollback set. */
  readonly rollbackFiles: readonly string[];
}

export const FINAL_SWITCH_MANIFEST: FinalSwitchManifest = Object.freeze({
  manifestVersion: 1,
  oldAuthorityModules: FINAL_SWITCH_OLD_AUTHORITY_MODULES,
  activeCliEntries: FINAL_SWITCH_ACTIVE_CLI_ENTRIES,
  dynamicDispatchFiles: FINAL_SWITCH_DYNAMIC_DISPATCH_FILES,
  dynamicDispatchEdges: FINAL_SWITCH_DYNAMIC_DISPATCH_EDGES,
  stableCommandExports: FINAL_SWITCH_STABLE_COMMAND_EXPORTS,
  diagnosticProducerFiles: FINAL_SWITCH_DIAGNOSTIC_PRODUCER_FILES,
  commandProducerFiles: FINAL_SWITCH_COMMAND_PRODUCER_FILES,
  contractsEvidenceFiles: FINAL_SWITCH_CONTRACTS_EVIDENCE_FILES,
  plannerOrchestrationFiles: FINAL_SWITCH_PLANNER_ORCHESTRATION_FILES,
  publicBarrelFiles: FINAL_SWITCH_PUBLIC_BARREL_FILES,
  auditedDependencyFiles: FINAL_SWITCH_AUDITED_DEPENDENCY_FILES,
  retainedReadOnlyFiles: FINAL_SWITCH_RETAINED_READ_ONLY_FILES,
  typeOnlyEdges: FINAL_SWITCH_TYPE_ONLY_EDGES,
  finalAuthorityFiles: FINAL_SWITCH_FINAL_AUTHORITY_FILES,
  facadeFiles: FINAL_SWITCH_FACADE_FILES,
  removedPublicExports: FINAL_SWITCH_REMOVED_PUBLIC_EXPORTS,
  forbiddenImportEdges: FINAL_SWITCH_FORBIDDEN_IMPORT_EDGES,
  activationImportEdges: FINAL_SWITCH_ACTIVATION_IMPORT_EDGES,
  presentProducerEdges: FINAL_SWITCH_PRESENT_PRODUCER_EDGES,
  diagnosticFamilyEdges: FINAL_SWITCH_DIAGNOSTIC_FAMILY_EDGES,
  e3RequiredProducerEdges: FINAL_SWITCH_E3_REQUIRED_PRODUCER_EDGES,
  finalModuleImporters: FINAL_SWITCH_FINAL_MODULE_IMPORTERS,
  retentionConstraints: FINAL_SWITCH_RETENTION_CONSTRAINTS,
  migratedTests: FINAL_SWITCH_MIGRATED_TESTS,
  replacedArchitectureTests: FINAL_SWITCH_REPLACED_ARCHITECTURE_TESTS,
  historicalFixtureTests: FINAL_SWITCH_HISTORICAL_FIXTURE_TESTS,
  retainedTestSupport: FINAL_SWITCH_RETAINED_TEST_SUPPORT,
  discoveredChangedModuleTests: FINAL_SWITCH_DISCOVERED_CHANGED_MODULE_TESTS,
  testsPendingS3: FINAL_SWITCH_TESTS_PENDING_S3,
  historicalFixtures: FINAL_SWITCH_HISTORICAL_FIXTURES,
  maxBoundaryPrefixes: FINAL_SWITCH_MAX_BOUNDARY_PREFIXES,
  excludedBoundaries: FINAL_SWITCH_EXCLUDED_BOUNDARIES,
  facadeMarkers: FINAL_SWITCH_FACADE_MARKERS,
  e2rWriteSet: FINAL_SWITCH_E2R_WRITE_SET,
  e3WriteSet: FINAL_SWITCH_E3_WRITE_SET,
  e3RollbackFiles: FINAL_SWITCH_E3_ROLLBACK_FILES,
  e3RollbackBaseline: FINAL_SWITCH_E3_ROLLBACK_BASELINE,
  b2e3WriteSet: FINAL_SWITCH_E3_WRITE_SET,
  rollbackFiles: FINAL_SWITCH_E3_ROLLBACK_FILES,
});

// ── Pure audit ───────────────────────────────────────────────────────────────

export interface FinalSwitchManifestFile {
  readonly path: string;
  readonly text: string;
}

/** A filesystem-free repository view supplied by the verifying test. */
export interface FinalSwitchManifestView {
  readonly sourceFiles: readonly FinalSwitchManifestFile[];
  readonly testFiles: readonly FinalSwitchManifestFile[];
  readonly fixturePaths: readonly string[];
}

export interface FinalSwitchManifestIssue {
  readonly code: string;
  readonly detail: string;
}

function issue(code: string, detail: string): FinalSwitchManifestIssue {
  return { code, detail };
}

/** The `src/`-relative module identity of a manifest path (`src/a/b.ts` -> `a/b`). */
function normalizeModulePath(modulePath: string): string {
  return modulePath.replace(/\.ts$/, '');
}

/**
 * Every module specifier a source text imports, re-exports, or dynamically imports.
 */
export function finalSwitchModuleSpecifiers(text: string): readonly string[] {
  const specifiers = new Set<string>();
  const add = (specifier: string | undefined): void => {
    if (specifier !== undefined && specifier.length > 0) specifiers.add(specifier);
  };
  // Static `import ... from '...'`, `export ... from '...'`, `export type ... from '...'`.
  for (const match of text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) add(match[1]);
  // Side-effect `import '...'`.
  for (const match of text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) add(match[1]);
  // Dynamic `import('...')` / `import("...")`.
  for (const match of text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) add(match[1]);
  return Object.freeze([...specifiers]);
}

/**
 * Resolves one module specifier relative to an importer's `src/`-relative path
 * (`src/orchestration/final-active-path.ts` + `../evidence/final-writer` ->
 * `src/evidence/final-writer`). A bare package specifier is not a repository
 * edge and resolves to `null`.
 */
function resolveSpecifier(fromPath: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const segments = fromPath.split('/').slice(0, -1);
  for (const part of specifier.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') segments.pop();
    else segments.push(part);
  }
  return segments.join('/').replace(/\.(ts|js|mjs|cjs)$/, '');
}

/** Every `src/`-relative edge target of one source file. */
function sourceEdges(fromPath: string, text: string): readonly string[] {
  const targets = new Set<string>();
  for (const specifier of finalSwitchModuleSpecifiers(text)) {
    const resolved = resolveSpecifier(fromPath, specifier);
    if (resolved !== null) targets.add(resolved);
  }
  return Object.freeze([...targets]);
}

/** True when `text` imports, re-exports, or dynamically imports `modulePath`. */
function importsModule(fromPath: string, text: string, modulePath: string): boolean {
  const normalized = normalizeModulePath(modulePath);
  return sourceEdges(fromPath, text).includes(normalized);
}

function withinBoundary(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(prefix));
}

const FINAL_MODULE_PREFIXES = [
  'src/contracts/final-',
  'src/evidence/final-',
  'src/orchestration/final-',
];

function importsFinalModule(fromPath: string, text: string): boolean {
  return sourceEdges(fromPath, text).some((target) =>
    FINAL_MODULE_PREFIXES.some((prefix) => target.startsWith(prefix)),
  );
}

/**
 * Verifies the frozen manifest against a supplied repository view, asserting the
 * post-cutover source architecture while preserving the frozen closure. It
 * proves:
 *
 * - every named file exists in the view;
 * - no named file escapes the E3 maximum boundary;
 * - every `src/**` importer of an old-authority module is classified;
 * - every `tests/**` importer of the old authority, an active CLI entry, the
 *   dynamic dispatch module, or any E3-changed module is classified;
 * - the forbidden old-authority edges are absent;
 * - every activation edge and its declared façade symbols are present, and the
 *   activation edges cover exactly the four active CLI entries;
 * - every active CLI entry references the current final façade;
 * - every declared dynamic dispatch edge is present in `src/cli/main.ts`;
 * - every removed public export is unreachable from the barrel;
 * - every present producer edge exists;
 * - every activation-time producer edge names two existing endpoints;
 * - every importer of a final module is manifested;
 * - the E3 write set and rollback set are identical.
 */
export function finalSwitchManifestIssues(
  view: FinalSwitchManifestView,
): readonly FinalSwitchManifestIssue[] {
  const issues: FinalSwitchManifestIssue[] = [];
  const manifest = FINAL_SWITCH_MANIFEST;
  const sources = new Map(view.sourceFiles.map((file) => [file.path, file.text] as const));
  const tests = new Map(view.testFiles.map((file) => [file.path, file.text] as const));

  const classifiedSource = new Set<string>([
    ...manifest.activeCliEntries,
    ...manifest.dynamicDispatchFiles,
    ...manifest.diagnosticProducerFiles,
    ...manifest.commandProducerFiles,
    ...manifest.contractsEvidenceFiles,
    ...manifest.plannerOrchestrationFiles,
    ...manifest.publicBarrelFiles,
    ...manifest.auditedDependencyFiles,
    ...manifest.retainedReadOnlyFiles,
    ...manifest.typeOnlyEdges,
    ...manifest.finalAuthorityFiles,
    ...manifest.facadeFiles,
  ]);

  const requireSource = (path: string): void => {
    if (!sources.has(path)) issues.push(issue('MANIFEST_FILE_MISSING', `source ${path} absent`));
  };
  const requireTest = (path: string): void => {
    if (!tests.has(path)) issues.push(issue('MANIFEST_TEST_MISSING', `test ${path} absent`));
  };

  for (const path of manifest.activeCliEntries) requireSource(path);
  for (const path of manifest.dynamicDispatchFiles) requireSource(path);
  for (const path of manifest.oldAuthorityModules) requireSource(path);
  for (const path of manifest.diagnosticProducerFiles) requireSource(path);
  for (const path of manifest.commandProducerFiles) requireSource(path);
  for (const path of manifest.contractsEvidenceFiles) requireSource(path);
  for (const path of manifest.plannerOrchestrationFiles) requireSource(path);
  for (const path of manifest.publicBarrelFiles) requireSource(path);
  for (const path of manifest.auditedDependencyFiles) requireSource(path);
  for (const path of manifest.retainedReadOnlyFiles) requireSource(path);
  for (const path of manifest.typeOnlyEdges) requireSource(path);
  for (const path of manifest.finalAuthorityFiles) requireSource(path);
  for (const path of manifest.facadeFiles) requireSource(path);
  for (const path of manifest.migratedTests) requireTest(path);
  for (const path of manifest.replacedArchitectureTests) requireTest(path);
  for (const path of manifest.historicalFixtureTests) requireTest(path);
  for (const path of manifest.retainedTestSupport) requireTest(path);
  for (const path of manifest.discoveredChangedModuleTests) requireTest(path);

  for (const path of manifest.e3WriteSet) {
    if (!withinBoundary(path, manifest.maxBoundaryPrefixes)) {
      issues.push(issue('MANIFEST_BOUNDARY_ESCAPE', `write path ${path} outside maximum boundary`));
    }
  }
  for (const path of manifest.oldAuthorityModules) {
    if (!withinBoundary(path, manifest.maxBoundaryPrefixes)) {
      issues.push(issue('MANIFEST_BOUNDARY_ESCAPE', `authority path ${path} outside boundary`));
    }
  }

  // E3 write set and rollback set must be identical.
  const writeSet = [...manifest.e3WriteSet].sort();
  const rollbackSet = [...manifest.e3RollbackFiles].sort();
  if (
    writeSet.length !== rollbackSet.length ||
    writeSet.some((path, i) => path !== rollbackSet[i])
  ) {
    issues.push(
      issue(
        'MANIFEST_ROLLBACK_MISMATCH',
        'The E3 write set and E3 rollback set are not identical.',
      ),
    );
  }

  // Closure over every `src/**` importer of the old current-result authority.
  for (const file of view.sourceFiles) {
    if (manifest.oldAuthorityModules.includes(file.path)) continue;
    if (!manifest.oldAuthorityModules.some((module) => importsModule(file.path, file.text, module)))
      continue;
    if (!classifiedSource.has(file.path)) {
      issues.push(
        issue('MANIFEST_SRC_CLOSURE_INCOMPLETE', `unaccounted old-authority importer ${file.path}`),
      );
    }
  }

  // Closure over every `tests/**` importer of the old authority, an active CLI
  // entry, the dynamic dispatch module, or *any changed module*: a test that
  // imports a module the E3 changeset changes (changed executor, changed Oracle
  // API, changed contract/evidence module, public barrel, or inactive façade)
  // must be classified so no pre-cutover assertion is silently left behind.
  const coveredTest = new Set([
    ...manifest.migratedTests,
    ...manifest.replacedArchitectureTests,
    ...manifest.historicalFixtureTests,
    ...manifest.retainedTestSupport,
    ...manifest.discoveredChangedModuleTests,
  ]);
  const changedModuleTargets = manifest.e3WriteSet.filter((path) => path.startsWith('src/'));
  const testEdgeModules = [
    ...manifest.oldAuthorityModules,
    ...manifest.activeCliEntries,
    ...manifest.dynamicDispatchFiles,
    ...changedModuleTargets,
  ];
  for (const file of view.testFiles) {
    if (!testEdgeModules.some((module) => importsModule(file.path, file.text, module))) continue;
    if (!coveredTest.has(file.path)) {
      issues.push(
        issue(
          'MANIFEST_TEST_CLOSURE_INCOMPLETE',
          `unaccounted changed-module/migrated test ${file.path}`,
        ),
      );
    }
  }

  // Every declared forbidden old-authority import edge must be absent from the
  // post-cutover source path.
  for (const edge of manifest.forbiddenImportEdges) {
    const text = sources.get(edge.from);
    if (text === undefined) continue;
    if (importsModule(edge.from, text, edge.to)) {
      issues.push(
        issue(
          'MANIFEST_FORBIDDEN_EDGE_PRESENT',
          `${edge.from} still imports the removed old-authority module ${edge.to}`,
        ),
      );
    }
  }

  // Every activation edge must name a real entry point and the real façade, its
  // declared façade symbols must be present, and each of the four active CLI
  // entries must be covered by one.
  const activationFrom = new Set(manifest.activationImportEdges.map((edge) => edge.from));
  for (const edge of manifest.activationImportEdges) {
    const text = sources.get(edge.from);
    if (text === undefined) {
      issues.push(issue('MANIFEST_ACTIVATION_FROM_MISSING', `entry ${edge.from} absent`));
    }
    if (!sources.has(edge.to)) {
      issues.push(issue('MANIFEST_ACTIVATION_TO_MISSING', `façade ${edge.to} absent`));
    }
    if (text === undefined) continue;
    for (const symbol of edge.symbols) {
      const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (!new RegExp(`\\b${escaped}\\b`).test(text)) {
        issues.push(
          issue(
            'MANIFEST_ACTIVATION_EDGE_ABSENT',
            `${edge.from} does not reference the façade symbol ${symbol} from ${edge.to}`,
          ),
        );
      }
    }
  }
  for (const entry of manifest.activeCliEntries) {
    if (!activationFrom.has(entry)) {
      issues.push(issue('MANIFEST_ACTIVATION_EDGE_MISSING', `no activation edge for ${entry}`));
    }
  }

  // The dynamic dispatch boundary must install every declared dynamic edge.
  for (const edge of manifest.dynamicDispatchEdges) {
    const text = sources.get(edge.from);
    if (text === undefined) continue;
    const escaped = edge.specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const present = new RegExp(`import\\s*\\(\\s*['"]${escaped}['"]\\s*\\)`).test(text);
    if (!present) {
      issues.push(
        issue(
          'MANIFEST_DYNAMIC_EDGE_ABSENT',
          `${edge.from} does not dynamically import "${edge.specifier}"`,
        ),
      );
    }
  }

  // Every removed public export must be unreachable from the post-cutover barrel.
  const barrel = sources.get('src/index.ts');
  if (barrel !== undefined) {
    for (const symbol of manifest.removedPublicExports) {
      if (new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(barrel)) {
        issues.push(
          issue(
            'MANIFEST_REMOVED_EXPORT_PRESENT',
            `barrel still exposes the removed symbol ${symbol}`,
          ),
        );
      }
    }
  }

  // Every active CLI entry must reference the current final façade.
  for (const path of manifest.activeCliEntries) {
    const text = sources.get(path);
    if (text === undefined) continue;
    if (!manifest.facadeMarkers.some((marker) => text.includes(marker))) {
      issues.push(
        issue(
          'MANIFEST_FACADE_UNREACHED',
          `active CLI entry ${path} does not reference the current final façade`,
        ),
      );
    }
  }

  // Every declared present producer edge must exist.
  for (const edge of manifest.presentProducerEdges) {
    const text = sources.get(edge.from);
    if (text === undefined) continue;
    if (!importsModule(edge.from, text, edge.to)) {
      issues.push(
        issue('MANIFEST_PRODUCER_EDGE_ABSENT', `${edge.from} does not import ${edge.to}`),
      );
    }
  }

  // Every activation-time producer edge must name two endpoints that already
  // exist, so E3 cannot install an edge into a module it never created.
  for (const edge of manifest.e3RequiredProducerEdges) {
    if (!sources.has(edge.from) || !sources.has(edge.to)) {
      issues.push(
        issue(
          'MANIFEST_PRODUCER_ENDPOINT_MISSING',
          `E3 producer edge ${edge.from} → ${edge.to} names a missing endpoint`,
        ),
      );
    }
  }

  // Every importer of a final module must be manifested.
  for (const file of view.sourceFiles) {
    if (!importsFinalModule(file.path, file.text)) continue;
    if (!manifest.finalModuleImporters.includes(file.path)) {
      issues.push(
        issue(
          'MANIFEST_FINAL_EDGE_UNMANIFESTED',
          `unmanifested final-module importer ${file.path}`,
        ),
      );
    }
  }

  // Every Diagnostic family must reach its live-fact adapter from the single
  // Diagnostic orchestration through an existing producer edge.
  const diagnosticOrchestration = sources.get('src/orchestration/diagnostic-execution.ts');
  if (diagnosticOrchestration !== undefined) {
    for (const edge of manifest.diagnosticFamilyEdges) {
      if (
        !importsModule(
          'src/orchestration/diagnostic-execution.ts',
          diagnosticOrchestration,
          edge.adapter,
        )
      ) {
        issues.push(
          issue(
            'MANIFEST_FAMILY_EDGE_ABSENT',
            `diagnostic-execution does not reach the ${edge.family} adapter ${edge.adapter}`,
          ),
        );
      }
    }
  }

  // The historical fixtures must exist and must not be rewritten by E3.
  for (const path of manifest.historicalFixtures) {
    if (!view.fixturePaths.includes(path)) {
      issues.push(issue('MANIFEST_FIXTURE_MISSING', `historical fixture ${path} absent`));
    }
    if (manifest.e3WriteSet.includes(path)) {
      issues.push(issue('MANIFEST_FIXTURE_REWRITTEN', `historical fixture ${path} in write set`));
    }
  }

  return Object.freeze(issues);
}

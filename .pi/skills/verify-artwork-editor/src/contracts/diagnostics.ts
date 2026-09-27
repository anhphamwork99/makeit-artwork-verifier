import type { FindingSeverity } from './discriminants';

/**
 * Closed diagnostic vocabulary.
 *
 * Severity is owned by this table, never by the caller that raises a finding.
 * That keeps the non-weakening rule enforceable: an ambiguous, stale,
 * duplicate, malformed, incompatible, or unresolved contract cannot be
 * downgraded to a warning by the code that detects it, and a coverage omission
 * cannot be escalated into a blocking registry failure.
 */
export const DIAGNOSTIC_SEVERITY = {
  // Coverage omissions: structured warnings that never block an otherwise valid
  // run (decision 0002).
  SUBJECT_REGISTRATION_MISSING: 'warning',
  SUBJECT_VARIANT_UNKNOWN: 'warning',
  // Known product-state discrepancy: authoritative `layoutItems` differ from the
  // flattened `nodes/rootIds` mirror. Specification 17 requires it to stay
  // reported and unrepaired. A product-state fact is never a blocking harness
  // contract failure, so this is a warning that cannot block an otherwise valid
  // run.
  ARTWORK_SCENEGRAPH_MIRROR_STALE: 'warning',
  // Internally invalid harness contracts.
  ADAPTER_CATALOGUE_DUPLICATE: 'blocking',
  CATALOGUE_INVALID: 'blocking',
  CATALOGUE_UNAVAILABLE: 'blocking',
  CAPABILITY_UNSUPPORTED: 'blocking',
  MALFORMED_CASE_INTENT: 'blocking',
  MALFORMED_CASE_REQUEST: 'blocking',
  OPERATION_CAPABILITY_MISMATCH: 'blocking',
  REGISTRY_HARNESS_BLOCKED: 'blocking',
  SUBJECT_ADAPTER_INCOMPATIBLE: 'blocking',
  SUBJECT_ADAPTER_UNKNOWN: 'blocking',
  SUBJECT_BINDING_INVALID: 'blocking',
  SUBJECT_DUPLICATE: 'blocking',
  SUBJECT_FAMILY_UNKNOWN: 'blocking',
  SUBJECT_REGISTRATION_AMBIGUOUS: 'blocking',
  SUBJECT_RELATIONSHIP_UNKNOWN: 'blocking',
  SUBJECT_SOURCE_MALFORMED: 'blocking',
  SUBJECT_SOURCE_STALE: 'blocking',
  SUBJECT_UNRESOLVED: 'blocking',
  SUBJECT_VARIANT_UNSUPPORTED: 'blocking',
  SUBJECT_WORKFLOW_CAPABILITY_MISMATCH: 'blocking',
  SUBJECT_WORKFLOW_UNKNOWN: 'blocking',
  UNKNOWN_OPERATION_DISCRIMINANT: 'blocking',
  WORKFLOW_CATALOGUE_DUPLICATE: 'blocking',
  WORKFLOW_UNKNOWN_CAPABILITY: 'blocking',
  // Coverage Model contract (decision 0004, specification 7). A missing model
  // is a coverage omission warning; every malformed, contradictory, or
  // unsatisfiable coverage declaration is blocking and fails before launch.
  CAPABILITY_BINDING_NO_CHECKS: 'blocking',
  COVERAGE_BASELINE_INVALID: 'blocking',
  COVERAGE_CATALOGUE_DUPLICATE: 'blocking',
  COVERAGE_CATALOGUE_INVALID: 'blocking',
  COVERAGE_COMBINATION_UNSUPPORTED: 'blocking',
  COVERAGE_CONSTRAINT_CONTRADICTORY: 'blocking',
  COVERAGE_CONSTRAINT_VIOLATED: 'blocking',
  COVERAGE_MODEL_INVALID: 'blocking',
  COVERAGE_MODEL_MISSING: 'warning',
  COVERAGE_OBLIGATION_UNSATISFIABLE: 'blocking',
  COVERAGE_PARTITION_INVALID: 'blocking',
  COVERAGE_REFERENCE_UNKNOWN: 'blocking',
  COVERAGE_RESIDUAL_POLICY_INVALID: 'blocking',
  COVERAGE_SCENARIO_INCOMPLETE: 'blocking',
  COVERAGE_SCENARIO_INELIGIBLE: 'blocking',
  COVERAGE_SCENARIO_UNKNOWN: 'blocking',
  COVERAGE_SELECTION_INCOMPLETE: 'warning',
  COVERAGE_UNIVERSE_UNBOUNDED: 'blocking',
  COVERAGE_UNQUALIFIED_COMPLETENESS: 'blocking',
  COVERAGE_VALUE_INVALID: 'blocking',
  // WP5 Slice 5-A tracer contract (specification 6, 9.1, 11). Every code below
  // is a blocking harness-contract failure, never a product `BUG`: a target the
  // adapter cannot resolve exactly once, an undelivered adapter/workflow step,
  // a missing hit point, a torn coherent capture, a readiness deadline, or a
  // source-agreement failure all mean the harness could not establish
  // trustworthy authority. A product non-convergence after valid authority is a
  // `BUG` outcome instead; the two are never converted into one another.
  ADAPTER_IMPLEMENTATION_UNAVAILABLE: 'blocking',
  HIT_POINT_UNAVAILABLE: 'blocking',
  OBSERVATION_TORN: 'blocking',
  ORACLE_SOURCE_DISAGREEMENT: 'blocking',
  READINESS_DEADLINE_EXCEEDED: 'blocking',
  SEAL_NOT_CONFIRMED: 'blocking',
  TARGET_AMBIGUOUS: 'blocking',
  TARGET_NOT_MOUNTED: 'blocking',
  TARGET_UNRESOLVED: 'blocking',
  UNUSABLE_EVIDENCE: 'blocking',
  WORKFLOW_STEP_UNKNOWN: 'blocking',
  WORKFLOW_STEPS_UNAVAILABLE: 'blocking',
  // Runtime ownership, Doctor, cleanup, CLI, and environment cell contracts
  // (specification 9.3, 10; Gate D). Ownership and instance-integrity failures
  // are blocking; a deliberately deferred command is a structured warning.
  BRIDGE_UNAVAILABLE: 'blocking',
  BRIDGE_VERSION_MISMATCH: 'blocking',
  // Bridge v4 distinct surface/precondition failures (WP5 Slice 5-B R14/R15):
  // Doctor must report the precise failed check instead of collapsing every
  // surface failure into a version mismatch.
  BRIDGE_SURFACE_MISMATCH: 'blocking',
  BRIDGE_NOT_FROZEN: 'blocking',
  BRIDGE_CURSOR_INVALID: 'blocking',
  BRIDGE_WAITER_UNBOUNDED: 'blocking',
  BRIDGE_MUTATION_DETECTED: 'blocking',
  BROWSER_CLEANUP_FAILED: 'blocking',
  // ADR 0118 prerequisite boundary. The required browser could not be launched
  // in this environment (typically a Playwright browser revision that was never
  // downloaded). It is an environment prerequisite failure — the harness could
  // not establish trustworthy authority — never a product `BUG`. The public
  // detail is derived only from safe facts, never the raw machine-local path.
  BROWSER_UNAVAILABLE: 'blocking',
  CLEANUP_INCOMPLETE: 'blocking',
  CLEANUP_IO_FAILED: 'blocking',
  CLEANUP_OWNERSHIP_AMBIGUOUS: 'blocking',
  // ADR 0011 R9/R12: durable evidence could not be redacted or written safely.
  // A redaction rejection is a harness-contract failure that forces
  // `HARNESS_BLOCKED`; it never claims PASS and never authorizes cleanup to be
  // skipped, weakened, or broadened.
  EVIDENCE_REDACTION_REJECTED: 'blocking',
  EVIDENCE_RECORD_WRITE_FAILED: 'blocking',
  CLI_NOT_IMPLEMENTED: 'warning',
  CLI_USAGE_INVALID: 'blocking',
  FIXTURE_UNAVAILABLE: 'blocking',
  // WP5 Slice 5-B typed geometry contract. Every code below is a blocking
  // harness-contract failure, never a product `BUG`: a malformed projection,
  // an unsupported representation, a target/Layout identity disagreement, or a
  // non-finite/non-invertible transform means the harness could not establish
  // trustworthy typed authority. A coherent canonical/renderer disagreement
  // after trustworthy execution remains a product `BUG` instead.
  GEOMETRY_LAYOUT_ID_MISMATCH: 'blocking',
  GEOMETRY_REPRESENTATION_UNSUPPORTED: 'blocking',
  GEOMETRY_TARGET_ID_MISMATCH: 'blocking',
  GEOMETRY_TRANSFORM_INVALID: 'blocking',
  // WP5 Slice 5-D nested-object affine chain (ADR 0013 R4–R11). A malformed,
  // mismatched, or irreconcilable chain/camera/ancestry fact means the harness
  // could not establish trustworthy typed authority, so it is blocking and
  // never silently repaired. The two composed-invariant explanations are
  // product-defect facts after a valid capture, so they are warnings.
  GEOMETRY_CHAIN_INVALID: 'blocking',
  GEOMETRY_CHAIN_ID_MISMATCH: 'blocking',
  GEOMETRY_PARENT_MISMATCH: 'blocking',
  GEOMETRY_CAMERA_MISMATCH: 'blocking',
  GEOMETRY_LOCAL_INVARIANT_FAILED: 'warning',
  GEOMETRY_WORLD_COMPOSITION_FAILED: 'warning',
  // WP5 Slice 5-D purpose-scoped interaction authority (ADR 0014 R6/R8/R9).
  // `POST_ACTION_HIT_OBSTRUCTED` is diagnostic-only: a completed action's
  // deterministic observation probe truthfully resolved to selection chrome,
  // transform chrome, a foreign listening node, or no hit. It never blocks and
  // never changes an outcome by itself. `TARGET_QUAD_INTERACTION_POINT_INVALID`
  // is blocking geometry authority: no finite, inset candidate could be derived
  // from the live convex target quad. `PRODUCT_SELECTION_NOT_RETAINED` is an
  // authoritative product mismatch after a safe dispatch (`BUG`), so it is a
  // warning record and never a harness failure.
  POST_ACTION_HIT_OBSTRUCTED: 'warning',
  TARGET_QUAD_INTERACTION_POINT_INVALID: 'blocking',
  PRODUCT_SELECTION_NOT_RETAINED: 'warning',
  // WP5 Slice 5-C resource ownership, native file-input, and raster authority.
  // Every code below is a blocking harness-contract failure, never a product
  // `BUG`: an invalid/undeclared/mismatched resource, an ambiguous public
  // control or file input, or malformed/tainted/ambiguous raster authority
  // means the harness could not establish trustworthy authority. A trustworthy
  // product mismatch after a safe native action remains a `BUG` instead.
  RESOURCE_MANIFEST_INVALID: 'blocking',
  RESOURCE_UNDECLARED: 'blocking',
  RESOURCE_BYTES_MISMATCH: 'blocking',
  RESOURCE_REQUEST_DENIED: 'blocking',
  RESOURCE_REQUEST_INCOMPLETE: 'blocking',
  PUBLIC_CONTROL_UNAVAILABLE: 'blocking',
  PUBLIC_CONTROL_AMBIGUOUS: 'blocking',
  FILE_INPUT_UNAVAILABLE: 'blocking',
  FILE_INPUT_ACCEPT_MISMATCH: 'blocking',
  RASTER_SCHEMA_UNSUPPORTED: 'blocking',
  RASTER_SOURCE_UNREADABLE: 'blocking',
  RASTER_CANVAS_TAINTED: 'blocking',
  RASTER_TARGET_ID_MISMATCH: 'blocking',
  RASTER_OBSERVATION_TORN: 'blocking',
  RASTER_AUTHORITY_UNUSABLE: 'blocking',
  RASTER_NODE_AMBIGUOUS: 'blocking',
  // WP5 Slice 5-E generated-Crossword determinism contract (ADR 0017 R4–R8).
  // A malformed observation, an unknown or missing/duplicated child role, a
  // failed source fingerprint, a currentness/ordering failure, or accepted
  // source drift means the harness could not establish trustworthy authority,
  // so it is blocking. The product-determinism facts are warnings: a same-seed
  // digest mismatch, a different-seed digest collision, a materialized seed
  // that is not the exact expected epoch, or generated-vector raster authority
  // that does not satisfy the accepted exact-target check is a real product
  // non-convergence (`BUG`) after valid, current, interpretable evidence.
  // Severity answers "is the harness authority unusable?", never "did the run
  // pass?", so none of these reclassifies an accepted product mismatch as
  // `HARNESS_BLOCKED`; missing/malformed/stale/uninterpretable authority keeps
  // its own blocking code.
  CROSSWORD_CLOCK_PROFILE_INVALID: 'blocking',
  CROSSWORD_CURRENTNESS_INVALID: 'blocking',
  CROSSWORD_OBSERVATION_DUPLICATE: 'blocking',
  CROSSWORD_OBSERVATION_MALFORMED: 'blocking',
  CROSSWORD_OBSERVATION_MISSING: 'blocking',
  CROSSWORD_OBSERVATION_ROLE_UNKNOWN: 'blocking',
  CROSSWORD_SEMANTIC_MALFORMED: 'blocking',
  CROSSWORD_SOURCE_DRIFT: 'blocking',
  CROSSWORD_SOURCE_FINGERPRINT_INVALID: 'blocking',
  PRODUCT_CROSSWORD_RASTER_INVALID: 'warning',
  PRODUCT_CROSSWORD_REPEAT_MISMATCH: 'warning',
  PRODUCT_CROSSWORD_SEED_INSENSITIVE: 'warning',
  PRODUCT_CROSSWORD_SEED_MISMATCH: 'warning',
  PRODUCT_CROSSWORD_WORDS_INVALID: 'warning',
  // The generated-Crossword binding is fully planned and launchable in this
  // phase, but its runtime orchestration is deliberately deferred. The
  // pre-launch gate records this as a non-fatal deferral, never a harness
  // failure and never a `PASS`.
  EXECUTION_NOT_YET_SUPPORTED: 'warning',
  // WP5 Slice 5-A product-transition fact. A valid native action against
  // authoritative state that produces no required causal transition by the
  // deadline is a product non-convergence (`BUG`), not a harness-contract
  // failure, so this explanatory record is a warning and never blocks.
  PRODUCT_TRANSITION_NOT_OBSERVED: 'warning',
  DIST_DIR_ENV_INVALID: 'blocking',
  DOCTOR_INSTANCE_MISMATCH: 'blocking',
  // The optional adapter-owned evidence root (`MAKEIT_ARTWORK_EVIDENCE_ROOT`)
  // is set to a value that is not a usable absolute, normalized, symlink-free
  // existing directory. It refuses before any evidence is read or written; it
  // is never a product `BUG` and never an `ENVIRONMENT_FAILURE`.
  EVIDENCE_ROOT_ENV_INVALID: 'blocking',
  ENVIRONMENT_CATALOGUE_INVALID: 'blocking',
  ENVIRONMENT_CELL_MISMATCH: 'blocking',
  ENVIRONMENT_CELL_UNKNOWN: 'blocking',
  PLAN_NOT_LAUNCHABLE: 'warning',
  // Production seam absence (specification 16 Gate C; TS-3). A reachable
  // observation/setup marker in emitted production output or in a live
  // production document is an internally invalid harness contract, never a
  // product `BUG` and never an `ENVIRONMENT_FAILURE`.
  PRODUCTION_ABSENCE_VIOLATION: 'blocking',
  RUN_ID_INVALID: 'blocking',
  RUN_OWNERSHIP_RECORD_INVALID: 'blocking',
  RUN_OWNERSHIP_UNKNOWN: 'blocking',
  RUN_RESOURCE_COLLISION: 'blocking',
  RUNTIME_LAUNCH_FAILED: 'blocking',
  RUNTIME_READINESS_FAILED: 'blocking',
  RUNTIME_TERMINATED_BY_SIGNAL: 'blocking',
  // Gated one-shot setup boundary (specification 9.1; TS-3, Gate C). A refused
  // setup attempt is a harness contract failure — `HARNESS_BLOCKED` — never a
  // product `BUG` and never an `ENVIRONMENT_FAILURE`. Setup facts also never
  // count as Capability or Coverage Obligation evidence.
  SETUP_ALREADY_SEALED: 'blocking',
  SETUP_AUTHORIZATION_INVALID: 'blocking',
  SETUP_AUTHORIZATION_MISSING: 'blocking',
  SETUP_CONSTRUCTOR_UNKNOWN: 'blocking',
  SETUP_CONSTRUCTOR_VERSION_MISMATCH: 'blocking',
  FIXTURE_NOT_NORMALIZED: 'blocking',
  SETUP_GATE_DISABLED: 'blocking',
  SETUP_HYDRATE_REJECTED: 'blocking',
  SETUP_INPUT_INVALID: 'blocking',
  SETUP_REQUEST_INVALID: 'blocking',
  SETUP_ROUTE_INVALID: 'blocking',
  SETUP_SCOPE_MISMATCH: 'blocking',
  SAME_RUN_CASE_ACTIVE: 'blocking',
  // ADR 0020 guarded selection clearing before Crossword creation (WP5 Slice
  // 5-F). Every condition below is a setup/precondition harness failure and is
  // `HARNESS_BLOCKED`; none is a product `BUG` and none carries history,
  // Capability, create, coverage, or Gate E credit.
  SETUP_TUTORIAL_CONTROL_UNAVAILABLE: 'blocking',
  SETUP_ONBOARDING_CONTROL_AMBIGUOUS: 'blocking',
  SETUP_IMAGE_ONBOARDING_ORDER_UNEXPECTED: 'blocking',
  SETUP_HISTORY_SHAPE_UNEXPECTED: 'blocking',
  SETUP_SELECTION_CLEAR_PRECONDITION_UNEXPECTED: 'blocking',
  SETUP_MORE_AMBIGUITY_UNEXPECTED: 'blocking',
  SETUP_ESCAPE_OWNER_UNSAFE: 'blocking',
  SETUP_SELECTION_CLEAR_FAILED: 'blocking',
  SETUP_SELECTION_CLEAR_MEANING_CHANGED: 'blocking',
  SETUP_SELECTION_CLEAR_HISTORY_CHANGED: 'blocking',
  SETUP_MORE_CONTROL_NOT_UNIQUE: 'blocking',
  // ADR 0019 Slice 5-F history/normalized-restore/suite contract. A missing,
  // ambiguous, inaccessible, or disabled required control blocks before
  // dispatch; a malformed/uninterpretable normalization or an ambiguous
  // restore authority blocks before a product claim. A safely dispatched
  // transition with wrong depth/meaning is a product `BUG` and therefore a
  // warning explanation, never a blocking harness failure.
  HISTORY_CONTROL_UNAVAILABLE: 'blocking',
  HISTORY_CONTROL_DISABLED: 'blocking',
  HISTORY_TRANSITION_MISSING: 'warning',
  HISTORY_DEPTH_MISMATCH: 'warning',
  HISTORY_MEANING_MISMATCH: 'warning',
  NORMALIZED_MEANING_SCHEMA_UNSUPPORTED: 'blocking',
  NORMALIZED_MEANING_UNUSABLE: 'blocking',
  RESTORE_ROUTE_CONTRACT_INVALID: 'blocking',
  RESTORE_REQUEST_MISSING: 'blocking',
  RESTORE_REQUEST_DUPLICATE: 'blocking',
  RESTORE_RESPONSE_INVALID: 'blocking',
  RESTORE_DOCUMENT_TRANSITION_MISSING: 'blocking',
  RESTORE_MEANING_MISMATCH: 'warning',
  RESTORE_RAW_SEMANTIC_MISMATCH: 'warning',
  DIAGNOSTIC_SUITE_UNKNOWN: 'blocking',
  DIAGNOSTIC_SUITE_INVALID: 'blocking',
  DIAGNOSTIC_SUITE_INCOMPLETE: 'blocking',
  // Package 7 Slice A strict correctness catalogues and compiler (ADR 0023).
  // Every malformed, unknown, duplicate, dangling, ambiguous, weakening, or
  // divergent correctness declaration is a blocking harness-contract failure:
  // the harness could not establish trustworthy correctness authority. It is
  // never a product `BUG` and never `ENVIRONMENT_FAILURE`, because malformed or
  // semantically invalid catalogue content is an authored contract defect.
  CORRECTNESS_CATALOGUE_INVALID: 'blocking',
  CORRECTNESS_CATALOGUE_DUPLICATE: 'blocking',
  CORRECTNESS_CATALOGUE_SCHEMA_UNSUPPORTED: 'blocking',
  CORRECTNESS_REFERENCE_UNRESOLVED: 'blocking',
  CORRECTNESS_REFERENCE_AMBIGUOUS: 'blocking',
  CORRECTNESS_UNKNOWN_DISCRIMINANT: 'blocking',
  CORRECTNESS_NON_WEAKENING_VIOLATION: 'blocking',
  CORRECTNESS_COMPATIBILITY_DIVERGENCE: 'blocking',
  CORRECTNESS_PROFILE_MISSING: 'blocking',
  CORRECTNESS_TOLERANCE_UNITS_MISMATCH: 'blocking',
  CORRECTNESS_CHECK_RESULT_STATUS_UNKNOWN: 'blocking',
  // Package 7 Slice C completeness ledger (gap-plan §5 P7-C). A missing,
  // unreadable, or non-strict accepted representative suite, a compiled-profile
  // gap, or an unpersisted durable ledger blocks the Package-7 gate; none is a
  // product `BUG` or an `ENVIRONMENT_FAILURE`.
  COMPLETENESS_REPRESENTATIVE_DECLARATION_INVALID: 'blocking',
  COMPLETENESS_ACCEPTED_SUITE_ABSENT: 'blocking',
  COMPLETENESS_ACCEPTED_SUITE_UNAVAILABLE: 'blocking',
  COMPLETENESS_ACCEPTED_SUITE_INVALID: 'blocking',
  COMPLETENESS_COMPILED_PROFILE_GAP: 'blocking',
  COMPLETENESS_LEDGER_PERSIST_FAILED: 'blocking',
  // ADR 0118 product-meaning provider preflight. The toolkit loads the narrow
  // FE-owned meaning provider only from the explicit, validated app root before
  // allocation. A missing, unavailable, malformed or incompatible provider is an
  // integration/harness refusal (never a product `BUG` and never
  // `ENVIRONMENT_FAILURE`): no meaning authority was established, so no run and
  // no evidence may be produced.
  PRODUCT_MEANING_PROVIDER_REQUIRED: 'blocking',
  PRODUCT_MEANING_PROVIDER_UNAVAILABLE: 'blocking',
  PRODUCT_MEANING_PROVIDER_INCOMPATIBLE: 'blocking',
} as const satisfies Record<string, FindingSeverity>;

export type DiagnosticCode = keyof typeof DIAGNOSTIC_SEVERITY;

/** Structured record emitted by every validation, reconciliation, and planner stage. */
export interface DiagnosticRecord {
  code: DiagnosticCode;
  severity: FindingSeverity;
  detail: string;
  subjectId: string | null;
  applicationKind: string | null;
  /** Extra bounded, non-secret qualifiers (rule ids, raw variants, versions). */
  context: Readonly<Record<string, string>>;
}

export interface DiagnosticHints {
  subjectId?: string;
  applicationKind?: string;
  context?: Readonly<Record<string, string>>;
}

export function diagnosticSeverity(code: DiagnosticCode): FindingSeverity {
  return DIAGNOSTIC_SEVERITY[code];
}

export function createDiagnostic(
  code: DiagnosticCode,
  detail: string,
  hints: DiagnosticHints = {},
): DiagnosticRecord {
  return {
    code,
    severity: diagnosticSeverity(code),
    detail,
    subjectId: hints.subjectId ?? null,
    applicationKind: hints.applicationKind ?? null,
    context: hints.context ?? {},
  };
}

export function formatDiagnostic(record: DiagnosticRecord): string {
  const location = [
    record.subjectId === null ? null : `subject=${record.subjectId}`,
    record.applicationKind === null ? null : `applicationKind=${record.applicationKind}`,
  ]
    .filter((entry): entry is string => entry !== null)
    .join(' ');

  return `[${record.severity}] ${record.code}${location.length > 0 ? ` (${location})` : ''}: ${record.detail}`;
}

export function blockingCodes(findings: readonly DiagnosticRecord[]): DiagnosticCode[] {
  return findings
    .filter((finding) => finding.severity === 'blocking')
    .map((finding) => finding.code);
}

export function warningCodes(findings: readonly DiagnosticRecord[]): DiagnosticCode[] {
  return findings
    .filter((finding) => finding.severity === 'warning')
    .map((finding) => finding.code);
}

export function hasBlockingDiagnostic(findings: readonly DiagnosticRecord[]): boolean {
  return findings.some((finding) => finding.severity === 'blocking');
}

export function diagnosticsOfCode(
  findings: readonly DiagnosticRecord[],
  code: DiagnosticCode,
): DiagnosticRecord[] {
  return findings.filter((finding) => finding.code === code);
}

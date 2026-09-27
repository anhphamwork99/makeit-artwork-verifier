/**
 * Named, versioned schema families for the production verification contracts.
 *
 * Every correctness-affecting record declares the explicit schema version it was
 * written under, and every identity is derived with a domain and an
 * identity-schema version (decision 0007 N6). Unknown or unsupported versions
 * fail closed before launch instead of being coerced.
 */

/** Version of the four-level identity derivation (`caseId`, materialization, plan). */
export const IDENTITY_SCHEMA_VERSION = 1;

/** Verification-owned Subject catalogue document. */
export const SUBJECT_CATALOGUE_SCHEMA_VERSION = 1;

/** Declared application-kind inventory reconciled against `ARTWORK_LAYER_REGISTRY`. */
export const APPLICATION_INVENTORY_SCHEMA_VERSION = 1;

/** Approved-operation catalogue (closed executable discriminant vocabulary). */
export const APPROVED_OPERATION_CATALOGUE_SCHEMA_VERSION = 1;

/** Authoritative adapter catalogue (executable adapter identity and compatibility). */
export const ADAPTER_CATALOGUE_SCHEMA_VERSION = 1;

/** Authoritative workflow catalogue (executable workflow identity, version, Capability). */
export const WORKFLOW_CATALOGUE_SCHEMA_VERSION = 1;

/**
 * Declarative workflow-step catalogue. Version 4 keeps the v3 executable
 * contracts intact and adds the WP5 Slice 5-F `shared.history` cross-subject
 * six-transition workflow and the closed `shared.serialize` frontend
 * Save/restore workflow (one native `control.activate` over `control:save`
 * plus the closed `frontend.restore.capture` runtime handoff). Step schema stays
 * v2. The v3 catalogue is renamed to v4 atomically (supervisor R1): no mixed
 * v3-catalogue/v4-catalogue or step-v1/step-v2 runnable state exists, and no v3
 * parser silently accepts or ignores the new workflows.
 *
 * The representative Diagnostic suite is declared separately under
 * `cases/diagnostic/suites/representative.v1.json` with its own schema version;
 * declaring it adds no Release, manifest, qualification, or Gate H credit.
 */
export const WORKFLOW_CATALOGUE_V4_SCHEMA_VERSION = 4;
export const WORKFLOW_STEP_SCHEMA_VERSION = 2;

/** Raster evidence schema published by bridge v7 `raster(id)` (closed v3 union). */
export const ARTWORK_VERIFICATION_RASTER_SCHEMA_VERSION = 3;

/** Executable adapter contract implemented by a toolkit `SubjectAdapter`. */
export const ADAPTER_CONTRACT_SCHEMA_VERSION = 1;

/**
 * Fixture catalogue mapping `subjectId × capability × scenarioId` to a fixture.
 *
 * Version 2 adds the closed, explicit `resolution` discriminant to every
 * semantic target role (ADR 0018 CR3). The v2 parser never defaults an omitted
 * `resolution`: a missing or unknown value is `FIXTURE_CATALOGUE_INVALID`. The
 * v1 catalogue is renamed to v2 atomically; no v1/v2 live pair exists.
 */
export const BINDING_FIXTURE_CATALOGUE_SCHEMA_VERSION = 2;

/** Content-addressed verification resource manifest (WP5 Slice 5-C). */
export const RESOURCE_MANIFEST_SCHEMA_VERSION = 1;

/** Signal-first correlated readiness profile (`action-cycle-v1`). */
export const READINESS_PROFILE_SCHEMA_VERSION = 1;

/** Geometry/behaviour Oracle profile (`geometry.delta` minimum profile). */
export const ORACLE_PROFILE_SCHEMA_VERSION = 1;

/**
 * Historical compact diagnostic run record (schema v3).
 *
 * E3-S2 makes the strict v4 public child/command record the sole current run
 * record (`contracts/final-record-v4.ts` `FINAL_CURRENT_CHILD_RECORD_SCHEMA_VERSION`,
 * `contracts/final-public-record.ts` `FINAL_PUBLIC_RECORD_SCHEMA_VERSION`, read
 * through `contracts/final-record-reader.ts`).
 *
 * This constant is retained as the explicit *historical* schema-3 marker. Legacy
 * reader behavior stays explicit and never coerces:
 *
 * - v1 → `legacy-unredacted-v1` (immutable history, never rewritten);
 * - v2 → `accepted-pre-5F-public-projection` (valid prior-slice evidence);
 * - v3 → `legacy-v3` (the former current projection, now read-only history);
 * - the current strict v4 record → `current-v4`;
 * - anything else → fail closed.
 *
 * Private ownership/cleanup schemas and the CLI result envelope are unchanged.
 */
export const DIAGNOSTIC_RUN_RECORD_SCHEMA_VERSION = 3;

/**
 * Representative Diagnostic suite declaration (ADR 0019 R12).
 *
 * Closed authoring data naming an ordered set of stable request copies under
 * `cases/diagnostic/requests/`. A declaration never references `tests/**`, an
 * absolute path, or a per-child allocation override; an unknown schema fails
 * closed before any child launches.
 */
export const DIAGNOSTIC_SUITE_SCHEMA_VERSION = 1;

/**
 * Historical aggregate Diagnostic suite record (schema v1).
 *
 * E3-S2 makes the v4-bound `FinalSuiteRecordV2` (schema version 2, label
 * `suite-v2`) the sole current suite authority. This constant is retained as the
 * explicit *historical* schema-1 marker: `contracts/final-suite-record.ts`
 * discriminates a schema-1 suite record into its labelled, read-only,
 * non-converting legacy branch, which preserves the recorded values exactly and
 * can never satisfy current acceptance.
 */
export const DIAGNOSTIC_SUITE_RESULT_SCHEMA_VERSION = 1;

/** Normalized Case Request produced by the planner's input stage. */
export const CASE_REQUEST_SCHEMA_VERSION = 1;

/** Immutable resolution of a Case Intent against authoritative catalogues. */
export const MATERIALIZED_CASE_SCHEMA_VERSION = 2;

/** Immutable closed phase graph. */
export const EXECUTION_PLAN_SCHEMA_VERSION = 2;

/** Preflight report emitted for every planning attempt. */
export const PREFLIGHT_REPORT_SCHEMA_VERSION = 1;

/** Coverage attribution record emitted for every planning attempt. */
export const COVERAGE_ATTRIBUTION_SCHEMA_VERSION = 1;

/** Evidence requirements manifest emitted for every planning attempt. */
export const EVIDENCE_REQUIREMENTS_SCHEMA_VERSION = 2;

/** Ownership and cleanup manifest emitted for every planning attempt. */
export const OWNERSHIP_CLEANUP_SCHEMA_VERSION = 1;

/** Attempt-specific ownership reservation / execution allocation. */
export const EXECUTION_ALLOCATION_SCHEMA_VERSION = 1;

/** Attempt-specific execution instance record. */
export const EXECUTION_INSTANCE_SCHEMA_VERSION = 1;

/** Coverage Model contract: validated Factors, partitions, scenarios, and obligations. */
export const COVERAGE_MODEL_SCHEMA_VERSION = 1;

/** Deterministic Coverage Selection Manifest contract. */
export const COVERAGE_SELECTION_SCHEMA_VERSION = 1;

/** Initial governed environment cell catalogue (specification 9.3). */
export const ENVIRONMENT_CELL_CATALOGUE_SCHEMA_VERSION = 1;

/** Exclusively owned run resources plus the reserved launch allocation. */
export const RUN_ALLOCATION_SCHEMA_VERSION = 1;

/** Durable, append-only run ownership record used by launch, Doctor, and cleanup. */
export const RUN_OWNERSHIP_RECORD_SCHEMA_VERSION = 2;

/**
 * Versioned multi-file snapshot of shared repository config rewritten by the
 * owned dev server (`tsconfig.json`, `next-env.d.ts`).
 */
export const REPO_CONFIG_SNAPSHOT_SCHEMA_VERSION = 1;

/** Structured cleanup/recovery result. */
export const CLEANUP_RESULT_SCHEMA_VERSION = 1;

/**
 * Read-only Doctor result.
 *
 * Version 7 independently verifies the bridge v7 object in the page realm — the
 * frozen eight-method surface, the document-correlated observation cursor, the
 * bounded waiter, the generic geometry and circle geometry-v2 surfaces where a
 * target is available, a pair-explicit geometry schema v3 request that fails
 * closed without mutation on unresolved ids, and a safe real `raster()` Promise
 * resolving to the raster schema v3 closed union without mutation — and reports
 * each failed check with its own precise code instead of collapsing every
 * surface failure into a version mismatch.
 */
export const DOCTOR_RESULT_SCHEMA_VERSION = 7;

/**
 * Stable `pnpm verify:artwork` structured CLI result envelope.
 *
 * Version 2 widens the terminal status vocabulary with first-class `BUG`
 * (`PASS=0`, `BUG=1`, `HARNESS_BLOCKED/ENVIRONMENT_FAILURE=2`,
 * `NOT_IMPLEMENTED=3`, `USAGE=64`). Consumers that validate schema v1 must fail
 * closed and upgrade; no dual emission is supported.
 */
export const CLI_RESULT_SCHEMA_VERSION = 2;

/** Static plan launchability projection while P5/P7 remain deferred. */
export const LAUNCHABILITY_SCHEMA_VERSION = 1;

/**
 * Package 7 Slice A correctness-contract authoring catalogue (ADR 0023).
 *
 * One named, closed schema family for the strict versioned declarations that
 * replace distributed source constants as the planning/static-validation
 * authority. Every declaration document rejects unknown keys and versions; a
 * differently named schema family is never accepted as an equivalent one.
 */
export const CORRECTNESS_CATALOGUE_SCHEMA_VERSION = 1;

/** Closed `PASS | FAIL | UNUSABLE` required-check result contract (P7-A). */
export const CHECK_RESULT_CONTRACT_SCHEMA_VERSION = 1;

/** Immutable compiled `ResolvedCorrectnessProfile` (P7-A planning authority). */
export const RESOLVED_CORRECTNESS_PROFILE_SCHEMA_VERSION = 1;

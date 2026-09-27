/**
 * Closed discriminant vocabulary (decision 0007 N8/N10).
 *
 * Every executable, policy, and classification discriminant the engine may act
 * on is declared here. Runtime contracts are validated against these lists and
 * unknown values fail closed; a caller can never widen the vocabulary by
 * passing a new string.
 */

export type FindingSeverity = 'blocking' | 'warning';

export const SUBJECT_FAMILIES = ['artwork', 'container', 'layer', 'selection'] as const;
export type SubjectFamily = (typeof SUBJECT_FAMILIES)[number];

export const SUBJECT_ORIGINS = ['application-backed', 'verification-native'] as const;
export type SubjectOrigin = (typeof SUBJECT_ORIGINS)[number];

/** Capability ids name user-observable results, never interaction mechanisms. */
export const CAPABILITIES = [
  'changeContainment',
  'changeProperties',
  'create',
  'editContent',
  'frontendSerializeRestore',
  'history',
  'move',
  'reorder',
  'resize',
  'rotate',
  'select',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const EXECUTION_PROFILES = ['diagnostic', 'release'] as const;
export type ExecutionProfile = (typeof EXECUTION_PROFILES)[number];

export const CASE_PROVENANCES = ['diagnostic-request', 'manifest'] as const;
export type CaseProvenance = (typeof CASE_PROVENANCES)[number];

export const EVIDENCE_DEPTHS = ['deep', 'standard'] as const;
export type EvidenceDepth = (typeof EVIDENCE_DEPTHS)[number];

/** Evidence has exactly two roles and no precedence beyond them. */
export const EVIDENCE_ROLES = ['diagnostic-only', 'required-authoritative'] as const;
export type EvidenceRole = (typeof EVIDENCE_ROLES)[number];

/** Closed phase graph node kinds. */
export const PLAN_PHASES = ['action', 'cleanup', 'evidence', 'precondition', 'setup'] as const;
export type PlanPhaseName = (typeof PLAN_PHASES)[number];

/** Engine-owned operations the compiled graph may contain. */
export const ENGINE_OPERATIONS = ['cleanup.release', 'evidence.finalize'] as const;
export type EngineOperation = (typeof ENGINE_OPERATIONS)[number];

export const PLAN_STATUSES = ['ENVIRONMENT_FAILURE', 'HARNESS_BLOCKED', 'PLANNED'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const ALLOCATION_STATUSES = ['ENVIRONMENT_FAILURE', 'RESERVED'] as const;
export type AllocationStatus = (typeof ALLOCATION_STATUSES)[number];

export const ALLOCATION_FAILURE_REASONS = [
  'APP_ROOT_INVALID',
  'DIST_DIR_INVALID',
  'DIST_DIR_OCCUPIED',
  'ENVIRONMENT_CATALOGUE_INVALID',
  'ENVIRONMENT_CELL_UNKNOWN',
  'EVIDENCE_ROOT_INVALID',
  'EVIDENCE_ROOT_OCCUPIED',
  'OWNERSHIP_RECORD_INVALID',
  'OWNERSHIP_UNKNOWN',
  'PORT_INVALID',
  'PORT_UNAVAILABLE',
  'PROCESS_GROUP_INVALID',
  'PROCESS_GROUP_UNVERIFIABLE',
  'RESOURCE_ALREADY_OWNED',
  'RUN_ID_INVALID',
  'SAME_RUN_CASE_ACTIVE',
  'SCRATCH_ROOT_OCCUPIED',
] as const;
export type AllocationFailureReason = (typeof ALLOCATION_FAILURE_REASONS)[number];

/**
 * Terminal CLI statuses for the stable `pnpm verify:artwork` surface (TS-2).
 *
 * `BUG` is a first-class status distinct from infrastructure/unavailable-evidence
 * (`ENVIRONMENT_FAILURE`/`HARNESS_BLOCKED`), deliberately deferred
 * (`NOT_IMPLEMENTED`), and success (`PASS`).
 */
export const CLI_STATUSES = [
  'BUG',
  'ENVIRONMENT_FAILURE',
  'HARNESS_BLOCKED',
  'NOT_IMPLEMENTED',
  'PASS',
  'USAGE',
] as const;
export type CliStatus = (typeof CLI_STATUSES)[number];

/** Canonical `verify:artwork` commands that this Work Package does not implement. */
export const DEFERRED_CLI_COMMANDS = ['claim', 'evidence'] as const;
export type DeferredCliCommand = (typeof DEFERRED_CLI_COMMANDS)[number];

export function isDeferredCliCommand(value: unknown): value is DeferredCliCommand {
  return isMember(DEFERRED_CLI_COMMANDS, value);
}

/** Resources a run may exclusively own. */
export const OWNERSHIP_KINDS = [
  'app-port',
  'app-process-group',
  'app-server',
  'browser',
  'browser-context',
  'evidence-root',
  'next-dist-dir',
  'route-handler',
  'run-scratch',
] as const;
export type OwnershipKind = (typeof OWNERSHIP_KINDS)[number];

/** Cleanup removes every owned resource except preserved evidence. */
export const PRESERVED_OWNERSHIP_KINDS = [
  'evidence-root',
] as const satisfies readonly OwnershipKind[];

export const CLEANUP_ORDER = [
  'browser-context',
  'browser',
  'route-handler',
  'app-server',
  'app-port',
  'app-process-group',
  'next-dist-dir',
  'run-scratch',
] as const satisfies readonly OwnershipKind[];

export const OWNERSHIP_PROOF_KINDS = ['allocation-ledger-reservation', 'plan-binding'] as const;
export type OwnershipProofKind = (typeof OWNERSHIP_PROOF_KINDS)[number];

export const COVERAGE_STATUSES = ['complete', 'incomplete'] as const;
export type CoverageStatus = (typeof COVERAGE_STATUSES)[number];

export const REGISTRY_STATUSES = ['HARNESS_BLOCKED', 'READY'] as const;
export type RegistryStatus = (typeof REGISTRY_STATUSES)[number];

/** Completeness must always be qualified by the dimension it describes. */
export const COMPLETENESS_DIMENSIONS = [
  'binding-execution',
  'binding-model',
  'project-scope',
  'registry-coverage',
  'selected-suite',
] as const;
export type CompletenessDimension = (typeof COMPLETENESS_DIMENSIONS)[number];

export const COMPLETENESS_STATUSES = ['complete', 'deferred', 'incomplete'] as const;
export type CompletenessStatus = (typeof COMPLETENESS_STATUSES)[number];

/** Exactly four terminal outcomes; there is no fifth. */
export const OUTCOMES = ['PASS', 'BUG', 'HARNESS_BLOCKED', 'ENVIRONMENT_FAILURE'] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const NON_PASS_MEANINGS = ['product-defect', 'unavailable-evidence'] as const;
export type NonPassMeaning = (typeof NON_PASS_MEANINGS)[number];

function isMember<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

export function isSubjectFamily(value: unknown): value is SubjectFamily {
  return isMember(SUBJECT_FAMILIES, value);
}

export function isSubjectOrigin(value: unknown): value is SubjectOrigin {
  return isMember(SUBJECT_ORIGINS, value);
}

export function isCapability(value: unknown): value is Capability {
  return isMember(CAPABILITIES, value);
}

export function isExecutionProfile(value: unknown): value is ExecutionProfile {
  return isMember(EXECUTION_PROFILES, value);
}

export function isCaseProvenance(value: unknown): value is CaseProvenance {
  return isMember(CASE_PROVENANCES, value);
}

export function isEvidenceDepth(value: unknown): value is EvidenceDepth {
  return isMember(EVIDENCE_DEPTHS, value);
}

export function isEvidenceRole(value: unknown): value is EvidenceRole {
  return isMember(EVIDENCE_ROLES, value);
}

export function isOutcome(value: unknown): value is Outcome {
  return isMember(OUTCOMES, value);
}

export function isOwnershipKind(value: unknown): value is OwnershipKind {
  return isMember(OWNERSHIP_KINDS, value);
}

/**
 * Immutable, lowercase, slash-namespaced Subject identity (decision 0002).
 * The pattern is shared by catalogue parsing and case normalization so the two
 * can never disagree about what a valid identity is.
 */
export const SUBJECT_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)+$/;

export function isSubjectId(value: unknown): value is string {
  return typeof value === 'string' && SUBJECT_ID_PATTERN.test(value);
}

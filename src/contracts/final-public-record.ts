import type {
  PublicCleanupProjection,
  PublicLaunchFacts,
  PublicOwnershipProjection,
  RunRecordFingerprints,
  RunRecordReadiness,
} from '../evidence/public-dto';
import {
  COMMAND_CHECK_CONTEXTS,
  type CommandCheckContext,
  type CommandStatusAuthority,
} from './command-check';
import type { DiagnosticRecord } from './diagnostics';
import {
  CASE_PROVENANCES,
  EVIDENCE_DEPTHS,
  OUTCOMES,
  type CaseProvenance,
  type EvidenceDepth,
  type Outcome,
} from './discriminants';
import {
  FINAL_CHILD_RECORD_KEYS,
  FINAL_COMMAND_RECORD_KEYS,
  FINAL_CURRENT_CHILD_RECORD_SCHEMA_VERSION,
  finalRecordLegacyAuthorityIssues,
  isolateFinalRecordValue,
  isFinalCommandRecordShape,
  validateFinalChildRecordV4,
  validateFinalCommandRecordV4,
  type CommandCheckResultView,
  type FinalCommandCheckRecordV4,
  type FinalCurrentChildRecordV4,
  type FinalRecordIssue,
} from './final-record-v4';
import {
  readFinalRecord,
  type FinalLegacyRecordView,
  type FinalRejectedRecordView,
} from './final-record-reader';
import { CURRENT_RESULT_LABEL } from './final-result-dto';
import { WAKE_SOURCES } from './observation';
import { isPlainRecord } from './result-agreement';

/**
 * Current complete closed public v4 record (ADR 0025 §7; ADR 0032 §E3-S2).
 *
 * This module is the public half of the current record path. It maps one
 * already-accepted strict-v4 child record (or one strict-v4 command-context
 * record) plus the safe operational projections the current public record
 * carries into exactly one complete closed public v4 DTO:
 *
 * - run / case / materialization / plan identities;
 * - repository and contract fingerprints;
 * - adapter, workflow, fixture and target identities;
 * - readiness, launch, ownership, cleanup and redacted diagnostics;
 * - the complete three-state required checks;
 * - the resolved-profile identity, component fingerprints and Action Cycle
 *   references;
 * - every applicable nested v4 projection.
 *
 * The child region is validated by the accepted strict-v4 validators. The
 * operational region is validated against a closed shape vocabulary. The
 * complete record — operational projections included — is then recursively
 * scanned for the two removed legacy authorities (`passed` and
 * `harnessInvalid`), so no public field can be recovered from either.
 *
 * This is the sole current public record shape: the active entry paths reach it
 * through the final modules, and it never writes anything or touches an
 * evidence location itself.
 */

/** The strict current public-record schema version (ADR 0025 §7). */
export const FINAL_PUBLIC_RECORD_SCHEMA_VERSION = FINAL_CURRENT_CHILD_RECORD_SCHEMA_VERSION;

/** The only command a compiled-profile public v4 child record may declare. */
export const FINAL_PUBLIC_RUN_RECORD_COMMAND = 'diagnostic' as const;

export const FINAL_PUBLIC_CURRENT_RECORD_LABEL = CURRENT_RESULT_LABEL;
export const FINAL_PUBLIC_COMMAND_RECORD_LABEL = 'command-v4';

/**
 * The public path-correlation vocabulary, mirrored here so the public record is
 * closed without a runtime import from the active evidence module. The B2-E1
 * proof asserts this mirror equals the current public contract exactly.
 */
export const FINAL_PUBLIC_PATH_REF_DOMAIN = 'makeit:public-path-ref:v1';
export const FINAL_PUBLIC_PATH_ROLES: readonly string[] = Object.freeze([
  'repository',
  'skill-root',
  'next-dist-dir',
  'scratch-root',
  'evidence-root',
  'server-log',
  'downloads',
  'temp',
  'config',
  'snapshot',
]);

export const FINAL_PUBLIC_FINDING_SEVERITIES: readonly string[] = Object.freeze([
  'blocking',
  'warning',
]);

/**
 * One complete closed public v4 Diagnostic child record: the accepted strict-v4
 * child record plus the safe operational projections retained from the current
 * public contract. No legacy boolean and no `harnessInvalid` appears anywhere.
 */
export interface FinalPublicRunRecordV4 {
  schemaVersion: typeof FINAL_PUBLIC_RECORD_SCHEMA_VERSION;
  command: typeof FINAL_PUBLIC_RUN_RECORD_COMMAND;
  recordedAt: string;
  runId: string;
  caseId: string;
  materializationFingerprint: string;
  planFingerprint: string;
  profile: string;
  observationId: string | null;
  resolvedProfileFingerprint: string;
  componentFingerprints: FinalCurrentChildRecordV4['componentFingerprints'];
  actionCycles: FinalCurrentChildRecordV4['actionCycles'];
  requiredChecks: FinalCurrentChildRecordV4['requiredChecks'];
  nestedProjections: FinalCurrentChildRecordV4['nestedProjections'];
  provenance: CaseProvenance;
  evidenceDepth: EvidenceDepth;
  environmentCellId: string;
  repository: { commit: string | null; dirty: boolean | null; lockfileDigest: string };
  fingerprints: RunRecordFingerprints;
  adapter: { adapterId: string; compatibilityVersion: number };
  workflow: { workflowId: string; version: number };
  fixture: { fixtureId: string; constructorId: string; constructorVersion: number };
  targets: readonly { role: string; elementId: string }[];
  readiness: RunRecordReadiness;
  behaviorOutcome: Outcome | null;
  finalOutcome: Outcome;
  launch: PublicLaunchFacts;
  ownership: PublicOwnershipProjection;
  cleanup: PublicCleanupProjection | null;
  diagnostics: readonly DiagnosticRecord[];
  runError: string | null;
}

/**
 * One complete closed public v4 command-context record (Doctor /
 * production-absence): the accepted strict-v4 command record plus its safe
 * operational projections. It carries its own command authority and never a
 * fabricated compiled-profile identity.
 */
export interface FinalPublicCommandRecordV4 {
  schemaVersion: typeof FINAL_PUBLIC_RECORD_SCHEMA_VERSION;
  command: CommandCheckContext;
  commandAuthority: CommandStatusAuthority;
  checks: readonly CommandCheckResultView[];
  recordedAt: string;
  runId: string;
  behaviorOutcome: Outcome | null;
  finalOutcome: Outcome;
  launch: PublicLaunchFacts;
  ownership: PublicOwnershipProjection;
  cleanup: PublicCleanupProjection | null;
  diagnostics: readonly DiagnosticRecord[];
  runError: string | null;
}

export type FinalPublicRecordV4 = FinalPublicRunRecordV4 | FinalPublicCommandRecordV4;

/** The operational fields a public v4 child record adds to the strict v4 child. */
export const FINAL_PUBLIC_RUN_OPERATIONAL_KEYS: readonly string[] = Object.freeze([
  'provenance',
  'evidenceDepth',
  'environmentCellId',
  'repository',
  'fingerprints',
  'adapter',
  'workflow',
  'fixture',
  'targets',
  'readiness',
  'behaviorOutcome',
  'finalOutcome',
  'launch',
  'ownership',
  'cleanup',
  'diagnostics',
  'runError',
]);

/** The operational fields a public v4 command record adds to the strict command record. */
export const FINAL_PUBLIC_COMMAND_OPERATIONAL_KEYS: readonly string[] = Object.freeze([
  'recordedAt',
  'runId',
  'behaviorOutcome',
  'finalOutcome',
  'launch',
  'ownership',
  'cleanup',
  'diagnostics',
  'runError',
]);

const PUBLIC_RUN_RECORD_HEADER_KEYS = ['schemaVersion', 'command', 'recordedAt'] as const;

/** The complete closed key set of a public v4 child record. */
export const FINAL_PUBLIC_RUN_RECORD_KEYS: readonly string[] = Object.freeze([
  ...PUBLIC_RUN_RECORD_HEADER_KEYS,
  ...FINAL_CHILD_RECORD_KEYS.filter((key) => key !== 'schemaVersion'),
  ...FINAL_PUBLIC_RUN_OPERATIONAL_KEYS,
]);

/** The complete closed key set of a public v4 command-context record. */
export const FINAL_PUBLIC_COMMAND_RECORD_KEYS: readonly string[] = Object.freeze([
  'schemaVersion',
  'command',
  'commandAuthority',
  'checks',
  ...FINAL_PUBLIC_COMMAND_OPERATIONAL_KEYS,
]);

export interface FinalPublicRecordValidation {
  readonly ok: boolean;
  readonly issues: readonly FinalRecordIssue[];
}

export interface FinalPublicRecordAssemblyFailure {
  readonly ok: false;
  readonly status: 'HARNESS_BLOCKED';
  readonly issues: readonly FinalRecordIssue[];
}

export type FinalPublicRunRecordAssemblyResult =
  | { readonly ok: true; readonly record: FinalPublicRunRecordV4 }
  | FinalPublicRecordAssemblyFailure;

export type FinalPublicCommandRecordAssemblyResult =
  | { readonly ok: true; readonly record: FinalPublicCommandRecordV4 }
  | FinalPublicRecordAssemblyFailure;

// ── Closed operational shape vocabulary ──────────────────────────────────────
//
// A tiny closed-shape validator rather than eleven hand-written traversals. Every
// nested projection is fully closed: an unknown key at any level fails the
// record, so the public DTO can never silently widen.

type ValueSpec =
  | { readonly kind: 'string' }
  | { readonly kind: 'nonempty-string' }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'finite-number' }
  | { readonly kind: 'nullable'; readonly inner: ValueSpec }
  | { readonly kind: 'optional'; readonly inner: ValueSpec }
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  | { readonly kind: 'ownership' }
  | { readonly kind: 'literal'; readonly value: string | number | boolean }
  | { readonly kind: 'string-map' }
  | { readonly kind: 'nullable-number-map' }
  | { readonly kind: 'array'; readonly items: ValueSpec }
  | { readonly kind: 'object'; readonly fields: Readonly<Record<string, ValueSpec>> };

const REPOSITORY_SPEC: ValueSpec = {
  kind: 'object',
  fields: {
    commit: { kind: 'nullable', inner: { kind: 'nonempty-string' } },
    dirty: { kind: 'nullable', inner: { kind: 'boolean' } },
    lockfileDigest: { kind: 'nonempty-string' },
  },
};

const FINGERPRINTS_SPEC: ValueSpec = {
  kind: 'object',
  fields: {
    registry: { kind: 'nonempty-string' },
    applicationInventory: { kind: 'nonempty-string' },
    operationCatalogue: { kind: 'nonempty-string' },
    adapterCatalogue: { kind: 'nonempty-string' },
    workflowCatalogue: { kind: 'nonempty-string' },
    workflowSteps: { kind: 'nonempty-string' },
    coverageModel: { kind: 'nullable', inner: { kind: 'nonempty-string' } },
    readinessProfile: { kind: 'nonempty-string' },
    oracleProfile: { kind: 'nonempty-string' },
  },
};

const ADAPTER_SPEC: ValueSpec = {
  kind: 'object',
  fields: {
    adapterId: { kind: 'nonempty-string' },
    compatibilityVersion: { kind: 'finite-number' },
  },
};

const WORKFLOW_SPEC: ValueSpec = {
  kind: 'object',
  fields: {
    workflowId: { kind: 'nonempty-string' },
    version: { kind: 'finite-number' },
  },
};

const FIXTURE_SPEC: ValueSpec = {
  kind: 'object',
  fields: {
    fixtureId: { kind: 'nonempty-string' },
    constructorId: { kind: 'nonempty-string' },
    constructorVersion: { kind: 'finite-number' },
  },
};

const TARGET_SPEC: ValueSpec = {
  kind: 'object',
  fields: {
    role: { kind: 'nonempty-string' },
    elementId: { kind: 'nonempty-string' },
  },
};

const IDLE_FACTS_SPEC: ValueSpec = {
  kind: 'object',
  fields: {
    targetCount: { kind: 'finite-number' },
    stableFrames: { kind: 'finite-number' },
    waitedMs: { kind: 'finite-number' },
    observationRevision: { kind: 'finite-number' },
  },
};

const READINESS_SPEC: ValueSpec = {
  kind: 'object',
  fields: {
    profileId: { kind: 'nonempty-string' },
    timingCategory: { kind: 'nonempty-string' },
    deadlineMs: { kind: 'finite-number' },
    wakeSource: { kind: 'enum', values: WAKE_SOURCES },
    fallbackPollCount: { kind: 'finite-number' },
    watchdogWaits: { kind: 'finite-number' },
    rendererStableFrames: { kind: 'finite-number' },
    idle: { kind: 'optional', inner: { kind: 'nullable', inner: IDLE_FACTS_SPEC } },
    timings: { kind: 'nullable-number-map' },
  },
};

const LAUNCH_SPEC: ValueSpec = {
  kind: 'object',
  fields: {
    attempted: { kind: 'boolean' },
    pid: { kind: 'nullable', inner: { kind: 'finite-number' } },
    processGroupId: { kind: 'nullable', inner: { kind: 'finite-number' } },
    readinessMs: { kind: 'nullable', inner: { kind: 'finite-number' } },
    serverLogArtifactId: { kind: 'nullable', inner: { kind: 'nonempty-string' } },
  },
};

const PATH_REF_SPEC: ValueSpec = {
  kind: 'object',
  fields: {
    algorithm: { kind: 'enum', values: Object.freeze(['sha256']) },
    domain: { kind: 'enum', values: Object.freeze([FINAL_PUBLIC_PATH_REF_DOMAIN]) },
    role: { kind: 'enum', values: FINAL_PUBLIC_PATH_ROLES },
    digest: { kind: 'nonempty-string' },
  },
};

const PATH_PROJECTION_SPEC: ValueSpec = {
  kind: 'object',
  fields: {
    role: { kind: 'enum', values: FINAL_PUBLIC_PATH_ROLES },
    relativePath: { kind: 'nullable', inner: { kind: 'nonempty-string' } },
    fingerprint: PATH_REF_SPEC,
  },
};

const OWNED_RESOURCES_SPEC: ValueSpec = {
  kind: 'object',
  fields: {
    repository: PATH_PROJECTION_SPEC,
    skillRoot: PATH_PROJECTION_SPEC,
    nextDistDir: PATH_PROJECTION_SPEC,
    scratchRoot: PATH_PROJECTION_SPEC,
    evidenceRoot: PATH_PROJECTION_SPEC,
    serverLog: PATH_PROJECTION_SPEC,
  },
};

const OWNERSHIP_ESTABLISHED_SPEC: ValueSpec = {
  kind: 'object',
  fields: {
    status: { kind: 'enum', values: Object.freeze(['established']) },
    runId: { kind: 'nonempty-string' },
    ownershipFingerprint: { kind: 'nonempty-string' },
    ownershipState: {
      kind: 'enum',
      values: Object.freeze(['allocated', 'cleaned', 'launched', 'stopped']),
    },
    pid: { kind: 'nullable', inner: { kind: 'finite-number' } },
    processGroupId: { kind: 'nullable', inner: { kind: 'finite-number' } },
    port: { kind: 'finite-number' },
    appOrigin: { kind: 'nonempty-string' },
    routeNamespace: { kind: 'nonempty-string' },
    storageNamespace: { kind: 'nonempty-string' },
    resources: OWNED_RESOURCES_SPEC,
  },
};

const OWNERSHIP_NOT_ESTABLISHED_SPEC: ValueSpec = {
  kind: 'object',
  fields: {
    status: { kind: 'enum', values: Object.freeze(['not-established']) },
    runId: { kind: 'nonempty-string' },
    allocationFailureCode: { kind: 'nonempty-string' },
    requestedPort: {
      kind: 'nullable',
      inner: {
        kind: 'object',
        fields: {
          requested: { kind: 'finite-number' },
          owned: { kind: 'literal', value: false },
        },
      },
    },
  },
};

const CLEANUP_SPEC: ValueSpec = {
  kind: 'object',
  fields: {
    schemaVersion: { kind: 'finite-number' },
    runId: { kind: 'nonempty-string' },
    attempted: { kind: 'boolean' },
    complete: { kind: 'boolean' },
    alreadyClean: { kind: 'boolean' },
    refusedReason: { kind: 'nullable', inner: { kind: 'nonempty-string' } },
    facts: {
      kind: 'object',
      fields: {
        processSignalled: { kind: 'boolean' },
        processEscalated: { kind: 'boolean' },
        processDead: { kind: 'boolean' },
        portClosed: { kind: 'boolean' },
        distDirRemoved: { kind: 'boolean' },
        scratchRemoved: { kind: 'boolean' },
        configRestored: { kind: 'boolean' },
        browserClosed: { kind: 'boolean' },
        evidencePreserved: { kind: 'boolean' },
      },
    },
    diagnostics: {
      kind: 'array',
      items: {
        kind: 'object',
        fields: {
          code: { kind: 'nonempty-string' },
          resourceRole: { kind: 'nullable', inner: { kind: 'nonempty-string' } },
        },
      },
    },
  },
};

const DIAGNOSTIC_SPEC: ValueSpec = {
  kind: 'object',
  fields: {
    code: { kind: 'nonempty-string' },
    severity: { kind: 'enum', values: FINAL_PUBLIC_FINDING_SEVERITIES },
    detail: { kind: 'string' },
    subjectId: { kind: 'nullable', inner: { kind: 'nonempty-string' } },
    applicationKind: { kind: 'nullable', inner: { kind: 'nonempty-string' } },
    context: { kind: 'string-map' },
  },
};

const RUN_OPERATIONAL_SPEC: Readonly<Record<string, ValueSpec>> = Object.freeze({
  provenance: { kind: 'enum', values: CASE_PROVENANCES },
  evidenceDepth: { kind: 'enum', values: EVIDENCE_DEPTHS },
  environmentCellId: { kind: 'nonempty-string' },
  repository: REPOSITORY_SPEC,
  fingerprints: FINGERPRINTS_SPEC,
  adapter: ADAPTER_SPEC,
  workflow: WORKFLOW_SPEC,
  fixture: FIXTURE_SPEC,
  targets: { kind: 'array', items: TARGET_SPEC },
  readiness: READINESS_SPEC,
  behaviorOutcome: { kind: 'nullable', inner: { kind: 'enum', values: OUTCOMES } },
  finalOutcome: { kind: 'enum', values: OUTCOMES },
  launch: LAUNCH_SPEC,
  ownership: { kind: 'ownership' },
  cleanup: { kind: 'nullable', inner: CLEANUP_SPEC },
  diagnostics: { kind: 'array', items: DIAGNOSTIC_SPEC },
  runError: { kind: 'nullable', inner: { kind: 'nonempty-string' } },
});

const COMMAND_OPERATIONAL_SPEC: Readonly<Record<string, ValueSpec>> = Object.freeze({
  recordedAt: { kind: 'nonempty-string' },
  runId: { kind: 'nonempty-string' },
  behaviorOutcome: { kind: 'nullable', inner: { kind: 'enum', values: OUTCOMES } },
  finalOutcome: { kind: 'enum', values: OUTCOMES },
  launch: LAUNCH_SPEC,
  ownership: { kind: 'ownership' },
  cleanup: { kind: 'nullable', inner: CLEANUP_SPEC },
  diagnostics: { kind: 'array', items: DIAGNOSTIC_SPEC },
  runError: { kind: 'nullable', inner: { kind: 'nonempty-string' } },
});

/** A key label that never echoes a hostile key verbatim (guard non-leak invariant). */
const SAFE_KEY_LABEL = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function keyLabel(key: string, ordinal: number): string {
  return SAFE_KEY_LABEL.test(key) ? `.${key}` : `.<key:${ordinal}>`;
}

function issue(code: FinalRecordIssue['code'], detail: string): FinalRecordIssue {
  return { code, detail, checkId: null };
}

function invalid(detail: string): FinalRecordIssue {
  return issue('FINAL_RECORD_FIELD_INVALID', detail);
}

function validateOwnership(value: unknown, label: string, issues: FinalRecordIssue[]): void {
  if (!isPlainRecord(value)) {
    issues.push(invalid(`${label} must be the closed ownership projection.`));
    return;
  }
  const branch =
    value.status === 'established'
      ? OWNERSHIP_ESTABLISHED_SPEC
      : value.status === 'not-established'
        ? OWNERSHIP_NOT_ESTABLISHED_SPEC
        : undefined;
  if (branch === undefined) {
    issues.push(invalid(`${label} has an unknown ownership status.`));
    return;
  }
  validateAgainstSpec(value, branch, label, issues);
}

function validateAgainstSpec(
  value: unknown,
  spec: ValueSpec,
  label: string,
  issues: FinalRecordIssue[],
): void {
  switch (spec.kind) {
    case 'nullable':
      if (value !== null) validateAgainstSpec(value, spec.inner, label, issues);
      return;
    case 'optional':
      if (value !== undefined) validateAgainstSpec(value, spec.inner, label, issues);
      return;
    case 'string':
      if (typeof value !== 'string') issues.push(invalid(`${label} must be a string.`));
      return;
    case 'nonempty-string':
      if (typeof value !== 'string' || value.length === 0) {
        issues.push(invalid(`${label} must be a non-empty string.`));
      }
      return;
    case 'boolean':
      if (typeof value !== 'boolean') issues.push(invalid(`${label} must be a boolean.`));
      return;
    case 'finite-number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        issues.push(invalid(`${label} must be a finite number.`));
      }
      return;
    case 'enum':
      if (typeof value !== 'string' || !spec.values.includes(value)) {
        issues.push(invalid(`${label} is not a member of the closed vocabulary.`));
      }
      return;
    case 'ownership':
      validateOwnership(value, label, issues);
      return;
    case 'literal':
      if (value !== spec.value) {
        issues.push(invalid(`${label} must equal the single accepted value.`));
      }
      return;
    case 'string-map':
      if (!isPlainRecord(value)) {
        issues.push(invalid(`${label} must be a plain string map.`));
        return;
      }
      for (const entry of Object.values(value)) {
        if (typeof entry !== 'string') issues.push(invalid(`${label} must be a plain string map.`));
      }
      return;
    case 'nullable-number-map':
      if (!isPlainRecord(value)) {
        issues.push(invalid(`${label} must be a plain timing map.`));
        return;
      }
      for (const entry of Object.values(value)) {
        if (entry !== null && (typeof entry !== 'number' || !Number.isFinite(entry))) {
          issues.push(invalid(`${label} must be a plain timing map.`));
        }
      }
      return;
    case 'array':
      if (!Array.isArray(value)) {
        issues.push(invalid(`${label} must be an array.`));
        return;
      }
      value.forEach((entry, index) => {
        validateAgainstSpec(entry, spec.items, `${label}[${index}]`, issues);
      });
      return;
    case 'object': {
      if (!isPlainRecord(value)) {
        issues.push(invalid(`${label} must be a plain object.`));
        return;
      }
      const allowed = Object.keys(spec.fields);
      const keys = Object.keys(value);
      keys.forEach((key, index) => {
        if (!allowed.includes(key)) {
          issues.push(invalid(`${label} carries an unknown field ${keyLabel(key, index + 1)}.`));
        }
      });
      for (const [key, fieldSpec] of Object.entries(spec.fields)) {
        if (!Object.hasOwn(value, key)) {
          if (fieldSpec.kind !== 'optional') {
            issues.push(invalid(`${label} requires field ${keyLabel(key, 0)}.`));
          }
          continue;
        }
        validateAgainstSpec(value[key], fieldSpec, `${label}${keyLabel(key, 0)}`, issues);
      }
      return;
    }
    default: {
      const unsupported = spec as { readonly kind: string };
      issues.push(invalid(`${label} has an unsupported shape kind "${unsupported.kind}".`));
    }
  }
}

function validateClosedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  issues: FinalRecordIssue[],
): void {
  Object.keys(value).forEach((key, index) => {
    if (!allowed.includes(key)) {
      issues.push(invalid(`${label} carries an unknown field ${keyLabel(key, index + 1)}.`));
    }
  });
}

function pick(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.hasOwn(value, key)) picked[key] = value[key];
  }
  return picked;
}

function dedupe(issues: readonly FinalRecordIssue[]): readonly FinalRecordIssue[] {
  const seen = new Set<string>();
  const unique: FinalRecordIssue[] = [];
  for (const entry of issues) {
    const fingerprint = `${entry.code}\0${entry.detail}\0${entry.checkId ?? ''}`;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    unique.push(entry);
  }
  return Object.freeze(unique);
}

/**
 * Strict validation of one already-parsed public v4 child record. The child
 * region is validated by the accepted strict-v4 child validator; the
 * operational region is validated against the closed shape vocabulary; the
 * complete record is recursively scanned for `passed`/`harnessInvalid`.
 */
export function validateFinalPublicRunRecordV4(value: unknown): FinalPublicRecordValidation {
  if (!isPlainRecord(value)) {
    return {
      ok: false,
      issues: Object.freeze([
        issue('FINAL_RECORD_NOT_OBJECT', 'A public v4 record must be a plain object.'),
      ]),
    };
  }
  const record = value as unknown as Record<string, unknown>;
  const issues: FinalRecordIssue[] = [];
  validateClosedKeys(record, FINAL_PUBLIC_RUN_RECORD_KEYS, 'A public v4 record', issues);
  if (record.schemaVersion !== FINAL_PUBLIC_RECORD_SCHEMA_VERSION) {
    issues.push(
      issue(
        'FINAL_RECORD_SCHEMA_UNSUPPORTED',
        `A public v4 record must declare schemaVersion ${FINAL_PUBLIC_RECORD_SCHEMA_VERSION}.`,
      ),
    );
  }
  if (record.command !== FINAL_PUBLIC_RUN_RECORD_COMMAND) {
    issues.push(invalid('A public v4 child record must declare the diagnostic command.'));
  }
  if (typeof record.recordedAt !== 'string' || record.recordedAt.length === 0) {
    issues.push(invalid('A public v4 record requires a non-empty recordedAt.'));
  }
  for (const [key, spec] of Object.entries(RUN_OPERATIONAL_SPEC)) {
    if (!Object.hasOwn(record, key)) {
      issues.push(invalid(`A public v4 record requires field .${key}.`));
      continue;
    }
    validateAgainstSpec(record[key], spec, `A public v4 record.${key}`, issues);
  }
  const child = validateFinalChildRecordV4(pick(record, FINAL_CHILD_RECORD_KEYS));
  for (const entry of child.issues) issues.push(entry);
  for (const entry of finalRecordLegacyAuthorityIssues(record, 'A public v4 record')) {
    issues.push(entry);
  }
  const unique = dedupe(issues);
  return { ok: unique.length === 0, issues: unique };
}

/** Strict validation of one already-parsed public v4 command-context record. */
export function validateFinalPublicCommandRecordV4(value: unknown): FinalPublicRecordValidation {
  if (!isPlainRecord(value)) {
    return {
      ok: false,
      issues: Object.freeze([
        issue('FINAL_RECORD_NOT_OBJECT', 'A public v4 command record must be a plain object.'),
      ]),
    };
  }
  const record = value as unknown as Record<string, unknown>;
  const issues: FinalRecordIssue[] = [];
  validateClosedKeys(
    record,
    FINAL_PUBLIC_COMMAND_RECORD_KEYS,
    'A public v4 command record',
    issues,
  );
  if (record.schemaVersion !== FINAL_PUBLIC_RECORD_SCHEMA_VERSION) {
    issues.push(
      issue(
        'FINAL_RECORD_SCHEMA_UNSUPPORTED',
        `A public v4 command record must declare schemaVersion ${FINAL_PUBLIC_RECORD_SCHEMA_VERSION}.`,
      ),
    );
  }
  if (
    typeof record.command !== 'string' ||
    !(COMMAND_CHECK_CONTEXTS as readonly string[]).includes(record.command)
  ) {
    issues.push(
      issue(
        'FINAL_RECORD_CHECK_CONTEXT_INVALID',
        'A public v4 command record must declare a known command context.',
      ),
    );
  }
  const command = validateFinalCommandRecordV4(pick(record, FINAL_COMMAND_RECORD_KEYS));
  for (const entry of command.issues) issues.push(entry);
  for (const [key, spec] of Object.entries(COMMAND_OPERATIONAL_SPEC)) {
    if (!Object.hasOwn(record, key)) {
      issues.push(invalid(`A public v4 command record requires field .${key}.`));
      continue;
    }
    validateAgainstSpec(record[key], spec, `A public v4 command record.${key}`, issues);
  }
  for (const entry of finalRecordLegacyAuthorityIssues(record, 'A public v4 command record')) {
    issues.push(entry);
  }
  const unique = dedupe(issues);
  return { ok: unique.length === 0, issues: unique };
}

/**
 * Validates either public v4 record family. A record that carries both a closed
 * command authority and a resolved-profile identity is rejected rather than
 * guessed at.
 */
export function validateFinalPublicRecordV4(value: unknown): FinalPublicRecordValidation {
  if (!isPlainRecord(value)) {
    return {
      ok: false,
      issues: Object.freeze([
        issue('FINAL_RECORD_NOT_OBJECT', 'A public v4 record must be a plain object.'),
      ]),
    };
  }
  const hasCommandAuthority = Object.hasOwn(value, 'commandAuthority');
  const hasResolvedProfile = Object.hasOwn(value, 'resolvedProfileFingerprint');
  if (hasCommandAuthority && hasResolvedProfile) {
    return {
      ok: false,
      issues: Object.freeze([
        issue(
          'FINAL_RECORD_CHECK_CONTEXT_INVALID',
          'A public v4 record may not mix a command authority with a compiled-profile identity.',
        ),
      ]),
    };
  }
  if (hasCommandAuthority) return validateFinalPublicCommandRecordV4(value);
  return validateFinalPublicRunRecordV4(value);
}

/** True when a parsed object is shaped as a public v4 command-context record. */
export function isFinalPublicCommandRecordShape(value: unknown): boolean {
  return isFinalCommandRecordShape(value);
}

// ── Current assembly ─────────────────────────────────────────────────────────

export interface AssembleFinalPublicRunRecordV4Input {
  /** The accepted strict-v4 child record produced by the B2-C assembly. */
  readonly child: FinalCurrentChildRecordV4;
  readonly provenance: CaseProvenance;
  readonly evidenceDepth: EvidenceDepth;
  readonly environmentCellId: string;
  readonly repository: { commit: string | null; dirty: boolean | null; lockfileDigest: string };
  readonly fingerprints: RunRecordFingerprints;
  readonly adapter: { adapterId: string; compatibilityVersion: number };
  readonly workflow: { workflowId: string; version: number };
  readonly fixture: { fixtureId: string; constructorId: string; constructorVersion: number };
  readonly targets: readonly { role: string; elementId: string }[];
  readonly readiness: RunRecordReadiness;
  readonly behaviorOutcome: Outcome | null;
  readonly finalOutcome: Outcome;
  readonly launch: PublicLaunchFacts;
  readonly ownership: PublicOwnershipProjection;
  readonly cleanup: PublicCleanupProjection | null;
  readonly diagnostics: readonly DiagnosticRecord[];
  readonly runError: string | null;
  /** Deterministic override for tests; never a caller-supplied private value. */
  readonly recordedAt?: string;
}

function assemblyFailure(issues: readonly FinalRecordIssue[]): FinalPublicRecordAssemblyFailure {
  return { ok: false, status: 'HARNESS_BLOCKED', issues: dedupe(issues) };
}

function isolateFailure(error: unknown): FinalPublicRecordAssemblyFailure {
  return assemblyFailure([
    invalid(
      `The public v4 record could not be isolated: ${
        error instanceof Error ? error.message : String(error)
      }.`,
    ),
  ]);
}

/**
 * Assembles one complete closed public v4 child record from an accepted strict
 * child record and the safe operational projections. It fails closed with no
 * record on any disagreement; nothing is written here.
 */
export function assembleFinalPublicRunRecordV4(
  input: AssembleFinalPublicRunRecordV4Input,
): FinalPublicRunRecordAssemblyResult {
  const childValidation = validateFinalChildRecordV4(input.child);
  if (!childValidation.ok) {
    // Forward the exact strict-v4 agreement issues: a caller must see the
    // precise refusal code, never a generic wrapper.
    return assemblyFailure(childValidation.issues);
  }
  const childRegion = pick(
    input.child as unknown as Record<string, unknown>,
    FINAL_CHILD_RECORD_KEYS,
  );
  const draft: Record<string, unknown> = {
    schemaVersion: FINAL_PUBLIC_RECORD_SCHEMA_VERSION,
    command: FINAL_PUBLIC_RUN_RECORD_COMMAND,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
    ...childRegion,
    provenance: input.provenance,
    evidenceDepth: input.evidenceDepth,
    environmentCellId: input.environmentCellId,
    repository: input.repository,
    fingerprints: input.fingerprints,
    adapter: input.adapter,
    workflow: input.workflow,
    fixture: input.fixture,
    targets: input.targets,
    readiness: input.readiness,
    behaviorOutcome: input.behaviorOutcome,
    finalOutcome: input.finalOutcome,
    launch: input.launch,
    ownership: input.ownership,
    cleanup: input.cleanup,
    diagnostics: input.diagnostics,
    runError: input.runError,
  };
  const validation = validateFinalPublicRunRecordV4(draft);
  if (!validation.ok) return assemblyFailure(validation.issues);
  try {
    return {
      ok: true,
      record: isolateFinalRecordValue(draft, 'publicRecord') as FinalPublicRunRecordV4,
    };
  } catch (error) {
    return isolateFailure(error);
  }
}

export interface AssembleFinalPublicCommandRecordV4Input {
  /** The accepted strict-v4 command record produced by the B2-C assembly. */
  readonly command: FinalCommandCheckRecordV4;
  readonly runId: string;
  readonly behaviorOutcome: Outcome | null;
  readonly finalOutcome: Outcome;
  readonly launch: PublicLaunchFacts;
  readonly ownership: PublicOwnershipProjection;
  readonly cleanup: PublicCleanupProjection | null;
  readonly diagnostics: readonly DiagnosticRecord[];
  readonly runError: string | null;
  /** Deterministic override for tests; never a caller-supplied private value. */
  readonly recordedAt?: string;
}

/**
 * Assembles one complete closed public v4 command-context record. No compiled
 * correctness profile is fabricated and no compiled-profile field is added.
 */
export function assembleFinalPublicCommandRecordV4(
  input: AssembleFinalPublicCommandRecordV4Input,
): FinalPublicCommandRecordAssemblyResult {
  const commandValidation = validateFinalCommandRecordV4(input.command);
  if (!commandValidation.ok) {
    // Forward the exact strict-v4 agreement issues, exactly as for the child.
    return assemblyFailure(commandValidation.issues);
  }
  const commandRegion = pick(
    input.command as unknown as Record<string, unknown>,
    FINAL_COMMAND_RECORD_KEYS,
  );
  const draft: Record<string, unknown> = {
    ...commandRegion,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
    runId: input.runId,
    behaviorOutcome: input.behaviorOutcome,
    finalOutcome: input.finalOutcome,
    launch: input.launch,
    ownership: input.ownership,
    cleanup: input.cleanup,
    diagnostics: input.diagnostics,
    runError: input.runError,
  };
  const validation = validateFinalPublicCommandRecordV4(draft);
  if (!validation.ok) return assemblyFailure(validation.issues);
  try {
    return {
      ok: true,
      record: isolateFinalRecordValue(draft, 'publicCommandRecord') as FinalPublicCommandRecordV4,
    };
  } catch (error) {
    return isolateFailure(error);
  }
}

// ── Current strict current/legacy reader of a public record ──────────────────

export interface FinalPublicCurrentRunRecordView {
  readonly kind: 'current-v4';
  readonly label: typeof FINAL_PUBLIC_CURRENT_RECORD_LABEL;
  readonly schemaVersion: typeof FINAL_PUBLIC_RECORD_SCHEMA_VERSION;
  readonly legacy: false;
  readonly current: true;
  readonly ambiguous: false;
  readonly record: FinalPublicRunRecordV4;
  readonly issues: readonly FinalRecordIssue[];
}

export interface FinalPublicCurrentCommandRecordView {
  readonly kind: 'command-v4';
  readonly label: typeof FINAL_PUBLIC_COMMAND_RECORD_LABEL;
  readonly schemaVersion: typeof FINAL_PUBLIC_RECORD_SCHEMA_VERSION;
  readonly legacy: false;
  readonly current: true;
  readonly ambiguous: false;
  readonly record: FinalPublicCommandRecordV4;
  readonly issues: readonly FinalRecordIssue[];
}

/**
 * Exactly one discriminated branch. A strict public v4 record is current; a
 * historical v1/v2/v3 record is exposed through the labelled, read-only,
 * non-converting legacy branch (its historical boolean is preserved exactly);
 * a mixed or unknown record is rejected.
 */
export type FinalPublicRecordReadResult =
  | FinalPublicCurrentRunRecordView
  | FinalPublicCurrentCommandRecordView
  | FinalLegacyRecordView
  | FinalRejectedRecordView;

function invalidView(issues: readonly FinalRecordIssue[]): FinalRejectedRecordView {
  return {
    kind: 'invalid',
    label: 'invalid',
    schemaVersion: null,
    legacy: false,
    current: false,
    ambiguous: false,
    record: null,
    issues,
  };
}

/**
 * Reads an already-parsed public record into exactly one branch. It never
 * converts a legacy record, never reinterprets a historical `passed:false`, and
 * never accepts a malformed, mixed, or unknown record.
 */
export function readFinalPublicRecord(value: unknown): FinalPublicRecordReadResult {
  if (isPlainRecord(value) && value.schemaVersion === FINAL_PUBLIC_RECORD_SCHEMA_VERSION) {
    if (isFinalPublicCommandRecordShape(value)) {
      const validation = validateFinalPublicCommandRecordV4(value);
      if (!validation.ok) return invalidView(validation.issues);
      return {
        kind: 'command-v4',
        label: FINAL_PUBLIC_COMMAND_RECORD_LABEL,
        schemaVersion: FINAL_PUBLIC_RECORD_SCHEMA_VERSION,
        legacy: false,
        current: true,
        ambiguous: false,
        record: value as unknown as FinalPublicCommandRecordV4,
        issues: Object.freeze([]),
      };
    }
    const validation = validateFinalPublicRunRecordV4(value);
    if (!validation.ok) return invalidView(validation.issues);
    return {
      kind: 'current-v4',
      label: FINAL_PUBLIC_CURRENT_RECORD_LABEL,
      schemaVersion: FINAL_PUBLIC_RECORD_SCHEMA_VERSION,
      legacy: false,
      current: true,
      ambiguous: false,
      record: value as unknown as FinalPublicRunRecordV4,
      issues: Object.freeze([]),
    };
  }
  // Everything else is delegated verbatim to the accepted strict reader so the
  // legacy/mixed/unknown/invalid semantics are identical, never re-derived.
  const delegated = readFinalRecord(value);
  if (delegated.kind === 'current-v4' || delegated.kind === 'command-v4') {
    // Unreachable: a current view is only produced for a strict v4 record, and
    // every v4 record was handled above. Fail closed rather than guess.
    return invalidView([
      invalid('A public record reader reached an impossible classification state.'),
    ]);
  }
  return delegated;
}

/** True only for an accepted current public v4 child record. */
export function isCurrentFinalPublicRunRecord(
  result: FinalPublicRecordReadResult,
): result is FinalPublicCurrentRunRecordView {
  return result.kind === 'current-v4';
}

/** True only for an accepted current public v4 command record. */
export function isCurrentFinalPublicCommandRecord(
  result: FinalPublicRecordReadResult,
): result is FinalPublicCurrentCommandRecordView {
  return result.kind === 'command-v4';
}

/** True only for a non-converting historical legacy view. */
export function isLegacyFinalPublicRecord(
  result: FinalPublicRecordReadResult,
): result is FinalLegacyRecordView {
  return result.legacy === true;
}

/** Throws for any value that is not an accepted current public v4 child record. */
export function readCurrentFinalPublicRunRecordOrThrow(value: unknown): FinalPublicRunRecordV4 {
  const result = readFinalPublicRecord(value);
  if (result.kind !== 'current-v4') {
    throw new Error(
      `A current public v4 record is required; the value classified as "${result.label}" with ${result.issues
        .map((entry) => entry.code)
        .join(', ')}.`,
    );
  }
  return result.record;
}

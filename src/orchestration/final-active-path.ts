import path from 'node:path';

import { canonicalize, sha256Hex } from '../canonical/canonicalize';
import type { DiagnosticRecord } from '../contracts/diagnostics';
import type { CommandCheckContext } from '../contracts/command-check';
import type { CliStatus, EvidenceRole, Outcome } from '../contracts/discriminants';
import type { OracleEvaluatorKind } from '../contracts/correctness';
import type {
  AssembleFinalPublicCommandRecordV4Input,
  AssembleFinalPublicRunRecordV4Input,
  FinalPublicCommandRecordV4,
  FinalPublicRecordReadResult,
  FinalPublicRecordV4,
  FinalPublicRunRecordV4,
} from '../contracts/final-public-record';
import type {
  FinalSuiteAggregateStatus,
  FinalSuiteChildRecordV2,
  FinalSuiteRecordV2,
} from '../contracts/final-suite-record';
import type { FinalCommandCheckRecordV4 } from '../contracts/final-record-v4';
import { loadCatalogueBundle, type CatalogueBundle } from '../catalogue/load';
import {
  prepareFinalPublicCommandRecordV4,
  prepareFinalPublicRunRecordV4,
  type PreparedFinalPublicCommandRecordV4,
  type PreparedFinalPublicRunRecordV4,
  type WriteFinalPublicCommandRecordV4Input,
  type WriteFinalPublicCommandRecordV4Result,
  type WriteFinalPublicRunRecordV4Input,
  type WriteFinalPublicRunRecordV4Result,
} from '../evidence/final-writer';
import { readFinalPublicRecordFile } from '../evidence/final-reader';
import {
  writeFinalSuiteRecordV2,
  type WriteFinalSuiteRecordV2Input,
  type WriteFinalSuiteRecordV2Result,
} from '../evidence/final-suite-writer';
import { planCaseForExecution, type PlanForExecutionResult } from '../planner/plan-case';
import {
  executeDiagnosticCase,
  type DiagnosticExecutionOutcome,
  type DiagnosticPrelaunchFacts,
} from './diagnostic-execution';
import {
  aggregateSuiteChildren,
  executeSuiteChild,
  type SuiteAggregationResult,
  type SuiteChildOutcome,
  type SuiteChildSummary,
} from './suite-execution';
import type { CommandExecutionContextInput, CommandExecutionOutcome } from './command-execution';
import { executeDoctorCommandContext } from './doctor-command-execution';
import { executeProductionAbsenceCommandContext } from './production-absence-command-execution';
import {
  EVIDENCE_FINAL_MANIFEST_FILE_NAME,
  EVIDENCE_INTENDED_INVENTORY_FILE_NAME,
  EVIDENCE_FINAL_MANIFEST_SCHEMA_VERSION,
  EVIDENCE_FINAL_MANIFEST_LABEL,
  EVIDENCE_INTENDED_INVENTORY_SCHEMA_VERSION,
  EVIDENCE_INTENDED_INVENTORY_LABEL,
  EVIDENCE_SEALED_STRICT_SCHEMAS,
  type EvidenceArtifactEntry,
  type EvidenceFinalManifest,
  type EvidenceIntendedInventory,
  type EvidenceProvenance,
  type EvidenceProvenanceIdentity,
} from '../contracts/evidence-transaction';
import {
  EXECUTABLE_ARTIFACT_EXTENSIONS,
  MANIFEST_ARTIFACT_EXTENSION,
  PRODUCTION_ABSENCE_MARKERS,
  PRODUCTION_ABSENCE_ROUTE,
  PRODUCTION_ABSENCE_SCHEMA_VERSION,
  SCAN_SKIPPED_DIRECTORY_NAMES,
  SCAN_SKIPPED_SUFFIXES,
} from '../contracts/production-absence';
import type { EnvironmentCatalogue, EnvironmentCell } from '../contracts/runtime';
import {
  deriveIntendedInventoryIdentity,
  deriveProvenanceIdentity,
} from '../canonical/package8-identity';
import { resolveRepoRoot } from '../runtime/paths';
import { runtimeEngineDigest } from '../runtime/environment-facts';
import { loadEnvironmentCatalogue, resolveEnvironmentCell } from '../runtime/environment';
import {
  inspectSanitizationApproval,
  sanitizeArtifactBytes,
  snapshotSanitizationApproval,
  type SanitizedArtifactApproval,
} from '../evidence/sanitize';
import { buildEvidenceProvenance } from '../evidence/provenance';
const ACTIVE_RUN_RECORD_FILE_NAME = 'run-record.json';
import {
  planEvidencePublication,
  executeEvidencePublication,
  type EvidenceArtifactPublication,
} from '../evidence/publication';
import type { EvidenceTransactionFailureClass } from '../evidence/transaction';
import type { PrivateSnapshotCollection } from '../evidence/private-snapshot';
import {
  collectEvidenceProvenance,
  collectRepositoryProvenanceInputs,
  type RepositoryProvenanceInputs,
} from '../evidence/provenance-collector';
import {
  getProvenanceComponentPolicy,
  componentDigestFromEntries,
  assertFinalProvenanceComponentPolicy,
  type ProvenanceFlow,
} from '../evidence/provenance-component-policy';
import type { FinalExecutionObservation } from '../runtime/execute-plan';

/**
 * P7-B2-E2 full active-path façade (ADR 0030 §B2-E2; post-cutover current path,
 * ADR 0032 §E3-S2).
 *
 * One composition layer whose inputs and outputs match the real active command
 * boundaries, built only from the current B2 orchestration (Diagnostic, suite,
 * Doctor, production-absence) and the current B2-E1 durable evidence port. It
 * covers:
 *
 * - standalone Diagnostic planning + execution;
 * - suite preflight + child execution + aggregation;
 * - allocation / no-launch / rejection paths;
 * - Doctor and production-absence command contexts;
 * - durable strict-v4 public record production;
 * - CLI outcome/status/details projection;
 * - exact cleanup-finalization precedence.
 *
 * It adapts operational shapes only. It never reinterprets legacy result
 * authority: there is no `passed`, no `harnessInvalid`, no boolean translation,
 * no runtime flag, no global mutable cache, no disk profile lookup, and no
 * route/family/scenario selector anywhere. Dispatch and profile selection remain
 * exclusively inside the accepted orchestration, keyed by the compiled envelope.
 *
 * Every durable write targets an explicit caller-supplied isolated sink. The
 * four active CLI entries reach this module through their activation edges; this
 * module imports no active CLI/runtime/evidence entry — only the current B2
 * orchestration, the strict-v4 contracts, the current final-writer, and the
 * planner.
 */

// ── CLI projection (mirrors the active CLI result contract exactly) ──────────

/**
 * Mirrors of the active CLI status→exit mapping and CLI schema version. They are
 * declared locally (this module must not import an active CLI module) and the
 * focused foundation suite proves they are byte-equal to the active
 * `EXIT_CODES` and `CLI_RESULT_SCHEMA_VERSION`.
 */
export const FINAL_ACTIVE_PATH_CLI_SCHEMA_VERSION = 2;

export const FINAL_ACTIVE_PATH_EXIT_CODES: Readonly<Record<CliStatus, number>> = Object.freeze({
  PASS: 0,
  BUG: 1,
  HARNESS_BLOCKED: 2,
  ENVIRONMENT_FAILURE: 2,
  NOT_IMPLEMENTED: 3,
  USAGE: 64,
});

const TERMINAL_OUTCOME_STATUS: Readonly<Record<Outcome, CliStatus>> = Object.freeze({
  PASS: 'PASS',
  BUG: 'BUG',
  HARNESS_BLOCKED: 'HARNESS_BLOCKED',
  ENVIRONMENT_FAILURE: 'ENVIRONMENT_FAILURE',
});

/** The one exhaustive terminal-outcome→CLI-status mapping; `BUG` is never masked. */
export function finalStatusForOutcome(outcome: Outcome): CliStatus {
  const status = TERMINAL_OUTCOME_STATUS[outcome];
  if (status === undefined) throw new Error(`Unknown terminal outcome: ${String(outcome)}.`);
  return status;
}

export function finalExitCodeForOutcome(outcome: Outcome): number {
  return FINAL_ACTIVE_PATH_EXIT_CODES[finalStatusForOutcome(outcome)];
}

/** The post-cutover CLI result envelope; field-compatible with the active v2 shape. */
export interface FinalActivePathCliResult<TDetails> {
  readonly schemaVersion: number;
  readonly command: string;
  readonly subcommand: string | null;
  readonly status: CliStatus;
  readonly exitCode: number;
  readonly launchAttempted: boolean;
  readonly outcome: Outcome | null;
  readonly detail: string;
  readonly details: TDetails | null;
  readonly diagnostics: readonly DiagnosticRecord[];
}

interface FinalCliProjectionInput<TDetails> {
  readonly command: string;
  readonly subcommand?: string | null;
  readonly status: CliStatus;
  readonly outcome?: Outcome | null;
  readonly detail: string;
  readonly launchAttempted?: boolean;
  readonly details?: TDetails | null;
  readonly diagnostics?: readonly DiagnosticRecord[];
}

/**
 * Builds the CLI envelope. A terminal outcome can never coexist with a
 * contradictory status, exactly as in the active `buildCliResult`.
 */
export function projectFinalCliResult<TDetails>(
  input: FinalCliProjectionInput<TDetails>,
): FinalActivePathCliResult<TDetails> {
  const outcome = input.outcome ?? null;
  if (outcome !== null && input.status !== finalStatusForOutcome(outcome)) {
    throw new Error(
      `Contradictory CLI envelope: status "${input.status}" cannot carry outcome "${outcome}".`,
    );
  }
  return {
    schemaVersion: FINAL_ACTIVE_PATH_CLI_SCHEMA_VERSION,
    command: input.command,
    subcommand: input.subcommand ?? null,
    status: input.status,
    exitCode: FINAL_ACTIVE_PATH_EXIT_CODES[input.status],
    launchAttempted: input.launchAttempted ?? false,
    outcome,
    detail: input.detail,
    details: input.details ?? null,
    diagnostics: input.diagnostics ?? [],
  };
}

// ── Durable strict-v4 production ─────────────────────────────────────────────

export interface FinalActivePathOptionalCandidate {
  readonly artifactId: 'doctor.screenshot' | 'production-absence.screenshot';
  /** Candidate path relative to the owned scratch root. */
  readonly relativePath: string;
  /** Public path relative to the run evidence root. */
  readonly publicRelativePath: 'doctor.png' | 'production-absence.png';
  /** True only when the producer genuinely produced the optional candidate. */
  readonly produced: boolean;
}

/** Explicit out-of-band sink; the module owns no default or active location. */
export interface FinalActivePathDurableSink {
  readonly evidenceRoot: string;
  readonly forbiddenPaths?: readonly string[];
  /** Captured before cleanup; never a path or live filesystem capability. */
  readonly privateSnapshots?: PrivateSnapshotCollection;
  readonly optionalCandidates?: readonly FinalActivePathOptionalCandidate[];
  /** Capture/validation failures are terminal harness failures, not omission. */
  readonly candidateCaptureError?: string | null;
}

export interface FinalActivePathDurableOutcome {
  /** A durable record was required for this outcome (the run produced a record). */
  readonly required: boolean;
  readonly attempted: boolean;
  readonly wrote: boolean;
  readonly path: string | null;
  readonly serialized: string | null;
  readonly error: string | null;
  readonly failureClass: EvidenceTransactionFailureClass | null;
}

export type FinalActivePathRunRecordWriter = (
  input: WriteFinalPublicRunRecordV4Input,
) => WriteFinalPublicRunRecordV4Result;
export type FinalActivePathCommandRecordWriter = (
  input: WriteFinalPublicCommandRecordV4Input,
) => WriteFinalPublicCommandRecordV4Result;

/** The exact operational region a public v4 child record adds to the strict child. */
export type FinalActivePathRunOperationals = Omit<
  AssembleFinalPublicRunRecordV4Input,
  'child' | 'behaviorOutcome' | 'finalOutcome'
>;
/** The exact operational region a public v4 command record adds to the command. */
export type FinalActivePathCommandOperationals = Omit<
  AssembleFinalPublicCommandRecordV4Input,
  'command' | 'behaviorOutcome' | 'finalOutcome'
>;

function durableOutcome(
  partial: Partial<FinalActivePathDurableOutcome>,
): FinalActivePathDurableOutcome {
  return {
    required: partial.required ?? false,
    attempted: partial.attempted ?? false,
    wrote: partial.wrote ?? false,
    path: partial.path ?? null,
    serialized: partial.serialized ?? null,
    error: partial.error ?? null,
    failureClass: partial.failureClass ?? null,
  };
}

class ActiveTransactionFinalizationError extends Error {
  readonly failureClass: EvidenceTransactionFailureClass;

  constructor(message: string, failureClass: EvidenceTransactionFailureClass) {
    super(message);
    this.name = 'ActiveTransactionFinalizationError';
    this.failureClass = failureClass;
  }
}

// ── Flow-specific provenance identities (ADR 0046 P8-A2 A2-3) ───────────────

export interface ProvenanceIdentityEnvironmentAuthority {
  readonly catalogue: EnvironmentCatalogue;
  readonly cell: EnvironmentCell;
}

export interface ProvenanceFlowIdentities {
  readonly catalogueIdentities: readonly EvidenceProvenanceIdentity[];
  readonly profileIdentities: readonly EvidenceProvenanceIdentity[];
}

const FLOW_IDENTITY_DOMAIN = 'makeit:provenance-flow-identity';

export function flowIdentityDigest(kind: string, value: unknown): string {
  return sha256Hex(canonicalize({ domain: `${FLOW_IDENTITY_DOMAIN}:${kind}:v1`, value }));
}

function sortFlowIdentities(
  identities: readonly EvidenceProvenanceIdentity[],
): EvidenceProvenanceIdentity[] {
  return [...identities]
    .map((entry) => ({ id: entry.id, digest: entry.digest }))
    .sort((left, right) => (left.id < right.id ? -1 : 1));
}

function componentIdentityEntries(
  components: FinalPublicRunRecordV4['componentFingerprints'],
): EvidenceProvenanceIdentity[] {
  return [
    { id: 'component:readiness', digest: components.readiness },
    { id: 'component:capture', digest: components.capture },
    { id: 'component:oracle', digest: components.oracle },
    { id: 'component:capability-baseline', digest: components.capabilityBaseline },
    { id: 'component:subject-addition', digest: components.subjectAddition },
    { id: 'component:required-check-set', digest: components.requiredCheckSet },
    { id: 'component:tolerances', digest: components.tolerances },
    { id: 'component:visuals', digest: components.visuals },
    { id: 'component:normalization', digest: components.normalization },
  ];
}

function runRecordFlowIdentities(record: FinalPublicRunRecordV4): ProvenanceFlowIdentities {
  const { fingerprints, componentFingerprints } = record;
  const catalogueIdentities: EvidenceProvenanceIdentity[] = [
    { id: 'catalogue:registry', digest: fingerprints.registry },
    { id: 'catalogue:application-inventory', digest: fingerprints.applicationInventory },
    { id: 'catalogue:operation', digest: fingerprints.operationCatalogue },
    { id: 'catalogue:adapter', digest: fingerprints.adapterCatalogue },
    { id: 'catalogue:workflow', digest: fingerprints.workflowCatalogue },
    { id: 'catalogue:workflow-steps', digest: fingerprints.workflowSteps },
  ];
  if (fingerprints.coverageModel !== null) {
    catalogueIdentities.push({
      id: 'catalogue:coverage-model',
      digest: fingerprints.coverageModel,
    });
  }
  const profileIdentities: EvidenceProvenanceIdentity[] = [
    { id: `profile:resolved:${record.profile}`, digest: record.resolvedProfileFingerprint },
    {
      id: 'profile:readiness',
      digest: flowIdentityDigest('readiness-profile-identity', fingerprints.readinessProfile),
    },
    {
      id: 'profile:oracle',
      digest: flowIdentityDigest('oracle-profile-identity', fingerprints.oracleProfile),
    },
    ...componentIdentityEntries(componentFingerprints),
  ];
  return {
    catalogueIdentities: sortFlowIdentities(catalogueIdentities),
    profileIdentities: sortFlowIdentities(profileIdentities),
  };
}

function commandFlowIdentities(
  record: FinalPublicCommandRecordV4,
  environment: ProvenanceIdentityEnvironmentAuthority | null,
): ProvenanceFlowIdentities {
  if (environment === null) {
    throw new Error(
      `The ${record.command} provenance requires the governed environment catalogue and cell.`,
    );
  }
  const authority = record.commandAuthority;
  const catalogueIdentities: EvidenceProvenanceIdentity[] = [
    {
      id: `command-authority:${authority.commandAuthorityId}`,
      digest: authority.commandAuthorityFingerprint,
    },
    {
      id: 'environment:catalogue',
      digest: flowIdentityDigest('environment-catalogue', environment.catalogue),
    },
    {
      id: `environment:cell:${environment.cell.cellId}`,
      digest: flowIdentityDigest('environment-cell', environment.cell),
    },
  ];
  if (record.command === 'production-absence') {
    catalogueIdentities.push(
      {
        id: 'production-absence:contract',
        digest: flowIdentityDigest('production-absence-contract', {
          schemaVersion: PRODUCTION_ABSENCE_SCHEMA_VERSION,
          route: PRODUCTION_ABSENCE_ROUTE,
          markers: PRODUCTION_ABSENCE_MARKERS,
        }),
      },
      {
        id: 'production-absence:static-scan-policy',
        digest: flowIdentityDigest('production-absence-static-scan-policy', {
          executableExtensions: EXECUTABLE_ARTIFACT_EXTENSIONS,
          manifestExtension: MANIFEST_ARTIFACT_EXTENSION,
          skippedDirectoryNames: SCAN_SKIPPED_DIRECTORY_NAMES,
          skippedSuffixes: SCAN_SKIPPED_SUFFIXES,
        }),
      },
    );
  }
  return {
    catalogueIdentities: sortFlowIdentities(catalogueIdentities),
    profileIdentities: [],
  };
}

export function deriveFlowProvenanceIdentities(
  flow: ProvenanceFlow,
  record: FinalPublicRecordV4,
  environment: ProvenanceIdentityEnvironmentAuthority | null,
): ProvenanceFlowIdentities {
  if (flow === 'diagnostic' || flow === 'suite-child') {
    if (!('profile' in record)) {
      throw new Error(`The ${flow} flow requires a compiled-profile run record.`);
    }
    return runRecordFlowIdentities(record);
  }
  if (!('commandAuthority' in record)) {
    throw new Error(`The ${flow} flow requires a command-context record.`);
  }
  return commandFlowIdentities(record, environment);
}

/** Resolve the governed environment authority once for a command-context flow. */
function resolveGovernedEnvironmentAuthority(): ProvenanceIdentityEnvironmentAuthority {
  const catalogue = loadEnvironmentCatalogue();
  return { catalogue, cell: resolveEnvironmentCell(catalogue) };
}

/** Runtime identity contains only values/digests; executable paths never enter public bytes. */
function finalProvenance(
  flow: ProvenanceFlow,
  record: FinalPublicRecordV4,
  repoRoot: string,
): EvidenceProvenance {
  assertFinalProvenanceComponentPolicy();
  const repository = collectRepositoryProvenanceInputs({ repoRoot });
  const environment =
    flow === 'doctor' || flow === 'production-absence'
      ? resolveGovernedEnvironmentAuthority()
      : null;
  const identities = deriveFlowProvenanceIdentities(flow, record, environment);
  return buildEvidenceProvenance({
    ...repository,
    cliBootstrapDigest: componentDigestFromEntries(
      repository.governedEntries,
      'cliBootstrapDigest',
      flow,
    ),
    runnerDigest: componentDigestFromEntries(repository.governedEntries, 'runnerDigest', flow),
    evidenceWriterDigest: componentDigestFromEntries(
      repository.governedEntries,
      'evidenceWriterDigest',
      flow,
    ),
    verifierDigest: componentDigestFromEntries(repository.governedEntries, 'verifierDigest', flow),
    runtimeEngineDigest: runtimeEngineDigest(repoRoot),
    catalogueIdentities: identities.catalogueIdentities,
    profileIdentities: identities.profileIdentities,
  });
}

type PreparedActiveTransaction =
  | PreparedFinalPublicRunRecordV4
  | PreparedFinalPublicCommandRecordV4;

/**
 * The one active run-level public writer. Strict-v4 preparation is deliberately
 * performed before any Package-8 public I/O; publication owns the only writes
 * and commits the manifest last.
 */
function isPngBytes(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 24) return false;
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (signature.some((value, index) => bytes[index] !== value)) return false;
  // A produced screenshot must contain a non-empty IHDR; this is deliberately
  // bounded validation, not a decoder or a second filesystem read.
  const chunkLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8);
  const chunkType = new TextDecoder().decode(bytes.subarray(12, 16));
  const width = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(16);
  const height = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(20);
  return chunkLength === 13 && chunkType === 'IHDR' && width > 0 && height > 0;
}

interface OptionalPublication {
  readonly artifact: EvidenceArtifactEntry;
  readonly publication: EvidenceArtifactPublication;
}

function optionalPublications(
  sink: FinalActivePathDurableSink,
  forbiddenPaths: readonly string[],
): readonly OptionalPublication[] {
  if (sink.candidateCaptureError !== undefined && sink.candidateCaptureError !== null) {
    throw new ActiveTransactionFinalizationError(
      `Optional diagnostic candidate capture failed: ${sink.candidateCaptureError}`,
      'HARNESS_BLOCKED',
    );
  }
  const candidates = sink.optionalCandidates ?? [];
  const snapshots = sink.privateSnapshots?.snapshots ?? [];
  const result: OptionalPublication[] = [];
  for (const candidate of candidates) {
    if (!candidate.produced) continue;
    const snapshot = snapshots.find((entry) => entry.artifactId === candidate.artifactId);
    if (snapshot === undefined) {
      throw new ActiveTransactionFinalizationError(
        `Optional candidate ${candidate.artifactId} was produced but no owned scratch snapshot was captured.`,
        'HARNESS_BLOCKED',
      );
    }
    const bytes = snapshot.bytes;
    if (candidate.artifactId.endsWith('.screenshot') && !isPngBytes(bytes)) {
      throw new ActiveTransactionFinalizationError(
        `Optional candidate ${candidate.artifactId} is not a valid bounded PNG.`,
        'HARNESS_BLOCKED',
      );
    }
    let approval: SanitizedArtifactApproval;
    try {
      approval = sanitizeArtifactBytes({
        artifactId: candidate.artifactId,
        relativePath: candidate.publicRelativePath,
        role: 'diagnostic-only',
        policy: 'opaque-bytes-guard-v1',
        bytes,
        semanticDigestKind: null,
        forbiddenPaths,
      });
    } catch (error) {
      throw new ActiveTransactionFinalizationError(
        `Optional candidate ${candidate.artifactId} was not sanitizer-approved: ${error instanceof Error ? error.message : String(error)}.`,
        'HARNESS_BLOCKED',
      );
    }
    const inspected = inspectSanitizationApproval(approval);
    if (inspected.approval !== 'approved' || inspected.sha256 === null) {
      throw new ActiveTransactionFinalizationError(
        `Optional candidate ${candidate.artifactId} was omitted by sanitization after production.`,
        'HARNESS_BLOCKED',
      );
    }
    result.push({
      artifact: {
        artifactId: candidate.artifactId,
        role: 'diagnostic-only',
        mediaType: 'image/png',
        schema: 'png',
        relativePath: candidate.publicRelativePath,
        byteLength: inspected.byteLength,
        sha256: inspected.sha256,
        semanticDigest: null,
        semanticDigestKind: null,
        producerPhase: 'observation',
        consumedBy: [],
        sanitizationPolicy: 'opaque-bytes-guard-v1',
        retentionStatus: 'eligible-later',
      },
      publication: {
        artifactId: candidate.artifactId,
        relativePath: candidate.publicRelativePath,
        approval,
      },
    });
  }
  return result;
}
function publishPreparedTransaction<T extends PreparedActiveTransaction>(
  prepared: T,
  sink: FinalActivePathDurableSink,
  flow: ProvenanceFlow,
): { readonly path: string; readonly serialized: string; readonly record: T['record'] } {
  const forbiddenPaths = sink.forbiddenPaths ?? [];
  const approval = sanitizeArtifactBytes({
    artifactId: 'run.record',
    relativePath: ACTIVE_RUN_RECORD_FILE_NAME,
    role: 'required-authoritative',
    policy: 'public-json-guard-v1',
    bytes: prepared.serialized,
    semanticDigestKind: 'canonical-json',
    semanticValue: prepared.record,
    forbiddenPaths,
  });
  const approved = inspectSanitizationApproval(approval);
  if (approved.approval !== 'approved' || approved.sha256 === null) {
    throw new ActiveTransactionFinalizationError(
      'The required strict-v4 run record was not sanitizer-approved.',
      'HARNESS_BLOCKED',
    );
  }

  const artifact: EvidenceArtifactEntry = {
    artifactId: 'run.record',
    role: 'required-authoritative',
    mediaType: 'application/json',
    schema: 'profile' in prepared.record ? 'current-v4' : 'command-v4',
    relativePath: ACTIVE_RUN_RECORD_FILE_NAME,
    byteLength: approved.byteLength,
    sha256: approved.sha256,
    semanticDigest: approved.semanticDigest,
    semanticDigestKind: approved.semanticDigestKind,
    producerPhase: 'finalization',
    consumedBy: [],
    sanitizationPolicy: 'public-json-guard-v1',
    retentionStatus: 'required-preserve',
  };
  const provenance = finalProvenance(flow, prepared.record, resolveRepoRoot());
  const createdAtUtc = new Date().toISOString();
  const optional = optionalPublications(sink, forbiddenPaths);
  const inventoryArtifacts = [artifact, ...optional.map((entry) => entry.artifact)].sort(
    (left, right) => left.artifactId.localeCompare(right.artifactId),
  );
  const inventory: EvidenceIntendedInventory = {
    schemaVersion: EVIDENCE_INTENDED_INVENTORY_SCHEMA_VERSION,
    label: EVIDENCE_INTENDED_INVENTORY_LABEL,
    transactionKind: 'run',
    transactionId: prepared.record.runId,
    provenance,
    sealedStrictSchemas: EVIDENCE_SEALED_STRICT_SCHEMAS,
    artifacts: inventoryArtifacts,
    createdAtUtc,
  };
  const manifest: EvidenceFinalManifest = {
    schemaVersion: EVIDENCE_FINAL_MANIFEST_SCHEMA_VERSION,
    label: EVIDENCE_FINAL_MANIFEST_LABEL,
    transactionKind: 'run',
    transactionId: prepared.record.runId,
    inventoryIdentity: deriveIntendedInventoryIdentity(inventory),
    provenanceIdentity: deriveProvenanceIdentity(provenance),
    sealedStrictSchemas: EVIDENCE_SEALED_STRICT_SCHEMAS,
    behaviorOutcome: prepared.record.behaviorOutcome ?? prepared.record.finalOutcome,
    transactionResult: 'committed',
    committedArtifacts: inventoryArtifacts.map((entry) => ({
      artifactId: entry.artifactId,
      relativePath: entry.relativePath,
      byteLength: entry.byteLength,
      sha256: entry.sha256,
      semanticDigest: entry.semanticDigest,
    })),
    references: [],
    committedAtUtc: new Date().toISOString(),
  };
  let execution: ReturnType<typeof executeEvidencePublication>;
  try {
    const plan = planEvidencePublication({
      evidenceRoot: sink.evidenceRoot,
      inventory,
      manifest,
      artifacts: [
        { artifactId: artifact.artifactId, relativePath: artifact.relativePath, approval },
        ...optional.map((entry) => entry.publication),
      ],
    });
    execution = executeEvidencePublication(plan);
  } catch (error) {
    if (error instanceof ActiveTransactionFinalizationError) throw error;
    throw new ActiveTransactionFinalizationError(
      error instanceof Error ? error.message : String(error),
      'HARNESS_BLOCKED',
    );
  }
  if (!execution.manifestCommitted) {
    throw new ActiveTransactionFinalizationError(
      `Package-8 publication did not commit the final manifest (${execution.evaluation.failureClass ?? 'HARNESS_BLOCKED'}).`,
      execution.evaluation.failureClass ?? 'HARNESS_BLOCKED',
    );
  }
  return {
    path: path.join(sink.evidenceRoot, ACTIVE_RUN_RECORD_FILE_NAME),
    serialized: prepared.serialized,
    record: prepared.record,
  };
}

function finalizeRunTransaction(
  input: WriteFinalPublicRunRecordV4Input,
  sink: FinalActivePathDurableSink,
): WriteFinalPublicRunRecordV4Result {
  const prepared = prepareFinalPublicRunRecordV4(input);
  return publishPreparedTransaction(prepared, sink, 'diagnostic');
}

function finalizeCommandTransaction(
  input: WriteFinalPublicCommandRecordV4Input,
  sink: FinalActivePathDurableSink,
): WriteFinalPublicCommandRecordV4Result {
  const prepared = prepareFinalPublicCommandRecordV4(input);
  const flow: ProvenanceFlow =
    prepared.record.command === 'doctor' ? 'doctor' : 'production-absence';
  return publishPreparedTransaction(prepared, sink, flow);
}

/**
 * Durably produces the strict-v4 public child record for a completed execution,
 * in the fixed accepted order enforced by the B2-E1 writer: assemble → validate
 * → redact/guard (record + exact bytes) → exclusive `wx`/`fsync` write with
 * overwrite refusal → byte-exact self-readback. A refusal before any record
 * (allocation/no-launch/rejection) requires no record and is not a finalization
 * failure.
 */
function finalizeRunRecord(
  execution: DiagnosticExecutionOutcome,
  operational: FinalActivePathRunOperationals,
  sink: FinalActivePathDurableSink,
  write: FinalActivePathRunRecordWriter | undefined,
): FinalActivePathDurableOutcome {
  if (execution.record === null) {
    return durableOutcome({ required: false });
  }
  try {
    const result =
      write === undefined
        ? finalizeRunTransaction(
            {
              child: execution.record,
              ...operational,
              behaviorOutcome: execution.behaviorOutcome,
              finalOutcome: execution.finalOutcome,
              evidenceRoot: sink.evidenceRoot,
              forbiddenPaths: sink.forbiddenPaths ?? [],
            },
            sink,
          )
        : write({
            child: execution.record,
            ...operational,
            behaviorOutcome: execution.behaviorOutcome,
            finalOutcome: execution.finalOutcome,
            evidenceRoot: sink.evidenceRoot,
            forbiddenPaths: sink.forbiddenPaths ?? [],
          });
    return durableOutcome({
      required: true,
      attempted: true,
      wrote: true,
      path: result.path,
      serialized: result.serialized,
      failureClass: null,
    });
  } catch (error) {
    return durableOutcome({
      required: true,
      attempted: true,
      wrote: false,
      error: error instanceof Error ? error.message : String(error),
      failureClass:
        error instanceof ActiveTransactionFinalizationError
          ? error.failureClass
          : 'HARNESS_BLOCKED',
    });
  }
}

/** Same, for a command-context (Doctor / production-absence) record. */
function finalizeCommandRecord(
  execution: CommandExecutionOutcome,
  operational: FinalActivePathCommandOperationals,
  sink: FinalActivePathDurableSink,
  write: FinalActivePathCommandRecordWriter | undefined,
): FinalActivePathDurableOutcome {
  if (execution.record === null) {
    return durableOutcome({ required: false });
  }
  try {
    const result =
      write === undefined
        ? finalizeCommandTransaction(
            {
              command: execution.record,
              ...operational,
              behaviorOutcome: execution.behaviorOutcome,
              finalOutcome: execution.finalOutcome,
              evidenceRoot: sink.evidenceRoot,
              forbiddenPaths: sink.forbiddenPaths ?? [],
            },
            sink,
          )
        : write({
            command: execution.record,
            ...operational,
            behaviorOutcome: execution.behaviorOutcome,
            finalOutcome: execution.finalOutcome,
            evidenceRoot: sink.evidenceRoot,
            forbiddenPaths: sink.forbiddenPaths ?? [],
          });
    return durableOutcome({
      required: true,
      attempted: true,
      wrote: true,
      path: result.path,
      serialized: result.serialized,
      failureClass: null,
    });
  } catch (error) {
    return durableOutcome({
      required: true,
      attempted: true,
      wrote: false,
      error: error instanceof Error ? error.message : String(error),
      failureClass:
        error instanceof ActiveTransactionFinalizationError
          ? error.failureClass
          : 'HARNESS_BLOCKED',
    });
  }
}

/**
 * Finalization precedence: a required durable record that did not reach disk
 * converts the final outcome to `ENVIRONMENT_FAILURE`, so a finalization failure
 * can never be reported as `PASS`. The behavior verdict is preserved separately.
 */
function applyFinalizationPrecedence(
  executionOutcome: Outcome,
  durable: FinalActivePathDurableOutcome,
): Outcome {
  if (durable.required && !durable.wrote) {
    return durable.failureClass ?? 'HARNESS_BLOCKED';
  }
  return executionOutcome;
}

function statusChecks(
  checks: readonly { readonly checkId: string; readonly status: unknown }[],
): readonly { readonly checkId: string; readonly status: string }[] {
  return checks.map((check) => ({ checkId: check.checkId, status: String(check.status) }));
}

// ── Standalone Diagnostic planning + execution ───────────────────────────────

export interface FinalDiagnosticActivePathInput {
  /** Either the raw case request or an already-planned projection is required. */
  readonly request?: unknown;
  readonly planning?: PlanForExecutionResult;
  readonly catalogues?: CatalogueBundle;
  /**
   * Explicit application root the raw request is planned against (ADR 0118).
   * Required whenever this input carries a raw `request` that resolves the
   * generated-Crossword product source; ignored when `planning` is supplied.
   */
  readonly appRoot?: string;
  readonly prelaunch: DiagnosticPrelaunchFacts;
  /** The atomic executor-owned final observation handoff. */
  readonly observation: FinalExecutionObservation | null;
  readonly runId: string;
  readonly cleanupSucceeded: boolean;
  readonly externalFailure?: boolean;
  readonly operational: FinalActivePathRunOperationals;
  readonly durable: FinalActivePathDurableSink;
  /** Test seam; defaults to the current durable port. */
  readonly writeRecord?: FinalActivePathRunRecordWriter;
}

export interface FinalDiagnosticActivePathCliDetails {
  readonly runId: string;
  readonly caseId: string | null;
  readonly materializationFingerprint: string | null;
  readonly planFingerprint: string | null;
  readonly evaluatorKind: OracleEvaluatorKind | null;
  readonly compatibilityVersion: number | null;
  readonly behaviorOutcome: Outcome | null;
  readonly finalOutcome: Outcome;
  readonly requiredChecks: readonly { readonly checkId: string; readonly status: string }[];
  readonly evidenceRoot: string | null;
  readonly runRecordPath: string | null;
  readonly observationId: string | null;
  readonly issues: readonly string[];
  readonly durable: FinalActivePathDurableOutcome;
}

export interface FinalDiagnosticActivePathOutcome {
  readonly planning: PlanForExecutionResult;
  readonly execution: DiagnosticExecutionOutcome;
  readonly durable: FinalActivePathDurableOutcome;
  readonly finalOutcome: Outcome;
  readonly cli: FinalActivePathCliResult<FinalDiagnosticActivePathCliDetails>;
}

/** Planning step of the final path; compile-once envelope only, never a recompile. */
export function planFinalActivePathCase(
  request: unknown,
  catalogues?: CatalogueBundle,
  appRoot?: string,
): PlanForExecutionResult {
  return planCaseForExecution(request, {
    catalogues: catalogues ?? loadCatalogueBundle(),
    ...(appRoot === undefined ? {} : { appRoot }),
  });
}

function resolvePlanning(input: {
  readonly request?: unknown;
  readonly planning?: PlanForExecutionResult;
  readonly catalogues?: CatalogueBundle;
  readonly appRoot?: string;
}): PlanForExecutionResult {
  if (input.planning !== undefined) return input.planning;
  if (input.request === undefined) {
    throw new Error(
      'The final active path requires either a case request or a planning projection.',
    );
  }
  return planFinalActivePathCase(input.request, input.catalogues, input.appRoot);
}

function diagnosticDetail(
  execution: DiagnosticExecutionOutcome,
  finalOutcome: Outcome,
  durable: FinalActivePathDurableOutcome,
): string {
  if (durable.required && !durable.wrote) {
    return `Diagnostic outcome ${execution.finalOutcome} could not be finalized: the strict v4 record was not written (${durable.error ?? 'unknown finalization failure'}); final outcome ${finalOutcome}.`;
  }
  if (execution.record === null) {
    return `Diagnostic ${finalOutcome}: no record was produced (prelaunch refusal); launchAttempted=${String(execution.launchAttempted)}.`;
  }
  return `Diagnostic ${finalOutcome} (behavior ${execution.behaviorOutcome ?? 'none'}); strict v4 record written.`;
}

/**
 * Runs one standalone Diagnostic case through the current final façade:
 * planning → execution/classification → durable strict-v4 production → CLI
 * projection, with exact cleanup/finalization precedence.
 */
export function runFinalDiagnosticActivePath(
  input: FinalDiagnosticActivePathInput,
): FinalDiagnosticActivePathOutcome {
  const planning = resolvePlanning(input);
  const execution = executeDiagnosticCase({
    planning,
    prelaunch: input.prelaunch,
    observation: input.observation,
    runId: input.runId,
    cleanupSucceeded: input.cleanupSucceeded,
    externalFailure: input.externalFailure,
  });
  const durable = finalizeRunRecord(execution, input.operational, input.durable, input.writeRecord);
  const finalOutcome = applyFinalizationPrecedence(execution.finalOutcome, durable);
  const cli = projectFinalCliResult<FinalDiagnosticActivePathCliDetails>({
    command: 'diagnostic',
    status: finalStatusForOutcome(finalOutcome),
    outcome: finalOutcome,
    detail: diagnosticDetail(execution, finalOutcome, durable),
    launchAttempted: execution.launchAttempted,
    details: {
      runId: input.runId,
      caseId: execution.caseId,
      materializationFingerprint: execution.materializationFingerprint,
      planFingerprint: execution.planFingerprint,
      evaluatorKind: execution.evaluatorKind,
      compatibilityVersion: execution.compatibilityVersion,
      behaviorOutcome: execution.behaviorOutcome,
      finalOutcome,
      requiredChecks: statusChecks(execution.requiredChecks),
      evidenceRoot: durable.path === null ? null : input.durable.evidenceRoot,
      runRecordPath: durable.path,
      observationId: execution.record === null ? null : (input.observation?.observationId ?? null),
      issues: execution.issues.map((entry) => entry.code),
      durable,
    },
    diagnostics: execution.diagnostics,
  });
  return { planning, execution, durable, finalOutcome, cli };
}

// ── Suite preflight + children + aggregation ─────────────────────────────────

export interface FinalSuiteMemberInput extends FinalDiagnosticActivePathInput {
  readonly order: number;
  readonly caseId: string;
  readonly requestPath: string;
  readonly expectedOutcome: 'PASS';
  /** Optional per-child timing; defaults to the aggregate suite timing. */
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly durationMs?: number;
}

/**
 * The safe aggregate operational context the current suite path needs to build
 * a complete v4-bound aggregate. It carries no child status and no boolean
 * acceptance authority.
 */
export interface FinalSuiteAggregateContext {
  readonly suiteExecutionId: string;
  /**
   * The immutable suite-lineage identity shared by every member of the suite
   * (ADR 0019 R11). It is a distinct identity from the per-execution
   * `suiteExecutionId` and every child entry must agree with it verbatim.
   */
  readonly suiteLineageId: string;
  readonly suiteFingerprint: string;
  readonly repository: {
    readonly commit: string | null;
    readonly dirty: boolean | null;
    readonly lockfileDigest: string;
  };
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly stopReason?: string | null;
  readonly recordedAt?: string;
}

export interface FinalSuiteActivePathInput {
  readonly suiteId: string;
  readonly suiteVersion: number;
  readonly declaredCaseCount: number;
  readonly members: readonly FinalSuiteMemberInput[];
  readonly interrupted?: boolean;
  readonly stoppedOnCleanup?: boolean;
  /** Aggregate operational context (required for a v4-bound aggregate). */
  readonly aggregate: FinalSuiteAggregateContext;
  /** Explicit out-of-band sink for the v4-bound suite aggregate. */
  readonly suiteDurable: FinalActivePathDurableSink;
  /** Test seam; defaults to the current v4-bound suite writer. */
  readonly writeSuiteRecord?: FinalSuiteAggregateWriter;
}

export type FinalSuiteAggregateWriter = (
  input: WriteFinalSuiteRecordV2Input,
) => WriteFinalSuiteRecordV2Result;

/** The durable outcome of one suite child's strict-v4 record readback. */
export interface FinalSuiteChildReadback {
  readonly order: number;
  readonly required: boolean;
  /** `current-v4` only for an independently read, validated strict-v4 child. */
  readonly kind:
    | 'current-v4'
    | 'no-record-refusal'
    | 'legacy'
    | 'mixed'
    | 'unknown'
    | 'invalid'
    | 'unreadable';
  readonly path: string | null;
}

/** The durable outcome of the v4-bound aggregate write + readback. */
export interface FinalSuiteAggregateDurableOutcome {
  readonly required: boolean;
  readonly attempted: boolean;
  readonly wrote: boolean;
  readonly path: string | null;
  readonly serialized: string | null;
  readonly error: string | null;
}

export interface FinalSuiteChildActivePathOutcome {
  readonly child: SuiteChildOutcome;
  readonly durable: FinalActivePathDurableOutcome;
  readonly cli: FinalActivePathCliResult<FinalDiagnosticActivePathCliDetails>;
}

export interface FinalSuiteActivePathCliDetails {
  readonly suiteId: string;
  readonly suiteVersion: number;
  readonly declaredCaseCount: number;
  readonly executedCount: number;
  readonly canonicalOrder: readonly number[];
  readonly children: readonly SuiteChildSummary[];
  readonly aggregateStatus: FinalSuiteAggregateStatus | null;
  readonly complete: boolean;
  readonly pass: boolean;
  readonly interrupted: boolean;
  readonly stoppedOnCleanup: boolean;
  readonly failedRecordOrders: readonly number[];
  readonly suiteRecordPath: string | null;
  readonly suiteRecordSchemaVersion: number | null;
  readonly suiteDurable: FinalSuiteAggregateDurableOutcome;
  readonly suiteChildReadback: readonly FinalSuiteChildReadback[];
}

export interface FinalSuiteActivePathOutcome {
  readonly preflight: {
    readonly ok: boolean;
    readonly issues: readonly string[];
  };
  readonly children: readonly FinalSuiteChildActivePathOutcome[];
  readonly childReadback: readonly FinalSuiteChildReadback[];
  readonly aggregation: SuiteAggregationResult | null;
  readonly suite: {
    readonly record: FinalSuiteRecordV2 | null;
    readonly durable: FinalSuiteAggregateDurableOutcome;
    readonly acceptedChildOrders: readonly number[];
    readonly refusedChildOrders: readonly number[];
  };
  readonly finalOutcome: Outcome;
  readonly cli: FinalActivePathCliResult<FinalSuiteActivePathCliDetails>;
}

export const FINAL_SUITE_PREFLIGHT_ISSUE_CODES = [
  'SUITE_PREFLIGHT_COUNT_MISMATCH',
  'SUITE_PREFLIGHT_ORDER_INVALID',
  'SUITE_PREFLIGHT_DUPLICATE_MEMBER',
] as const;
export type FinalSuitePreflightIssueCode = (typeof FINAL_SUITE_PREFLIGHT_ISSUE_CODES)[number];

/** Declaration-only suite preflight; runs before any child allocation or launch. */
export function preflightFinalSuite(input: FinalSuiteActivePathInput): readonly string[] {
  const issues: string[] = [];
  if (input.members.length !== input.declaredCaseCount) {
    issues.push(
      `SUITE_PREFLIGHT_COUNT_MISMATCH: declared ${input.declaredCaseCount} members but ${input.members.length} were supplied`,
    );
  }
  const orders = input.members.map((member) => member.order);
  const canonical =
    orders.every((order, index) => order === index + 1) && new Set(orders).size === orders.length;
  if (!canonical) {
    issues.push(
      `SUITE_PREFLIGHT_ORDER_INVALID: members must declare the contiguous canonical order 1..N; received [${orders.join(', ')}]`,
    );
  }
  const caseIds = input.members.map((member) => member.caseId);
  const requests = input.members.map((member) => member.requestPath);
  if (new Set(caseIds).size !== caseIds.length || new Set(requests).size !== requests.length) {
    issues.push(
      'SUITE_PREFLIGHT_DUPLICATE_MEMBER: members must declare distinct case ids and requests',
    );
  }
  return Object.freeze(issues);
}

function runFinalSuiteChild(member: FinalSuiteMemberInput): FinalSuiteChildActivePathOutcome {
  const child = executeSuiteChild({
    planning: resolvePlanning(member),
    prelaunch: member.prelaunch,
    observation: member.observation,
    runId: member.runId,
    cleanupSucceeded: member.cleanupSucceeded,
    externalFailure: member.externalFailure,
    order: member.order,
    caseId: member.caseId,
    request: member.requestPath,
    expectedOutcome: member.expectedOutcome,
  });
  const durable = finalizeRunRecord(
    child.execution,
    member.operational,
    member.durable,
    member.writeRecord,
  );
  const finalOutcome = applyFinalizationPrecedence(child.execution.finalOutcome, durable);
  const cli = projectFinalCliResult<FinalDiagnosticActivePathCliDetails>({
    command: 'diagnostic',
    subcommand: member.requestPath,
    status: finalStatusForOutcome(finalOutcome),
    outcome: finalOutcome,
    detail: diagnosticDetail(child.execution, finalOutcome, durable),
    launchAttempted: child.execution.launchAttempted,
    details: {
      runId: member.runId,
      caseId: child.execution.caseId,
      materializationFingerprint: child.execution.materializationFingerprint,
      planFingerprint: child.execution.planFingerprint,
      evaluatorKind: child.execution.evaluatorKind,
      compatibilityVersion: child.execution.compatibilityVersion,
      behaviorOutcome: child.execution.behaviorOutcome,
      finalOutcome,
      requiredChecks: statusChecks(child.execution.requiredChecks),
      evidenceRoot: durable.path === null ? null : member.durable.evidenceRoot,
      runRecordPath: durable.path,
      observationId:
        child.execution.record === null ? null : (member.observation?.observationId ?? null),
      issues: child.execution.issues.map((entry) => entry.code),
      durable,
    },
    diagnostics: child.execution.diagnostics,
  });
  return { child, durable, cli };
}

function emptySuiteDurableOutcome(
  partial: Partial<FinalSuiteAggregateDurableOutcome> = {},
): FinalSuiteAggregateDurableOutcome {
  return {
    required: partial.required ?? false,
    attempted: partial.attempted ?? false,
    wrote: partial.wrote ?? false,
    path: partial.path ?? null,
    serialized: partial.serialized ?? null,
    error: partial.error ?? null,
  };
}

function emptySuiteDetails(input: FinalSuiteActivePathInput): FinalSuiteActivePathCliDetails {
  return {
    suiteId: input.suiteId,
    suiteVersion: input.suiteVersion,
    declaredCaseCount: input.declaredCaseCount,
    executedCount: 0,
    canonicalOrder: input.members.map((member) => member.order),
    children: [],
    aggregateStatus: null,
    complete: false,
    pass: false,
    interrupted: input.interrupted === true,
    stoppedOnCleanup: input.stoppedOnCleanup === true,
    failedRecordOrders: [],
    suiteRecordPath: null,
    suiteRecordSchemaVersion: null,
    suiteDurable: emptySuiteDurableOutcome(),
    suiteChildReadback: [],
  };
}

/**
 * The suite-scoped child execution identity (ADR 0019 R11). It is deliberately
 * independent from the child's own `runId`: the run id names the child run
 * record, while the execution id names exactly one child slot inside one suite
 * execution, so an aggregate can never be assembled from an aliased identity.
 */
function suiteChildExecutionId(context: FinalSuiteAggregateContext, order: number): string {
  return `${context.suiteExecutionId}#${order}`;
}

/**
 * Reads back one child's durable strict-v4 public record, without coercing and
 * without ever throwing: an unreadable file, malformed JSON, a legacy/mixed
 * record, and a current record are all classified into the closed readback
 * vocabulary so a single bad child can never abort the whole suite path.
 */
function readBackSuiteChild(entry: FinalSuiteChildActivePathOutcome): FinalSuiteChildReadback {
  const order = entry.child.order;
  if (entry.child.execution.record === null) {
    // The child was explicitly refused before any record; it contributes its
    // already-classified verdict and no child record identity.
    return { order, required: entry.durable.required, kind: 'no-record-refusal', path: null };
  }
  if (!entry.durable.wrote || entry.durable.path === null) {
    return {
      order,
      required: entry.durable.required,
      kind: 'unreadable',
      path: entry.durable.path,
    };
  }
  let read: FinalPublicRecordReadResult;
  try {
    read = readFinalPublicRecordFile(entry.durable.path);
  } catch {
    return {
      order,
      required: entry.durable.required,
      kind: 'unreadable',
      path: entry.durable.path,
    };
  }
  const kind: FinalSuiteChildReadback['kind'] =
    read.kind === 'current-v4'
      ? 'current-v4'
      : read.legacy
        ? 'legacy'
        : read.kind === 'invalid' || read.kind === 'mixed' || read.kind === 'unknown'
          ? read.kind
          : 'mixed';
  return { order, required: entry.durable.required, kind, path: entry.durable.path };
}

/**
 * Builds the closed aggregate child entry for one independently read current-v4
 * child, or returns a refusal detail when the readback identity disagrees with
 * the child execution. The child's behavior and final outcome are preserved
 * verbatim; nothing is reconstructed, downgraded, or rewritten.
 */
function aggregateChildEntry(
  entry: FinalSuiteChildActivePathOutcome,
  member: FinalSuiteMemberInput,
  readback: FinalSuiteChildReadback,
  context: FinalSuiteAggregateContext,
): { readonly entry: FinalSuiteChildRecordV2 } | { readonly refusal: string } {
  const child = entry.child;
  const executionId = suiteChildExecutionId(context, child.order);
  if (readback.kind === 'no-record-refusal') {
    return {
      entry: {
        order: child.order,
        caseId: child.caseId,
        request: child.request,
        expectedOutcome: 'PASS',
        runId: member.runId,
        executionId,
        parentSuiteExecutionId: context.suiteExecutionId,
        suiteLineageId: context.suiteLineageId,
        recordPresent: false,
        childRecordLabel: 'no-record-refusal',
        childRecordSchemaVersion: null,
        childProfile: null,
        materializationFingerprint: null,
        planFingerprint: null,
        expectedMet: child.execution.finalOutcome === 'PASS',
        behaviorOutcome: child.execution.behaviorOutcome,
        finalOutcome: entry.cli.outcome ?? child.execution.finalOutcome,
        cleanupComplete: member.cleanupSucceeded,
        startedAt: member.startedAt ?? context.startedAt,
        endedAt: member.endedAt ?? context.endedAt,
        durationMs: member.durationMs ?? 0,
        runRecordRole: 'run-record',
      },
    };
  }
  if (readback.kind !== 'current-v4' || readback.path === null) {
    return {
      refusal: `Suite member ${child.order} did not read back as a current strict-v4 child (${readback.kind}).`,
    };
  }
  // Re-read is bounded: the file may have become unreadable after the summary
  // readback, so an I/O failure is a refusal, never an escaping error.
  let read: FinalPublicRecordReadResult;
  try {
    read = readFinalPublicRecordFile(readback.path);
  } catch (error) {
    return {
      refusal: `Suite member ${child.order} readback record could not be read: ${error instanceof Error ? error.message : String(error)}.`,
    };
  }
  if (read.kind !== 'current-v4') {
    return {
      refusal: `Suite member ${child.order} did not read back as a current strict-v4 child (${read.kind}).`,
    };
  }
  const record: FinalPublicRunRecordV4 = read.record;
  if (
    record.caseId !== child.caseId ||
    record.runId !== member.runId ||
    record.materializationFingerprint !== child.execution.materializationFingerprint ||
    record.planFingerprint !== child.execution.planFingerprint
  ) {
    return {
      refusal: `Suite member ${child.order} readback record identity does not agree with its own compiled case/run/plan identity.`,
    };
  }
  if (
    record.behaviorOutcome !== child.execution.behaviorOutcome ||
    record.finalOutcome !== child.execution.finalOutcome
  ) {
    return {
      refusal: `Suite member ${child.order} readback record outcome does not preserve its delivered behavior/final outcome verbatim.`,
    };
  }
  return {
    entry: {
      order: child.order,
      caseId: child.caseId,
      request: child.request,
      expectedOutcome: 'PASS',
      runId: member.runId,
      executionId,
      parentSuiteExecutionId: context.suiteExecutionId,
      suiteLineageId: context.suiteLineageId,
      recordPresent: true,
      childRecordLabel: 'current-v4',
      childRecordSchemaVersion: 4,
      childProfile: record.profile,
      materializationFingerprint: record.materializationFingerprint,
      planFingerprint: record.planFingerprint,
      expectedMet: child.execution.finalOutcome === 'PASS',
      behaviorOutcome: child.execution.behaviorOutcome,
      finalOutcome: child.execution.finalOutcome,
      cleanupComplete: member.cleanupSucceeded,
      startedAt: member.startedAt ?? context.startedAt,
      endedAt: member.endedAt ?? context.endedAt,
      durationMs: member.durationMs ?? 0,
      runRecordRole: 'run-record',
    },
  };
}

/**
 * Runs one representative-suite execution through the current final façade.
 * Each child keeps its own envelope and immutable identity; a refused suite
 * preflight, a refused aggregation, a failed child record write/readback, an
 * interruption, or an incomplete sequence all prevent a `PASS` aggregate.
 *
 * On a successful aggregation it writes each strict-v4 child, reads each child
 * back, assembles the closed v4-bound suite aggregate (schema version 2), writes
 * it exclusively, and returns the real `suiteRecordPath`. A required child
 * record or readback failure, or a required aggregate write failure, is a
 * finalization failure: it converts the suite outcome to `ENVIRONMENT_FAILURE`
 * and outranks every lower suite outcome without altering any child outcome.
 */
export function runFinalSuiteActivePath(
  input: FinalSuiteActivePathInput,
): FinalSuiteActivePathOutcome {
  const preflightIssues = preflightFinalSuite(input);
  if (preflightIssues.length > 0) {
    const detail = `Suite ${input.suiteId}@${input.suiteVersion} refused preflight: ${preflightIssues.join('; ')}.`;
    return {
      preflight: { ok: false, issues: preflightIssues },
      children: [],
      childReadback: [],
      aggregation: null,
      suite: {
        record: null,
        durable: emptySuiteDurableOutcome(),
        acceptedChildOrders: [],
        refusedChildOrders: [],
      },
      finalOutcome: 'HARNESS_BLOCKED',
      cli: projectFinalCliResult<FinalSuiteActivePathCliDetails>({
        command: 'diagnostic',
        subcommand: input.suiteId,
        status: 'HARNESS_BLOCKED',
        outcome: 'HARNESS_BLOCKED',
        detail,
        launchAttempted: false,
        details: emptySuiteDetails(input),
        diagnostics: [],
      }),
    };
  }

  const children = input.members.map(runFinalSuiteChild);
  const aggregation = aggregateSuiteChildren({
    declaredCaseCount: input.declaredCaseCount,
    children: children.map((entry) => entry.child),
    interrupted: input.interrupted === true,
    stoppedOnCleanup: input.stoppedOnCleanup === true,
  });
  const childReadback = children.map(readBackSuiteChild);
  const failedRecordOrders = children
    .filter((entry) => entry.durable.required && !entry.durable.wrote)
    .map((entry) => entry.child.order);

  // Assemble the v4-bound aggregate only from an accepted aggregation and only
  // when every record-bearing child independently read back as a current
  // strict-v4 child. Any refusal means no aggregate is written.
  let suiteRecord: FinalSuiteRecordV2 | null = null;
  let suiteDurable = emptySuiteDurableOutcome();
  const acceptedChildOrders: number[] = [];
  const refusedChildOrders: number[] = [];
  if (aggregation.ok) {
    const entries: FinalSuiteChildRecordV2[] = [];
    let refusal: string | null = null;
    input.members.forEach((member, index) => {
      const childEntry = children[index];
      const readback = childReadback[index];
      if (childEntry === undefined || readback === undefined) {
        refusal = refusal ?? 'A suite member was missing its execution or readback facts.';
        return;
      }
      const built = aggregateChildEntry(childEntry, member, readback, input.aggregate);
      if ('refusal' in built) {
        refusal = refusal ?? built.refusal;
        refusedChildOrders.push(childEntry.child.order);
        return;
      }
      entries.push(built.entry);
      acceptedChildOrders.push(childEntry.child.order);
    });

    if (refusal !== null) {
      suiteDurable = emptySuiteDurableOutcome({ required: true, error: refusal });
    } else {
      const complete = aggregation.decision.complete;
      const interrupted = input.interrupted === true;
      const stoppedOnCleanup = input.stoppedOnCleanup === true;
      const aggregateDetail = `Suite ${input.suiteId}@${input.suiteVersion}: ${children.length}/${input.declaredCaseCount} children executed; aggregate ${aggregation.decision.finalStatus}.`;
      const writer = input.writeSuiteRecord ?? writeFinalSuiteRecordV2;
      try {
        const written = writer({
          payload: {
            suiteExecutionId: input.aggregate.suiteExecutionId,
            suiteLineageId: input.aggregate.suiteLineageId,
            suiteId: input.suiteId as FinalSuiteRecordV2['suiteId'],
            suiteVersion: input.suiteVersion,
            suiteFingerprint: input.aggregate.suiteFingerprint,
            profile: 'diagnostic',
            execution: 'sequential-independent-runs',
            repository: input.aggregate.repository,
            declaredCaseCount: input.declaredCaseCount,
            executedCount: children.length,
            canonicalOrder: children.map((entry) => entry.child.order),
            children: entries,
            complete,
            stoppedEarly: !complete || interrupted || stoppedOnCleanup,
            stopReason: input.aggregate.stopReason ?? null,
            interrupted,
            aggregateStatus: aggregation.decision.finalStatus,
            startedAt: input.aggregate.startedAt,
            endedAt: input.aggregate.endedAt,
            durationMs: input.aggregate.durationMs,
            detail: aggregateDetail,
          },
          evidenceRoot: input.suiteDurable.evidenceRoot,
          forbiddenPaths: input.suiteDurable.forbiddenPaths ?? [],
          ...(input.aggregate.recordedAt === undefined
            ? {}
            : { recordedAt: input.aggregate.recordedAt }),
        });
        suiteRecord = written.record;
        suiteDurable = emptySuiteDurableOutcome({
          required: true,
          attempted: true,
          wrote: true,
          path: written.path,
          serialized: written.serialized,
        });
      } catch (error) {
        suiteDurable = emptySuiteDurableOutcome({
          required: true,
          attempted: true,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // ENVIRONMENT_FAILURE precedence: a required child record that did not reach
  // disk, a required child readback that did not classify as a current strict-v4
  // child, or a required aggregate write that did not reach disk is a
  // finalization failure. It outranks every lower suite outcome (PASS, BUG,
  // HARNESS_BLOCKED) and can never be reported as a `PASS`.
  const requiredReadFailures = childReadback.filter(
    (entry) => entry.kind !== 'current-v4' && entry.kind !== 'no-record-refusal',
  );
  const finalizationFailed =
    failedRecordOrders.length > 0 ||
    requiredReadFailures.length > 0 ||
    (suiteDurable.required && !suiteDurable.wrote);
  const aggregatedOutcome: Outcome = aggregation.ok
    ? aggregation.decision.finalStatus
    : 'HARNESS_BLOCKED';
  const finalOutcome: Outcome = finalizationFailed ? 'ENVIRONMENT_FAILURE' : aggregatedOutcome;

  const aggregateStatus: FinalSuiteAggregateStatus | null = aggregation.ok
    ? aggregation.decision.finalStatus
    : null;
  const details: FinalSuiteActivePathCliDetails = {
    suiteId: input.suiteId,
    suiteVersion: input.suiteVersion,
    declaredCaseCount: input.declaredCaseCount,
    executedCount: children.length,
    canonicalOrder: children.map((entry) => entry.child.order),
    children: aggregation.ok ? aggregation.decision.children : [],
    aggregateStatus,
    complete: aggregation.ok ? aggregation.decision.complete : false,
    pass:
      aggregation.ok && finalOutcome === 'PASS' && aggregation.decision.pass && suiteDurable.wrote,
    interrupted: input.interrupted === true,
    stoppedOnCleanup: input.stoppedOnCleanup === true,
    failedRecordOrders,
    suiteRecordPath: suiteDurable.wrote ? suiteDurable.path : null,
    suiteRecordSchemaVersion: suiteRecord === null ? null : suiteRecord.schemaVersion,
    suiteDurable,
    suiteChildReadback: childReadback,
  };
  const detail = `Suite ${input.suiteId}@${input.suiteVersion}: ${children.length}/${input.declaredCaseCount} children executed; aggregate ${finalOutcome}${
    aggregation.ok ? '' : ` (refused: ${aggregation.issues.map((entry) => entry.code).join(', ')})`
  }${suiteDurable.wrote ? '' : suiteDurable.error === null ? '' : ` (aggregate refused: ${suiteDurable.error})`}.`;

  return {
    preflight: { ok: true, issues: [] },
    children,
    childReadback,
    aggregation,
    suite: { record: suiteRecord, durable: suiteDurable, acceptedChildOrders, refusedChildOrders },
    finalOutcome,
    cli: projectFinalCliResult<FinalSuiteActivePathCliDetails>({
      command: 'diagnostic',
      subcommand: input.suiteId,
      status: finalStatusForOutcome(finalOutcome),
      outcome: finalOutcome,
      detail,
      launchAttempted: children.some((entry) => entry.child.execution.launchAttempted),
      details,
      diagnostics: [],
    }),
  };
}

// ── Doctor and production-absence command contexts ───────────────────────────

export interface FinalCommandActivePathInput {
  readonly input: CommandExecutionContextInput;
  readonly operational: FinalActivePathCommandOperationals;
  readonly durable: FinalActivePathDurableSink;
  readonly writeRecord?: FinalActivePathCommandRecordWriter;
}

export interface FinalCommandActivePathCliDetails {
  readonly command: CommandCheckContext;
  readonly runId: string;
  readonly authoritative: boolean;
  readonly preauthority: boolean;
  readonly behaviorOutcome: Outcome | null;
  readonly finalOutcome: Outcome;
  readonly requiredChecks: readonly { readonly checkId: string; readonly status: string }[];
  readonly evidenceRoot: string | null;
  readonly runRecordPath: string | null;
  readonly issues: readonly string[];
  readonly durable: FinalActivePathDurableOutcome;
}

export interface FinalCommandActivePathOutcome {
  readonly execution: CommandExecutionOutcome;
  readonly durable: FinalActivePathDurableOutcome;
  readonly finalOutcome: Outcome;
  readonly cli: FinalActivePathCliResult<FinalCommandActivePathCliDetails>;
}

function runFinalCommandActivePath(
  executor: (input: CommandExecutionContextInput) => CommandExecutionOutcome,
  input: FinalCommandActivePathInput,
): FinalCommandActivePathOutcome {
  const execution = executor(input.input);
  const durable = finalizeCommandRecord(
    execution,
    input.operational,
    input.durable,
    input.writeRecord,
  );
  const finalOutcome = applyFinalizationPrecedence(execution.finalOutcome, durable);
  const detail =
    durable.required && !durable.wrote
      ? `${execution.command} outcome ${execution.finalOutcome} could not be finalized: ${durable.error ?? 'unknown finalization failure'}; final outcome ${finalOutcome}.`
      : execution.record === null
        ? `${execution.command} ${finalOutcome}: no command record was produced (pre-authority refusal).`
        : `${execution.command} ${finalOutcome} (behavior ${execution.behaviorOutcome ?? 'none'}); strict v4 command record written.`;
  const cli = projectFinalCliResult<FinalCommandActivePathCliDetails>({
    command: execution.command,
    status: finalStatusForOutcome(finalOutcome),
    outcome: finalOutcome,
    detail,
    launchAttempted: execution.record !== null,
    details: {
      command: execution.command,
      runId: input.operational.runId,
      authoritative: execution.authoritative,
      preauthority: execution.preauthority,
      behaviorOutcome: execution.behaviorOutcome,
      finalOutcome,
      requiredChecks: statusChecks(execution.requiredChecks),
      evidenceRoot: durable.path === null ? null : input.durable.evidenceRoot,
      runRecordPath: durable.path,
      issues: execution.issues.map((entry) => entry.code),
      durable,
    },
    diagnostics: execution.diagnostics,
  });
  return { execution, durable, finalOutcome, cli };
}

/** Runs the Doctor command context through the current final façade. */
export function runFinalDoctorActivePath(
  input: FinalCommandActivePathInput,
): FinalCommandActivePathOutcome {
  return runFinalCommandActivePath(executeDoctorCommandContext, input);
}

/** Runs the production-absence command context through the current final façade. */
export function runFinalProductionAbsenceActivePath(
  input: FinalCommandActivePathInput,
): FinalCommandActivePathOutcome {
  return runFinalCommandActivePath(executeProductionAbsenceCommandContext, input);
}

/** Type-level guard: a produced public record is exactly one of the two v4 families. */
export type FinalActivePathPublicRecord = FinalPublicRecordV4;

/** Re-exported for the façade consumers that adapt an already-assembled command. */
export type { FinalCommandCheckRecordV4 };

import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  closeSync,
} from 'node:fs';
import path from 'node:path';

import { canonicalize, sha256Hex } from '../canonical/canonicalize';
import { createGovernanceTiming, isGovernanceTiming } from '../contracts/governance-timing';
import type {
  ExecutableManifestValidationContext,
  ExecutableSelectionManifestDraftV1,
} from '../contracts/executable-selection-manifest';
import {
  QUALIFICATION_ATTEMPTS_PER_CELL,
  QUALIFICATION_RUNTIME_SCHEMA_VERSION,
  type PrepareQualificationBatchInput,
  type QualificationAttemptResult,
  type QualificationBatchV1,
  type QualificationFailureCode,
  type QualificationRuntimeResult,
  type VerifiedQualificationBatchV1,
} from '../contracts/qualification-runtime';
import type { CliResult } from '../contracts/runtime';
import { validateExecutableSelectionManifest } from './executable-selection-manifest';
import {
  appendQualificationEvent,
  claimQualificationBatch,
  createQualificationBatchDirectory,
  QualificationLedgerError,
  readQualificationLedger,
} from './qualification-ledger';
import {
  compilePreparedExecutionCandidate,
  runDiagnosticCommand,
  type PreparedExecutionCandidate,
} from '../cli/diagnostic';
import { readFinalPublicRecord } from '../contracts/final-public-record';
import { verifyEvidenceRoot, createCurrentTreeProvenanceProvider } from '../evidence/integrity';
import {
  collectRepositoryProvenanceInputs,
  governedTreeDigestFromCollectedInputs,
} from '../evidence/provenance-collector';
import { resolveRepoRoot, resolveSkillRoot, isSafeRunId } from '../runtime/paths';
import { createNodeEvidenceVerifyFsAdapter } from '../evidence/integrity';
import type { FinalPublicRunRecordV4 } from '../contracts/final-public-record';
import { FINAL_PUBLIC_RECORD_SCHEMA_VERSION } from '../contracts/final-public-record';
import type { Outcome } from '../contracts/discriminants';

const MAX_CHILD_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_RUNNER_DETAIL = 'Qualification attempt failed closed.';

export interface QualificationRuntimeDependencies {
  readonly skillRoot: string;
  readonly repoRoot: string;
  readonly loadContext: () => ExecutableManifestValidationContext;
  readonly compileCandidate: (
    request: unknown,
  ) => ReturnType<typeof compilePreparedExecutionCandidate>;
  readonly runCandidate: (input: {
    preparedCandidate: PreparedExecutionCandidate;
    expectedIdentity: PreparedExecutionCandidate['identity'];
    runId: string;
  }) => Promise<CliResult<unknown>>;
  readonly collectSourceDigest: () => string;
  readonly readAndVerifyChild: (runId: string) => VerifiedChild;
  readonly makeId: () => string;
  readonly monotonicNow?: () => number;
  readonly wallNow?: () => string;
}

export interface VerifiedChild {
  readonly valid: boolean;
  readonly recordDigest: string | null;
  readonly evidenceDigest?: string | null;
  readonly outcome: Outcome | null;
  readonly cleanupVerified: boolean;
  readonly evidenceVerified: boolean;
  readonly code: QualificationFailureCode | null;
  readonly runId?: string;
  readonly caseId?: string;
  readonly materializationFingerprint?: string;
  readonly planFingerprint?: string;
  readonly cellId?: string;
  readonly profile?: string;
  readonly provenance?: string;
  readonly evidenceDepth?: string;
}

export interface QualificationRuntimeOptions {
  readonly dependencies?: Partial<QualificationRuntimeDependencies>;
}

function productionDependencies(): QualificationRuntimeDependencies {
  const skillRoot = realpathSync(resolveSkillRoot());
  const repoRoot = realpathSync(resolveRepoRoot());
  return {
    skillRoot,
    repoRoot,
    loadContext: () => {
      throw new Error('Qualification CLI must provide the current manifest context.');
    },
    compileCandidate: compilePreparedExecutionCandidate,
    runCandidate: ({ preparedCandidate, expectedIdentity, runId }) =>
      runDiagnosticCommand({ preparedCandidate, expectedIdentity, runId }),
    collectSourceDigest: () => sourceProvenanceDigest(repoRoot),
    readAndVerifyChild: (runId) => readAndVerifyDiagnosticChild(skillRoot, runId, repoRoot),
    makeId: randomUUID,
    monotonicNow: () => performance.now(),
    wallNow: () => new Date().toISOString(),
  };
}

function dependencies(options: QualificationRuntimeOptions): QualificationRuntimeDependencies {
  const base = productionDependencies();
  return { ...base, ...options.dependencies };
}

interface TimingSession {
  lastMonotonicSample: number | null;
  invalid: boolean;
}

function monotonicSample(deps: QualificationRuntimeDependencies, session: TimingSession): number {
  if (session.invalid) return Number.NaN;
  try {
    const value = (deps.monotonicNow ?? (() => performance.now()))();
    if (
      !Number.isFinite(value) ||
      value < 0 ||
      (session.lastMonotonicSample !== null && value < session.lastMonotonicSample)
    ) {
      session.invalid = true;
      return Number.NaN;
    }
    session.lastMonotonicSample = value;
    return value;
  } catch {
    session.invalid = true;
    return Number.NaN;
  }
}

function beginTiming(
  deps: QualificationRuntimeDependencies,
  session: TimingSession,
): {
  readonly monotonicStart: number;
  readonly wallStart: string;
} {
  try {
    return {
      monotonicStart: monotonicSample(deps, session),
      wallStart: (deps.wallNow ?? (() => new Date().toISOString()))(),
    };
  } catch {
    return { monotonicStart: Number.NaN, wallStart: '' };
  }
}

function finishTiming(
  deps: QualificationRuntimeDependencies,
  start: ReturnType<typeof beginTiming>,
  session: TimingSession,
) {
  try {
    const monotonicEnd = monotonicSample(deps, session);
    if (session.invalid) return null;
    return createGovernanceTiming({
      ...start,
      monotonicEnd,
      wallEnd: (deps.wallNow ?? (() => new Date().toISOString()))(),
    });
  } catch {
    return null;
  }
}

function sourceProvenanceDigest(repoRoot: string): string {
  const collected = collectRepositoryProvenanceInputs({ repoRoot });
  return sha256Hex(
    canonicalize({
      revision: collected.repositoryRevision,
      dirtyPolicy: collected.dirtyPolicy,
      governedTreeDigest: governedTreeDigestFromCollectedInputs(collected),
      lockfileDigest: collected.lockfileDigest,
    }),
  );
}

function readChildRecord(
  skillRoot: string,
  runId: string,
): { readonly bytes: string; readonly record: FinalPublicRunRecordV4 } | null {
  if (!isSafeRunId(runId)) return null;
  const root = path.join(skillRoot, 'evidence', 'runs', runId);
  const recordPath = path.join(root, 'run-record.json');
  try {
    const evidenceRootStat = lstatSync(root);
    if (
      !evidenceRootStat.isDirectory() ||
      evidenceRootStat.isSymbolicLink() ||
      realpathSync(root) !== root
    )
      return null;
    const fd = openSync(
      recordPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.nlink !== 1 || before.size > MAX_CHILD_RECORD_BYTES)
        return null;
      const buffer = Buffer.alloc(before.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const count = readSync(fd, buffer, offset, buffer.length - offset, null);
        if (count === 0) break;
        offset += count;
      }
      const after = fstatSync(fd);
      if (
        offset !== before.size ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ino !== after.ino
      )
        return null;
      const bytes = buffer.subarray(0, offset).toString('utf8');
      const parsed: unknown = JSON.parse(bytes);
      const view = readFinalPublicRecord(parsed);
      if (view.kind !== 'current-v4' || view.record.command !== 'diagnostic') return null;
      return { bytes, record: view.record };
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

function readAndVerifyChild(skillRoot: string, runId: string, repoRoot: string): VerifiedChild {
  const read = readChildRecord(skillRoot, runId);
  if (!read) {
    return {
      valid: false,
      recordDigest: null,
      outcome: null,
      cleanupVerified: false,
      evidenceVerified: false,
      code: 'CHILD_RECORD_INVALID',
    };
  }
  const record = read.record;
  const cleanupVerified =
    record.cleanup !== null &&
    record.cleanup.runId === runId &&
    record.cleanup.attempted &&
    record.cleanup.complete &&
    record.cleanup.facts.evidencePreserved;
  const evidence = verifyEvidenceRoot(
    { requestedId: runId },
    {
      evidenceBaseDir: path.join(skillRoot, 'evidence'),
      fs: createNodeEvidenceVerifyFsAdapter(),
      forbiddenRoots: [repoRoot, skillRoot],
      currentTree: createCurrentTreeProvenanceProvider({ repoRoot }),
    },
  );
  const evidenceVerified =
    evidence.transaction.creditEligible &&
    evidence.transaction.strictRecordPresent &&
    evidence.provenance.currentTreeCheck === 'PASS' &&
    evidence.provenance.currentTreeCreditEligible &&
    evidence.checks.every((check) => check.result === 'PASS');
  const valid =
    record.schemaVersion === FINAL_PUBLIC_RECORD_SCHEMA_VERSION &&
    record.runId === runId &&
    record.profile === 'release' &&
    record.provenance === 'manifest' &&
    record.evidenceDepth === 'standard' &&
    cleanupVerified &&
    evidenceVerified;
  return {
    valid,
    recordDigest: sha256Hex(canonicalize(record)),
    evidenceDigest: sha256Hex(canonicalize(evidence)),
    outcome: record.finalOutcome,
    cleanupVerified,
    evidenceVerified,
    code: !cleanupVerified
      ? 'CLEANUP_INVALID'
      : !evidenceVerified
        ? 'EVIDENCE_INVALID'
        : !valid
          ? 'CHILD_RECORD_INVALID'
          : null,
    runId: record.runId,
    caseId: record.caseId,
    materializationFingerprint: record.materializationFingerprint,
    planFingerprint: record.planFingerprint,
    cellId: record.environmentCellId,
    profile: record.profile,
    provenance: record.provenance,
    evidenceDepth: record.evidenceDepth,
  };
}

/** Shared actual strict-v4 Diagnostic record, cleanup, evidence, and current-tree verifier. */
export function readAndVerifyDiagnosticChild(
  skillRoot: string,
  runId: string,
  repoRoot: string,
): VerifiedChild {
  return readAndVerifyChild(skillRoot, runId, repoRoot);
}

function manifestContext(
  deps: QualificationRuntimeDependencies,
): ExecutableManifestValidationContext {
  return deps.loadContext();
}

function validateCandidate(
  draft: ExecutableSelectionManifestDraftV1,
  deps: QualificationRuntimeDependencies,
): QualificationFailureCode | null {
  try {
    return validateExecutableSelectionManifest(draft, manifestContext(deps)).valid
      ? null
      : 'CANDIDATE_DRIFT';
  } catch {
    return 'CANDIDATE_INVALID';
  }
}

function profileIdentityMatches(
  entry: ExecutableSelectionManifestDraftV1['content']['entries'][number],
  candidate: PreparedExecutionCandidate,
): boolean {
  return (
    candidate.planning.request.profile === 'release' &&
    candidate.planning.request.provenance === 'manifest' &&
    candidate.planning.request.evidenceDepth === 'standard' &&
    candidate.identity.caseId === entry.caseId &&
    candidate.identity.materializationFingerprint === entry.materializationFingerprint &&
    candidate.identity.planFingerprint === entry.planFingerprint &&
    candidate.identity.cellId === entry.cell.cellId &&
    candidate.requestDigest === entry.requestDigest
  );
}

function fingerprintBatch(input: Omit<QualificationBatchV1, 'batchFingerprint'>): string {
  return sha256Hex(canonicalize(input));
}

function validateFrozenBatch(
  batch: QualificationBatchV1,
  deps: QualificationRuntimeDependencies,
): QualificationFailureCode | null {
  try {
    const expectedKeys = [
      'schemaVersion',
      'batchId',
      'batchFingerprint',
      'manifestId',
      'manifestFingerprint',
      'candidate',
      'requiredCellIds',
      'selectedEntryIds',
      'selectionRationale',
      'sourceProvenanceDigest',
      'slots',
      'predecessorBatchId',
      'correctionRationale',
    ];
    if (
      !hasExactKeys(batch, expectedKeys) ||
      batch.schemaVersion !== QUALIFICATION_RUNTIME_SCHEMA_VERSION ||
      !/^qbatch-[0-9a-f-]{36}$/.test(batch.batchId)
    )
      return 'LEDGER_INVALID';
    if (
      !Array.isArray(batch.requiredCellIds) ||
      batch.requiredCellIds.length !== 1 ||
      !Array.isArray(batch.selectedEntryIds) ||
      batch.selectedEntryIds.length !== QUALIFICATION_ATTEMPTS_PER_CELL ||
      new Set(batch.selectedEntryIds).size !== QUALIFICATION_ATTEMPTS_PER_CELL ||
      !Array.isArray(batch.slots) ||
      batch.slots.length !== QUALIFICATION_ATTEMPTS_PER_CELL
    )
      return 'ENTRY_SELECTION_INVALID';
    if (
      typeof batch.selectionRationale !== 'string' ||
      batch.selectionRationale.trim().length === 0 ||
      typeof batch.sourceProvenanceDigest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(batch.sourceProvenanceDigest)
    )
      return 'LEDGER_INVALID';
    if (
      (batch.predecessorBatchId === null) !== (batch.correctionRationale === null) ||
      (batch.correctionRationale !== null && batch.correctionRationale.trim().length === 0)
    )
      return 'LEDGER_INVALID';
    if (
      batch.candidate.manifestId !== batch.manifestId ||
      batch.candidate.contentFingerprint !== batch.manifestFingerprint ||
      validateCandidate(batch.candidate, deps) !== null
    )
      return 'CANDIDATE_DRIFT';
    const entries = new Map(batch.candidate.content.entries.map((entry) => [entry.entryId, entry]));
    const instanceIds = new Set<string>();
    const runIds = new Set<string>();
    for (let index = 0; index < QUALIFICATION_ATTEMPTS_PER_CELL; index += 1) {
      const slot = batch.slots[index];
      if (
        !slot ||
        !hasExactKeys(slot, [
          'ordinal',
          'instanceId',
          'runId',
          'entryId',
          'cell',
          'requestDigest',
          'caseId',
          'materializationFingerprint',
          'planFingerprint',
          'executionProfileIdentity',
        ])
      )
        return 'LEDGER_INVALID';
      const entryId = batch.selectedEntryIds[index];
      const entry = typeof entryId === 'string' ? entries.get(entryId) : undefined;
      if (
        !entry ||
        slot.ordinal !== index + 1 ||
        slot.entryId !== entryId ||
        slot.cell.cellId !== batch.requiredCellIds[0] ||
        canonicalize(slot.cell) !== canonicalize(entry.cell) ||
        slot.requestDigest !== entry.requestDigest ||
        slot.caseId !== entry.caseId ||
        slot.materializationFingerprint !== entry.materializationFingerprint ||
        slot.planFingerprint !== entry.planFingerprint ||
        slot.executionProfileIdentity !== entry.executionProfileIdentity
      )
        return 'PLAN_DRIFT';
      if (
        typeof slot.instanceId !== 'string' ||
        !/^qinstance-[0-9a-f-]{36}$/.test(slot.instanceId) ||
        !isSafeRunId(slot.runId) ||
        !slot.runId.startsWith('qual-') ||
        instanceIds.has(slot.instanceId) ||
        runIds.has(slot.runId)
      )
        return 'LEDGER_INVALID';
      instanceIds.add(slot.instanceId);
      runIds.add(slot.runId);
    }
    const { batchFingerprint, ...fingerprintedContent } = batch;
    const fingerprint = fingerprintBatch(fingerprintedContent);
    if (fingerprint !== batch.batchFingerprint) return 'LEDGER_INVALID';
    return null;
  } catch {
    return 'LEDGER_INVALID';
  }
}

function hasExactKeys(value: unknown, expected: readonly string[]): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => typeof key === 'string' && expected.includes(key))
  );
}

function makeBatchId(id: string): string {
  return `qbatch-${id}`;
}

export function prepareQualificationBatch(
  input: PrepareQualificationBatchInput,
  options: QualificationRuntimeOptions = {},
):
  | { readonly ok: true; readonly batch: QualificationBatchV1 }
  | { readonly ok: false; readonly code: QualificationFailureCode } {
  const deps = dependencies(options);
  if (
    !Array.isArray(input.entryIds) ||
    input.entryIds.length !== QUALIFICATION_ATTEMPTS_PER_CELL ||
    new Set(input.entryIds).size !== QUALIFICATION_ATTEMPTS_PER_CELL ||
    input.entryIds.some((id) => typeof id !== 'string' || id.length === 0) ||
    typeof input.selectionRationale !== 'string' ||
    input.selectionRationale.trim().length === 0
  ) {
    return { ok: false, code: 'ENTRY_SELECTION_INVALID' };
  }
  const invalid = validateCandidate(input.draft, deps);
  if (invalid) return { ok: false, code: invalid };
  const content = input.draft.content;
  const entryMap = new Map(content.entries.map((entry) => [entry.entryId, entry]));
  if (input.entryIds.some((entryId) => !entryMap.has(entryId)))
    return { ok: false, code: 'ENTRY_SELECTION_INVALID' };
  const sourceDigest = deps.collectSourceDigest();
  const requiredCell = content.requiredCell;
  const frozen: Omit<QualificationBatchV1['slots'][number], 'instanceId' | 'runId'>[] = [];
  for (let index = 0; index < input.entryIds.length; index += 1) {
    const entry = entryMap.get(input.entryIds[index] as string);
    if (!entry) return { ok: false, code: 'ENTRY_SELECTION_INVALID' };
    if (entry.cell.cellId !== requiredCell.cellId)
      return { ok: false, code: 'ENTRY_SELECTION_INVALID' };
    let compiled: ReturnType<typeof compilePreparedExecutionCandidate>;
    try {
      compiled = deps.compileCandidate(entry.request);
    } catch {
      return { ok: false, code: 'PLAN_DRIFT' };
    }
    if (!compiled.ok || !profileIdentityMatches(entry, compiled.candidate))
      return { ok: false, code: 'PLAN_DRIFT' };
    frozen.push({
      ordinal: index + 1,
      entryId: entry.entryId,
      cell: entry.cell,
      requestDigest: entry.requestDigest,
      caseId: entry.caseId,
      materializationFingerprint: entry.materializationFingerprint,
      planFingerprint: entry.planFingerprint,
      executionProfileIdentity: entry.executionProfileIdentity,
    });
  }
  if (deps.collectSourceDigest() !== sourceDigest) return { ok: false, code: 'SOURCE_DRIFT' };
  const batchId = makeBatchId(deps.makeId());
  const requiredCellIds = [requiredCell.cellId];
  const slots = frozen.map((slot) => ({
    ...slot,
    instanceId: `qinstance-${deps.makeId()}`,
    runId: `qual-${deps.makeId()}`,
  }));
  if (
    slots.some((slot) => !isSafeRunId(slot.runId)) ||
    new Set(slots.map((slot) => slot.runId)).size !== slots.length
  )
    return { ok: false, code: 'CANDIDATE_INVALID' };
  const fingerprintInput = {
    schemaVersion: QUALIFICATION_RUNTIME_SCHEMA_VERSION,
    batchId,
    manifestId: input.draft.manifestId,
    manifestFingerprint: input.draft.contentFingerprint,
    candidate: input.draft,
    requiredCellIds,
    selectedEntryIds: [...input.entryIds],
    selectionRationale: input.selectionRationale.trim(),
    sourceProvenanceDigest: sourceDigest,
    slots,
    predecessorBatchId: input.predecessorBatchId ?? null,
    correctionRationale: input.correctionRationale?.trim() || null,
  };
  const batchFingerprint = fingerprintBatch(fingerprintInput);
  const batch: QualificationBatchV1 = {
    schemaVersion: QUALIFICATION_RUNTIME_SCHEMA_VERSION,
    batchId,
    batchFingerprint,
    manifestId: input.draft.manifestId,
    manifestFingerprint: input.draft.contentFingerprint,
    candidate: input.draft,
    requiredCellIds,
    selectedEntryIds: [...input.entryIds],
    selectionRationale: input.selectionRationale.trim(),
    sourceProvenanceDigest: sourceDigest,
    slots,
    predecessorBatchId: input.predecessorBatchId ?? null,
    correctionRationale: input.correctionRationale?.trim() || null,
  };
  try {
    createQualificationBatchDirectory(deps.skillRoot, batch);
  } catch {
    return { ok: false, code: 'LEDGER_INVALID' };
  }
  return { ok: true, batch };
}

function resultFor(
  batch: QualificationBatchV1,
  state: QualificationRuntimeResult['state'],
  failureCode: QualificationFailureCode | null,
  attempts: readonly QualificationAttemptResult[],
): QualificationRuntimeResult {
  return {
    batchId: batch.batchId,
    batchFingerprint: batch.batchFingerprint,
    state,
    failureCode,
    attempts,
    releaseCredit: false,
  };
}

function finalAssessmentFromRecords(
  records: ReturnType<typeof readQualificationLedger>,
): 'REVIEW_READY' | 'FAILED' | 'INTERRUPTED' | null {
  const final = records.at(-1)?.event;
  return final?.type === 'batch-assessed' ? final.state : null;
}

export async function runQualificationBatch(
  batchId: string,
  options: QualificationRuntimeOptions = {},
): Promise<QualificationRuntimeResult | null> {
  const deps = dependencies(options);
  let records: ReturnType<typeof readQualificationLedger>;
  try {
    records = readQualificationLedger(deps.skillRoot, batchId);
  } catch {
    return null;
  }
  const first = records[0]?.event;
  if (!first || first.type !== 'batch-predeclared') return null;
  const batch = first.batch;
  if (
    records.length !== 1 ||
    batch.batchId !== batchId ||
    finalAssessmentFromRecords(records) !== null
  )
    return null;
  if (validateFrozenBatch(batch, deps) !== null) return null;
  try {
    claimQualificationBatch(deps.skillRoot, batchId, batch.batchFingerprint);
    appendQualificationEvent(deps.skillRoot, batchId, {
      type: 'batch-started',
      batchFingerprint: batch.batchFingerprint,
    });
  } catch {
    return resultFor(batch, 'FAILED', 'BATCH_ALREADY_CONSUMED', []);
  }
  const attempts: QualificationAttemptResult[] = [];
  const timingSession: TimingSession = { lastMonotonicSample: null, invalid: false };
  const batchTimingStart = beginTiming(deps, timingSession);
  const slotElapsedTimes: number[] = [];
  let failureCode: QualificationFailureCode | null = null;
  try {
    if (deps.collectSourceDigest() !== batch.sourceProvenanceDigest)
      throw Object.assign(new Error(), { qualificationCode: 'SOURCE_DRIFT' as const });
    for (const slot of batch.slots) {
      if (deps.collectSourceDigest() !== batch.sourceProvenanceDigest)
        throw Object.assign(new Error(), { qualificationCode: 'SOURCE_DRIFT' as const });
      const currentDraft = loadFrozenDraft(batch, deps);
      const entry = currentDraft.content.entries.find(
        (candidate) => candidate.entryId === slot.entryId,
      );
      if (!entry)
        throw Object.assign(new Error(), { qualificationCode: 'CANDIDATE_DRIFT' as const });
      const compiled = deps.compileCandidate(entry.request);
      if (
        !compiled.ok ||
        !profileIdentityMatches(entry, compiled.candidate) ||
        !slotMatches(slot, compiled.candidate)
      )
        throw Object.assign(new Error(), { qualificationCode: 'PLAN_DRIFT' as const });
      if (deps.collectSourceDigest() !== batch.sourceProvenanceDigest)
        throw Object.assign(new Error(), { qualificationCode: 'SOURCE_DRIFT' as const });
      const slotTimingStart = beginTiming(deps, timingSession);
      if (timingSession.invalid)
        throw Object.assign(new Error(), { qualificationCode: 'TIMING_INVALID' as const });
      appendQualificationEvent(deps.skillRoot, batchId, {
        type: 'instance-started',
        ordinal: slot.ordinal,
        instanceId: slot.instanceId,
        runId: slot.runId,
      });
      let cliResult: CliResult<unknown>;
      try {
        cliResult = await deps.runCandidate({
          preparedCandidate: compiled.candidate,
          expectedIdentity: compiled.candidate.identity,
          runId: slot.runId,
        });
      } catch {
        const timing = finishTiming(deps, slotTimingStart, timingSession);
        const attempt: QualificationAttemptResult = {
          ordinal: slot.ordinal,
          instanceId: slot.instanceId,
          runId: slot.runId,
          outcome: null,
          evidenceVerified: false,
          cleanupVerified: false,
          failureCode: 'EXECUTION_INTERRUPTED',
        };
        attempts.push(attempt);
        appendQualificationEvent(deps.skillRoot, batchId, {
          type: 'instance-finished',
          ordinal: slot.ordinal,
          instanceId: slot.instanceId,
          runId: slot.runId,
          outcome: null,
          recordDigest: null,
          evidenceDigest: null,
          evidenceVerified: false,
          cleanupVerified: false,
          failureCode: 'EXECUTION_INTERRUPTED',
          ...(timing === null ? {} : { timing }),
        });
        throw Object.assign(new Error(), { qualificationCode: 'EXECUTION_INTERRUPTED' as const });
      }
      let verified: VerifiedChild;
      try {
        verified = deps.readAndVerifyChild(slot.runId);
      } catch {
        verified = {
          valid: false,
          recordDigest: null,
          outcome: null,
          cleanupVerified: false,
          evidenceVerified: false,
          code: 'CHILD_RECORD_INVALID',
        };
      }
      const timing = finishTiming(deps, slotTimingStart, timingSession);
      const persistedIdentityMatches =
        verified.runId === slot.runId &&
        verified.caseId === slot.caseId &&
        verified.materializationFingerprint === slot.materializationFingerprint &&
        verified.planFingerprint === slot.planFingerprint &&
        verified.cellId === slot.cell.cellId &&
        verified.profile === 'release' &&
        verified.provenance === 'manifest' &&
        verified.evidenceDepth === 'standard';
      const outcome = verified.outcome;
      const cliOutcome = resultOutcome(cliResult.status);
      const attemptFailure =
        !persistedIdentityMatches || outcome === null || cliOutcome !== outcome
          ? 'CHILD_RECORD_INVALID'
          : !verified.valid
            ? (verified.code ?? 'CHILD_RECORD_INVALID')
            : outcome !== 'PASS'
              ? 'CHILD_OUTCOME_NON_PASS'
              : null;
      const measuredAttemptFailure = attemptFailure ?? (timing === null ? 'TIMING_INVALID' : null);
      if (timing !== null) slotElapsedTimes.push(timing.elapsedMs);
      const attempt: QualificationAttemptResult = {
        ordinal: slot.ordinal,
        instanceId: slot.instanceId,
        runId: slot.runId,
        outcome,
        evidenceVerified: verified.evidenceVerified,
        cleanupVerified: verified.cleanupVerified,
        failureCode: measuredAttemptFailure,
      };
      attempts.push(attempt);
      appendQualificationEvent(deps.skillRoot, batchId, {
        type: 'instance-finished',
        ordinal: slot.ordinal,
        instanceId: slot.instanceId,
        runId: slot.runId,
        outcome,
        recordDigest: verified.recordDigest,
        evidenceDigest: verified.evidenceDigest ?? null,
        evidenceVerified: verified.evidenceVerified,
        cleanupVerified: verified.cleanupVerified,
        failureCode: measuredAttemptFailure,
        ...(timing === null ? {} : { timing }),
      });
      if (measuredAttemptFailure !== null)
        throw Object.assign(new Error(), { qualificationCode: measuredAttemptFailure });
      if (deps.collectSourceDigest() !== batch.sourceProvenanceDigest)
        throw Object.assign(new Error(), { qualificationCode: 'SOURCE_DRIFT' as const });
    }
    const batchTiming = finishTiming(deps, batchTimingStart, timingSession);
    if (
      batchTiming === null ||
      batchTiming.elapsedMs < slotElapsedTimes.reduce((total, elapsed) => total + elapsed, 0)
    )
      throw Object.assign(new Error(), { qualificationCode: 'TIMING_INVALID' as const });
    appendQualificationEvent(deps.skillRoot, batchId, {
      type: 'batch-assessed',
      state: 'REVIEW_READY',
      failureCode: null,
      completedAttemptCount: attempts.length,
      releaseCredit: false,
      ...(batchTiming === null ? {} : { timing: batchTiming }),
    });
    return resultFor(batch, 'REVIEW_READY', null, attempts);
  } catch (error) {
    failureCode = isQualificationFailureCode(
      (error as { qualificationCode?: unknown }).qualificationCode,
    )
      ? (error as { qualificationCode: QualificationFailureCode }).qualificationCode
      : 'EXECUTION_INTERRUPTED';
    const state = failureCode === 'EXECUTION_INTERRUPTED' ? 'INTERRUPTED' : 'FAILED';
    try {
      const batchTiming = finishTiming(deps, batchTimingStart, timingSession);
      appendQualificationEvent(deps.skillRoot, batchId, {
        type: 'batch-assessed',
        state,
        failureCode,
        completedAttemptCount: attempts.length,
        releaseCredit: false,
        ...(batchTiming === null ? {} : { timing: batchTiming }),
      });
    } catch {
      // The started ledger remains permanently non-admissible if terminal append fails.
    }
    return resultFor(batch, state, failureCode, attempts);
  }
}

/** Re-reads Qualification history and its actual child evidence without writing. */
export function verifyQualificationBatch(
  batchId: string,
  options: QualificationRuntimeOptions = {},
):
  | { readonly ok: true; readonly verified: VerifiedQualificationBatchV1 }
  | { readonly ok: false; readonly code: QualificationFailureCode } {
  const deps = dependencies(options);
  try {
    const records = readQualificationLedger(deps.skillRoot, batchId);
    const first = records[0]?.event;
    const finalRecord = records.at(-1);
    if (
      !first ||
      first.type !== 'batch-predeclared' ||
      !finalRecord ||
      finalRecord.event.type !== 'batch-assessed'
    )
      return { ok: false, code: 'LEDGER_INVALID' };
    const batch = first.batch;
    if (batch.batchId !== batchId || validateFrozenBatch(batch, deps) !== null)
      return { ok: false, code: 'CANDIDATE_DRIFT' };
    if (deps.collectSourceDigest() !== batch.sourceProvenanceDigest)
      return { ok: false, code: 'SOURCE_DRIFT' };
    if (records.length !== 3 + batch.slots.length * 2) return { ok: false, code: 'LEDGER_INVALID' };
    const startedBatch = records[1]?.event;
    if (
      startedBatch?.type !== 'batch-started' ||
      startedBatch.batchFingerprint !== batch.batchFingerprint
    )
      return { ok: false, code: 'LEDGER_INVALID' };
    const verifiedSlots: VerifiedQualificationBatchV1['slots'][number][] = [];
    let slotElapsedTotal = 0;
    for (let index = 0; index < batch.slots.length; index += 1) {
      const slot = batch.slots[index];
      const started = records[2 + index * 2]?.event;
      const finished = records[3 + index * 2]?.event;
      if (
        !slot ||
        started?.type !== 'instance-started' ||
        finished?.type !== 'instance-finished' ||
        started.ordinal !== index + 1 ||
        started.instanceId !== slot.instanceId ||
        started.runId !== slot.runId ||
        finished.ordinal !== index + 1 ||
        finished.instanceId !== slot.instanceId ||
        finished.runId !== slot.runId ||
        !isGovernanceTiming(finished.timing) ||
        finished.outcome !== 'PASS' ||
        finished.failureCode !== null ||
        !finished.evidenceVerified ||
        !finished.cleanupVerified ||
        !finished.recordDigest ||
        !finished.evidenceDigest
      )
        return { ok: false, code: 'CHILD_OUTCOME_NON_PASS' };
      slotElapsedTotal += finished.timing.elapsedMs;
      const child = deps.readAndVerifyChild(slot.runId);
      if (
        !child.valid ||
        child.outcome !== 'PASS' ||
        !child.recordDigest ||
        !child.evidenceDigest ||
        child.recordDigest !== finished.recordDigest ||
        child.evidenceDigest !== finished.evidenceDigest ||
        child.runId !== slot.runId ||
        child.caseId !== slot.caseId ||
        child.materializationFingerprint !== slot.materializationFingerprint ||
        child.planFingerprint !== slot.planFingerprint ||
        child.cellId !== slot.cell.cellId ||
        child.profile !== 'release' ||
        child.provenance !== 'manifest' ||
        child.evidenceDepth !== 'standard' ||
        !child.cleanupVerified ||
        !child.evidenceVerified
      )
        return { ok: false, code: child.code ?? 'CHILD_RECORD_INVALID' };
      verifiedSlots.push({
        ordinal: index + 1,
        entryId: slot.entryId,
        runId: slot.runId,
        recordDigest: child.recordDigest,
        evidenceDigest: child.evidenceDigest,
      });
    }
    if (
      finalRecord.event.type !== 'batch-assessed' ||
      finalRecord.event.state !== 'REVIEW_READY' ||
      finalRecord.event.failureCode !== null ||
      finalRecord.event.completedAttemptCount !== batch.slots.length ||
      finalRecord.event.releaseCredit !== false ||
      !isGovernanceTiming(finalRecord.event.timing) ||
      finalRecord.event.timing.elapsedMs < slotElapsedTotal ||
      deps.collectSourceDigest() !== batch.sourceProvenanceDigest
    )
      return { ok: false, code: 'LEDGER_INVALID' };
    return {
      ok: true,
      verified: {
        batch,
        finalLedgerDigest: finalRecord.digest,
        sourceProvenanceDigest: batch.sourceProvenanceDigest,
        slots: verifiedSlots,
      },
    };
  } catch {
    return { ok: false, code: 'LEDGER_INVALID' };
  }
}

function validateCandidateFromBatch(
  batch: QualificationBatchV1,
  deps: QualificationRuntimeDependencies,
): QualificationFailureCode | null {
  const loaded = loadFrozenDraft(batch, deps);
  return validateCandidate(loaded, deps);
}

function loadFrozenDraft(
  batch: QualificationBatchV1,
  deps: QualificationRuntimeDependencies,
): ExecutableSelectionManifestDraftV1 {
  // The validated candidate bytes are retained in the predeclared first ledger event.
  const records = readQualificationLedger(deps.skillRoot, batch.batchId);
  const first = records[0]?.event;
  if (
    !first ||
    first.type !== 'batch-predeclared' ||
    first.batch.batchFingerprint !== batch.batchFingerprint
  )
    throw new Error(MAX_RUNNER_DETAIL);
  if (
    first.batch.candidate.manifestId !== batch.manifestId ||
    first.batch.candidate.contentFingerprint !== batch.manifestFingerprint
  )
    throw new Error(MAX_RUNNER_DETAIL);
  return first.batch.candidate;
}

function slotMatches(
  slot: QualificationBatchV1['slots'][number],
  candidate: PreparedExecutionCandidate,
): boolean {
  return (
    slot.caseId === candidate.identity.caseId &&
    slot.materializationFingerprint === candidate.identity.materializationFingerprint &&
    slot.planFingerprint === candidate.identity.planFingerprint &&
    slot.cell.cellId === candidate.identity.cellId &&
    slot.requestDigest === candidate.requestDigest
  );
}

function resultOutcome(status: string): Outcome | null {
  return status === 'PASS' ||
    status === 'BUG' ||
    status === 'HARNESS_BLOCKED' ||
    status === 'ENVIRONMENT_FAILURE'
    ? status
    : null;
}

function isQualificationFailureCode(value: unknown): value is QualificationFailureCode {
  return (
    typeof value === 'string' &&
    [
      'CANDIDATE_INVALID',
      'CANDIDATE_DRIFT',
      'ENTRY_SELECTION_INVALID',
      'PLAN_DRIFT',
      'SOURCE_DRIFT',
      'LEDGER_INVALID',
      'BATCH_ALREADY_CONSUMED',
      'CHILD_RECORD_INVALID',
      'CHILD_OUTCOME_NON_PASS',
      'CLEANUP_INVALID',
      'EVIDENCE_INVALID',
      'TIMING_INVALID',
      'EXECUTION_INTERRUPTED',
    ].includes(value)
  );
}

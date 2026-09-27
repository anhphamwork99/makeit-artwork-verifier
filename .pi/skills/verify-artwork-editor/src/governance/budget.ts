import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';

import { canonicalize, sha256Hex } from '../canonical/canonicalize';
import type {
  BudgetFamilyMeasurementV1,
  BudgetFeasibilityResultV1,
  BudgetMeasuredRunV1,
  BudgetMeasurementFailureCode,
  BudgetMeasurementResult,
  BudgetMeasurementSetContentV1,
  BudgetMeasurementSetV1,
  BudgetObservedDimensionsV1,
  BudgetPolicyApprovalArtifactV1,
  BudgetPolicyAuthorityAttestationV1,
  BudgetPolicyAuthorityProvider,
  BudgetPolicyCeilingsV1,
  BudgetPolicyFailureCode,
  BudgetPolicyFamilyStateV1,
  BudgetPolicyProposalArtifactV1,
  BudgetPolicyProposalV1,
  BudgetPolicyReviewArtifactV1,
  BudgetResult,
  CalibrationFailureCode,
  DiagnosticCalibrationEventV1,
  DiagnosticCalibrationLedgerRecordV1,
  DiagnosticCalibrationV1,
  DiagnosticCalibrationSlotV1,
  PreparedDiagnosticCalibrationV1,
  RetentionNamespace,
  VerifiedDiagnosticCalibrationV1,
} from '../contracts/budget-retention';
import {
  BUDGET_MEASUREMENT_SET_SCHEMA_VERSION,
  BUDGET_MEASUREMENT_SET_ID_PATTERN,
  BUDGET_MEASUREMENT_JOIN_METHOD,
  BUDGET_MEASUREMENT_VERIFIER_METHOD,
  BUDGET_POLICY_ARTIFACT_ID_PATTERN,
  BUDGET_POLICY_ARTIFACT_SCHEMA_VERSION,
  BUDGET_POLICY_DECISION_MAKER,
  BUDGET_POLICY_DECISION_SCOPE,
  BUDGET_POLICY_MANDATE,
  BUDGET_POLICY_METHOD,
  BUDGET_POLICY_SCHEMA_VERSION,
  BUDGET_POLICY_VERIFIED_DECISION,
  DIAGNOSTIC_CALIBRATION_ID_PATTERN,
  DIAGNOSTIC_CALIBRATION_METHOD,
  DIAGNOSTIC_CALIBRATION_SCHEMA_VERSION,
} from '../contracts/budget-retention';
import {
  createGovernanceTiming,
  isGovernanceTiming,
  type GovernanceTimingV1,
} from '../contracts/governance-timing';
import type {
  ExecutableManifestValidationContext,
  ExecutableSelectionManifestDraftV1,
} from '../contracts/executable-selection-manifest';
import { validateExecutableSelectionManifest } from './executable-selection-manifest';
import type { PreparedExecutionCandidate } from '../cli/diagnostic';
import { compilePreparedExecutionCandidate, runDiagnosticCommand } from '../cli/diagnostic';
import type { Outcome } from '../contracts/discriminants';
import type { CliResult } from '../contracts/runtime';
import {
  readAndVerifyDiagnosticChild,
  verifyQualificationBatch,
  type VerifiedChild,
} from './qualification-runtime';
import { readQualificationLedger } from './qualification-ledger';
import { isQualificationBatchId } from '../contracts/qualification-runtime';
import { readAndVerifyRetentionAudit } from './retention';
import { readFinalPublicRecordFile } from '../evidence/final-reader';
import { BUDGET_SAMPLE_AUTHORITY_REGISTRY } from './budget-authority-registry';
import {
  createLocalReleaseShardPlan,
  reconstructLocalReleaseShards,
  type ReleaseShardWorkItemV1,
} from './release-sharding';
import {
  collectRepositoryProvenanceInputs,
  governedTreeDigestFromCollectedInputs,
} from '../evidence/provenance-collector';
import { FINAL_NESTED_PROJECTION_SCHEMA_VERSION } from '../contracts/final-record-v4';
import {
  FINAL_PUBLIC_RECORD_SCHEMA_VERSION,
  readFinalPublicRecord,
} from '../contracts/final-public-record';
import {
  RELEASE_BUDGET_METHOD,
  RELEASE_BUDGET_METHOD_VERSION,
  type ReleaseBudgetPreflightFailureCode,
  type ReleaseBudgetPreflightInputV1,
  type ReleaseBudgetPreflightResultV1,
} from '../contracts/release-runtime';
import { isSafeRunId, resolveRepoRoot, resolveSkillRoot } from '../runtime/paths';
import { loadCatalogueBundle } from '../catalogue/load';
import { loadDiagnosticSuite, resolveSuiteRequests } from '../catalogue/suite';
import { normalizeCaseRequest } from '../planner/normalize-intent';
import { loadEnvironmentCatalogue, resolveEnvironmentCell } from '../runtime/environment';

const MAX_DRAFT_BYTES = 4 * 1024 * 1024;
const MAX_LEDGER_BYTES = 8 * 1024 * 1024;
const MAX_EVIDENCE_FILES = 20_000;
const MAX_EVIDENCE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_EVIDENCE_TOTAL_BYTES = 1024 * 1024 * 1024;
const EVENT_FILE = /^event-(\d{6})\.json$/;
const SAFE_INSTANCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const digestBytes = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const CALIBRATION_FAILURE_CODES: readonly CalibrationFailureCode[] = [
  'CANDIDATE_INVALID',
  'CANDIDATE_DRIFT',
  'SOURCE_DRIFT',
  'PLAN_DRIFT',
  'LEDGER_INVALID',
  'CALIBRATION_CONSUMED',
  'CHILD_RECORD_INVALID',
  'CHILD_OUTCOME_INVALID',
  'CLEANUP_INVALID',
  'EVIDENCE_INVALID',
  'TIMING_INVALID',
  'EXECUTION_INTERRUPTED',
];
function isCalibrationFailureCode(value: unknown): value is CalibrationFailureCode {
  return (
    typeof value === 'string' && CALIBRATION_FAILURE_CODES.includes(value as CalibrationFailureCode)
  );
}

export interface BudgetRuntimeDependencies {
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
  readonly monotonicNow: () => number;
  readonly wallNow: () => string;
  /** Test seam; production defaults to the real read-only Qualification verifier. */
  readonly verifyQualification?: (batchId: string) => ReturnType<typeof verifyQualificationBatch>;
}

export interface BudgetRuntimeOptions {
  readonly dependencies?: Partial<BudgetRuntimeDependencies>;
}

export interface BudgetCalibrationRunResult {
  readonly calibrationId: string;
  readonly state: 'COMPLETE_ALL_PASS' | 'NON_CREDITABLE' | 'INTERRUPTED';
  readonly completedCount: number;
  readonly workCount: number;
  readonly unstartedOrders: readonly number[];
  readonly noReleaseCredit: true;
}

function sourceDigest(repoRoot: string): string {
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

function currentContext(skillRoot: string): ExecutableManifestValidationContext {
  const environmentCatalogue = loadEnvironmentCatalogue({ rootDir: skillRoot });
  const requestTemplates = resolveSuiteRequests(
    loadDiagnosticSuite('representative', { rootDir: skillRoot }),
  ).map((member) => {
    const normalized = normalizeCaseRequest(member.request);
    if (!normalized.ok) throw new Error('CANDIDATE_INVALID');
    const intent = normalized.request.intent;
    return {
      templateId: path.basename(member.relativePath, '.json'),
      subjectId: intent.subjectId,
      capability: intent.capability,
      scenarioId: intent.scenario,
      intent,
    };
  });
  return {
    catalogues: loadCatalogueBundle({ rootDir: skillRoot }),
    environmentCatalogue,
    requiredCell: resolveEnvironmentCell(environmentCatalogue),
    requestTemplates,
  };
}

function dependencies(options: BudgetRuntimeOptions): BudgetRuntimeDependencies {
  const skillRoot = realpathSync(resolveSkillRoot());
  const repoRoot = realpathSync(resolveRepoRoot());
  return {
    skillRoot,
    repoRoot,
    loadContext: () => currentContext(skillRoot),
    compileCandidate: compilePreparedExecutionCandidate,
    runCandidate: (input) => runDiagnosticCommand(input),
    collectSourceDigest: () => sourceDigest(repoRoot),
    readAndVerifyChild: (runId) => readAndVerifyDiagnosticChild(skillRoot, runId, repoRoot),
    makeId: randomUUID,
    monotonicNow: () => performance.now(),
    wallNow: () => new Date().toISOString(),
    ...options.dependencies,
  };
}

function fail(code: CalibrationFailureCode): BudgetResult<never> {
  return { ok: false, code };
}

function digestRecord(record: Omit<DiagnosticCalibrationLedgerRecordV1, 'digest'>): string {
  return sha256Hex(canonicalize(record));
}

function safeDirectory(directory: string): boolean {
  try {
    const stat = lstatSync(directory);
    return stat.isDirectory() && !stat.isSymbolicLink() && realpathSync(directory) === directory;
  } catch {
    return false;
  }
}

function ensureDirectory(root: string, relative: string): string {
  if (!path.isAbsolute(root) || path.normalize(root) !== root || !safeDirectory(root))
    throw new Error('LEDGER_INVALID');
  let current = root;
  for (const part of relative.split('/')) {
    if (!part || part === '.' || part === '..' || part.includes('\\'))
      throw new Error('LEDGER_INVALID');
    current = path.join(current, part);
    try {
      mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('LEDGER_INVALID');
    }
    if (!safeDirectory(current)) throw new Error('LEDGER_INVALID');
  }
  return current;
}

function readFileBounded(file: string, maxBytes: number): Buffer {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size < 0n ||
      before.size > BigInt(maxBytes)
    )
      throw new Error('LEDGER_INVALID');
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true });
    if (
      offset !== Number(before.size) ||
      before.size !== after.size ||
      before.ino !== after.ino ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new Error('LEDGER_INVALID');
    return bytes.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}

function safeDraftReference(
  skillRoot: string,
  draftFile: string,
): { reference: string; bytes: Buffer; draft: ExecutableSelectionManifestDraftV1 } {
  if (draftFile.split(/[\\/]+/).includes('..')) throw new Error('CANDIDATE_INVALID');
  const absolute = path.resolve(draftFile);
  const draftsRoot = path.join(skillRoot, 'cases', 'selection-manifests', 'drafts');
  if (!safeDirectory(draftsRoot)) throw new Error('CANDIDATE_INVALID');
  const relative = path.relative(draftsRoot, absolute);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error('CANDIDATE_INVALID');
  const parent = path.dirname(absolute);
  if (
    !safeDirectory(parent) ||
    (parent !== draftsRoot && !parent.startsWith(`${draftsRoot}${path.sep}`))
  )
    throw new Error('CANDIDATE_INVALID');
  const bytes = readFileBounded(absolute, MAX_DRAFT_BYTES);
  const parsed: unknown = JSON.parse(bytes.toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('CANDIDATE_INVALID');
  return {
    reference: path.relative(skillRoot, absolute).split(path.sep).join('/'),
    bytes,
    draft: parsed as ExecutableSelectionManifestDraftV1,
  };
}

function readDraftReference(
  skillRoot: string,
  reference: string,
): { bytes: Buffer; draft: ExecutableSelectionManifestDraftV1 } {
  if (
    !reference.startsWith('cases/selection-manifests/drafts/') ||
    reference.includes('..') ||
    reference.includes('\\')
  )
    throw new Error('CANDIDATE_INVALID');
  const absolute = path.join(skillRoot, reference);
  const parent = path.dirname(absolute);
  const draftsRoot = path.join(skillRoot, 'cases', 'selection-manifests', 'drafts');
  if (
    !safeDirectory(parent) ||
    (parent !== draftsRoot && !parent.startsWith(`${draftsRoot}${path.sep}`))
  )
    throw new Error('CANDIDATE_INVALID');
  const bytes = readFileBounded(absolute, MAX_DRAFT_BYTES);
  const parsed: unknown = JSON.parse(bytes.toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('CANDIDATE_INVALID');
  return { bytes, draft: parsed as ExecutableSelectionManifestDraftV1 };
}

function calibrationDirectory(skillRoot: string, calibrationId: string, create: boolean): string {
  if (!DIAGNOSTIC_CALIBRATION_ID_PATTERN.test(calibrationId)) throw new Error('LEDGER_INVALID');
  const base = create
    ? ensureDirectory(skillRoot, 'evidence/governance/budget/measurements/calibrations')
    : path.join(skillRoot, 'evidence/governance/budget/measurements/calibrations');
  if (!create && !safeDirectory(base)) throw new Error('LEDGER_INVALID');
  const directory = path.join(base, calibrationId);
  if (create) {
    mkdirSync(directory, { mode: 0o700 });
    if (!safeDirectory(directory)) throw new Error('LEDGER_INVALID');
  } else if (!safeDirectory(directory)) throw new Error('LEDGER_INVALID');
  return directory;
}

function appendEvent(
  skillRoot: string,
  calibrationId: string,
  event: DiagnosticCalibrationEventV1,
): DiagnosticCalibrationLedgerRecordV1 {
  const directory = calibrationDirectory(skillRoot, calibrationId, false);
  const events = path.join(directory, 'events');
  if (!safeDirectory(events)) throw new Error('LEDGER_INVALID');
  const names = readdirSync(events).sort();
  const prior = names.length ? readLedger(skillRoot, calibrationId) : [];
  const sequence = prior.length + 1;
  if (names.length !== prior.length) throw new Error('LEDGER_INVALID');
  const unsigned = {
    schemaVersion: DIAGNOSTIC_CALIBRATION_SCHEMA_VERSION,
    calibrationId,
    sequence,
    previousDigest: prior.at(-1)?.digest ?? null,
    event,
  } as const;
  const record: DiagnosticCalibrationLedgerRecordV1 = {
    ...unsigned,
    digest: digestRecord(unsigned),
  };
  const bytes = Buffer.from(`${canonicalize(record)}\n`);
  if (bytes.byteLength > MAX_LEDGER_BYTES) throw new Error('LEDGER_INVALID');
  const file = path.join(events, `event-${String(sequence).padStart(6, '0')}.json`);
  const fd = openSync(
    file,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n) throw new Error('LEDGER_INVALID');
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw new Error('LEDGER_INVALID');
      offset += count;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return record;
}

function readLedger(
  skillRoot: string,
  calibrationId: string,
): DiagnosticCalibrationLedgerRecordV1[] {
  const directory = calibrationDirectory(skillRoot, calibrationId, false);
  const events = path.join(directory, 'events');
  if (!safeDirectory(events)) throw new Error('LEDGER_INVALID');
  const names = readdirSync(events).sort();
  const records: DiagnosticCalibrationLedgerRecordV1[] = [];
  let previousDigest: string | null = null;
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index] as string;
    if (name !== `event-${String(index + 1).padStart(6, '0')}.json` || !EVENT_FILE.test(name))
      throw new Error('LEDGER_INVALID');
    const bytes = readFileBounded(path.join(events, name), MAX_LEDGER_BYTES);
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('LEDGER_INVALID');
    const record = value as DiagnosticCalibrationLedgerRecordV1;
    if (
      !exactKeys(record, [
        'schemaVersion',
        'calibrationId',
        'sequence',
        'previousDigest',
        'event',
        'digest',
      ]) ||
      record.schemaVersion !== DIAGNOSTIC_CALIBRATION_SCHEMA_VERSION ||
      record.calibrationId !== calibrationId ||
      record.sequence !== index + 1 ||
      record.previousDigest !== previousDigest ||
      typeof record.digest !== 'string' ||
      digestRecord({
        schemaVersion: record.schemaVersion,
        calibrationId: record.calibrationId,
        sequence: record.sequence,
        previousDigest: record.previousDigest,
        event: record.event,
      }) !== record.digest ||
      `${canonicalize(record)}\n` !== bytes.toString('utf8') ||
      !validEvent(record.event)
    )
      throw new Error('LEDGER_INVALID');
    records.push(record);
    previousDigest = record.digest;
  }
  if (records.length === 0 || records[0]?.event.type !== 'calibration-predeclared')
    throw new Error('LEDGER_INVALID');
  return records;
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const own = Reflect.ownKeys(value);
  return (
    own.length === keys.length && own.every((key) => typeof key === 'string' && keys.includes(key))
  );
}

function validEvent(event: unknown): event is DiagnosticCalibrationEventV1 {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
  const value = event as Record<string, unknown>;
  if (value.type === 'calibration-predeclared')
    return exactKeys(value, ['type', 'calibration']) && validCalibration(value.calibration);
  if (value.type === 'calibration-started')
    return (
      exactKeys(value, ['type', 'calibrationFingerprint']) &&
      /^[0-9a-f]{64}$/.test(String(value.calibrationFingerprint))
    );
  if (value.type === 'slot-started')
    return (
      exactKeys(value, ['type', 'order', 'instanceId', 'runId']) &&
      Number.isSafeInteger(value.order) &&
      typeof value.instanceId === 'string' &&
      isSafeRunId(value.runId)
    );
  if (value.type === 'slot-finished')
    return (
      (exactKeys(value, [
        'type',
        'order',
        'instanceId',
        'runId',
        'outcome',
        'cliStatus',
        'recordDigest',
        'evidenceDigest',
        'failureCode',
        'cleanupVerified',
        'evidenceVerified',
        'evidenceFileCount',
        'evidenceByteCount',
        'evidenceFiles',
        'evidenceFilesDigest',
        'timing',
      ]) ||
        exactKeys(value, [
          'type',
          'order',
          'instanceId',
          'runId',
          'outcome',
          'cliStatus',
          'recordDigest',
          'evidenceDigest',
          'failureCode',
          'cleanupVerified',
          'evidenceVerified',
          'evidenceFileCount',
          'evidenceByteCount',
          'evidenceFiles',
          'evidenceFilesDigest',
        ])) &&
      validSlotFields(value)
    );
  if (value.type === 'calibration-assessed')
    return (
      (exactKeys(value, [
        'type',
        'state',
        'failureCode',
        'completedCount',
        'unstartedOrders',
        'noReleaseCredit',
        'timing',
      ]) ||
        exactKeys(value, [
          'type',
          'state',
          'failureCode',
          'completedCount',
          'unstartedOrders',
          'noReleaseCredit',
        ])) &&
      validAssessmentFields(value)
    );
  return false;
}

function validSlotFields(value: Record<string, unknown>): boolean {
  return (
    Number.isSafeInteger(value.order) &&
    typeof value.instanceId === 'string' &&
    SAFE_INSTANCE_ID.test(value.instanceId) &&
    isSafeRunId(value.runId) &&
    (value.outcome === null ||
      ['PASS', 'BUG', 'HARNESS_BLOCKED', 'ENVIRONMENT_FAILURE'].includes(String(value.outcome))) &&
    (value.cliStatus === null ||
      ['PASS', 'BUG', 'HARNESS_BLOCKED', 'ENVIRONMENT_FAILURE'].includes(
        String(value.cliStatus),
      )) &&
    (value.recordDigest === null || /^[0-9a-f]{64}$/.test(String(value.recordDigest))) &&
    (value.evidenceDigest === null || /^[0-9a-f]{64}$/.test(String(value.evidenceDigest))) &&
    (value.failureCode === null || isCalibrationFailureCode(value.failureCode)) &&
    typeof value.cleanupVerified === 'boolean' &&
    typeof value.evidenceVerified === 'boolean' &&
    Number.isSafeInteger(value.evidenceFileCount) &&
    Number(value.evidenceFileCount) >= 0 &&
    Number.isSafeInteger(value.evidenceByteCount) &&
    Number(value.evidenceByteCount) >= 0 &&
    Array.isArray(value.evidenceFiles) &&
    value.evidenceFiles.length === value.evidenceFileCount &&
    value.evidenceFiles.every(
      (file: unknown) =>
        exactKeys(file, ['path', 'byteCount', 'sha256']) &&
        typeof file.path === 'string' &&
        !file.path.startsWith('/') &&
        !file.path
          .split('/')
          .some((segment: string) => !segment || segment === '.' || segment === '..') &&
        Number.isSafeInteger(file.byteCount) &&
        Number(file.byteCount) >= 0 &&
        typeof file.sha256 === 'string' &&
        /^[0-9a-f]{64}$/.test(file.sha256),
    ) &&
    sha256Hex(canonicalize(value.evidenceFiles)) === value.evidenceFilesDigest &&
    /^[0-9a-f]{64}$/.test(String(value.evidenceFilesDigest)) &&
    (value.timing === undefined || isGovernanceTiming(value.timing))
  );
}

function validAssessmentFields(value: Record<string, unknown>): boolean {
  return (
    ['COMPLETE_ALL_PASS', 'NON_CREDITABLE', 'INTERRUPTED'].includes(String(value.state)) &&
    (value.failureCode === null || isCalibrationFailureCode(value.failureCode)) &&
    Number.isSafeInteger(value.completedCount) &&
    Number(value.completedCount) >= 0 &&
    Array.isArray(value.unstartedOrders) &&
    value.unstartedOrders.every(Number.isSafeInteger) &&
    value.noReleaseCredit === true &&
    (value.timing === undefined || isGovernanceTiming(value.timing))
  );
}

function validCalibration(value: unknown): value is DiagnosticCalibrationV1 {
  if (
    !exactKeys(value, [
      'schemaVersion',
      'method',
      'calibrationId',
      'draftReference',
      'draftBytesDigest',
      'manifestId',
      'manifestFingerprint',
      'candidate',
      'requiredCell',
      'sourceProvenanceDigest',
      'slots',
      'shardPlanFingerprint',
    ])
  )
    return false;
  const v = value as unknown as DiagnosticCalibrationV1;
  return (
    v.schemaVersion === DIAGNOSTIC_CALIBRATION_SCHEMA_VERSION &&
    v.method === DIAGNOSTIC_CALIBRATION_METHOD &&
    DIAGNOSTIC_CALIBRATION_ID_PATTERN.test(v.calibrationId) &&
    v.draftReference.startsWith('cases/selection-manifests/drafts/') &&
    !v.draftReference.includes('..') &&
    /^[0-9a-f]{64}$/.test(v.draftBytesDigest) &&
    /^[0-9a-f]{64}$/.test(v.manifestFingerprint) &&
    /^[0-9a-f]{64}$/.test(v.sourceProvenanceDigest) &&
    /^[0-9a-f]{64}$/.test(v.shardPlanFingerprint) &&
    v.candidate !== null &&
    typeof v.candidate === 'object' &&
    v.candidate.content !== null &&
    typeof v.candidate.content === 'object' &&
    Array.isArray(v.candidate.content.entries) &&
    v.manifestId === v.candidate.manifestId &&
    v.manifestFingerprint === v.candidate.contentFingerprint &&
    Array.isArray(v.slots) &&
    v.slots.length === v.candidate.content.entries.length &&
    v.slots.every(
      (slot, index) =>
        exactKeys(slot, [
          'order',
          'entryId',
          'cell',
          'instanceId',
          'runId',
          'requestDigest',
          'caseId',
          'materializationFingerprint',
          'planFingerprint',
          'executionProfileIdentity',
        ]) &&
        slot.order === index &&
        slot.entryId === v.candidate.content.entries[index]?.entryId &&
        typeof slot.runId === 'string' &&
        isSafeRunId(slot.runId) &&
        typeof slot.instanceId === 'string' &&
        SAFE_INSTANCE_ID.test(slot.instanceId) &&
        typeof slot.requestDigest === 'string' &&
        /^[0-9a-f]{64}$/.test(slot.requestDigest),
    )
  );
}

function matches(
  entry: ExecutableSelectionManifestDraftV1['content']['entries'][number],
  candidate: PreparedExecutionCandidate,
): boolean {
  return (
    candidate.planning.request.profile === 'release' &&
    candidate.planning.request.provenance === 'manifest' &&
    candidate.planning.request.evidenceDepth === 'standard' &&
    candidate.requestDigest === entry.requestDigest &&
    candidate.identity.caseId === entry.caseId &&
    candidate.identity.materializationFingerprint === entry.materializationFingerprint &&
    candidate.identity.planFingerprint === entry.planFingerprint &&
    candidate.identity.cellId === entry.cell.cellId &&
    canonicalize(candidate.environmentCell) === canonicalize(entry.cell)
  );
}

function compileCalibration(
  draft: ExecutableSelectionManifestDraftV1,
  d: BudgetRuntimeDependencies,
): {
  slots: DiagnosticCalibrationSlotV1[];
  candidates: PreparedExecutionCandidate[];
  shardPlanFingerprint: string;
} {
  if (!Array.isArray(draft.content.entries) || draft.content.entries.length === 0)
    throw new Error('CANDIDATE_INVALID');
  const slots: DiagnosticCalibrationSlotV1[] = [];
  const candidates: PreparedExecutionCandidate[] = [];
  const idSet = new Set<string>();
  for (let order = 0; order < draft.content.entries.length; order += 1) {
    const entry = draft.content.entries[order];
    if (!entry || entry.cell.cellId !== draft.content.requiredCell.cellId)
      throw new Error('PLAN_DRIFT');
    const compiled = d.compileCandidate(entry.request);
    if (!compiled.ok || !matches(entry, compiled.candidate)) throw new Error('PLAN_DRIFT');
    candidates.push(compiled.candidate);
    const instanceId = `calinstance-${d.makeId()}`;
    const runId = `calrun-${d.makeId()}`;
    if (
      !SAFE_INSTANCE_ID.test(instanceId) ||
      !isSafeRunId(runId) ||
      idSet.has(instanceId) ||
      idSet.has(runId)
    )
      throw new Error('PLAN_DRIFT');
    idSet.add(instanceId);
    idSet.add(runId);
    slots.push({
      order,
      entryId: entry.entryId,
      cell: entry.cell,
      instanceId,
      runId,
      requestDigest: entry.requestDigest,
      caseId: entry.caseId,
      materializationFingerprint: entry.materializationFingerprint,
      planFingerprint: entry.planFingerprint,
      executionProfileIdentity: entry.executionProfileIdentity,
    });
  }
  const shardItems: ReleaseShardWorkItemV1[] = slots.map((slot) => ({
    order: slot.order,
    entryId: slot.entryId,
    cellId: slot.cell.cellId,
    instanceId: slot.instanceId,
    runId: slot.runId,
  }));
  const shard = createLocalReleaseShardPlan({
    manifestFingerprint: draft.contentFingerprint,
    items: shardItems,
    shardCount: 1,
  });
  if (!shard.ok) throw new Error('PLAN_DRIFT');
  const reconstructed = reconstructLocalReleaseShards(shard.plan, [
    {
      schemaVersion: 1,
      planFingerprint: shard.plan.fingerprint,
      shardIndex: 0,
      status: 'complete',
      items: shardItems,
    },
  ]);
  if (!reconstructed.ok || canonicalize(reconstructed.items) !== canonicalize(shardItems))
    throw new Error('PLAN_DRIFT');
  return { slots, candidates, shardPlanFingerprint: shard.plan.fingerprint };
}

// ── Pure measured-run metric projection ──────────────────────────────────────
//
// One strictly validated current public v4 run record contributes one
// `BudgetMeasuredRunV1` to the no-credit measurement set. This is the only place
// a run's persisted Image tear counter is read, and it is pure: it performs no
// filesystem access and takes every number from its caller.
//
// Caller trust boundary (explicit): the caller must supply a record already
// accepted by `readFinalPublicRecord` as `kind: 'current-v4'` and the run's
// selected widget family derived from the validated full manifest. The helper
// re-validates every value it consumes and refuses rather than guessing; it does
// not re-read the record, the manifest, or any evidence file.

/** The six widget families a validated manifest can select (ADR 0106 §2). */
export type BudgetMeasuredFamilyV1 = BudgetFamilyMeasurementV1['family'];
const BUDGET_MEASURED_FAMILIES: readonly BudgetMeasuredFamilyV1[] = [
  'image',
  'text',
  'object',
  'crossword',
  'history',
  'restore',
];

/**
 * The only region of a strict validated public v4 run record this projection
 * reads. A `FinalPublicRunRecordV4` is structurally assignable to it.
 */
export interface BudgetMeasuredRunRecordSourceV1 {
  readonly schemaVersion: number;
  readonly command: string;
  readonly runId: string;
  readonly nestedProjections: readonly BudgetNestedProjectionSourceV1[];
}

/** A strict nested v4 projection reduced to the fields the projection consumes. */
export interface BudgetNestedProjectionSourceV1 {
  readonly schemaVersion: number;
  readonly family: string;
  readonly cycles?: readonly BudgetNestedCycleSourceV1[];
}

/** One nested Image cycle reduced to its strictly persisted tear counter. */
export interface BudgetNestedCycleSourceV1 {
  readonly tornRecaptureCount?: number;
}

/** Verified owned run-root inventory totals (governance/scratch/log files excluded). */
export interface BudgetRunInventorySummaryV1 {
  readonly evidenceFileCount: number;
  readonly evidenceByteCount: number;
}

/** Caller-supplied inputs for one measured run. */
export interface BudgetMeasuredRunProjectionInputV1 {
  /** Entry identity from the validated manifest; must be non-empty. */
  readonly entryId: string;
  /** Run identity from the verified child readback; must be a safe run id. */
  readonly runId: string;
  /** The run's selected widget family, derived from the validated full manifest. */
  readonly family: BudgetMeasuredFamilyV1;
  /** Verified per-run WP1 governance timing. */
  readonly timing: GovernanceTimingV1;
  /** Verified owned run-root inventory summary. */
  readonly inventory: BudgetRunInventorySummaryV1;
  /** An already strict-validated current public v4 run record. */
  readonly record: BudgetMeasuredRunRecordSourceV1;
}

function measuredRunFailure(code: BudgetMeasurementFailureCode): BudgetMeasurementResult<never> {
  return { ok: false, code };
}

/**
 * Strict Image tear projection. Exactly one Image nested projection must exist
 * and every cycle must persist a safe nonnegative `tornRecaptureCount`; a
 * missing, duplicated or malformed counter refuses. The single tear-count rule
 * is shared verbatim by `projectBudgetMeasuredRun` and the Release runtime's
 * `readReleaseChildStrictFacts`, so the two can never drift.
 */
function strictImageTornRecaptures(
  record: BudgetMeasuredRunRecordSourceV1,
): { readonly ok: true; readonly value: number } | { readonly ok: false } {
  const imageProjections = record.nestedProjections.filter(
    (projection) => projection.family === 'image',
  );
  if (imageProjections.length !== 1) return { ok: false };
  const projection = imageProjections[0]!;
  if (
    projection.schemaVersion !== FINAL_NESTED_PROJECTION_SCHEMA_VERSION ||
    !Array.isArray(projection.cycles)
  )
    return { ok: false };
  const cycles = projection.cycles as readonly BudgetNestedCycleSourceV1[];
  let total = 0;
  for (const cycle of cycles) {
    const count = cycle.tornRecaptureCount;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)
      return { ok: false };
    total += count;
    if (!Number.isSafeInteger(total)) return { ok: false };
  }
  return { ok: true, value: total };
}

/**
 * Projects one measured run for the no-credit measurement set.
 *
 * An Image run sums every strict `tornRecaptureCount` exactly once; a missing,
 * duplicated, or malformed Image projection refuses. A selected non-Image family
 * has no trusted persisted counter, so it is `UNAVAILABLE` with a null count —
 * never numeric zero and never `NOT_APPLICABLE`, which belongs to the later
 * aggregate join for a family absent from the manifest. Elapsed time, file count
 * and byte count are re-validated as finite/safe nonnegative values.
 */
export function projectBudgetMeasuredRun(
  input: BudgetMeasuredRunProjectionInputV1,
): BudgetMeasurementResult<BudgetMeasuredRunV1> {
  if (typeof input.entryId !== 'string' || input.entryId.length === 0)
    return measuredRunFailure('INPUT_INVALID');
  if (!isSafeRunId(input.runId)) return measuredRunFailure('INPUT_INVALID');
  if (!BUDGET_MEASURED_FAMILIES.includes(input.family)) return measuredRunFailure('INPUT_INVALID');
  if (!isGovernanceTiming(input.timing)) return measuredRunFailure('INPUT_INVALID');
  if (
    !Number.isSafeInteger(input.inventory.evidenceFileCount) ||
    input.inventory.evidenceFileCount < 0 ||
    !Number.isSafeInteger(input.inventory.evidenceByteCount) ||
    input.inventory.evidenceByteCount < 0
  )
    return measuredRunFailure('INPUT_INVALID');

  const record = input.record;
  if (
    record === null ||
    typeof record !== 'object' ||
    record.schemaVersion !== FINAL_PUBLIC_RECORD_SCHEMA_VERSION ||
    record.command !== 'diagnostic' ||
    record.runId !== input.runId ||
    !Array.isArray(record.nestedProjections)
  )
    return measuredRunFailure('MEASUREMENT_INVALID');

  let imageTornRecaptures: number | null = null;
  let imageApplicability: BudgetMeasuredRunV1['imageApplicability'] = 'UNAVAILABLE';
  if (input.family === 'image') {
    const torn = strictImageTornRecaptures(record);
    if (!torn.ok) return measuredRunFailure('MEASUREMENT_INVALID');
    imageTornRecaptures = torn.value;
    imageApplicability = 'MEASURED';
  }

  return {
    ok: true,
    value: {
      runId: input.runId,
      entryId: input.entryId,
      elapsedMs: input.timing.elapsedMs,
      evidenceFileCount: input.inventory.evidenceFileCount,
      evidenceByteCount: input.inventory.evidenceByteCount,
      imageTornRecaptures,
      imageApplicability,
    },
  };
}

/** Validate a bounded draft and compile the complete work list before any ledger or child allocation. */
export function prepareDiagnosticCalibration(
  input: { readonly draftFile: string },
  options: BudgetRuntimeOptions = {},
): BudgetResult<PreparedDiagnosticCalibrationV1> {
  const d = dependencies(options);
  try {
    const source = d.collectSourceDigest();
    const { reference, bytes, draft } = safeDraftReference(d.skillRoot, input.draftFile);
    if (!validateExecutableSelectionManifest(draft, d.loadContext()).valid)
      return fail('CANDIDATE_DRIFT');
    const compiled = compileCalibration(draft, d);
    if (d.collectSourceDigest() !== source) return fail('SOURCE_DRIFT');
    const id = `cal-${d.makeId()}`;
    if (!DIAGNOSTIC_CALIBRATION_ID_PATTERN.test(id)) return fail('CANDIDATE_INVALID');
    const calibration: DiagnosticCalibrationV1 = {
      schemaVersion: DIAGNOSTIC_CALIBRATION_SCHEMA_VERSION,
      method: DIAGNOSTIC_CALIBRATION_METHOD,
      calibrationId: id,
      draftReference: reference,
      draftBytesDigest: digestBytes(bytes),
      manifestId: draft.manifestId,
      manifestFingerprint: draft.contentFingerprint,
      candidate: draft,
      requiredCell: draft.content.requiredCell,
      sourceProvenanceDigest: source,
      slots: compiled.slots,
      shardPlanFingerprint: compiled.shardPlanFingerprint,
    };
    return { ok: true, value: { calibration, preparedCandidates: compiled.candidates } };
  } catch (error) {
    const code =
      error instanceof Error && ['CANDIDATE_INVALID', 'PLAN_DRIFT'].includes(error.message)
        ? (error.message as CalibrationFailureCode)
        : 'CANDIDATE_INVALID';
    return fail(code);
  }
}

interface TimingSession {
  last: number | null;
  invalid: boolean;
}
function sample(d: BudgetRuntimeDependencies, session: TimingSession): number {
  try {
    const value = d.monotonicNow();
    if (!Number.isFinite(value) || value < 0 || (session.last !== null && value < session.last))
      session.invalid = true;
    else session.last = value;
    return session.invalid ? Number.NaN : value;
  } catch {
    session.invalid = true;
    return Number.NaN;
  }
}
function timing(
  d: BudgetRuntimeDependencies,
  session: TimingSession,
  start: number,
  wallStart: string,
) {
  const end = sample(d, session);
  return session.invalid
    ? null
    : createGovernanceTiming({
        monotonicStart: start,
        monotonicEnd: end,
        wallStart,
        wallEnd: d.wallNow(),
      });
}

interface EvidenceFile {
  readonly path: string;
  readonly byteCount: number;
  readonly sha256: string;
}
function inventoryEvidenceRoot(
  skillRoot: string,
  runId: string,
): { files: EvidenceFile[]; digest: string; bytes: number } {
  if (!isSafeRunId(runId)) throw new Error('EVIDENCE_INVALID');
  const root = path.join(skillRoot, 'evidence', 'runs', runId);
  if (!safeDirectory(root)) throw new Error('EVIDENCE_INVALID');
  const files: EvidenceFile[] = [];
  let total = 0;
  function walk(directory: string, relative: string): void {
    if (!safeDirectory(directory)) throw new Error('EVIDENCE_INVALID');
    for (const name of readdirSync(directory).sort()) {
      if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\'))
        throw new Error('EVIDENCE_INVALID');
      const target = path.join(directory, name);
      const stat = lstatSync(target);
      if (stat.isSymbolicLink()) throw new Error('EVIDENCE_INVALID');
      const next = relative ? `${relative}/${name}` : name;
      if (stat.isDirectory()) walk(target, next);
      else if (stat.isFile()) {
        if (
          files.length >= MAX_EVIDENCE_FILES ||
          stat.nlink !== 1 ||
          stat.size > MAX_EVIDENCE_FILE_BYTES
        )
          throw new Error('EVIDENCE_INVALID');
        const bytes = readFileBounded(target, MAX_EVIDENCE_FILE_BYTES);
        total += bytes.byteLength;
        if (total > MAX_EVIDENCE_TOTAL_BYTES) throw new Error('EVIDENCE_INVALID');
        files.push({ path: next, byteCount: bytes.byteLength, sha256: digestBytes(bytes) });
      } else throw new Error('EVIDENCE_INVALID');
    }
  }
  walk(root, '');
  files.sort((a, b) => a.path.localeCompare(b.path));
  if (!files.some((file) => file.path === 'run-record.json')) throw new Error('EVIDENCE_INVALID');
  return { files, digest: sha256Hex(canonicalize(files)), bytes: total };
}

function validOutcome(value: unknown): value is Outcome {
  return (
    value === 'PASS' ||
    value === 'BUG' ||
    value === 'HARNESS_BLOCKED' ||
    value === 'ENVIRONMENT_FAILURE'
  );
}

function assessState(
  slots: readonly DiagnosticCalibrationSlotV1[],
  finished: readonly Extract<DiagnosticCalibrationEventV1, { type: 'slot-finished' }>[],
  stopped: boolean,
  code: CalibrationFailureCode | null,
): 'COMPLETE_ALL_PASS' | 'NON_CREDITABLE' | 'INTERRUPTED' {
  if (
    stopped ||
    finished.length < slots.length ||
    code === 'TIMING_INVALID' ||
    code === 'EXECUTION_INTERRUPTED'
  )
    return 'INTERRUPTED';
  return finished.length === slots.length &&
    finished.every((event) => event.outcome === 'PASS' && event.failureCode === null)
    ? 'COMPLETE_ALL_PASS'
    : 'NON_CREDITABLE';
}

/** Persist and execute one exact precompiled full-manifest calibration; never retries or grants Release credit. */
export async function runDiagnosticCalibration(
  prepared: PreparedDiagnosticCalibrationV1,
  options: BudgetRuntimeOptions = {},
): Promise<BudgetResult<BudgetCalibrationRunResult>> {
  const d = dependencies(options);
  const calibration = prepared.calibration;
  let created = false;
  try {
    if (
      !validCalibration(calibration) ||
      prepared.preparedCandidates.length !== calibration.slots.length
    )
      return fail('CANDIDATE_INVALID');
    const reread = readDraftReference(d.skillRoot, calibration.draftReference);
    if (
      digestBytes(reread.bytes) !== calibration.draftBytesDigest ||
      canonicalize(reread.draft) !== canonicalize(calibration.candidate)
    )
      return fail('CANDIDATE_DRIFT');
    if (
      !validateExecutableSelectionManifest(reread.draft, d.loadContext()).valid ||
      d.collectSourceDigest() !== calibration.sourceProvenanceDigest
    )
      return fail('SOURCE_DRIFT');
    const compiledAgain = compileCalibration(reread.draft, {
      ...d,
      makeId: (() => {
        let i = 0;
        return () => {
          const slot = calibration.slots[Math.floor(i / 2)];
          return i++ % 2 === 0 ? (slot?.instanceId.slice(12) ?? '') : (slot?.runId.slice(7) ?? '');
        };
      })(),
    });
    if (
      canonicalize(compiledAgain.slots) !== canonicalize(calibration.slots) ||
      compiledAgain.shardPlanFingerprint !== calibration.shardPlanFingerprint
    )
      return fail('PLAN_DRIFT');
    if (
      calibration.slots.some((slot) =>
        lstatSync(path.join(d.skillRoot, 'evidence/runs', slot.runId), {
          throwIfNoEntry: false,
        }),
      )
    )
      return fail('CALIBRATION_CONSUMED');
    // The in-memory prepared candidates are compile-once products; verify their identity against the frozen slots.
    if (
      prepared.preparedCandidates.some(
        (candidate, i) =>
          !candidate ||
          !matches(reread.draft.content.entries[i]!, candidate) ||
          candidate.identity.caseId !== calibration.slots[i]?.caseId,
      )
    )
      return fail('PLAN_DRIFT');
    const directory = calibrationDirectory(d.skillRoot, calibration.calibrationId, true);
    created = true;
    mkdirSync(path.join(directory, 'events'), { mode: 0o700 });
    if (!safeDirectory(path.join(directory, 'events'))) return fail('LEDGER_INVALID');
    appendEvent(d.skillRoot, calibration.calibrationId, {
      type: 'calibration-predeclared',
      calibration,
    });
    // A second predeclaration or concurrent start collides through O_EXCL event names.
    const startEvent = {
      type: 'calibration-started',
      calibrationFingerprint: sha256Hex(canonicalize(calibration)),
    } as const;
    appendEvent(d.skillRoot, calibration.calibrationId, startEvent);
    const session: TimingSession = { last: null, invalid: false };
    const runStartWall = d.wallNow();
    const runStart = sample(d, session);
    const finished: Extract<DiagnosticCalibrationEventV1, { type: 'slot-finished' }>[] = [];
    let failureCode: CalibrationFailureCode | null = null;
    let stopped = false;
    for (let index = 0; index < calibration.slots.length; index += 1) {
      const slot = calibration.slots[index];
      const candidate = prepared.preparedCandidates[index];
      if (!slot || !candidate) {
        failureCode = 'PLAN_DRIFT';
        stopped = true;
        break;
      }
      if (session.invalid || d.collectSourceDigest() !== calibration.sourceProvenanceDigest) {
        failureCode = session.invalid ? 'TIMING_INVALID' : 'SOURCE_DRIFT';
        stopped = true;
        break;
      }
      const wallStart = d.wallNow();
      const slotStart = sample(d, session);
      if (session.invalid) {
        failureCode = 'TIMING_INVALID';
        stopped = true;
        break;
      }
      appendEvent(d.skillRoot, calibration.calibrationId, {
        type: 'slot-started',
        order: slot.order,
        instanceId: slot.instanceId,
        runId: slot.runId,
      });
      let cli: CliResult<unknown> | null = null;
      let child: VerifiedChild | null = null;
      let byteInventory: ReturnType<typeof inventoryEvidenceRoot> | null = null;
      let slotFailure: CalibrationFailureCode | null = null;
      try {
        cli = await d.runCandidate({
          preparedCandidate: candidate,
          expectedIdentity: candidate.identity,
          runId: slot.runId,
        });
        child = d.readAndVerifyChild(slot.runId);
        byteInventory = inventoryEvidenceRoot(d.skillRoot, slot.runId);
        const expectedOutcome = validOutcome(cli.outcome) ? cli.outcome : null;
        const identityValid =
          child.runId === slot.runId &&
          child.caseId === slot.caseId &&
          child.materializationFingerprint === slot.materializationFingerprint &&
          child.planFingerprint === slot.planFingerprint &&
          child.cellId === slot.cell.cellId &&
          child.profile === 'release' &&
          child.provenance === 'manifest' &&
          child.evidenceDepth === 'standard';
        if (
          !identityValid ||
          !child.valid ||
          child.outcome !== expectedOutcome ||
          !child.recordDigest ||
          !child.evidenceDigest
        )
          slotFailure = 'CHILD_RECORD_INVALID';
        else if (!child.cleanupVerified) slotFailure = 'CLEANUP_INVALID';
        else if (!child.evidenceVerified) slotFailure = 'EVIDENCE_INVALID';
      } catch {
        slotFailure = 'EXECUTION_INTERRUPTED';
      }
      const slotTiming = timing(d, session, slotStart, wallStart);
      if (!slotTiming) slotFailure = 'TIMING_INVALID';
      const outcome = child && validOutcome(child.outcome) ? child.outcome : null;
      const event: Extract<DiagnosticCalibrationEventV1, { type: 'slot-finished' }> = {
        type: 'slot-finished',
        order: slot.order,
        instanceId: slot.instanceId,
        runId: slot.runId,
        outcome: slotFailure === null ? outcome : outcome,
        cliStatus: cli && validOutcome(cli.status) ? cli.status : null,
        recordDigest: child?.recordDigest ?? null,
        evidenceDigest: child?.evidenceDigest ?? null,
        failureCode: slotFailure,
        cleanupVerified: child?.cleanupVerified ?? false,
        evidenceVerified: child?.evidenceVerified ?? false,
        evidenceFileCount: byteInventory?.files.length ?? 0,
        evidenceByteCount: byteInventory?.bytes ?? 0,
        evidenceFiles: byteInventory?.files ?? [],
        evidenceFilesDigest: byteInventory?.digest ?? sha256Hex(canonicalize([])),
        ...(slotTiming === null ? {} : { timing: slotTiming }),
      };
      appendEvent(d.skillRoot, calibration.calibrationId, event);
      finished.push(event);
      if (slotFailure !== null) {
        failureCode = slotFailure;
        stopped = true;
        break;
      }
      if (d.collectSourceDigest() !== calibration.sourceProvenanceDigest) {
        failureCode = 'SOURCE_DRIFT';
        stopped = true;
        break;
      }
    }
    const runTiming = timing(d, session, runStart, runStartWall);
    if (
      !runTiming ||
      runTiming.elapsedMs < finished.reduce((sum, event) => sum + (event.timing?.elapsedMs ?? 0), 0)
    ) {
      failureCode = 'TIMING_INVALID';
      stopped = true;
    }
    const state = assessState(calibration.slots, finished, stopped, failureCode);
    const unstartedOrders = calibration.slots.slice(finished.length).map((slot) => slot.order);
    appendEvent(d.skillRoot, calibration.calibrationId, {
      type: 'calibration-assessed',
      state,
      failureCode,
      completedCount: finished.length,
      unstartedOrders,
      noReleaseCredit: true,
      ...(runTiming ? { timing: runTiming } : {}),
    });
    return {
      ok: true,
      value: {
        calibrationId: calibration.calibrationId,
        state,
        completedCount: finished.length,
        workCount: calibration.slots.length,
        unstartedOrders,
        noReleaseCredit: true,
      },
    };
  } catch (error) {
    if (created)
      return fail(
        error instanceof Error && error.message === 'CALIBRATION_CONSUMED'
          ? 'CALIBRATION_CONSUMED'
          : 'LEDGER_INVALID',
      );
    return fail('LEDGER_INVALID');
  }
}

function validOutcomeValue(value: unknown): value is Outcome {
  return (
    value === 'PASS' ||
    value === 'BUG' ||
    value === 'HARNESS_BLOCKED' ||
    value === 'ENVIRONMENT_FAILURE'
  );
}

/** Re-read the closed ledger, exact current draft/source, strict child records, and byte inventories. */
export function verifyDiagnosticCalibration(
  calibrationId: string,
  options: BudgetRuntimeOptions = {},
): BudgetResult<VerifiedDiagnosticCalibrationV1> {
  const d = dependencies(options);
  try {
    const records = readLedger(d.skillRoot, calibrationId);
    const calibrationEvent = records[0]?.event;
    const started = records[1]?.event;
    const terminal = records.at(-1)?.event;
    if (
      calibrationEvent?.type !== 'calibration-predeclared' ||
      started?.type !== 'calibration-started' ||
      terminal?.type !== 'calibration-assessed'
    )
      return fail('LEDGER_INVALID');
    const calibration = calibrationEvent.calibration;
    if (
      !validCalibration(calibration) ||
      started.calibrationFingerprint !== sha256Hex(canonicalize(calibration))
    )
      return fail('LEDGER_INVALID');
    const source = d.collectSourceDigest();
    const { bytes, draft } = readDraftReference(d.skillRoot, calibration.draftReference);
    if (
      digestBytes(bytes) !== calibration.draftBytesDigest ||
      canonicalize(draft) !== canonicalize(calibration.candidate)
    )
      return fail('CANDIDATE_DRIFT');
    if (
      !validateExecutableSelectionManifest(draft, d.loadContext()).valid ||
      source !== calibration.sourceProvenanceDigest
    )
      return fail('SOURCE_DRIFT');
    const compiled = compileCalibration(draft, {
      ...d,
      makeId: (() => {
        let i = 0;
        return () => {
          const slot = calibration.slots[Math.floor(i / 2)];
          return i++ % 2 === 0 ? (slot?.instanceId.slice(12) ?? '') : (slot?.runId.slice(7) ?? '');
        };
      })(),
    });
    if (
      canonicalize(compiled.slots) !== canonicalize(calibration.slots) ||
      compiled.shardPlanFingerprint !== calibration.shardPlanFingerprint
    )
      return fail('PLAN_DRIFT');
    const events = records.slice(2, -1).map((record) => record.event);
    const finished: Extract<DiagnosticCalibrationEventV1, { type: 'slot-finished' }>[] = [];
    let cursor = 0;
    for (const slot of calibration.slots) {
      const start = events[cursor];
      if (
        start?.type !== 'slot-started' ||
        start.order !== slot.order ||
        start.instanceId !== slot.instanceId ||
        start.runId !== slot.runId
      )
        break;
      cursor++;
      const end = events[cursor++];
      if (
        end?.type !== 'slot-finished' ||
        end.order !== slot.order ||
        end.instanceId !== slot.instanceId ||
        end.runId !== slot.runId
      )
        return fail('LEDGER_INVALID');
      if (
        end.failureCode === 'EXECUTION_INTERRUPTED' &&
        end.outcome === null &&
        end.cliStatus === null &&
        end.recordDigest === null &&
        end.evidenceDigest === null &&
        end.cleanupVerified === false &&
        end.evidenceVerified === false &&
        end.evidenceFileCount === 0 &&
        end.evidenceByteCount === 0 &&
        end.evidenceFiles.length === 0 &&
        end.evidenceFilesDigest === sha256Hex(canonicalize([])) &&
        !lstatSync(path.join(d.skillRoot, 'evidence/runs', slot.runId), {
          throwIfNoEntry: false,
        })
      ) {
        if (!isGovernanceTiming(end.timing)) return fail('TIMING_INVALID');
        finished.push(end);
        break;
      }
      const child = d.readAndVerifyChild(slot.runId);
      const bytesResult = inventoryEvidenceRoot(d.skillRoot, slot.runId);
      if (
        child.runId !== slot.runId ||
        child.caseId !== slot.caseId ||
        child.materializationFingerprint !== slot.materializationFingerprint ||
        child.planFingerprint !== slot.planFingerprint ||
        child.cellId !== slot.cell.cellId ||
        child.profile !== 'release' ||
        child.provenance !== 'manifest' ||
        child.evidenceDepth !== 'standard' ||
        !child.recordDigest ||
        child.recordDigest !== end.recordDigest ||
        child.evidenceDigest !== end.evidenceDigest ||
        child.outcome !== end.outcome ||
        !child.valid ||
        child.cleanupVerified !== end.cleanupVerified ||
        child.evidenceVerified !== end.evidenceVerified ||
        !child.cleanupVerified ||
        !child.evidenceVerified ||
        bytesResult.digest !== end.evidenceFilesDigest ||
        bytesResult.bytes !== end.evidenceByteCount ||
        bytesResult.files.length !== end.evidenceFileCount ||
        canonicalize(bytesResult.files) !== canonicalize(end.evidenceFiles)
      )
        return fail(
          child.code && isCalibrationFailureCode(child.code) ? child.code : 'CHILD_RECORD_INVALID',
        );
      if (end.timing === undefined || !isGovernanceTiming(end.timing))
        return fail('TIMING_INVALID');
      finished.push(end);
    }
    if (cursor !== events.length || d.collectSourceDigest() !== calibration.sourceProvenanceDigest)
      return fail('LEDGER_INVALID');
    const state = terminal.state;
    const expectedState = assessState(
      calibration.slots,
      finished,
      state === 'INTERRUPTED',
      terminal.failureCode,
    );
    const missingTerminalTiming =
      state === 'INTERRUPTED' &&
      terminal.failureCode === 'TIMING_INVALID' &&
      finished.length === 0 &&
      terminal.timing === undefined;
    if (
      state !== expectedState ||
      terminal.completedCount !== finished.length ||
      canonicalize(terminal.unstartedOrders) !==
        canonicalize(calibration.slots.slice(finished.length).map((slot) => slot.order)) ||
      (!missingTerminalTiming &&
        (!isGovernanceTiming(terminal.timing) ||
          terminal.timing.elapsedMs <
            finished.reduce((sum, event) => sum + (event.timing?.elapsedMs ?? 0), 0))) ||
      (finished.some((event) => event.failureCode !== null) &&
        terminal.failureCode !== finished.at(-1)?.failureCode)
    )
      return fail('LEDGER_INVALID');
    return {
      ok: true,
      value: {
        calibration,
        finalLedgerDigest: records.at(-1)!.digest,
        state,
        timing: terminal.timing ?? null,
        slots: finished
          .filter((event) => event.recordDigest !== null && event.evidenceDigest !== null)
          .map((event) => ({
            order: event.order,
            runId: event.runId,
            outcome: event.outcome,
            recordDigest: event.recordDigest!,
            evidenceDigest: event.evidenceDigest!,
            evidenceFileCount: event.evidenceFileCount,
            evidenceByteCount: event.evidenceByteCount,
          })),
      },
    };
  } catch {
    return fail('LEDGER_INVALID');
  }
}

// ── Read-only WP3b measurement-set eligibility join ──────────────────────────
//
// `deriveFreshMeasurementContent` recomputes the *current* measurement-set
// content from explicitly named, re-read and verified lineage: the all-PASS
// full-manifest Diagnostic calibration, the exactly matched all-PASS fixed
// Qualification batch, and the read-back retention snapshot that covers every
// required ledger/run-evidence byte. It derives each run's measured family from
// the validated manifest route/subject/adapter, never from a caller, and refuses
// an ambiguous family. It is strictly read-only: it creates no directory, ledger,
// audit, measurement set or child, and it accepts no caller-supplied metrics.
//
// Persisting a `BudgetMeasurementSetV1`, its verifier, any policy/Release credit
// and any CLI route are separate, later-authorized work packages.

/** Explicit caller-named current lineage for one re-derived measurement set. */
export interface FreshMeasurementContentInputV1 {
  readonly calibrationId: string;
  readonly qualificationBatchId: string;
  readonly retentionAuditId: string;
}

/** ADR 0108: packaged, pinned preactivation scope — never a caller-selected sample. */
function approvedQualificationSample(
  skillRoot: string,
  calibration: DiagnosticCalibrationV1,
  batch: import('../contracts/qualification-runtime').QualificationBatchV1,
): boolean {
  const anchor = BUDGET_SAMPLE_AUTHORITY_REGISTRY.find(
    (item) =>
      item.manifestId === calibration.manifestId &&
      item.manifestFingerprint === calibration.manifestFingerprint &&
      item.draftBytesDigest === calibration.draftBytesDigest &&
      item.requiredCellId === calibration.requiredCell.cellId,
  );
  if (!anchor) return false;
  try {
    let directory = skillRoot;
    for (const part of anchor.directory.split('/')) {
      directory = path.join(directory, part);
      if (!safeDirectory(directory)) return false;
    }
    const readPinned = (name: string, digest: string): Buffer => {
      const bytes = readFileBounded(path.join(directory, name), MAX_DRAFT_BYTES);
      if (digestBytes(bytes) !== digest) throw new Error('SAMPLE_AUTHORITY_INVALID');
      return bytes;
    };
    readPinned('decision.md', anchor.decisionDigest);
    readPinned('review.md', anchor.reviewDigest);
    const proposal: unknown = JSON.parse(
      readPinned('proposed-scope.json', anchor.proposalDigest).toString('utf8'),
    );
    if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) return false;
    const p = proposal as Record<string, unknown>;
    if (
      p.schemaVersion !== 1 ||
      p.state !== 'PROPOSED_NOT_APPROVED' ||
      p.releaseCredit !== false ||
      p.manifestId !== anchor.manifestId ||
      p.contentFingerprint !== anchor.manifestFingerprint ||
      p.artifact !== calibration.draftReference ||
      !Array.isArray(p.qualificationEntryIdsInOrder) ||
      !Array.isArray(p.qualificationScenarioOrder) ||
      p.qualificationEntryIdsInOrder.length !== 3 ||
      p.qualificationScenarioOrder.length !== 3 ||
      !p.qualificationEntryIdsInOrder.every((value) => typeof value === 'string') ||
      !p.qualificationScenarioOrder.every((value) => typeof value === 'string') ||
      new Set(p.qualificationEntryIdsInOrder).size !== 3 ||
      canonicalize(batch.selectedEntryIds) !== canonicalize(p.qualificationEntryIdsInOrder) ||
      batch.slots.length !== 3 ||
      batch.requiredCellIds.length !== 1 ||
      batch.requiredCellIds[0] !== anchor.requiredCellId
    )
      return false;
    const entryIds = p.qualificationEntryIdsInOrder as string[];
    const scenarios = p.qualificationScenarioOrder as string[];
    return batch.slots.every((slot, index) => {
      const entry = calibration.candidate.content.entries.find(
        (item) => item.entryId === entryIds[index],
      );
      return (
        slot.ordinal === index + 1 &&
        slot.entryId === entry?.entryId &&
        entry?.scenarioId === scenarios[index] &&
        slot.cell.cellId === anchor.requiredCellId
      );
    });
  } catch {
    return false;
  }
}

interface DerivedEntryRouteV1 {
  readonly family: BudgetMeasuredFamilyV1;
  readonly adapterId: string;
  readonly workflowId: string;
}

interface RequiredCoverageV1 {
  readonly namespace: RetentionNamespace;
  readonly relativePath: string;
  readonly byteCount: number;
  readonly sha256: string;
}

const MEASURED_APPLICATION_KIND_FAMILIES: Readonly<Record<string, BudgetMeasuredFamilyV1>> = {
  image: 'image',
  text: 'text',
  object: 'object',
  crossword: 'crossword',
};

const ADAPTER_FOR_MEASURED_FAMILY: Readonly<Record<BudgetMeasuredFamilyV1, string>> = {
  image: 'image-specialized',
  text: 'text-specialized',
  object: 'object-specialized',
  crossword: 'generated-specialized',
  history: 'default',
  restore: 'default',
};

/**
 * Derives exactly one measured family from the validated manifest's resolved
 * route, subject application kind and adapter. An unknown application kind, an
 * adapter that disagrees with the application kind, an undelivered generic
 * capability, or a non-`default` adapter without an application kind is
 * ambiguous and returns `null` so the join refuses instead of guessing.
 */
function deriveMeasuredFamily(
  materializedCase: PreparedExecutionCandidate['planning']['materializedCase'],
): BudgetMeasuredFamilyV1 | null {
  const adapterId = materializedCase.route.adapterId;
  const applicationKind = materializedCase.subject.applicationKind;
  if (applicationKind !== null) {
    const family = MEASURED_APPLICATION_KIND_FAMILIES[applicationKind];
    if (!family || ADAPTER_FOR_MEASURED_FAMILY[family] !== adapterId) return null;
    return family;
  }
  if (adapterId !== 'default') return null;
  const capability = materializedCase.route.capability;
  if (capability === 'history') return 'history';
  if (capability === 'frontendSerializeRestore') return 'restore';
  return null;
}

/** Compiles every validated manifest entry and derives its closed family/route. */
function deriveEntryRoutes(
  candidate: ExecutableSelectionManifestDraftV1,
  d: BudgetRuntimeDependencies,
): BudgetMeasurementResult<Map<string, DerivedEntryRouteV1>> {
  const routes = new Map<string, DerivedEntryRouteV1>();
  for (const entry of candidate.content.entries) {
    if (routes.has(entry.entryId)) return { ok: false, code: 'MEASUREMENT_INVALID' };
    const compiled = d.compileCandidate(entry.request);
    if (!compiled.ok) return { ok: false, code: 'MEASUREMENT_INVALID' };
    const materializedCase = compiled.candidate.planning.materializedCase;
    const family = deriveMeasuredFamily(materializedCase);
    if (family === null) return { ok: false, code: 'MEASUREMENT_INVALID' };
    if (
      compiled.candidate.identity.caseId !== entry.caseId ||
      compiled.candidate.identity.materializationFingerprint !== entry.materializationFingerprint ||
      compiled.candidate.identity.planFingerprint !== entry.planFingerprint
    )
      return { ok: false, code: 'MEASUREMENT_INVALID' };
    routes.set(entry.entryId, {
      family,
      adapterId: materializedCase.route.adapterId,
      workflowId: materializedCase.route.workflowId,
    });
  }
  if (routes.size !== candidate.content.entries.length)
    return { ok: false, code: 'MEASUREMENT_INVALID' };
  return { ok: true, value: routes };
}

function eventFileName(sequence: number): string {
  return `event-${String(sequence).padStart(6, '0')}.json`;
}

/** Digest-bound required coverage for one closed ledger's ordered event files. */
function ledgerCoverage(
  namespace: RetentionNamespace,
  directoryPrefix: string,
  records: readonly unknown[],
): RequiredCoverageV1[] {
  return records.map((record, index) => {
    const bytes = Buffer.from(`${canonicalize(record)}\n`);
    return {
      namespace,
      relativePath: `${directoryPrefix}/${eventFileName(index + 1)}`,
      byteCount: bytes.byteLength,
      sha256: digestBytes(bytes),
    };
  });
}

function runCoverage(
  runId: string,
  files: readonly { readonly path: string; readonly byteCount: number; readonly sha256: string }[],
): RequiredCoverageV1[] {
  return files.map((file) => ({
    namespace: 'run-evidence',
    relativePath: `${runId}/${file.path}`,
    byteCount: file.byteCount,
    sha256: file.sha256,
  }));
}

function hasCoverage(
  snapshot: { readonly artifacts: readonly RequiredCoverageV1[] },
  required: RequiredCoverageV1,
): boolean {
  const artifact = snapshot.artifacts.find(
    (candidate) =>
      candidate.namespace === required.namespace &&
      candidate.relativePath === required.relativePath,
  );
  return (
    artifact !== undefined &&
    artifact.byteCount === required.byteCount &&
    artifact.sha256 === required.sha256
  );
}

function validMeasuredRun(run: BudgetMeasuredRunV1): boolean {
  return (
    typeof run.runId === 'string' &&
    isSafeRunId(run.runId) &&
    typeof run.entryId === 'string' &&
    run.entryId.length > 0 &&
    Number.isFinite(run.elapsedMs) &&
    run.elapsedMs >= 0 &&
    Number.isSafeInteger(run.evidenceFileCount) &&
    run.evidenceFileCount >= 0 &&
    Number.isSafeInteger(run.evidenceByteCount) &&
    run.evidenceByteCount >= 0 &&
    (run.imageApplicability === 'MEASURED' || run.imageApplicability === 'UNAVAILABLE') &&
    (run.imageTornRecaptures === null ||
      (Number.isSafeInteger(run.imageTornRecaptures) && run.imageTornRecaptures >= 0))
  );
}

interface MeasuredRunSlotV1 {
  readonly entryId: string;
  readonly runId: string;
  readonly timing: GovernanceTimingV1;
  readonly recordDigest: string;
}

/**
 * Re-reads one run's real owned evidence root and strict public v4 record,
 * binds the record to the verified ledger entry digest and manifest route, and
 * projects the measured run plus its exact retention coverage.
 */
function projectMeasuredRun(
  slot: MeasuredRunSlotV1,
  route: DerivedEntryRouteV1,
  d: BudgetRuntimeDependencies,
): BudgetMeasurementResult<{
  readonly run: BudgetMeasuredRunV1;
  readonly coverage: RequiredCoverageV1[];
}> {
  let inventory: ReturnType<typeof inventoryEvidenceRoot>;
  try {
    inventory = inventoryEvidenceRoot(d.skillRoot, slot.runId);
  } catch {
    return { ok: false, code: 'MEASUREMENT_INVALID' };
  }
  let read: ReturnType<typeof readFinalPublicRecordFile>;
  try {
    read = readFinalPublicRecordFile(
      path.join(d.skillRoot, 'evidence', 'runs', slot.runId, 'run-record.json'),
    );
  } catch {
    return { ok: false, code: 'MEASUREMENT_INVALID' };
  }
  if (read.kind !== 'current-v4' || read.record.command !== 'diagnostic')
    return { ok: false, code: 'MEASUREMENT_INVALID' };
  const record = read.record;
  if (
    sha256Hex(canonicalize(record)) !== slot.recordDigest ||
    record.runId !== slot.runId ||
    record.adapter.adapterId !== route.adapterId ||
    record.workflow.workflowId !== route.workflowId
  )
    return { ok: false, code: 'MEASUREMENT_INVALID' };
  const projected = projectBudgetMeasuredRun({
    entryId: slot.entryId,
    runId: slot.runId,
    family: route.family,
    timing: slot.timing,
    inventory: {
      evidenceFileCount: inventory.files.length,
      evidenceByteCount: inventory.bytes,
    },
    record,
  });
  if (!projected.ok) return projected;
  return {
    ok: true,
    value: { run: projected.value, coverage: runCoverage(slot.runId, inventory.files) },
  };
}

/**
 * Recomputes and validates the current measurement-set content for the exact
 * named calibration, Qualification batch and retention audit. Every fact is
 * re-read from disk; nothing is written. Returns a closed refusal code instead
 * of a partial or caller-influenced set.
 */
export function deriveFreshMeasurementContent(
  input: FreshMeasurementContentInputV1,
  options: BudgetRuntimeOptions = {},
): BudgetMeasurementResult<BudgetMeasurementSetContentV1> {
  if (!input || typeof input !== 'object') return { ok: false, code: 'INPUT_INVALID' };
  const d = dependencies(options);
  const calibrationId = input.calibrationId;
  const qualificationBatchId = input.qualificationBatchId;
  const retentionAuditId = input.retentionAuditId;
  if (
    typeof calibrationId !== 'string' ||
    !DIAGNOSTIC_CALIBRATION_ID_PATTERN.test(calibrationId) ||
    !isQualificationBatchId(qualificationBatchId) ||
    typeof retentionAuditId !== 'string' ||
    retentionAuditId.length === 0
  )
    return { ok: false, code: 'INPUT_INVALID' };
  const verifyQualification =
    d.verifyQualification ??
    ((batchId: string) =>
      verifyQualificationBatch(batchId, {
        dependencies: {
          skillRoot: d.skillRoot,
          repoRoot: d.repoRoot,
          loadContext: d.loadContext,
          compileCandidate: d.compileCandidate,
          collectSourceDigest: d.collectSourceDigest,
          readAndVerifyChild: d.readAndVerifyChild,
        },
      }));
  try {
    // 1 — the current all-PASS full-manifest calibration, re-read and verified.
    const calibration = verifyDiagnosticCalibration(calibrationId, options);
    if (!calibration.ok || calibration.value.state !== 'COMPLETE_ALL_PASS')
      return { ok: false, code: 'CALIBRATION_INVALID' };
    const qualification = verifyQualification(qualificationBatchId);
    if (!qualification.ok) return { ok: false, code: 'QUALIFICATION_INVALID' };
    if (!isGovernanceTiming(calibration.value.timing))
      return { ok: false, code: 'MEASUREMENT_INVALID' };
    const manifest = calibration.value.calibration;
    const routes = deriveEntryRoutes(manifest.candidate, d);
    if (!routes.ok) return routes;
    let calibrationRecords: DiagnosticCalibrationLedgerRecordV1[];
    try {
      calibrationRecords = readLedger(d.skillRoot, calibrationId);
    } catch {
      return { ok: false, code: 'CALIBRATION_INVALID' };
    }
    if (calibrationRecords.at(-1)?.digest !== calibration.value.finalLedgerDigest)
      return { ok: false, code: 'CALIBRATION_INVALID' };
    const calibrationFinished = new Map<
      number,
      Extract<DiagnosticCalibrationEventV1, { type: 'slot-finished' }>
    >();
    for (const record of calibrationRecords)
      if (record.event.type === 'slot-finished')
        calibrationFinished.set(record.event.order, record.event);
    if (calibrationFinished.size !== manifest.slots.length)
      return { ok: false, code: 'CALIBRATION_INVALID' };

    const coverage: RequiredCoverageV1[] = [
      ...ledgerCoverage(
        'budget-measurements',
        `calibrations/${calibrationId}/events`,
        calibrationRecords,
      ),
    ];
    const calibrationRuns: BudgetMeasuredRunV1[] = [];
    for (const slot of manifest.slots) {
      const finish = calibrationFinished.get(slot.order);
      const route = routes.value.get(slot.entryId);
      if (
        !finish ||
        finish.runId !== slot.runId ||
        finish.failureCode !== null ||
        finish.outcome !== 'PASS' ||
        !route
      )
        return { ok: false, code: 'CALIBRATION_INVALID' };
      if (!isGovernanceTiming(finish.timing) || !finish.recordDigest)
        return { ok: false, code: 'MEASUREMENT_INVALID' };
      const projected = projectMeasuredRun(
        {
          entryId: slot.entryId,
          runId: slot.runId,
          timing: finish.timing,
          recordDigest: finish.recordDigest,
        },
        route,
        d,
      );
      if (!projected.ok) return projected;
      calibrationRuns.push(projected.value.run);
      coverage.push(...projected.value.coverage);
    }
    if (calibrationRuns.length !== manifest.slots.length)
      return { ok: false, code: 'CALIBRATION_INVALID' };

    // 2 — the exactly matched all-PASS fixed three-slot Qualification batch.
    const batch = qualification.verified.batch;
    if (
      batch.slots.length !== 3 ||
      batch.selectedEntryIds.length !== 3 ||
      batch.manifestId !== manifest.manifestId ||
      batch.manifestFingerprint !== manifest.manifestFingerprint ||
      batch.sourceProvenanceDigest !== manifest.sourceProvenanceDigest ||
      canonicalize(batch.candidate) !== canonicalize(manifest.candidate) ||
      !batch.requiredCellIds.includes(manifest.requiredCell.cellId)
    )
      return { ok: false, code: 'LINEAGE_MISMATCH' };
    if (!approvedQualificationSample(d.skillRoot, manifest, batch))
      return { ok: false, code: 'LINEAGE_MISMATCH' };
    let qualificationRecords: ReturnType<typeof readQualificationLedger>;
    try {
      qualificationRecords = readQualificationLedger(d.skillRoot, qualificationBatchId);
    } catch {
      return { ok: false, code: 'QUALIFICATION_INVALID' };
    }
    if (qualificationRecords.at(-1)?.digest !== qualification.verified.finalLedgerDigest)
      return { ok: false, code: 'QUALIFICATION_INVALID' };
    const assessed = qualificationRecords.at(-1)?.event;
    if (assessed?.type !== 'batch-assessed' || !isGovernanceTiming(assessed.timing))
      return { ok: false, code: 'QUALIFICATION_INVALID' };
    const qualificationFinished = new Map<
      number,
      Extract<
        ReturnType<typeof readQualificationLedger>[number]['event'],
        { type: 'instance-finished' }
      >
    >();
    for (const record of qualificationRecords)
      if (record.event.type === 'instance-finished')
        qualificationFinished.set(record.event.ordinal, record.event);
    coverage.push(
      ...ledgerCoverage(
        'qualification-authority',
        `batches/${qualificationBatchId}/events`,
        qualificationRecords,
      ),
    );
    const qualificationRuns: BudgetMeasuredRunV1[] = [];
    for (const slot of batch.slots) {
      const finish = qualificationFinished.get(slot.ordinal);
      const route = routes.value.get(slot.entryId);
      if (
        !finish ||
        finish.runId !== slot.runId ||
        finish.failureCode !== null ||
        finish.outcome !== 'PASS' ||
        !route ||
        slot.cell.cellId !== manifest.requiredCell.cellId
      )
        return { ok: false, code: 'QUALIFICATION_INVALID' };
      if (!isGovernanceTiming(finish.timing) || !finish.recordDigest)
        return { ok: false, code: 'MEASUREMENT_INVALID' };
      const projected = projectMeasuredRun(
        {
          entryId: slot.entryId,
          runId: slot.runId,
          timing: finish.timing,
          recordDigest: finish.recordDigest,
        },
        route,
        d,
      );
      if (!projected.ok) return projected;
      qualificationRuns.push(projected.value.run);
      coverage.push(...projected.value.coverage);
    }
    if (qualificationRuns.length !== 3) return { ok: false, code: 'QUALIFICATION_INVALID' };

    // 3 — the read-back retention snapshot must cover every required byte.
    const retention = readAndVerifyRetentionAudit(d.skillRoot, retentionAuditId);
    if (!retention.ok) return { ok: false, code: 'RETENTION_INVALID' };
    if (!coverage.every((required) => hasCoverage(retention.value.snapshot, required)))
      return { ok: false, code: 'RETENTION_INVALID' };

    // 4 — manifest-derived family applicability, never a caller claim.
    const selected = new Set<BudgetMeasuredFamilyV1>();
    for (const route of routes.value.values()) selected.add(route.family);
    const allRuns = [...calibrationRuns, ...qualificationRuns];
    const families: BudgetFamilyMeasurementV1[] = [];
    for (const family of BUDGET_MEASURED_FAMILIES) {
      if (!selected.has(family)) {
        families.push({
          family,
          status: 'NOT_APPLICABLE',
          tornRecaptureCount: null,
          reason: 'NOT_IN_MANIFEST',
        });
        continue;
      }
      if (family !== 'image') {
        families.push({
          family,
          status: 'UNAVAILABLE',
          tornRecaptureCount: null,
          reason: 'NO_TRUSTED_V4_COUNTER',
        });
        continue;
      }
      let total = 0;
      let measured = 0;
      for (const run of allRuns) {
        if (run.imageApplicability !== 'MEASURED' || run.imageTornRecaptures === null) continue;
        total += run.imageTornRecaptures;
        measured += 1;
        if (!Number.isSafeInteger(total)) return { ok: false, code: 'MEASUREMENT_INVALID' };
      }
      if (measured === 0) return { ok: false, code: 'MEASUREMENT_INVALID' };
      families.push({
        family,
        status: 'MEASURED',
        tornRecaptureCount: total,
        reason: 'STRICT_V4_IMAGE_CYCLES',
      });
    }

    const content: BudgetMeasurementSetContentV1 = {
      schemaVersion: BUDGET_MEASUREMENT_SET_SCHEMA_VERSION,
      joinMethod: BUDGET_MEASUREMENT_JOIN_METHOD,
      verifierMethod: BUDGET_MEASUREMENT_VERIFIER_METHOD,
      calibrationId,
      calibrationLedgerDigest: calibration.value.finalLedgerDigest,
      qualificationBatchId,
      qualificationLedgerDigest: qualification.verified.finalLedgerDigest,
      retentionAuditId,
      retentionAuditDigest: retention.value.digest,
      manifestId: manifest.manifestId,
      manifestFingerprint: manifest.manifestFingerprint,
      sourceProvenanceDigest: manifest.sourceProvenanceDigest,
      requiredCellId: manifest.requiredCell.cellId,
      calibrationElapsedMs: calibration.value.timing.elapsedMs,
      qualificationElapsedMs: assessed.timing.elapsedMs,
      calibrationRuns,
      qualificationRuns,
      families,
      releaseCredit: false,
    };
    if (
      content.calibrationRuns.length !== manifest.slots.length ||
      content.qualificationRuns.length !== 3 ||
      content.families.length !== BUDGET_MEASURED_FAMILIES.length ||
      !content.calibrationRuns.every(validMeasuredRun) ||
      !content.qualificationRuns.every(validMeasuredRun) ||
      !Number.isFinite(content.calibrationElapsedMs) ||
      content.calibrationElapsedMs < 0 ||
      !Number.isFinite(content.qualificationElapsedMs) ||
      content.qualificationElapsedMs < 0
    )
      return { ok: false, code: 'MEASUREMENT_INVALID' };
    return { ok: true, value: content };
  } catch {
    return { ok: false, code: 'MEASUREMENT_INVALID' };
  }
}

const MEASUREMENT_DIRECTORY = 'evidence/governance/budget/measurements/sets';

function measurementRecord(content: BudgetMeasurementSetContentV1): BudgetMeasurementSetV1 {
  const contentDigest = sha256Hex(canonicalize(content));
  return {
    schemaVersion: BUDGET_MEASUREMENT_SET_SCHEMA_VERSION,
    measurementSetId: `bset-${contentDigest}`,
    content,
    contentDigest,
  };
}

function measurementPath(skillRoot: string, id: string, create: boolean): string {
  if (!BUDGET_MEASUREMENT_SET_ID_PATTERN.test(id)) throw new Error('MEASUREMENT_INVALID');
  const directory = create
    ? ensureDirectory(skillRoot, MEASUREMENT_DIRECTORY)
    : path.join(skillRoot, MEASUREMENT_DIRECTORY);
  if (!safeDirectory(directory)) throw new Error('MEASUREMENT_INVALID');
  return path.join(directory, `${id}.json`);
}

/** Recompute current lineage rather than trusting a persisted content digest alone. */
export function verifyBudgetMeasurementSet(
  measurementSetId: string,
  options: BudgetRuntimeOptions = {},
): BudgetMeasurementResult<BudgetMeasurementSetV1> {
  if (!BUDGET_MEASUREMENT_SET_ID_PATTERN.test(measurementSetId))
    return { ok: false, code: 'INPUT_INVALID' };
  let file: string;
  try {
    const d = dependencies(options);
    file = measurementPath(d.skillRoot, measurementSetId, false);
  } catch {
    return { ok: false, code: 'MEASUREMENT_INVALID' };
  }
  try {
    const bytes = readFileBounded(file, MAX_LEDGER_BYTES);
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    if (
      !exactKeys(parsed, ['schemaVersion', 'measurementSetId', 'content', 'contentDigest']) ||
      parsed.schemaVersion !== BUDGET_MEASUREMENT_SET_SCHEMA_VERSION ||
      parsed.measurementSetId !== measurementSetId ||
      typeof parsed.contentDigest !== 'string' ||
      !exactKeys(parsed.content, [
        'schemaVersion',
        'joinMethod',
        'verifierMethod',
        'calibrationId',
        'calibrationLedgerDigest',
        'qualificationBatchId',
        'qualificationLedgerDigest',
        'retentionAuditId',
        'retentionAuditDigest',
        'manifestId',
        'manifestFingerprint',
        'sourceProvenanceDigest',
        'requiredCellId',
        'calibrationElapsedMs',
        'qualificationElapsedMs',
        'calibrationRuns',
        'qualificationRuns',
        'families',
        'releaseCredit',
      ])
    )
      return { ok: false, code: 'MEASUREMENT_INVALID' };
    const record = parsed as unknown as BudgetMeasurementSetV1;
    if (
      record.content.joinMethod !== BUDGET_MEASUREMENT_JOIN_METHOD ||
      record.content.verifierMethod !== BUDGET_MEASUREMENT_VERIFIER_METHOD
    )
      return { ok: false, code: 'MEASUREMENT_INVALID' };
    const current = deriveFreshMeasurementContent(
      {
        calibrationId: record.content.calibrationId,
        qualificationBatchId: record.content.qualificationBatchId,
        retentionAuditId: record.content.retentionAuditId,
      },
      options,
    );
    if (!current.ok) return current;
    const expected = measurementRecord(current.value);
    if (
      canonicalize(record) !== canonicalize(expected) ||
      !bytes.equals(Buffer.from(`${canonicalize(expected)}\n`))
    )
      return { ok: false, code: 'MEASUREMENT_INVALID' };
    return { ok: true, value: expected };
  } catch (error) {
    return {
      ok: false,
      code:
        error instanceof Error && 'code' in error && error.code === 'ENOENT'
          ? 'MEASUREMENT_NOT_FOUND'
          : 'MEASUREMENT_INVALID',
    };
  }
}

/** Append one immutable no-credit record for explicitly named, freshly verified inputs. */
export function createFreshMeasurementSet(
  input: FreshMeasurementContentInputV1,
  options: BudgetRuntimeOptions = {},
): BudgetMeasurementResult<BudgetMeasurementSetV1> {
  const derived = deriveFreshMeasurementContent(input, options);
  if (!derived.ok) return derived;
  try {
    const d = dependencies(options);
    const record = measurementRecord(derived.value);
    const bytes = Buffer.from(`${canonicalize(record)}\n`);
    if (bytes.byteLength > MAX_LEDGER_BYTES) return { ok: false, code: 'MEASUREMENT_INVALID' };
    const file = measurementPath(d.skillRoot, record.measurementSetId, true);
    const fd = openSync(
      file,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const stat = fstatSync(fd, { bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n) throw new Error('MEASUREMENT_WRITE_REFUSED');
      let offset = 0;
      while (offset < bytes.length) {
        const count = writeSync(fd, bytes, offset, bytes.length - offset, offset);
        if (count <= 0) throw new Error('MEASUREMENT_WRITE_REFUSED');
        offset += count;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const reread = verifyBudgetMeasurementSet(record.measurementSetId, options);
    return reread.ok ? reread : { ok: false, code: 'MEASUREMENT_WRITE_REFUSED' };
  } catch {
    return { ok: false, code: 'MEASUREMENT_WRITE_REFUSED' };
  }
}

//
// Pure `full-scope-envelope-v1` feasibility checker.
//
// Trust boundary (explicit): the caller supplies (a) an already-verified
// measurement-set content — for example the canonical value returned by
// `verifyBudgetMeasurementSet`/`deriveFreshMeasurementContent` — (b) a closed
// proposal, and (c) a retained inventory byte count already derived from a
// verified `RetentionSnapshotV1` readback for the policy-bound audit. This
// function performs no filesystem access, authors/proves no approval, and does
// not prove that (c) matches the snapshot: it only checks that (c) is a safe
// nonnegative integer and that the policy binds the audit id/digest it was
// derived from. It never supplies a default or invented ceiling.

const HEX64 = /^[0-9a-f]{64}$/;
const BUDGET_POLICY_KEYS = [
  'schemaVersion',
  'method',
  'state',
  'releaseCredit',
  'measurementSetId',
  'measurementSetContentDigest',
  'retentionAuditId',
  'retentionAuditDigest',
  'manifestId',
  'manifestFingerprint',
  'sourceProvenanceDigest',
  'requiredCellId',
  'familyStates',
  'tornCounterDependencies',
  'ceilings',
] as const;
const BUDGET_POLICY_CEILING_KEYS = [
  'releaseDurationMs',
  'releaseEvidenceBytes',
  'qualificationDurationMs',
  'qualificationEvidenceBytes',
  'retainedEvidenceBytes',
  'imageTornRecaptures',
] as const;
const BUDGET_POLICY_FAMILY_STATE_KEYS = ['family', 'status'] as const;
const BUDGET_MEASUREMENT_CONTENT_KEYS = [
  'schemaVersion',
  'joinMethod',
  'verifierMethod',
  'calibrationId',
  'calibrationLedgerDigest',
  'qualificationBatchId',
  'qualificationLedgerDigest',
  'retentionAuditId',
  'retentionAuditDigest',
  'manifestId',
  'manifestFingerprint',
  'sourceProvenanceDigest',
  'requiredCellId',
  'calibrationElapsedMs',
  'qualificationElapsedMs',
  'calibrationRuns',
  'qualificationRuns',
  'families',
  'releaseCredit',
] as const;

function isKnownFamily(value: unknown): value is BudgetMeasuredFamilyV1 {
  return (
    typeof value === 'string' && BUDGET_MEASURED_FAMILIES.includes(value as BudgetMeasuredFamilyV1)
  );
}

/** Structural validation of one measured run, including its Image self-consistency. */
function wellFormedMeasuredRun(run: unknown): boolean {
  if (
    !exactKeys(run, [
      'runId',
      'entryId',
      'elapsedMs',
      'evidenceFileCount',
      'evidenceByteCount',
      'imageTornRecaptures',
      'imageApplicability',
    ])
  )
    return false;
  const value = run as Record<string, unknown>;
  if (!isSafeRunId(value.runId) || typeof value.entryId !== 'string' || value.entryId.length === 0)
    return false;
  if (!Number.isFinite(value.elapsedMs) || (value.elapsedMs as number) < 0) return false;
  if (
    !Number.isSafeInteger(value.evidenceFileCount) ||
    (value.evidenceFileCount as number) < 0 ||
    !Number.isSafeInteger(value.evidenceByteCount) ||
    (value.evidenceByteCount as number) < 0
  )
    return false;
  if (value.imageApplicability === 'MEASURED') {
    return (
      Number.isSafeInteger(value.imageTornRecaptures) && (value.imageTornRecaptures as number) >= 0
    );
  }
  if (value.imageApplicability === 'UNAVAILABLE') return value.imageTornRecaptures === null;
  return false;
}

function wellFormedFamily(family: unknown): boolean {
  if (!exactKeys(family, ['family', 'status', 'tornRecaptureCount', 'reason'])) return false;
  const value = family as Record<string, unknown>;
  if (!isKnownFamily(value.family)) return false;
  if (value.status === 'MEASURED') {
    return (
      value.reason === 'STRICT_V4_IMAGE_CYCLES' &&
      value.family === 'image' &&
      Number.isSafeInteger(value.tornRecaptureCount) &&
      (value.tornRecaptureCount as number) >= 0
    );
  }
  if (value.status === 'UNAVAILABLE') {
    return value.reason === 'NO_TRUSTED_V4_COUNTER' && value.tornRecaptureCount === null;
  }
  if (value.status === 'NOT_APPLICABLE') {
    return value.reason === 'NOT_IN_MANIFEST' && value.tornRecaptureCount === null;
  }
  return false;
}

/** Closed structural validation of already-verified measurement content. */
function wellFormedMeasurementContent(content: unknown): content is BudgetMeasurementSetContentV1 {
  if (!exactKeys(content, BUDGET_MEASUREMENT_CONTENT_KEYS)) return false;
  const value = content as Record<string, unknown>;
  if (
    value.schemaVersion !== BUDGET_MEASUREMENT_SET_SCHEMA_VERSION ||
    value.joinMethod !== BUDGET_MEASUREMENT_JOIN_METHOD ||
    value.verifierMethod !== BUDGET_MEASUREMENT_VERIFIER_METHOD ||
    value.releaseCredit !== false
  )
    return false;
  if (
    typeof value.calibrationId !== 'string' ||
    !DIAGNOSTIC_CALIBRATION_ID_PATTERN.test(value.calibrationId) ||
    !isQualificationBatchId(value.qualificationBatchId)
  )
    return false;
  for (const key of [
    'calibrationLedgerDigest',
    'qualificationLedgerDigest',
    'retentionAuditDigest',
    'manifestFingerprint',
    'sourceProvenanceDigest',
  ])
    if (typeof value[key] !== 'string' || !HEX64.test(value[key] as string)) return false;
  for (const key of ['retentionAuditId', 'manifestId', 'requiredCellId'])
    if (typeof value[key] !== 'string' || (value[key] as string).length === 0) return false;
  for (const key of ['calibrationElapsedMs', 'qualificationElapsedMs'])
    if (!Number.isFinite(value[key]) || (value[key] as number) < 0) return false;
  if (
    !Array.isArray(value.calibrationRuns) ||
    value.calibrationRuns.length === 0 ||
    !value.calibrationRuns.every(wellFormedMeasuredRun) ||
    !Array.isArray(value.qualificationRuns) ||
    value.qualificationRuns.length === 0 ||
    !value.qualificationRuns.every(wellFormedMeasuredRun)
  )
    return false;
  if (!Array.isArray(value.families) || value.families.length !== BUDGET_MEASURED_FAMILIES.length)
    return false;
  const seen = new Set<string>();
  for (const family of value.families) {
    if (!wellFormedFamily(family)) return false;
    const name = (family as { family: string }).family;
    if (seen.has(name)) return false;
    seen.add(name);
  }
  if (seen.size !== BUDGET_MEASURED_FAMILIES.length) return false;
  const image = (value.families as readonly BudgetFamilyMeasurementV1[]).find(
    (family) => family.family === 'image',
  );
  if (image?.status === 'MEASURED') {
    let total = 0;
    let measured = 0;
    const runs = [
      ...(value.calibrationRuns as readonly BudgetMeasuredRunV1[]),
      ...(value.qualificationRuns as readonly BudgetMeasuredRunV1[]),
    ];
    for (const run of runs) {
      if (run.imageApplicability !== 'MEASURED' || run.imageTornRecaptures === null) continue;
      total += run.imageTornRecaptures;
      measured += 1;
      if (!Number.isSafeInteger(total)) return false;
    }
    if (measured === 0 || total !== image.tornRecaptureCount) return false;
  }
  return true;
}

/** Closed structural validation of one policy proposal. */
function wellFormedPolicyProposal(policy: unknown): policy is BudgetPolicyProposalV1 {
  if (!exactKeys(policy, BUDGET_POLICY_KEYS)) return false;
  const value = policy as Record<string, unknown>;
  if (value.state !== 'PROPOSED_NOT_APPROVED' || value.releaseCredit !== false) return false;
  for (const key of ['manifestId', 'retentionAuditId', 'requiredCellId'])
    if (typeof value[key] !== 'string' || (value[key] as string).length === 0) return false;
  if (
    typeof value.measurementSetContentDigest !== 'string' ||
    !HEX64.test(value.measurementSetContentDigest) ||
    typeof value.measurementSetId !== 'string' ||
    !BUDGET_MEASUREMENT_SET_ID_PATTERN.test(value.measurementSetId) ||
    typeof value.retentionAuditDigest !== 'string' ||
    !HEX64.test(value.retentionAuditDigest) ||
    typeof value.manifestFingerprint !== 'string' ||
    !HEX64.test(value.manifestFingerprint) ||
    typeof value.sourceProvenanceDigest !== 'string' ||
    !HEX64.test(value.sourceProvenanceDigest)
  )
    return false;
  if (!exactKeys(value.ceilings, BUDGET_POLICY_CEILING_KEYS)) return false;
  const ceilings = value.ceilings as Record<string, unknown>;
  for (const key of ['releaseDurationMs', 'qualificationDurationMs'])
    if (!Number.isFinite(ceilings[key]) || (ceilings[key] as number) < 0) return false;
  for (const key of ['releaseEvidenceBytes', 'qualificationEvidenceBytes', 'retainedEvidenceBytes'])
    if (!Number.isSafeInteger(ceilings[key]) || (ceilings[key] as number) < 0) return false;
  if (
    !(
      ceilings.imageTornRecaptures === null ||
      (Number.isSafeInteger(ceilings.imageTornRecaptures) &&
        (ceilings.imageTornRecaptures as number) >= 0)
    )
  )
    return false;
  if (
    !Array.isArray(value.familyStates) ||
    value.familyStates.length !== BUDGET_MEASURED_FAMILIES.length
  )
    return false;
  const families = new Set<string>();
  for (const state of value.familyStates) {
    if (!exactKeys(state, BUDGET_POLICY_FAMILY_STATE_KEYS)) return false;
    const entry = state as Record<string, unknown>;
    if (
      !isKnownFamily(entry.family) ||
      (entry.status !== 'MEASURED' &&
        entry.status !== 'UNAVAILABLE' &&
        entry.status !== 'NOT_APPLICABLE') ||
      families.has(entry.family)
    )
      return false;
    families.add(entry.family);
  }
  if (families.size !== BUDGET_MEASURED_FAMILIES.length) return false;
  if (!Array.isArray(value.tornCounterDependencies)) return false;
  const dependencies = new Set<string>();
  for (const dependency of value.tornCounterDependencies) {
    if (!isKnownFamily(dependency) || dependencies.has(dependency)) return false;
    dependencies.add(dependency);
  }
  return true;
}

function policyRefusal(code: BudgetPolicyFailureCode): BudgetFeasibilityResultV1 {
  return { ok: false, code };
}

function sumRunBytes(runs: readonly BudgetMeasuredRunV1[]): number | null {
  let total = 0;
  for (const run of runs) {
    total += run.evidenceByteCount;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

export interface BudgetFeasibilityCheckInputV1 {
  /** Already-verified content; this pure checker re-validates its shape but does not re-read it. */
  readonly content: BudgetMeasurementSetContentV1;
  readonly policy: BudgetPolicyProposalV1;
  /**
   * Safety value derived by the retention service from a verified snapshot
   * readback for the policy-bound audit. Explicitly trusted as an input value:
   * the pure checker validates its shape and the bound audit identity, never
   * that the number itself was truly observed.
   */
  readonly retainedInventoryBytes: number;
}

/**
 * Pure `full-scope-envelope-v1` feasibility decision. Returns `FEASIBLE` only
 * when the proposal binds the supplied content exactly, the content is a closed
 * well-formed all-`MEASURED`/explicit-state measurement, Image is measured when
 * selected, no dependency rests on an unavailable counter, and every observed
 * dimension is at or below its separately approved ceiling (equality allowed).
 */
export function checkBudgetPolicyFeasibility(
  input: BudgetFeasibilityCheckInputV1,
): BudgetFeasibilityResultV1 {
  if (!input || typeof input !== 'object') return policyRefusal('POLICY_INVALID');
  const { policy, content } = input;
  if (!Number.isSafeInteger(input.retainedInventoryBytes) || input.retainedInventoryBytes < 0)
    return policyRefusal('RETAINED_BYTES_INVALID');
  if (!exactKeys(policy, BUDGET_POLICY_KEYS)) return policyRefusal('POLICY_INVALID');
  const rawPolicy = policy as unknown as Record<string, unknown>;
  if (
    rawPolicy.schemaVersion !== BUDGET_POLICY_SCHEMA_VERSION ||
    rawPolicy.method !== BUDGET_POLICY_METHOD
  )
    return policyRefusal('POLICY_UNSUPPORTED');
  if (!wellFormedPolicyProposal(policy)) return policyRefusal('POLICY_INVALID');
  if (!wellFormedMeasurementContent(content)) return policyRefusal('MEASUREMENT_SHAPE_INVALID');

  const contentDigest = sha256Hex(canonicalize(content));
  if (
    policy.measurementSetContentDigest !== contentDigest ||
    policy.measurementSetId !== `bset-${contentDigest}` ||
    policy.manifestId !== content.manifestId ||
    policy.manifestFingerprint !== content.manifestFingerprint ||
    policy.sourceProvenanceDigest !== content.sourceProvenanceDigest ||
    policy.requiredCellId !== content.requiredCellId ||
    policy.retentionAuditId !== content.retentionAuditId ||
    policy.retentionAuditDigest !== content.retentionAuditDigest
  )
    return policyRefusal('BINDING_MISMATCH');

  const contentFamilies = new Map(content.families.map((family) => [family.family, family]));
  const policyStates = new Map(policy.familyStates.map((state) => [state.family, state.status]));
  for (const family of BUDGET_MEASURED_FAMILIES) {
    const observed = contentFamilies.get(family);
    const declared = policyStates.get(family);
    if (!observed || !declared || declared !== observed.status)
      return policyRefusal('FAMILY_STATE_MISMATCH');
    // `full-scope-envelope-v1` supports only a measured Image and unavailable
    // (never zero) or absent non-Image families.
    if (family === 'image') {
      if (observed.status !== 'MEASURED' && observed.status !== 'NOT_APPLICABLE')
        return policyRefusal('FAMILY_STATE_MISMATCH');
    } else if (observed.status !== 'UNAVAILABLE' && observed.status !== 'NOT_APPLICABLE') {
      return policyRefusal('FAMILY_STATE_MISMATCH');
    }
  }

  const image = contentFamilies.get('image');
  if (!image) return policyRefusal('MEASUREMENT_SHAPE_INVALID');
  if (image.status === 'MEASURED') {
    if (policy.ceilings.imageTornRecaptures === null)
      return policyRefusal('REQUIRED_IMAGE_UNMEASURED');
  } else if (policy.ceilings.imageTornRecaptures !== null) {
    return policyRefusal('FAMILY_STATE_MISMATCH');
  }

  const measuredFamilies = content.families
    .filter((family) => family.status === 'MEASURED')
    .map((family) => family.family);
  for (const dependency of policy.tornCounterDependencies)
    if (contentFamilies.get(dependency)?.status !== 'MEASURED')
      return policyRefusal('UNAVAILABLE_DEPENDENCY');
  for (const family of measuredFamilies)
    if (!policy.tornCounterDependencies.includes(family))
      return policyRefusal('FAMILY_STATE_MISMATCH');

  let imageTornRecaptures: number | null = null;
  if (image.status === 'MEASURED') imageTornRecaptures = image.tornRecaptureCount;

  const releaseEvidenceBytes = sumRunBytes(content.calibrationRuns);
  const qualificationEvidenceBytes = sumRunBytes(content.qualificationRuns);
  if (releaseEvidenceBytes === null || qualificationEvidenceBytes === null)
    return policyRefusal('MEASUREMENT_SHAPE_INVALID');

  const observed: BudgetObservedDimensionsV1 = {
    releaseDurationMs: content.calibrationElapsedMs,
    releaseEvidenceBytes,
    qualificationDurationMs: content.qualificationElapsedMs,
    qualificationEvidenceBytes,
    retainedInventoryBytes: input.retainedInventoryBytes,
    imageTornRecaptures,
  };
  if (
    observed.releaseDurationMs > policy.ceilings.releaseDurationMs ||
    observed.releaseEvidenceBytes > policy.ceilings.releaseEvidenceBytes ||
    observed.qualificationDurationMs > policy.ceilings.qualificationDurationMs ||
    observed.qualificationEvidenceBytes > policy.ceilings.qualificationEvidenceBytes ||
    observed.retainedInventoryBytes > policy.ceilings.retainedEvidenceBytes ||
    (observed.imageTornRecaptures !== null &&
      observed.imageTornRecaptures > (policy.ceilings.imageTornRecaptures as number))
  )
    return policyRefusal('LIMIT_EXCEEDED');

  return { ok: true, decision: 'FEASIBLE', observed };
}

//
// Read-only `full-scope-envelope-v1` proposal-assessment wrapper.
//
// Trust boundary (explicit): the wrapper re-reads the named immutable
// measurement set from disk, re-reads the set's exact bound `PRESERVE_ALL`
// retention audit, derives the retained inventory byte count from the verified
// audit snapshot itself, and only then calls the pure
// `checkBudgetPolicyFeasibility`. It accepts no caller-supplied retained byte
// scalar, authors/proves no approval, and performs no writes. A passing result
// is `PROPOSAL_FEASIBLE_NOT_APPROVED` with `releaseCredit: false`; it is never an
// approved policy, Release credit, or authorization to allocate Release work.

/**
 * Sanitized refusal vocabulary for the read-only assessment. Composes the
 * closed measurement-set and policy failure codes; any retention-audit read or
 * binding failure is collapsed to the single `RETENTION_INVALID` code so no
 * audit internals (existence, path, tamper detail) leak.
 */
export type BudgetProposalAssessmentFailureCode =
  | BudgetMeasurementFailureCode
  | BudgetPolicyFailureCode;

/**
 * Result of the read-only proposal assessment. The success arm can only ever
 * mean "the supplied proposal is feasible against the verified set/audit and is
 * still unapproved and non-creditable".
 */
export type BudgetProposalAssessmentResultV1 =
  | {
      readonly ok: true;
      readonly decision: 'PROPOSAL_FEASIBLE_NOT_APPROVED';
      readonly releaseCredit: false;
      readonly measurementSetId: string;
      readonly measurementSetContentDigest: string;
      readonly retentionAuditId: string;
      readonly retentionAuditDigest: string;
      readonly observed: BudgetObservedDimensionsV1;
    }
  | { readonly ok: false; readonly code: BudgetProposalAssessmentFailureCode };

/**
 * Assess one closed proposal against its exact verified measurement set and that
 * set's exact verified retention audit. The retained byte dimension is derived
 * exclusively from the verified audit snapshot; the pure checker remains the
 * feasibility decision authority and no approval or credit is produced.
 */
export function assessBudgetPolicyProposal(
  measurementSetId: string,
  policy: BudgetPolicyProposalV1,
  options: BudgetRuntimeOptions = {},
): BudgetProposalAssessmentResultV1 {
  // 1 — reread and re-derive the current immutable measurement set before any
  // policy input is considered; a stale/changed/absent set refuses here.
  const set = verifyBudgetMeasurementSet(measurementSetId, options);
  if (!set.ok) return { ok: false, code: set.code };
  const content = set.value.content;

  // 2 — reread the set's exact bound retention audit and require the exact
  // audit id/digest the set binds; the byte scalar comes only from its verified
  // snapshot (`snapshot.totalByteCount`), never from the caller.
  let d: BudgetRuntimeDependencies;
  try {
    d = dependencies(options);
  } catch {
    return { ok: false, code: 'RETENTION_INVALID' };
  }
  const audit = readAndVerifyRetentionAudit(d.skillRoot, content.retentionAuditId);
  if (
    !audit.ok ||
    audit.value.auditId !== content.retentionAuditId ||
    audit.value.digest !== content.retentionAuditDigest
  )
    return { ok: false, code: 'RETENTION_INVALID' };

  // 3 — the existing pure checker remains the sole feasibility decision.
  const checked = checkBudgetPolicyFeasibility({
    content,
    policy,
    retainedInventoryBytes: audit.value.snapshot.totalByteCount,
  });
  if (!checked.ok) return { ok: false, code: checked.code };

  return {
    ok: true,
    decision: 'PROPOSAL_FEASIBLE_NOT_APPROVED',
    releaseCredit: false,
    measurementSetId: set.value.measurementSetId,
    measurementSetContentDigest: set.value.contentDigest,
    retentionAuditId: audit.value.auditId,
    retentionAuditDigest: audit.value.digest,
    observed: checked.observed,
  };
}

//
// Read-only external-authority budget-policy verifier (ADR 0111).
//
// Trust boundary (explicit): three canonical proposal/review/approval artifacts
// under `evidence/governance/budget/policies/` are *not* authority on their own.
// A same-user, runner-writable file, Git commit, chmod bit, caller boolean or CLI
// flag is never authentication. The only accepted authority is an independent
// trust-root provider that pins the exact raw-byte digests. The production
// default provider always refuses, so this verifier returns `AUTHORITY_UNATTESTED`
// even when every JSON string looks correct, until independently controlled trust
// infrastructure exists. A success is `POLICY_VERIFIED_NON_CREDITABLE` with
// `releaseCredit: false`; it is never policy approval, Release credit or an
// allocation authorization. This function performs no writes.

/** Sanitized refusal vocabulary for the external-authority verifier. */
export type BudgetPolicyVerificationFailureCode =
  | 'AUTHORITY_UNATTESTED'
  | 'AUTHORITY_MISMATCH'
  | 'APPROVAL_INVALID'
  | 'REVIEW_INVALID'
  | 'PROPOSAL_INVALID'
  | 'ACTOR_INVALID'
  | 'MANDATE_INVALID'
  | 'SCOPE_INVALID'
  | BudgetProposalAssessmentFailureCode;

/**
 * Result of the external-authority verification. The success arm can only ever
 * mean "an independent trust root pinned this exact artifact triplet and the
 * bound current measurement/retention set is feasible"; it is explicitly still
 * non-creditable and unapproved for Release.
 */
export type BudgetPolicyVerificationResultV1 =
  | {
      readonly ok: true;
      readonly decision: typeof BUDGET_POLICY_VERIFIED_DECISION;
      readonly releaseCredit: false;
      readonly approvalId: string;
      readonly approvalDigest: string;
      readonly proposalId: string;
      readonly proposalDigest: string;
      readonly reviewId: string;
      readonly reviewDigest: string;
      readonly measurementSetId: string;
      readonly measurementSetContentDigest: string;
      readonly retentionAuditId: string;
      readonly retentionAuditDigest: string;
      readonly manifestId: string;
      readonly manifestFingerprint: string;
      readonly requiredCellId: string;
      readonly sourceProvenanceDigest: string;
      readonly ceilings: BudgetPolicyCeilingsV1;
      readonly familyStates: readonly BudgetPolicyFamilyStateV1[];
      readonly tornCounterDependencies: readonly BudgetFamilyMeasurementV1['family'][];
      readonly observed: BudgetObservedDimensionsV1;
    }
  | { readonly ok: false; readonly code: BudgetPolicyVerificationFailureCode };

export interface BudgetPolicyVerifierOptions extends BudgetRuntimeOptions {
  /**
   * Independent trust-root seam. Absent (the production default) always refuses.
   * Present only in synthetic tests that simulate external control; it must not
   * be wired to a public runner or to any same-user file/boolean.
   */
  readonly authority?: BudgetPolicyAuthorityProvider;
}

/** Production default: no independent control exists, so nothing is attested. */
export const REFUSING_BUDGET_POLICY_AUTHORITY_PROVIDER: BudgetPolicyAuthorityProvider = {
  resolve: () => null,
};

const POLICY_ARTIFACT_DIRECTORY: Readonly<Record<'approvals' | 'proposals' | 'reviews', string>> = {
  approvals: 'evidence/governance/budget/policies/approvals',
  proposals: 'evidence/governance/budget/policies/proposals',
  reviews: 'evidence/governance/budget/policies/reviews',
};
const MAX_POLICY_ARTIFACT_BYTES = 4 * 1024 * 1024;
const PROPOSAL_ARTIFACT_KEYS = [
  'schemaVersion',
  'proposalId',
  'state',
  'releaseCredit',
  'proposal',
  'rationale',
] as const;
const REVIEW_ARTIFACT_KEYS = [
  'schemaVersion',
  'reviewId',
  'reviewer',
  'result',
  'proposalId',
  'proposalDigest',
  'rationale',
] as const;
const APPROVAL_ARTIFACT_KEYS = [
  'schemaVersion',
  'approvalId',
  'decisionMaker',
  'mandate',
  'decisionScope',
  'proposalId',
  'proposalDigest',
  'reviewId',
  'reviewDigest',
  'rationale',
  'timestamp',
] as const;
const ATTESTATION_KEYS = [
  'decisionScope',
  'proposalId',
  'proposalDigest',
  'reviewId',
  'reviewDigest',
  'approvalId',
  'approvalDigest',
] as const;

function policyVerificationRefusal(
  code: BudgetPolicyVerificationFailureCode,
): BudgetPolicyVerificationResultV1 {
  return { ok: false, code };
}

function nonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Read one canonical UTF8+LF artifact via a bounded no-follow regular-file read. */
function readPolicyArtifact(
  skillRoot: string,
  kind: 'approvals' | 'proposals' | 'reviews',
  id: string,
): { readonly value: unknown; readonly bytes: Buffer } {
  if (!BUDGET_POLICY_ARTIFACT_ID_PATTERN.test(id)) throw new Error('ID_INVALID');
  const directory = path.join(skillRoot, POLICY_ARTIFACT_DIRECTORY[kind]);
  if (!safeDirectory(directory)) throw new Error('FILE_INVALID');
  const bytes = readFileBounded(path.join(directory, `${id}.json`), MAX_POLICY_ARTIFACT_BYTES);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('FILE_INVALID');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('FILE_INVALID');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    `${canonicalize(parsed)}\n` !== text
  )
    throw new Error('FILE_INVALID');
  return { value: parsed, bytes };
}

type ArtifactValidation<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: BudgetPolicyVerificationFailureCode };

function validateApprovalArtifact(
  value: unknown,
  id: string,
): ArtifactValidation<BudgetPolicyApprovalArtifactV1> {
  if (!exactKeys(value, APPROVAL_ARTIFACT_KEYS)) return { ok: false, code: 'APPROVAL_INVALID' };
  const approval = value as Record<string, unknown>;
  if (
    approval.schemaVersion !== BUDGET_POLICY_ARTIFACT_SCHEMA_VERSION ||
    approval.approvalId !== id ||
    typeof approval.proposalId !== 'string' ||
    !BUDGET_POLICY_ARTIFACT_ID_PATTERN.test(approval.proposalId) ||
    typeof approval.proposalDigest !== 'string' ||
    !HEX64.test(approval.proposalDigest) ||
    typeof approval.reviewId !== 'string' ||
    !BUDGET_POLICY_ARTIFACT_ID_PATTERN.test(approval.reviewId) ||
    typeof approval.reviewDigest !== 'string' ||
    !HEX64.test(approval.reviewDigest) ||
    !nonEmptyText(approval.rationale) ||
    typeof approval.timestamp !== 'string' ||
    !Number.isFinite(Date.parse(approval.timestamp))
  )
    return { ok: false, code: 'APPROVAL_INVALID' };
  if (approval.decisionMaker !== BUDGET_POLICY_DECISION_MAKER)
    return { ok: false, code: 'ACTOR_INVALID' };
  if (approval.mandate !== BUDGET_POLICY_MANDATE) return { ok: false, code: 'MANDATE_INVALID' };
  if (approval.decisionScope !== BUDGET_POLICY_DECISION_SCOPE)
    return { ok: false, code: 'SCOPE_INVALID' };
  return { ok: true, value: approval as unknown as BudgetPolicyApprovalArtifactV1 };
}

function validateReviewArtifact(
  value: unknown,
  id: string,
): ArtifactValidation<BudgetPolicyReviewArtifactV1> {
  if (!exactKeys(value, REVIEW_ARTIFACT_KEYS)) return { ok: false, code: 'REVIEW_INVALID' };
  const review = value as Record<string, unknown>;
  if (
    review.schemaVersion !== BUDGET_POLICY_ARTIFACT_SCHEMA_VERSION ||
    review.reviewId !== id ||
    !nonEmptyText(review.reviewer) ||
    review.result !== 'PASS' ||
    typeof review.proposalId !== 'string' ||
    !BUDGET_POLICY_ARTIFACT_ID_PATTERN.test(review.proposalId) ||
    typeof review.proposalDigest !== 'string' ||
    !HEX64.test(review.proposalDigest) ||
    !nonEmptyText(review.rationale)
  )
    return { ok: false, code: 'REVIEW_INVALID' };
  return { ok: true, value: review as unknown as BudgetPolicyReviewArtifactV1 };
}

function validateProposalArtifact(
  value: unknown,
  id: string,
): ArtifactValidation<BudgetPolicyProposalArtifactV1> {
  if (!exactKeys(value, PROPOSAL_ARTIFACT_KEYS)) return { ok: false, code: 'PROPOSAL_INVALID' };
  const proposal = value as Record<string, unknown>;
  if (
    proposal.schemaVersion !== BUDGET_POLICY_ARTIFACT_SCHEMA_VERSION ||
    proposal.proposalId !== id ||
    proposal.state !== 'PROPOSED_NOT_APPROVED' ||
    proposal.releaseCredit !== false ||
    !nonEmptyText(proposal.rationale) ||
    !wellFormedPolicyProposal(proposal.proposal)
  )
    return { ok: false, code: 'PROPOSAL_INVALID' };
  return { ok: true, value: proposal as unknown as BudgetPolicyProposalArtifactV1 };
}

function validAttestationShape(value: unknown): value is BudgetPolicyAuthorityAttestationV1 {
  if (!exactKeys(value, ATTESTATION_KEYS)) return false;
  const attestation = value as Record<string, unknown>;
  return (
    typeof attestation.decisionScope === 'string' &&
    typeof attestation.proposalId === 'string' &&
    BUDGET_POLICY_ARTIFACT_ID_PATTERN.test(attestation.proposalId) &&
    typeof attestation.proposalDigest === 'string' &&
    HEX64.test(attestation.proposalDigest) &&
    typeof attestation.reviewId === 'string' &&
    BUDGET_POLICY_ARTIFACT_ID_PATTERN.test(attestation.reviewId) &&
    typeof attestation.reviewDigest === 'string' &&
    HEX64.test(attestation.reviewDigest) &&
    typeof attestation.approvalId === 'string' &&
    BUDGET_POLICY_ARTIFACT_ID_PATTERN.test(attestation.approvalId) &&
    typeof attestation.approvalDigest === 'string' &&
    HEX64.test(attestation.approvalDigest)
  );
}

/**
 * Verify one externally approved budget policy by exact raw digest/name joins.
 *
 * Checks, in fail-closed order: (1) an independent trust root attests the exact
 * approval id and its pinned digests/scope; (2) the three canonical artifacts
 * exist, parse, close over their declared keys, and pass structural, actor,
 * mandate and scope checks with exact id/byte-digest joins among themselves and
 * against the independent pins; (3) the review's reviewer is distinct from the
 * approval's decision-maker; (4) the bound current measurement set, retention
 * audit, source and candidate re-verify and the proposal is feasible via the
 * existing read-only wrapper. Refuses with a sanitized stable code; performs no
 * writes.
 */
export function verifyApprovedBudgetPolicy(
  approvalId: string,
  options: BudgetPolicyVerifierOptions = {},
): BudgetPolicyVerificationResultV1 {
  // 1 — independent authority first. Without an attestation we never interpret
  // any same-user file, however well-formed its JSON strings look.
  const authority = options.authority ?? REFUSING_BUDGET_POLICY_AUTHORITY_PROVIDER;
  let attestation: BudgetPolicyAuthorityAttestationV1 | null;
  try {
    attestation = authority.resolve(approvalId);
  } catch {
    return policyVerificationRefusal('AUTHORITY_UNATTESTED');
  }
  if (!attestation || !validAttestationShape(attestation) || attestation.approvalId !== approvalId)
    return policyVerificationRefusal('AUTHORITY_UNATTESTED');
  if (attestation.decisionScope !== BUDGET_POLICY_DECISION_SCOPE)
    return policyVerificationRefusal('AUTHORITY_MISMATCH');

  let skillRoot: string;
  try {
    skillRoot = dependencies(options).skillRoot;
  } catch {
    return policyVerificationRefusal('AUTHORITY_UNATTESTED');
  }

  // 2 — approval artifact: canonical bytes, closed keys, exact id and actor.
  let approval: ArtifactValidation<BudgetPolicyApprovalArtifactV1>;
  let approvalDigest: string;
  try {
    const read = readPolicyArtifact(skillRoot, 'approvals', approvalId);
    approval = validateApprovalArtifact(read.value, approvalId);
    approvalDigest = digestBytes(read.bytes);
  } catch {
    return policyVerificationRefusal('APPROVAL_INVALID');
  }
  if (!approval.ok) return policyVerificationRefusal(approval.code);
  if (approvalDigest !== attestation.approvalDigest)
    return policyVerificationRefusal('AUTHORITY_MISMATCH');

  // 3 — review artifact: exact join to approval and to the independent pins.
  let review: ArtifactValidation<BudgetPolicyReviewArtifactV1>;
  let reviewDigest: string;
  try {
    const read = readPolicyArtifact(skillRoot, 'reviews', approval.value.reviewId);
    review = validateReviewArtifact(read.value, approval.value.reviewId);
    reviewDigest = digestBytes(read.bytes);
  } catch {
    return policyVerificationRefusal('REVIEW_INVALID');
  }
  if (!review.ok) return policyVerificationRefusal(review.code);
  // The reviewer must be a distinct identity from the delegated decision-maker.
  if (review.value.reviewer === approval.value.decisionMaker)
    return policyVerificationRefusal('ACTOR_INVALID');
  if (reviewDigest !== approval.value.reviewDigest)
    return policyVerificationRefusal('REVIEW_INVALID');
  if (reviewDigest !== attestation.reviewDigest || review.value.reviewId !== attestation.reviewId)
    return policyVerificationRefusal('AUTHORITY_MISMATCH');

  // 4 — proposal artifact: exact join to review, approval and independent pins.
  let proposal: ArtifactValidation<BudgetPolicyProposalArtifactV1>;
  let proposalDigest: string;
  try {
    const read = readPolicyArtifact(skillRoot, 'proposals', review.value.proposalId);
    proposal = validateProposalArtifact(read.value, review.value.proposalId);
    proposalDigest = digestBytes(read.bytes);
  } catch {
    return policyVerificationRefusal('PROPOSAL_INVALID');
  }
  if (!proposal.ok) return policyVerificationRefusal(proposal.code);
  if (proposalDigest !== review.value.proposalDigest)
    return policyVerificationRefusal('REVIEW_INVALID');
  if (
    proposalDigest !== approval.value.proposalDigest ||
    proposal.value.proposalId !== approval.value.proposalId
  )
    return policyVerificationRefusal('APPROVAL_INVALID');
  if (
    proposalDigest !== attestation.proposalDigest ||
    proposal.value.proposalId !== attestation.proposalId
  )
    return policyVerificationRefusal('AUTHORITY_MISMATCH');

  // 5 — current verified measurement/retention/source/candidate feasibility via
  // the existing read-only wrapper; never a caller-supplied substitute.
  const assessed = assessBudgetPolicyProposal(
    proposal.value.proposal.measurementSetId,
    proposal.value.proposal,
    options,
  );
  if (!assessed.ok) return policyVerificationRefusal(assessed.code);

  return {
    ok: true,
    decision: BUDGET_POLICY_VERIFIED_DECISION,
    releaseCredit: false,
    approvalId: approval.value.approvalId,
    approvalDigest,
    proposalId: proposal.value.proposalId,
    proposalDigest,
    reviewId: review.value.reviewId,
    reviewDigest,
    measurementSetId: assessed.measurementSetId,
    measurementSetContentDigest: assessed.measurementSetContentDigest,
    retentionAuditId: assessed.retentionAuditId,
    retentionAuditDigest: assessed.retentionAuditDigest,
    manifestId: proposal.value.proposal.manifestId,
    manifestFingerprint: proposal.value.proposal.manifestFingerprint,
    requiredCellId: proposal.value.proposal.requiredCellId,
    sourceProvenanceDigest: proposal.value.proposal.sourceProvenanceDigest,
    ceilings: proposal.value.proposal.ceilings,
    familyStates: proposal.value.proposal.familyStates,
    tornCounterDependencies: proposal.value.proposal.tornCounterDependencies,
    observed: assessed.observed,
  };
}

//
// Read-only proposal-by-ID inspection accessor (WP6, ADR 0115).
//
// Trust boundary (explicit): this only *inspects* one externally authored
// proposal artifact by its exact closed id. It reuses the private canonical
// bounded artifact reader, the closed proposal validator and the read-only
// assessment wrapper; it exposes no generic reader, raw path, review/approval
// bytes or write capability, and it never asserts approval. The success arm
// keeps `state: 'PROPOSED_NOT_APPROVED'` and `releaseCredit: false`: a
// well-formed, currently feasible proposal is still not an approved policy,
// attestation, authorization or Release credit. Every refusal is a sanitized
// stable code that discloses no file path, existence or tamper detail. This
// function performs no writes.
//

/** Sanitized refusal vocabulary for the read-only proposal-by-ID inspector. */
export type BudgetPolicyProposalInspectionFailureCode =
  | 'PROPOSAL_INVALID'
  | BudgetProposalAssessmentFailureCode;

/**
 * Result of the read-only proposal-by-ID inspection. The success arm reports the
 * exact proposal's nonsecret identity facts plus its rederived measurement and
 * retention feasibility; it is never approval, attestation or Release credit.
 */
export type BudgetPolicyProposalInspectionResultV1 =
  | {
      readonly ok: true;
      readonly state: 'PROPOSED_NOT_APPROVED';
      readonly releaseCredit: false;
      readonly decision: 'PROPOSAL_FEASIBLE_NOT_APPROVED';
      readonly proposalId: string;
      readonly proposalDigest: string;
      readonly measurementSetId: string;
      readonly measurementSetContentDigest: string;
      readonly retentionAuditId: string;
      readonly retentionAuditDigest: string;
      readonly manifestId: string;
      readonly manifestFingerprint: string;
      readonly requiredCellId: string;
      readonly sourceProvenanceDigest: string;
      readonly ceilings: BudgetPolicyCeilingsV1;
      readonly familyStates: readonly BudgetPolicyFamilyStateV1[];
      readonly tornCounterDependencies: readonly BudgetFamilyMeasurementV1['family'][];
      readonly observed: BudgetObservedDimensionsV1;
    }
  | { readonly ok: false; readonly code: BudgetPolicyProposalInspectionFailureCode };

/**
 * Inspect exactly one externally authored budget-policy *proposal* by id.
 *
 * Read-only, fail-closed and non-creditable. The exact id is validated before
 * any filesystem access; the proposal is then read through the private canonical
 * bounded no-follow reader, validated against its closed schema and exact id,
 * and finally rederived against its bound current measurement set and retention
 * audit via the existing assessment wrapper. It refuses with a sanitized stable
 * code when the locator is malformed or path-traversal-shaped, the proposal is
 * missing/non-canonical/oversized/symlinked or has unknown keys or a wrong
 * id/state/credit/shape, or the bound set/audit is absent, stale/changed or
 * infeasible. It reads no review or approval artifact, never writes and never
 * claims approval.
 */
export function inspectBudgetPolicyProposal(
  proposalId: string,
  options: BudgetRuntimeOptions = {},
): BudgetPolicyProposalInspectionResultV1 {
  // 1 — reject a malformed or traversal-shaped locator before touching any file.
  if (typeof proposalId !== 'string' || !BUDGET_POLICY_ARTIFACT_ID_PATTERN.test(proposalId))
    return { ok: false, code: 'PROPOSAL_INVALID' };

  let skillRoot: string;
  try {
    skillRoot = dependencies(options).skillRoot;
  } catch {
    return { ok: false, code: 'PROPOSAL_INVALID' };
  }

  // 2 — canonical bounded no-follow read of exactly this proposal artifact.
  // Every read/parse/canonical/closed-schema/id-mismatch failure collapses to a
  // single sanitized code so no path, existence or tamper detail leaks.
  let read: { readonly value: unknown; readonly bytes: Buffer };
  try {
    read = readPolicyArtifact(skillRoot, 'proposals', proposalId);
  } catch {
    return { ok: false, code: 'PROPOSAL_INVALID' };
  }
  const validated = validateProposalArtifact(read.value, proposalId);
  if (!validated.ok) return { ok: false, code: 'PROPOSAL_INVALID' };

  // 3 — rederive the bound current measurement set and retention feasibility. A
  // stale/changed/absent set or audit, or an infeasible policy, refuses here
  // rather than returning an apparently approved result.
  const assessed = assessBudgetPolicyProposal(
    validated.value.proposal.measurementSetId,
    validated.value.proposal,
    options,
  );
  if (!assessed.ok) return { ok: false, code: assessed.code };

  return {
    ok: true,
    state: 'PROPOSED_NOT_APPROVED',
    releaseCredit: false,
    decision: 'PROPOSAL_FEASIBLE_NOT_APPROVED',
    proposalId,
    proposalDigest: digestBytes(read.bytes),
    measurementSetId: assessed.measurementSetId,
    measurementSetContentDigest: assessed.measurementSetContentDigest,
    retentionAuditId: assessed.retentionAuditId,
    retentionAuditDigest: assessed.retentionAuditDigest,
    manifestId: validated.value.proposal.manifestId,
    manifestFingerprint: validated.value.proposal.manifestFingerprint,
    requiredCellId: validated.value.proposal.requiredCellId,
    sourceProvenanceDigest: validated.value.proposal.sourceProvenanceDigest,
    ceilings: validated.value.proposal.ceilings,
    familyStates: validated.value.proposal.familyStates,
    tornCounterDependencies: validated.value.proposal.tornCounterDependencies,
    observed: assessed.observed,
  };
}

//
// Read-only Release preflight adapter (WP5-A, ADR 0111/0112).
//
// Trust boundary (explicit): this maps an independently verified budget policy
// onto the exact currently governed Release manifest/cell/source. The caller
// supplies only a policy *id* locator; it confers no authority, and without an
// independent trust root the underlying verifier refuses before any file bytes
// are interpreted. The returned `releaseCredit` is always `false`: a passing
// preflight is neither policy approval nor Release credit.

/** Deterministic, closed disclosure of every unsupported measurement family. */
function releasePreflightLimitations(
  states: readonly BudgetPolicyFamilyStateV1[],
  tornCounterDependencies: readonly BudgetFamilyMeasurementV1['family'][],
): readonly string[] {
  const rows: string[] = [];
  for (const state of states)
    if (state.status !== 'MEASURED') rows.push(`family:${state.family}:${state.status}`);
  for (const family of tornCounterDependencies) rows.push(`torn-counter:${family}:REQUIRED`);
  return rows.sort();
}

/** Collapse the WP4 refusal vocabulary into the sanitized Release preflight set. */
function releasePreflightFailure(
  code: BudgetPolicyVerificationFailureCode,
): ReleaseBudgetPreflightFailureCode {
  switch (code) {
    case 'AUTHORITY_UNATTESTED':
      return 'BUDGET_AUTHORITY_UNATTESTED';
    case 'AUTHORITY_MISMATCH':
      return 'BUDGET_AUTHORITY_MISMATCH';
    case 'BINDING_MISMATCH':
    case 'LINEAGE_MISMATCH':
      return 'BUDGET_BINDING_MISMATCH';
    case 'INPUT_INVALID':
    case 'CALIBRATION_INVALID':
    case 'QUALIFICATION_INVALID':
    case 'RETENTION_INVALID':
    case 'MEASUREMENT_INVALID':
    case 'MEASUREMENT_NOT_FOUND':
    case 'MEASUREMENT_WRITE_REFUSED':
      return 'BUDGET_MEASUREMENT_INVALID';
    default:
      return 'BUDGET_POLICY_INVALID';
  }
}

/**
 * Resolve one exact, independently pinned budget policy for a Release run.
 *
 * Refuses with a sanitized stable code when: no independent authority root is
 * available, the supplied policy id is not a well-formed locator, the verified
 * policy does not bind the exact current manifest/cell/source lineage, or the
 * policy method is unsupported. Performs no writes and never grants Release
 * credit; the sole success shape is a structurally closed, non-creditable
 * preflight.
 */
export function resolveReleaseBudgetPreflight(
  input: ReleaseBudgetPreflightInputV1,
  options: BudgetPolicyVerifierOptions = {},
): ReleaseBudgetPreflightResultV1 {
  if (!input || typeof input !== 'object') return { ok: false, code: 'BUDGET_POLICY_INVALID' };
  if (
    typeof input.policyApprovalId !== 'string' ||
    !BUDGET_POLICY_ARTIFACT_ID_PATTERN.test(input.policyApprovalId)
  )
    return { ok: false, code: 'BUDGET_AUTHORITY_UNATTESTED' };
  const verified = verifyApprovedBudgetPolicy(input.policyApprovalId, options);
  if (!verified.ok) return { ok: false, code: releasePreflightFailure(verified.code) };
  if (
    verified.manifestId !== input.manifestId ||
    verified.manifestFingerprint !== input.manifestFingerprint ||
    verified.requiredCellId !== input.requiredCellId ||
    verified.sourceProvenanceDigest !== input.sourceProvenanceDigest
  )
    return { ok: false, code: 'BUDGET_BINDING_MISMATCH' };
  return {
    ok: true,
    value: {
      releaseCredit: false,
      policyApprovalId: verified.approvalId,
      policyDigest: verified.proposalDigest,
      approvalDigest: verified.approvalDigest,
      reviewDigest: verified.reviewDigest,
      measurementSetId: verified.measurementSetId,
      measurementSetContentDigest: verified.measurementSetContentDigest,
      method: RELEASE_BUDGET_METHOD,
      methodVersion: RELEASE_BUDGET_METHOD_VERSION,
      ceilings: verified.ceilings,
      limitations: releasePreflightLimitations(
        verified.familyStates,
        verified.tornCounterDependencies,
      ),
      manifestId: verified.manifestId,
      manifestFingerprint: verified.manifestFingerprint,
      requiredCellId: verified.requiredCellId,
      sourceProvenanceDigest: verified.sourceProvenanceDigest,
      basis: {
        measurementSetContentDigest: verified.measurementSetContentDigest,
        retentionAuditId: verified.retentionAuditId,
        retentionAuditDigest: verified.retentionAuditDigest,
      },
    },
  };
}

//
// Strict per-child Release budget facts (WP5-B, ADR 0112).
//
// Trust boundary (explicit): these read only a verified owned evidence root and
// the strict current public v4 child record through the same strict readers the
// no-credit measurement set uses. They never read a provider summary, a fixture
// total or a caller-supplied scalar, and they confer no evidence validity or
// Release credit by themselves. A read refusal is an integrity stop for the
// calling runtime, never a weaker budget skip.

/** Strict family/byte/tear facts for one started Release child. */
export interface ReleaseChildStrictFactsV1 {
  readonly family: BudgetMeasuredFamilyV1;
  readonly evidenceByteCount: number;
  readonly imageTornRecaptures: number | null;
}

export interface ReleaseChildStrictFactsInputV1 {
  readonly skillRoot: string;
  readonly runId: string;
  readonly family: BudgetMeasuredFamilyV1;
  /** The verified child record digest whose exact bytes these facts must join. */
  readonly expectedRecordDigest?: string | null;
}

/**
 * Exposes the closed ADR 0106 family derivation the measurement set already uses
 * so the Release runtime routes an entry to exactly one measured family instead
 * of re-deriving (and possibly drifting) it.
 */
export function deriveBudgetMeasuredFamily(
  materializedCase: PreparedExecutionCandidate['planning']['materializedCase'],
): BudgetMeasuredFamilyV1 | null {
  return deriveMeasuredFamily(materializedCase);
}

/**
 * Re-reads one started Release child's strict owned evidence bytes and, only for
 * the Image family, its strict persisted tear sum. Refuses on an unsafe/absent
 * root, a non-current or non-diagnostic record, a record whose exact canonical
 * bytes do not join the verified child digest, or a missing/malformed Image
 * counter; it never fabricates a zero for an unavailable family counter.
 */
export function readReleaseChildStrictFacts(
  input: ReleaseChildStrictFactsInputV1,
): BudgetMeasurementResult<ReleaseChildStrictFactsV1> {
  if (!input || typeof input !== 'object') return measuredRunFailure('INPUT_INVALID');
  if (!isSafeRunId(input.runId)) return measuredRunFailure('INPUT_INVALID');
  if (!BUDGET_MEASURED_FAMILIES.includes(input.family)) return measuredRunFailure('INPUT_INVALID');
  let inventory: ReturnType<typeof inventoryEvidenceRoot>;
  try {
    inventory = inventoryEvidenceRoot(input.skillRoot, input.runId);
  } catch {
    return measuredRunFailure('MEASUREMENT_INVALID');
  }
  let read: ReturnType<typeof readFinalPublicRecordFile>;
  try {
    read = readFinalPublicRecordFile(
      path.join(input.skillRoot, 'evidence', 'runs', input.runId, 'run-record.json'),
    );
  } catch {
    return measuredRunFailure('MEASUREMENT_INVALID');
  }
  if (
    read.kind !== 'current-v4' ||
    read.record.command !== 'diagnostic' ||
    read.record.runId !== input.runId
  )
    return measuredRunFailure('MEASUREMENT_INVALID');
  if (
    input.expectedRecordDigest !== undefined &&
    input.expectedRecordDigest !== null &&
    sha256Hex(canonicalize(read.record)) !== input.expectedRecordDigest
  )
    return measuredRunFailure('MEASUREMENT_INVALID');
  let imageTornRecaptures: number | null = null;
  if (input.family === 'image') {
    const torn = strictImageTornRecaptures(read.record);
    if (!torn.ok) return measuredRunFailure('MEASUREMENT_INVALID');
    imageTornRecaptures = torn.value;
  }
  return {
    ok: true,
    value: {
      family: input.family,
      evidenceByteCount: inventory.bytes,
      imageTornRecaptures,
    },
  };
}

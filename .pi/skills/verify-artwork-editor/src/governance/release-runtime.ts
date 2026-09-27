import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';

import { canonicalize, sha256Hex } from '../canonical/canonicalize';
import type {
  ExecutableManifestValidationContext,
  ExecutableSelectionManifestDraftV1,
} from '../contracts/executable-selection-manifest';
import type { PreparedExecutionCandidate } from '../cli/diagnostic';
import { createGovernanceTiming, isGovernanceTiming } from '../contracts/governance-timing';
import type { CliResult } from '../contracts/runtime';
import type { VerifiedQualificationBatchV1 } from '../contracts/qualification-runtime';
import {
  RELEASE_APPROVAL_ACTOR,
  RELEASE_LEDGER_SCHEMA_VERSION_V2,
  type ReleaseApprovalV1,
  type ReleaseBudgetAuthorityV1,
  type ReleaseBudgetFamilyV1,
  type ReleaseBudgetPreflightInputV1,
  type ReleaseBudgetPreflightResultV1,
  type ReleaseBudgetRederivationV1,
  type ReleaseChildBudgetFactsV1,
  type ReleaseChildBudgetFactsResultV1,
  type ReleaseLedgerRecord,
  type ReleaseReviewReceiptV1,
  type ReleaseRunEventV2,
  type ReleaseRunStateV2,
  type ReleaseRuntimeResult,
  type ReleaseScopeProposalV1,
  type ReleaseWorkSlotV1,
  type VerifiedBudgetPreflightV1,
} from '../contracts/release-runtime';
import {
  collectRepositoryProvenanceInputs,
  governedTreeDigestFromCollectedInputs,
} from '../evidence/provenance-collector';
import { validateExecutableSelectionManifest } from './executable-selection-manifest';
import {
  readAndVerifyDiagnosticChild,
  verifyQualificationBatch,
  type VerifiedChild,
} from './qualification-runtime';
import {
  appendReleaseEvent,
  appendReleaseEventV2,
  claimReleaseRun,
  createReleaseLedger,
  createReleaseLedgerV2,
  isVerifiedBudgetPreflight,
  readReleaseLedger,
} from './release-ledger';
import {
  resolveReleaseBudgetPreflight,
  readReleaseChildStrictFacts,
  deriveBudgetMeasuredFamily,
} from './budget';
import {
  createLocalReleaseShardPlan,
  reconstructLocalReleaseShards,
  type ReleaseShardWorkItemV1,
} from './release-sharding';
import {
  compilePreparedExecutionCandidate,
  runDiagnosticCommand,
  type PreparedExecutionCandidate as PreparedCandidate,
} from '../cli/diagnostic';
import { isSafeRunId, resolveRepoRoot, resolveSkillRoot } from '../runtime/paths';

const MAX_AUTHORITY_BYTES = 4 * 1024 * 1024;
const SAFE_ID = /^[a-z][a-z0-9-]{0,95}$/;

/**
 * Terminal-persistence boundary stages reached by a run exactly once, in order:
 * `before-provisional-append` → `before-provisional-reread` →
 * `before-final-append` → `before-final-reread`. Exposed so a test can provoke a
 * distinct terminal-stage refusal without widening the write set.
 */
export type TerminalPersistenceStage =
  | 'before-provisional-append'
  | 'before-provisional-reread'
  | 'before-final-append'
  | 'before-final-reread';

export interface ReleaseRuntimeDependencies {
  readonly skillRoot: string;
  readonly repoRoot: string;
  readonly loadContext: () => ExecutableManifestValidationContext;
  readonly compileCandidate: (
    request: unknown,
  ) => ReturnType<typeof compilePreparedExecutionCandidate>;
  readonly runCandidate: (input: {
    preparedCandidate: PreparedCandidate;
    expectedIdentity: PreparedCandidate['identity'];
    runId: string;
  }) => Promise<CliResult<unknown>>;
  readonly collectSourceDigest: () => string;
  readonly readAndVerifyChild: (runId: string) => VerifiedChild;
  /**
   * Strict per-child budget facts (owned evidence bytes and, for Image, the
   * strict tear sum) read after one started slot is strictly verified and
   * cleaned up. The production default re-reads the verified child root through
   * the strict measurement readers; a test implementation is synthetic-only.
   * A refused read is an integrity stop, never a weaker budget skip.
   */
  readonly readChildBudgetFacts: (input: {
    readonly runId: string;
    readonly family: ReleaseBudgetFamilyV1;
    readonly recordDigest: string | null;
  }) => ReleaseChildBudgetFactsResultV1;
  readonly verifyQualification: (batchId: string) => ReturnType<typeof verifyQualificationBatch>;
  readonly makeId: () => string;
  readonly monotonicNow?: () => number;
  readonly wallNow?: () => string;
  /**
   * Verified-preflight seam. The production default authenticates through the
   * independently rooted WP4 policy verifier and refuses absent that root; a
   * test implementation is synthetic-only and can never grant live authority.
   */
  readonly resolveBudgetPreflight?: (
    input: ReleaseBudgetPreflightInputV1,
  ) => ReleaseBudgetPreflightResultV1;
  /** Locator reference for the exact budget policy approval; never authority. */
  readonly budgetPolicyApprovalId?: string;
  /**
   * Test-only observation seam invoked exactly once between the durably
   * appended/strictly reread provisional event and the sole endpoint sample. It
   * exists so a test can advance a synthetic clock to prove the endpoint sample
   * charges provisional persistence/readback waiting (ADR 0113). It cannot
   * alter the ledger, run state or authority; production leaves it undefined.
   */
  readonly afterProvisionalReadback?: () => void;
  /**
   * Test-only terminal-boundary observation seam, invoked once immediately
   * before each terminal-persistence step (`TerminalPersistenceStage`). It
   * exists so a test can deterministically provoke a distinct terminal-stage
   * append/reread refusal. The runtime never reads a value, state or outcome
   * from it, so it cannot alter authoritative run state, ledger authority or
   * credit; a callback may only mutate the on-disk ledger so the runtime's own
   * strict append/reread refuses. Production leaves it undefined.
   */
  readonly terminalPersistenceSeam?: (stage: TerminalPersistenceStage) => void;
}

export interface ReleaseRuntimeOptions {
  readonly dependencies?: Partial<ReleaseRuntimeDependencies>;
}

export interface ReleaseActivationResult {
  readonly lifecycleId: string;
  readonly lifecycleDigest: string;
  readonly manifestId: string;
  readonly manifestFingerprint: string;
  readonly workCount: number;
  readonly exclusions: ExecutableSelectionManifestDraftV1['content']['exclusions'];
  readonly lostObligationsByBinding: ReleaseScopeProposalV1['lostObligationsByBinding'];
}

export interface ReleaseRunResult {
  readonly runId: string;
  readonly manifestId: string;
  readonly manifestFingerprint: string;
  readonly state: 'COMPLETE_ALL_PASS' | 'NON_CREDITABLE' | 'INTERRUPTED' | 'BUDGET_TERMINATED';
  readonly releaseCreditGranted: boolean;
  /**
   * Derived authority of the terminal budget classification (ADR 0113).
   * `ROOT_BOUND` only when the independently rooted production budget authority
   * corroborates the exact bound policy/set raw bytes; any injectable/synthetic
   * seam yields `NON_AUTHORITATIVE` and can never establish an authoritative
   * budget termination. Derived at readback, never trusted from ledger state.
   */
  readonly budgetAuthority: ReleaseBudgetAuthorityV1;
  /**
   * Independent WP5-C budget rederivation of the terminal state from persisted
   * governance data and strict child evidence. Present on `verifyReleaseRun`
   * readback; derived, never trusted from stored booleans. This is
   * integrity/readback consistency, not cryptographic external authentication.
   */
  readonly budgetRederivation?: ReleaseBudgetRederivationV1;
  readonly workCount: number;
  readonly outcomes: readonly {
    readonly order: number;
    readonly runId: string;
    readonly outcome: string | null;
  }[];
  readonly exclusions: ExecutableSelectionManifestDraftV1['content']['exclusions'];
  readonly lostObligationsByBinding: ReleaseScopeProposalV1['lostObligationsByBinding'];
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

function defaultChildReader(skillRoot: string, runId: string, repoRoot: string): VerifiedChild {
  return readAndVerifyDiagnosticChild(skillRoot, runId, repoRoot);
}

function productionDependencies(): ReleaseRuntimeDependencies {
  const skillRoot = realpathSync(resolveSkillRoot());
  const repoRoot = realpathSync(resolveRepoRoot());
  return {
    skillRoot,
    repoRoot,
    loadContext: () => {
      throw new Error('Release command must supply manifest context.');
    },
    compileCandidate: compilePreparedExecutionCandidate,
    runCandidate: ({ preparedCandidate, expectedIdentity, runId }) =>
      runDiagnosticCommand({ preparedCandidate, expectedIdentity, runId }),
    collectSourceDigest: () => sourceDigest(repoRoot),
    readAndVerifyChild: (id) => defaultChildReader(skillRoot, id, repoRoot),
    readChildBudgetFacts: ({ runId, family, recordDigest }) => {
      const facts = readReleaseChildStrictFacts({
        skillRoot,
        runId,
        family,
        expectedRecordDigest: recordDigest,
      });
      return facts.ok ? { ok: true, value: facts.value } : { ok: false, code: 'EVIDENCE_INVALID' };
    },
    verifyQualification: (id) =>
      verifyQualificationBatch(id, {
        dependencies: {
          skillRoot,
          repoRoot,
          loadContext: () => {
            throw new Error('Release command must supply manifest context.');
          },
        },
      }),
    makeId: randomUUID,
    monotonicNow: () => performance.now(),
    wallNow: () => new Date().toISOString(),
    resolveBudgetPreflight: (input) =>
      resolveReleaseBudgetPreflight(input, {
        dependencies: {
          skillRoot,
          repoRoot,
          loadContext: () => {
            throw new Error('Release budget preflight must supply manifest context.');
          },
        },
      }),
  };
}
/**
 * Resolved runtime dependencies. `strictChildBudgetFacts` is deliberately kept
 * separate from the injectable `readChildBudgetFacts` seam: production budget
 * classification uses this fixed root-bound reader whenever the independently
 * rooted production authority binds the predeclaration, so a caller-supplied
 * synthetic reader can never forge an authoritative budget stop (ADR 0113 §6).
 */
interface ResolvedReleaseDependencies extends ReleaseRuntimeDependencies {
  readonly strictChildBudgetFacts: ReleaseRuntimeDependencies['readChildBudgetFacts'];
}

function deps(options: ReleaseRuntimeOptions): ResolvedReleaseDependencies {
  const production = productionDependencies();
  return {
    ...production,
    ...options.dependencies,
    resolveBudgetPreflight:
      options.dependencies?.resolveBudgetPreflight ?? production.resolveBudgetPreflight,
    readChildBudgetFacts:
      options.dependencies?.readChildBudgetFacts ?? production.readChildBudgetFacts,
    strictChildBudgetFacts: production.readChildBudgetFacts,
  };
}

/**
 * Independently rooted production budget authority used ONLY to corroborate
 * terminal Release credit.
 *
 * This invocation is deliberately *not* routed through
 * `ReleaseRuntimeDependencies`: `options.dependencies.resolveBudgetPreflight` is
 * only a pre-allocation ordering / test seam, and a caller-supplied synthetic
 * result may exercise the V2 ledger shape but can never be the authority for
 * credit. Production has no independently controlled trust root, so this
 * refuses by default (see ADR 0111); readback must therefore refuse credit
 * regardless of synthetic fixtures, and wiring a real trust root is a separate,
 * reviewed authority decision. String/boolean labels in user input are never
 * accepted as trust.
 *
 * Credit requires the authority to independently reproduce the exact bound
 * policy and measurement-set raw-byte digests and every other binding/ceiling
 * the V2 predeclaration froze. Any structural-only or forged preflight fails
 * this comparison.
 */
function productionAuthorityBindsBudget(bound: VerifiedBudgetPreflightV1): boolean {
  const input: ReleaseBudgetPreflightInputV1 = {
    manifestId: bound.manifestId,
    manifestFingerprint: bound.manifestFingerprint,
    requiredCellId: bound.requiredCellId,
    sourceProvenanceDigest: bound.sourceProvenanceDigest,
    policyApprovalId: bound.policyApprovalId,
  };
  let authoritative: ReleaseBudgetPreflightResultV1;
  try {
    // No caller-supplied options: the production default (refusing) authority is
    // the only route, so this cannot be overridden by ReleaseRuntimeOptions.
    authoritative = resolveReleaseBudgetPreflight(input);
  } catch {
    return false;
  }
  if (!authoritative.ok || authoritative.value.releaseCredit !== false) return false;
  const value = authoritative.value;
  return (
    value.policyApprovalId === bound.policyApprovalId &&
    value.policyDigest === bound.policyDigest &&
    value.approvalDigest === bound.approvalDigest &&
    value.reviewDigest === bound.reviewDigest &&
    value.measurementSetId === bound.measurementSetId &&
    value.measurementSetContentDigest === bound.measurementSetContentDigest &&
    value.method === bound.method &&
    value.methodVersion === bound.methodVersion &&
    canonicalize(value.ceilings) === canonicalize(bound.ceilings) &&
    canonicalize(value.limitations) === canonicalize(bound.limitations) &&
    value.manifestId === bound.manifestId &&
    value.manifestFingerprint === bound.manifestFingerprint &&
    value.requiredCellId === bound.requiredCellId &&
    value.sourceProvenanceDigest === bound.sourceProvenanceDigest &&
    canonicalize(value.basis) === canonicalize(bound.basis)
  );
}

/**
 * Strictly rereads the just-appended provisional record and joins its completed
 * prefix and remaining suffix to the actual ordered slot events. Any mismatch
 * aborts before the endpoint sample, leaving no finalized run (ADR 0113 §2).
 */
function assertProvisionalPersisted(
  d: ResolvedReleaseDependencies,
  runId: string,
  provisionalDigest: string,
  completedOrders: readonly number[],
  unstartedOrders: readonly number[],
): void {
  const records = readReleaseLedger(d.skillRoot, runId);
  const last = records.at(-1);
  if (!last || last.digest !== provisionalDigest || last.event.type !== 'run-provisional')
    throw new Error('PROVISIONAL_NOT_DURABLE');
  const startedOrders: number[] = [];
  for (const record of records) {
    if (record.event.type === 'slot-started') startedOrders.push(record.event.order);
  }
  if (
    canonicalize(last.event.completedOrders) !== canonicalize(completedOrders) ||
    canonicalize(last.event.unstartedOrders) !== canonicalize(unstartedOrders) ||
    canonicalize(startedOrders) !== canonicalize(completedOrders)
  )
    throw new Error('PROVISIONAL_JOIN_INVALID');
}

/**
 * Confirms the completed chain after the single final adjudication append: it
 * must contain exactly one provisional and one final assessment and the final
 * must join the provisional's exact suffix. A failure here never yields a
 * claimed durable termination or credit (ADR 0113 §2/§3).
 */
function assertFinalPersisted(
  d: ResolvedReleaseDependencies,
  runId: string,
  finalDigest: string,
  completedOrders: readonly number[],
  unstartedOrders: readonly number[],
): void {
  const records = readReleaseLedger(d.skillRoot, runId);
  const last = records.at(-1);
  const provisionals = records.filter((record) => record.event.type === 'run-provisional');
  const terminals = records.filter((record) => record.event.type === 'run-assessed');
  if (!last || last.digest !== finalDigest || last.event.type !== 'run-assessed')
    throw new Error('FINAL_NOT_DURABLE');
  if (provisionals.length !== 1 || terminals.length !== 1)
    throw new Error('TERMINAL_SEQUENCE_INVALID');
  const provisional = provisionals[0];
  if (
    provisional?.event.type !== 'run-provisional' ||
    canonicalize(provisional.event.completedOrders) !== canonicalize(completedOrders) ||
    canonicalize(provisional.event.unstartedOrders) !== canonicalize(unstartedOrders) ||
    canonicalize(last.event.unstartedOrders) !== canonicalize(unstartedOrders)
  )
    throw new Error('TERMINAL_JOIN_INVALID');
}

interface TimingSession {
  lastMonotonicSample: number | null;
  invalid: boolean;
}

function monotonicSample(d: ReleaseRuntimeDependencies, session: TimingSession): number {
  if (session.invalid) return Number.NaN;
  try {
    const value = (d.monotonicNow ?? (() => performance.now()))();
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
  d: ReleaseRuntimeDependencies,
  session: TimingSession,
): {
  readonly monotonicStart: number;
  readonly wallStart: string;
} {
  try {
    return {
      monotonicStart: monotonicSample(d, session),
      wallStart: (d.wallNow ?? (() => new Date().toISOString()))(),
    };
  } catch {
    return { monotonicStart: Number.NaN, wallStart: '' };
  }
}

function finishTiming(
  d: ReleaseRuntimeDependencies,
  start: ReturnType<typeof beginTiming>,
  session: TimingSession,
) {
  try {
    const monotonicEnd = monotonicSample(d, session);
    if (session.invalid) return null;
    return createGovernanceTiming({
      ...start,
      monotonicEnd,
      wallEnd: (d.wallNow ?? (() => new Date().toISOString()))(),
    });
  } catch {
    return null;
  }
}

function readBounded(file: string): string {
  const parent = path.dirname(file);
  const stat = lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(parent) !== parent)
    throw new Error('FILE_INVALID');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_AUTHORITY_BYTES)
      throw new Error('FILE_INVALID');
    const b = Buffer.alloc(before.size + 1);
    let n = 0;
    while (n < b.length) {
      const x = readSync(fd, b, n, b.length - n, null);
      if (!x) break;
      n += x;
    }
    const after = fstatSync(fd);
    if (
      n !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ino !== before.ino
    )
      throw new Error('FILE_INVALID');
    return b.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function safeId(id: string): boolean {
  return SAFE_ID.test(id);
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && own.every((k) => typeof k === 'string' && keys.includes(k));
}
function parseJson<T>(text: string): T {
  return JSON.parse(text) as T;
}
function requiredWork(
  draft: ExecutableSelectionManifestDraftV1,
): { entryId: string; cellId: string }[] {
  const cells = [draft.content.requiredCell.cellId];
  return draft.content.entries.flatMap((entry) =>
    cells.map((cellId) => ({ entryId: entry.entryId, cellId })),
  );
}
function lostObligations(
  draft: ExecutableSelectionManifestDraftV1,
): ReleaseScopeProposalV1['lostObligationsByBinding'] {
  return draft.content.bindings.map((binding) => {
    const entries = draft.content.entries.filter(
      (entry) => entry.subjectId === binding.subjectId && entry.capability === binding.capability,
    );
    const included = entries.map((entry) => entry.entryId);
    const satisfied = new Set(entries.flatMap((entry) => entry.obligationIds));
    const required = binding.selection.obligationMappings
      .filter((mapping) => mapping.requiredFor === 'release')
      .map((mapping) => mapping.obligationId);
    return {
      subjectId: binding.subjectId,
      capability: binding.capability,
      includedEntryIds: included,
      uncoveredObligations: [...new Set(required.filter((id) => !satisfied.has(id)))].sort(),
    };
  });
}
function proposalMatches(
  proposal: ReleaseScopeProposalV1,
  draft: ExecutableSelectionManifestDraftV1,
  batch: VerifiedQualificationBatchV1['batch'],
): boolean {
  const counts: Record<string, number> = {};
  for (const item of draft.content.exclusions) counts[item.code] = (counts[item.code] ?? 0) + 1;
  const selectedScenarios = batch.selectedEntryIds.map(
    (id) => draft.content.entries.find((entry) => entry.entryId === id)?.scenarioId,
  );
  return (
    proposal.schemaVersion === 1 &&
    proposal.state === 'PROPOSED_NOT_APPROVED' &&
    proposal.manifestId === draft.manifestId &&
    proposal.contentFingerprint === draft.contentFingerprint &&
    proposal.releaseCredit === false &&
    typeof proposal.scope === 'string' &&
    proposal.scope.trim().length > 0 &&
    typeof proposal.artifact === 'string' &&
    proposal.exclusionCount === draft.content.exclusions.length &&
    canonicalize(proposal.exclusionReasonCounts) === canonicalize(counts) &&
    canonicalize(proposal.lostObligationsByBinding) === canonicalize(lostObligations(draft)) &&
    canonicalize(proposal.qualificationEntryIdsInOrder) === canonicalize(batch.selectedEntryIds) &&
    canonicalize(proposal.qualificationScenarioOrder) === canonicalize(selectedScenarios) &&
    proposal.selectionRationale === batch.selectionRationale &&
    typeof proposal.completeExclusionLedgerSource === 'string' &&
    proposal.completeExclusionLedgerSource.trim().length > 0
  );
}

function recordDigest<T extends Record<string, unknown>>(value: T, field: string): string {
  const { [field]: _ignored, ...unsigned } = value;
  return sha256Hex(`makeit.verify-artwork-editor/${field}/v1\n${canonicalize(unsigned)}`);
}

function readDraft(
  file: string,
  d: ReleaseRuntimeDependencies,
): { draft: ExecutableSelectionManifestDraftV1; bytes: string } {
  if (file.split(/[\\/]/).includes('..')) throw new Error('CANDIDATE_INVALID');
  const absolute = path.resolve(file);
  const draftsRoot = path.join(d.skillRoot, 'cases/selection-manifests/drafts');
  const rel = path.relative(draftsRoot, absolute);
  if (!rel || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
    throw new Error('CANDIDATE_INVALID');
  const bytes = readBounded(absolute);
  const draft = parseJson<ExecutableSelectionManifestDraftV1>(bytes);
  if (!validateExecutableSelectionManifest(draft, d.loadContext()).valid)
    throw new Error('CANDIDATE_INVALID');
  return { draft, bytes };
}

function readApproval(skillRoot: string, id: string): { value: ReleaseApprovalV1; bytes: string } {
  if (!safeId(id)) throw new Error('APPROVAL_INVALID');
  const file = path.join(skillRoot, 'evidence/governance/approvals', `${id}.json`);
  const bytes = readBounded(file);
  const value = parseJson<ReleaseApprovalV1>(bytes);
  if (
    `${canonicalize(value)}\n` !== bytes ||
    !exact(value, [
      'schemaVersion',
      'approvalId',
      'decisionMaker',
      'mandate',
      'decisionScope',
      'manifestId',
      'manifestFingerprint',
      'draftBytesDigest',
      'qualificationBatchId',
      'qualificationBatchFingerprint',
      'qualificationLedgerDigest',
      'requiredWork',
      'proposalReference',
      'proposalBytesDigest',
      'qualificationEntryIdsInOrder',
      'reviews',
      'rationale',
      'timestamp',
      'previousLifecycleDigest',
      'recordDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.approvalId !== id ||
    !Array.isArray(value.reviews) ||
    value.reviews.some(
      (item) =>
        !exact(item, ['reviewId', 'bytesDigest']) ||
        typeof item.reviewId !== 'string' ||
        !SAFE_ID.test(item.reviewId) ||
        typeof item.bytesDigest !== 'string' ||
        !/^[0-9a-f]{64}$/.test(item.bytesDigest),
    ) ||
    value.recordDigest !== recordDigest(value as unknown as Record<string, unknown>, 'recordDigest')
  )
    throw new Error('APPROVAL_INVALID');
  return { value, bytes };
}

function readReview(
  skillRoot: string,
  id: string,
): { value: ReleaseReviewReceiptV1; digest: string } {
  if (!safeId(id)) throw new Error('REVIEW_INVALID');
  const bytes = readBounded(path.join(skillRoot, 'evidence/governance/reviews', `${id}.json`));
  const value = parseJson<ReleaseReviewReceiptV1>(bytes);
  if (
    `${canonicalize(value)}\n` !== bytes ||
    !exact(value, [
      'schemaVersion',
      'reviewId',
      'reviewer',
      'result',
      'manifestId',
      'manifestFingerprint',
      'qualificationBatchId',
      'qualificationLedgerDigest',
      'proposalDigest',
      'rationale',
    ]) ||
    value.schemaVersion !== 1 ||
    value.reviewId !== id ||
    value.result !== 'PASS' ||
    !value.reviewer.trim() ||
    !value.rationale.trim()
  )
    throw new Error('REVIEW_INVALID');
  return { value, digest: sha256Hex(bytes) };
}

function readProposal(
  skillRoot: string,
  reference: string,
): { value: ReleaseScopeProposalV1; digest: string } {
  if (
    !reference.startsWith('evidence/governance/proposals/') ||
    reference.includes('..') ||
    reference.includes('\\')
  )
    throw new Error('PROPOSAL_INVALID');
  const bytes = readBounded(path.join(skillRoot, reference));
  const value = parseJson<ReleaseScopeProposalV1>(bytes);
  if (
    !exact(value, [
      'schemaVersion',
      'state',
      'manifestId',
      'contentFingerprint',
      'artifact',
      'releaseCredit',
      'scope',
      'qualificationEntryIdsInOrder',
      'qualificationScenarioOrder',
      'selectionRationale',
      'lostObligationsByBinding',
      'exclusionCount',
      'exclusionReasonCounts',
      'completeExclusionLedgerSource',
    ]) ||
    !Array.isArray(value.qualificationEntryIdsInOrder) ||
    !value.qualificationEntryIdsInOrder.every((id) => typeof id === 'string') ||
    !Array.isArray(value.qualificationScenarioOrder) ||
    !value.qualificationScenarioOrder.every((id) => typeof id === 'string') ||
    !Array.isArray(value.lostObligationsByBinding) ||
    value.lostObligationsByBinding.some(
      (row) =>
        !exact(row, ['subjectId', 'capability', 'includedEntryIds', 'uncoveredObligations']) ||
        typeof row.subjectId !== 'string' ||
        typeof row.capability !== 'string' ||
        !Array.isArray(row.includedEntryIds) ||
        !row.includedEntryIds.every((id) => typeof id === 'string') ||
        !Array.isArray(row.uncoveredObligations) ||
        !row.uncoveredObligations.every((id) => typeof id === 'string'),
    ) ||
    !value.exclusionReasonCounts ||
    typeof value.exclusionReasonCounts !== 'object' ||
    Array.isArray(value.exclusionReasonCounts) ||
    Object.values(value.exclusionReasonCounts).some(
      (count) => !Number.isSafeInteger(count) || (count as number) < 0,
    )
  )
    throw new Error('PROPOSAL_INVALID');
  return { value, digest: sha256Hex(bytes) };
}

function lifecycleIdFor(draft: ExecutableSelectionManifestDraftV1, draftBytes: string): string {
  const digest = sha256Hex(
    `makeit.verify-artwork-editor/manifest-lifecycle-snapshot/v1\n${canonicalize({ manifestId: draft.manifestId, contentFingerprint: draft.contentFingerprint, draftBytesDigest: sha256Hex(draftBytes) })}`,
  );
  return `manifest-${digest}`;
}
function lifecycle(
  d: ReleaseRuntimeDependencies,
  lifecycleId: string,
): readonly ReleaseLedgerRecord[] | null {
  try {
    return readReleaseLedger(d.skillRoot, lifecycleId);
  } catch {
    return null;
  }
}

export function activateRelease(
  input: { readonly manifestFile: string; readonly batchId: string; readonly approvalId: string },
  options: ReleaseRuntimeOptions = {},
): ReleaseRuntimeResult<ReleaseActivationResult> {
  const d = deps(options);
  try {
    const { draft, bytes } = readDraft(input.manifestFile, d);
    const lifecycleId = lifecycleIdFor(draft, bytes);
    const artifactRelative = path
      .relative(d.skillRoot, path.resolve(input.manifestFile))
      .split(path.sep)
      .join('/');
    const approvalFile = readApproval(d.skillRoot, input.approvalId);
    const approval = approvalFile.value;
    const qualification = d.verifyQualification(input.batchId);
    if (!qualification.ok) return { ok: false, code: 'QUALIFICATION_INVALID' };
    const { batch, finalLedgerDigest } = qualification.verified;
    const proposal = readProposal(d.skillRoot, approval.proposalReference);
    if (
      canonicalize(batch.candidate) !== canonicalize(draft) ||
      batch.manifestId !== draft.manifestId ||
      batch.manifestFingerprint !== draft.contentFingerprint
    )
      return { ok: false, code: 'QUALIFICATION_INVALID' };
    if (
      approval.reviews.length === 0 ||
      new Set(approval.reviews.map((ref) => ref.reviewId)).size !== approval.reviews.length
    )
      return { ok: false, code: 'REVIEW_INVALID' };
    const reviews = approval.reviews.map((ref) => readReview(d.skillRoot, ref.reviewId));
    const prior = lifecycle(d, lifecycleId);
    const priorDigest = finalLedgerDigest;
    const work = requiredWork(draft);
    if (
      approval.decisionMaker !== RELEASE_APPROVAL_ACTOR ||
      approval.mandate !== 'ADR-0099' ||
      approval.decisionScope !== 'activate-exact-release-candidate' ||
      approval.manifestId !== draft.manifestId ||
      approval.manifestFingerprint !== draft.contentFingerprint ||
      approval.draftBytesDigest !== sha256Hex(bytes) ||
      approval.qualificationBatchId !== batch.batchId ||
      approval.qualificationBatchFingerprint !== batch.batchFingerprint ||
      approval.qualificationLedgerDigest !== finalLedgerDigest ||
      approval.previousLifecycleDigest !== priorDigest ||
      canonicalize(approval.requiredWork) !== canonicalize(work) ||
      canonicalize(approval.qualificationEntryIdsInOrder) !==
        canonicalize(batch.selectedEntryIds) ||
      approval.reviews.length < 1 ||
      !approval.rationale.trim() ||
      !Number.isFinite(Date.parse(approval.timestamp))
    )
      return { ok: false, code: 'APPROVAL_MISMATCH' };
    if (
      approval.proposalBytesDigest !== proposal.digest ||
      proposal.value.artifact !== artifactRelative ||
      !proposalMatches(proposal.value, draft, batch)
    )
      return { ok: false, code: 'PROPOSAL_INVALID' };
    for (let index = 0; index < reviews.length; index += 1) {
      const review = reviews[index];
      const ref = approval.reviews[index];
      if (
        !review ||
        !ref ||
        review.digest !== ref.bytesDigest ||
        review.value.reviewer === approval.decisionMaker ||
        review.value.manifestId !== draft.manifestId ||
        review.value.manifestFingerprint !== draft.contentFingerprint ||
        review.value.qualificationBatchId !== batch.batchId ||
        review.value.qualificationLedgerDigest !== finalLedgerDigest ||
        review.value.proposalDigest !== proposal.digest
      )
        return { ok: false, code: 'REVIEW_INVALID' };
    }
    let priorFrozen: ReleaseLedgerRecord | null = null;
    if (prior) {
      if (prior.length !== 1 || prior[0]?.event.type !== 'APPROVED_FROZEN')
        return { ok: false, code: 'ALREADY_ACTIVE' };
      const event = prior[0].event;
      if (
        event.approvalId !== approval.approvalId ||
        event.approvalBytesDigest !== sha256Hex(approvalFile.bytes) ||
        event.draftBytesDigest !== sha256Hex(bytes) ||
        event.batchId !== batch.batchId ||
        event.batchFingerprint !== batch.batchFingerprint ||
        event.qualificationLedgerDigest !== finalLedgerDigest ||
        event.proposalBytesDigest !== proposal.digest ||
        canonicalize(event.manifest) !== canonicalize(draft) ||
        canonicalize(event.work) !== canonicalize(work) ||
        canonicalize(event.reviewBytesDigests) !== canonicalize(reviews.map((item) => item.digest))
      )
        return { ok: false, code: 'APPROVAL_MISMATCH' };
      priorFrozen = prior[0];
    }
    const frozen =
      priorFrozen ??
      createReleaseLedger(d.skillRoot, lifecycleId, {
        type: 'APPROVED_FROZEN',
        manifest: draft,
        draftBytesDigest: sha256Hex(bytes),
        batchId: batch.batchId,
        batchFingerprint: batch.batchFingerprint,
        qualificationLedgerDigest: finalLedgerDigest,
        approvalId: approval.approvalId,
        approvalBytesDigest: sha256Hex(approvalFile.bytes),
        proposalBytesDigest: proposal.digest,
        reviewBytesDigests: reviews.map((item) => item.digest),
        work,
      });
    const active = appendReleaseEvent(d.skillRoot, lifecycleId, {
      type: 'ACTIVE',
      frozenEventDigest: frozen.digest,
    });
    return {
      ok: true,
      value: {
        lifecycleId,
        lifecycleDigest: active.digest,
        manifestId: draft.manifestId,
        manifestFingerprint: draft.contentFingerprint,
        workCount: work.length,
        exclusions: draft.content.exclusions,
        lostObligationsByBinding: lostObligations(draft),
      },
    };
  } catch {
    return { ok: false, code: 'APPROVAL_INVALID' };
  }
}

export async function runRelease(
  input: { readonly manifestFile: string },
  options: ReleaseRuntimeOptions = {},
): Promise<ReleaseRuntimeResult<ReleaseRunResult>> {
  const d = deps(options);
  let runId = '';
  try {
    const { draft: identityDraft, bytes: identityBytes } = readDraft(input.manifestFile, d);
    const lifecycleId = lifecycleIdFor(identityDraft, identityBytes);
    const records = readReleaseLedger(d.skillRoot, lifecycleId);
    const events = records.map((r) => r.event);
    if (
      events.length !== 2 ||
      events[0]?.type !== 'APPROVED_FROZEN' ||
      events[1]?.type !== 'ACTIVE' ||
      events[1].frozenEventDigest !== records[0]?.digest
    )
      return { ok: false, code: 'LIFECYCLE_INVALID' };
    const frozen = events[0];
    if (frozen.type !== 'APPROVED_FROZEN') return { ok: false, code: 'LIFECYCLE_INVALID' };
    const { draft, bytes } = { draft: identityDraft, bytes: identityBytes };
    if (
      sha256Hex(bytes) !== frozen.draftBytesDigest ||
      canonicalize(draft) !== canonicalize(frozen.manifest) ||
      d.collectSourceDigest() === ''
    )
      return { ok: false, code: 'CANDIDATE_INVALID' };
    const qualification = d.verifyQualification(frozen.batchId);
    if (
      !qualification.ok ||
      qualification.verified.batch.batchFingerprint !== frozen.batchFingerprint ||
      qualification.verified.finalLedgerDigest !== frozen.qualificationLedgerDigest ||
      canonicalize(qualification.verified.batch.candidate) !== canonicalize(draft) ||
      qualification.verified.batch.manifestId !== draft.manifestId ||
      qualification.verified.batch.manifestFingerprint !== draft.contentFingerprint
    )
      return { ok: false, code: 'QUALIFICATION_INVALID' };
    const approvalInput = readApproval(d.skillRoot, frozen.approvalId);
    const proposal = readProposal(d.skillRoot, approvalInput.value.proposalReference);
    const reviews = approvalInput.value.reviews.map((review) =>
      readReview(d.skillRoot, review.reviewId),
    );
    if (
      sha256Hex(approvalInput.bytes) !== frozen.approvalBytesDigest ||
      approvalInput.value.reviews.length === 0 ||
      approvalInput.value.decisionMaker !== RELEASE_APPROVAL_ACTOR ||
      approvalInput.value.mandate !== 'ADR-0099' ||
      approvalInput.value.decisionScope !== 'activate-exact-release-candidate' ||
      approvalInput.value.manifestId !== draft.manifestId ||
      approvalInput.value.manifestFingerprint !== draft.contentFingerprint ||
      approvalInput.value.draftBytesDigest !== frozen.draftBytesDigest ||
      approvalInput.value.qualificationBatchId !== qualification.verified.batch.batchId ||
      approvalInput.value.qualificationBatchFingerprint !==
        qualification.verified.batch.batchFingerprint ||
      approvalInput.value.qualificationLedgerDigest !== qualification.verified.finalLedgerDigest ||
      approvalInput.value.previousLifecycleDigest !== qualification.verified.finalLedgerDigest ||
      !approvalInput.value.rationale.trim() ||
      !Number.isFinite(Date.parse(approvalInput.value.timestamp)) ||
      canonicalize(approvalInput.value.requiredWork) !== canonicalize(requiredWork(draft)) ||
      canonicalize(approvalInput.value.qualificationEntryIdsInOrder) !==
        canonicalize(qualification.verified.batch.selectedEntryIds) ||
      proposal.digest !== frozen.proposalBytesDigest ||
      proposal.value.artifact !==
        path.relative(d.skillRoot, path.resolve(input.manifestFile)).split(path.sep).join('/') ||
      proposal.digest !== approvalInput.value.proposalBytesDigest ||
      !proposalMatches(proposal.value, draft, qualification.verified.batch) ||
      canonicalize(reviews.map((review) => review.digest)) !==
        canonicalize(frozen.reviewBytesDigests) ||
      reviews.some(
        (review, index) =>
          review.digest !== approvalInput.value.reviews[index]?.bytesDigest ||
          review.value.reviewer === approvalInput.value.decisionMaker ||
          review.value.proposalDigest !== proposal.digest ||
          review.value.qualificationLedgerDigest !== qualification.verified.finalLedgerDigest ||
          review.value.qualificationBatchId !== qualification.verified.batch.batchId ||
          review.value.manifestId !== draft.manifestId ||
          review.value.manifestFingerprint !== draft.contentFingerprint,
      )
    )
      return { ok: false, code: 'APPROVAL_MISMATCH' };
    if (d.collectSourceDigest() !== qualification.verified.sourceProvenanceDigest)
      return { ok: false, code: 'SOURCE_DRIFT' };
    const work = requiredWork(draft);
    if (
      work.length !== frozen.work.length ||
      work.some(
        (item, i) =>
          item.entryId !== frozen.work[i]?.entryId || item.cellId !== frozen.work[i]?.cellId,
      )
    )
      return { ok: false, code: 'PLAN_INVALID' };
    const slots: ReleaseWorkSlotV1[] = frozen.work.map((item, order) => ({
      order,
      entryId: item.entryId,
      cell: draft.content.requiredCell,
      instanceId: `rinstance-${d.makeId()}`,
      runId: `release-${d.makeId()}`,
    }));
    if (
      new Set(slots.map((slot) => slot.runId)).size !== slots.length ||
      new Set(slots.map((slot) => slot.instanceId)).size !== slots.length ||
      slots.some((slot) => !isSafeRunId(slot.runId))
    )
      return { ok: false, code: 'PLAN_INVALID' };
    const compiled: PreparedCandidate[] = [];
    for (const slot of slots) {
      const entry = draft.content.entries.find((candidate) => candidate.entryId === slot.entryId);
      if (!entry) return { ok: false, code: 'CANDIDATE_INVALID' };
      const candidate = d.compileCandidate(entry.request);
      if (!candidate.ok || !matches(entry, candidate.candidate))
        return { ok: false, code: 'PLAN_INVALID' };
      compiled.push(candidate.candidate);
    }
    if (d.collectSourceDigest() !== qualification.verified.sourceProvenanceDigest)
      return { ok: false, code: 'SOURCE_DRIFT' };
    runId = `rrun-${d.makeId()}`;
    if (!isSafeRunId(runId)) return { ok: false, code: 'PLAN_INVALID' };
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
    if (!shard.ok) return { ok: false, code: 'PLAN_INVALID' };
    const shardCheck = reconstructLocalReleaseShards(shard.plan, [
      {
        schemaVersion: 1,
        planFingerprint: shard.plan.fingerprint,
        shardIndex: 0,
        status: 'complete',
        items: shardItems,
      },
    ]);
    if (!shardCheck.ok) return { ok: false, code: 'PLAN_INVALID' };
    // Pre-allocation budget-policy preflight: exact approval + fresh
    // Qualification have already been re-verified above; the independently
    // rooted policy/set readback must now bind this exact manifest/cell/source
    // before the first allocation or ledger write. Refusal precedes every
    // lease, run directory, process and Release-start write.
    const preflightInput: ReleaseBudgetPreflightInputV1 = {
      manifestId: draft.manifestId,
      manifestFingerprint: draft.contentFingerprint,
      requiredCellId: draft.content.requiredCell.cellId,
      sourceProvenanceDigest: qualification.verified.sourceProvenanceDigest,
      policyApprovalId: d.budgetPolicyApprovalId ?? null,
    };
    let preflight: ReleaseBudgetPreflightResultV1;
    try {
      preflight = (
        d.resolveBudgetPreflight ?? (() => ({ ok: false, code: 'BUDGET_AUTHORITY_UNATTESTED' }))
      )(preflightInput);
    } catch {
      return { ok: false, code: 'BUDGET_PREFLIGHT_REFUSED' };
    }
    if (
      !preflight.ok ||
      !isVerifiedBudgetPreflight(preflight.value) ||
      preflight.value.manifestId !== draft.manifestId ||
      preflight.value.manifestFingerprint !== draft.contentFingerprint ||
      preflight.value.requiredCellId !== draft.content.requiredCell.cellId ||
      preflight.value.sourceProvenanceDigest !== qualification.verified.sourceProvenanceDigest
    )
      return { ok: false, code: 'BUDGET_PREFLIGHT_REFUSED' };
    // Authority of the budget classification: only the independently rooted
    // production budget authority can bind it. When it does, budget facts are
    // read exclusively through the fixed root-bound reader; the injectable
    // `readChildBudgetFacts` seam is otherwise test-only and non-authoritative
    // (ADR 0113 §6).
    const budgetAuthorityBound = productionAuthorityBindsBudget(preflight.value);
    const readFacts = budgetAuthorityBound ? d.strictChildBudgetFacts : d.readChildBudgetFacts;
    const pre = createReleaseLedgerV2(d.skillRoot, runId, {
      type: 'run-predeclared',
      lifecycleId,
      activeEventDigest: records[1]?.digest ?? '',
      slots,
      shardPlanFingerprint: shard.plan.fingerprint,
      budget: preflight.value,
    });
    claimReleaseRun(d.skillRoot, runId, pre.digest);
    appendReleaseEventV2(d.skillRoot, runId, {
      type: 'run-started',
      lifecycleDigest: records[1]?.digest ?? '',
    });
    const timingSession: TimingSession = { lastMonotonicSample: null, invalid: false };
    const runTimingStart = beginTiming(d, timingSession);
    const outcomes: { order: number; runId: string; outcome: string | null }[] = [];
    let interrupted = false;
    let allPass = true;
    let timingInvalid = false;
    let budgetTerminated = false;
    let cumulativeEvidenceBytes = 0;
    let cumulativeImageTorn = 0;
    const slotElapsedTimes: number[] = [];
    for (let i = 0; i < slots.length; i += 1) {
      const slot = slots[i];
      const candidate = compiled[i];
      if (!slot || !candidate) {
        interrupted = true;
        allPass = false;
        break;
      }
      try {
        if (d.collectSourceDigest() !== qualification.verified.sourceProvenanceDigest) {
          interrupted = true;
          allPass = false;
          break;
        }
      } catch {
        interrupted = true;
        allPass = false;
        break;
      }
      const slotTimingStart = beginTiming(d, timingSession);
      if (timingSession.invalid) {
        timingInvalid = true;
        interrupted = true;
        allPass = false;
        break;
      }
      // Aggregate duration ceiling check BEFORE allocating or starting the next
      // slot. The shared monotonic session has already charged every prior
      // slot's execution, strict evidence reread, cleanup and the between-slot
      // orchestration gap, so the ceiling sees the real total from run start.
      // Equality is allowed; only a strictly greater elapsed terminates.
      if (
        slotTimingStart.monotonicStart - runTimingStart.monotonicStart >
        preflight.value.ceilings.releaseDurationMs
      ) {
        budgetTerminated = true;
        break;
      }
      appendReleaseEventV2(d.skillRoot, runId, {
        type: 'slot-started',
        order: slot.order,
        instanceId: slot.instanceId,
        runId: slot.runId,
      });
      let cli: CliResult<unknown>;
      try {
        cli = await d.runCandidate({
          preparedCandidate: candidate,
          expectedIdentity: candidate.identity,
          runId: slot.runId,
        });
      } catch {
        const timing = finishTiming(d, slotTimingStart, timingSession);
        appendReleaseEventV2(d.skillRoot, runId, {
          type: 'slot-finished',
          order: slot.order,
          instanceId: slot.instanceId,
          runId: slot.runId,
          outcome: null,
          recordDigest: null,
          evidenceDigest: null,
          failureCode: 'EXECUTION_INTERRUPTED',
          ...(timing === null ? {} : { timing }),
        });
        outcomes.push({ order: slot.order, runId: slot.runId, outcome: null });
        interrupted = true;
        allPass = false;
        break;
      }
      let child: VerifiedChild;
      try {
        child = d.readAndVerifyChild(slot.runId);
      } catch {
        const timing = finishTiming(d, slotTimingStart, timingSession);
        appendReleaseEventV2(d.skillRoot, runId, {
          type: 'slot-finished',
          order: slot.order,
          instanceId: slot.instanceId,
          runId: slot.runId,
          outcome: null,
          recordDigest: null,
          evidenceDigest: null,
          failureCode: 'EXECUTION_INTERRUPTED',
          ...(timing === null ? {} : { timing }),
        });
        outcomes.push({ order: slot.order, runId: slot.runId, outcome: null });
        interrupted = true;
        allPass = false;
        break;
      }
      const expected = draft.content.entries.find((entry) => entry.entryId === slot.entryId);
      const identityOK =
        !!expected &&
        child.runId === slot.runId &&
        child.caseId === expected.caseId &&
        child.materializationFingerprint === expected.materializationFingerprint &&
        child.planFingerprint === expected.planFingerprint &&
        child.cellId === slot.cell.cellId &&
        child.profile === 'release' &&
        child.provenance === 'manifest' &&
        child.evidenceDepth === 'standard';
      const outcome = identityOK ? child.outcome : null;
      const resultOutcome =
        cli.status === 'PASS' ||
        cli.status === 'BUG' ||
        cli.status === 'HARNESS_BLOCKED' ||
        cli.status === 'ENVIRONMENT_FAILURE'
          ? cli.status
          : null;
      const valid =
        identityOK &&
        child.valid &&
        child.cleanupVerified &&
        child.evidenceVerified &&
        typeof child.recordDigest === 'string' &&
        outcome !== null &&
        outcome === resultOutcome;
      // Strict aggregate budget facts. A valid child is not budget-accounted
      // until its owned evidence root is re-read strictly; an unreadable root, a
      // record that does not join the verified child digest, or a missing
      // required Image counter is an integrity refusal, never a budget skip.
      let budgetFacts: ReleaseChildBudgetFactsV1 | null = null;
      let budgetFactsUnavailable = false;
      if (valid) {
        const family = deriveBudgetMeasuredFamily(candidate.planning.materializedCase);
        if (family === null) {
          budgetFactsUnavailable = true;
        } else {
          try {
            const facts = readFacts({
              runId: slot.runId,
              family,
              recordDigest: child.recordDigest,
            });
            if (facts.ok) budgetFacts = facts.value;
            else budgetFactsUnavailable = true;
          } catch {
            budgetFactsUnavailable = true;
          }
        }
      }
      const strictValid = valid && !budgetFactsUnavailable;
      const timing = finishTiming(d, slotTimingStart, timingSession);
      if (timing === null) timingInvalid = true;
      else slotElapsedTimes.push(timing.elapsedMs);
      appendReleaseEventV2(d.skillRoot, runId, {
        type: 'slot-finished',
        order: slot.order,
        instanceId: slot.instanceId,
        runId: slot.runId,
        outcome: strictValid ? outcome : null,
        recordDigest: strictValid ? child.recordDigest : null,
        evidenceDigest: strictValid ? (child.evidenceDigest ?? null) : null,
        failureCode: strictValid
          ? timing === null
            ? 'TIMING_INVALID'
            : null
          : budgetFactsUnavailable
            ? 'EVIDENCE_INVALID'
            : (child.code ?? 'CHILD_RECORD_INVALID'),
        ...(timing === null ? {} : { timing }),
      });
      outcomes.push({
        order: slot.order,
        runId: slot.runId,
        outcome: strictValid ? outcome : null,
      });
      if (!strictValid || outcome !== 'PASS') allPass = false;
      if (!strictValid) {
        interrupted = true;
        break;
      }
      if (timing === null) {
        interrupted = true;
        break;
      }
      if (budgetFacts !== null) {
        cumulativeEvidenceBytes += budgetFacts.evidenceByteCount;
        if (budgetFacts.imageTornRecaptures !== null)
          cumulativeImageTorn += budgetFacts.imageTornRecaptures;
      }
      // Cumulative strict-evidence byte and Image tear ceilings are checked after
      // the started child's strict verification and cleanup. Equality is allowed;
      // only a strictly greater cumulative total terminates the run. A stronger
      // invalid-evidence/cleanup/timing stop above is never relabeled this way.
      if (
        cumulativeEvidenceBytes > preflight.value.ceilings.releaseEvidenceBytes ||
        (preflight.value.ceilings.imageTornRecaptures !== null &&
          cumulativeImageTorn > preflight.value.ceilings.imageTornRecaptures)
      ) {
        budgetTerminated = true;
        break;
      }
      try {
        if (d.collectSourceDigest() !== qualification.verified.sourceProvenanceDigest) {
          interrupted = true;
          allPass = false;
          break;
        }
      } catch {
        interrupted = true;
        allPass = false;
        break;
      }
    }
    const completedOrders = outcomes.map((item) => item.order);
    const unstarted = slots.slice(outcomes.length).map((slot) => slot.order);
    // ADR 0113 finite metered endpoint: durably append one pending, non-credit
    // provisional assessment and strictly reread its canonical chain and exact
    // work-order prefix/suffix joins BEFORE the sole endpoint sample. That makes
    // terminal persistence/readback waiting part of the checked interval without
    // representing the final adjudication write in the value it stores.
    d.terminalPersistenceSeam?.('before-provisional-append');
    const provisional = appendReleaseEventV2(d.skillRoot, runId, {
      type: 'run-provisional',
      completedOrders,
      unstartedOrders: unstarted,
      pending: true,
      releaseCreditGranted: false,
    });
    d.terminalPersistenceSeam?.('before-provisional-reread');
    assertProvisionalPersisted(d, runId, provisional.digest, completedOrders, unstarted);
    // Test-only seam: advance a synthetic clock across provisional
    // persistence/readback waiting. It cannot alter ledger, state or authority.
    d.afterProvisionalReadback?.();
    // Sole final duration sample: taken after the provisional append/readback and
    // before the final adjudication append.
    const runTiming = finishTiming(d, runTimingStart, timingSession);
    if (
      runTiming === null ||
      runTiming.elapsedMs < slotElapsedTimes.reduce((total, elapsed) => total + elapsed, 0)
    )
      timingInvalid = true;
    // Endpoint aggregate ceiling sample: the run-level monotonic elapsed now also
    // covers the last slot's cleanup and the provisional persistence/readback
    // wait. A budget stop is only ever declared when the clock itself stayed
    // valid and no stronger integrity stop occurred.
    if (
      !timingInvalid &&
      !interrupted &&
      runTiming !== null &&
      runTiming.elapsedMs > preflight.value.ceilings.releaseDurationMs
    )
      budgetTerminated = true;
    const state =
      budgetTerminated && !timingInvalid && !interrupted
        ? 'BUDGET_TERMINATED'
        : interrupted || unstarted.length > 0
          ? 'INTERRUPTED'
          : timingInvalid
            ? 'NON_CREDITABLE'
            : allPass && outcomes.length === slots.length
              ? 'COMPLETE_ALL_PASS'
              : 'NON_CREDITABLE';
    // Classification authority is derived, never asserted: only the independently
    // rooted production authority makes a terminal budget decision authoritative.
    // A caller-supplied synthetic preflight or synthetic child-facts seam may
    // exercise ledger/transitions, but is explicitly non-authoritative and can
    // never mint credit or an authoritative `BUDGET_TERMINATED` (ADR 0111/0113).
    const budgetAuthority: ReleaseBudgetAuthorityV1 = budgetAuthorityBound
      ? 'ROOT_BOUND'
      : 'NON_AUTHORITATIVE';
    const releaseCreditGranted = state === 'COMPLETE_ALL_PASS' && budgetAuthorityBound;
    d.terminalPersistenceSeam?.('before-final-append');
    const final = appendReleaseEventV2(d.skillRoot, runId, {
      type: 'run-assessed',
      state,
      unstartedOrders: unstarted,
      releaseCreditGranted,
      ...(runTiming === null ? {} : { timing: runTiming }),
      ...(timingInvalid ? { timingFailureCode: 'TIMING_INVALID' as const } : {}),
    });
    // Confirm durable completion by strictly rereading the completed chain.
    d.terminalPersistenceSeam?.('before-final-reread');
    assertFinalPersisted(d, runId, final.digest, completedOrders, unstarted);
    return {
      ok: true,
      value: {
        runId,
        manifestId: draft.manifestId,
        manifestFingerprint: draft.contentFingerprint,
        state,
        releaseCreditGranted,
        budgetAuthority,
        workCount: slots.length,
        outcomes,
        exclusions: draft.content.exclusions,
        lostObligationsByBinding: lostObligations(draft),
      },
    };
  } catch {
    return { ok: false, code: runId ? 'LEDGER_INVALID' : 'LIFECYCLE_INVALID' };
  }
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

/** Terminal re-verifier for future claim/budget readers; stored credit fields are consistency data only. */
export function verifyReleaseRun(
  skillRoot: string,
  runId: string,
  options: ReleaseRuntimeOptions,
): ReleaseRuntimeResult<ReleaseRunResult> {
  try {
    const d = deps(options);
    if (path.resolve(skillRoot) !== d.skillRoot) return { ok: false, code: 'LEDGER_INVALID' };
    const records = readReleaseLedger(skillRoot, runId);
    const first = records[0]?.event;
    const terminal = records.at(-1)?.event;
    if (
      !first ||
      first.type !== 'run-predeclared' ||
      !terminal ||
      terminal.type !== 'run-assessed' ||
      !isGovernanceTiming(terminal.timing)
    )
      return { ok: false, code: 'LEDGER_INVALID' };
    if (!isSafeRunId(runId)) return { ok: false, code: 'LEDGER_INVALID' };
    const life = readReleaseLedger(skillRoot, first.lifecycleId);
    const frozen = life[0]?.event;
    const active = life[1]?.event;
    const activeRecord = life[1];
    if (
      life.length !== 2 ||
      frozen?.type !== 'APPROVED_FROZEN' ||
      active?.type !== 'ACTIVE' ||
      !activeRecord ||
      active.frozenEventDigest !== life[0]?.digest ||
      activeRecord.digest !== first.activeEventDigest
    )
      return { ok: false, code: 'LIFECYCLE_INVALID' };
    const qualified = d.verifyQualification(frozen.batchId);
    if (
      !qualified.ok ||
      qualified.verified.finalLedgerDigest !== frozen.qualificationLedgerDigest ||
      qualified.verified.batch.batchFingerprint !== frozen.batchFingerprint ||
      canonicalize(qualified.verified.batch.candidate) !== canonicalize(frozen.manifest) ||
      d.collectSourceDigest() !== qualified.verified.sourceProvenanceDigest
    )
      return { ok: false, code: 'QUALIFICATION_INVALID' };
    const approvalInput = readApproval(skillRoot, frozen.approvalId);
    const proposal = readProposal(skillRoot, approvalInput.value.proposalReference);
    const { draft, bytes } = readDraft(path.join(skillRoot, proposal.value.artifact), d);
    const reviews = approvalInput.value.reviews.map((review) =>
      readReview(skillRoot, review.reviewId),
    );
    if (
      canonicalize(draft) !== canonicalize(frozen.manifest) ||
      sha256Hex(bytes) !== frozen.draftBytesDigest ||
      first.lifecycleId !== lifecycleIdFor(draft, bytes) ||
      canonicalize(frozen.work) !== canonicalize(requiredWork(draft)) ||
      sha256Hex(approvalInput.bytes) !== frozen.approvalBytesDigest ||
      proposal.digest !== frozen.proposalBytesDigest ||
      approvalInput.value.decisionMaker !== RELEASE_APPROVAL_ACTOR ||
      approvalInput.value.mandate !== 'ADR-0099' ||
      approvalInput.value.decisionScope !== 'activate-exact-release-candidate' ||
      approvalInput.value.manifestId !== draft.manifestId ||
      approvalInput.value.manifestFingerprint !== draft.contentFingerprint ||
      approvalInput.value.draftBytesDigest !== frozen.draftBytesDigest ||
      approvalInput.value.qualificationBatchId !== qualified.verified.batch.batchId ||
      approvalInput.value.qualificationBatchFingerprint !==
        qualified.verified.batch.batchFingerprint ||
      approvalInput.value.qualificationLedgerDigest !== qualified.verified.finalLedgerDigest ||
      approvalInput.value.previousLifecycleDigest !== qualified.verified.finalLedgerDigest ||
      approvalInput.value.proposalBytesDigest !== proposal.digest ||
      canonicalize(approvalInput.value.requiredWork) !== canonicalize(requiredWork(draft)) ||
      canonicalize(approvalInput.value.qualificationEntryIdsInOrder) !==
        canonicalize(qualified.verified.batch.selectedEntryIds) ||
      !proposalMatches(proposal.value, draft, qualified.verified.batch) ||
      canonicalize(reviews.map((review) => review.digest)) !==
        canonicalize(frozen.reviewBytesDigests) ||
      reviews.some(
        (review, index) =>
          review.digest !== approvalInput.value.reviews[index]?.bytesDigest ||
          review.value.reviewer === approvalInput.value.decisionMaker ||
          review.value.proposalDigest !== proposal.digest ||
          review.value.qualificationLedgerDigest !== qualified.verified.finalLedgerDigest ||
          review.value.qualificationBatchId !== qualified.verified.batch.batchId ||
          review.value.manifestId !== draft.manifestId ||
          review.value.manifestFingerprint !== draft.contentFingerprint,
      )
    )
      return { ok: false, code: 'APPROVAL_MISMATCH' };
    const slots = first.slots;
    if (
      slots.length === 0 ||
      slots.length !== frozen.work.length ||
      slots.some(
        (slot, index) =>
          slot.order !== index ||
          slot.entryId !== frozen.work[index]?.entryId ||
          slot.cell.cellId !== frozen.work[index]?.cellId ||
          canonicalize(slot.cell) !== canonicalize(draft.content.requiredCell),
      ) ||
      new Set(slots.map((slot) => slot.runId)).size !== slots.length ||
      new Set(slots.map((slot) => slot.instanceId)).size !== slots.length
    )
      return { ok: false, code: 'PLAN_INVALID' };
    const shardItems: ReleaseShardWorkItemV1[] = slots.map((slot) => ({
      order: slot.order,
      entryId: slot.entryId,
      cellId: slot.cell.cellId,
      instanceId: slot.instanceId,
      runId: slot.runId,
    }));
    const shard = createLocalReleaseShardPlan({
      manifestFingerprint: frozen.manifest.contentFingerprint,
      items: shardItems,
      shardCount: 1,
    });
    if (!shard.ok || shard.plan.fingerprint !== first.shardPlanFingerprint)
      return { ok: false, code: 'PLAN_INVALID' };
    const started = records[1]?.event;
    if (started?.type !== 'run-started' || started.lifecycleDigest !== activeRecord.digest)
      return { ok: false, code: 'LEDGER_INVALID' };
    // Independent WP5-C readback rederives budget authority from the persisted
    // bound predeclaration rather than any stored classification/credit flag.
    // Only a bound V2 predeclaration whose exact policy/set raw bytes the rooted
    // production authority corroborates is `ROOT_BOUND`; a synthetic/test chain
    // can exercise reordering and shape but is always `NON_AUTHORITATIVE`.
    const predeclaration = records[0];
    const boundBudget =
      predeclaration &&
      predeclaration.schemaVersion === RELEASE_LEDGER_SCHEMA_VERSION_V2 &&
      predeclaration.event.type === 'run-predeclared'
        ? predeclaration.event.budget
        : null;
    const budgetAuthorityBound =
      boundBudget !== null && productionAuthorityBindsBudget(boundBudget);
    // A root-bound chain re-reads strict owned child evidence through the fixed
    // reader; an unbound chain uses the injected reader for structurally
    // representative proof only and can never derive credit.
    const readFacts = budgetAuthorityBound ? d.strictChildBudgetFacts : d.readChildBudgetFacts;
    const outcomes: { order: number; runId: string; outcome: string | null }[] = [];
    let allPass = true;
    let integrityStop = false;
    let cursor = 2;
    let completed = 0;
    let slotElapsedTotal = 0;
    let derivedEvidenceBytes = 0;
    let derivedImageTorn = 0;
    for (const slot of slots) {
      const begin = records[cursor]?.event;
      if (begin?.type !== 'slot-started') {
        // No further started slot: the remainder is the exact unstarted suffix.
        // Whether that is a budget stop or an interruption is derived below from
        // the bound ceilings and any recorded integrity failure.
        break;
      }
      cursor += 1;
      const finish = records[cursor]?.event;
      if (
        finish?.type !== 'slot-finished' ||
        !isGovernanceTiming(finish.timing) ||
        begin.order !== slot.order ||
        begin.instanceId !== slot.instanceId ||
        begin.runId !== slot.runId ||
        finish.order !== slot.order ||
        finish.instanceId !== slot.instanceId ||
        finish.runId !== slot.runId
      )
        return { ok: false, code: 'LEDGER_INVALID' };
      slotElapsedTotal += finish.timing.elapsedMs;
      cursor += 1;
      completed += 1;
      if (
        finish.failureCode === 'EXECUTION_INTERRUPTED' &&
        finish.outcome === null &&
        finish.recordDigest === null &&
        finish.evidenceDigest === null
      ) {
        outcomes.push({ order: slot.order, runId: slot.runId, outcome: null });
        allPass = false;
        integrityStop = true;
        break;
      }
      const child = d.readAndVerifyChild(slot.runId);
      const expectedEntry = draft.content.entries.find((entry) => entry.entryId === slot.entryId);
      const valid =
        !!expectedEntry &&
        child.valid &&
        child.runId === slot.runId &&
        child.caseId === expectedEntry.caseId &&
        child.materializationFingerprint === expectedEntry.materializationFingerprint &&
        child.planFingerprint === expectedEntry.planFingerprint &&
        child.cellId === slot.cell.cellId &&
        child.profile === 'release' &&
        child.provenance === 'manifest' &&
        child.evidenceDepth === 'standard' &&
        child.cleanupVerified &&
        child.evidenceVerified &&
        child.recordDigest === finish.recordDigest &&
        child.evidenceDigest === finish.evidenceDigest &&
        child.outcome === finish.outcome;
      if (!valid)
        return {
          ok: false,
          code: child.code === 'EVIDENCE_INVALID' ? 'CANDIDATE_INVALID' : 'LEDGER_INVALID',
        };
      // Strict counter rederivation (WP5-C): for a bound V2 chain the family is
      // recompiled from the frozen manifest entry (never a stored scalar) and the
      // owned evidence bytes plus any applicable Image tear count are re-read from
      // the rooted child evidence. A missing/undesivable fact is an integrity
      // refusal, never a silently lower byte/torn total (ADR 0113 §6).
      if (boundBudget !== null) {
        if (!expectedEntry) return { ok: false, code: 'LEDGER_INVALID' };
        let family: ReleaseBudgetFamilyV1 | null = null;
        try {
          const compiled = d.compileCandidate(expectedEntry.request);
          if (compiled.ok && matches(expectedEntry, compiled.candidate))
            family = deriveBudgetMeasuredFamily(compiled.candidate.planning.materializedCase);
        } catch {
          family = null;
        }
        if (family === null) return { ok: false, code: 'LEDGER_INVALID' };
        let facts: ReleaseChildBudgetFactsResultV1;
        try {
          facts = readFacts({ runId: slot.runId, family, recordDigest: child.recordDigest });
        } catch {
          return { ok: false, code: 'LEDGER_INVALID' };
        }
        if (!facts.ok) return { ok: false, code: 'LEDGER_INVALID' };
        derivedEvidenceBytes += facts.value.evidenceByteCount;
        if (facts.value.imageTornRecaptures !== null)
          derivedImageTorn += facts.value.imageTornRecaptures;
      }
      outcomes.push({ order: slot.order, runId: slot.runId, outcome: child.outcome });
      if (child.outcome !== 'PASS' || finish.failureCode !== null) allPass = false;
      if (finish.failureCode !== null) {
        integrityStop = true;
        break;
      }
    }
    const completedOrders = slots.slice(0, completed).map((slot) => slot.order);
    const unstarted = slots.slice(completed).map((slot) => slot.order);
    const v2Run = records[0]?.schemaVersion === RELEASE_LEDGER_SCHEMA_VERSION_V2;
    // ADR 0113 exact V2 event sequence: for a new (V2) run, after the ordered slot
    // pairs there must be exactly one pending provisional assessment joining the
    // exact completed prefix and remaining suffix, immediately followed by exactly
    // one final assessment joining it. Absent, duplicated, reordered or
    // contradictory provisional/final records are refused rather than trusted.
    // Retained V1 history keeps its prior shape and stays readable/non-creditable.
    const provisional = records[cursor]?.event;
    let provisionalInvalid = false;
    if (v2Run) {
      const prov = provisional;
      provisionalInvalid =
        !prov ||
        prov.type !== 'run-provisional' ||
        cursor !== records.length - 2 ||
        records.filter((record) => record.event.type === 'run-provisional').length !== 1 ||
        prov.pending !== true ||
        prov.releaseCreditGranted !== false ||
        canonicalize(prov.completedOrders) !== canonicalize(completedOrders) ||
        canonicalize(prov.unstartedOrders) !== canonicalize(unstarted);
    }
    // Independent WP5-C terminal derivation. The sole aggregate duration is the
    // persisted bound endpoint timing (never a wall-clock delta or per-slot sum,
    // which cannot reconstruct elapsed). Every applicable metered ceiling is
    // compared against strictly rederived facts; the persisted state, totals,
    // reason and credit boolean are consistency data only, never authority.
    const elapsedMs = terminal.timing.elapsedMs;
    const durationCeilingMs = boundBudget === null ? null : boundBudget.ceilings.releaseDurationMs;
    const evidenceByteCeiling =
      boundBudget === null ? null : boundBudget.ceilings.releaseEvidenceBytes;
    const imageTornCeiling = boundBudget === null ? null : boundBudget.ceilings.imageTornRecaptures;
    const ceilingExceeded =
      (durationCeilingMs !== null && elapsedMs > durationCeilingMs) ||
      (evidenceByteCeiling !== null && derivedEvidenceBytes > evidenceByteCeiling) ||
      (imageTornCeiling !== null && derivedImageTorn > imageTornCeiling);
    // The provisional/final joins, exact prefix/suffix, single terminal and clock
    // integrity must all hold before any derivation is trusted.
    if (
      provisionalInvalid ||
      (!v2Run && cursor !== records.length - 1) ||
      records.filter((record) => record.event.type === 'run-assessed').length !== 1 ||
      canonicalize(terminal.unstartedOrders) !== canonicalize(unstarted) ||
      terminal.timingFailureCode !== undefined ||
      elapsedMs < slotElapsedTotal
    )
      return { ok: false, code: 'LEDGER_INVALID' };
    // Mirrors the runtime state precedence: an observed ceiling crossing with no
    // stronger integrity/clock stop is a non-creditable BUDGET_TERMINATED, over
    // any remaining-slot suffix; otherwise a started-but-unfinished or failed run
    // is INTERRUPTED/NON_CREDITABLE and credit requires a complete all-PASS run.
    const state: ReleaseRunStateV2 =
      ceilingExceeded && !integrityStop
        ? 'BUDGET_TERMINATED'
        : integrityStop || completed < slots.length
          ? 'INTERRUPTED'
          : allPass && completed === slots.length
            ? 'COMPLETE_ALL_PASS'
            : 'NON_CREDITABLE';
    // Budget-gated credit exists only for a bound V2 record whose exact policy
    // and measurement-set raw bytes are independently corroborated by the
    // production budget authority at readback. The persisted credit flag is
    // consistency data only and is never trusted; V1 chains remain readable
    // history but are never counted as budget-authorized credit.
    const complete =
      state === 'COMPLETE_ALL_PASS' &&
      outcomes.length === slots.length &&
      outcomes.every((item) => item.outcome === 'PASS');
    const credit = complete && budgetAuthorityBound;
    const budgetAuthority: ReleaseBudgetAuthorityV1 = budgetAuthorityBound
      ? 'ROOT_BOUND'
      : 'NON_AUTHORITATIVE';
    if (
      terminal.state !== state ||
      terminal.releaseCreditGranted !== credit ||
      d.collectSourceDigest() !== qualified.verified.sourceProvenanceDigest
    )
      return { ok: false, code: 'LEDGER_INVALID' };
    return {
      ok: true,
      value: {
        runId,
        manifestId: frozen.manifest.manifestId,
        manifestFingerprint: frozen.manifest.contentFingerprint,
        state,
        releaseCreditGranted: credit,
        budgetAuthority,
        budgetRederivation: {
          state,
          elapsedMs,
          durationCeilingMs,
          evidenceByteCount: derivedEvidenceBytes,
          evidenceByteCeiling,
          imageTornRecaptures: derivedImageTorn,
          imageTornCeiling,
          ceilingExceeded,
          credit,
          budgetAuthority,
        },
        workCount: slots.length,
        outcomes,
        exclusions: frozen.manifest.content.exclusions,
        lostObligationsByBinding: lostObligations(frozen.manifest),
      },
    };
  } catch {
    return { ok: false, code: 'LEDGER_INVALID' };
  }
}

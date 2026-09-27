/**
 * Private/deprecated legacy composite check mirror (ADR 0032 §E3-S1). It is
 * retained only so this Oracle module compiles until the E3-S2 architecture
 * switch consumes the additive `primitiveFacts` below. It is deliberately
 * declared locally (never imported from `contracts/execution`) so the Oracle no
 * longer reaches the legacy boolean result authority, and it is never the source
 * of a final status.
 *
 * @deprecated E3-S2 removes the legacy composite authority entirely.
 */
interface LegacyCompositeCheck {
  readonly checkId: string;
  readonly passed: boolean;
}
import {
  createDiagnostic,
  type DiagnosticCode,
  type DiagnosticRecord,
} from '../contracts/diagnostics';
import {
  CROSSWORD_EXECUTION_ROLES,
  CROSSWORD_REQUIRED_CHECKS,
  crosswordWordsAreAuthoritative,
  validateCrosswordExecutionSet,
  type CrosswordExecutionRole,
  type CrosswordObservationFindingCode,
  type CrosswordRequiredCheck,
  type ValidatedCrosswordExecution,
} from '../contracts/crossword-observation';
import { rasterRegionAgreesWithTarget } from '../contracts/raster';
import {
  compareCrosswordExecutions,
  type CrosswordThreeChildComparison,
} from '../contracts/crossword';

/**
 * Generated-Crossword determinism Oracle (ADR 0017 R4–R8; ADR 0018 CR9).
 *
 * `crossword-determinism-v1` evaluates exactly six required authoritative checks
 * over an accepted three-child execution set (A1, A2, B) and the governed
 * fixed-wall-clock profile. It is a pure predicate: it reads typed, validated
 * fields only, recomputes each semantic digest from the accepted generated
 * layout, and never parses an opaque fingerprint or stores an expected layout.
 *
 * Check semantics:
 *
 * 1. `crossword.created` — every child proves active-host `0 → 1`, exactly one
 *    new target, and history advancement.
 * 2. `crossword.seed-derived` — the actual product seed equals the expected
 *    release epoch for each child.
 * 3. `crossword.semantic-valid` — every child has the exact ordered NFC defaults
 *    placed with no omissions and a valid complete layout.
 * 4. `crossword.same-seed-repeatable` — A1/A2 share a seed and produce the same
 *    semantic digest over pairwise-distinct fresh documents.
 * 5. `crossword.different-seed-sensitive` — A1/B keep the same words but produce
 *    a different seed and semantic digest at the accepted generator fingerprint.
 * 6. `crossword.raster-current` — every child has coherent ready mounted-node
 *    exact-target generated-vector raster authority.
 *
 * A valid-evidence failure of checks 2, 4, 5, or 6 is a product determinism
 * defect (`BUG`); a malformed, missing, duplicated, non-current, drifting, or
 * unusable-authority observation is unusable harness authority
 * (`HARNESS_BLOCKED`).
 */

export const CROSSWORD_ORACLE_PROFILE_ID = 'crossword-determinism-v1';
export const CROSSWORD_ORACLE_PROFILE_VERSION = 1;

export { CROSSWORD_REQUIRED_CHECKS };

export interface CrosswordOracleInput {
  clock: unknown;
  sourceFingerprintExpected: string;
  executions: readonly unknown[];
}

/**
 * Closed explicit authority vocabulary for the additive primitive observations
 * (ADR 0029 §4 B2-B). `current` means the accepted three-child execution set and
 * governed clock were readable and internally consistent; `malformed` means the
 * Oracle could not read them. This is the only authority a B2-B4 adapter may
 * read; the legacy aggregate harness-validity flag is deliberately not part of
 * this view.
 */
export const CROSSWORD_PRIMITIVE_AUTHORITIES = ['current', 'malformed'] as const;
export type CrosswordPrimitiveAuthority = (typeof CROSSWORD_PRIMITIVE_AUTHORITIES)[number];

/** The six accepted required checks the additive primitives describe. */
export type CrosswordPrimitiveCheckId = CrosswordRequiredCheck;

/** One explicit per-check predicate derived from the raw child observations. */
export interface CrosswordPrimitiveCheckFact {
  readonly checkId: CrosswordPrimitiveCheckId;
  readonly predicateMet: boolean;
}

/**
 * Raw accepted three-child comparison primitives (ADR 0029 §4 B2-B): the A1/A2
 * same-seed repeat identity, the A1/B seed-sensitivity control, the A1/B
 * different-seed collision, and fresh-document distinctness. Every field is a
 * primitive derived from the raw children; none is a legacy check result.
 */
export interface CrosswordPrimitiveComparisonFacts {
  readonly sameSeedPair: boolean;
  readonly differentSeedPair: boolean;
  readonly repeatIdentical: boolean;
  readonly seedSensitivity: boolean;
  readonly collision: boolean;
  readonly wordsEqualAcrossChildren: boolean;
  readonly distinctDocuments: boolean;
}

/**
 * Additive, explicitly named primitive Crossword-evaluation facts (ADR 0029 §4
 * B2-B). They expose an explicit structured authority, the independent
 * governed-clock/source-agreement primitive, the raw accepted child-comparison
 * (repeat / seed-sensitivity / collision), governed clock, currentness, and
 * raster primitives, and one explicit predicate per accepted required check. No
 * field here is a legacy composite boolean check result.
 */
export interface CrosswordPrimitiveFacts {
  readonly authority: CrosswordPrimitiveAuthority;
  readonly sourceAgreement: boolean;
  /** Raw A1/A2 repeat and A1/B sensitivity/collision comparison primitives. */
  readonly comparison: CrosswordPrimitiveComparisonFacts | null;
  /** The governed fixed-wall clock epochs the accepted children derived. */
  readonly clockEpochs: readonly number[] | null;
  /** Whether every accepted child is a fresh, pairwise-distinct document. */
  readonly currentnessDistinct: boolean;
  /** Whether every accepted child has ready, exact-target raster authority. */
  readonly rasterCurrent: boolean;
  readonly checks: readonly CrosswordPrimitiveCheckFact[];
}

/** The explicit primitive facts of a malformed evaluation: nothing readable. */
function malformedCrosswordPrimitiveFacts(): CrosswordPrimitiveFacts {
  return {
    authority: 'malformed',
    sourceAgreement: false,
    comparison: null,
    clockEpochs: null,
    currentnessDistinct: false,
    rasterCurrent: false,
    checks: CROSSWORD_REQUIRED_CHECKS.map((checkId) => ({ checkId, predicateMet: false })),
  };
}

export interface CrosswordOracleEvaluation {
  checks: readonly LegacyCompositeCheck[];
  /**
   * Check-specific evidence id map (ADR 0017 R14; ADR 0018 CR9). Each required
   * check names exactly the accepted observation/semantic/raster ids it
   * consumed: every child for a per-child check, A1+A2 for the same-seed
   * repeat, and A1+B for the different-seed sensitivity control. A failed or
   * unusable evaluation carries empty arrays, never a generic substitute.
   */
  evidence: Readonly<Record<CrosswordRequiredCheck, readonly string[]>>;
  requiredSourcesAgree: boolean;
  harnessInvalid: boolean;
  diagnostics: readonly DiagnosticRecord[];
  comparison: CrosswordThreeChildComparison | null;
  /** Accepted per-child results, present only when the set is usable. */
  executions: readonly ValidatedCrosswordExecution[];
  /**
   * Additive primitive facts for the inactive B2-B4 live-fact adapter. The
   * legacy `checks`/`harnessInvalid` fields above remain for the active runtime
   * until the B2-E cutover; the adapter reads only this view and the raw child,
   * clock, and source observations.
   */
  primitiveFacts: CrosswordPrimitiveFacts;
}

function emptyEvidence(): Record<CrosswordRequiredCheck, readonly string[]> {
  return Object.fromEntries(
    CROSSWORD_REQUIRED_CHECKS.map((checkId) => [checkId, [] as readonly string[]]),
  ) as Record<CrosswordRequiredCheck, readonly string[]>;
}

function failedChecks(): LegacyCompositeCheck[] {
  return CROSSWORD_REQUIRED_CHECKS.map((checkId) => ({ checkId, passed: false }));
}

/**
 * Builds the exact per-check evidence map from the accepted children. The
 * evidence ids are structural facts of the accepted observations; no check ever
 * borrows another check's authority.
 */
function checkEvidence(
  ordered: readonly ValidatedCrosswordExecution[],
  a1: ValidatedCrosswordExecution,
  a2: ValidatedCrosswordExecution,
  b: ValidatedCrosswordExecution,
): Record<CrosswordRequiredCheck, readonly string[]> {
  const observation = (child: ValidatedCrosswordExecution): string =>
    `observation:${child.observationId}`;
  const semantic = (child: ValidatedCrosswordExecution): string =>
    `semantic:${child.semanticDigest}`;
  const raster = (child: ValidatedCrosswordExecution): string =>
    `raster:${child.raster.rasterFingerprint}`;
  return {
    'crossword.created': ordered.map(observation),
    'crossword.seed-derived': ordered.map(observation),
    'crossword.semantic-valid': ordered.map(semantic),
    'crossword.same-seed-repeatable': [observation(a1), observation(a2)],
    'crossword.different-seed-sensitive': [observation(a1), observation(b)],
    'crossword.raster-current': ordered.map(raster),
  };
}

function diagnosticForFinding(
  code: CrosswordObservationFindingCode,
  detail: string,
  context: Readonly<Record<string, string>>,
): DiagnosticRecord {
  return createDiagnostic(code as DiagnosticCode, detail, { context });
}

function byRole(
  executions: readonly ValidatedCrosswordExecution[],
): Readonly<Record<CrosswordExecutionRole, ValidatedCrosswordExecution>> {
  const map = new Map(executions.map((child) => [child.executionRole, child]));
  return Object.fromEntries(
    CROSSWORD_EXECUTION_ROLES.map((role) => [role, map.get(role)]),
  ) as unknown as Readonly<Record<CrosswordExecutionRole, ValidatedCrosswordExecution>>;
}

function sameWordOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((word, index) => word === right[index]);
}

/**
 * Evaluates the six required checks. Every failure is reported with its own
 * precise diagnostic; no check is silently rescued by another.
 */
export function evaluateCrosswordOracle(input: CrosswordOracleInput): CrosswordOracleEvaluation {
  const validation = validateCrosswordExecutionSet({
    clock: input.clock,
    sourceFingerprintExpected: input.sourceFingerprintExpected,
    executions: input.executions,
  });

  if (!validation.ok) {
    return {
      checks: failedChecks(),
      evidence: emptyEvidence(),
      requiredSourcesAgree: false,
      harnessInvalid: true,
      diagnostics: validation.findings.map((entry) =>
        diagnosticForFinding(entry.code, entry.detail, entry.context),
      ),
      comparison: null,
      executions: [],
      primitiveFacts: malformedCrosswordPrimitiveFacts(),
    };
  }

  const { set } = validation;
  const roles = byRole(set.executions);
  const ordered = CROSSWORD_EXECUTION_ROLES.map((role) => roles[role]);

  const sourceCurrent = ordered.every(
    (child) => child.sourceContractFingerprint === set.sourceFingerprintExpected,
  );
  // The validator has already proven the causal transition facts and the
  // generated-vector raster tuple for every accepted child; this check is their
  // aggregate authority.
  const created = ordered.every(
    (child) =>
      child.transition.preActionHostCrosswordCount === 0 &&
      child.transition.postActionHostCrosswordCount === 1 &&
      child.transition.newTargetCount === 1 &&
      child.transition.historyPastDepthAfter > child.transition.historyPastDepthBefore,
  );
  // The expected seed is the materialized governed clock profile epoch for the
  // child's role, never a hard-coded release epoch: a diagnostic collision
  // profile legitimately declares a different B baseline and must still satisfy
  // `crossword.seed-derived` (ADR 0018 CR9).
  const seedDerived = ordered.every((child, index) => child.actualSeed === set.clock.epochs[index]);
  const semanticValid = ordered.every((child) => crosswordWordsAreAuthoritative(child));
  const rasterCurrent = ordered.every((child) => {
    if (child.raster.status !== 'ready' || child.raster.region === null) return false;
    return rasterRegionAgreesWithTarget({
      region: child.raster.region,
      target: child.targetGeometry,
    }).agrees;
  });

  const a1 = roles.A1;
  const a2 = roles.A2;
  const b = roles.B;
  const sameSeedRepeatable =
    a1.actualSeed === a2.actualSeed &&
    sameWordOrder(a1.words, a2.words) &&
    a1.semanticDigest === a2.semanticDigest &&
    a1.currentness.documentId !== a2.currentness.documentId;
  const differentSeedSensitive =
    sameWordOrder(a1.words, b.words) &&
    a1.actualSeed !== b.actualSeed &&
    a1.semanticDigest !== b.semanticDigest;

  const comparison = compareCrosswordExecutions({
    a1: { words: a1.words, seed: a1.actualSeed, semanticDigest: a1.semanticDigest },
    a2: { words: a2.words, seed: a2.actualSeed, semanticDigest: a2.semanticDigest },
    b: { words: b.words, seed: b.actualSeed, semanticDigest: b.semanticDigest },
  });

  const harnessInvalid = !sourceCurrent;

  const diagnostics: DiagnosticRecord[] = [];
  if (!sourceCurrent) {
    diagnostics.push(
      createDiagnostic(
        'CROSSWORD_SOURCE_DRIFT',
        'At least one generated child carries a source-contract fingerprint other than the accepted one; the materialization no longer binds the accepted product revision.',
      ),
    );
  }
  if (!seedDerived) {
    diagnostics.push(
      createDiagnostic(
        'PRODUCT_CROSSWORD_SEED_MISMATCH',
        'At least one child product generationSeed does not equal the exact expected release epoch.',
      ),
    );
  }
  if (!semanticValid) {
    diagnostics.push(
      createDiagnostic(
        'PRODUCT_CROSSWORD_WORDS_INVALID',
        'At least one generated child does not declare the exact ordered default word set with every word placed.',
      ),
    );
  }
  if (!sameSeedRepeatable) {
    diagnostics.push(
      createDiagnostic(
        'PRODUCT_CROSSWORD_REPEAT_MISMATCH',
        'A1 and A2 share a clock baseline but produced different semantic digests or reused a document; same-seed generation is not reproducible on fresh executions.',
      ),
    );
  }
  if (!differentSeedSensitive) {
    diagnostics.push(
      createDiagnostic(
        'PRODUCT_CROSSWORD_SEED_INSENSITIVE',
        'The B child uses a different clock baseline but produced the same semantic digest as A1; different-seed generation is not sensitive at the accepted generator fingerprint.',
      ),
    );
  }
  if (!rasterCurrent) {
    diagnostics.push(
      createDiagnostic(
        'PRODUCT_CROSSWORD_RASTER_INVALID',
        'At least one child lacks ready generated-vector raster authority for the exact created target.',
      ),
    );
  }

  return {
    checks: [
      { checkId: 'crossword.created', passed: created },
      { checkId: 'crossword.seed-derived', passed: seedDerived },
      { checkId: 'crossword.semantic-valid', passed: semanticValid },
      { checkId: 'crossword.same-seed-repeatable', passed: sameSeedRepeatable },
      { checkId: 'crossword.different-seed-sensitive', passed: differentSeedSensitive },
      { checkId: 'crossword.raster-current', passed: rasterCurrent },
    ],
    evidence: checkEvidence(ordered, a1, a2, b),
    requiredSourcesAgree: sourceCurrent,
    harnessInvalid,
    diagnostics,
    comparison,
    executions: set.executions,
    primitiveFacts: {
      authority: 'current',
      sourceAgreement: sourceCurrent,
      comparison: {
        sameSeedPair: a1.actualSeed === a2.actualSeed,
        differentSeedPair: a1.actualSeed !== b.actualSeed,
        repeatIdentical:
          sameWordOrder(a1.words, a2.words) && a1.semanticDigest === a2.semanticDigest,
        seedSensitivity:
          sameWordOrder(a1.words, b.words) &&
          a1.actualSeed !== b.actualSeed &&
          a1.semanticDigest !== b.semanticDigest,
        collision:
          sameWordOrder(a1.words, b.words) &&
          a1.actualSeed !== b.actualSeed &&
          a1.semanticDigest === b.semanticDigest,
        wordsEqualAcrossChildren: sameWordOrder(a1.words, b.words),
        distinctDocuments: a1.currentness.documentId !== a2.currentness.documentId,
      },
      clockEpochs: [...set.clock.epochs],
      currentnessDistinct:
        a1.currentness.documentId !== a2.currentness.documentId &&
        a1.currentness.documentId !== b.currentness.documentId &&
        a2.currentness.documentId !== b.currentness.documentId,
      rasterCurrent,
      checks: [
        { checkId: 'crossword.created', predicateMet: created },
        { checkId: 'crossword.seed-derived', predicateMet: seedDerived },
        { checkId: 'crossword.semantic-valid', predicateMet: semanticValid },
        { checkId: 'crossword.same-seed-repeatable', predicateMet: sameSeedRepeatable },
        { checkId: 'crossword.different-seed-sensitive', predicateMet: differentSeedSensitive },
        { checkId: 'crossword.raster-current', predicateMet: rasterCurrent },
      ],
    },
  };
}

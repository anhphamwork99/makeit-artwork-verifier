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
import { createDiagnostic, type DiagnosticRecord } from '../contracts/diagnostics';
import {
  RESTORE_REQUIRED_CHECKS,
  RESTORE_ORACLE_PROFILE_ID,
  restoreMeaningSatisfied,
  restoreRawSemanticSatisfied,
  restoreTransitionSatisfied,
  type RestoreMeaningFactView,
  type RestoreOracleFacts,
  type RestoreRawSemanticFactView,
  type RestoreTransitionFactView,
} from '../contracts/restore-observation';
import { ORACLE_PROFILE_SCHEMA_VERSION } from '../contracts/schema-versions';

/**
 * Frontend serialize/restore Oracle (ADR 0019 R5–R7; design §6.3).
 *
 * The Oracle consumes only the accepted facts the restore drive captured. It is
 * pure: it evaluates the two binding required checks (`serialize.roundtrip`,
 * `serialize.raw-semantic`) and never decides product `BUG` versus harness
 * block — that classification belongs to the drive, which knows whether the
 * Save/route/restore chain was safely completed. A check that cannot be
 * evaluated because the accepted evidence is incomplete is reported as
 * harness-invalid, never silently passed.
 */

export const RESTORE_ORACLE_PROFILE_VERSION = 1;

/**
 * Closed explicit authority vocabulary for the additive primitive observations
 * (ADR 0029 §4 B2-B). `current` means the accepted whole-document round trip
 * was readable and internally consistent; `malformed` means the Oracle could
 * not read it. This is the only authority a B2-B5 adapter may read; the legacy
 * aggregate harness-validity flag is deliberately not part of this view.
 */
export const RESTORE_PRIMITIVE_AUTHORITIES = ['current', 'malformed'] as const;
export type RestorePrimitiveAuthority = (typeof RESTORE_PRIMITIVE_AUTHORITIES)[number];

/** One explicit per-check predicate derived from the raw accepted restore facts. */
export interface RestorePrimitiveCheckFact {
  readonly checkId: string;
  readonly predicateMet: boolean;
}

/**
 * Additive, explicitly named primitive frontend serialize/restore facts (ADR
 * 0029 §4 B2-B). They expose an explicit structured authority, the independent
 * source/restored-document correlation primitive, the raw accepted transition,
 * normalized-meaning, and raw-semantics views, and one explicit predicate per
 * accepted required check. No field here is a legacy composite boolean check
 * result, an aggregate harness-validity flag, or a final status.
 */
export interface RestorePrimitiveFacts {
  readonly authority: RestorePrimitiveAuthority;
  readonly schemaVersion: number;
  /**
   * The independent raw source/restored correlation primitive: the round trip
   * really resolved a distinct restored document and both serialized sides
   * carry a concrete normalized-meaning identity. It never encodes whether the
   * product meaning matched.
   */
  readonly sourceAgreement: boolean;
  readonly transition: RestoreTransitionFactView | null;
  readonly meaning: RestoreMeaningFactView | null;
  readonly rawSemantics: RestoreRawSemanticFactView | null;
  readonly checks: readonly RestorePrimitiveCheckFact[];
}

/** The explicit primitive facts of a malformed evaluation: nothing readable. */
function malformedRestorePrimitiveFacts(requiredChecks: readonly string[]): RestorePrimitiveFacts {
  return {
    authority: 'malformed',
    schemaVersion: 0,
    sourceAgreement: false,
    transition: null,
    meaning: null,
    rawSemantics: null,
    checks: requiredChecks.map((checkId) => ({ checkId, predicateMet: false })),
  };
}

export interface RestoreOracleEvaluation {
  checks: readonly LegacyCompositeCheck[];
  passed: boolean;
  harnessInvalid: boolean;
  diagnostics: readonly DiagnosticRecord[];
  /**
   * Additive primitive facts for the inactive B2-B5 live-fact adapter. The
   * legacy `checks`/`passed`/`harnessInvalid` fields above remain for the
   * active runtime until the B2-E cutover; the adapter reads only this view.
   */
  primitiveFacts: RestorePrimitiveFacts;
}

/**
 * Evaluates the two closed restore checks. `harnessInvalid` is set only when
 * the accepted facts cannot support a trustworthy decision (a malformed fact
 * shape or a required-check list that is not the closed pair). A well-formed
 * but wrong transition/meaning/raw-semantics is a check failure the drive
 * classifies as a product `BUG`.
 */
export function evaluateRestoreOracle(
  facts: RestoreOracleFacts,
  requiredChecks: readonly string[] = RESTORE_REQUIRED_CHECKS,
): RestoreOracleEvaluation {
  const diagnostics: DiagnosticRecord[] = [];
  if (facts.schemaVersion !== 1) {
    return {
      checks: [...requiredChecks].sort().map((checkId) => ({ checkId, passed: false })),
      passed: false,
      harnessInvalid: true,
      diagnostics: [
        createDiagnostic(
          'NORMALIZED_MEANING_SCHEMA_UNSUPPORTED',
          `Restore Oracle facts declare schema ${String(facts.schemaVersion)}, not 1.`,
        ),
      ],
      primitiveFacts: malformedRestorePrimitiveFacts(requiredChecks),
    };
  }

  const transitionOk = restoreTransitionSatisfied(facts.transition);
  const meaningOk = restoreMeaningSatisfied(facts.meaning);
  const rawOk = restoreRawSemanticSatisfied(facts.rawSemantics);

  if (!transitionOk) {
    diagnostics.push(
      createDiagnostic(
        'RESTORE_DOCUMENT_TRANSITION_MISSING',
        'The Save → exact POST → redirect → exact GET → new document restore chain was not fully observed after the action epoch.',
      ),
    );
  }
  if (!meaningOk) {
    diagnostics.push(
      createDiagnostic(
        'RESTORE_MEANING_MISMATCH',
        facts.meaning.persistenceLossDetected
          ? 'The restored document lost included product meaning across the frontend round trip (persistence loss detected).'
          : 'The restored document normalized meaning does not structurally equal the source meaning.',
      ),
    );
  }
  if (!rawOk) {
    diagnostics.push(
      createDiagnostic(
        'RESTORE_RAW_SEMANTIC_MISMATCH',
        'The raw persisted Crossword/config/server-metadata checks did not all hold against the guarded raw payload and restored snapshot.',
      ),
    );
  }

  const byId: Record<string, boolean> = {
    // The normalized round trip requires the complete restore transition and the
    // exact normalized meaning; transition facts alone are insufficient.
    'serialize.roundtrip': transitionOk && meaningOk,
    // The raw semantic/config/exclusion checks are evaluated separately and can
    // never be inferred from normalized equality.
    'serialize.raw-semantic': rawOk,
  };
  const checks: LegacyCompositeCheck[] = [...requiredChecks]
    .sort()
    .map((checkId) => ({ checkId, passed: byId[checkId] ?? false }));

  // The raw source/restored correlation primitive: the round trip resolved a
  // genuinely distinct restored document and both serialized sides carry a
  // concrete normalized-meaning identity. It never encodes whether the product
  // meaning matched; that is the checks' own predicate.
  const sourceAgreement =
    facts.transition.documentIdentityDistinct === true &&
    facts.meaning.sourceFingerprint !== null &&
    facts.meaning.restoredFingerprint !== null;

  const primitiveFacts: RestorePrimitiveFacts = {
    authority: 'current',
    schemaVersion: facts.schemaVersion,
    sourceAgreement,
    transition: { ...facts.transition },
    meaning: { ...facts.meaning },
    rawSemantics: { ...facts.rawSemantics, words: [...facts.rawSemantics.words] },
    checks: [...requiredChecks]
      .sort()
      .map((checkId) => ({ checkId, predicateMet: byId[checkId] ?? false })),
  };

  return {
    checks,
    passed: checks.every((check) => check.passed),
    harnessInvalid: false,
    diagnostics,
    primitiveFacts,
  };
}

export const RESTORE_ORACLE_PROFILE = Object.freeze({
  schemaVersion: ORACLE_PROFILE_SCHEMA_VERSION,
  profileId: RESTORE_ORACLE_PROFILE_ID,
  version: RESTORE_ORACLE_PROFILE_VERSION,
});

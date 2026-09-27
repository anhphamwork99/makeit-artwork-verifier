import { createDiagnostic, type DiagnosticRecord } from '../contracts/diagnostics';
import type { StampedGeometryView } from '../readiness/coherent-capture';
import {
  evaluateGeometryDeltaOracle,
  findCanonicalPosition,
  renderedTransformPosition,
  type GeometryDeltaOracleResult,
  type MinimumDelta,
} from './geometry';
import { ORACLE_PROFILE_SCHEMA_VERSION } from '../contracts/schema-versions';
import {
  evaluateWarpedTextOracle,
  WARPED_TEXT_ORACLE_PROFILE_ID,
  type WarpedGeometrySource,
  type WarpedOracleEvaluation,
} from './warped-text';
import {
  evaluateNestedObjectOracle,
  NESTED_OBJECT_ORACLE_PROFILE_ID,
  type NestedObjectOracleFacts,
} from './nested-object';
import type { NestedObjectGeometryV3 } from '../contracts/geometry-v3';

/**
 * Required-check Oracle evaluation (specification 11; WP5 Slice 5-A).
 *
 * The Oracle consumes only an *accepted* coherent observation. A required check
 * that cannot be evaluated from the accepted sources is `UNUSABLE` and blocks as
 * harness-invalid evidence; it is never converted into a product `BUG`. Source
 * disagreement is reported separately so `classifyOutcome` can treat it as a
 * product defect without a source rescuing another.
 */

export interface OracleTarget {
  role: string;
  elementId: string;
}

export interface OracleGeometrySource {
  layoutItems: unknown;
  geometry: Readonly<Record<string, StampedGeometryView>>;
}

export interface OracleEvaluationInput {
  requiredChecks: readonly string[];
  targets: readonly OracleTarget[];
  minimumDelta: MinimumDelta;
  baseline: OracleGeometrySource;
  observed: OracleGeometrySource;
  /**
   * Present for the warped Text circle-envelope profile (WP5 Slice 5-B). When
   * set, the `geometry.delta` and `geometry.warp-envelope` checks are evaluated
   * by the typed `warped-text-circle-move-v1` profile instead of the ordinary
   * 5-A delta profile.
   */
  warpedTarget?: {
    targetId: string;
    expectedLayoutId: string;
    baseline: WarpedGeometrySource;
    observed: WarpedGeometrySource;
  };
  /**
   * Present for the nested-object affine profile (WP5 Slice 5-D). When set, all
   * four required checks are evaluated by the typed `nested-object-move-v1`
   * profile from the accepted paired geometry-v3 records.
   */
  nestedTarget?: NestedOracleContext;
}

/** Accepted paired geometry-v3 authority for the nested-object profile. */
export interface NestedOracleContext {
  targetId: string;
  witnessId: string;
  layoutId: string;
  requestedPointerDeltaCss: { x: number; y: number };
  baseline: { geometry: NestedObjectGeometryV3; layoutItems: unknown };
  observed: { geometry: NestedObjectGeometryV3; layoutItems: unknown };
}

/**
 * Private/deprecated legacy composite check mirror (ADR 0032 §E3-S1). It is
 * retained only so the pre-cutover `runActionCycle`/executor callers still
 * compile until the E3-S2 architecture switch consumes the additive primitive
 * facts below. It is deliberately declared locally (never imported from
 * `contracts/execution`) so this Oracle dispatcher no longer reaches the legacy
 * boolean result authority, and it is never the source of a final status.
 *
 * @deprecated E3-S2 removes the legacy composite authority entirely.
 */
export interface OracleLegacyCompositeCheck {
  readonly checkId: string;
  readonly passed: boolean;
}

/** One explicitly named primitive predicate per required check (ADR 0029 §4). */
export interface OraclePrimitiveCheckFact {
  readonly checkId: string;
  readonly predicateMet: boolean;
}

/**
 * The additive primitive observation facts of a required-check evaluation. They
 * are derived from the family Oracle's own raw observations (never from a
 * legacy `passed` boolean, the composite check set, or `harnessInvalid`) and are
 * the only Oracle output the accepted B2 live-fact adapters consume.
 */
export interface OraclePrimitiveFacts {
  readonly authority: 'current' | 'malformed';
  readonly sourcesAgree: boolean;
  readonly checks: readonly OraclePrimitiveCheckFact[];
}

export interface OracleEvaluation {
  /**
   * @deprecated Private/deprecated legacy composite mirror retained for staging
   * compile until E3-S2. Never used to derive a final status.
   */
  checks: readonly OracleLegacyCompositeCheck[];
  /**
   * @deprecated Legacy aggregate source-agreement flag retained for staging
   * compile until E3-S2. The additive {@link OracleEvaluation.primitiveFacts}
   * `sourcesAgree` is the authoritative primitive.
   */
  requiredSourcesAgree: boolean;
  /**
   * @deprecated Legacy aggregate harness-validity side channel retained for
   * staging compile until E3-S2. Not part of the primitive-fact authority.
   */
  harnessInvalid: boolean;
  diagnostics: readonly DiagnosticRecord[];
  geometry: GeometryDeltaOracleResult | null;
  /** Set only for the typed warped Text circle-envelope profile. */
  warped: WarpedOracleEvaluation | null;
  /** Set only for the typed nested-object affine profile. */
  nested: NestedObjectOracleFacts | null;
  /**
   * The additive primitive observation facts of this evaluation (ADR 0032
   * §E3-S1). This is the exposed producer surface the accepted B2 live-fact
   * adapters consume; it never reads the deprecated composite fields above.
   */
  primitiveFacts: OraclePrimitiveFacts;
}

/**
 * The explicit `malformed` primitive facts for a dispatch that could not produce
 * a readable evaluation: no source agreement and no check predicate met.
 */
function malformedOraclePrimitiveFacts(requiredChecks: readonly string[]): OraclePrimitiveFacts {
  return {
    authority: 'malformed',
    sourcesAgree: false,
    checks: [...requiredChecks].sort().map((checkId) => ({ checkId, predicateMet: false })),
  };
}

function isMinimumDelta(value: unknown): value is MinimumDelta {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.x === 'number' &&
    Number.isFinite(record.x) &&
    typeof record.y === 'number' &&
    Number.isFinite(record.y)
  );
}

/** Reads `expected.minimumDelta` from a closed Case Intent expectation record. */
export function readMinimumDelta(expected: Readonly<Record<string, unknown>>): MinimumDelta | null {
  const candidate = expected.minimumDelta;
  return isMinimumDelta(candidate) ? { x: candidate.x, y: candidate.y } : null;
}

function nestedRequiredChecks(input: OracleEvaluationInput): OracleEvaluation {
  const context = input.nestedTarget;
  if (!context) {
    return {
      checks: [],
      requiredSourcesAgree: false,
      harnessInvalid: true,
      diagnostics: [],
      geometry: null,
      warped: null,
      nested: null,
      primitiveFacts: malformedOraclePrimitiveFacts(input.requiredChecks),
    };
  }
  const evaluation = evaluateNestedObjectOracle({
    minimumDelta: input.minimumDelta,
    targetId: context.targetId,
    witnessId: context.witnessId,
    layoutId: context.layoutId,
    requestedPointerDeltaCss: context.requestedPointerDeltaCss,
    baseline: context.baseline,
    observed: context.observed,
  });
  const byId = new Map(evaluation.checks.map((check) => [check.checkId, check]));
  const checks = [...input.requiredChecks]
    .sort()
    .map((checkId) => ({ checkId, passed: byId.get(checkId)?.passed ?? false }));
  return {
    checks,
    requiredSourcesAgree: evaluation.requiredSourcesAgree,
    harnessInvalid: evaluation.harnessInvalid,
    diagnostics: evaluation.diagnostics,
    geometry: null,
    warped: null,
    nested: evaluation.facts,
    primitiveFacts: {
      authority: evaluation.primitiveFacts.authority,
      sourcesAgree: evaluation.primitiveFacts.sourcesAgree,
      checks: evaluation.primitiveFacts.checks.map((check) => ({
        checkId: check.checkId,
        predicateMet: check.predicateMet,
      })),
    },
  };
}

function warpedRequiredChecks(input: OracleEvaluationInput): OracleEvaluation {
  const context = input.warpedTarget;
  if (!context) {
    return {
      checks: [],
      requiredSourcesAgree: false,
      harnessInvalid: true,
      diagnostics: [],
      geometry: null,
      warped: null,
      nested: null,
      primitiveFacts: malformedOraclePrimitiveFacts(input.requiredChecks),
    };
  }
  const evaluation = evaluateWarpedTextOracle({
    minimumDelta: input.minimumDelta,
    targetId: context.targetId,
    expectedLayoutId: context.expectedLayoutId,
    baseline: context.baseline,
    observed: context.observed,
  });
  const byId = new Map(evaluation.checks.map((check) => [check.checkId, check]));
  const checks = [...input.requiredChecks].sort().map((checkId) => ({
    checkId,
    passed: byId.get(checkId)?.passed ?? false,
  }));
  return {
    checks,
    requiredSourcesAgree: evaluation.requiredSourcesAgree,
    harnessInvalid: evaluation.harnessInvalid,
    diagnostics: evaluation.diagnostics,
    geometry: null,
    warped: evaluation,
    nested: null,
    primitiveFacts: {
      authority: evaluation.primitiveFacts.authority,
      sourcesAgree:
        evaluation.primitiveFacts.canonicalSourcesAgree &&
        evaluation.primitiveFacts.rendererSourcesAgree,
      checks: evaluation.primitiveFacts.checks.map((check) => ({
        checkId: check.checkId,
        predicateMet: check.predicateMet,
      })),
    },
  };
}

export function evaluateRequiredChecks(input: OracleEvaluationInput): OracleEvaluation {
  const diagnostics: DiagnosticRecord[] = [];
  const checks: OracleLegacyCompositeCheck[] = [];
  let requiredSourcesAgree = true;
  let harnessInvalid = false;
  let geometry: GeometryDeltaOracleResult | null = null;

  if (!isMinimumDelta(input.minimumDelta)) {
    return {
      checks: [],
      requiredSourcesAgree: false,
      harnessInvalid: true,
      diagnostics: [
        createDiagnostic(
          'UNUSABLE_EVIDENCE',
          'The case expectation does not declare a finite minimumDelta { x, y }.',
        ),
      ],
      geometry: null,
      warped: null,
      nested: null,
      primitiveFacts: malformedOraclePrimitiveFacts(input.requiredChecks),
    };
  }

  if (input.nestedTarget) {
    return nestedRequiredChecks(input);
  }

  if (input.warpedTarget) {
    return warpedRequiredChecks(input);
  }

  for (const checkId of [...input.requiredChecks].sort()) {
    if (checkId !== 'geometry.delta') {
      checks.push({ checkId, passed: false });
      harnessInvalid = true;
      diagnostics.push(
        createDiagnostic(
          'UNUSABLE_EVIDENCE',
          `Required check "${checkId}" has no delivered Oracle profile; trustworthy evidence cannot be produced.`,
          { context: { checkId } },
        ),
      );
      continue;
    }

    const target = input.targets[0];
    if (!target) {
      checks.push({ checkId, passed: false });
      harnessInvalid = true;
      diagnostics.push(
        createDiagnostic('UNUSABLE_EVIDENCE', 'geometry.delta requires one resolved target.'),
      );
      continue;
    }

    geometry = evaluateGeometryDeltaOracle({
      minimumDelta: input.minimumDelta,
      canonicalBefore: findCanonicalPosition(input.baseline.layoutItems, target.elementId),
      canonicalAfter: findCanonicalPosition(input.observed.layoutItems, target.elementId),
      renderedBefore: renderedTransformPosition(
        input.baseline.geometry[target.elementId],
        target.elementId,
      ),
      renderedAfter: renderedTransformPosition(
        input.observed.geometry[target.elementId],
        target.elementId,
      ),
    });

    if (geometry.status === 'UNUSABLE') {
      checks.push({ checkId, passed: false });
      harnessInvalid = true;
      diagnostics.push(
        createDiagnostic('UNUSABLE_EVIDENCE', geometry.detail, { context: { checkId } }),
      );
      continue;
    }

    checks.push({ checkId, passed: geometry.passed });
    if (!geometry.sourcesAgree) {
      requiredSourcesAgree = false;
      diagnostics.push(
        createDiagnostic('ORACLE_SOURCE_DISAGREEMENT', geometry.detail, { context: { checkId } }),
      );
    }
  }

  return {
    checks,
    requiredSourcesAgree,
    harnessInvalid,
    diagnostics,
    geometry,
    warped: null,
    nested: null,
    primitiveFacts: primitiveFactsFromGeometry(geometry, input.requiredChecks),
  };
}

/**
 * Projects the ordinary `geometry.delta` result into the additive primitive
 * facts. The per-check predicate is the explicitly named conjunction of the
 * Oracle's own `canonicalMet`/`renderedMet`/`sourcesAgree` observations, never
 * the composite `passed` boolean.
 */
function primitiveFactsFromGeometry(
  geometry: GeometryDeltaOracleResult | null,
  requiredChecks: readonly string[],
): OraclePrimitiveFacts {
  if (geometry === null || geometry.status === 'UNUSABLE') {
    return malformedOraclePrimitiveFacts(requiredChecks);
  }
  const predicateMet = geometry.canonicalMet && geometry.renderedMet && geometry.sourcesAgree;
  return {
    authority: 'current',
    sourcesAgree: geometry.sourcesAgree,
    checks: [{ checkId: geometry.checkId, predicateMet }],
  };
}

export const ORACLE_PROFILE = Object.freeze({
  schemaVersion: ORACLE_PROFILE_SCHEMA_VERSION,
  profileId: 'geometry-delta-v1',
});

export const WARPED_ORACLE_PROFILE_ID = WARPED_TEXT_ORACLE_PROFILE_ID;
export const NESTED_ORACLE_PROFILE_ID = NESTED_OBJECT_ORACLE_PROFILE_ID;

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  compileResolvedCorrectnessProfile,
  deriveResolvedCorrectnessProfileFingerprint,
  evaluateGeometryDeltaOracle,
  evaluateOrdinaryTextChecks,
  evaluateWarpedTextChecks,
  isFullCanonicalFingerprint,
  loadCorrectnessCatalogue,
  projectCorrectnessProfileIdentity,
  resolveRouteSelection,
  textKernelKindForEvaluator,
  validateResultIdentityAgreement,
} from '../../src/index';
import type {
  ActionCycleCorrectnessIdentity,
  CorrectnessCheckResult,
  CorrectnessProfileIdentityView,
  OrdinaryTextDeltaFact,
  OrdinaryTextKernelFacts,
  ResolvedCorrectnessProfile,
  TextEvidenceAvailability,
  TextEvidenceFact,
  TextKernelIssueCode,
  TextKernelResult,
  WarpedTextCheckFact,
  WarpedTextKernelFacts,
} from '../../src/index';
import type { WarpedOracleEvaluation } from '../../src/oracles/warped-text';
import {
  projectOrdinaryTextLiveFact,
  projectWarpedTextLiveFacts,
} from '../../src/adapters/text-live-facts';
import { CHECK_RESULT_CONTRACT_SCHEMA_VERSION } from '../../src/contracts/schema-versions';

/**
 * P7-B B1-B inactive compiled-profile Text kernel tests (ADR 0028 §3 B1-B).
 *
 * The kernels are pure and inactive: they are never reached from an active
 * executor, Oracle, classifier, or writer. These tests drive them directly,
 * including with real accepted ordinary-Text Oracle results, and independently
 * re-validate every produced check with the B1-A compiled-profile/result
 * agreement validator.
 */

const catalogue = loadCorrectnessCatalogue();
const ORDINARY_ROUTE = { subjectId: 'layer/text', capability: 'move' as const, variant: 'plain' };
const WARPED_ROUTE = {
  subjectId: 'layer/text',
  capability: 'move' as const,
  variant: 'warp-circle',
};

function compile(route: typeof ORDINARY_ROUTE | typeof WARPED_ROUTE): ResolvedCorrectnessProfile {
  const selection = resolveRouteSelection(catalogue, route);
  if (selection === null) throw new Error(`missing route selection for ${route.variant}`);
  const compiled = compileResolvedCorrectnessProfile({
    catalogue,
    selection,
    declaredChecks: ['geometry.delta'],
  });
  if (!compiled.ok) throw new Error(`route ${route.variant} failed to compile`);
  return compiled.profile;
}

const ordinary = compile(ORDINARY_ROUTE);
const warped = compile(WARPED_ROUTE);
const ordinaryIdentity = projectCorrectnessProfileIdentity(ordinary);
const warpedIdentity = projectCorrectnessProfileIdentity(warped);

function cycle(
  profile: ResolvedCorrectnessProfile,
  id = 'action-cycle-1',
): ActionCycleCorrectnessIdentity {
  return {
    schemaVersion: CHECK_RESULT_CONTRACT_SCHEMA_VERSION,
    actionCycleId: id,
    resolvedProfileFingerprint: profile.resolvedFingerprint,
    readinessFingerprint: profile.componentFingerprints.readiness,
  };
}

function evidenceAll(
  profile: ResolvedCorrectnessProfile,
  overrides: Readonly<Record<string, TextEvidenceAvailability>> = {},
): TextEvidenceFact[] {
  return profile.requiredAuthoritativeEvidence.map((evidenceId) => ({
    evidenceId,
    availability: overrides[evidenceId] ?? 'authoritative',
  }));
}

function codes(result: TextKernelResult): TextKernelIssueCode[] {
  return result.issues.map((entry) => entry.code);
}

function agreement(
  identity: CorrectnessProfileIdentityView,
  aCycle: ActionCycleCorrectnessIdentity,
  checks: readonly CorrectnessCheckResult[],
) {
  return validateResultIdentityAgreement(identity, {
    actionCycles: [aCycle],
    requiredChecks: checks,
  });
}

type OrdinaryOracleInput = Parameters<typeof evaluateGeometryDeltaOracle>[0];

const ORDINARY_ORACLE_INPUT: OrdinaryOracleInput = {
  minimumDelta: { x: 40, y: 20 },
  canonicalBefore: { x: 100, y: 100 },
  canonicalAfter: { x: 150, y: 130 },
  renderedBefore: { x: 100, y: 100 },
  renderedAfter: { x: 150, y: 130 },
};

/**
 * Builds the structured ordinary-Text fact exactly as the inactive live-fact
 * adapter does, from a real accepted `geometry.delta` Oracle result.
 */
function ordinaryCheck(overrides: Partial<OrdinaryOracleInput> = {}): OrdinaryTextDeltaFact {
  return projectOrdinaryTextLiveFact(
    evaluateGeometryDeltaOracle({ ...ORDINARY_ORACLE_INPUT, ...overrides }),
  );
}

const WARPED_DELTA = {
  canonicalDelta: { x: 80, y: 40 },
  canonicalMet: true,
  expectedRendererDelta: { x: 80, y: 40 },
  maxPointAxisDeviation: 0,
  rendererDeltaPerPoint: [
    { x: 80, y: 40 },
    { x: 80, y: 40 },
    { x: 80, y: 40 },
    { x: 80, y: 40 },
  ],
};

const WARPED_ENVELOPE = {
  baselineFingerprint: 'baseline-envelope',
  observedFingerprint: 'observed-envelope',
  maxCanonicalDeviation: 0,
  maxRenderedDeviation: 0,
};

/** Builds the explicit structured warped-Text check facts from the additive primitive facts. */
function warpedChecks(
  overrides: {
    predicateMet?: boolean;
    authority?: 'current' | 'malformed';
    canonicalSourcesAgree?: boolean;
    rendererSourcesAgree?: boolean;
    checks?: readonly { readonly checkId: string; readonly predicateMet: boolean }[];
  } = {},
): WarpedTextCheckFact[] {
  return projectWarpedTextLiveFacts({
    profileId: warped.oracle.oracleProfileId,
    primitiveFacts: {
      authority: overrides.authority ?? 'current',
      canonicalSourcesAgree: overrides.canonicalSourcesAgree ?? true,
      rendererSourcesAgree: overrides.rendererSourcesAgree ?? true,
      checks:
        overrides.checks ??
        warped.requiredChecks.map((entry) => ({
          checkId: entry.checkId,
          predicateMet: overrides.predicateMet ?? true,
        })),
    },
    delta: WARPED_DELTA,
    envelope: WARPED_ENVELOPE,
  });
}

function ordinaryFacts(overrides: Partial<OrdinaryTextKernelFacts> = {}): OrdinaryTextKernelFacts {
  return {
    evaluator: 'canonical-delta',
    minimumDelta: { x: 40, y: 20 },
    check: ordinaryCheck(),
    evidence: evidenceAll(ordinary),
    ...overrides,
  };
}

function warpedFacts(overrides: Partial<WarpedTextKernelFacts> = {}): WarpedTextKernelFacts {
  return {
    evaluator: 'typed-envelope',
    minimumDelta: { x: 40, y: 20 },
    checks: warpedChecks(),
    delta: WARPED_DELTA,
    envelope: WARPED_ENVELOPE,
    evidence: evidenceAll(warped),
    ...overrides,
  };
}

function runOrdinary(
  facts: OrdinaryTextKernelFacts,
  profile: ResolvedCorrectnessProfile = ordinary,
): TextKernelResult {
  return evaluateOrdinaryTextChecks({
    profile,
    route: ORDINARY_ROUTE,
    actionCycle: cycle(profile),
    facts,
  });
}

function runWarped(
  facts: WarpedTextKernelFacts,
  profile: ResolvedCorrectnessProfile = warped,
): TextKernelResult {
  return evaluateWarpedTextChecks({
    profile,
    route: WARPED_ROUTE,
    actionCycle: cycle(profile),
    facts,
  });
}

describe('[P7-B B1-B] ordinary Text kernel', () => {
  it('produces a complete PASS check from real accepted geometry.delta facts', () => {
    const result = runOrdinary(ordinaryFacts());
    expect(result.ok).toBe(true);
    expect(result.kind).toBe('text-ordinary');
    expect(result.checks).toHaveLength(1);
    const check = result.checks[0] as CorrectnessCheckResult;
    const contract = ordinary.requiredChecks[0] as (typeof ordinary.requiredChecks)[number];
    expect(check.status).toBe('PASS');
    expect(check.checkId).toBe(contract.checkId);
    expect(check.schemaVersion).toBe(CHECK_RESULT_CONTRACT_SCHEMA_VERSION);
    expect(check.evidenceIds).toEqual([...contract.requiredEvidence].sort());
    expect(check.toleranceRefs).toEqual([...contract.toleranceRefs].sort());
    expect(check.visualRefs).toEqual([]);
    expect(check.normalizationRef).toBeNull();
    expect(check.actionCycleRef).toBe('action-cycle-1');
    expect(check.consumedComponentFingerprints).toEqual({
      resolvedProfile: ordinary.resolvedFingerprint,
      requiredCheckSet: ordinary.componentFingerprints.requiredCheckSet,
      oracle: ordinary.componentFingerprints.oracle,
      capture: ordinary.componentFingerprints.capture,
      tolerances: ordinary.componentFingerprints.tolerances,
      visuals: ordinary.componentFingerprints.visuals,
      normalization: ordinary.componentFingerprints.normalization,
    });
    expect(check.expected.schema).toBe(contract.expectedSchema);
    expect(check.expected.minimumDelta).toEqual({ x: 40, y: 20 });
    expect(check.actual.schema).toBe(contract.actualSchema);
    expect(check.actual.authority).toBe('current');
    expect(check.actual.canonicalDelta).toEqual({ x: 50, y: 30 });
    expect(check.actual.renderedDelta).toEqual({ x: 50, y: 30 });
    expect(check.actual.sourcesAgree).toBe(true);
    expect(agreement(ordinaryIdentity, cycle(ordinary), result.checks).ok).toBe(true);
  });

  it('produces a FAIL for a trustworthy product mismatch', () => {
    const facts = ordinaryFacts({
      check: ordinaryCheck({
        canonicalAfter: { x: 110, y: 105 },
        renderedAfter: { x: 110, y: 105 },
      }),
    });
    const result = runOrdinary(facts);
    expect(result.ok).toBe(true);
    expect(result.checks[0]?.status).toBe('FAIL');
    expect(result.checks[0]?.actual.authority).toBe('current');
    // A trustworthy mismatch still consumed its complete required evidence.
    expect(result.checks[0]?.evidenceIds).toEqual(
      [...(ordinary.requiredChecks[0]?.requiredEvidence ?? [])].sort(),
    );
    expect(agreement(ordinaryIdentity, cycle(ordinary), result.checks).ok).toBe(true);
  });

  it('produces UNUSABLE rather than FAIL when required authority is torn', () => {
    const facts = ordinaryFacts({
      check: ordinaryCheck({
        renderedAfter: null,
      }),
      evidence: evidenceAll(ordinary, { 'geometry.renderer': 'torn' }),
    });
    const result = runOrdinary(facts);
    expect(result.ok).toBe(true);
    expect(result.checks[0]?.status).toBe('UNUSABLE');
    expect(result.checks[0]?.actual.authority).toBe('torn');
    expect(result.checks[0]?.evidenceIds).not.toContain('geometry.renderer');
    expect(agreement(ordinaryIdentity, cycle(ordinary), result.checks).ok).toBe(true);
  });

  it('produces UNUSABLE when the accepted evaluator produced no fact at all', () => {
    const result = runOrdinary(ordinaryFacts({ check: null }));
    expect(result.ok).toBe(true);
    expect(result.checks[0]?.status).toBe('UNUSABLE');
    expect(result.checks[0]?.actual.authority).toBe('missing');
  });

  it('never lets diagnostic-only evidence rescue a required check', () => {
    const facts = ordinaryFacts({
      evidence: [
        { evidenceId: 'geometry.canonical', availability: 'missing' },
        { evidenceId: 'geometry.renderer', availability: 'authoritative' },
        { evidenceId: 'observation', availability: 'authoritative' },
        { evidenceId: 'screenshot.diagnostic', availability: 'diagnostic-only' },
        { evidenceId: 'obstruction.diagnostic', availability: 'diagnostic-only' },
      ],
    });
    const result = runOrdinary(facts);
    expect(result.ok).toBe(true);
    expect(result.checks[0]?.status).toBe('UNUSABLE');
    expect(result.checks[0]?.evidenceIds).not.toContain('screenshot.diagnostic');
    expect(result.checks[0]?.evidenceIds).not.toContain('obstruction.diagnostic');
    expect(result.checks[0]?.evidenceIds).toEqual(['geometry.renderer', 'observation']);
    expect(agreement(ordinaryIdentity, cycle(ordinary), result.checks).ok).toBe(true);
  });

  it('reports a diagnostic-only item declared for required authority', () => {
    const result = runOrdinary(
      ordinaryFacts({
        evidence: evidenceAll(ordinary, { 'geometry.canonical': 'diagnostic-only' }),
      }),
    );
    expect(codes(result)).toContain('TEXT_KERNEL_EVIDENCE_DIAGNOSTIC_ONLY');
    expect(result.checks[0]?.status).toBe('UNUSABLE');
  });

  it('reports undeclared evidence that claims authority without consuming it', () => {
    const result = runOrdinary(
      ordinaryFacts({
        evidence: [
          ...evidenceAll(ordinary),
          { evidenceId: 'geometry.secret', availability: 'authoritative' },
        ],
      }),
    );
    expect(codes(result)).toContain('TEXT_KERNEL_EVIDENCE_UNDECLARED');
    expect(result.checks[0]?.evidenceIds).not.toContain('geometry.secret');
  });
});

describe('[P7-B B1-B] circle-warped Text kernel', () => {
  it('produces a complete PASS result for both declared checks', () => {
    const result = runWarped(warpedFacts());
    expect(result.ok).toBe(true);
    expect(result.kind).toBe('text-warped');
    expect(result.checks).toHaveLength(2);
    for (const check of result.checks) {
      expect(check.status).toBe('PASS');
      expect(check.actionCycleRef).toBe('action-cycle-1');
      expect(check.consumedComponentFingerprints.oracle).toBe(warped.componentFingerprints.oracle);
      expect(check.normalizationRef).toBeNull();
    }
    expect(result.checks.map((check) => check.checkId)).toEqual([
      'geometry.delta',
      'geometry.warp-envelope',
    ]);
    expect(agreement(warpedIdentity, cycle(warped), result.checks).ok).toBe(true);
  });

  it('maps a trustworthy per-check mismatch to FAIL and preserves source disagreement', () => {
    const result = runWarped(
      warpedFacts({
        checks: warpedChecks({ predicateMet: false, canonicalSourcesAgree: false }),
        delta: {
          canonicalDelta: { x: 80, y: 40 },
          canonicalMet: true,
          expectedRendererDelta: { x: 80, y: 40 },
          maxPointAxisDeviation: 0.6,
          rendererDeltaPerPoint: null,
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.checks.map((check) => check.status)).toEqual(['FAIL', 'FAIL']);
    expect(result.checks[0]?.actual.sourcesAgree).toBe(false);
    expect(result.checks[0]?.actual.authority).toBe('current');
    expect(agreement(warpedIdentity, cycle(warped), result.checks).ok).toBe(true);
  });

  it('maps a malformed observation authority to UNUSABLE, never FAIL', () => {
    const result = runWarped(
      warpedFacts({ checks: warpedChecks({ authority: 'malformed', predicateMet: false }) }),
    );
    expect(result.ok).toBe(true);
    expect(result.checks.map((check) => check.status)).toEqual(['UNUSABLE', 'UNUSABLE']);
    expect(result.checks[0]?.actual.authority).toBe('malformed');
    expect(result.checks[0]?.actual.mismatch).toBe(false);
  });

  it('produces UNUSABLE when a declared check has no accepted evaluator fact', () => {
    const result = runWarped(
      warpedFacts({
        checks: warpedChecks({ checks: [{ checkId: 'geometry.delta', predicateMet: true }] }),
      }),
    );
    expect(result.ok).toBe(true);
    expect(codes(result)).toContain('TEXT_KERNEL_FACT_CHECK_MISSING');
    const envelope = result.checks.find((check) => check.checkId === 'geometry.warp-envelope');
    expect(envelope?.status).toBe('UNUSABLE');
  });

  it('rejects an accepted fact for an undeclared check without consuming it', () => {
    const result = runWarped(
      warpedFacts({
        checks: [
          ...warpedChecks(),
          ...warpedChecks({ checks: [{ checkId: 'geometry.unknown', predicateMet: true }] }),
        ],
      }),
    );
    expect(codes(result)).toContain('TEXT_KERNEL_FACT_CHECK_UNKNOWN');
    expect(result.checks.map((check) => check.checkId)).toEqual([
      'geometry.delta',
      'geometry.warp-envelope',
    ]);
  });

  it('produces UNUSABLE when required typed-envelope evidence is stale', () => {
    const result = runWarped(
      warpedFacts({ evidence: evidenceAll(warped, { 'geometry.typed-envelope': 'stale' }) }),
    );
    expect(result.ok).toBe(true);
    expect(result.checks.map((check) => check.status)).toEqual(['UNUSABLE', 'UNUSABLE']);
    for (const check of result.checks) {
      expect(check.evidenceIds).not.toContain('geometry.typed-envelope');
      expect(check.actual.authority).toBe('stale');
    }
  });

  it('consumes structured live facts projected from the delivered WarpedOracleEvaluation additive primitive facts', () => {
    const accepted: Pick<WarpedOracleEvaluation, 'primitiveFacts' | 'delta' | 'envelope'> = {
      primitiveFacts: {
        authority: 'current',
        canonicalSourcesAgree: true,
        rendererSourcesAgree: true,
        measured: {
          canonicalDelta: { x: 1, y: 2 },
          minimumDelta: { x: 1, y: 2 },
          maxPointAxisDeviation: 0,
          maxCanonicalDeviation: 0,
          maxRenderedDeviation: 0,
          envelopeFailures: [],
        },
        tolerances: { canonical: 1e-6, renderer: 0.25 },
        checks: [
          { checkId: 'geometry.delta', predicateMet: true },
          { checkId: 'geometry.warp-envelope', predicateMet: true },
        ],
      },
      delta: {
        canonicalDelta: { x: 1, y: 2 },
        canonicalMet: true,
        expectedRendererDelta: { x: 1, y: 2 },
        maxPointAxisDeviation: 0,
        rendererDeltaPerPoint: [{ x: 1, y: 2 }],
      },
      envelope: {
        baselineFingerprint: 'b',
        observedFingerprint: 'o',
        maxCanonicalDeviation: 0,
        maxRenderedDeviation: 0,
      },
    };
    const facts: WarpedTextKernelFacts = {
      evaluator: 'typed-envelope',
      minimumDelta: { x: 1, y: 2 },
      checks: projectWarpedTextLiveFacts({
        profileId: warped.oracle.oracleProfileId,
        ...accepted,
      }),
      delta: accepted.delta,
      envelope: accepted.envelope,
      evidence: evidenceAll(warped),
    };
    expect(runWarped(facts).checks.every((check) => check.status === 'PASS')).toBe(true);
  });
});

describe('[P7-B B1-B] compiled-profile identity agreement', () => {
  it('rejects a profile for a different route without fabricating checks', () => {
    const result = evaluateOrdinaryTextChecks({
      profile: ordinary,
      route: WARPED_ROUTE,
      actionCycle: cycle(ordinary),
      facts: ordinaryFacts(),
    });
    expect(result.ok).toBe(false);
    expect(result.checks).toEqual([]);
    expect(codes(result)).toContain('TEXT_KERNEL_ROUTE_MISMATCH');
  });

  it('rejects an Action Cycle that observed a different resolved profile', () => {
    const result = evaluateOrdinaryTextChecks({
      profile: ordinary,
      route: ORDINARY_ROUTE,
      actionCycle: { ...cycle(ordinary), resolvedProfileFingerprint: 'a'.repeat(64) },
      facts: ordinaryFacts(),
    });
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('TEXT_KERNEL_ACTION_CYCLE_MISMATCH');
  });

  it('rejects an Action Cycle readiness disagreement', () => {
    const result = evaluateOrdinaryTextChecks({
      profile: ordinary,
      route: ORDINARY_ROUTE,
      actionCycle: { ...cycle(ordinary), readinessFingerprint: 'b'.repeat(64) },
      facts: ordinaryFacts(),
    });
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('TEXT_KERNEL_READINESS_MISMATCH');
  });

  it('rejects a compiled profile whose content was mutated in place', () => {
    const tampered = structuredClone(ordinary) as unknown as Record<string, unknown>;
    (tampered.readiness as Record<string, unknown>).stableFrames = 99;
    const result = evaluateOrdinaryTextChecks({
      profile: tampered as unknown as ResolvedCorrectnessProfile,
      route: ORDINARY_ROUTE,
      actionCycle: cycle(ordinary),
      facts: ordinaryFacts(),
    });
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('TEXT_KERNEL_PROFILE_FINGERPRINT_MISMATCH');
  });

  it('rejects a non-canonical resolved fingerprint', () => {
    const tampered = structuredClone(ordinary) as unknown as Record<string, unknown>;
    tampered.resolvedFingerprint = 'deadbeef';
    const result = evaluateOrdinaryTextChecks({
      profile: tampered as unknown as ResolvedCorrectnessProfile,
      route: ORDINARY_ROUTE,
      actionCycle: cycle(ordinary),
      facts: ordinaryFacts(),
    });
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('TEXT_KERNEL_PROFILE_FINGERPRINT_INVALID');
  });

  it('rejects an invalid component fingerprint', () => {
    const tampered = structuredClone(ordinary) as unknown as Record<string, unknown>;
    (tampered.componentFingerprints as Record<string, unknown>).oracle = 'not-a-fingerprint';
    const result = evaluateOrdinaryTextChecks({
      profile: tampered as unknown as ResolvedCorrectnessProfile,
      route: ORDINARY_ROUTE,
      actionCycle: cycle(ordinary),
      facts: ordinaryFacts(),
    });
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('TEXT_KERNEL_COMPONENT_FINGERPRINT_INVALID');
  });

  it('emits consumed component fingerprints that a disagreeing compiled identity cannot match', () => {
    // A profile that is internally consistent but whose Oracle component was
    // swapped: the kernel trusts its own profile, and the B1-A agreement
    // validator independently detects the disagreement with the real identity.
    const swapped = structuredClone(ordinary) as unknown as Record<string, unknown>;
    (swapped.componentFingerprints as Record<string, unknown>).oracle = 'c'.repeat(64);
    const { resolvedFingerprint: _drop, ...preimage } = swapped;
    swapped.resolvedFingerprint = deriveResolvedCorrectnessProfileFingerprint(
      preimage as unknown as Omit<ResolvedCorrectnessProfile, 'resolvedFingerprint'>,
    );
    void _drop;
    const profile = swapped as unknown as ResolvedCorrectnessProfile;
    const result = evaluateOrdinaryTextChecks({
      profile,
      route: ORDINARY_ROUTE,
      actionCycle: cycle(profile),
      facts: ordinaryFacts(),
    });
    expect(result.ok).toBe(true);
    const validation = validateResultIdentityAgreement(ordinaryIdentity, {
      actionCycles: [cycle(profile)],
      requiredChecks: result.checks,
    });
    expect(validation.ok).toBe(false);
    expect(validation.issues.map((entry) => entry.code)).toContain(
      'RESULT_CONSUMED_COMPONENT_MISMATCH',
    );
  });
});

describe('[P7-B B1-B] required-check set and evaluator discriminants', () => {
  function tamperedProfile(mutate: (profile: Record<string, unknown>) => void) {
    const clone = structuredClone(ordinary) as unknown as Record<string, unknown>;
    mutate(clone);
    return clone as unknown as ResolvedCorrectnessProfile;
  }

  function runTampered(profile: ResolvedCorrectnessProfile): TextKernelResult {
    return evaluateOrdinaryTextChecks({
      profile,
      route: ORDINARY_ROUTE,
      actionCycle: cycle(profile),
      facts: ordinaryFacts(),
    });
  }

  it('rejects an empty required-check set', () => {
    const result = runTampered(
      tamperedProfile((profile) => {
        profile.requiredChecks = [];
      }),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('TEXT_KERNEL_EMPTY_REQUIRED_CHECKS');
  });

  it('rejects a duplicated declared check', () => {
    const result = runTampered(
      tamperedProfile((profile) => {
        const [check] = profile.requiredChecks as unknown[];
        profile.requiredChecks = [check, check];
      }),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('TEXT_KERNEL_REQUIRED_CHECK_DUPLICATE');
  });

  it('rejects an unsupported per-check evaluator discriminant', () => {
    const result = runTampered(
      tamperedProfile((profile) => {
        const [check] = profile.requiredChecks as Record<string, unknown>[];
        check.evaluator = 'crossword-determinism';
      }),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('TEXT_KERNEL_CHECK_EVALUATOR_UNSUPPORTED');
  });

  it('rejects an unsupported Oracle evaluator discriminant', () => {
    const result = runTampered(
      tamperedProfile((profile) => {
        (profile.oracle as Record<string, unknown>).evaluatorKind = 'frontend-restore';
      }),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('TEXT_KERNEL_ORACLE_EVALUATOR_UNSUPPORTED');
  });

  it('routes each delivered evaluator kind to exactly one Text kernel', () => {
    expect(textKernelKindForEvaluator('geometry-delta')).toBe('text-ordinary');
    expect(textKernelKindForEvaluator('warped-text-envelope')).toBe('text-warped');
    expect(textKernelKindForEvaluator('frontend-restore')).toBeNull();
    expect(textKernelKindForEvaluator(undefined)).toBeNull();
  });
});

describe('[P7-B B1-B] relevant compiled-field mutation matrix', () => {
  function collectLeafPaths(value: unknown, prefix: string, out: string[]): void {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        collectLeafPaths(entry, prefix === '' ? `[${index}]` : `${prefix}[${index}]`, out);
      });
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        collectLeafPaths(child, prefix === '' ? key : `${prefix}.${key}`, out);
      }
      return;
    }
    out.push(prefix);
  }

  function mutateLeaf(root: Record<string, unknown>, path: string): void {
    const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
    let node: unknown = root;
    for (let index = 0; index < parts.length - 1; index += 1) {
      node = (node as Record<string, unknown>)[parts[index] as string];
    }
    const leaf = (node as Record<string, unknown>)[parts[parts.length - 1] as string];
    let replacement: unknown = 'mutated';
    if (typeof leaf === 'string') replacement = `${leaf}-mutated`;
    else if (typeof leaf === 'number') replacement = leaf + 1;
    else if (typeof leaf === 'boolean') replacement = !leaf;
    (node as Record<string, unknown>)[parts[parts.length - 1] as string] = replacement;
  }

  const paths = new Set<string>();
  for (const profile of [ordinary, warped]) {
    const collected: string[] = [];
    collectLeafPaths(profile, '', collected);
    for (const path of collected) paths.add(`${profile.variant ?? 'plain'}::${path}`);
  }

  it('covers at least the accepted 68-field semantic projection', () => {
    expect(paths.size).toBeGreaterThanOrEqual(68);
  });

  it('rejects every single-leaf mutation of either compiled Text profile', () => {
    for (const profile of [ordinary, warped]) {
      const route = profile === ordinary ? ORDINARY_ROUTE : WARPED_ROUTE;
      const collected: string[] = [];
      collectLeafPaths(profile, '', collected);
      for (const leafPath of collected) {
        const clone = structuredClone(profile) as unknown as Record<string, unknown>;
        mutateLeaf(clone, leafPath);
        const result =
          route === ORDINARY_ROUTE
            ? evaluateOrdinaryTextChecks({
                profile: clone as unknown as ResolvedCorrectnessProfile,
                route,
                actionCycle: cycle(clone as unknown as ResolvedCorrectnessProfile),
                facts: ordinaryFacts(),
              })
            : evaluateWarpedTextChecks({
                profile: clone as unknown as ResolvedCorrectnessProfile,
                route,
                actionCycle: cycle(clone as unknown as ResolvedCorrectnessProfile),
                facts: warpedFacts(),
              });
        expect(
          result.ok,
          `mutation of ${String(profile.variant)}::${leafPath} was not detected`,
        ).toBe(false);
      }
    }
  });
});

describe('[P7-B B1-B] inactive kernel invariants', () => {
  const skillRoot = path.resolve(process.cwd());
  const source = (relative: string): string => readFileSync(path.join(skillRoot, relative), 'utf8');

  it('does not import any active executor, Oracle, evidence writer, or classifier', () => {
    const kernel = source('src/kernels/text-kernel.ts');
    expect(kernel).not.toMatch(/from '\.\.\/(runtime|oracles|evidence)\//);
    expect(kernel).not.toContain('execute-plan');
    expect(kernel).not.toContain('contracts/execution');
    expect(kernel).not.toContain('outcomes');
  });

  it('is not referenced by any active executor, Oracle, or writer module', () => {
    for (const relative of [
      'src/runtime/execute-plan.ts',
      'src/runtime/action-cycle.ts',
      'src/oracles/evaluate.ts',
      'src/oracles/warped-text.ts',
      'src/evidence/writer.ts',
      'src/evidence/public-dto.ts',
      'src/runtime/outcomes.ts',
    ]) {
      expect(source(relative)).not.toContain('text-kernel');
      expect(source(relative)).not.toContain('evaluateOrdinaryTextChecks');
      expect(source(relative)).not.toContain('evaluateWarpedTextChecks');
    }
  });

  it('leaves the active boolean CheckResult and v3 record schema unchanged', () => {
    expect(source('src/contracts/execution.ts')).toMatch(
      /export interface CheckResult \{\n {2}checkId: string;\n {2}passed: boolean;\n\}/,
    );
    expect(source('src/contracts/schema-versions.ts')).toContain(
      'export const DIAGNOSTIC_RUN_RECORD_SCHEMA_VERSION = 3;',
    );
  });

  it('keeps every produced fingerprint full canonical', () => {
    const result = runWarped(warpedFacts());
    for (const check of result.checks) {
      expect(isFullCanonicalFingerprint(check.consumedComponentFingerprints.resolvedProfile)).toBe(
        true,
      );
      expect(isFullCanonicalFingerprint(check.consumedComponentFingerprints.oracle)).toBe(true);
    }
  });
});

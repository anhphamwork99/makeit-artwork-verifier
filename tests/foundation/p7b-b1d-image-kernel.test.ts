import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadResourceManifest } from '../../src/catalogue/resources';
import { RASTER_PROBE_SET, rasterProbeBackingCoordinate } from '../../src/contracts/raster';
import type { ResourceManifestEntry } from '../../src/contracts/resources';
import { CHECK_RESULT_CONTRACT_SCHEMA_VERSION } from '../../src/contracts/schema-versions';
import {
  evaluateImageOracle,
  type ImageOracleEvaluation,
  type ImageOracleInput,
} from '../../src/oracles/image';
import {
  compileResolvedCorrectnessProfile,
  deriveResolvedCorrectnessProfileFingerprint,
  evaluateImageChecks,
  imageCurrentnessForAuthority,
  imageKernelKindForEvaluator,
  isFullCanonicalFingerprint,
  loadCorrectnessCatalogue,
  projectCorrectnessProfileIdentity,
  resolveRouteSelection,
  validateResultIdentityAgreement,
} from '../../src/index';
import type {
  ActionCycleCorrectnessIdentity,
  CorrectnessCheckResult,
  CorrectnessProfileIdentityView,
  ImageAuthorityState,
  ImageEvaluatorFact,
  ImageEvidenceAvailability,
  ImageEvidenceFact,
  ImageKernelFacts,
  ImageKernelIssueCode,
  ImageKernelResult,
  ImageOracleFactsView,
  ImageReadinessFact,
  ImageReadinessOutcome,
  ResolvedCorrectnessProfile,
} from '../../src/index';

/**
 * P7-B B1-D inactive compiled-profile Image kernel tests (ADR 0028 §3 B1-D).
 *
 * The kernel is pure and inactive: it is never reached from an active executor,
 * Oracle, classifier, or writer. These tests drive it directly — including with
 * real `evaluateImageOracle` results over the exact checked-in resource raster
 * records — and independently re-validate every produced check with the B1-A
 * compiled-profile/result agreement validator.
 */

const manifest = loadResourceManifest();
const A = manifest.resources.find(
  (entry) => entry.logicalId === 'image.upload-a',
) as ResourceManifestEntry;
const B = manifest.resources.find(
  (entry) => entry.logicalId === 'image.upload-b',
) as ResourceManifestEntry;
const TARGET_ID = 'layout-image-a-image-1';
const LAYOUT_ID = 'layout-image-a';
const EXPECTED_FRAME = { x: 90, y: 110, width: 320, height: 240, rotation: 0 };

const ROUTE = {
  subjectId: 'layer/image',
  capability: 'changeProperties' as const,
  variant: 'static',
};

const CHECKS = [
  'image.content-distinct',
  'image.frame-stable',
  'image.raster-current',
  'image.semantic-transition',
  'image.structural-visual',
];

const EVIDENCE_BY_CHECK: Readonly<Record<string, string[]>> = {
  'image.content-distinct': ['image.semantic-baseline', 'image.semantic-observed', 'observation'],
  'image.frame-stable': ['geometry.renderer', 'observation'],
  'image.raster-current': ['observation', 'raster.accepted'],
  'image.semantic-transition': ['image.semantic-baseline', 'image.semantic-observed'],
  'image.structural-visual': ['geometry.canonical', 'observation', 'raster.accepted'],
};

// ── Real accepted-oracle facts ───────────────────────────────────────────────

function layer(src: string | null, overrides: Record<string, unknown> = {}) {
  return {
    id: TARGET_ID,
    xCoordinate: 90,
    yCoordinate: 110,
    width: 320,
    height: 240,
    rotation: 0,
    transform: { flipX: false, flipY: false },
    config: { placeholder: true, ...(src === null ? {} : { testedWithImage: true }) },
    ...(src === null ? {} : { src }),
    zCoordinate: 1,
    ...overrides,
  };
}

function snapshotWith(sourceLayer: Record<string, unknown>) {
  return [
    { id: LAYOUT_ID, xCoordinate: 80, yCoordinate: 60, layers: [sourceLayer] },
    { id: 'layout-image-control', xCoordinate: 660, yCoordinate: 60, layers: [] },
  ];
}

function rasterRecord(
  entry: ResourceManifestEntry,
  opts: { id?: string; rgbaSha?: string; revision?: number } = {},
) {
  const backingWidth = 320;
  const backingHeight = 240;
  const probes = entry.structuralVisual.probes.map((probe) => {
    const backingX = rasterProbeBackingCoordinate(
      backingWidth,
      probe.x.numerator,
      probe.x.denominator,
    );
    const backingY = rasterProbeBackingCoordinate(
      backingHeight,
      probe.y.numerator,
      probe.y.denominator,
    );
    return {
      probeSetId: 'rgba-probes-v1',
      probeId: probe.id,
      x: probe.x,
      y: probe.y,
      backingX,
      backingY,
      rgba: [...probe.expectedRgba],
    };
  });
  return {
    rasterSchemaVersion: 3,
    authorityKind: 'image-source-v2',
    observation: {
      schemaVersion: 1,
      documentId: 'doc',
      documentEpoch: 1,
      bridgeVersion: 7,
      bridgeGeneration: 1,
      revision: opts.revision ?? 5,
    },
    id: opts.id ?? TARGET_ID,
    kind: 'image',
    mounted: true,
    status: 'ready',
    source: {
      scheme: 'blob',
      mimeType: 'image/png',
      byteLength: entry.byteLength,
      sha256: entry.sha256,
      decodedWidth: entry.dimensions.width,
      decodedHeight: entry.dimensions.height,
      sourceFingerprint: `sf-${entry.logicalId}`,
    },
    rendered: {
      nodeClass: 'Image',
      drawnWidth: backingWidth,
      drawnHeight: backingHeight,
      backingWidth,
      backingHeight,
      rgbaByteLength: backingWidth * backingHeight * 4,
      rgbaSha256: opts.rgbaSha ?? `rgba-${entry.logicalId}`,
      nonTransparentPixelCount: backingWidth * backingHeight,
      probes,
    },
    renderer: {
      bridgeGeneration: 1,
      stageFingerprint: 'stage',
      targetFingerprint: 'target',
      target: { id: TARGET_ID, nodeClass: 'Image', x: 90, y: 110 },
    },
    capture: {
      started: {
        schemaVersion: 1,
        documentId: 'doc',
        documentEpoch: 1,
        bridgeVersion: 7,
        bridgeGeneration: 1,
        revision: opts.revision ?? 5,
      },
      completed: {
        schemaVersion: 1,
        documentId: 'doc',
        documentEpoch: 1,
        bridgeVersion: 7,
        bridgeGeneration: 1,
        revision: opts.revision ?? 5,
      },
      sourceStable: true,
      rendererStable: true,
    },
    rasterFingerprint: `rf-${entry.logicalId}`,
  };
}

function expectedResource(entry: ResourceManifestEntry) {
  return {
    logicalId: entry.logicalId,
    version: entry.version,
    sha256: entry.sha256,
    byteLength: entry.byteLength,
    mimeType: entry.mimeType,
    dimensions: entry.dimensions,
    probes: entry.structuralVisual.probes.map((probe) => ({
      id: probe.id,
      x: probe.x,
      y: probe.y,
      expectedRgba: probe.expectedRgba,
      channelTolerance: probe.channelTolerance,
    })),
  };
}

function uploadInput(overrides: Partial<ImageOracleInput> = {}): ImageOracleInput {
  return {
    mode: 'upload',
    targetId: TARGET_ID,
    expectedLayoutId: LAYOUT_ID,
    expectedFrame: EXPECTED_FRAME,
    expectedResource: expectedResource(A),
    acceptedUpload: null,
    baselineSnapshot: snapshotWith(layer(null)),
    observedSnapshot: snapshotWith(layer('blob:http://127.0.0.1/a')),
    raster: rasterRecord(A),
    ...overrides,
  };
}

function replacementInput(overrides: Partial<ImageOracleInput> = {}): ImageOracleInput {
  const accepted = {
    sourceSha256: A.sha256,
    rgbaSha256: `rgba-${A.logicalId}`,
    probes: A.structuralVisual.probes.map((probe) => ({
      probeId: probe.id,
      rgba: probe.expectedRgba,
    })),
  };
  return {
    mode: 'replacement',
    targetId: TARGET_ID,
    expectedLayoutId: LAYOUT_ID,
    expectedFrame: EXPECTED_FRAME,
    expectedResource: expectedResource(B),
    acceptedUpload: accepted,
    baselineSnapshot: snapshotWith(layer('blob:http://127.0.0.1/a')),
    observedSnapshot: snapshotWith(layer('blob:http://127.0.0.1/b')),
    raster: rasterRecord(B),
    ...overrides,
  };
}

// ── Kernel scaffolding ───────────────────────────────────────────────────────

const catalogue = loadCorrectnessCatalogue();

function compile(): ResolvedCorrectnessProfile {
  const selection = resolveRouteSelection(catalogue, ROUTE);
  if (selection === null) throw new Error('missing Image route selection');
  const compiled = compileResolvedCorrectnessProfile({
    catalogue,
    selection,
    declaredChecks: [],
  });
  if (!compiled.ok) throw new Error('Image route failed to compile');
  return compiled.profile;
}

const profile = compile();
const identity = projectCorrectnessProfileIdentity(profile);

function cycle(
  source: ResolvedCorrectnessProfile = profile,
  id = 'action-cycle-image-1',
): ActionCycleCorrectnessIdentity {
  return {
    schemaVersion: CHECK_RESULT_CONTRACT_SCHEMA_VERSION,
    actionCycleId: id,
    resolvedProfileFingerprint: source.resolvedFingerprint,
    readinessFingerprint: source.componentFingerprints.readiness,
  };
}

/** The compiled readiness policy the runtime must have applied. */
function readinessPolicy(overrides: Partial<ImageReadinessFact['policy']> = {}) {
  return {
    profileId: profile.readiness.profileId,
    deadlineCategory: profile.readiness.deadlineCategory,
    deadlineMs: profile.readiness.deadlineMs,
    signalWatchdogMs: profile.readiness.signalWatchdogMs,
    fallbackCadenceMs: [...profile.readiness.fallbackCadenceMs],
    stableFrames: profile.readiness.stableFrames,
    quiescenceRequired: profile.readiness.quiescenceRequired,
    stableFrameRequired: profile.readiness.stableFrameRequired,
    ...overrides,
  };
}

function convergedReadiness(
  overrides: Partial<ImageReadinessFact['observation']> = {},
): ImageReadinessFact {
  return {
    policy: readinessPolicy(),
    observation: {
      outcome: 'converged',
      authority: 'current',
      wakeSource: 'store-signal',
      fallbackPollCount: 0,
      watchdogWaits: 0,
      attempts: 1,
      tornCount: 0,
      mismatches: [],
      detail: 'Live raster matches the expected resource.',
      ...overrides,
    },
  };
}

function evidenceAll(
  source: ResolvedCorrectnessProfile = profile,
  overrides: Readonly<Record<string, ImageEvidenceAvailability>> = {},
): ImageEvidenceFact[] {
  return source.requiredAuthoritativeEvidence.map((evidenceId) => ({
    evidenceId,
    availability: overrides[evidenceId] ?? 'authoritative',
  }));
}

function structuredChecks(evaluation: ImageOracleEvaluation): ImageEvaluatorFact[] {
  const authority: ImageAuthorityState =
    evaluation.primitiveFacts.authority === 'malformed' ? 'malformed' : 'current';
  const sourcesAgree = evaluation.primitiveFacts.sourceAgreement === true;
  return evaluation.primitiveFacts.checks.map((check) => ({
    checkId: check.checkId,
    authority,
    currentness: imageCurrentnessForAuthority(authority),
    sourcesAgree,
    mismatch: authority === 'malformed' ? false : check.predicateMet !== true,
  }));
}

function oracleFactsOf(evaluation: ImageOracleEvaluation): ImageOracleFactsView {
  return {
    authority: evaluation.primitiveFacts.authority,
    sourceAgreement: evaluation.primitiveFacts.sourceAgreement === true,
    checks: evaluation.primitiveFacts.checks.map((check) => ({
      checkId: check.checkId,
      predicateMet: check.predicateMet === true,
    })),
  };
}

function kernelFacts(
  input: ImageOracleInput,
  overrides: Partial<ImageKernelFacts> = {},
): ImageKernelFacts {
  const evaluation = evaluateImageOracle(input);
  return {
    evaluator: 'image-upload-replace',
    mode: input.mode,
    targetId: input.targetId,
    expectedLayoutId: input.expectedLayoutId,
    expectedFrame: input.expectedFrame,
    expectedResource: input.expectedResource,
    acceptedUpload: input.acceptedUpload,
    checks: structuredChecks(evaluation),
    oracleFacts: oracleFactsOf(evaluation),
    diagnostics: evaluation.diagnostics,
    raster: input.raster,
    readiness: convergedReadiness(),
    evidence: evidenceAll(),
    ...overrides,
  };
}

function run(
  facts: ImageKernelFacts,
  source: ResolvedCorrectnessProfile = profile,
): ImageKernelResult {
  return evaluateImageChecks({
    profile: source,
    route: ROUTE,
    actionCycle: cycle(source),
    facts,
  });
}

function codes(result: ImageKernelResult): ImageKernelIssueCode[] {
  return result.issues.map((entry) => entry.code);
}

function statusFor(result: ImageKernelResult, checkId: string): string | undefined {
  return result.checks.find((check) => check.checkId === checkId)?.status;
}

function checkFor(result: ImageKernelResult, checkId: string): CorrectnessCheckResult | undefined {
  return result.checks.find((check) => check.checkId === checkId);
}

function agreement(
  view: CorrectnessProfileIdentityView,
  aCycle: ActionCycleCorrectnessIdentity,
  checks: readonly CorrectnessCheckResult[],
) {
  return validateResultIdentityAgreement(view, { actionCycles: [aCycle], requiredChecks: checks });
}

function replacementFacts(overrides: Partial<ImageKernelFacts> = {}): ImageKernelFacts {
  return kernelFacts(replacementInput(), overrides);
}

describe('[P7-B B1-D] Image kernel positive results', () => {
  it('produces a complete PASS result for every declared Image check from real Oracle facts', () => {
    const evaluation = evaluateImageOracle(replacementInput());
    expect(evaluation.harnessInvalid).toBe(false);
    expect(evaluation.checks.every((check) => check.passed)).toBe(true);

    const result = run(replacementFacts());
    expect(result.ok).toBe(true);
    expect(result.kind).toBe('image-upload-replace');
    expect(result.checks.map((check) => check.checkId)).toEqual(CHECKS);

    for (const check of result.checks) {
      expect(check.status).toBe('PASS');
      expect(check.schemaVersion).toBe(CHECK_RESULT_CONTRACT_SCHEMA_VERSION);
      expect(check.evidenceIds).toEqual(EVIDENCE_BY_CHECK[check.checkId]);
      expect(check.visualRefs).toEqual(
        check.checkId === 'image.structural-visual' ? ['image-structural-visual-v1'] : [],
      );
      expect(check.normalizationRef).toBeNull();
      expect(check.actionCycleRef).toBe('action-cycle-image-1');
      expect(check.consumedComponentFingerprints).toEqual({
        resolvedProfile: profile.resolvedFingerprint,
        requiredCheckSet: profile.componentFingerprints.requiredCheckSet,
        oracle: profile.componentFingerprints.oracle,
        capture: profile.componentFingerprints.capture,
        tolerances: profile.componentFingerprints.tolerances,
        visuals: profile.componentFingerprints.visuals,
        normalization: profile.componentFingerprints.normalization,
      });
      expect(check.actual.authority).toBe('current');
    }
    expect(agreement(identity, cycle(), result.checks).ok).toBe(true);
  });

  it('carries the exact compiled check schemas, tolerances, and references per check', () => {
    const result = run(replacementFacts());
    for (const contract of profile.requiredChecks) {
      const check = checkFor(result, contract.checkId) as CorrectnessCheckResult;
      expect(check.expected.schema).toBe(contract.expectedSchema);
      expect(check.actual.schema).toBe(contract.actualSchema);
      expect(check.toleranceRefs).toEqual([...contract.toleranceRefs].sort());
      expect(check.visualRefs).toEqual([...contract.visualRefs].sort());
      expect(check.normalizationRef).toBe(contract.normalizationRef);
      expect(check.expected.requiredEvidence).toEqual([...contract.requiredEvidence].sort());
    }
  });

  it('publishes the compiled signal-first readiness policy in expected and the observed execution in actual', () => {
    const result = run(replacementFacts());
    const distributed = checkFor(result, 'image.raster-current') as CorrectnessCheckResult;
    expect(distributed.expected.readinessPolicy).toEqual({
      profileId: profile.readiness.profileId,
      deadlineCategory: profile.readiness.deadlineCategory,
      deadlineMs: profile.readiness.deadlineMs,
      signalWatchdogMs: profile.readiness.signalWatchdogMs,
      fallbackCadenceMs: [...profile.readiness.fallbackCadenceMs],
      stableFrames: profile.readiness.stableFrames,
      quiescenceRequired: profile.readiness.quiescenceRequired,
      stableFrameRequired: profile.readiness.stableFrameRequired,
    });
    expect(distributed.actual.readiness).toMatchObject({
      profileId: profile.readiness.profileId,
      outcome: 'converged',
      wakeSource: 'store-signal',
      fallbackPollCount: 0,
      watchdogWaits: 0,
      attempts: 1,
      tornCount: 0,
    });
  });

  it('publishes the accepted source, rendered and resource facts in the raster-current actual', () => {
    const result = run(replacementFacts());
    const check = checkFor(result, 'image.raster-current') as CorrectnessCheckResult;
    expect(check.actual.raster).toMatchObject({
      schemaVersion: 3,
      authorityKind: 'image-source-v2',
      id: TARGET_ID,
      status: 'ready',
      rendererTargetId: TARGET_ID,
    });
    expect(check.actual.source).toMatchObject({
      scheme: 'blob',
      sha256: B.sha256,
      byteLength: B.byteLength,
      mimeType: B.mimeType,
      decodedWidth: B.dimensions.width,
      decodedHeight: B.dimensions.height,
    });
    expect(check.actual.rendered).toMatchObject({
      rgbaSha256: `rgba-${B.logicalId}`,
      backingWidth: 320,
      backingHeight: 240,
      nonTransparentPixelCount: 320 * 240,
      drawnWidth: 320,
      drawnHeight: 240,
    });
    expect((check.actual.rendered as Record<string, unknown>).probeIds).toEqual(
      RASTER_PROBE_SET.map((probe) => probe.id),
    );
    expect(check.expected.expectedResource).toMatchObject({
      logicalId: B.logicalId,
      sha256: B.sha256,
      byteLength: B.byteLength,
      mimeType: B.mimeType,
    });
    expect(check.expected.acceptedUpload).toEqual({
      sourceSha256: A.sha256,
      rgbaSha256: `rgba-${A.logicalId}`,
    });
  });

  it('structurally accepts the delivered ImageOracleEvaluation and raster fact projection', () => {
    const input = replacementInput();
    const evaluation = evaluateImageOracle(input);
    const facts: ImageKernelFacts = {
      evaluator: 'image-upload-replace',
      mode: input.mode,
      targetId: input.targetId,
      expectedLayoutId: input.expectedLayoutId,
      expectedFrame: input.expectedFrame,
      expectedResource: input.expectedResource,
      acceptedUpload: input.acceptedUpload,
      checks: structuredChecks(evaluation),
      oracleFacts: oracleFactsOf(evaluation),
      diagnostics: evaluation.diagnostics,
      raster: input.raster,
      readiness: convergedReadiness(),
      evidence: evidenceAll(),
    };
    expect(Object.hasOwn(facts, 'harnessInvalid')).toBe(false);
    for (const check of facts.checks) {
      expect(Object.hasOwn(check, 'passed')).toBe(false);
      expect(Object.hasOwn(check, 'unusable')).toBe(false);
    }
    expect(run(facts).checks.every((check) => check.status === 'PASS')).toBe(true);
  });

  it('marks the replacement-only distinct check UNUSABLE on the upload Action Cycle', () => {
    const evaluation = evaluateImageOracle(uploadInput());
    expect(evaluation.checks.map((check) => check.checkId)).not.toContain('image.content-distinct');
    const result = run(kernelFacts(uploadInput()));
    expect(result.ok).toBe(true);
    for (const checkId of [
      'image.frame-stable',
      'image.raster-current',
      'image.semantic-transition',
      'image.structural-visual',
    ]) {
      expect(statusFor(result, checkId)).toBe('PASS');
    }
    // The upload cycle carries no accepted distinctness authority; a fabricated
    // pass is never produced.
    expect(statusFor(result, 'image.content-distinct')).toBe('UNUSABLE');
    expect(codes(result)).toContain('IMAGE_KERNEL_FACT_CHECK_MISSING');
  });
});

describe('[P7-B B1-D] trustworthy mismatch / non-convergence maps to FAIL', () => {
  it('fails only raster-current when the page-observed source digest does not equal the resolved resource', () => {
    const input = replacementInput({
      raster: {
        ...rasterRecord(B),
        source: { ...rasterRecord(B).source, sha256: A.sha256 },
      } as never,
    });
    const evaluation = evaluateImageOracle(input);
    expect(evaluation.harnessInvalid).toBe(false);
    const result = run(kernelFacts(input));
    expect(statusFor(result, 'image.raster-current')).toBe('FAIL');
    expect(statusFor(result, 'image.frame-stable')).toBe('PASS');
    expect(statusFor(result, 'image.semantic-transition')).toBe('PASS');
    expect(checkFor(result, 'image.raster-current')?.actual.authority).toBe('current');
    expect(agreement(identity, cycle(), result.checks).ok).toBe(true);
  });

  it('fails only structural-visual when a probe channel is outside the declared tolerance', () => {
    const wrongProbe = rasterRecord(B);
    wrongProbe.rendered.probes[0]!.rgba = [0, 0, 0, 255];
    const input = replacementInput({ raster: wrongProbe as never });
    expect(evaluateImageOracle(input).harnessInvalid).toBe(false);
    const result = run(kernelFacts(input));
    expect(statusFor(result, 'image.structural-visual')).toBe('FAIL');
    expect(statusFor(result, 'image.raster-current')).toBe('PASS');
    expect(statusFor(result, 'image.frame-stable')).toBe('PASS');
    expect(agreement(identity, cycle(), result.checks).ok).toBe(true);
  });

  it('fails only frame-stable when the observed canonical frame drifts', () => {
    const input = replacementInput({
      observedSnapshot: snapshotWith(layer('blob:http://x/b', { height: 241 })),
    });
    const evaluation = evaluateImageOracle(input);
    expect(evaluation.harnessInvalid).toBe(false);
    const result = run(kernelFacts(input));
    expect(statusFor(result, 'image.frame-stable')).toBe('FAIL');
    expect(statusFor(result, 'image.raster-current')).toBe('PASS');
    expect(agreement(identity, cycle(), result.checks).ok).toBe(true);
  });

  it('fails content-distinct when the replacement retains the accepted upload pixels', () => {
    const input = replacementInput({
      raster: {
        ...rasterRecord(B),
        rendered: { ...rasterRecord(B).rendered, rgbaSha256: `rgba-${A.logicalId}` },
      } as never,
    });
    const evaluation = evaluateImageOracle(input);
    expect(evaluation.harnessInvalid).toBe(false);
    const result = run(kernelFacts(input));
    expect(statusFor(result, 'image.content-distinct')).toBe('FAIL');
    expect(statusFor(result, 'image.semantic-transition')).toBe('PASS');
    expect(checkFor(result, 'image.content-distinct')?.actual.authority).toBe('current');
  });

  it('maps a trustworthy raster non-convergence at the one deadline to FAIL for every check', () => {
    const result = run(
      kernelFacts(replacementInput(), {
        readiness: convergedReadiness({
          outcome: 'deadline-exceeded',
          wakeSource: 'poll-fallback',
          fallbackPollCount: 4,
          watchdogWaits: 1,
          attempts: 5,
          mismatches: ['rendered.drawnWidth', 'source.sha256'],
          detail: 'Never converged to the expected replacement resource.',
        }),
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.checks.every((check) => check.status === 'FAIL')).toBe(true);
    for (const check of result.checks) {
      expect(check.actual.authority).toBe('current');
    }
    const current = checkFor(result, 'image.raster-current') as CorrectnessCheckResult;
    expect(current.actual.readiness).toMatchObject({
      outcome: 'deadline-exceeded',
      wakeSource: 'poll-fallback',
      fallbackPollCount: 4,
      watchdogWaits: 1,
      attempts: 5,
    });
    expect(agreement(identity, cycle(), result.checks).ok).toBe(true);
  });

  it('never lets a passing semantic transition rescue a failed raster check', () => {
    const input = replacementInput({
      raster: {
        ...rasterRecord(B),
        rendered: { ...rasterRecord(B).rendered, nonTransparentPixelCount: 0 },
      } as never,
    });
    const evaluation = evaluateImageOracle(input);
    expect(evaluation.harnessInvalid).toBe(false);
    const result = run(kernelFacts(input));
    expect(statusFor(result, 'image.raster-current')).toBe('FAIL');
    expect(statusFor(result, 'image.semantic-transition')).toBe('PASS');
  });
});

describe('[P7-B B1-D] missing/stale/torn/wrong-target/malformed raster authority maps to UNUSABLE', () => {
  function verifyUnusable(result: ImageKernelResult, authority: ImageAuthorityState): void {
    expect(result.ok).toBe(true);
    expect(result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    for (const check of result.checks) {
      expect(check.actual.authority).toBe(authority);
    }
  }

  it('is UNUSABLE for every check when no live raster was accepted', () => {
    const input = replacementInput({ raster: null });
    const evaluation = evaluateImageOracle(input);
    expect(evaluation.harnessInvalid).toBe(true);
    const result = run(kernelFacts(input));
    verifyUnusable(result, 'missing');
    expect(codes(result)).toContain('IMAGE_KERNEL_RASTER_AUTHORITY_UNUSABLE');
  });

  it('is UNUSABLE for a torn raster record', () => {
    const input = replacementInput({
      raster: { ...rasterRecord(B), status: 'torn', reason: 'observation-changed' } as never,
    });
    const result = run(kernelFacts(input));
    verifyUnusable(result, 'torn');
    expect(codes(result)).toContain('IMAGE_KERNEL_RASTER_AUTHORITY_UNUSABLE');
  });

  it('is UNUSABLE for a pending (stale) raster record', () => {
    const input = replacementInput({ raster: { ...rasterRecord(B), status: 'pending' } as never });
    const result = run(kernelFacts(input));
    verifyUnusable(result, 'stale');
  });

  it('is UNUSABLE for a wrong-target raster record', () => {
    const input = replacementInput({ raster: rasterRecord(B, { id: 'other-target' }) as never });
    const evaluation = evaluateImageOracle(input);
    expect(evaluation.harnessInvalid).toBe(true);
    const result = run(kernelFacts(input));
    verifyUnusable(result, 'wrong-target');
  });

  it('is UNUSABLE for a malformed raster record missing its authority discriminant', () => {
    const { authorityKind: _omitted, ...withoutAuthorityKind } = rasterRecord(B);
    void _omitted;
    const input = replacementInput({ raster: withoutAuthorityKind as never });
    const result = run(kernelFacts(input));
    verifyUnusable(result, 'malformed');
  });

  it('is UNUSABLE for a non-blob source authority', () => {
    const input = replacementInput({
      raster: {
        ...rasterRecord(B),
        source: { ...rasterRecord(B).source, scheme: 'data' },
      } as never,
    });
    const result = run(kernelFacts(input));
    verifyUnusable(result, 'missing');
  });

  it('is UNUSABLE for a torn acquisition capture even when ready', () => {
    const input = replacementInput({
      raster: {
        ...rasterRecord(B),
        capture: { ...rasterRecord(B).capture, rendererStable: false },
      } as never,
    });
    const result = run(kernelFacts(input));
    verifyUnusable(result, 'torn');
  });

  it('is UNUSABLE when the accepted readiness outcome is unusable with a torn authority', () => {
    const result = run(
      kernelFacts(replacementInput(), {
        readiness: convergedReadiness({
          outcome: 'unusable',
          authority: 'torn',
          wakeSource: 'none',
          attempts: 1,
          detail: 'Raster renderer identity changed during acquisition.',
        }),
      }),
    );
    verifyUnusable(result, 'torn');
  });

  it('is UNUSABLE when raster readiness was never attempted', () => {
    const result = run(
      kernelFacts(replacementInput(), {
        readiness: {
          policy: readinessPolicy(),
          observation: {
            outcome: 'not-attempted' as ImageReadinessOutcome,
            authority: 'missing',
            wakeSource: null,
            fallbackPollCount: 0,
            watchdogWaits: 0,
            attempts: 0,
            tornCount: 0,
            mismatches: [],
            detail: null,
          },
        },
      }),
    );
    verifyUnusable(result, 'missing');
  });

  it('is UNUSABLE when the accepted evaluator authority is malformed', () => {
    const facts = replacementFacts();
    const result = run({
      ...facts,
      checks: facts.checks.map((check) => ({
        ...check,
        authority: 'malformed' as ImageAuthorityState,
        currentness: 'unavailable' as const,
        mismatch: false,
      })),
    });
    verifyUnusable(result, 'malformed');
    expect(codes(result)).toContain('IMAGE_KERNEL_AUTHORITY_MALFORMED');
  });

  it('is UNUSABLE for a declared check with no accepted fact', () => {
    const facts = replacementFacts();
    const result = run({
      ...facts,
      checks: facts.checks.filter((check) => check.checkId !== 'image.frame-stable'),
    });
    expect(codes(result)).toContain('IMAGE_KERNEL_FACT_CHECK_MISSING');
    expect(statusFor(result, 'image.frame-stable')).toBe('UNUSABLE');
    expect(statusFor(result, 'image.raster-current')).toBe('PASS');
  });
});

describe('[P7-B B1-D] evidence roles and diagnostic isolation', () => {
  it('never lets a diagnostic screenshot rescue a required check', () => {
    const result = run(
      replacementFacts({
        evidence: [
          { evidenceId: 'raster.accepted', availability: 'missing' },
          { evidenceId: 'image.semantic-baseline', availability: 'authoritative' },
          { evidenceId: 'image.semantic-observed', availability: 'authoritative' },
          { evidenceId: 'geometry.canonical', availability: 'authoritative' },
          { evidenceId: 'geometry.renderer', availability: 'authoritative' },
          { evidenceId: 'observation', availability: 'authoritative' },
          { evidenceId: 'screenshot.diagnostic', availability: 'authoritative' },
        ],
      }),
    );
    expect(statusFor(result, 'image.raster-current')).toBe('UNUSABLE');
    expect(statusFor(result, 'image.structural-visual')).toBe('UNUSABLE');
    expect(statusFor(result, 'image.semantic-transition')).toBe('PASS');
    const current = checkFor(result, 'image.raster-current') as CorrectnessCheckResult;
    expect(current.evidenceIds).toEqual(['observation']);
    expect(current.evidenceIds).not.toContain('screenshot.diagnostic');
    expect(codes(result)).toContain('IMAGE_KERNEL_EVIDENCE_UNDECLARED');
  });

  it('reports a diagnostic-only item declared for required authority', () => {
    const result = run(
      replacementFacts({
        evidence: evidenceAll(profile, { 'raster.accepted': 'diagnostic-only' }),
      }),
    );
    expect(codes(result)).toContain('IMAGE_KERNEL_EVIDENCE_DIAGNOSTIC_ONLY');
    expect(statusFor(result, 'image.raster-current')).toBe('UNUSABLE');
    expect(statusFor(result, 'image.structural-visual')).toBe('UNUSABLE');
  });

  it('is UNUSABLE and consumes no evidence when required raster authority is torn', () => {
    const result = run(
      replacementFacts({
        evidence: evidenceAll(profile, { 'raster.accepted': 'torn' }),
      }),
    );
    const current = checkFor(result, 'image.raster-current') as CorrectnessCheckResult;
    expect(current.evidenceIds).toEqual(['observation']);
    expect(current.actual.authority).toBe('torn');
    expect(statusFor(result, 'image.semantic-transition')).toBe('PASS');
    expect(agreement(identity, cycle(), result.checks).ok).toBe(true);
  });

  it('reports undeclared evidence that claims authority without consuming it', () => {
    const result = run(
      replacementFacts({
        evidence: [
          ...evidenceAll(),
          { evidenceId: 'image.raw-payload.diagnostic', availability: 'authoritative' },
        ],
      }),
    );
    expect(codes(result)).toContain('IMAGE_KERNEL_EVIDENCE_UNDECLARED');
    for (const check of result.checks) {
      expect(check.evidenceIds).not.toContain('image.raw-payload.diagnostic');
    }
  });
});

describe('[P7-B B1-D] compiled-profile identity agreement', () => {
  it('rejects a profile for a different route without fabricating checks', () => {
    const result = evaluateImageChecks({
      profile,
      route: { subjectId: 'layer/text', capability: 'changeProperties', variant: 'static' },
      actionCycle: cycle(),
      facts: replacementFacts(),
    });
    expect(result.ok).toBe(false);
    expect(result.checks).toEqual([]);
    expect(codes(result)).toContain('IMAGE_KERNEL_ROUTE_MISMATCH');
  });

  it('rejects an Action Cycle that observed a different resolved profile', () => {
    const result = evaluateImageChecks({
      profile,
      route: ROUTE,
      actionCycle: { ...cycle(), resolvedProfileFingerprint: 'a'.repeat(64) },
      facts: replacementFacts(),
    });
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('IMAGE_KERNEL_ACTION_CYCLE_MISMATCH');
  });

  it('rejects an Action Cycle readiness disagreement', () => {
    const result = evaluateImageChecks({
      profile,
      route: ROUTE,
      actionCycle: { ...cycle(), readinessFingerprint: 'b'.repeat(64) },
      facts: replacementFacts(),
    });
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('IMAGE_KERNEL_READINESS_MISMATCH');
  });

  it('rejects a compiled profile whose content was mutated in place', () => {
    const tampered = structuredClone(profile) as unknown as Record<string, unknown>;
    (tampered.readiness as Record<string, unknown>).stableFrames = 99;
    const result = evaluateImageChecks({
      profile: tampered as unknown as ResolvedCorrectnessProfile,
      route: ROUTE,
      actionCycle: cycle(),
      facts: replacementFacts(),
    });
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('IMAGE_KERNEL_PROFILE_FINGERPRINT_MISMATCH');
  });

  it('rejects a non-canonical resolved fingerprint', () => {
    const tampered = structuredClone(profile) as unknown as Record<string, unknown>;
    tampered.resolvedFingerprint = 'deadbeef';
    const result = evaluateImageChecks({
      profile: tampered as unknown as ResolvedCorrectnessProfile,
      route: ROUTE,
      actionCycle: cycle(),
      facts: replacementFacts(),
    });
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('IMAGE_KERNEL_PROFILE_FINGERPRINT_INVALID');
  });

  it('rejects an invalid component fingerprint', () => {
    const tampered = structuredClone(profile) as unknown as Record<string, unknown>;
    (tampered.componentFingerprints as Record<string, unknown>).oracle = 'not-a-fingerprint';
    const result = evaluateImageChecks({
      profile: tampered as unknown as ResolvedCorrectnessProfile,
      route: ROUTE,
      actionCycle: cycle(),
      facts: replacementFacts(),
    });
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('IMAGE_KERNEL_COMPONENT_FINGERPRINT_INVALID');
  });

  it('emits consumed component fingerprints a disagreeing compiled identity cannot match', () => {
    const swapped = structuredClone(profile) as unknown as Record<string, unknown>;
    (swapped.componentFingerprints as Record<string, unknown>).oracle = 'c'.repeat(64);
    const { resolvedFingerprint: _drop, ...preimage } = swapped;
    swapped.resolvedFingerprint = deriveResolvedCorrectnessProfileFingerprint(
      preimage as unknown as Omit<ResolvedCorrectnessProfile, 'resolvedFingerprint'>,
    );
    void _drop;
    const swappedProfile = swapped as unknown as ResolvedCorrectnessProfile;
    const result = evaluateImageChecks({
      profile: swappedProfile,
      route: ROUTE,
      actionCycle: cycle(swappedProfile),
      facts: replacementFacts(),
    });
    expect(result.ok).toBe(true);
    const validation = agreement(identity, cycle(swappedProfile), result.checks);
    expect(validation.ok).toBe(false);
    expect(validation.issues.map((entry) => entry.code)).toContain(
      'RESULT_CONSUMED_COMPONENT_MISMATCH',
    );
  });

  it('leaves the compiled check-set/route identity stable across recompiles', () => {
    expect(compile().resolvedFingerprint).toBe(profile.resolvedFingerprint);
    expect(profile.requiredChecks.map((check) => check.checkId)).toEqual(CHECKS);
    expect(profile.requiredAuthoritativeEvidence).toEqual([
      'geometry.canonical',
      'geometry.renderer',
      'image.semantic-baseline',
      'image.semantic-observed',
      'observation',
      'raster.accepted',
    ]);
    expect(profile.diagnosticOnlyEvidence).toEqual([
      'image.raw-payload.diagnostic',
      'screenshot.diagnostic',
    ]);
  });
});

describe('[P7-B B1-D] required-check set, evaluator discriminants, and readiness policy', () => {
  function tamperedProfile(mutate: (profile: Record<string, unknown>) => void) {
    const clone = structuredClone(profile) as unknown as Record<string, unknown>;
    mutate(clone);
    return clone as unknown as ResolvedCorrectnessProfile;
  }

  function runTampered(source: ResolvedCorrectnessProfile): ImageKernelResult {
    return evaluateImageChecks({
      profile: source,
      route: ROUTE,
      actionCycle: cycle(source),
      facts: replacementFacts(),
    });
  }

  it('rejects an empty required-check set', () => {
    const result = runTampered(
      tamperedProfile((entry) => {
        entry.requiredChecks = [];
      }),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('IMAGE_KERNEL_EMPTY_REQUIRED_CHECKS');
  });

  it('rejects a duplicated declared check', () => {
    const result = runTampered(
      tamperedProfile((entry) => {
        const [check] = entry.requiredChecks as unknown[];
        entry.requiredChecks = [check, check];
      }),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('IMAGE_KERNEL_REQUIRED_CHECK_DUPLICATE');
  });

  it('rejects an unsupported per-check evaluator discriminant', () => {
    const result = runTampered(
      tamperedProfile((entry) => {
        const [check] = entry.requiredChecks as Record<string, unknown>[];
        check.evaluator = 'canonical-delta';
      }),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('IMAGE_KERNEL_CHECK_EVALUATOR_UNSUPPORTED');
  });

  it('rejects an unsupported Oracle evaluator discriminant', () => {
    const result = runTampered(
      tamperedProfile((entry) => {
        (entry.oracle as Record<string, unknown>).evaluatorKind = 'geometry-delta';
      }),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('IMAGE_KERNEL_ORACLE_EVALUATOR_UNSUPPORTED');
  });

  it('rejects facts that declare a different evaluator', () => {
    const result = run({
      ...replacementFacts(),
      evaluator: 'geometry-delta' as unknown as ImageKernelFacts['evaluator'],
    });
    expect(result.ok).toBe(true);
    expect(codes(result)).toContain('IMAGE_KERNEL_FACTS_EVALUATOR_MISMATCH');
  });

  it('rejects an accepted fact for an undeclared check without consuming it', () => {
    const facts = replacementFacts();
    const result = run({
      ...facts,
      checks: [
        ...facts.checks,
        {
          checkId: 'image.unknown',
          authority: 'current' as ImageAuthorityState,
          currentness: 'current' as const,
          sourcesAgree: true,
          mismatch: false,
        },
      ],
    });
    expect(codes(result)).toContain('IMAGE_KERNEL_FACT_CHECK_UNKNOWN');
    expect(result.checks.map((check) => check.checkId)).toEqual(CHECKS);
    expect(result.checks.every((check) => check.status === 'PASS')).toBe(true);
  });

  it('rejects a duplicated check fact', () => {
    const facts = replacementFacts();
    const result = run({
      ...facts,
      checks: [...facts.checks, facts.checks[0] as (typeof facts.checks)[number]],
    });
    expect(codes(result)).toContain('IMAGE_KERNEL_FACT_CHECK_DUPLICATE');
  });

  it('makes a check UNUSABLE when its accepted fact has no explicit structured authority', () => {
    const facts = replacementFacts();
    const result = run({
      ...facts,
      checks: [
        {
          checkId: 'image.raster-current',
          authority: 'current' as ImageAuthorityState,
          currentness: 'current' as const,
          sourcesAgree: true,
          mismatch: 'yes' as unknown as boolean,
        },
        ...facts.checks.filter((check) => check.checkId !== 'image.raster-current'),
      ],
    });
    expect(codes(result)).toContain('IMAGE_KERNEL_FACT_STATUS_UNKNOWN');
    expect(statusFor(result, 'image.raster-current')).toBe('UNUSABLE');
  });

  it('rejects a readiness policy that diverges from the compiled readiness authority', () => {
    const result = run(
      kernelFacts(replacementInput(), {
        readiness: {
          policy: readinessPolicy({ deadlineMs: 9999, deadlineCategory: 'DERIVED_GENERATION_V1' }),
          observation: convergedReadiness().observation,
        },
      }),
    );
    expect(codes(result)).toContain('IMAGE_KERNEL_READINESS_POLICY_MISMATCH');
    expect(result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    for (const check of result.checks) {
      expect(check.actual.authority).toBe('unavailable');
    }
  });

  it('routes exactly the delivered Image evaluator kind to the kernel', () => {
    expect(imageKernelKindForEvaluator('image-upload-replace')).toBe('image-upload-replace');
    expect(imageKernelKindForEvaluator('geometry-delta')).toBeNull();
    expect(imageKernelKindForEvaluator('nested-object-affine')).toBeNull();
    expect(imageKernelKindForEvaluator(undefined)).toBeNull();
  });
});

describe('[P7-B B1-D] relevant compiled-field mutation matrix', () => {
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

  function mutateLeaf(root: Record<string, unknown>, leafPath: string): void {
    const parts = leafPath.replace(/\[(\d+)\]/g, '.$1').split('.');
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

  const leafPaths: string[] = [];
  collectLeafPaths(profile, '', leafPaths);

  it('covers the complete compiled Image profile projection', () => {
    expect(leafPaths.length).toBeGreaterThanOrEqual(200);
  });

  it('rejects every single-leaf mutation of the compiled Image profile', () => {
    for (const leafPath of leafPaths) {
      const clone = structuredClone(profile) as unknown as Record<string, unknown>;
      mutateLeaf(clone, leafPath);
      const mutated = clone as unknown as ResolvedCorrectnessProfile;
      const result = evaluateImageChecks({
        profile: mutated,
        route: ROUTE,
        actionCycle: cycle(mutated),
        facts: replacementFacts(),
      });
      expect(result.ok, `mutation of ${leafPath} was not detected`).toBe(false);
    }
  });
});

describe('[P7-B B1-D] inactive kernel invariants', () => {
  const skillRoot = path.resolve(process.cwd());
  const source = (relative: string): string => readFileSync(path.join(skillRoot, relative), 'utf8');

  it('does not import any active executor, Oracle, readiness loop, evidence writer, or classifier', () => {
    const kernel = source('src/kernels/image-kernel.ts');
    expect(kernel).not.toMatch(/from '\.\.\/(runtime|oracles|readiness|evidence)\//);
    expect(kernel).not.toContain('execute-plan');
    expect(kernel).not.toContain('execute-image-plan');
    expect(kernel).not.toContain('contracts/execution');
    expect(kernel).not.toMatch(/from '\.\.\/runtime\/outcomes'/);
    expect(kernel).not.toMatch(/from '\.\.\/runtime\/result-outcome'/);
  });

  it('is not referenced by any active executor, Oracle, or writer module', () => {
    for (const relative of [
      'src/runtime/execute-plan.ts',
      'src/runtime/execute-image-plan.ts',
      'src/runtime/action-cycle.ts',
      'src/oracles/evaluate.ts',
      'src/oracles/image.ts',
      'src/evidence/writer.ts',
      'src/evidence/public-dto.ts',
      'src/runtime/outcomes.ts',
    ]) {
      expect(source(relative)).not.toContain('image-kernel');
      expect(source(relative)).not.toContain('evaluateImageChecks');
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

  it('keeps every produced component fingerprint full canonical', () => {
    const result = run(replacementFacts());
    for (const check of result.checks) {
      expect(isFullCanonicalFingerprint(check.consumedComponentFingerprints.resolvedProfile)).toBe(
        true,
      );
      expect(isFullCanonicalFingerprint(check.consumedComponentFingerprints.oracle)).toBe(true);
      expect(isFullCanonicalFingerprint(check.consumedComponentFingerprints.tolerances)).toBe(true);
    }
  });
});

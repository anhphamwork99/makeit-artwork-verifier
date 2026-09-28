import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadCatalogueBundle, type CatalogueBundle } from '../../src/catalogue/load';
import { loadResourceManifest } from '../../src/catalogue/resources';
import { loadDiagnosticSuite, resolveSuiteRequests } from '../../src/catalogue/suite';
import type { ResolvedCorrectnessProfile } from '../../src/contracts/correctness';
import { rasterProbeBackingCoordinate } from '../../src/contracts/raster';
import type { ResourceManifestEntry } from '../../src/contracts/resources';
import { CHECK_RESULT_CONTRACT_SCHEMA_VERSION } from '../../src/contracts/schema-versions';
import { evaluateImageOracle, type ImageOracleInput } from '../../src/oracles/image';
import {
  MATERIALIZED_EXECUTION_ENVELOPE_SCHEMA_VERSION,
  type MaterializedExecutionEnvelopeV1,
} from '../../src/planner/execution-materialization';
import { planCaseForExecution } from '../../src/planner/plan-case';
import { resolveToolkitRoot } from '../../src/runtime/paths';
import {
  IMAGE_LIVE_FACT_ISSUE_CODES,
  adaptImageLiveFacts,
  evaluateImageLiveChecks,
  projectImageLiveFacts,
  type ImageLiveEvaluationObservation,
  type ImageLiveFactFailure,
  type ImageLiveFactRoute,
} from '../../src/adapters/image-live-facts';
import {
  isFullCanonicalFingerprint,
  projectCorrectnessProfileIdentity,
  validateResultIdentityAgreement,
} from '../../src/index';
import type {
  ActionCycleCorrectnessIdentity,
  CorrectnessCheckResult,
  ImageEvidenceAvailability,
  ImageEvidenceFact,
  ImageKernelFacts,
  ImageReadinessFact,
  ImageReadinessOutcome,
} from '../../src/index';

/**
 * P7-B2-B3 focused proof: inactive live-fact adapter for Image
 * upload/replacement (ADR 0029 §4 B2-B).
 *
 * The suites drive the adapter from the *real* exact envelope produced by
 * `planCaseForExecution` for the representative Image request and the *real*
 * accepted `evaluateImageOracle` outputs over the exact checked-in resource
 * raster records. They cover PASS, a trustworthy source-digest / frame / probe /
 * distinctness mismatch, a trustworthy deadline non-convergence, missing/stale/
 * torn/wrong-target/malformed/non-blob raster authority, explicit readiness
 * facts, identity/evidence agreement, fail-closed envelope rejection before the
 * kernel, no adapter policy, no active imports, no legacy boolean/harnessInvalid
 * authority in the produced structured facts, and a single-leaf mutation of
 * every compiled compatibility field.
 */

const skillRoot = resolveToolkitRoot();
const bundle: CatalogueBundle = loadCatalogueBundle();

function representativeRequest(fileName: string): unknown {
  const resolved = resolveSuiteRequests(loadDiagnosticSuite('representative'));
  const entry = resolved.find((candidate) => path.basename(candidate.relativePath) === fileName);
  if (entry === undefined) throw new Error(`missing representative request ${fileName}`);
  return entry.request;
}

const IMAGE_REQUEST = 'layer-image-upload-replace.json';

interface PreparedCase {
  readonly envelope: MaterializedExecutionEnvelopeV1;
  readonly profile: ResolvedCorrectnessProfile;
  readonly route: ImageLiveFactRoute;
  readonly expectedFrame: ImageKernelFacts['expectedFrame'];
}

function prepare(fileName: string): PreparedCase {
  const result = planCaseForExecution(representativeRequest(fileName), { catalogues: bundle });
  if (result.status !== 'PLANNED') throw new Error(`${fileName} did not plan: ${result.status}`);
  if (result.envelope === null) throw new Error(`${fileName} produced no envelope`);
  const envelope = result.envelope;
  const intent = result.materializedCase.intent;
  const expected = intent.expected as {
    imageFrame?: ImageKernelFacts['expectedFrame'];
  };
  if (expected.imageFrame === undefined) throw new Error('missing imageFrame');
  expect(envelope.schemaVersion).toBe(MATERIALIZED_EXECUTION_ENVELOPE_SCHEMA_VERSION);
  return {
    envelope,
    profile: envelope.correctnessProfile as unknown as ResolvedCorrectnessProfile,
    route: {
      subjectId: intent.subjectId,
      capability: intent.capability,
      variant: intent.variant,
    },
    expectedFrame: expected.imageFrame,
  };
}

const imageCase = prepare(IMAGE_REQUEST);

function cycle(prepared: PreparedCase, actionCycleId: string): ActionCycleCorrectnessIdentity {
  return {
    schemaVersion: CHECK_RESULT_CONTRACT_SCHEMA_VERSION,
    actionCycleId,
    resolvedProfileFingerprint: prepared.profile.resolvedFingerprint,
    readinessFingerprint: prepared.profile.componentFingerprints.readiness,
  };
}

const IMAGE_CYCLE = cycle(imageCase, 'b2b3-cycle-image');

function evidenceAll(
  profile: ResolvedCorrectnessProfile,
  overrides: Readonly<Record<string, ImageEvidenceAvailability>> = {},
): ImageEvidenceFact[] {
  return profile.requiredAuthoritativeEvidence.map((evidenceId) => ({
    evidenceId,
    availability: overrides[evidenceId] ?? 'authoritative',
  }));
}

// ── Real accepted raster/resource fixtures (WP5 Slice 5-C) ──────────────────

const manifest = loadResourceManifest();
const A = manifest.resources.find(
  (entry) => entry.logicalId === 'image.upload-a',
) as ResourceManifestEntry;
const B = manifest.resources.find(
  (entry) => entry.logicalId === 'image.upload-b',
) as ResourceManifestEntry;
const TARGET_ID = 'layout-image-a-image-1';
const LAYOUT_ID = 'layout-image-a';

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

function rasterRecord(entry: ResourceManifestEntry, opts: { id?: string; rgbaSha?: string } = {}) {
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
      revision: 5,
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
        revision: 5,
      },
      completed: {
        schemaVersion: 1,
        documentId: 'doc',
        documentEpoch: 1,
        bridgeVersion: 7,
        bridgeGeneration: 1,
        revision: 5,
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
    expectedFrame: imageCase.expectedFrame,
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
    expectedFrame: imageCase.expectedFrame,
    expectedResource: expectedResource(B),
    acceptedUpload: accepted,
    baselineSnapshot: snapshotWith(layer('blob:http://127.0.0.1/a')),
    observedSnapshot: snapshotWith(layer('blob:http://127.0.0.1/b')),
    raster: rasterRecord(B),
    ...overrides,
  };
}

// ── Readiness fixtures ──────────────────────────────────────────────────────

function readinessPolicy(overrides: Partial<ImageReadinessFact['policy']> = {}) {
  return {
    profileId: imageCase.profile.readiness.profileId,
    deadlineCategory: imageCase.profile.readiness.deadlineCategory,
    deadlineMs: imageCase.profile.readiness.deadlineMs,
    signalWatchdogMs: imageCase.profile.readiness.signalWatchdogMs,
    fallbackCadenceMs: [...imageCase.profile.readiness.fallbackCadenceMs],
    stableFrames: imageCase.profile.readiness.stableFrames,
    quiescenceRequired: imageCase.profile.readiness.quiescenceRequired,
    stableFrameRequired: imageCase.profile.readiness.stableFrameRequired,
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

// ── Adapter invocation helpers ───────────────────────────────────────────────

function observationOf(input: ImageOracleInput): ImageLiveEvaluationObservation {
  const evaluation = evaluateImageOracle(input);
  return { primitiveFacts: evaluation.primitiveFacts, diagnostics: evaluation.diagnostics };
}

function imageInput(
  input: ImageOracleInput,
  overrides: Partial<Parameters<typeof adaptImageLiveFacts>[0]> = {},
): Parameters<typeof adaptImageLiveFacts>[0] {
  return {
    envelope: imageCase.envelope,
    route: imageCase.route,
    actionCycle: IMAGE_CYCLE,
    mode: input.mode,
    targetId: input.targetId,
    expectedLayoutId: input.expectedLayoutId,
    expectedFrame: input.expectedFrame,
    expectedResource: input.expectedResource,
    acceptedUpload: input.acceptedUpload,
    oracle: observationOf(input),
    raster: input.raster,
    readiness: convergedReadiness(),
    evidence: evidenceAll(imageCase.profile),
    ...overrides,
  };
}

function issueCodes(failure: ImageLiveFactFailure): string[] {
  return failure.issues.map((issue) => issue.code);
}

function assertIdentityAgreement(
  checks: readonly CorrectnessCheckResult[],
  profile: ResolvedCorrectnessProfile,
  aCycle: ActionCycleCorrectnessIdentity,
): void {
  const identity = projectCorrectnessProfileIdentity(profile);
  const validation = validateResultIdentityAgreement(identity, {
    actionCycles: [aCycle],
    requiredChecks: checks,
  });
  expect(validation.ok).toBe(true);
  expect(validation.issues).toEqual([]);
  for (const check of checks) {
    expect(check.actionCycleRef).toBe(aCycle.actionCycleId);
    expect(check.consumedComponentFingerprints.resolvedProfile).toBe(profile.resolvedFingerprint);
    expect(check.consumedComponentFingerprints.oracle).toBe(profile.componentFingerprints.oracle);
    expect(check.consumedComponentFingerprints.capture).toBe(profile.componentFingerprints.capture);
  }
}

function statusFor(checks: readonly CorrectnessCheckResult[], checkId: string): string | undefined {
  return checks.find((check) => check.checkId === checkId)?.status;
}

function checkFor(
  checks: readonly CorrectnessCheckResult[],
  checkId: string,
): CorrectnessCheckResult | undefined {
  return checks.find((check) => check.checkId === checkId);
}

const CHECK_IDS = [
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

// ── Envelope agreement and fail-closed adaptation ───────────────────────────

describe('[P7-B2-B3] exact-envelope agreement and fail-closed adaptation', () => {
  it('adapts the real representative Image envelope into complete structured facts', () => {
    const input = replacementInput();
    const adaptation = adaptImageLiveFacts(imageInput(input));
    expect(adaptation.ok).toBe(true);
    if (!adaptation.ok) return;
    expect(adaptation.facts.evaluator).toBe('image-upload-replace');
    expect(adaptation.facts.checks.map((entry) => entry.checkId).sort()).toEqual(
      [...CHECK_IDS].sort(),
    );
    for (const entry of adaptation.facts.checks) {
      expect(entry.authority).toBe('current');
      expect(entry.currentness).toBe('current');
      expect(entry.mismatch).toBe(false);
      expect(entry.sourcesAgree).toBe(true);
      expect(Object.hasOwn(entry, 'passed')).toBe(false);
      expect(Object.hasOwn(entry, 'unusable')).toBe(false);
    }
    expect(adaptation.facts.oracleFacts).not.toBeNull();
    expect(adaptation.facts.checks).toHaveLength(CHECK_IDS.length);
    expect(Object.hasOwn(adaptation.facts, 'harnessInvalid')).toBe(false);
    expect(adaptation.facts.raster).toBe(input.raster);
  });

  it('fails closed before the kernel on every envelope disagreement class', () => {
    const planFingerprint = adaptImageLiveFacts({
      ...imageInput(replacementInput()),
      envelope: {
        ...imageCase.envelope,
        planFingerprint: 'f'.repeat(64),
      } as MaterializedExecutionEnvelopeV1,
    });
    expect(planFingerprint.ok).toBe(false);
    if (!planFingerprint.ok) {
      expect(planFingerprint.status).toBe('HARNESS_BLOCKED');
      expect(planFingerprint.launchAttempted).toBe(false);
      expect(issueCodes(planFingerprint)).toContain('ENVELOPE_PLAN_FINGERPRINT_MISMATCH');
    }

    const caseId = adaptImageLiveFacts({
      ...imageInput(replacementInput()),
      envelope: {
        ...imageCase.envelope,
        caseId: 'other-case',
      } as MaterializedExecutionEnvelopeV1,
    });
    expect(caseId.ok).toBe(false);

    const routeMismatch = adaptImageLiveFacts({
      ...imageInput(replacementInput()),
      route: { ...imageCase.route, variant: 'foreign-variant' },
    });
    expect(routeMismatch.ok).toBe(false);
    if (!routeMismatch.ok) {
      expect(issueCodes(routeMismatch)).toContain('ENVELOPE_ROUTE_MISMATCH');
    }

    const evaluatorMismatch = adaptImageLiveFacts({
      ...imageInput(replacementInput()),
      envelope: {
        ...imageCase.envelope,
        correctnessProfile: {
          ...imageCase.profile,
          oracle: { ...imageCase.profile.oracle, evaluatorKind: 'geometry-delta' },
        },
      } as unknown as MaterializedExecutionEnvelopeV1,
    });
    expect(evaluatorMismatch.ok).toBe(false);
    if (!evaluatorMismatch.ok) {
      expect(issueCodes(evaluatorMismatch)).toContain('ENVELOPE_ORACLE_EVALUATOR_UNSUPPORTED');
    }

    const actionCycleMismatch = adaptImageLiveFacts({
      ...imageInput(replacementInput()),
      actionCycle: { ...IMAGE_CYCLE, resolvedProfileFingerprint: 'a'.repeat(64) },
    });
    expect(actionCycleMismatch.ok).toBe(false);
    if (!actionCycleMismatch.ok) {
      expect(issueCodes(actionCycleMismatch)).toContain('ENVELOPE_ACTION_CYCLE_MISMATCH');
    }

    const readinessMismatch = adaptImageLiveFacts({
      ...imageInput(replacementInput()),
      actionCycle: { ...IMAGE_CYCLE, readinessFingerprint: 'b'.repeat(64) },
    });
    expect(readinessMismatch.ok).toBe(false);
    if (!readinessMismatch.ok) {
      expect(issueCodes(readinessMismatch)).toContain('ENVELOPE_READINESS_MISMATCH');
    }

    const invalidEvidence = adaptImageLiveFacts({
      ...imageInput(replacementInput()),
      evidence: [{ evidenceId: 'observation', availability: 'invented' } as never],
    });
    expect(invalidEvidence.ok).toBe(false);
    if (!invalidEvidence.ok) {
      expect(issueCodes(invalidEvidence)).toContain('IMAGE_LIVE_EVIDENCE_FACT_INVALID');
    }

    const malformedObservation = adaptImageLiveFacts({
      ...imageInput(replacementInput()),
      oracle: {
        primitiveFacts: { authority: 'current' },
      } as unknown as ImageLiveEvaluationObservation,
    });
    expect(malformedObservation.ok).toBe(false);
    if (!malformedObservation.ok) {
      expect(issueCodes(malformedObservation)).toContain('IMAGE_LIVE_OBSERVATION_MALFORMED');
    }

    const unknownIssueCodes = new Set<string>(IMAGE_LIVE_FACT_ISSUE_CODES);
    for (const failure of [planFingerprint, routeMismatch, actionCycleMismatch, invalidEvidence]) {
      if (failure.ok) continue;
      for (const issue of failure.issues) {
        expect(unknownIssueCodes.has(issue.code)).toBe(true);
      }
    }
  });

  it('never invokes the kernel on a disagreeing envelope', () => {
    const failed = evaluateImageLiveChecks({
      ...imageInput(replacementInput()),
      actionCycle: { ...IMAGE_CYCLE, resolvedProfileFingerprint: 'c'.repeat(64) },
    });
    expect(failed.ok).toBe(false);
    expect(Object.hasOwn(failed, 'result')).toBe(false);
    expect(Object.hasOwn(failed, 'facts')).toBe(false);
  });
});

// ── Image live-fact behavior ────────────────────────────────────────────────

describe('[P7-B2-B3] Image live facts', () => {
  it('produces complete PASS checks with identity/evidence agreement', () => {
    const outcome = evaluateImageLiveChecks(imageInput(replacementInput()));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.checks.map((check) => check.checkId)).toEqual(CHECK_IDS);
    for (const check of outcome.result.checks) {
      expect(check.status).toBe('PASS');
      expect(check.actual.authority).toBe('current');
      expect(check.evidenceIds).toEqual(EVIDENCE_BY_CHECK[check.checkId]);
    }
    assertIdentityAgreement(outcome.result.checks, imageCase.profile, IMAGE_CYCLE);
  });

  it('fails only raster-current on a page-observed source digest mismatch', () => {
    const input = replacementInput({
      raster: {
        ...rasterRecord(B),
        source: { ...rasterRecord(B).source, sha256: A.sha256 },
      } as never,
    });
    const outcome = evaluateImageLiveChecks(imageInput(input));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(statusFor(outcome.result.checks, 'image.raster-current')).toBe('FAIL');
    expect(statusFor(outcome.result.checks, 'image.frame-stable')).toBe('PASS');
    expect(statusFor(outcome.result.checks, 'image.semantic-transition')).toBe('PASS');
    expect(checkFor(outcome.result.checks, 'image.raster-current')?.actual.authority).toBe(
      'current',
    );
    assertIdentityAgreement(outcome.result.checks, imageCase.profile, IMAGE_CYCLE);
  });

  it('fails only structural-visual when a probe channel is outside its tolerance', () => {
    const wrongProbe = rasterRecord(B);
    const firstProbe = wrongProbe.rendered.probes[0];
    if (firstProbe !== undefined) firstProbe.rgba = [0, 0, 0, 255];
    const outcome = evaluateImageLiveChecks(imageInput(replacementInput({ raster: wrongProbe })));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(statusFor(outcome.result.checks, 'image.structural-visual')).toBe('FAIL');
    expect(statusFor(outcome.result.checks, 'image.raster-current')).toBe('PASS');
    assertIdentityAgreement(outcome.result.checks, imageCase.profile, IMAGE_CYCLE);
  });

  it('fails only frame-stable when the observed canonical frame drifts', () => {
    const outcome = evaluateImageLiveChecks(
      imageInput(
        replacementInput({
          observedSnapshot: snapshotWith(layer('blob:http://x/b', { height: 241 })),
        }),
      ),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(statusFor(outcome.result.checks, 'image.frame-stable')).toBe('FAIL');
    expect(statusFor(outcome.result.checks, 'image.raster-current')).toBe('PASS');
    assertIdentityAgreement(outcome.result.checks, imageCase.profile, IMAGE_CYCLE);
  });

  it('fails content-distinct when the replacement retains the accepted upload pixels', () => {
    const input = replacementInput({
      raster: {
        ...rasterRecord(B),
        rendered: { ...rasterRecord(B).rendered, rgbaSha256: `rgba-${A.logicalId}` },
      } as never,
    });
    const outcome = evaluateImageLiveChecks(imageInput(input));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(statusFor(outcome.result.checks, 'image.content-distinct')).toBe('FAIL');
    expect(statusFor(outcome.result.checks, 'image.semantic-transition')).toBe('PASS');
    assertIdentityAgreement(outcome.result.checks, imageCase.profile, IMAGE_CYCLE);
  });

  it('maps a trustworthy raster non-convergence at the one deadline to FAIL for every check', () => {
    const outcome = evaluateImageLiveChecks(
      imageInput(replacementInput(), {
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
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.checks.every((check) => check.status === 'FAIL')).toBe(true);
    for (const check of outcome.result.checks) {
      expect(check.actual.authority).toBe('current');
    }
    const current = checkFor(
      outcome.result.checks,
      'image.raster-current',
    ) as CorrectnessCheckResult;
    expect(current.actual.readiness).toMatchObject({
      outcome: 'deadline-exceeded',
      wakeSource: 'poll-fallback',
      fallbackPollCount: 4,
      watchdogWaits: 1,
      attempts: 5,
    });
    assertIdentityAgreement(outcome.result.checks, imageCase.profile, IMAGE_CYCLE);
  });

  it('produces UNUSABLE for missing, stale, torn, wrong-target, malformed, and non-blob authority', () => {
    const cases: readonly [string, ImageOracleInput, string][] = [
      ['missing', replacementInput({ raster: null }), 'missing'],
      [
        'torn',
        replacementInput({
          raster: { ...rasterRecord(B), status: 'torn', reason: 'observation-changed' } as never,
        }),
        'torn',
      ],
      [
        'stale',
        replacementInput({ raster: { ...rasterRecord(B), status: 'pending' } as never }),
        'stale',
      ],
      [
        'wrong-target',
        replacementInput({ raster: rasterRecord(B, { id: 'other-target' }) as never }),
        'wrong-target',
      ],
      [
        'non-blob',
        replacementInput({
          raster: {
            ...rasterRecord(B),
            source: { ...rasterRecord(B).source, scheme: 'data' },
          } as never,
        }),
        'missing',
      ],
      [
        'torn-capture',
        replacementInput({
          raster: {
            ...rasterRecord(B),
            capture: { ...rasterRecord(B).capture, rendererStable: false },
          } as never,
        }),
        'torn',
      ],
    ];
    for (const [label, input, expectedAuthority] of cases) {
      const outcome = evaluateImageLiveChecks(imageInput(input));
      expect(outcome.ok, label).toBe(true);
      if (!outcome.ok) continue;
      expect(
        outcome.result.checks.map((check) => check.status),
        label,
      ).toEqual(['UNUSABLE', 'UNUSABLE', 'UNUSABLE', 'UNUSABLE', 'UNUSABLE']);
      for (const check of outcome.result.checks) {
        expect(check.actual.authority, label).toBe(expectedAuthority);
      }
    }

    const { authorityKind: _omitted, ...withoutAuthorityKind } = rasterRecord(B);
    void _omitted;
    const malformed = evaluateImageLiveChecks(
      imageInput(replacementInput({ raster: withoutAuthorityKind as never })),
    );
    expect(malformed.ok).toBe(true);
    if (malformed.ok) {
      expect(malformed.result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
      expect(malformed.result.checks[0]?.actual.authority).toBe('malformed');
    }
  });

  it('keeps the observed readiness facts explicit, including a never-attempted cycle', () => {
    const outcome = evaluateImageLiveChecks(
      imageInput(replacementInput(), {
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
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    for (const check of outcome.result.checks) {
      expect(check.actual.authority).toBe('missing');
      expect(check.actual.readiness).toMatchObject({ outcome: 'not-attempted', gate: 'unusable' });
    }
  });

  it('marks the replacement-only distinct check UNUSABLE on an upload Action Cycle', () => {
    const outcome = evaluateImageLiveChecks(imageInput(uploadInput()));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    for (const checkId of [
      'image.frame-stable',
      'image.raster-current',
      'image.semantic-transition',
      'image.structural-visual',
    ]) {
      expect(statusFor(outcome.result.checks, checkId)).toBe('PASS');
    }
    expect(statusFor(outcome.result.checks, 'image.content-distinct')).toBe('UNUSABLE');
    expect(outcome.result.issues.map((entry) => entry.code)).toContain(
      'IMAGE_KERNEL_FACT_CHECK_MISSING',
    );
  });

  it('passes the observed evidence roles through untouched and never invents a role', () => {
    const observed = evidenceAll(imageCase.profile);
    const outcome = evaluateImageLiveChecks(imageInput(uploadInput(), { evidence: observed }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.facts.evidence).toEqual(observed);
    expect(outcome.result.checks[0]?.evidenceIds).toEqual(
      EVIDENCE_BY_CHECK[outcome.result.checks[0]?.checkId ?? ''],
    );
  });

  it('never lets a diagnostic screenshot rescue a required check', () => {
    const outcome = evaluateImageLiveChecks(
      imageInput(replacementInput(), {
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
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(statusFor(outcome.result.checks, 'image.raster-current')).toBe('UNUSABLE');
    expect(statusFor(outcome.result.checks, 'image.structural-visual')).toBe('UNUSABLE');
    expect(statusFor(outcome.result.checks, 'image.semantic-transition')).toBe('PASS');
    expect(
      outcome.result.checks.every((check) => !check.evidenceIds.includes('screenshot.diagnostic')),
    ).toBe(true);
    expect(outcome.result.issues.map((entry) => entry.code)).toContain(
      'IMAGE_KERNEL_EVIDENCE_UNDECLARED',
    );
  });

  it('carries no legacy harnessInvalid or boolean passed authority into the kernel facts', () => {
    const adaptation = adaptImageLiveFacts(imageInput(replacementInput()));
    expect(adaptation.ok).toBe(true);
    if (!adaptation.ok) return;
    const facts = adaptation.facts as ImageKernelFacts;
    expect(Object.hasOwn(facts, 'harnessInvalid')).toBe(false);
    expect(Object.hasOwn(facts, 'checks')).toBe(true);
    for (const check of facts.checks) {
      expect(Object.hasOwn(check, 'passed')).toBe(false);
      expect(Object.hasOwn(check, 'unusable')).toBe(false);
      expect(typeof check.authority).toBe('string');
      expect(typeof check.currentness).toBe('string');
      expect(typeof check.sourcesAgree).toBe('boolean');
      expect(typeof check.mismatch).toBe('boolean');
    }
  });
});

// ── Legacy authority elimination ────────────────────────────────────────────

describe('[P7-B2-B3] legacy authority elimination', () => {
  it('derives facts only from additive primitive observations, never from legacy booleans', () => {
    const baseline = evaluateImageLiveChecks(imageInput(replacementInput()));
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;
    expect(baseline.result.checks.every((check) => check.status === 'PASS')).toBe(true);

    // Runtime spy: flip every legacy composite check-result boolean and the
    // aggregate harness-validity flag while leaving the additive primitive facts
    // byte-identical. The adapter must not observe any difference: it no longer
    // reads any of those fields.
    const input = replacementInput();
    const evaluation = evaluateImageOracle(input);
    const flipped = {
      ...evaluation,
      checks: evaluation.checks.map((check) => ({ ...check, passed: !check.passed })),
      harnessInvalid: !evaluation.harnessInvalid,
    };
    const afterFlip = evaluateImageLiveChecks(
      imageInput(input, {
        oracle: flipped as unknown as ImageLiveEvaluationObservation,
      }),
    );
    expect(afterFlip.ok).toBe(true);
    if (!afterFlip.ok) return;
    expect(afterFlip.result.checks).toEqual(baseline.result.checks);
    expect(afterFlip.facts).toEqual(baseline.facts);

    // A genuine per-check primitive change must change the adapter output.
    const tamperedPrimitives = {
      ...evaluation.primitiveFacts,
      sourceAgreement: false,
      checks: evaluation.primitiveFacts.checks.map((check) => ({
        ...check,
        predicateMet: false,
      })),
    };
    const afterPrimitive = evaluateImageLiveChecks(
      imageInput(input, {
        oracle: {
          ...evaluation,
          primitiveFacts: tamperedPrimitives,
        } as unknown as ImageLiveEvaluationObservation,
      }),
    );
    expect(afterPrimitive.ok).toBe(true);
    if (!afterPrimitive.ok) return;
    expect(afterPrimitive.result.checks.every((check) => check.status === 'FAIL')).toBe(true);
    for (const check of afterPrimitive.result.checks) {
      expect(check.actual.sourcesAgree).toBe(false);
      expect(check.actual.authority).toBe('current');
    }
  });

  it('derives malformed authority from the primitive authority, not the aggregate harness flag', () => {
    const input = replacementInput();
    const evaluation = evaluateImageOracle(input);
    expect(evaluation.harnessInvalid).toBe(false);
    // Force the additive primitive authority to malformed while every legacy
    // boolean stays clean; the outcome must stay UNUSABLE rather than becoming a
    // fabricated PASS/FAIL.
    const primitives = {
      ...evaluation.primitiveFacts,
      authority: 'malformed' as const,
      checks: evaluation.primitiveFacts.checks.map((check) => ({
        ...check,
        predicateMet: true,
      })),
    };
    const outcome = evaluateImageLiveChecks(
      imageInput(input, {
        oracle: {
          ...evaluation,
          primitiveFacts: primitives,
        } as unknown as ImageLiveEvaluationObservation,
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    for (const check of outcome.result.checks) {
      expect(check.actual.authority).toBe('malformed');
      expect(check.actual.mismatch).toBe(false);
    }
  });

  it('preserves the active Oracle consumers additively', () => {
    const evaluation = evaluateImageOracle(replacementInput());
    // Legacy fields the active runtime still consumes remain exactly as before.
    expect(evaluation.checks.map((check) => check.checkId).sort()).toEqual([...CHECK_IDS].sort());
    expect(evaluation.checks.every((check) => check.passed)).toBe(true);
    expect(evaluation.harnessInvalid).toBe(false);
    expect(evaluation.diagnostics).toEqual([]);
    // The additive primitive facts carry only named primitives, never a boolean
    // check result or aggregate harness flag.
    expect(evaluation.primitiveFacts.authority).toBe('current');
    expect(evaluation.primitiveFacts.sourceAgreement).toBe(true);
    expect(evaluation.primitiveFacts.checks.map((check) => check.checkId).sort()).toEqual(
      [...CHECK_IDS].sort(),
    );
    expect(Object.hasOwn(evaluation.primitiveFacts, 'passed')).toBe(false);
    expect(Object.hasOwn(evaluation.primitiveFacts, 'status')).toBe(false);
    expect(Object.hasOwn(evaluation.primitiveFacts, 'harnessInvalid')).toBe(false);
    for (const check of evaluation.primitiveFacts.checks) {
      expect(Object.hasOwn(check, 'passed')).toBe(false);
      expect(typeof check.predicateMet).toBe('boolean');
    }
    // The adapter's structured projection never carries the raw legacy booleans.
    const projected = projectImageLiveFacts({
      primitiveFacts: evaluation.primitiveFacts,
      diagnostics: evaluation.diagnostics,
    });
    for (const entry of projected) {
      expect(Object.hasOwn(entry, 'passed')).toBe(false);
      expect(Object.hasOwn(entry, 'unusable')).toBe(false);
      expect(typeof entry.authority).toBe('string');
      expect(typeof entry.mismatch).toBe('boolean');
    }
  });
});

// ── No adapter policy, no active imports, no legacy authority ───────────────

describe('[P7-B2-B3] inactive adapter invariants', () => {
  const source = (relative: string): string => readFileSync(path.join(skillRoot, relative), 'utf8');
  const adapterSource = source('src/adapters/image-live-facts.ts');
  const kernelSource = source('src/kernels/image-kernel.ts');

  it('does not import any active executor, Oracle, evidence writer, CLI, browser, or classifier', () => {
    expect(adapterSource).not.toMatch(
      /from '\.\.\/(runtime|oracles|evidence|cli|browser|workflows|commands)\//,
    );
    for (const token of [
      'execute-plan',
      'evaluateImageOracle',
      'writeRunRecord',
      'outcomes',
      'contracts/execution',
    ]) {
      expect(adapterSource, token).not.toContain(token);
    }
  });

  it('owns no required-check array, fallback id, deadline, tolerance, visual, or normalization literal', () => {
    for (const token of [
      "'image.semantic-transition'",
      "'image.raster-current'",
      "'image.frame-stable'",
      "'image.structural-visual'",
      "'image.content-distinct'",
      "'layer/image'",
      "'image-upload-replace-v1'",
      'deadlineMs',
      'stableFrames',
      'quiescenceRequired',
      '0.25',
      '1e-6',
    ]) {
      expect(adapterSource, token).not.toContain(token);
    }
  });

  it('performs no authoring-catalogue reload or route/Subject/scenario dispatch', () => {
    for (const token of [
      'loadCorrectnessCatalogue',
      'loadCatalogueBundle',
      'compileResolvedCorrectnessProfile',
      'resolveRouteSelection',
      'routeSelections',
      "subjectId === '",
      "variant === '",
      'switch (',
    ]) {
      expect(adapterSource, token).not.toContain(token);
    }
  });

  it('never defaults an evidence role and never translates a boolean into a final status', () => {
    expect(adapterSource).not.toContain('evidenceId:');
    expect(adapterSource).not.toMatch(/'PASS'|'FAIL'/);
    // The reconciled kernel fact contract no longer exposes legacy authority.
    expect(kernelSource).not.toMatch(/readonly passed: boolean/);
    expect(kernelSource).not.toMatch(/readonly unusable: boolean/);
    expect(kernelSource).not.toMatch(/readonly harnessInvalid: boolean/);
  });

  it('reads no legacy composite boolean or aggregate authority field from the observation', () => {
    // Scan only executed source, not explanatory comments.
    const code = adapterSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/\bpassed\b/);
    expect(code).not.toMatch(/\bunusable\b/);
    expect(code).not.toMatch(/\bharnessInvalid\b/);
    expect(code).not.toMatch(/\.status\b/);
    // The only nested read surface is the additive primitive view.
    expect(code).toContain('primitiveFacts');
  });

  it('is inactive: not exported from the public barrel and unreferenced by active modules', () => {
    const indexSource = source('src/index.ts');
    expect(indexSource).not.toContain('image-live-facts');
    expect(indexSource).not.toContain('adaptImageLiveFacts');
    expect(indexSource).not.toContain('evaluateImageLiveChecks');
  });

  it('fails closed with a structured diagnostic on every reported issue', () => {
    const failure = adaptImageLiveFacts(
      imageInput(replacementInput(), {
        evidence: [{ evidenceId: 'x', availability: 'nope' } as never],
      }),
    );
    expect(failure.ok).toBe(false);
    if (failure.ok) return;
    expect(failure.status).toBe('HARNESS_BLOCKED');
    expect(failure.launchAttempted).toBe(false);
    expect(failure.diagnostic.code).toBe('UNUSABLE_EVIDENCE');
    expect(failure.diagnostic.detail).toContain('IMAGE_LIVE_EVIDENCE_FACT_INVALID');
  });
});

// ── Compiled compatibility mutation matrix ──────────────────────────────────

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

function mutatedEnvelope(
  envelope: MaterializedExecutionEnvelopeV1,
  leafPath: string,
): MaterializedExecutionEnvelopeV1 {
  const clone = structuredClone(envelope) as unknown as Record<string, unknown>;
  mutateLeaf(clone, `correctnessProfile.${leafPath}`);
  return clone as unknown as MaterializedExecutionEnvelopeV1;
}

describe('[P7-B2-B3] compiled compatibility mutation matrix', () => {
  const leafPaths: string[] = [];
  collectLeafPaths(imageCase.profile, '', leafPaths);

  it('covers the complete compiled Image profile projection', () => {
    expect(leafPaths.length).toBeGreaterThanOrEqual(200);
  });

  it('detects every single-leaf mutation of the compiled Image profile', () => {
    for (const leafPath of leafPaths) {
      const adaptation = adaptImageLiveFacts({
        ...imageInput(replacementInput()),
        envelope: mutatedEnvelope(imageCase.envelope, leafPath),
      });
      expect(adaptation.ok, `mutation of ${leafPath} was not detected`).toBe(false);
    }
  });

  it('detects a mutated component fingerprint retained against the stored resolved identity', () => {
    const clone = structuredClone(imageCase.profile) as unknown as Record<string, unknown>;
    (clone.componentFingerprints as Record<string, unknown>).oracle = 'c'.repeat(64);
    const adaptation = adaptImageLiveFacts({
      ...imageInput(replacementInput()),
      envelope: {
        ...imageCase.envelope,
        correctnessProfile: clone,
      } as unknown as MaterializedExecutionEnvelopeV1,
    });
    expect(adaptation.ok).toBe(false);
  });

  it('keeps an unrelated valid envelope accepted after the mutation matrix', () => {
    const adaptation = adaptImageLiveFacts(imageInput(replacementInput()));
    expect(adaptation.ok).toBe(true);
    if (adaptation.ok) {
      expect(adaptation.facts.oracleFacts).not.toBeNull();
      expect(adaptation.facts.checks).toHaveLength(CHECK_IDS.length);
      expect(isFullCanonicalFingerprint(imageCase.profile.resolvedFingerprint)).toBe(true);
    }
  });
});

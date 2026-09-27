import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadCatalogueBundle } from '../../src/catalogue/load';
import { resolveAdapterImplementation } from '../../src/adapters/registry';
import {
  CIRCLE_ENVELOPE_GEOMETRY_PROFILE,
  textSpecializedAdapter,
  WARPED_TEXT_READINESS_PROFILE,
} from '../../src/adapters/text-specialized';
import type { TargetResolution } from '../../src/contracts/adapter';
import {
  OBSERVATION_BRIDGE_READ_ONLY_METHODS,
  OBSERVATION_BRIDGE_VERSION,
  OBSERVATION_GLOBAL_NAME,
  SETUP_SEAM_SCHEMA_VERSION,
} from '../../src/contracts/seam';
import {
  ARTWORK_VERIFICATION_RASTER_SCHEMA_VERSION,
  DOCTOR_RESULT_SCHEMA_VERSION,
} from '../../src/contracts/schema-versions';
import {
  circleControlBounds,
  computeCircleWarpFingerprint,
  computeRepresentationFingerprint,
  GEOMETRY_MATRIX_KEYS,
  GEOMETRY_SCHEMA_VERSION,
  GEOMETRY_SPACE_UNITS,
  reconstructWarpControlToSubjectFrame,
  validateTypedGeometry,
  type CircleControlEnvelopeQuadV1,
  type CircleTextFrameProjectionV1,
  type CircleWarpPayloadInput,
  type Quad,
  type TypedGeometryResult,
} from '../../src/contracts/geometry-v2';
import type { ObservationCursor } from '../../src/contracts/observation';
import {
  captureCoherentObservation,
  type CoherentCaptureDeps,
  type StableRendererFingerprint,
  type StampedGeometryView,
} from '../../src/readiness/coherent-capture';
import { buildDoctorBridgeInspectionScript } from '../../src/browser/doctor';
import { sameBridgeMethodSurface } from '../../src/runtime/execute-plan';
import { resolveSkillRoot } from '../../src/runtime/paths';
import { resolveWorkflowSteps } from '../../src/workflows/steps';
import { executeWorkflowSteps, type WorkflowPrimitiveHandlers } from '../../src/workflows/execute';
import type { WorkflowStep } from '../../src/contracts/workflows';

/**
 * WP5 Slice 5-B binding acceptance matrix additions (R11–R15, P2, P5–P7, P10).
 *
 * Focused, browser-free tests for the gaps the implementation record left open:
 * the renderer-local G0/G1 torn-observation matrix and accepted-G1 authority,
 * the exact inline eight-method bridge surface, warped adapter precondition
 * validation, precise primitive/workflow diagnostics, the atomic version
 * lock-step, the monotonic clock default, and the toolkit's product-formula
 * freedom. Product-helper shadow/alignment equality lives in the product
 * projection test; here the binding invariants are asserted at the toolkit
 * boundary.
 */

const TARGET_ID = 'layout-a-text-1';
const LAYOUT_ID = 'layout-a';
const READ_ONLY = [...OBSERVATION_BRIDGE_READ_ONLY_METHODS];

const PAYLOAD: CircleWarpPayloadInput = {
  centerX: 99,
  centerY: 99,
  radius: 99,
  radiusY: 99,
  rotationAngle: -Math.PI / 2,
  arcLength: 0,
  inverted: false,
  verticalAlign: 'center',
  arcAlign: 'end',
};

function cursor(revision: number): ObservationCursor {
  return {
    schemaVersion: 1,
    documentId: 'doc-1',
    documentEpoch: 1,
    bridgeVersion: OBSERVATION_BRIDGE_VERSION,
    bridgeGeneration: 4,
    revision,
  };
}

// ── Coherent capture: renderer-local G0/G1 bracket (R12; tests 41–45) ───────

function geometryView(
  options: {
    envelope?: string | null;
    targetId?: string | null;
    layoutId?: string | null;
    marker?: string;
    revision?: number;
  } = {},
): StampedGeometryView {
  const view: StampedGeometryView = {
    observation: cursor(options.revision ?? 7),
    id: TARGET_ID,
    mounted: true,
    renderer: {
      bridgeGeneration: 4,
      stageFingerprint: 'stage-a',
      targetFingerprint: JSON.stringify({ id: TARGET_ID, x: 1, y: 2 }),
    },
    geometryV2: {
      schemaVersion: 2,
      envelopeFingerprint: options.envelope === undefined ? 'env-a' : options.envelope,
      typedProvenance: {
        target: { id: options.targetId === undefined ? TARGET_ID : options.targetId },
        layout: { id: options.layoutId === undefined ? LAYOUT_ID : options.layoutId },
      },
    },
  };
  if (options.marker !== undefined) {
    (view as unknown as Record<string, unknown>).marker = options.marker;
  }
  return view;
}

function captureHarness(input: {
  g0: StampedGeometryView;
  g1: StampedGeometryView;
  stable?: StableRendererFingerprint | null;
  recapture?: { g0: StampedGeometryView; g1: StampedGeometryView };
  deadlineAt?: number;
  snapshotAdvanceMs?: number;
  recaptureSnapshotAdvanceMs?: number;
  a1DocumentId?: string;
}): { deps: CoherentCaptureDeps; allocated: string[] } {
  let now = 0;
  let reads = 0;
  let cursorReads = 0;
  const allocated: string[] = [];
  const queue = [input.g0, input.g1, input.recapture?.g0, input.recapture?.g1].filter(
    (entry): entry is StampedGeometryView => entry !== undefined,
  );
  let snapshotCount = 0;
  const deps: CoherentCaptureDeps = {
    now: () => now,
    deadlineAt: input.deadlineAt ?? 1_000,
    readCursor: async () => {
      cursorReads += 1;
      const anchored = cursor(7);
      if (cursorReads === 1) return anchored;
      return input.a1DocumentId === undefined
        ? anchored
        : { ...anchored, documentId: input.a1DocumentId };
    },
    readSnapshot: async () => {
      snapshotCount += 1;
      now +=
        snapshotCount === 1
          ? (input.snapshotAdvanceMs ?? 100)
          : (input.recaptureSnapshotAdvanceMs ?? 100);
      return { observation: cursor(7) };
    },
    readGeometry: async () => queue[reads++] ?? (queue[queue.length - 1] as StampedGeometryView),
    targetIds: [TARGET_ID],
    stableRendererFingerprint: input.stable ?? null,
    allocateObservationId: () => {
      allocated.push('observation-1');
      return 'observation-1';
    },
  };
  return { deps, allocated };
}

describe('coherent capture — renderer-local G0/G1 bracket (R12; tests 41–45)', () => {
  it('tears when the A0/A1 document identity differs (test 44)', async () => {
    const { deps, allocated } = captureHarness({
      g0: geometryView(),
      g1: geometryView(),
      a1DocumentId: 'doc-2',
      deadlineAt: 50,
    });
    const result = await captureCoherentObservation(deps);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected torn');
    expect(result.torn[0]?.reason).toBe('document-tear');
    expect(allocated).toEqual([]);
  });

  it('accepts an equal bracket and records only the accepted G1 read', async () => {
    const g0 = geometryView({ marker: 'G0' });
    const g1 = geometryView({ marker: 'G1' });
    const { deps, allocated } = captureHarness({ g0, g1 });
    const result = await captureCoherentObservation(deps);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected acceptance');
    expect(result.observation.attempts).toBe(1);
    expect(result.observation.geometry[TARGET_ID]).toBe(g1);
    expect(
      (result.observation.geometry[TARGET_ID] as unknown as Record<string, unknown>).marker,
    ).toBe('G1');
    expect(allocated).toEqual(['observation-1']);
  });

  it('tears when the G0/G1 envelope fingerprint changes (point/matrix/fingerprint)', async () => {
    const { deps, allocated } = captureHarness({
      g0: geometryView({ envelope: 'env-a' }),
      g1: geometryView({ envelope: 'env-b' }),
      deadlineAt: 50,
    });
    const result = await captureCoherentObservation(deps);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected torn');
    expect(result.torn[0]?.reason).toBe('geometry-bracket-tear');
    expect(allocated).toEqual([]);
  });

  it('tears when the G0/G1 typed target identity changes', async () => {
    const { deps } = captureHarness({
      g0: geometryView({ targetId: TARGET_ID }),
      g1: geometryView({ targetId: 'layout-a-text-2' }),
      deadlineAt: 50,
    });
    const result = await captureCoherentObservation(deps);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected torn');
    expect(result.torn[0]?.reason).toBe('geometry-bracket-tear');
  });

  it('tears when the G0/G1 typed Layout identity changes or is missing', async () => {
    const changed = await captureCoherentObservation(
      captureHarness({
        g0: geometryView({ layoutId: LAYOUT_ID }),
        g1: geometryView({ layoutId: 'layout-b' }),
        deadlineAt: 50,
      }).deps,
    );
    expect(changed.ok).toBe(false);
    if (changed.ok) throw new Error('expected torn');
    expect(changed.torn[0]?.reason).toBe('geometry-bracket-tear');

    const missing = await captureCoherentObservation(
      captureHarness({
        g0: geometryView({ targetId: null }),
        g1: geometryView({ targetId: null }),
        deadlineAt: 50,
      }).deps,
    );
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error('expected torn');
    expect(missing.torn[0]?.reason).toBe('geometry-bracket-tear');
  });

  it('tears when the stable typed envelope no longer matches after quiescence', async () => {
    const { deps, allocated } = captureHarness({
      g0: geometryView({ envelope: 'env-b' }),
      g1: geometryView({ envelope: 'env-b' }),
      stable: {
        bridgeGeneration: 4,
        stageFingerprint: 'stage-a',
        targetFingerprints: { [TARGET_ID]: 'geometry-v2:env-a' },
      },
    });
    const result = await captureCoherentObservation(deps);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected torn');
    expect(result.torn[0]?.reason).toBe('renderer-provenance-tear');
    expect(allocated).toEqual([]);
  });

  it('recaptures a torn candidate inside the original deadline and accepts the retry', async () => {
    const { deps, allocated } = captureHarness({
      g0: geometryView({ envelope: 'env-a' }),
      g1: geometryView({ envelope: 'env-b' }),
      recapture: {
        g0: geometryView({ envelope: 'env-a', marker: 'G0-retry' }),
        g1: geometryView({ envelope: 'env-a', marker: 'G1-retry' }),
      },
      deadlineAt: 1_000,
      snapshotAdvanceMs: 100,
      recaptureSnapshotAdvanceMs: 100,
    });
    const result = await captureCoherentObservation(deps);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected recaptured acceptance');
    expect(result.observation.attempts).toBe(2);
    expect(result.torn.map((entry) => entry.reason)).toEqual(['geometry-bracket-tear']);
    expect(
      (result.observation.geometry[TARGET_ID] as unknown as Record<string, unknown>).marker,
    ).toBe('G1-retry');
    expect(allocated).toHaveLength(1);
  });

  it('stops as OBSERVATION_TORN once the original deadline is exhausted', async () => {
    const { deps, allocated } = captureHarness({
      g0: geometryView({ envelope: 'env-a' }),
      g1: geometryView({ envelope: 'env-b' }),
      deadlineAt: 100,
      snapshotAdvanceMs: 500,
    });
    const result = await captureCoherentObservation(deps);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected torn');
    expect(result.code).toBe('OBSERVATION_TORN');
    expect(result.attempts).toBe(1);
    expect(allocated).toEqual([]);
  });
});

// ── Inline drive inspection: exact eight-method surface (R15; test 33) ──────

interface FakeBridgeOptions {
  extraMethod?: string;
  omitMethod?: string;
  frozen?: boolean;
}

function fakeBridge(options: FakeBridgeOptions = {}): Record<string, unknown> {
  const cursorValue = cursor(0);
  const bridge: Record<string, unknown> = {
    version: OBSERVATION_BRIDGE_VERSION,
    doctor: () => ({
      version: OBSERVATION_BRIDGE_VERSION,
      // A lying self-report: descriptors, not this claim, are authoritative.
      methods: READ_ONLY,
      observation: cursorValue,
      document: {
        documentId: cursorValue.documentId,
        documentEpoch: 1,
        bridgeVersion: OBSERVATION_BRIDGE_VERSION,
      },
      stage: { mounted: true, width: 100, height: 100, layerNames: [] },
      state: {
        rootCount: 1,
        scenegraphRootCount: 1,
        nodeCount: 1,
        layoutCount: 1,
        layerCount: 0,
        scenegraphInSync: true,
      },
    }),
    snapshot: () => ({ layoutItems: [], selectedLayerIds: [], camera: null }),
    elements: () => ({ elements: [] }),
    geometry: () => null,
    raster: () => null,
    cursor: () => cursorValue,
    waitForChange: async () => ({ status: 'timeout' }),
    waitForIdle: async () => ({ observation: cursorValue }),
  };
  if (options.extraMethod !== undefined) bridge[options.extraMethod] = () => null;
  if (options.omitMethod !== undefined) delete bridge[options.omitMethod];
  if (options.frozen === true) Object.freeze(bridge);
  return bridge;
}

describe('inline drive bridge inspection — exact eight-method surface (R15; test 33)', () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>)[OBSERVATION_GLOBAL_NAME];
  });

  async function inspect(
    bridge: Record<string, unknown>,
  ): Promise<{ methods: string[]; doctor: { methods: string[] } }> {
    (window as unknown as Record<string, unknown>)[OBSERVATION_GLOBAL_NAME] = bridge;
    // biome-ignore lint/security/noGlobalEval: the inspection script is a page-realm contract; running it in the window realm is the assertion.
    return (await window.eval(buildDoctorBridgeInspectionScript())) as {
      methods: string[];
      doctor: { methods: string[] };
    };
  }

  it('reads the true callable own surface from descriptors, not the doctor() self-report', async () => {
    const inspection = await inspect(fakeBridge({ extraMethod: 'drive' }));
    expect([...inspection.methods].sort()).toEqual([...READ_ONLY, 'drive'].sort());
    // The bridge lies that its surface is exactly the eight methods.
    expect(inspection.doctor.methods).toEqual(READ_ONLY);
    expect(sameBridgeMethodSurface(inspection.methods)).toBe(false);
  });

  it('rejects a missing method and accepts the exact surface', async () => {
    const missing = await inspect(fakeBridge({ omitMethod: 'raster' }));
    expect(sameBridgeMethodSurface(missing.methods)).toBe(false);

    const exact = await inspect(fakeBridge());
    expect(sameBridgeMethodSurface(exact.methods)).toBe(true);
    expect(exact.methods.sort()).toEqual([...READ_ONLY].sort());
  });

  it('compares by exact set membership of the true own-method surface', () => {
    expect(sameBridgeMethodSurface(['snapshot'])).toBe(false);
    expect(sameBridgeMethodSurface([...READ_ONLY.slice(0, 7), 'drive'])).toBe(false);
    expect(sameBridgeMethodSurface(READ_ONLY)).toBe(true);
  });
});

// ── Warped adapter precondition validation (R11; P10) ───────────────────────

const PADDING = 14;

function rawQuad(): Quad {
  const bounds = circleControlBounds(PAYLOAD);
  if (bounds === null) throw new Error('bounds unavailable');
  return [
    { x: bounds.left, y: bounds.top },
    { x: bounds.right, y: bounds.top },
    { x: bounds.right, y: bounds.bottom },
    { x: bounds.left, y: bounds.bottom },
  ];
}

function projection(): CircleTextFrameProjectionV1 {
  const bounds = circleControlBounds(PAYLOAD);
  if (bounds === null) throw new Error('bounds unavailable');
  const width = bounds.width + PADDING * 2;
  const height = bounds.height + PADDING * 2;
  return {
    kind: 'circle-text-frame-projection-v1',
    padding: { left: PADDING, right: PADDING, top: PADDING, bottom: PADDING },
    controlBounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
    subjectFrame: { width, height, flipCenterX: width / 2, flipCenterY: height / 2 },
    flips: { x: false, y: false },
  };
}

function typedRecord(): TypedGeometryResult {
  const raw = rawQuad();
  const frameProjection = projection();
  const warpControlToSubjectFrame = reconstructWarpControlToSubjectFrame(frameProjection);
  if (warpControlToSubjectFrame === null) throw new Error('projection reconstruction failed');
  const matrices = Object.fromEntries(
    GEOMETRY_MATRIX_KEYS.map((key) => [
      key,
      key === 'warpControlToSubjectFrame'
        ? warpControlToSubjectFrame
        : { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    ]),
  ) as CircleControlEnvelopeQuadV1['matrices'];
  const warpFingerprint = computeCircleWarpFingerprint(PAYLOAD);
  const representationWithoutFingerprints = {
    kind: 'circle-control-envelope-quad-v1' as const,
    pointOrder: ['top-left', 'top-right', 'bottom-right', 'bottom-left'] as const,
    warpType: 'circle' as const,
    units: GEOMETRY_SPACE_UNITS,
    projection: frameProjection,
    warpControlLocal: raw,
    subjectFrameLocal: raw,
    layoutLocal: raw,
    worldScene: raw,
    stageViewportCss: raw,
    browserClientCss: raw,
    matrices,
  };
  const representationFingerprint = computeRepresentationFingerprint({
    representation: representationWithoutFingerprints,
    targetId: TARGET_ID,
    layoutId: LAYOUT_ID,
    cssRatios: { x: 1, y: 1 },
    bridgeGeneration: 1,
    warpFingerprint,
  });
  const representation: CircleControlEnvelopeQuadV1 = {
    ...representationWithoutFingerprints,
    warpFingerprint,
    representationFingerprint,
  };
  return {
    schemaVersion: 2,
    typedProvenance: {
      schemaVersion: 2,
      bridgeGeneration: 1,
      stageFingerprint: 'stage',
      target: {
        id: TARGET_ID,
        konvaId: TARGET_ID,
        nodeClass: 'Group',
        subjectFrameToLayout: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
        fingerprint: 'target',
      },
      layout: {
        id: LAYOUT_ID,
        konvaId: `layout-${LAYOUT_ID}`,
        nodeClass: 'Group',
        layoutToWorldScene: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
        fingerprint: 'layout',
      },
      representationFingerprint,
    },
    representation,
    cssRatios: { x: 1, y: 1 },
  };
}

function canonicalSnapshot(): unknown {
  return [
    {
      id: LAYOUT_ID,
      layers: [
        {
          id: TARGET_ID,
          type: 'TEXT',
          xCoordinate: 0,
          yCoordinate: 0,
          rotation: 0,
          transform: { flipX: false, flipY: false },
          warp: { type: 'circle', payload: PAYLOAD },
        },
      ],
    },
  ];
}

function warpedResolution(): TargetResolution {
  return {
    role: 'target',
    status: 'resolved',
    matchCount: 1,
    matchedElementIds: [TARGET_ID],
    target: {
      role: 'target',
      elementId: TARGET_ID,
      kind: 'text',
      parentId: LAYOUT_ID,
      geometryProfile: CIRCLE_ENVELOPE_GEOMETRY_PROFILE,
    },
    detail: '',
  };
}

function validateWarped(input: {
  typedGeometry?: Record<string, unknown>;
  canonical?: { layoutItems: unknown; expectedLayoutId: string } | undefined;
  resolutions?: TargetResolution[];
}) {
  const adapter = textSpecializedAdapter();
  return adapter.validatePreconditions({
    resolutions: input.resolutions ?? [warpedResolution()],
    geometry: {
      [TARGET_ID]: {
        elementId: TARGET_ID,
        mounted: true,
        visible: true,
        listening: true,
        hasHitPoint: true,
      },
    },
    typedGeometry: input.typedGeometry ?? { [TARGET_ID]: { geometryV2: typedRecord() } },
    canonical:
      'canonical' in input
        ? input.canonical
        : { layoutItems: canonicalSnapshot(), expectedLayoutId: LAYOUT_ID },
  });
}

describe('warped adapter precondition validation (R11; P10)', () => {
  it('accepts a coherent typed circle envelope and contributes the warped profile', () => {
    expect(validateWarped({})).toEqual([]);
    const adapter = textSpecializedAdapter();
    const contribution = adapter.contributeReadiness({
      phase: 'pre-action',
      roles: [
        {
          role: 'target',
          kind: 'text',
          layoutRole: 'active',
          resolution: 'pre-action-existing',
          geometryProfile: 'circle-control-envelope-quad-v1',
        },
      ],
      resolutions: [warpedResolution()],
    });
    expect(contribution.profileId).toBe(WARPED_TEXT_READINESS_PROFILE);
    expect(contribution.targetIds).toEqual([TARGET_ID]);
    const normalized = adapter.normalizeResult([warpedResolution()], 'move', ['geometry.delta']);
    expect(normalized.requiredChecks).toEqual(['geometry.delta', 'geometry.warp-envelope']);
  });

  it('fails closed when the bridge published no typed geometry record', () => {
    const problems = validateWarped({ typedGeometry: {} });
    expect(problems.map((entry) => entry.code)).toEqual(['GEOMETRY_TRANSFORM_INVALID']);
    expect(problems[0]?.context.reason).toBe('TYPED_GEOMETRY_MISSING');
  });

  it('fails closed for a mixed-version schema, representation kind, and target id', () => {
    const schema = typedRecord();
    schema.schemaVersion = 1 as never;
    const schemaProblems = validateWarped({
      typedGeometry: { [TARGET_ID]: { geometryV2: schema } },
    });
    expect(schemaProblems[0]?.code).toBe('GEOMETRY_REPRESENTATION_UNSUPPORTED');
    expect(schemaProblems[0]?.context.reason).toBe('SCHEMA_VERSION_UNSUPPORTED');

    const wrongKind = typedRecord();
    wrongKind.representation = { ...wrongKind.representation, kind: 'aabb-rect-v1' as never };
    const kindProblems = validateWarped({
      typedGeometry: { [TARGET_ID]: { geometryV2: wrongKind } },
    });
    expect(kindProblems[0]?.code).toBe('GEOMETRY_REPRESENTATION_UNSUPPORTED');
    expect(kindProblems[0]?.context.reason).toBe('REPRESENTATION_KIND_UNSUPPORTED');

    const wrongTarget = typedRecord();
    wrongTarget.typedProvenance = {
      ...wrongTarget.typedProvenance,
      target: { ...wrongTarget.typedProvenance.target, id: 'layout-a-text-9' },
    };
    const targetProblems = validateWarped({
      typedGeometry: { [TARGET_ID]: { geometryV2: wrongTarget } },
    });
    expect(targetProblems[0]?.code).toBe('GEOMETRY_TARGET_ID_MISMATCH');
  });

  it('fails closed without canonical facts, for the wrong parent Layout, and without a circle layer', () => {
    const noCanonical = validateWarped({ canonical: undefined });
    expect(noCanonical[0]?.context.reason).toBe('CANONICAL_UNAVAILABLE');

    const wrongLayout = typedRecord();
    wrongLayout.typedProvenance = {
      ...wrongLayout.typedProvenance,
      layout: { ...wrongLayout.typedProvenance.layout, id: 'layout-b' },
    };
    const layoutProblems = validateWarped({
      typedGeometry: { [TARGET_ID]: { geometryV2: wrongLayout } },
    });
    expect(layoutProblems[0]?.code).toBe('GEOMETRY_LAYOUT_ID_MISMATCH');

    const plainSnapshot = [
      {
        id: LAYOUT_ID,
        layers: [
          {
            id: TARGET_ID,
            type: 'TEXT',
            xCoordinate: 0,
            yCoordinate: 0,
            warp: { type: 'none', payload: {} },
          },
        ],
      },
    ];
    const representationProblems = validateWarped({
      canonical: { layoutItems: plainSnapshot, expectedLayoutId: LAYOUT_ID },
    });
    expect(representationProblems[0]?.code).toBe('GEOMETRY_REPRESENTATION_UNSUPPORTED');
    expect(representationProblems[0]?.context.reason).toBe('CANONICAL_REPRESENTATION_UNSUPPORTED');
  });

  it('fails closed for a malformed projection and a degenerate envelope', () => {
    const asymmetric = typedRecord();
    asymmetric.representation = {
      ...asymmetric.representation,
      projection: {
        ...asymmetric.representation.projection,
        padding: { left: PADDING, right: PADDING + 1, top: PADDING, bottom: PADDING },
      },
    };
    const projectionProblems = validateWarped({
      typedGeometry: { [TARGET_ID]: { geometryV2: asymmetric } },
    });
    expect(projectionProblems[0]?.code).toBe('GEOMETRY_REPRESENTATION_UNSUPPORTED');
    expect(projectionProblems[0]?.context.reason).toBe('PADDING_ASYMMETRIC');

    const degenerate = typedRecord();
    const point = { x: 0, y: 0 };
    degenerate.representation = {
      ...degenerate.representation,
      layoutLocal: [point, point, point, point] as unknown as Quad,
    };
    const degenerateProblems = validateWarped({
      typedGeometry: { [TARGET_ID]: { geometryV2: degenerate } },
    });
    expect(degenerateProblems[0]?.code).toBe('GEOMETRY_TRANSFORM_INVALID');
    expect(degenerateProblems[0]?.context.reason).toBe('ENVELOPE_DEGENERATE');
  });

  it('does not run the typed checks for an ordinary (profile-free) role', () => {
    const ordinary: TargetResolution = {
      role: 'target',
      status: 'resolved',
      matchCount: 1,
      matchedElementIds: [TARGET_ID],
      target: { role: 'target', elementId: TARGET_ID, kind: 'text', parentId: LAYOUT_ID },
      detail: '',
    };
    expect(validateWarped({ resolutions: [ordinary], typedGeometry: {} })).toEqual([]);
  });
});

// ── Precise primitive/workflow diagnostics (R14) ────────────────────────────

describe('precise primitive and workflow diagnostics (R14)', () => {
  const bundle = loadCatalogueBundle();
  const steps = resolveWorkflowSteps(bundle.workflowStepCatalogue, 'shared.move')?.steps ?? [];

  function handlers(overrides: Partial<WorkflowPrimitiveHandlers> = {}): WorkflowPrimitiveHandlers {
    return {
      pointerDrag: async () => ({ ok: false, detail: 'unused' }),
      pointerClick: async () => ({ ok: false, detail: 'unused' }),
      controlActivate: async () => ({ ok: false, detail: 'unused' }),
      keyboardPress: async () => ({ ok: false, detail: 'unused' }),
      fileInputSet: async () => ({ ok: false, detail: 'unused' }),
      ...overrides,
    };
  }

  const resolutions: TargetResolution[] = [
    {
      role: 'target',
      status: 'resolved',
      matchCount: 1,
      matchedElementIds: [TARGET_ID],
      target: { role: 'target', elementId: TARGET_ID, kind: 'text', parentId: LAYOUT_ID },
      detail: '',
    },
  ];

  it('preserves a primitive refusal code rather than reporting a workflow-structure code', async () => {
    const result = await executeWorkflowSteps({
      steps,
      operation: { discriminant: 'move.by', parameters: { dx: 80, dy: 40 } },
      resolutions,
      points: { [TARGET_ID]: { x: 10, y: 20 } },
      handlers: handlers({
        pointerDrag: async () => ({
          ok: false,
          detail: 'hit point refused',
          code: 'HIT_POINT_UNAVAILABLE',
        }),
      }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.finding.code).toBe('HIT_POINT_UNAVAILABLE');
  });

  it('keeps structural step failures as workflow diagnostics, not hit-point failures', async () => {
    const structural = await executeWorkflowSteps({
      steps,
      operation: { discriminant: 'move.by', parameters: { dx: 'eighty', dy: 40 } },
      resolutions,
      points: { [TARGET_ID]: { x: 10, y: 20 } },
      handlers: handlers(),
    });
    expect(structural.ok).toBe(false);
    if (structural.ok) throw new Error('expected failure');
    expect(structural.finding.code).toBe('WORKFLOW_STEP_UNKNOWN');
  });

  it('refuses the dedicated restore marker in the generic executor before any resolution or action', async () => {
    const handlerCalls: string[] = [];
    const counted = handlers({
      pointerDrag: async () => {
        handlerCalls.push('pointerDrag');
        return { ok: false, detail: 'unused' };
      },
      controlActivate: async () => {
        handlerCalls.push('controlActivate');
        return { ok: false, detail: 'unused' };
      },
      fileInputSet: async () => {
        handlerCalls.push('fileInputSet');
        return { ok: false, detail: 'unused' };
      },
    });
    const restoreStep: WorkflowStep = {
      stepId: 'restore.capture',
      primitive: 'frontend.restore.capture',
      targetRole: 'target',
      parameters: [],
    };
    // No resolved role and no live point: the marker must be refused before any
    // target-resolution-dependent action, and no primitive handler may run.
    const result = await executeWorkflowSteps({
      steps: [restoreStep],
      operation: { discriminant: 'move.by', parameters: { dx: 80, dy: 40 } },
      resolutions: [],
      points: {},
      handlers: counted,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.finding.code).toBe('WORKFLOW_STEP_UNKNOWN');
    expect(result.finding.detail).toContain('dedicated restore profile');
    expect(handlerCalls).toEqual([]);

    // The same refusal holds even when a target would resolve and a point exists.
    const withTarget = await executeWorkflowSteps({
      steps: [restoreStep],
      operation: { discriminant: 'move.by', parameters: { dx: 80, dy: 40 } },
      resolutions,
      points: { [TARGET_ID]: { x: 10, y: 20 } },
      handlers: counted,
    });
    expect(withTarget.ok).toBe(false);
    if (withTarget.ok) throw new Error('expected failure');
    expect(withTarget.finding.code).toBe('WORKFLOW_STEP_UNKNOWN');
    expect(handlerCalls).toEqual([]);
  });

  it('reports a missing delivered workflow as WORKFLOW_STEPS_UNAVAILABLE', async () => {
    const result = await executeWorkflowSteps({
      steps: [],
      operation: { discriminant: 'move.by', parameters: { dx: 80, dy: 40 } },
      resolutions,
      points: {},
      handlers: handlers(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.finding.code).toBe('WORKFLOW_STEPS_UNAVAILABLE');
  });
});

// ── Atomic version lock-step and mixed-version negatives (R15; P-add 13) ────

describe('atomic v7/v2/v3 version lock-step (R15; ADR 0017 R11)', () => {
  it('pins bridge v7, geometry schema v2, raster schema v3, Doctor v7, setup v1 and adapter v2 together', () => {
    expect(OBSERVATION_BRIDGE_VERSION).toBe(7);
    expect(GEOMETRY_SCHEMA_VERSION).toBe(2);
    expect(ARTWORK_VERIFICATION_RASTER_SCHEMA_VERSION).toBe(3);
    expect(DOCTOR_RESULT_SCHEMA_VERSION).toBe(7);
    expect(SETUP_SEAM_SCHEMA_VERSION).toBe(1);
    expect(READ_ONLY).toHaveLength(8);
    expect(textSpecializedAdapter().compatibilityVersion).toBe(3);
    expect(textSpecializedAdapter().adapterId).toBe('text-specialized');
  });

  it('rejects a mixed adapter compatibility version instead of negotiating', () => {
    const bundle = loadCatalogueBundle();
    for (const compatibilityVersion of [1, 2, 4]) {
      const resolution = resolveAdapterImplementation({
        catalogue: bundle.adapterCatalogue,
        declaration: { adapterId: 'text-specialized', compatibilityVersion },
      });
      expect(resolution.ok).toBe(false);
      if (!resolution.ok) {
        expect(resolution.finding.code).toBe('ADAPTER_IMPLEMENTATION_UNAVAILABLE');
      }
    }
    expect(
      resolveAdapterImplementation({
        catalogue: bundle.adapterCatalogue,
        declaration: { adapterId: 'text-specialized', compatibilityVersion: 3 },
      }).ok,
    ).toBe(true);
  });

  it('rejects a geometry schema version other than v2', () => {
    const record = typedRecord();
    for (const schemaVersion of [1, 3]) {
      const validation = validateTypedGeometry({
        schemaVersion,
        representation: record.representation,
        provenance: record.typedProvenance,
        ratios: record.cssRatios,
      });
      expect(validation.ok).toBe(false);
      if (!validation.ok) {
        expect(validation.failure.code).toBe('GEOMETRY_REPRESENTATION_UNSUPPORTED');
      }
    }
  });
});

// ── Monotonic clock default (R12) ───────────────────────────────────────────

describe('monotonic drive clock (R12)', () => {
  const executePlanSource = (): string =>
    readFileSync(path.join(resolveSkillRoot(), 'src', 'runtime', 'execute-plan.ts'), 'utf8');

  it('defaults the diagnostic drive to performance.now() and never Date.now()', () => {
    const source = executePlanSource();
    expect(source).toContain('input.now ?? (() => performance.now())');
    expect(source).not.toContain('input.now ?? (() => Date.now())');
  });

  it('keeps Date.now() out of the toolkit monotonic clock defaults outside wall timestamps', () => {
    const source = executePlanSource();
    // Date.now() remains permitted only for wall-clock evidence timestamps.
    const dateNowUses = source.match(/Date\.now\(\)/g) ?? [];
    expect(dateNowUses).toHaveLength(0);
  });
});

// ── Toolkit product-formula freedom (P2, P8; P-add 2) ───────────────────────

describe('toolkit owns no product padding formula (P2, P8)', () => {
  function sourceFiles(root: string): string[] {
    const entries = readdirSync(root);
    const files: string[] = [];
    for (const entry of entries) {
      const full = path.join(root, entry);
      if (statSync(full).isDirectory()) {
        files.push(...sourceFiles(full));
      } else if (/\.(ts|tsx)$/.test(entry)) {
        files.push(full);
      }
    }
    return files;
  }

  it('contains no product circle/shadow padding constant or helper reference', () => {
    const skillRoot = resolveSkillRoot();
    const needles = [
      ['computeShadow', 'FramePadding'].join(''),
      ['SHADOW_FRAME', '_OFFSET_SCALE'].join(''),
      ['CIRCLE_FRAME', '_PADDING'].join(''),
      ['CIRCLE_VALIGN', '_TOP_FONT_FACTOR'].join(''),
      ['getTextLayer', 'FramePadding'].join(''),
      ['canonicalCircle', 'FramePadding'].join(''),
      ['shadow', 'ExtraPx'].join(''),
    ];
    const offenders: string[] = [];
    for (const dir of ['src', 'tests']) {
      for (const file of sourceFiles(path.join(skillRoot, dir))) {
        const content = readFileSync(file, 'utf8');
        for (const needle of needles) {
          if (content.includes(needle))
            offenders.push(`${path.relative(skillRoot, file)}:${needle}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';

import {
  findCanonicalImageLayer,
  imageSpecializedAdapter,
  IMAGE_REPLACE_CONTROL_READY_CHECK,
} from '../../src/adapters/image-specialized';
import { loadResourceManifest } from '../../src/catalogue/resources';
import type { ResourceManifestEntry } from '../../src/contracts/resources';
import {
  RASTER_PROBE_SET,
  rasterProbeBackingCoordinate,
  validateRasterRecord,
} from '../../src/contracts/raster';
import { evaluateImageOracle, type ImageOracleInput } from '../../src/oracles/image';
import { IMAGE_RASTER_ACTION_CYCLE_PROFILE } from '../../src/readiness/correlated-gate';
import { captureCoherentObservation } from '../../src/readiness/coherent-capture';
import { executeWorkflowSteps } from '../../src/workflows/execute';
import { parseWorkflowStepCatalogue } from '../../src/workflows/steps';
import type { WorkflowStep } from '../../src/contracts/workflows';
import { deriveWorkflowStepCatalogueFingerprint } from '../../src/catalogue/fingerprint';
import { defaultBundle } from './helpers';

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
    expectedFrame: { x: 90, y: 110, width: 320, height: 240, rotation: 0 },
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
    expectedFrame: { x: 90, y: 110, width: 320, height: 240, rotation: 0 },
    expectedResource: expectedResource(B),
    acceptedUpload: accepted,
    baselineSnapshot: snapshotWith(layer('blob:http://127.0.0.1/a')),
    observedSnapshot: snapshotWith(layer('blob:http://127.0.0.1/b')),
    raster: rasterRecord(B),
    ...overrides,
  };
}

function check(input: ImageOracleInput, checkId: string) {
  const evaluation = evaluateImageOracle(input);
  return evaluation.checks.find((entry) => entry.checkId === checkId) as {
    passed: boolean;
    unusable: boolean;
    detail: string;
  };
}

describe('WP5 Slice 5-C — workflow/step schema migration (R1)', () => {
  it('parses the v4 step-schema-v2 catalogue with the image checkpoints and keeps shared.move intact', () => {
    const bundle = defaultBundle();
    expect(bundle.workflowStepCatalogue.schemaVersion).toBe(4);
    expect(bundle.workflowStepCatalogue.stepSchemaVersion).toBe(2);
    const image = bundle.workflowStepCatalogue.workflows.find(
      (entry) => entry.workflowId === 'image.upload-replace',
    );
    expect(image?.steps).toHaveLength(5);
    expect(image?.steps.filter((step) => step.checkpoint).map((step) => step.checkpoint)).toEqual([
      'after-upload-current',
      'after-replacement-current',
    ]);
    const move = bundle.workflowStepCatalogue.workflows.find(
      (entry) => entry.workflowId === 'shared.move',
    );
    expect(move?.steps[0]?.primitive).toBe('pointer.drag');
    expect(move?.steps[0]?.checkpoint).toBeUndefined();
    expect(deriveWorkflowStepCatalogueFingerprint(bundle.workflowStepCatalogue)).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it('rejects a v3-catalogue/step-v1 state and a duplicate checkpoint', () => {
    const base = {
      schemaVersion: 4,
      stepSchemaVersion: 2,
      workflows: [
        {
          workflowId: 'w',
          capability: 'changeProperties',
          steps: [
            {
              stepId: 's',
              primitive: 'fileInput.set',
              targetRole: 'dialog:test-with-image:file',
              parameters: [],
              checkpoint: 'after-upload-current',
            },
          ],
        },
      ],
    };
    expect(parseWorkflowStepCatalogue(base).stepSchemaVersion).toBe(2);
    expect(() => parseWorkflowStepCatalogue({ ...base, schemaVersion: 2 })).toThrow();
    expect(() => parseWorkflowStepCatalogue({ ...base, stepSchemaVersion: 1 })).toThrow();
    expect(() =>
      parseWorkflowStepCatalogue({
        ...base,
        workflows: [
          {
            ...base.workflows[0],
            steps: [
              base.workflows[0]?.steps?.[0],
              { ...base.workflows[0]?.steps?.[0], stepId: 's2' },
            ],
          },
        ],
      }),
    ).toThrow(/duplicate checkpoint/);
    expect(() =>
      parseWorkflowStepCatalogue({
        ...base,
        workflows: [
          {
            ...base.workflows[0],
            steps: [{ ...base.workflows[0]?.steps?.[0], checkpoint: 'nope' }],
          },
        ],
      }),
    ).toThrow();
  });
});

describe('WP5 Slice 5-C — native workflow executor control/dialog roles', () => {
  it('dispatches control.activate and fileInput.set by declared role without a semantic element', async () => {
    const steps: WorkflowStep[] = [
      {
        stepId: 'c',
        primitive: 'control.activate',
        targetRole: 'control:test-with-image',
        parameters: [],
      },
      {
        stepId: 'f',
        primitive: 'fileInput.set',
        targetRole: 'dialog:test-with-image:file',
        parameters: [{ name: 'resource', operation: 'resource.use', parameter: 'upload-initial' }],
        checkpoint: 'after-upload-current',
      },
    ];
    const calls: string[] = [];
    const result = await executeWorkflowSteps({
      steps,
      operation: undefined,
      resolutions: [],
      points: {},
      handlers: {
        pointerDrag: async () => ({ ok: false, detail: 'no' }),
        pointerClick: async () => ({ ok: false, detail: 'no' }),
        controlActivate: async ({ control }) => {
          calls.push(`control:${control}`);
          return { ok: true, detail: 'ok' };
        },
        keyboardPress: async () => ({ ok: false, detail: 'no' }),
        fileInputSet: async ({ dialogAccessibleName, accept, resourceRole }) => {
          calls.push(`file:${dialogAccessibleName}:${accept}:${resourceRole}`);
          return { ok: true, detail: 'ok' };
        },
      },
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      'control:Test with image',
      'file:Test with image:image/png,image/jpeg:upload-initial',
    ]);
    expect(result.ok && result.logs.map((log) => log.primitive)).toEqual([
      'control.activate',
      'fileInput.set',
    ]);
  });

  it('refuses an unknown control slug and a missing resource binding', async () => {
    const handlers = {
      pointerDrag: async () => ({ ok: false, detail: 'no' }),
      pointerClick: async () => ({ ok: false, detail: 'no' }),
      controlActivate: async () => ({ ok: true, detail: 'ok' }),
      keyboardPress: async () => ({ ok: false, detail: 'no' }),
      fileInputSet: async () => ({ ok: true, detail: 'ok' }),
    };
    const unknown = await executeWorkflowSteps({
      steps: [
        { stepId: 'c', primitive: 'control.activate', targetRole: 'control:nope', parameters: [] },
      ],
      operation: undefined,
      resolutions: [],
      points: {},
      handlers,
    });
    expect(unknown.ok).toBe(false);
    const missing = await executeWorkflowSteps({
      steps: [
        {
          stepId: 'f',
          primitive: 'fileInput.set',
          targetRole: 'dialog:test-with-image:file',
          parameters: [],
        },
      ],
      operation: undefined,
      resolutions: [],
      points: {},
      handlers,
    });
    expect(missing.ok).toBe(false);
  });
});

describe('WP5 Slice 5-C — image adapter role resolution', () => {
  const adapter = imageSpecializedAdapter();
  const elements = [
    { id: TARGET_ID, kind: 'image', parentId: LAYOUT_ID, mounted: true },
    {
      id: 'layout-image-control-image-1',
      kind: 'image',
      parentId: 'layout-image-control',
      mounted: true,
    },
  ];

  it('resolves exactly one active-Layout Image and reports kind-only ambiguity with matchCount 2', () => {
    const active = adapter.resolveTargets({
      phase: 'pre-action',
      roles: [
        {
          role: 'target',
          kind: 'image',
          layoutRole: 'active',
          resolution: 'pre-action-existing',
        },
      ],
      elements,
      activeLayoutId: LAYOUT_ID,
    });
    expect(active[0]?.status).toBe('resolved');
    expect(active[0]?.target?.elementId).toBe(TARGET_ID);

    const kindOnly = adapter.resolveTargets({
      phase: 'pre-action',
      roles: [
        {
          role: 'target',
          kind: 'image',
          layoutRole: 'any',
          resolution: 'pre-action-existing',
        },
      ],
      elements,
      activeLayoutId: LAYOUT_ID,
    });
    expect(kindOnly[0]?.status).toBe('ambiguous');
    expect(kindOnly[0]?.matchCount).toBe(2);
  });

  it('contributes the raster readiness profile and the image checks', () => {
    const readiness = adapter.contributeReadiness({
      phase: 'pre-action',
      roles: [
        { role: 'target', kind: 'image', layoutRole: 'active', resolution: 'pre-action-existing' },
      ],
      resolutions: [
        {
          role: 'target',
          status: 'resolved',
          matchCount: 1,
          matchedElementIds: [TARGET_ID],
          target: { role: 'target', elementId: TARGET_ID, kind: 'image', parentId: LAYOUT_ID },
          detail: '',
        },
      ],
    });
    expect(readiness.profileId).toBe('image-raster-action-cycle-v1');
    const normalized = adapter.normalizeResult([], 'changeProperties', [
      'image.semantic-transition',
    ]);
    expect(normalized.requiredChecks).toEqual(
      expect.arrayContaining([
        'image.semantic-transition',
        'image.raster-current',
        'image.frame-stable',
        'image.structural-visual',
      ]),
    );
  });

  it('requires an exact empty placeholder before the first file action', () => {
    const resolution = {
      role: 'target',
      status: 'resolved' as const,
      matchCount: 1,
      matchedElementIds: [TARGET_ID],
      target: { role: 'target', elementId: TARGET_ID, kind: 'image', parentId: LAYOUT_ID },
      detail: '',
    };
    const geometry = {
      [TARGET_ID]: {
        elementId: TARGET_ID,
        mounted: true,
        visible: true,
        listening: true,
        hasHitPoint: true,
      },
    };
    const ok = adapter.validatePreconditions({
      resolutions: [resolution],
      geometry,
      canonical: { layoutItems: snapshotWith(layer(null)), expectedLayoutId: LAYOUT_ID },
    });
    expect(ok).toEqual([]);
    const bad = adapter.validatePreconditions({
      resolutions: [resolution],
      geometry,
      canonical: { layoutItems: snapshotWith(layer('blob:x')), expectedLayoutId: LAYOUT_ID },
    });
    expect(bad.map((problem) => problem.code)).toContain('RASTER_AUTHORITY_UNUSABLE');
  });

  it('reads canonical placeholder/tested/src facts without parsing anything', () => {
    const facts = findCanonicalImageLayer(snapshotWith(layer('blob:http://x/y')), TARGET_ID);
    expect(facts).toMatchObject({
      parentLayoutId: LAYOUT_ID,
      placeholder: true,
      testedWithImage: true,
    });
    expect(facts?.src).toBe('blob:http://x/y');
    expect(findCanonicalImageLayer([], TARGET_ID)).toBeNull();
  });
});

describe('WP5 Slice 5-C — raster-aware coherent capture (R7, capture order)', () => {
  const cursor = (revision: number) => ({
    schemaVersion: 1,
    documentId: 'doc',
    documentEpoch: 1,
    bridgeVersion: 7,
    bridgeGeneration: 1,
    revision,
  });
  const geometry = {
    id: TARGET_ID,
    observation: cursor(5),
    mounted: true,
    visible: true,
    listening: true,
    hitPoint: { x: 1, y: 1 },
    viewportRect: { x: 0, y: 0, width: 10, height: 10 },
  };

  it('accepts a coherent R0/R1 raster bracket and issues one observation id', async () => {
    const result = await captureCoherentObservation({
      now: () => 0,
      deadlineAt: 1_000,
      readCursor: async () => cursor(5),
      readSnapshot: async () => ({ observation: cursor(5), layoutItems: [] }),
      readGeometry: async () => geometry,
      readRaster: async () => rasterRecord(A) as never,
      targetIds: [TARGET_ID],
      stableRendererFingerprint: null,
      allocateObservationId: () => 'obs-1',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.observation.observationId).toBe('obs-1');
      expect(result.observation.raster[TARGET_ID]).toBeDefined();
    }
  });

  it('tears when R0/R1 raster facts disagree and never issues an observation id', async () => {
    let calls = 0;
    const result = await captureCoherentObservation({
      now: () => 0,
      deadlineAt: 0,
      readCursor: async () => cursor(5),
      readSnapshot: async () => ({ observation: cursor(5), layoutItems: [] }),
      readGeometry: async () => geometry,
      readRaster: async () => {
        calls += 1;
        return rasterRecord(A, { rgbaSha: calls % 2 === 1 ? 'one' : 'two' }) as never;
      },
      targetIds: [TARGET_ID],
      stableRendererFingerprint: null,
      allocateObservationId: () => 'obs-1',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.torn[0]?.reason).toBe('raster-bracket-tear');
  });
});

describe('WP5 Slice 5-C — raster schema validation and image Oracle (tests 16–18, 44–52)', () => {
  it('validates a ready raster record structurally and rejects a malformed one', () => {
    expect(validateRasterRecord(rasterRecord(A)).ok).toBe(true);
    expect(validateRasterRecord({ ...rasterRecord(A), rasterSchemaVersion: 1 }).ok).toBe(false);
    // A durable legacy v2 record is readable evidence but never live authority.
    expect(validateRasterRecord({ ...rasterRecord(A), rasterSchemaVersion: 2 }).ok).toBe(false);
    // A v3 record missing (or lying about) the closed authority discriminant can
    // never launch: mixed bridge/Doctor/raster versions fail closed.
    const { authorityKind: _omitted, ...withoutAuthorityKind } = rasterRecord(A);
    expect(validateRasterRecord(withoutAuthorityKind).ok).toBe(false);
    expect(
      validateRasterRecord({
        ...rasterRecord(A),
        authorityKind: 'generated-vector-projection-v1',
      }).ok,
    ).toBe(false);
    expect(
      validateRasterRecord({
        ...rasterRecord(A),
        rendered: { ...rasterRecord(A).rendered, rgbaByteLength: 4 },
      }).ok,
    ).toBe(false);
  });

  it('exposes the manifest-neutral probe set', () => {
    expect(RASTER_PROBE_SET.map((probe) => probe.id)).toEqual([
      'upper-left',
      'upper-right',
      'lower-left',
      'lower-right',
    ]);
  });

  it('passes the exact upload and replacement Oracles', () => {
    const upload = evaluateImageOracle(uploadInput());
    expect(upload.harnessInvalid).toBe(false);
    expect(upload.checks.every((entry) => entry.passed)).toBe(true);
    const replacement = evaluateImageOracle(replacementInput());
    expect(replacement.harnessInvalid).toBe(false);
    expect(replacement.checks.map((entry) => entry.checkId)).toContain('image.content-distinct');
    expect(replacement.checks.every((entry) => entry.passed)).toBe(true);
  });

  it('fails the named check for a wrong source digest, retained A pixels, wrong probe, wrong alpha and wrong frame', () => {
    expect(
      check(
        uploadInput({
          raster: {
            ...rasterRecord(A),
            source: { ...rasterRecord(A).source, sha256: B.sha256 },
          } as never,
        }),
        'image.raster-current',
      ),
    ).toMatchObject({ passed: false, unusable: false });
    expect(
      check(
        replacementInput({
          raster: {
            ...rasterRecord(B),
            rendered: { ...rasterRecord(B).rendered, rgbaSha256: `rgba-${A.logicalId}` },
          } as never,
        }),
        'image.content-distinct',
      ).passed,
    ).toBe(false);
    const wrongProbe = rasterRecord(A);
    wrongProbe.rendered.probes[0]!.rgba = [0, 0, 0, 255];
    expect(
      check(uploadInput({ raster: wrongProbe as never }), 'image.structural-visual').passed,
    ).toBe(false);
    const emptyAlpha = rasterRecord(A);
    emptyAlpha.rendered.nonTransparentPixelCount = 0;
    expect(check(uploadInput({ raster: emptyAlpha as never }), 'image.raster-current').passed).toBe(
      false,
    );
    expect(
      check(
        uploadInput({ observedSnapshot: snapshotWith(layer('blob:x', { height: 241 })) }),
        'image.frame-stable',
      ).passed,
    ).toBe(false);
    expect(
      check(
        uploadInput({ raster: rasterRecord(A, { id: 'other' }) as never }),
        'image.raster-current',
      ).unusable,
    ).toBe(true);
  });

  it('passes exactly at the channel tolerance boundary and fails immediately outside it', () => {
    const within = rasterRecord(A);
    within.rendered.probes[0]!.rgba = [241, 48, 64, 255];
    expect(check(uploadInput({ raster: within as never }), 'image.structural-visual').passed).toBe(
      true,
    );
    const outside = rasterRecord(A);
    outside.rendered.probes[0]!.rgba = [242, 48, 64, 255];
    expect(check(uploadInput({ raster: outside as never }), 'image.structural-visual').passed).toBe(
      false,
    );
  });

  it('does not require distinctness on the upload checkpoint', () => {
    const evaluation = evaluateImageOracle(uploadInput());
    expect(evaluation.checks.map((entry) => entry.checkId)).not.toContain('image.content-distinct');
    expect(evaluation.harnessInvalid).toBe(false);
  });
});

describe('WP5 Slice 5-C — readiness profile and module surface', () => {
  it('binds one non-extending 8,000 ms resource-render deadline with signal-first cadence', () => {
    expect(IMAGE_RASTER_ACTION_CYCLE_PROFILE.profileId).toBe('image-raster-action-cycle-v1');
    expect(IMAGE_RASTER_ACTION_CYCLE_PROFILE.timingCategory).toBe('RESOURCE_RENDER_V1');
    expect(IMAGE_RASTER_ACTION_CYCLE_PROFILE.deadlineMs).toBe(8_000);
    expect(IMAGE_RASTER_ACTION_CYCLE_PROFILE.signalWatchdogMs).toBe(100);
    expect(IMAGE_RASTER_ACTION_CYCLE_PROFILE.fallbackCadenceMs).toEqual([100, 200, 250]);
  });

  it('exposes the R10 replace-control-ready intermediate check identity', () => {
    expect(IMAGE_REPLACE_CONTROL_READY_CHECK).toBe('image.replace-control-ready');
  });

  // Dynamic import of the delivered image-drive module graph is real in-process
  // work. 60 000 ms is a test budget for that evaluation under parallel workers
  // (the 5 000 ms default is not a production deadline); no assertion is
  // weakened and no retry is used.
  it('exposes the image drive executor as a function (module smoke)', async () => {
    const module = await import('../../src/runtime/execute-image-plan');
    expect(typeof module.executeImagePlan).toBe('function');
  }, 60_000);
});

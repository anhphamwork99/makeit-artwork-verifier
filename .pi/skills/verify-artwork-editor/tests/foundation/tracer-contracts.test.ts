import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { loadCatalogueBundle } from '../../src/catalogue/load';
import { ADAPTER_IMPLEMENTATIONS, resolveAdapterImplementation } from '../../src/adapters/registry';
import { textSpecializedAdapter } from '../../src/adapters/text-specialized';
import type { AdapterElementFact, TargetResolution } from '../../src/contracts/adapter';
import { resolveSkillRoot } from '../../src/runtime/paths';
import {
  parseWorkflowStepCatalogue,
  resolveWorkflowSteps,
  WORKFLOW_STEP_FORBIDDEN_KEYS,
} from '../../src/workflows/steps';
import { executeWorkflowSteps } from '../../src/workflows/execute';
import type { ObservationCursor } from '../../src/contracts/observation';
import {
  awaitCausalTransition,
  type CausalPredicateResult,
  type ReadinessProfile,
} from '../../src/readiness/correlated-gate';
import { captureCoherentObservation } from '../../src/readiness/coherent-capture';
import {
  evaluateGeometryDeltaOracle,
  findCanonicalPosition,
  renderedTransformPosition,
} from '../../src/oracles/geometry';
import { evaluateRequiredChecks } from '../../src/oracles/evaluate';

/**
 * WP5 Slice 5-A tracer contract tests (TS-1 foundation).
 *
 * Everything here is deterministic and browser-free: adapter routing and target
 * classification, declarative workflow-step closure, signal-first readiness
 * timing, coherent-capture tear rejection, and the geometry.delta Oracle.
 */

const bundle = loadCatalogueBundle();

function cursor(revision: number, overrides: Partial<ObservationCursor> = {}): ObservationCursor {
  return {
    schemaVersion: 1,
    documentId: 'doc-1',
    documentEpoch: 1,
    bridgeVersion: 5,
    bridgeGeneration: 4,
    revision,
    ...overrides,
  };
}

function element(overrides: Partial<AdapterElementFact> = {}): AdapterElementFact {
  return { id: 'layer-1', kind: 'text', parentId: 'layout-a', mounted: true, ...overrides };
}

describe('[TS-1] data-routed adapter registry', () => {
  it('resolves the delivered text-specialized adapter at its declared version', () => {
    const resolution = resolveAdapterImplementation({
      catalogue: bundle.adapterCatalogue,
      declaration: { adapterId: 'text-specialized', compatibilityVersion: 3 },
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) throw new Error('expected adapter');
    expect(resolution.adapter.adapterId).toBe('text-specialized');
    expect(ADAPTER_IMPLEMENTATIONS['text-specialized']).toBeDefined();
  });

  it('resolves the delivered default adapter at its declared version', () => {
    const resolution = resolveAdapterImplementation({
      catalogue: bundle.adapterCatalogue,
      declaration: { adapterId: 'default', compatibilityVersion: 1 },
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) throw new Error('expected adapter');
    expect(resolution.adapter.adapterId).toBe('default');
    expect(ADAPTER_IMPLEMENTATIONS.default).toBeDefined();
  });

  it('fails closed on a declared-but-undelivered adapter', () => {
    const catalogue = {
      ...bundle.adapterCatalogue,
      adapters: [
        ...bundle.adapterCatalogue.adapters,
        { adapterId: 'ghost-undelivered', compatibilityVersion: 1 },
      ],
    };
    const resolution = resolveAdapterImplementation({
      catalogue,
      declaration: { adapterId: 'ghost-undelivered', compatibilityVersion: 1 },
    });
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error('expected failure');
    expect(resolution.finding.code).toBe('ADAPTER_IMPLEMENTATION_UNAVAILABLE');
  });

  it('fails closed on an unknown adapter id and a compatibility disagreement', () => {
    const unknown = resolveAdapterImplementation({
      catalogue: bundle.adapterCatalogue,
      declaration: { adapterId: 'ghost-specialized', compatibilityVersion: 1 },
    });
    expect(unknown.ok).toBe(false);
    const mismatch = resolveAdapterImplementation({
      catalogue: bundle.adapterCatalogue,
      declaration: { adapterId: 'text-specialized', compatibilityVersion: 1 },
    });
    expect(mismatch.ok).toBe(false);
    if (mismatch.ok) throw new Error('expected failure');
    expect(mismatch.finding.code).toBe('ADAPTER_IMPLEMENTATION_UNAVAILABLE');
  });
});

describe('[TS-1] Text target resolution classification', () => {
  const adapter = textSpecializedAdapter();

  it('resolves exactly one active-layout Text layer', () => {
    const [resolution] = adapter.resolveTargets({
      phase: 'pre-action',
      roles: [
        {
          role: 'target',
          kind: 'text',
          layoutRole: 'active',
          resolution: 'pre-action-existing',
        },
      ],
      elements: [
        element({ id: 'layout-a-text-1', parentId: 'layout-a' }),
        element({ id: 'layout-b-text-1', parentId: 'layout-b' }),
      ],
      activeLayoutId: 'layout-a',
    });
    expect(resolution?.status).toBe('resolved');
    expect(resolution?.target?.elementId).toBe('layout-a-text-1');
    expect(resolution?.matchCount).toBe(1);
  });

  it('classifies a two-match role as ambiguous with matchCount 2 (before any action)', () => {
    const [resolution] = adapter.resolveTargets({
      phase: 'pre-action',
      roles: [
        { role: 'target', kind: 'text', layoutRole: 'any', resolution: 'pre-action-existing' },
      ],
      elements: [
        element({ id: 'layout-a-text-1', parentId: 'layout-a' }),
        element({ id: 'layout-b-text-1', parentId: 'layout-b' }),
      ],
      activeLayoutId: 'layout-a',
    });
    expect(resolution?.status).toBe('ambiguous');
    expect(resolution?.matchCount).toBe(2);
    expect(resolution?.target).toBeNull();
  });

  it('classifies zero matches as unresolved and an unmounted match as unmounted', () => {
    const adapter2 = textSpecializedAdapter();
    const [unresolved] = adapter2.resolveTargets({
      phase: 'pre-action',
      roles: [
        { role: 'target', kind: 'image', layoutRole: 'any', resolution: 'pre-action-existing' },
      ],
      elements: [element()],
      activeLayoutId: 'layout-a',
    });
    expect(unresolved?.status).toBe('unresolved');
    const [unmounted] = adapter2.resolveTargets({
      phase: 'pre-action',
      roles: [
        {
          role: 'target',
          kind: 'text',
          layoutRole: 'active',
          resolution: 'pre-action-existing',
        },
      ],
      elements: [element({ mounted: false })],
      activeLayoutId: 'layout-a',
    });
    expect(unmounted?.status).toBe('unmounted');
  });

  it('reports hit-point-less and invisible targets as blocking preconditions', () => {
    const resolutions: TargetResolution[] = [
      {
        role: 'target',
        status: 'resolved',
        matchCount: 1,
        matchedElementIds: ['layer-1'],
        target: { role: 'target', elementId: 'layer-1', kind: 'text', parentId: 'layout-a' },
        detail: '',
      },
    ];
    const problems = adapter.validatePreconditions({
      resolutions,
      geometry: {
        'layer-1': {
          elementId: 'layer-1',
          mounted: true,
          visible: true,
          listening: true,
          hasHitPoint: false,
        },
      },
    });
    expect(problems.map((entry) => entry.code)).toEqual(['HIT_POINT_UNAVAILABLE']);
  });
});

describe('[TS-1] declarative workflow-step schema', () => {
  it('parses the delivered v2 step catalogue and resolves shared.move', () => {
    const entry = resolveWorkflowSteps(bundle.workflowStepCatalogue, 'shared.move');
    expect(entry?.steps).toHaveLength(1);
    expect(entry?.steps[0]?.primitive).toBe('pointer.drag');
    expect(entry?.steps[0]?.parameters.map((parameter) => parameter.name).sort()).toEqual([
      'dx',
      'dy',
    ]);
  });

  it.each(
    WORKFLOW_STEP_FORBIDDEN_KEYS,
  )('rejects a step that declares the forbidden key "%s"', (key) => {
    expect(() =>
      parseWorkflowStepCatalogue({
        schemaVersion: 4,
        stepSchemaVersion: 2,
        workflows: [
          {
            workflowId: 'shared.move',
            capability: 'move',
            steps: [
              {
                stepId: 'move.drag',
                primitive: 'pointer.drag',
                targetRole: 'target',
                parameters: [],
                [key]: 80,
              },
            ],
          },
        ],
      }),
    ).toThrow();
  });

  it('rejects an unknown primitive and a literal-coordinate parameter value', () => {
    expect(() =>
      parseWorkflowStepCatalogue({
        schemaVersion: 4,
        stepSchemaVersion: 2,
        workflows: [
          {
            workflowId: 'shared.move',
            capability: 'move',
            steps: [
              { stepId: 'x', primitive: 'dom.evaluate', targetRole: 'target', parameters: [] },
            ],
          },
        ],
      }),
    ).toThrow(/primitive/);
    expect(() =>
      parseWorkflowStepCatalogue({
        schemaVersion: 4,
        stepSchemaVersion: 2,
        workflows: [
          {
            workflowId: 'shared.move',
            capability: 'move',
            steps: [
              {
                stepId: 'x',
                primitive: 'pointer.drag',
                targetRole: 'target',
                parameters: [{ name: 'dx', value: 80 }],
              },
            ],
          },
        ],
      }),
    ).toThrow();
  });

  it('binds primitive parameters from the approved operation and refuses unknown steps', async () => {
    const steps = resolveWorkflowSteps(bundle.workflowStepCatalogue, 'shared.move')?.steps ?? [];
    const handlers = {
      pointerDrag: async (request: { dx: number; dy: number }) => {
        expect(request.dx).toBe(80);
        expect(request.dy).toBe(40);
        return { ok: true, detail: 'dispatched' };
      },
      pointerClick: async () => ({ ok: false, detail: 'no' }),
      controlActivate: async () => ({ ok: false, detail: 'no' }),
      keyboardPress: async () => ({ ok: false, detail: 'no' }),
      fileInputSet: async () => ({ ok: false, detail: 'no' }),
    };
    const resolutions: TargetResolution[] = [
      {
        role: 'target',
        status: 'resolved',
        matchCount: 1,
        matchedElementIds: ['layer-1'],
        target: { role: 'target', elementId: 'layer-1', kind: 'text', parentId: 'layout-a' },
        detail: '',
      },
    ];
    const ok = await executeWorkflowSteps({
      steps,
      operation: { discriminant: 'move.by', parameters: { dx: 80, dy: 40 } },
      resolutions,
      points: { 'layer-1': { x: 10, y: 20 } },
      handlers,
    });
    expect(ok.ok).toBe(true);

    const wrong = await executeWorkflowSteps({
      steps,
      operation: { discriminant: 'move.by', parameters: { dx: 'eighty', dy: 40 } },
      resolutions,
      points: { 'layer-1': { x: 10, y: 20 } },
      handlers,
    });
    expect(wrong.ok).toBe(false);
    if (wrong.ok) throw new Error('expected failure');
    expect(wrong.finding.code).toBe('WORKFLOW_STEP_UNKNOWN');
  });
});

describe('[TS-1] signal-first correlated readiness gate', () => {
  const profile: ReadinessProfile = {
    schemaVersion: 1,
    profileId: 'test-action-cycle',
    timingCategory: 'INTERACTIVE_RENDER_V1',
    deadlineMs: 1_000,
    signalWatchdogMs: 100,
    fallbackCadenceMs: [100, 200, 250],
    stableFrames: 3,
  };

  function harness(options: {
    signalAt: number | null;
    predicateSatisfied: boolean;
    deadlineMs?: number;
    documentMismatchAt?: number | null;
  }) {
    let t = 0;
    let delivered = false;
    const advanced = cursor(6);
    return {
      deps: {
        profile: { ...profile, deadlineMs: options.deadlineMs ?? profile.deadlineMs },
        now: () => t,
        armedAt: 0,
        armCursor: cursor(5),
        waitForChange: async (after: ObservationCursor, timeoutMs: number) => {
          if (options.signalAt !== null && !delivered && t >= options.signalAt) {
            delivered = true;
            return {
              status: 'changed' as const,
              cursor: advanced,
              wakeSource: 'store-signal' as const,
              waitedMs: 0,
            };
          }
          t += timeoutMs;
          return { status: 'timeout' as const, cursor: after, waitedMs: timeoutMs };
        },
        readCursor: async () =>
          options.documentMismatchAt !== null &&
          options.documentMismatchAt !== undefined &&
          t >= options.documentMismatchAt
            ? cursor(6, { documentId: 'doc-2' })
            : advanced,
        evaluateCausalTransition: async (): Promise<CausalPredicateResult> => ({
          satisfied: options.predicateSatisfied,
          detail: options.predicateSatisfied ? 'moved' : 'not the required target transition',
        }),
        sleep: async (ms: number) => {
          t += ms;
        },
      },
    };
  }

  it('accepts a store-signal wake with zero fallback polls', async () => {
    const { deps } = harness({ signalAt: 0, predicateSatisfied: true });
    const result = await awaitCausalTransition(deps);
    expect(result.status).toBe('transition');
    expect(result.wakeSource).toBe('store-signal');
    expect(result.fallbackPollCount).toBe(0);
    expect(result.events.some((event) => event.kind === 'fallback-poll')).toBe(false);
  });

  it('never polls before the 100ms watchdog and then follows the bounded cadence', async () => {
    const { deps } = harness({ signalAt: null, predicateSatisfied: false });
    const result = await awaitCausalTransition(deps);
    expect(result.status).toBe('deadline-exceeded');
    const polls = result.events.filter((event) => event.kind === 'fallback-poll');
    expect(polls.length).toBeGreaterThan(0);
    expect(polls[0]?.atMs).toBeGreaterThanOrEqual(100);
    expect(result.fallbackDelaysMs.slice(0, 4)).toEqual([0, 100, 200, 250]);
    expect(result.remainingMs).toBeLessThanOrEqual(0);
    expect(result.events.map((event) => event.atMs)).toEqual(
      [...result.events.map((event) => event.atMs)].sort((left, right) => left - right),
    );
  });

  it('keeps the single deadline monotonic and never extends it', async () => {
    const { deps } = harness({ signalAt: null, predicateSatisfied: false });
    const result = await awaitCausalTransition(deps);
    const lastEvent = result.events[result.events.length - 1];
    expect(lastEvent?.kind).toBe('deadline-exceeded');
    expect(lastEvent?.atMs).toBeGreaterThanOrEqual(1_000);
    expect(result.remainingMs).toBeLessThanOrEqual(0);
  });

  it('does not accept an unrelated revision wake without the target predicate', async () => {
    const { deps } = harness({ signalAt: 0, predicateSatisfied: false });
    const result = await awaitCausalTransition(deps);
    expect(result.status).toBe('deadline-exceeded');
    expect(result.events.some((event) => event.kind === 'causal-rejected')).toBe(true);
  });

  it('invalidates on a document mismatch during fallback', async () => {
    const { deps } = harness({ signalAt: null, predicateSatisfied: false, documentMismatchAt: 0 });
    const result = await awaitCausalTransition(deps);
    expect(result.status).toBe('invalidated');
    expect(result.invalidatedReason).toBe('document-mismatch');
  });
});

describe('[TS-1] coherent capture tear rejection', () => {
  const target = 'layer-1';
  const stable = {
    bridgeGeneration: 4,
    stageFingerprint: 'stage-a',
    targetFingerprints: { [target]: 'target-a' },
  };

  function captureHarness(overrides: {
    snapshotRevision?: number;
    a1Revision?: number;
    a1Generation?: number;
    geometryRevision?: number;
    geometryTargetFingerprint?: string;
  }) {
    let now = 0;
    let cursorReads = 0;
    const deadlineAt = 1_000;
    return {
      deps: {
        now: () => now,
        deadlineAt,
        readCursor: async () => {
          cursorReads += 1;
          // The first read is anchor A0; later reads are anchor A1.
          if (cursorReads === 1) return cursor(7);
          return cursor(overrides.a1Revision ?? 7, {
            bridgeGeneration: overrides.a1Generation ?? 4,
          });
        },
        readSnapshot: async () => {
          now += 600;
          return {
            observation: cursor(overrides.snapshotRevision ?? 7),
            layoutItems: [{ id: target, xCoordinate: 0, yCoordinate: 0 }],
          };
        },
        readGeometry: async () => ({
          observation: cursor(overrides.geometryRevision ?? 7),
          id: target,
          mounted: true,
          renderer: {
            bridgeGeneration: 4,
            stageFingerprint: 'stage-a',
            targetFingerprint: overrides.geometryTargetFingerprint ?? 'target-a',
          },
        }),
        targetIds: [target],
        stableRendererFingerprint: stable,
        allocateObservationId: () => 'observation-1',
      },
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it('accepts one coherent bundle and assigns exactly one observationId', async () => {
    const { deps } = captureHarness({});
    const result = await captureCoherentObservation(deps);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected acceptance');
    expect(result.observation.observationId).toBe('observation-1');
    expect(result.observation.attempts).toBe(1);
  });

  it('rejects a snapshot store-revision tear', async () => {
    const { deps } = captureHarness({ snapshotRevision: 6 });
    const result = await captureCoherentObservation(deps);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected torn');
    expect(result.torn[0]?.reason).toBe('store-revision-tear');
  });

  it('rejects an A1 store-revision tear', async () => {
    const { deps } = captureHarness({ a1Revision: 8 });
    const result = await captureCoherentObservation(deps);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected torn');
    expect(result.torn[0]?.reason).toBe('store-revision-tear');
  });

  it('rejects a bridge-generation tear', async () => {
    const { deps } = captureHarness({ a1Generation: 5 });
    const result = await captureCoherentObservation(deps);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected torn');
    expect(result.torn[0]?.reason).toBe('generation-tear');
  });

  it('rejects a renderer-provenance tear even when the store revision is unchanged', async () => {
    const { deps } = captureHarness({ geometryTargetFingerprint: 'target-b' });
    const result = await captureCoherentObservation(deps);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected torn');
    expect(result.torn[0]?.reason).toBe('renderer-provenance-tear');
  });
});

describe('[TS-1] geometry.delta Oracle', () => {
  it('passes only when canonical and renderer agree and both meet the minimum', () => {
    const result = evaluateGeometryDeltaOracle({
      minimumDelta: { x: 40, y: 20 },
      canonicalBefore: { x: 125, y: 125 },
      canonicalAfter: { x: 205, y: 165 },
      renderedBefore: { x: 125, y: 125 },
      renderedAfter: { x: 205, y: 165 },
    });
    expect(result.status).toBe('PASS');
    expect(result.sourcesAgree).toBe(true);
  });

  it('fails an impossible required delta without claiming a source rescue', () => {
    const result = evaluateGeometryDeltaOracle({
      minimumDelta: { x: 500, y: 500 },
      canonicalBefore: { x: 125, y: 125 },
      canonicalAfter: { x: 205, y: 165 },
      renderedBefore: { x: 125, y: 125 },
      renderedAfter: { x: 205, y: 165 },
    });
    expect(result.status).toBe('FAIL');
    expect(result.canonicalMet).toBe(false);
    expect(result.sourcesAgree).toBe(true);
  });

  it('reports canonical/renderer disagreement beyond the 0.25 CSS px tolerance', () => {
    const result = evaluateGeometryDeltaOracle({
      minimumDelta: { x: 40, y: 20 },
      canonicalBefore: { x: 0, y: 0 },
      canonicalAfter: { x: 80, y: 40 },
      renderedBefore: { x: 0, y: 0 },
      renderedAfter: { x: 79, y: 40 },
    });
    expect(result.status).toBe('FAIL');
    expect(result.sourcesAgree).toBe(false);
  });

  it('reads the decoration-independent typed node transform from renderer provenance', () => {
    const target = renderedTransformPosition(
      {
        observation: cursor(1),
        id: 'layer-1',
        mounted: true,
        // A selection chrome can move the rect without moving the target.
        sceneRect: { x: 186.4, y: 148.5, width: 171.5, height: 84.2 },
        renderer: {
          bridgeGeneration: 4,
          stageFingerprint: 'stage-a',
          targetFingerprint: 'opaque-equality-fact',
          target: { id: 'layer-1', nodeClass: 'Group', x: 272.2, y: 168.8 },
        },
      },
      'layer-1',
    );
    expect(target).toEqual({ x: 272.2, y: 168.8 });
  });

  it('never parses a fingerprint and never rescues provenance with the AABB rects (R7, R11; test 57)', () => {
    const base = {
      observation: cursor(1),
      id: 'layer-1',
      mounted: true,
      sceneRect: { x: 186.4, y: 148.5, width: 10, height: 10 },
    } as const;
    // No typed provenance: unusable, not an AABB fallback.
    expect(renderedTransformPosition(base)).toBeNull();
    // An embedded JSON "fingerprint" is never parsed: no typed provenance, no position.
    const embeddedJson = JSON.stringify({ id: 'layer-1', x: 272.2, y: 168.8 });
    expect(
      renderedTransformPosition({
        ...base,
        renderer: {
          bridgeGeneration: 4,
          stageFingerprint: 's',
          targetFingerprint: embeddedJson,
          target: null,
        },
      }),
    ).toBeNull();
    // A typed target id that disagrees with the read geometry id is unusable.
    expect(
      renderedTransformPosition({
        ...base,
        renderer: {
          bridgeGeneration: 4,
          stageFingerprint: 's',
          targetFingerprint: 'opaque',
          target: { id: 'layer-other', nodeClass: 'Group', x: 1, y: 2 },
        },
      }),
    ).toBeNull();
    // A typed target id that disagrees with the resolved target id is unusable.
    expect(
      renderedTransformPosition(
        {
          ...base,
          renderer: {
            bridgeGeneration: 4,
            stageFingerprint: 's',
            targetFingerprint: 'opaque',
            target: { id: 'layer-1', nodeClass: 'Group', x: 1, y: 2 },
          },
        },
        'layer-other',
      ),
    ).toBeNull();
    // Non-finite typed coordinates are unusable.
    expect(
      renderedTransformPosition({
        ...base,
        renderer: {
          bridgeGeneration: 4,
          stageFingerprint: 's',
          targetFingerprint: 'opaque',
          target: { id: 'layer-1', nodeClass: 'Group', x: Number.NaN, y: 2 },
        },
      }),
    ).toBeNull();
    // A matching id with finite typed coordinates is the only accepted source.
    expect(
      renderedTransformPosition(
        {
          ...base,
          renderer: {
            bridgeGeneration: 4,
            stageFingerprint: 's',
            targetFingerprint: embeddedJson,
            target: { id: 'layer-1', nodeClass: 'Group', x: 1, y: 2 },
          },
        },
        'layer-1',
      ),
    ).toEqual({ x: 1, y: 2 });
  });

  it('marks a missing source as UNUSABLE rather than a product failure', () => {
    const result = evaluateGeometryDeltaOracle({
      minimumDelta: { x: 40, y: 20 },
      canonicalBefore: { x: 0, y: 0 },
      canonicalAfter: null,
      renderedBefore: { x: 0, y: 0 },
      renderedAfter: { x: 80, y: 40 },
    });
    expect(result.status).toBe('UNUSABLE');
  });

  it('reads canonical positions from nested layoutItems trees', () => {
    const position = findCanonicalPosition(
      [
        {
          id: 'layout-a',
          xCoordinate: 0,
          yCoordinate: 0,
          layers: [{ id: 'nested', xCoordinate: 5, yCoordinate: 6 }],
        },
      ],
      'nested',
    );
    expect(position).toEqual({ x: 5, y: 6 });
  });

  it('treats a required check with no delivered Oracle profile as harness-unusable', () => {
    const evaluation = evaluateRequiredChecks({
      requiredChecks: ['geometry.size'],
      targets: [],
      minimumDelta: { x: 1, y: 1 },
      baseline: { layoutItems: [], geometry: {} },
      observed: { layoutItems: [], geometry: {} },
    });
    expect(evaluation.harnessInvalid).toBe(true);
    expect(evaluation.checks).toEqual([{ checkId: 'geometry.size', passed: false }]);
  });
});

// ── Slice 5-A compatibility — ordinary Text no longer parses fingerprints ────

describe('ordinary Text no longer parses targetFingerprint (R7, R11; test 57)', () => {
  function tsFiles(root: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(root)) {
      const full = path.join(root, entry);
      if (statSync(full).isDirectory()) files.push(...tsFiles(full));
      else if (/\.ts$/.test(entry)) files.push(full);
    }
    return files;
  }

  it('keeps every Oracle and adapter free of fingerprint parsing or semantic fingerprint reads', () => {
    const skillRoot = resolveSkillRoot();
    const offenders: string[] = [];
    for (const dir of ['src/oracles', 'src/adapters']) {
      for (const file of tsFiles(path.join(skillRoot, dir))) {
        const content = readFileSync(file, 'utf8');
        const relative = path.relative(skillRoot, file);
        if (content.includes('JSON.parse')) offenders.push(`${relative}: JSON.parse`);
        if (content.includes('targetFingerprint')) offenders.push(`${relative}: targetFingerprint`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('sources the ordinary renderer position only from typed renderer provenance', () => {
    const source = readFileSync(
      path.join(resolveSkillRoot(), 'src', 'oracles', 'geometry.ts'),
      'utf8',
    );
    expect(source).toContain('geometry.renderer?.target');
    expect(source).not.toContain('JSON.parse');
    expect(source).not.toContain('targetFingerprint');
  });
});

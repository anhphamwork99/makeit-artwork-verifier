import {
  createDiagnostic,
  type DiagnosticCode,
  type DiagnosticRecord,
} from '../contracts/diagnostics';
import type { ObservationCursor, WaitForChangeOutcome, WakeSource } from '../contracts/observation';
import {
  isFullCanonicalFingerprint,
  type ActionCycleCorrectnessIdentity,
} from '../contracts/correctness';
import type { MaterializedExecutionEnvelopeV1 } from '../planner/execution-materialization';
import {
  awaitCausalTransition,
  type CausalPredicateResult,
  type ReadinessEvent,
  type ReadinessProfile,
  type CorrelatedGateResult,
} from '../readiness/correlated-gate';
import {
  captureCoherentObservation,
  type CoherentObservation,
  type StableRendererFingerprint,
  type StampedGeometryView,
  type StampedSnapshotView,
  type TornObservation,
} from '../readiness/coherent-capture';
import {
  evaluateRequiredChecks,
  type NestedOracleContext,
  type OracleEvaluation,
  type OracleLegacyCompositeCheck,
  type OraclePrimitiveFacts,
} from '../oracles/evaluate';
import type { MinimumDelta } from '../oracles/geometry';
import type { WarpedGeometrySource } from '../oracles/warped-text';
import {
  deriveNestedCanonicalChain,
  parseNestedGeometryV3,
  type NestedObjectGeometryContractFailure,
} from '../contracts/geometry-v3';
import { classifyOutcome, type Outcome } from './outcomes';

/**
 * The Action Cycle correctness-identity schema version (ADR 0028 §2). It names
 * the shape of one `ActionCycleCorrectnessIdentity` recorded once per Action
 * Cycle; it is not a policy or catalogue version.
 */
export const ACTION_CYCLE_CORRECTNESS_SCHEMA_VERSION = 1;

/**
 * Binds one Action Cycle correctness identity to the **exact** planning
 * envelope (ADR 0033 §2). Both fingerprints are copied only from the compiled
 * envelope: the resolved-profile fingerprint from
 * `correctnessProfile.resolvedFingerprint` and the readiness fingerprint from
 * `correctnessProfile.componentFingerprints.readiness`. It accepts no
 * caller-supplied profile or readiness fingerprint, performs no catalogue,
 * disk, cache, or fallback lookup, validates both as full canonical
 * fingerprints, requires a non-empty source-owned Action Cycle identifier, and
 * returns a frozen identity.
 *
 * The executor creates the identifier before the corresponding family
 * evaluation from its owned run/allocation identity and family-local cycle
 * scope; no CLI code may create or edit it.
 */
export function bindFinalActionCycleIdentity(input: {
  readonly envelope: MaterializedExecutionEnvelopeV1;
  readonly actionCycleId: string;
}): Readonly<ActionCycleCorrectnessIdentity> {
  const actionCycleId = input.actionCycleId.trim();
  if (actionCycleId.length === 0) {
    throw new Error(
      'bindFinalActionCycleIdentity requires a non-empty source-owned Action Cycle identifier.',
    );
  }
  const profile = input.envelope.correctnessProfile;
  const resolvedProfileFingerprint = profile.resolvedFingerprint;
  const readinessFingerprint = profile.componentFingerprints.readiness;
  if (!isFullCanonicalFingerprint(resolvedProfileFingerprint)) {
    throw new Error(
      'The exact envelope resolved-profile fingerprint is not a full canonical fingerprint.',
    );
  }
  if (!isFullCanonicalFingerprint(readinessFingerprint)) {
    throw new Error(
      'The exact envelope readiness component fingerprint is not a full canonical fingerprint.',
    );
  }
  return Object.freeze({
    schemaVersion: ACTION_CYCLE_CORRECTNESS_SCHEMA_VERSION,
    actionCycleId,
    resolvedProfileFingerprint,
    readinessFingerprint,
  });
}

/**
 * Signal-first action cycle (specification 11; supervisor R5/R6/R7; WP5 Slice 5-A).
 *
 * One monotonic deadline bounds the whole claimed transition: arm → native
 * action → causal transition (signal-first, bounded fallback) → target-aware
 * renderer quiescence → coherent A0/source/A1 capture → Oracle. No phase resets
 * or extends the deadline, and no phase can accept an observation that is not
 * both revision-coherent and renderer-stable.
 *
 * The cycle returns only behaviour-level outcomes (`PASS`/`BUG`/`HARNESS_BLOCKED`);
 * owned-runtime and cleanup failures are the CLI layer's `ENVIRONMENT_FAILURE`.
 */

export interface ActionDispatchResult {
  ok: boolean;
  detail: string;
  /** Precise harness-blocking code when the action/primitive was refused. */
  code?: DiagnosticCode;
  at: string;
}

export interface IdleObservationResult {
  observation: ObservationCursor;
  snapshot: StampedSnapshotView;
  renderer: {
    bridgeGeneration: number;
    stageFingerprint: string;
    targets: readonly {
      id: string;
      fingerprint: string;
      mounted: boolean;
      visible: boolean;
      listening: boolean;
    }[];
  };
}

export interface ActionCycleBaseline {
  cursor: ObservationCursor;
  snapshot: StampedSnapshotView;
  geometry: Readonly<Record<string, StampedGeometryView>>;
}

export interface ActionCycleDeps {
  profile: ReadinessProfile;
  now: () => number;
  targetIds: readonly string[];
  requiredChecks: readonly string[];
  minimumDelta: MinimumDelta | null;
  baseline: ActionCycleBaseline;
  /**
   * When set, the drive evaluates the typed `warped-text-circle-move-v1`
   * profile: `geometry.delta` plus `geometry.warp-envelope`, with the accepted
   * parent Layout id. It is `null` for the ordinary 5-A drive.
   */
  warpedExpectedLayoutId?: string | null;
  /**
   * Present for the nested-object affine profile (WP5 Slice 5-D). The cycle
   * reads the pair-explicit typed geometry and evaluates the typed nested
   * Oracle instead of the ordinary delta profile.
   */
  nestedTarget?: {
    targetId: string;
    witnessId: string;
    layoutId: string;
    requestedPointerDeltaCss: { x: number; y: number };
  } | null;
  readCursor: () => Promise<ObservationCursor>;
  readSnapshot: () => Promise<StampedSnapshotView>;
  readGeometry: (id: string) => Promise<StampedGeometryView>;
  waitForChange: (after: ObservationCursor, timeoutMs: number) => Promise<WaitForChangeOutcome>;
  waitForIdle: (options: {
    targets: readonly string[];
    stableFrames: number;
    timeoutMs: number;
    nested?: { targetId: string; witnessId: string; layoutId: string };
  }) => Promise<IdleObservationResult>;
  evaluateCausalTransition: (cursor: ObservationCursor) => Promise<CausalPredicateResult>;
  performAction: () => Promise<ActionDispatchResult>;
  sleep?: (ms: number) => Promise<void>;
}

export interface ActionCycleTimings {
  armedAtMs: number;
  actionCompletedAtMs: number;
  transitionAtMs: number | null;
  quiescentAtMs: number | null;
  capturedAtMs: number | null;
  deadlineAtMs: number;
  totalMs: number | null;
}

export interface ActionCycleResult {
  behaviorOutcome: Extract<Outcome, 'PASS' | 'BUG' | 'HARNESS_BLOCKED'>;
  /**
   * @deprecated Private/deprecated legacy composite mirror retained for staging
   * compile until E3-S2. Never the source of a final status.
   */
  requiredChecks: readonly OracleLegacyCompositeCheck[];
  /**
   * @deprecated Legacy aggregate source-agreement flag retained for staging
   * compile until E3-S2. The additive `primitiveFacts.sourcesAgree` is
   * authoritative.
   */
  requiredSourcesAgree: boolean;
  /**
   * @deprecated Legacy aggregate harness-validity side channel retained for
   * staging compile until E3-S2. Not part of the primitive-fact authority.
   */
  harnessInvalid: boolean;
  /**
   * The additive primitive observation facts of the evaluated Oracle (ADR 0032
   * §E3-S1). The accepted B2 live-fact adapters consume this view; it never
   * reads the deprecated composite fields above.
   */
  primitiveFacts: OraclePrimitiveFacts;
  diagnostics: readonly DiagnosticRecord[];
  events: readonly ReadinessEvent[];
  wakeSource: WakeSource;
  fallbackPollCount: number;
  observation: CoherentObservation | null;
  action: ActionDispatchResult;
  gate: CorrelatedGateResult | null;
  oracle: OracleEvaluation | null;
  torn: readonly TornObservation[];
  timings: ActionCycleTimings;
  detail: string;
}

function toStableRendererFingerprint(idle: IdleObservationResult): StableRendererFingerprint {
  return {
    bridgeGeneration: idle.renderer.bridgeGeneration,
    stageFingerprint: idle.renderer.stageFingerprint,
    targetFingerprints: Object.fromEntries(
      idle.renderer.targets.map((target) => [target.id, target.fingerprint]),
    ),
  };
}

/** The typed geometry source a warped Oracle evaluation consumes. */
function warpedGeometrySource(
  layoutItems: unknown,
  geometry: StampedGeometryView | undefined,
): WarpedGeometrySource {
  return {
    layoutItems,
    geometryV2: (geometry?.geometryV2 as WarpedGeometrySource['geometryV2']) ?? null,
  };
}

/**
 * The explicit `malformed` primitive facts for a cycle that produced no readable
 * Oracle evaluation (a refused action, an invalidated/deadline gate, a torn
 * capture, or a nested-authority failure): no source agreement and no check
 * predicate met. It is the fail-closed default of the additive primitive surface
 * and reads neither the deprecated composite check set nor the `harnessInvalid`
 * side channel.
 */
function malformedPrimitiveFacts(requiredChecks: readonly string[]): OraclePrimitiveFacts {
  return {
    authority: 'malformed',
    sourcesAgree: false,
    checks: [...requiredChecks].sort().map((checkId) => ({ checkId, predicateMet: false })),
  };
}

export async function runActionCycle(deps: ActionCycleDeps): Promise<ActionCycleResult> {
  const diagnostics: DiagnosticRecord[] = [];
  const nested = deps.nestedTarget ?? null;
  // The nested capture reads one paired typed observation keyed by the drag
  // target; the witness is carried inside that record. The idle fingerprint
  // still observes the explicit target + witness pair.
  const captureTargetIds = nested === null ? deps.targetIds : [nested.targetId];
  const idleTargetIds = nested === null ? deps.targetIds : [nested.targetId, nested.witnessId];
  const armedAt = deps.now();
  const deadlineAt = armedAt + deps.profile.deadlineMs;
  const requiredChecks = [...deps.requiredChecks].sort();
  const timings: ActionCycleTimings = {
    armedAtMs: 0,
    actionCompletedAtMs: 0,
    transitionAtMs: null,
    quiescentAtMs: null,
    capturedAtMs: null,
    deadlineAtMs: deadlineAt - armedAt,
    totalMs: null,
  };

  const finish = (input: {
    outcome: Extract<Outcome, 'PASS' | 'BUG' | 'HARNESS_BLOCKED'>;
    checks: readonly OracleLegacyCompositeCheck[];
    sourcesAgree: boolean;
    harnessInvalid: boolean;
    gate: CorrelatedGateResult | null;
    oracle: OracleEvaluation | null;
    observation: CoherentObservation | null;
    torn: readonly TornObservation[];
    action: ActionDispatchResult;
    detail: string;
  }): ActionCycleResult => {
    timings.totalMs = Math.round(deps.now() - armedAt);
    return {
      behaviorOutcome: input.outcome,
      requiredChecks: input.checks,
      requiredSourcesAgree: input.sourcesAgree,
      harnessInvalid: input.harnessInvalid,
      primitiveFacts: input.oracle?.primitiveFacts ?? malformedPrimitiveFacts(requiredChecks),
      diagnostics,
      events: input.gate?.events ?? [],
      wakeSource: input.gate?.wakeSource ?? 'none',
      fallbackPollCount: input.gate?.fallbackPollCount ?? 0,
      observation: input.observation,
      action: input.action,
      gate: input.gate,
      oracle: input.oracle,
      torn: input.torn,
      timings,
      detail: input.detail,
    };
  };

  const failedChecks = (): OracleLegacyCompositeCheck[] =>
    requiredChecks.map((checkId) => ({ checkId, passed: false }));

  const classify = (input: {
    checks: readonly OracleLegacyCompositeCheck[];
    sourcesAgree: boolean;
    harnessInvalid: boolean;
  }): Extract<Outcome, 'PASS' | 'BUG' | 'HARNESS_BLOCKED'> => {
    const outcome = classifyOutcome({
      requiredChecks: input.checks,
      cleanupSucceeded: true,
      requiredSourcesAgree: input.sourcesAgree,
      harnessInvalid: input.harnessInvalid,
      environmentInvalid: false,
    });
    // The cycle never produces ENVIRONMENT_FAILURE: owned-runtime failure is the
    // CLI layer's responsibility and would mean no trustworthy action occurred.
    return outcome === 'ENVIRONMENT_FAILURE' ? 'HARNESS_BLOCKED' : outcome;
  };

  // ── 3. Native action after arm ────────────────────────────────────────────
  const action = await deps.performAction();
  timings.armedAtMs = 0;
  timings.actionCompletedAtMs = Math.round(deps.now() - armedAt);
  if (!action.ok) {
    const code = action.code ?? 'HIT_POINT_UNAVAILABLE';
    diagnostics.push(createDiagnostic(code, action.detail, { context: { phase: 'action' } }));
    return finish({
      outcome: 'HARNESS_BLOCKED',
      checks: failedChecks(),
      sourcesAgree: true,
      harnessInvalid: true,
      gate: null,
      oracle: null,
      observation: null,
      torn: [],
      action,
      detail: `Native action was refused before dispatch: ${action.detail}`,
    });
  }

  // ── 4. Causal transition (signal-first, bounded fallback) ─────────────────
  const gate = await awaitCausalTransition({
    profile: deps.profile,
    now: deps.now,
    armedAt,
    armCursor: deps.baseline.cursor,
    waitForChange: deps.waitForChange,
    readCursor: deps.readCursor,
    evaluateCausalTransition: deps.evaluateCausalTransition,
    sleep: deps.sleep,
  });

  if (gate.status === 'invalidated') {
    diagnostics.push(
      createDiagnostic(
        'UNUSABLE_EVIDENCE',
        `Observation authority was invalidated during readiness: ${gate.invalidatedReason ?? 'unknown'}.`,
      ),
    );
    return finish({
      outcome: 'HARNESS_BLOCKED',
      checks: failedChecks(),
      sourcesAgree: true,
      harnessInvalid: true,
      gate,
      oracle: null,
      observation: null,
      torn: [],
      action,
      detail: `Readiness authority invalidated: ${gate.invalidatedReason ?? 'unknown'}.`,
    });
  }

  if (gate.status === 'deadline-exceeded') {
    // Valid native action against authoritative state, intact signal/capture
    // contract, but no required causal transition by the deadline: a product
    // non-convergence (`BUG`), not a harness failure.
    diagnostics.push(
      createDiagnostic(
        'PRODUCT_TRANSITION_NOT_OBSERVED',
        `No required causal transition was observed within the ${deps.profile.deadlineMs}ms readiness deadline after a valid native action.`,
      ),
    );
    return finish({
      outcome: 'BUG',
      checks: failedChecks(),
      sourcesAgree: true,
      harnessInvalid: false,
      gate,
      oracle: null,
      observation: null,
      torn: [],
      action,
      detail: `Product transition not observed within the ${deps.profile.deadlineMs}ms deadline (fallback probes: ${gate.fallbackPollCount}).`,
    });
  }

  timings.transitionAtMs = Math.round(deps.now() - armedAt);

  // ── 5. Target-aware renderer quiescence ───────────────────────────────────
  const remainingForIdle = deadlineAt - deps.now();
  let idle: IdleObservationResult;
  try {
    idle = await deps.waitForIdle({
      targets: idleTargetIds,
      stableFrames: deps.profile.stableFrames,
      timeoutMs: Math.max(0, remainingForIdle),
      ...(nested === null
        ? {}
        : {
            nested: {
              targetId: nested.targetId,
              witnessId: nested.witnessId,
              layoutId: nested.layoutId,
            },
          }),
    });
  } catch (error) {
    const deadlinePassed = deps.now() >= deadlineAt;
    const detail = `Target-aware renderer quiescence did not settle: ${(error as Error).message}`;
    diagnostics.push(
      createDiagnostic(
        deadlinePassed ? 'READINESS_DEADLINE_EXCEEDED' : 'UNUSABLE_EVIDENCE',
        detail,
      ),
    );
    return finish({
      outcome: 'HARNESS_BLOCKED',
      checks: failedChecks(),
      sourcesAgree: true,
      harnessInvalid: true,
      gate,
      oracle: null,
      observation: null,
      torn: [],
      action,
      detail,
    });
  }
  timings.quiescentAtMs = Math.round(deps.now() - armedAt);
  const stableRenderer = toStableRendererFingerprint(idle);

  // ── 6. Coherent A0 → sources → A1 capture ────────────────────────────────
  const capture = await captureCoherentObservation({
    now: deps.now,
    deadlineAt,
    readCursor: deps.readCursor,
    readSnapshot: deps.readSnapshot,
    readGeometry: deps.readGeometry,
    targetIds: captureTargetIds,
    stableRendererFingerprint: stableRenderer,
  });

  if (!capture.ok) {
    diagnostics.push(
      createDiagnostic(
        'OBSERVATION_TORN',
        `Coherent observation could not be captured (${capture.code}) after ${capture.attempts} attempt(s): ${capture.torn
          .map((entry) => entry.reason)
          .join(', ')}. First cause: ${capture.torn[0]?.detail ?? 'none'}`,
      ),
    );
    return finish({
      outcome: 'HARNESS_BLOCKED',
      checks: failedChecks(),
      sourcesAgree: true,
      harnessInvalid: true,
      gate,
      oracle: null,
      observation: null,
      torn: capture.torn,
      action,
      detail: `Observation capture unusable: ${capture.code}.`,
    });
  }
  timings.capturedAtMs = Math.round(deps.now() - armedAt);

  // ── 6b. Post-action interaction diagnostic (non-blocking) ────────────────
  const postInteraction = capture.observation.postActionInteraction;
  if (postInteraction !== null && postInteraction.accepted !== null) {
    const accepted = postInteraction.accepted;
    if (accepted.status === 'obstructed') {
      diagnostics.push(
        createDiagnostic(
          'POST_ACTION_HIT_OBSTRUCTED',
          `The deterministic post-action observation probe resolved to ${String(
            accepted.hitClassification,
          )}; the target/witness/Layout geometry remains authoritative and no hit ownership is claimed.`,
          {
            context: {
              phase: 'post-action',
              candidate: String(accepted.candidate),
              hitClassification: String(accepted.hitClassification),
              obstructionCode: String(accepted.obstructionCode),
              diagnosticStableAcrossG0G1: String(postInteraction.diagnosticStableAcrossG0G1),
              authority: 'none',
            },
          },
        ),
      );
    }
  }

  // ── 6c. Selection retention (authoritative product fact) ────────────────
  if (nested !== null) {
    const acceptedSnapshot = capture.observation.snapshot as unknown as {
      activeLayoutId?: unknown;
      primarySelectedLayerId?: unknown;
      selectedLayerIds?: unknown;
      optimisticSelectedLayerId?: unknown;
    };
    const selectedLayerIds = Array.isArray(acceptedSnapshot.selectedLayerIds)
      ? acceptedSnapshot.selectedLayerIds.filter(
          (entry): entry is string => typeof entry === 'string',
        )
      : null;
    const selectionRetained =
      acceptedSnapshot.activeLayoutId === nested.layoutId &&
      acceptedSnapshot.primarySelectedLayerId === nested.targetId &&
      selectedLayerIds !== null &&
      selectedLayerIds.length === 1 &&
      selectedLayerIds[0] === nested.targetId &&
      acceptedSnapshot.optimisticSelectedLayerId === null;
    if (!selectionRetained) {
      diagnostics.push(
        createDiagnostic(
          'PRODUCT_SELECTION_NOT_RETAINED',
          `The accepted post-action snapshot no longer selects "${nested.targetId}" in Layout "${nested.layoutId}" after a safe native dispatch (activeLayoutId=${String(
            acceptedSnapshot.activeLayoutId,
          )}, primarySelectedLayerId=${String(
            acceptedSnapshot.primarySelectedLayerId,
          )}, selectedLayerIds=${JSON.stringify(selectedLayerIds)}, optimisticSelectedLayerId=${String(
            acceptedSnapshot.optimisticSelectedLayerId,
          )}).`,
        ),
      );
      return finish({
        outcome: 'BUG',
        checks: failedChecks(),
        sourcesAgree: true,
        harnessInvalid: false,
        gate,
        oracle: null,
        observation: capture.observation,
        torn: capture.torn,
        action,
        detail:
          'Trustworthy selection loss after a safe native dispatch: PRODUCT_SELECTION_NOT_RETAINED.',
      });
    }
  }

  // ── 7. Oracle (accepted observation only) ────────────────────────────────
  let nestedContext: NestedOracleContext | null = null;
  if (nested !== null) {
    const baselineView = deps.baseline.geometry[nested.targetId];
    const observedView = capture.observation.geometry[nested.targetId];
    const beforeDerived = deriveNestedCanonicalChain({
      layoutItems: deps.baseline.snapshot.layoutItems,
      targetId: nested.targetId,
      witnessId: nested.witnessId,
      layoutId: nested.layoutId,
    });
    const afterDerived = deriveNestedCanonicalChain({
      layoutItems: capture.observation.snapshot.layoutItems,
      targetId: nested.targetId,
      witnessId: nested.witnessId,
      layoutId: nested.layoutId,
    });
    const nestedFailure = (
      failure: NestedObjectGeometryContractFailure,
      detail: string,
    ): ActionCycleResult => {
      diagnostics.push(
        createDiagnostic(failure.code, failure.detail, {
          context: { ...failure.context, reason: failure.reason },
        }),
      );
      return finish({
        outcome: 'HARNESS_BLOCKED',
        checks: failedChecks(),
        sourcesAgree: true,
        harnessInvalid: true,
        gate,
        oracle: null,
        observation: capture.observation,
        torn: capture.torn,
        action,
        detail,
      });
    };
    if (!baselineView || !observedView) {
      return finish({
        outcome: 'HARNESS_BLOCKED',
        checks: failedChecks(),
        sourcesAgree: true,
        harnessInvalid: true,
        gate,
        oracle: null,
        observation: capture.observation,
        torn: capture.torn,
        action,
        detail: 'The accepted observation carries no paired nested geometry view.',
      });
    }
    if (!beforeDerived.ok)
      return nestedFailure(
        beforeDerived.failure,
        'Nested canonical chain unavailable before action.',
      );
    if (!afterDerived.ok)
      return nestedFailure(
        afterDerived.failure,
        'Nested canonical chain unavailable after action.',
      );
    const beforeParse = parseNestedGeometryV3({
      raw: baselineView.geometryV3,
      expected: {
        targetId: nested.targetId,
        witnessId: nested.witnessId,
        layoutId: nested.layoutId,
        chain: beforeDerived.derivation.chain,
      },
    });
    if (!beforeParse.ok)
      return nestedFailure(
        beforeParse.failure,
        'Baseline nested geometry-v3 authority is unusable.',
      );
    const afterParse = parseNestedGeometryV3({
      raw: observedView.geometryV3,
      expected: {
        targetId: nested.targetId,
        witnessId: nested.witnessId,
        layoutId: nested.layoutId,
        chain: afterDerived.derivation.chain,
      },
    });
    if (!afterParse.ok)
      return nestedFailure(
        afterParse.failure,
        'Observed nested geometry-v3 authority is unusable.',
      );
    nestedContext = {
      targetId: nested.targetId,
      witnessId: nested.witnessId,
      layoutId: nested.layoutId,
      requestedPointerDeltaCss: nested.requestedPointerDeltaCss,
      baseline: {
        geometry: beforeParse.geometry,
        layoutItems: deps.baseline.snapshot.layoutItems,
      },
      observed: {
        geometry: afterParse.geometry,
        layoutItems: capture.observation.snapshot.layoutItems,
      },
    };
  }
  const targets = deps.targetIds.map((elementId) => ({ role: 'target', elementId }));
  const warpedExpectedLayoutId = deps.warpedExpectedLayoutId ?? null;
  const oracle = evaluateRequiredChecks({
    requiredChecks,
    targets,
    minimumDelta: deps.minimumDelta ?? { x: Number.NaN, y: Number.NaN },
    baseline: {
      layoutItems: deps.baseline.snapshot.layoutItems,
      geometry: deps.baseline.geometry,
    },
    observed: {
      layoutItems: capture.observation.snapshot.layoutItems,
      geometry: capture.observation.geometry,
    },
    ...(nestedContext === null ? {} : { nestedTarget: nestedContext }),
    ...(warpedExpectedLayoutId === null
      ? {}
      : {
          warpedTarget: {
            targetId: deps.targetIds[0] as string,
            expectedLayoutId: warpedExpectedLayoutId,
            baseline: warpedGeometrySource(
              deps.baseline.snapshot.layoutItems,
              deps.baseline.geometry[deps.targetIds[0] as string],
            ),
            observed: warpedGeometrySource(
              capture.observation.snapshot.layoutItems,
              capture.observation.geometry[deps.targetIds[0] as string],
            ),
          },
        }),
  });
  diagnostics.push(...oracle.diagnostics);

  const outcome = classify({
    checks: oracle.checks,
    sourcesAgree: oracle.requiredSourcesAgree,
    harnessInvalid: oracle.harnessInvalid,
  });

  return finish({
    outcome,
    checks: oracle.checks,
    sourcesAgree: oracle.requiredSourcesAgree,
    harnessInvalid: oracle.harnessInvalid,
    gate,
    oracle,
    observation: capture.observation,
    torn: capture.torn,
    action,
    detail:
      oracle.nested !== null
        ? `nested-object-move-v1 evaluated: ${oracle.checks
            .map((check) => `${check.checkId}=${check.passed ? 'PASS' : 'FAIL'}`)
            .join(', ')}.`
        : oracle.warped !== null
          ? `warped-text-circle-move-v1 evaluated: ${oracle.warped.checks
              .map((check) => `${check.checkId}=${check.passed ? 'PASS' : 'FAIL'}`)
              .join(', ')}.`
          : (oracle.geometry?.detail ??
            `Oracle evaluated ${oracle.checks.length} required check(s).`),
  });
}

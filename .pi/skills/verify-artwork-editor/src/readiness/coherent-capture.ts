import { randomUUID } from 'node:crypto';

import type { ObservationCursor } from '../contracts/observation';
import { cursorKey, cursorsEqual } from '../contracts/observation';

/**
 * Coherent observation capture: anchor A0 → sources → anchor A1 (supervisor R7,
 * specification 11).
 *
 * A single store cursor is necessary but not sufficient: a multi-source
 * state/renderer capture is coherent only when every stamped payload shares the
 * same document, epoch, bridge version/generation and revision *and* the
 * renderer provenance consumed by the Oracle still matches the stable renderer
 * fingerprint the quiescence stage established. A torn candidate is excluded
 * from authority and may be recaptured only inside the original deadline; only
 * an accepted bundle receives one `observationId`.
 */

export interface BridgeRendererTargetProvenance {
  /** Live Konva node id; equals the semantic element id for non-FRAME nodes. */
  id: string;
  nodeClass?: string;
  /** Finite live node-transform position; never the AABB rect. */
  x: number;
  y: number;
}

export interface BridgeRendererProvenance {
  bridgeGeneration: number;
  stageFingerprint: string;
  targetFingerprint: string;
  /**
   * Typed live target provenance published by bridge v4. The ordinary-Text
   * Oracle reads this directly; `targetFingerprint` stays an opaque equality
   * fact and is never parsed for semantic fields (R7, R11).
   */
  target?: BridgeRendererTargetProvenance | null;
}

export interface StampedSnapshotView {
  observation: ObservationCursor;
  [key: string]: unknown;
}

export interface StampedGeometryView {
  observation: ObservationCursor;
  id: string;
  mounted: boolean;
  visible?: boolean;
  listening?: boolean;
  sceneRect?: { x: number; y: number; width: number; height: number };
  stageRect?: { x: number; y: number; width: number; height: number };
  viewportRect?: { x: number; y: number; width: number; height: number };
  hitPoint?: { x: number; y: number };
  renderer?: BridgeRendererProvenance;
  /**
   * Typed geometry schema v2 (bridge v4). Present only for the circle-warped
   * Text representation; carries the opaque envelope identity used by the
   * G0/G1 bracket.
   */
  geometryV2?: {
    schemaVersion?: unknown;
    envelopeFingerprint?: unknown;
    representation?: { representationFingerprint?: unknown } | null;
    typedProvenance?: {
      target?: { id?: unknown } | null;
      layout?: { id?: unknown } | null;
    } | null;
  } | null;
  /**
   * Typed geometry schema v3 (bridge v7, WP5 Slice 5-D). Present only for a
   * pair-explicit nested-object request; the representation fingerprint covers
   * target, witness, chain, matrices, points, camera, and CSS ratios.
   */
  geometryV3?: {
    schemaVersion?: unknown;
    representation?: { representationFingerprint?: unknown } | null;
    typedProvenance?: {
      target?: { id?: unknown } | null;
      witness?: { id?: unknown } | null;
      layout?: { id?: unknown } | null;
    } | null;
    /** Purpose-scoped interaction member (ADR 0014 R6); diagnostic only. */
    interaction?: unknown;
    recordFingerprint?: unknown;
  } | null;
  /** Structured non-throwing failure for a typed geometry-v3 request. */
  geometryV3Failure?: { code?: unknown; reason?: unknown; detail?: unknown } | null;
}

export interface StableRendererFingerprint {
  bridgeGeneration: number;
  stageFingerprint: string;
  targetFingerprints: Readonly<Record<string, string>>;
}

/**
 * Structural raster view consumed by the raster-aware bracket (WP5 Slice 5-C).
 * Only typed digest/dimension/probe fields and the opaque fingerprint are read
 * for equality; nothing is parsed for semantic fields.
 */
export interface RasterProbeView {
  probeSetId?: unknown;
  probeId: string;
  backingX: number;
  backingY: number;
  rgba: readonly number[];
}

/**
 * Internal start/end anchors the product publishes for one asynchronous raster
 * acquisition (supervisor R4/R12). Retained so a dedicated test can assert
 * directly that both anchors and the stability flags agree, and so the bracket
 * can tear on any one-field disagreement.
 */
export interface RasterCaptureView {
  method?: unknown;
  started?: ObservationCursor;
  completed?: ObservationCursor;
  sourceStable?: unknown;
  rendererStable?: unknown;
  boundsStable?: unknown;
}

export interface RasterRegionView {
  coordinateSpace?: unknown;
  x?: unknown;
  y?: unknown;
  width?: unknown;
  height?: unknown;
  backingScaleX?: unknown;
  backingScaleY?: unknown;
}

export interface RasterBracketView {
  rasterSchemaVersion?: unknown;
  authorityKind?: unknown;
  observation?: ObservationCursor;
  id?: unknown;
  kind?: unknown;
  status?: unknown;
  source?: {
    sha256?: unknown;
    byteLength?: unknown;
    mimeType?: unknown;
    decodedWidth?: unknown;
    decodedHeight?: unknown;
  } | null;
  rendered?: {
    rgbaSha256?: unknown;
    rgbaByteLength?: unknown;
    backingWidth?: unknown;
    backingHeight?: unknown;
    nonTransparentPixelCount?: unknown;
    drawnWidth?: unknown;
    drawnHeight?: unknown;
    probes?: readonly RasterProbeView[];
  } | null;
  region?: RasterRegionView | null;
  renderer?: {
    bridgeGeneration?: unknown;
    targetFingerprint?: unknown;
    target?: { id?: unknown } | null;
  } | null;
  capture?: RasterCaptureView;
  rasterFingerprint?: unknown;
}

export type TornReason =
  | 'document-tear'
  | 'generation-tear'
  | 'store-revision-tear'
  | 'renderer-provenance-tear'
  | 'geometry-bracket-tear'
  | 'raster-bracket-tear'
  | 'target-missing'
  | 'target-unmounted';

/** True when two published probe sets agree on identity, coordinate and RGBA. */
function rasterProbesEqual(
  left: readonly RasterProbeView[] | undefined,
  right: readonly RasterProbeView[] | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.length !== right.length) return false;
  return left.every((probe, index) => {
    const other = right[index];
    if (other === undefined) return false;
    return (
      probe.probeId === other.probeId &&
      probe.backingX === other.backingX &&
      probe.backingY === other.backingY &&
      probe.rgba.length === other.rgba.length &&
      probe.rgba.every((channel, channelIndex) => channel === other.rgba[channelIndex])
    );
  });
}

/**
 * Opaque typed identity for a typed target, or `null`. Geometry-v3 is preferred
 * when present (a target cannot carry both typed representations). The returned
 * string is already prefixed so it can be compared to idle fingerprints.
 */
function typedFingerprintOf(view: StampedGeometryView | undefined): string | null {
  const v3 = view?.geometryV3?.representation?.representationFingerprint;
  if (typeof v3 === 'string' && v3.length > 0) return `geometry-v3:${v3}`;
  const v2 = view?.geometryV2?.envelopeFingerprint;
  return typeof v2 === 'string' && v2.length > 0 ? `geometry-v2:${v2}` : null;
}

/** The target/witness/Layout identity published by the typed record, if any. */
function typedIdentityOf(view: StampedGeometryView | undefined): {
  targetId: string | null;
  witnessId: string | null;
  layoutId: string | null;
} {
  const v3 = view?.geometryV3?.typedProvenance;
  if (v3 !== undefined && v3 !== null) {
    return {
      targetId: typeof v3.target?.id === 'string' ? v3.target.id : null,
      witnessId: typeof v3.witness?.id === 'string' ? v3.witness.id : null,
      layoutId: typeof v3.layout?.id === 'string' ? v3.layout.id : null,
    };
  }
  const provenance = view?.geometryV2?.typedProvenance;
  return {
    targetId: typeof provenance?.target?.id === 'string' ? provenance.target.id : null,
    witnessId: null,
    layoutId: typeof provenance?.layout?.id === 'string' ? provenance.layout.id : null,
  };
}

function typedIdentityAgrees(
  left: ReturnType<typeof typedIdentityOf>,
  right: ReturnType<typeof typedIdentityOf>,
): boolean {
  return (
    left.targetId !== null &&
    left.targetId === right.targetId &&
    left.layoutId === right.layoutId &&
    left.witnessId === right.witnessId
  );
}

export interface TornObservation {
  attempt: number;
  atMs: number;
  reason: TornReason;
  detail: string;
}

export interface CoherentObservation {
  observationId: string;
  cursor: ObservationCursor;
  snapshot: StampedSnapshotView;
  geometry: Readonly<Record<string, StampedGeometryView>>;
  /** Accepted R1 raster views per target; empty for non-raster bindings. */
  raster: Readonly<Record<string, RasterBracketView>>;
  /**
   * Post-action interaction diagnostic (ADR 0014 R9.8). The accepted G1
   * classification is recorded even when G0 and G1 disagree; interaction
   * differences never tear authoritative geometry and never deny the id.
   */
  postActionInteraction: PostInteractionDiagnostic | null;
  attempts: number;
}

/** One bounded, non-authoritative post-action interaction projection. */
interface PostInteractionView {
  phase?: unknown;
  purpose?: unknown;
  authority?: unknown;
  status?: unknown;
  candidate?: unknown;
  safetyInsetCssPx?: unknown;
  hitClassification?: unknown;
  obstructionCode?: unknown;
  safeHitDescriptor?: unknown;
  interactionFingerprint?: unknown;
}

export interface PostInteractionDiagnostic {
  diagnosticStableAcrossG0G1: boolean;
  /** Accepted G1 diagnostic projection. */
  accepted: PostInteractionView | null;
  /** G0 and G1 classifications, retained only when they disagree. */
  compared: readonly PostInteractionView[];
}

function readPostInteraction(view: StampedGeometryView | undefined): PostInteractionView | null {
  const interaction = view?.geometryV3?.interaction;
  if (interaction === null || typeof interaction !== 'object' || Array.isArray(interaction)) {
    return null;
  }
  const candidate = interaction as PostInteractionView;
  return candidate.phase === 'post-action' ? candidate : null;
}

function postInteractionsAgree(left: PostInteractionView, right: PostInteractionView): boolean {
  if (
    typeof left.interactionFingerprint === 'string' &&
    typeof right.interactionFingerprint === 'string'
  ) {
    return left.interactionFingerprint === right.interactionFingerprint;
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

function postInteractionDiagnostic(
  g0: readonly StampedGeometryView[],
  g1: readonly StampedGeometryView[],
): PostInteractionDiagnostic | null {
  const readG0 = g0
    .map(readPostInteraction)
    .filter((view): view is PostInteractionView => view !== null);
  const readG1 = g1
    .map(readPostInteraction)
    .filter((view): view is PostInteractionView => view !== null);
  if (readG0.length === 0 && readG1.length === 0) return null;
  const stable =
    readG0.length === readG1.length &&
    readG0.every((view, index) =>
      postInteractionsAgree(view, readG1[index] as PostInteractionView),
    );
  return {
    diagnosticStableAcrossG0G1: stable,
    accepted: readG1[readG1.length - 1] ?? null,
    compared: stable ? [] : [...readG0, ...readG1],
  };
}

export interface CoherentCaptureDeps {
  now: () => number;
  /** Absolute monotonic deadline (same deadline as the readiness gate). */
  deadlineAt: number;
  readCursor: () => Promise<ObservationCursor>;
  readSnapshot: () => Promise<StampedSnapshotView>;
  readGeometry: (id: string) => Promise<StampedGeometryView>;
  targetIds: readonly string[];
  stableRendererFingerprint: StableRendererFingerprint | null;
  /** Optional raster R0/R1 bracket for raster-aware bindings (Slice 5-C). */
  readRaster?: (id: string) => Promise<RasterBracketView>;
  allocateObservationId?: () => string;
}

export type CoherentCaptureResult =
  | {
      ok: true;
      observation: CoherentObservation;
      torn: readonly TornObservation[];
      /** Observed capture attempts consumed before the accepted bundle. */
      attempts: number;
    }
  | {
      ok: false;
      code: 'OBSERVATION_TORN' | 'READINESS_DEADLINE_EXCEEDED';
      torn: readonly TornObservation[];
      attempts: number;
    };

function classifyTear(input: {
  a0: ObservationCursor;
  a1: ObservationCursor;
  snapshot: StampedSnapshotView;
  g0: readonly StampedGeometryView[];
  g1: readonly StampedGeometryView[];
  r0: readonly RasterBracketView[];
  r1: readonly RasterBracketView[];
  targetIds: readonly string[];
  stable: StableRendererFingerprint | null;
}): { reason: TornReason; detail: string } | null {
  const { a0, a1, snapshot, g0, g1, r0, r1, targetIds, stable } = input;

  if (
    a0.documentId !== a1.documentId ||
    a0.documentEpoch !== a1.documentEpoch ||
    a0.bridgeVersion !== a1.bridgeVersion
  ) {
    return {
      reason: 'document-tear',
      detail: `Anchor A0 (${cursorKey(a0)}) and A1 (${cursorKey(a1)}) do not share one document identity.`,
    };
  }
  if (a0.bridgeGeneration !== a1.bridgeGeneration) {
    return {
      reason: 'generation-tear',
      detail: `Anchor A0 generation ${a0.bridgeGeneration} differs from A1 generation ${a1.bridgeGeneration}.`,
    };
  }
  if (a0.revision !== a1.revision) {
    return {
      reason: 'store-revision-tear',
      detail: `Anchor A0 revision ${a0.revision} differs from A1 revision ${a1.revision}.`,
    };
  }
  if (!cursorsEqual(snapshot.observation, a0)) {
    return {
      reason: 'store-revision-tear',
      detail: `Snapshot stamp ${cursorKey(snapshot.observation)} does not match anchor A0 ${cursorKey(a0)}.`,
    };
  }

  for (const id of targetIds) {
    const read = g1.find((entry) => entry.id === id);
    const readG0 = g0.find((entry) => entry.id === id);
    if (!read || !readG0) {
      return {
        reason: 'target-missing',
        detail: `No geometry source was captured for target "${id}".`,
      };
    }
    for (const candidate of [readG0, read]) {
      if (!cursorsEqual(candidate.observation, a0)) {
        return {
          reason: 'store-revision-tear',
          detail: `Geometry stamp for "${id}" (${cursorKey(candidate.observation)}) does not match anchor A0 ${cursorKey(a0)}.`,
        };
      }
      if (!candidate.mounted) {
        const cause =
          typeof candidate.geometryV3Failure?.detail === 'string'
            ? candidate.geometryV3Failure.detail
            : typeof candidate.geometryV3Failure?.reason === 'string'
              ? candidate.geometryV3Failure.reason
              : typeof candidate.geometryV3Failure?.code === 'string'
                ? candidate.geometryV3Failure.code
                : 'unknown';
        return {
          reason: 'target-unmounted',
          detail: `Target "${id}" is not mounted in the captured geometry read (${cause}).`,
        };
      }
    }

    // Renderer-local G0/G1 bracket (R12): the two geometry reads must agree on
    // target/witness/Layout identity, typed provenance, representation, and
    // corresponding points. The typed fingerprint covers all of them.
    const typedG0 = typedFingerprintOf(readG0);
    const typedG1 = typedFingerprintOf(read);
    if (typedG0 !== null || typedG1 !== null) {
      if (typedG0 === null || typedG1 === null || typedG0 !== typedG1) {
        return {
          reason: 'geometry-bracket-tear',
          detail: `Target "${id}" typed geometry changed between the G0 and G1 bracket reads.`,
        };
      }
      const identityG0 = typedIdentityOf(readG0);
      const identityG1 = typedIdentityOf(read);
      if (!typedIdentityAgrees(identityG0, identityG1)) {
        return {
          reason: 'geometry-bracket-tear',
          detail: `Target "${id}" typed target/witness/Layout identity changed between the G0 and G1 bracket reads.`,
        };
      }
    }

    if (stable !== null) {
      const expected = stable.targetFingerprints[id];
      if (
        expected !== undefined &&
        (expected.startsWith('geometry-v2:') || expected.startsWith('geometry-v3:'))
      ) {
        if (typedG1 === null || expected !== typedG1) {
          return {
            reason: 'renderer-provenance-tear',
            detail: `Target "${id}" typed geometry representation changed after quiescence.`,
          };
        }
        continue;
      }
      if (read.renderer === undefined) {
        return {
          reason: 'renderer-provenance-tear',
          detail: `Target "${id}" carries no renderer provenance to compare with the stable fingerprint.`,
        };
      }
      if (read.renderer.bridgeGeneration !== stable.bridgeGeneration) {
        return {
          reason: 'renderer-provenance-tear',
          detail: `Target "${id}" renderer generation ${read.renderer.bridgeGeneration} differs from the stable generation ${stable.bridgeGeneration}.`,
        };
      }
      if (read.renderer.stageFingerprint !== stable.stageFingerprint) {
        return {
          reason: 'renderer-provenance-tear',
          detail: `Target "${id}" Stage fingerprint changed after quiescence.`,
        };
      }
      if (expected !== undefined && read.renderer.targetFingerprint !== expected) {
        return {
          reason: 'renderer-provenance-tear',
          detail: `Target "${id}" geometry provenance changed after quiescence.`,
        };
      }
    }
  }

  for (let index = 0; index < targetIds.length; index += 1) {
    const id = targetIds[index] as string;
    const readRaster0 = r0[index];
    const readRaster1 = r1[index];
    if (readRaster0 === undefined || readRaster1 === undefined) continue;
    const rasterMismatchDetail = (detail: string) => ({
      reason: 'raster-bracket-tear' as const,
      detail,
    });
    if (readRaster0.id !== id || readRaster1.id !== id) {
      return rasterMismatchDetail(
        `Target "${id}" raster bracket published the wrong target id (${String(readRaster0.id)}/${String(readRaster1.id)}).`,
      );
    }
    if (readRaster0.observation === undefined || readRaster1.observation === undefined) {
      return rasterMismatchDetail(`Target "${id}" raster bracket published no observation cursor.`);
    }
    if (!cursorsEqual(readRaster0.observation, a0) || !cursorsEqual(readRaster1.observation, a0)) {
      return rasterMismatchDetail(
        `Target "${id}" raster stamps do not match anchor A0 ${cursorKey(a0)}.`,
      );
    }
    // R12: each raster capture retains its own internal start/end anchors, and
    // both must agree with the product's reported stability and with anchor A0.
    for (const [label, view] of [
      ['R0', readRaster0],
      ['R1', readRaster1],
    ] as const) {
      const capture = view.capture;
      if (
        capture === undefined ||
        capture.started === undefined ||
        capture.completed === undefined
      ) {
        return rasterMismatchDetail(
          `Target "${id}" raster ${label} published no internal capture anchors.`,
        );
      }
      if (!cursorsEqual(capture.started, capture.completed)) {
        return rasterMismatchDetail(
          `Target "${id}" raster ${label} changed between its internal capture start and end.`,
        );
      }
      if (!cursorsEqual(capture.started, a0)) {
        return rasterMismatchDetail(
          `Target "${id}" raster ${label} internal capture anchors do not match anchor A0 ${cursorKey(a0)}.`,
        );
      }
      // ADR 0017 R11/R12: the stability facts are arm-explicit. The Image arm
      // uses source/renderer stability; the generated-vector projection arm uses
      // renderer/bounds stability. A record that does not carry its arm's exact
      // facts is a bracket tear, never a silent pass.
      const armStable =
        view.authorityKind === 'generated-vector-projection-v1'
          ? capture.rendererStable === true && capture.boundsStable === true
          : capture.sourceStable === true && capture.rendererStable === true;
      if (!armStable) {
        return rasterMismatchDetail(
          `Target "${id}" raster ${label} source/renderer identity changed during acquisition.`,
        );
      }
    }
    if (readRaster1.authorityKind !== readRaster0.authorityKind) {
      return rasterMismatchDetail(
        `Target "${id}" raster authority kind changed between R0 and R1.`,
      );
    }
    if (readRaster1.status !== readRaster0.status) {
      return rasterMismatchDetail(`Target "${id}" raster status changed between R0 and R1.`);
    }
    if (readRaster1.rasterFingerprint !== readRaster0.rasterFingerprint) {
      return rasterMismatchDetail(`Target "${id}" raster fingerprint changed between R0 and R1.`);
    }
    if (readRaster1.renderer?.bridgeGeneration !== readRaster0.renderer?.bridgeGeneration) {
      return rasterMismatchDetail(
        `Target "${id}" raster renderer generation changed between R0 and R1.`,
      );
    }
    if (readRaster1.renderer?.target?.id !== readRaster0.renderer?.target?.id) {
      return rasterMismatchDetail(
        `Target "${id}" raster renderer target changed between R0 and R1.`,
      );
    }
    if (readRaster1.source?.sha256 !== readRaster0.source?.sha256) {
      return rasterMismatchDetail(`Target "${id}" raster source digest changed between R0 and R1.`);
    }
    if (readRaster1.source?.byteLength !== readRaster0.source?.byteLength) {
      return rasterMismatchDetail(
        `Target "${id}" raster source byte length changed between R0 and R1.`,
      );
    }
    if (readRaster1.source?.mimeType !== readRaster0.source?.mimeType) {
      return rasterMismatchDetail(`Target "${id}" raster source MIME changed between R0 and R1.`);
    }
    if (readRaster1.source?.decodedWidth !== readRaster0.source?.decodedWidth) {
      return rasterMismatchDetail(`Target "${id}" raster decoded width changed between R0 and R1.`);
    }
    if (readRaster1.source?.decodedHeight !== readRaster0.source?.decodedHeight) {
      return rasterMismatchDetail(
        `Target "${id}" raster decoded height changed between R0 and R1.`,
      );
    }
    if (readRaster1.rendered?.rgbaSha256 !== readRaster0.rendered?.rgbaSha256) {
      return rasterMismatchDetail(`Target "${id}" raster RGBA digest changed between R0 and R1.`);
    }
    if (readRaster1.rendered?.rgbaByteLength !== readRaster0.rendered?.rgbaByteLength) {
      return rasterMismatchDetail(
        `Target "${id}" raster RGBA byte length changed between R0 and R1.`,
      );
    }
    if (readRaster1.rendered?.backingWidth !== readRaster0.rendered?.backingWidth) {
      return rasterMismatchDetail(`Target "${id}" raster backing width changed between R0 and R1.`);
    }
    if (readRaster1.rendered?.backingHeight !== readRaster0.rendered?.backingHeight) {
      return rasterMismatchDetail(
        `Target "${id}" raster backing height changed between R0 and R1.`,
      );
    }
    if (
      readRaster1.rendered?.nonTransparentPixelCount !==
      readRaster0.rendered?.nonTransparentPixelCount
    ) {
      return rasterMismatchDetail(
        `Target "${id}" raster alpha coverage changed between R0 and R1.`,
      );
    }
    if (readRaster1.rendered?.drawnWidth !== readRaster0.rendered?.drawnWidth) {
      return rasterMismatchDetail(`Target "${id}" raster drawn width changed between R0 and R1.`);
    }
    if (readRaster1.rendered?.drawnHeight !== readRaster0.rendered?.drawnHeight) {
      return rasterMismatchDetail(`Target "${id}" raster drawn height changed between R0 and R1.`);
    }
    if (!rasterProbesEqual(readRaster0.rendered?.probes, readRaster1.rendered?.probes)) {
      return rasterMismatchDetail(`Target "${id}" raster probe values changed between R0 and R1.`);
    }
  }

  return null;
}

export async function captureCoherentObservation(
  deps: CoherentCaptureDeps,
): Promise<CoherentCaptureResult> {
  const allocateObservationId = deps.allocateObservationId ?? (() => randomUUID());
  const torn: TornObservation[] = [];
  let attempt = 0;

  for (;;) {
    attempt += 1;
    const atMs = Math.round(deps.now());

    // Accepted post-action capture order: A0 → snapshot → G0 → G1 → A1.
    const a0 = await deps.readCursor();
    const snapshot = await deps.readSnapshot();
    const g0: StampedGeometryView[] = [];
    for (const id of deps.targetIds) {
      g0.push(await deps.readGeometry(id));
    }
    const g1: StampedGeometryView[] = [];
    for (const id of deps.targetIds) {
      g1.push(await deps.readGeometry(id));
    }
    const r0: RasterBracketView[] = [];
    const r1: RasterBracketView[] = [];
    if (deps.readRaster) {
      for (const id of deps.targetIds) {
        r0.push(await deps.readRaster(id));
      }
      for (const id of deps.targetIds) {
        r1.push(await deps.readRaster(id));
      }
    }
    const a1 = await deps.readCursor();

    const tear = classifyTear({
      a0,
      a1,
      snapshot,
      g0,
      g1,
      r0,
      r1,
      targetIds: deps.targetIds,
      stable: deps.stableRendererFingerprint,
    });

    if (tear === null) {
      return {
        ok: true,
        attempts: attempt,
        torn,
        observation: {
          observationId: allocateObservationId(),
          cursor: a0,
          snapshot,
          geometry: Object.fromEntries(g1.map((entry) => [entry.id, entry])),
          raster: Object.fromEntries(r1.map((entry) => [String(entry.id), entry])),
          postActionInteraction: postInteractionDiagnostic(g0, g1),
          attempts: attempt,
        },
      };
    }

    torn.push({ attempt, atMs, reason: tear.reason, detail: tear.detail });

    // Torn candidates are excluded from authority. Recapture openly only while
    // the original deadline still has budget.
    if (deps.now() >= deps.deadlineAt) {
      return { ok: false, code: 'OBSERVATION_TORN', torn, attempts: attempt };
    }
  }
}

/** True when two renderer fingerprints are equal (used by quiescence handoff). */
export function rendererFingerprintStable(
  left: StableRendererFingerprint,
  right: StableRendererFingerprint,
): boolean {
  if (left.bridgeGeneration !== right.bridgeGeneration) return false;
  if (left.stageFingerprint !== right.stageFingerprint) return false;
  const leftIds = Object.keys(left.targetFingerprints).sort();
  const rightIds = Object.keys(right.targetFingerprints).sort();
  if (leftIds.length !== rightIds.length) return false;
  return leftIds.every(
    (id, index) =>
      rightIds[index] === id && left.targetFingerprints[id] === right.targetFingerprints[id],
  );
}

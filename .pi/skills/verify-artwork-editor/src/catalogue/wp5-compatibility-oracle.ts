import type { Capability } from '../contracts/discriminants';
import type {
  CapabilityBaselineDeclaration,
  CaptureDeclaration,
  NormalizationApplicability,
  NormalizationEvaluator,
  NormalizationMeaningRef,
  OracleDeclaration,
  ReadinessDeclaration,
  SubjectAdditionDeclaration,
  ToleranceDeclaration,
  VisualAuthorityDeclaration,
} from '../contracts/correctness';

/**
 * Route-level WP5 Compatibility Oracle (ADR 0024 §4).
 *
 * This is **independent historical acceptance evidence**, not runtime policy
 * authority. It is hand-authored against the ADR 0022 accepted WP5 route
 * semantics and is deliberately *not* generated from the Package-7 catalogues,
 * the compiled projections, or the runtime dispatch registries. `validate
 * --all` compares the complete compiled projection of every delivered route
 * against these entries, so the compatibility check can never be satisfied by
 * generating both compared sides from the same catalogue object.
 *
 * It exists only to prove that the P7-A catalogue/compiler migration is
 * behavior-preserving with respect to the accepted WP5 correctness meaning. It
 * grants no Gate F/G/H, Release, qualification, claim, deployment, or
 * production-verification credit, and it does not migrate active runtime
 * behavior (that is P7-B).
 *
 * Every collections field that the parser canonicalizes (checks,
 * requiredEvidence, toleranceRefs, visualRefs, evidenceItemIds, requiredSources,
 * currentness) is authored in the same canonical order so the comparison is a
 * value comparison rather than an ordering artifact. Ordered policy data
 * (fallback cadence, capture bracketing) is authored in its meaningful order.
 */

/** One delivered route identity (the ADR 0022 representative route set). */
export interface Wp5CompatibilityRoute {
  subjectId: string;
  capability: Capability;
  variant: string | null;
}

/** Normalization projection: an applicable declaration or explicit non-applicability. */
export type Wp5CompatibilityNormalization =
  | { applicable: false }
  | {
      applicable: true;
      normalizationId: string;
      version: number;
      applicability: NormalizationApplicability;
      meaningRef: NormalizationMeaningRef;
      evaluator: NormalizationEvaluator;
    };

/** The complete ADR 0024 §4 correctness projection compared per route. */
export interface Wp5CompatibilityProjection {
  route: Wp5CompatibilityRoute;
  profileId: string;
  readiness: ReadinessDeclaration;
  capture: CaptureDeclaration;
  oracle: OracleDeclaration;
  capabilityBaseline: CapabilityBaselineDeclaration;
  subjectAddition: SubjectAdditionDeclaration;
  routeSelection: {
    readinessProfileId: string;
    oracleProfileId: string;
    checks: readonly string[];
  };
  declaredChecks: readonly string[];
  requiredChecks: readonly string[];
  tolerances: readonly ToleranceDeclaration[];
  visuals: readonly VisualAuthorityDeclaration[];
  normalization: Wp5CompatibilityNormalization;
  nonWeakeningSatisfied: boolean;
}

export interface Wp5CompatibilityOracleEntry {
  /** Explicit anchor to the accepted ADR 0022 route semantics. */
  provenance: string;
  projection: Wp5CompatibilityProjection;
}

const ADR_0022_PROVENANCE =
  'ADR 0022 accepted WP5 route semantics (readiness/capture/Oracle/composition/policies)';

const CANONICAL_MATRIX_EPSILON: ToleranceDeclaration = {
  toleranceId: 'canonical-matrix-epsilon-v1',
  version: 1,
  algorithm: 'matrix-component-absolute',
  units: 'matrix-unit',
  value: 1e-6,
  parameters: null,
  rationale:
    'Canonical matrix components are exact up to floating-point epsilon; a larger epsilon would accept a real transform change as noise.',
  compatibilityDomain: 'canonical-geometry-matrix',
};

const RENDERER_TRANSFORM_PX: ToleranceDeclaration = {
  toleranceId: 'renderer-transform-px-v1',
  version: 1,
  algorithm: 'css-pixel-absolute',
  units: 'css-px',
  value: 0.25,
  parameters: null,
  rationale:
    'The renderer transform is compared to the canonical projection per point and axis within one quarter of a CSS pixel, the accepted rendering tolerance.',
  compatibilityDomain: 'renderer-transform',
};

const BACKING_PIXEL_EDGE: ToleranceDeclaration = {
  toleranceId: 'backing-pixel-edge-v1',
  version: 1,
  algorithm: 'backing-pixel-edge',
  units: 'effective-backing-pixel',
  value: 1,
  parameters: null,
  rationale:
    'Raster edge agreement is compared within one effective backing pixel; a wider band would hide a real raster drift.',
  compatibilityDomain: 'raster-edge',
};

const IMAGE_STRUCTURAL_VISUAL: VisualAuthorityDeclaration = {
  visualId: 'image-structural-visual-v1',
  version: 1,
  mode: 'structural',
  algorithm: 'structural-probe-v1',
  evidenceSource: 'raster.accepted',
  authorityRole: 'required-authoritative',
  toleranceRef: 'backing-pixel-edge-v1',
  boundedRegion: 'target-viewport-rect',
  currentness: ['bridge-generation', 'document', 'raster', 'revision'],
};

const DIAGNOSTIC_SCREENSHOT_VISUAL: VisualAuthorityDeclaration = {
  visualId: 'diagnostic-screenshot-v1',
  version: 1,
  mode: 'bounded-capture',
  algorithm: 'screenshot-capture-v1',
  evidenceSource: 'screenshot.diagnostic',
  authorityRole: 'diagnostic-only',
  toleranceRef: null,
  boundedRegion: 'viewport',
  currentness: ['bridge-generation', 'document', 'revision'],
};

// ── Readiness declarations (accepted ADR 0022 timing policy) ────────────────

const ACTION_CYCLE_V1: ReadinessDeclaration = {
  schemaVersion: 1,
  profileId: 'action-cycle-v1',
  version: 1,
  deadlineCategory: 'INTERACTIVE_RENDER_V1',
  deadlineMs: 5000,
  signalWatchdogMs: 100,
  fallbackCadenceMs: [100, 200, 250],
  stableFrames: 3,
  quiescenceRequired: true,
  stableFrameRequired: true,
  currentnessIdentities: ['bridge-generation', 'document', 'epoch', 'renderer-stage', 'revision'],
  captureProfileId: 'single-target-v1',
  oracleProfileId: 'geometry-delta-v1',
};

const WARPED_TEXT_ACTION_CYCLE_V1: ReadinessDeclaration = {
  schemaVersion: 1,
  profileId: 'warped-text-action-cycle-v1',
  version: 1,
  deadlineCategory: 'INTERACTIVE_RENDER_V1',
  deadlineMs: 5000,
  signalWatchdogMs: 100,
  fallbackCadenceMs: [100, 200, 250],
  stableFrames: 3,
  quiescenceRequired: true,
  stableFrameRequired: true,
  currentnessIdentities: [
    'bridge-generation',
    'document',
    'epoch',
    'renderer-stage',
    'revision',
    'typed-envelope',
  ],
  captureProfileId: 'typed-envelope-v1',
  oracleProfileId: 'warped-text-circle-move-v1',
};

const IMAGE_RASTER_ACTION_CYCLE_V1: ReadinessDeclaration = {
  schemaVersion: 1,
  profileId: 'image-raster-action-cycle-v1',
  version: 1,
  deadlineCategory: 'RESOURCE_RENDER_V1',
  deadlineMs: 8000,
  signalWatchdogMs: 100,
  fallbackCadenceMs: [100, 200, 250],
  stableFrames: 3,
  quiescenceRequired: true,
  stableFrameRequired: true,
  currentnessIdentities: [
    'bridge-generation',
    'document',
    'epoch',
    'raster',
    'renderer-stage',
    'revision',
  ],
  captureProfileId: 'raster-target-v1',
  oracleProfileId: 'image-upload-replace-v1',
};

const NESTED_OBJECT_ACTION_CYCLE_V1: ReadinessDeclaration = {
  schemaVersion: 1,
  profileId: 'nested-object-action-cycle-v1',
  version: 1,
  deadlineCategory: 'INTERACTIVE_RENDER_V1',
  deadlineMs: 5000,
  signalWatchdogMs: 100,
  fallbackCadenceMs: [100, 200, 250],
  stableFrames: 3,
  quiescenceRequired: true,
  stableFrameRequired: true,
  currentnessIdentities: [
    'bridge-generation',
    'document',
    'epoch',
    'renderer-stage',
    'revision',
    'typed-chain-v3',
  ],
  captureProfileId: 'nested-object-affine-capture-v1',
  oracleProfileId: 'nested-object-move-v1',
};

const CROSSWORD_GENERATION_ACTION_CYCLE_V1: ReadinessDeclaration = {
  schemaVersion: 1,
  profileId: 'crossword-generation-action-cycle-v1',
  version: 1,
  deadlineCategory: 'DERIVED_GENERATION_V1',
  deadlineMs: 8000,
  signalWatchdogMs: 100,
  fallbackCadenceMs: [100, 200, 250],
  stableFrames: 3,
  quiescenceRequired: true,
  stableFrameRequired: true,
  currentnessIdentities: [
    'bridge-generation',
    'crossword-generation',
    'document',
    'epoch',
    'raster',
    'renderer-stage',
    'revision',
  ],
  captureProfileId: 'crossword-generation-raster-v1',
  oracleProfileId: 'crossword-determinism-v1',
};

const HISTORY_TRANSITION_V1: ReadinessDeclaration = {
  schemaVersion: 1,
  profileId: 'history-transition-v1',
  version: 1,
  deadlineCategory: 'INTERACTIVE_HISTORY_V1',
  deadlineMs: 5000,
  signalWatchdogMs: 100,
  fallbackCadenceMs: [100, 200, 250],
  stableFrames: 3,
  quiescenceRequired: true,
  stableFrameRequired: true,
  currentnessIdentities: ['bridge-generation', 'document', 'epoch', 'history-snapshot', 'revision'],
  captureProfileId: 'history-whole-document-v1',
  oracleProfileId: 'history-cross-subject-v1',
};

const FRONTEND_RESTORE_TRANSITION_V1: ReadinessDeclaration = {
  schemaVersion: 1,
  profileId: 'frontend-restore-transition-v1',
  version: 1,
  deadlineCategory: 'FRONTEND_RESTORE_V1',
  deadlineMs: 15000,
  signalWatchdogMs: 100,
  fallbackCadenceMs: [100, 200, 250],
  stableFrames: 3,
  quiescenceRequired: true,
  stableFrameRequired: true,
  currentnessIdentities: ['bridge-generation', 'document', 'epoch', 'restore-snapshot', 'revision'],
  captureProfileId: 'restore-whole-document-v1',
  oracleProfileId: 'frontend-restore-v1',
};

// ── Capture declarations (accepted coherent-capture recipes) ────────────────

const CAPTURE_SINGLE_TARGET_V1: CaptureDeclaration = {
  schemaVersion: 1,
  captureProfileId: 'single-target-v1',
  version: 1,
  requiredSources: [
    {
      sourceId: 'canonical-snapshot',
      role: 'canonical',
      currentness: ['bridge-generation', 'document', 'epoch', 'revision'],
      required: true,
    },
    {
      sourceId: 'renderer-geometry',
      role: 'renderer',
      currentness: ['bridge-generation', 'document', 'renderer-stage', 'revision'],
      required: true,
    },
    {
      sourceId: 'semantic-state',
      role: 'semantic',
      currentness: ['bridge-generation', 'document', 'revision'],
      required: true,
    },
  ],
  bracketing: ['anchor-A0', 'sources', 'anchor-A1', 'quiescence'],
  acceptedObservationRule:
    'A bundle is accepted only when every required source shares the A0/A1 document, bridge generation, revision and epoch, and the renderer stage fingerprint matches the quiescence-established stable renderer fingerprint.',
  tornCandidateHandling:
    'A torn candidate receives no observationId and may be recaptured only inside the original non-extending deadline.',
  evidenceItemIds: ['geometry.canonical', 'geometry.renderer', 'observation'],
};

const CAPTURE_TYPED_ENVELOPE_V1: CaptureDeclaration = {
  schemaVersion: 1,
  captureProfileId: 'typed-envelope-v1',
  version: 1,
  requiredSources: [
    {
      sourceId: 'canonical-snapshot',
      role: 'canonical',
      currentness: ['bridge-generation', 'document', 'epoch', 'revision'],
      required: true,
    },
    {
      sourceId: 'renderer-geometry',
      role: 'renderer',
      currentness: ['bridge-generation', 'document', 'renderer-stage', 'revision'],
      required: true,
    },
    {
      sourceId: 'semantic-state',
      role: 'semantic',
      currentness: ['bridge-generation', 'document', 'revision'],
      required: true,
    },
    {
      sourceId: 'typed-envelope-geometry',
      role: 'renderer',
      currentness: ['bridge-generation', 'document', 'revision', 'typed-envelope'],
      required: true,
    },
  ],
  bracketing: ['anchor-A0', 'sources', 'anchor-A1', 'quiescence'],
  acceptedObservationRule:
    'A bundle is accepted only when every required source shares the same document, bridge generation, revision and epoch, the renderer stage fingerprint is stable, and the typed circle-control envelope fingerprint agrees across the bracketing anchors.',
  tornCandidateHandling:
    'A torn candidate receives no observationId and may be recaptured only inside the original non-extending deadline.',
  evidenceItemIds: [
    'geometry.canonical',
    'geometry.renderer',
    'geometry.typed-envelope',
    'observation',
  ],
};

const CAPTURE_RASTER_TARGET_V1: CaptureDeclaration = {
  schemaVersion: 1,
  captureProfileId: 'raster-target-v1',
  version: 1,
  requiredSources: [
    {
      sourceId: 'canonical-snapshot',
      role: 'canonical',
      currentness: ['bridge-generation', 'document', 'epoch', 'revision'],
      required: true,
    },
    {
      sourceId: 'raster-capture',
      role: 'raster',
      currentness: ['bridge-generation', 'document', 'raster', 'revision'],
      required: true,
    },
    {
      sourceId: 'renderer-geometry',
      role: 'renderer',
      currentness: ['bridge-generation', 'document', 'renderer-stage', 'revision'],
      required: true,
    },
    {
      sourceId: 'semantic-state',
      role: 'semantic',
      currentness: ['bridge-generation', 'document', 'revision'],
      required: true,
    },
  ],
  bracketing: ['anchor-A0', 'sources', 'anchor-A1', 'quiescence'],
  acceptedObservationRule:
    'A bundle is accepted only when every required source shares the same document, bridge generation, revision and epoch, the renderer stage fingerprint is stable, and the raster start/complete anchors agree on the same source revision.',
  tornCandidateHandling:
    'A torn candidate receives no observationId and may be recaptured only inside the original non-extending deadline.',
  evidenceItemIds: [
    'geometry.canonical',
    'geometry.renderer',
    'image.semantic-baseline',
    'image.semantic-observed',
    'observation',
    'raster.accepted',
  ],
};

const CAPTURE_NESTED_OBJECT_AFFINE_V1: CaptureDeclaration = {
  schemaVersion: 1,
  captureProfileId: 'nested-object-affine-capture-v1',
  version: 1,
  requiredSources: [
    {
      sourceId: 'canonical-snapshot',
      role: 'canonical',
      currentness: ['bridge-generation', 'document', 'epoch', 'revision'],
      required: true,
    },
    {
      sourceId: 'renderer-geometry',
      role: 'renderer',
      currentness: ['bridge-generation', 'document', 'renderer-stage', 'revision'],
      required: true,
    },
    {
      sourceId: 'typed-chain-v3',
      role: 'semantic',
      currentness: ['bridge-generation', 'document', 'revision', 'typed-chain-v3'],
      required: true,
    },
  ],
  bracketing: ['anchor-A0', 'sources', 'anchor-A1', 'quiescence'],
  acceptedObservationRule:
    'A bundle is accepted only when the pair-explicit typed geometry-v3 records for target and witness share the same document, bridge generation, revision, epoch and representation fingerprint.',
  tornCandidateHandling:
    'A torn candidate receives no observationId and may be recaptured only inside the original non-extending deadline.',
  evidenceItemIds: [
    'geometry.canonical',
    'geometry.renderer',
    'geometry.typed-chain-v3',
    'observation',
  ],
};

const CAPTURE_CROSSWORD_GENERATION_RASTER_V1: CaptureDeclaration = {
  schemaVersion: 1,
  captureProfileId: 'crossword-generation-raster-v1',
  version: 1,
  requiredSources: [
    {
      sourceId: 'canonical-snapshot',
      role: 'canonical',
      currentness: ['bridge-generation', 'document', 'epoch', 'revision'],
      required: true,
    },
    {
      sourceId: 'crossword-observation-set',
      role: 'crossword-generation',
      currentness: ['bridge-generation', 'crossword-generation', 'document', 'raster', 'revision'],
      required: true,
    },
    {
      sourceId: 'renderer-geometry',
      role: 'renderer',
      currentness: ['bridge-generation', 'document', 'renderer-stage', 'revision'],
      required: true,
    },
  ],
  bracketing: [
    'anchor-A0',
    'baseline-observation',
    'repeat-observation',
    'sensitive-observation',
    'anchor-A1',
    'quiescence',
  ],
  acceptedObservationRule:
    'The baseline/repeat/sensitive observation set is accepted only when every child shares the same document, bridge generation and generation epoch, is ordered baseline → repeat → sensitive, and each raster anchor is current.',
  tornCandidateHandling:
    'A torn candidate receives no observationId and may be recaptured only inside the original non-extending deadline.',
  evidenceItemIds: [
    'crossword.observation-baseline',
    'crossword.observation-repeat',
    'crossword.observation-sensitive',
    'observation',
    'raster.accepted',
  ],
};

const CAPTURE_HISTORY_WHOLE_DOCUMENT_V1: CaptureDeclaration = {
  schemaVersion: 1,
  captureProfileId: 'history-whole-document-v1',
  version: 1,
  requiredSources: [
    {
      sourceId: 'canonical-snapshot',
      role: 'canonical',
      currentness: ['bridge-generation', 'document', 'epoch', 'revision'],
      required: true,
    },
    {
      sourceId: 'history-transition',
      role: 'history',
      currentness: ['bridge-generation', 'document', 'history-snapshot', 'revision'],
      required: true,
    },
    {
      sourceId: 'serialized-source',
      role: 'serialization',
      currentness: ['bridge-generation', 'document', 'history-snapshot', 'revision'],
      required: true,
    },
  ],
  bracketing: ['anchor-A0', 'sources', 'anchor-A1', 'quiescence'],
  acceptedObservationRule:
    'A bundle is accepted only when the pre-action snapshot and the post-transition snapshot share the same document and bridge generation and every history tuple is read from one coherent transition.',
  tornCandidateHandling:
    'A torn candidate receives no observationId and may be recaptured only inside the original non-extending deadline.',
  evidenceItemIds: ['history.source-snapshot', 'history.transition-snapshot', 'observation'],
};

const CAPTURE_RESTORE_WHOLE_DOCUMENT_V1: CaptureDeclaration = {
  schemaVersion: 1,
  captureProfileId: 'restore-whole-document-v1',
  version: 1,
  requiredSources: [
    {
      sourceId: 'normalized-meaning',
      role: 'normalization',
      currentness: ['document', 'restore-snapshot'],
      required: true,
    },
    {
      sourceId: 'restored-snapshot',
      role: 'semantic',
      currentness: ['bridge-generation', 'document', 'restore-snapshot'],
      required: true,
    },
    {
      sourceId: 'serialized-source',
      role: 'serialization',
      currentness: ['document', 'restore-snapshot'],
      required: true,
    },
  ],
  bracketing: [
    'anchor-A0',
    'source-snapshot',
    'create-request',
    'restore-navigation',
    'restored-capture',
    'quiescence',
  ],
  acceptedObservationRule:
    'A bundle is accepted only when the source snapshot and the restored snapshot are captured from the same document identity, the exact create/GET requests bracket the navigation, and the normalized meaning is computed by the product-owned normalizer.',
  tornCandidateHandling:
    'A torn candidate receives no observationId and may be recaptured only inside the original non-extending deadline.',
  evidenceItemIds: [
    'observation',
    'restore.restored-snapshot',
    'restore.route-request',
    'restore.source-snapshot',
  ],
};

// ── Oracle declarations (accepted evaluator kinds and required checks) ──────

const ORACLE_GEOMETRY_DELTA_V1: OracleDeclaration = {
  schemaVersion: 1,
  oracleProfileId: 'geometry-delta-v1',
  version: 1,
  evaluatorKind: 'geometry-delta',
  checks: [
    {
      checkId: 'geometry.delta',
      evaluator: 'canonical-delta',
      expectedSchema: 'minimum-delta-v1',
      actualSchema: 'geometry-delta-v1',
      requiredEvidence: ['geometry.canonical', 'geometry.renderer', 'observation'],
      toleranceRefs: ['canonical-matrix-epsilon-v1', 'renderer-transform-px-v1'],
      visualRefs: [],
      normalizationRef: null,
    },
  ],
  diagnosticOnlyEvidence: ['obstruction.diagnostic', 'screenshot.diagnostic'],
};

const ORACLE_WARPED_TEXT_CIRCLE_MOVE_V1: OracleDeclaration = {
  schemaVersion: 1,
  oracleProfileId: 'warped-text-circle-move-v1',
  version: 1,
  evaluatorKind: 'warped-text-envelope',
  checks: [
    {
      checkId: 'geometry.delta',
      evaluator: 'typed-envelope',
      expectedSchema: 'minimum-delta-v1',
      actualSchema: 'warped-envelope-delta-v1',
      requiredEvidence: [
        'geometry.canonical',
        'geometry.renderer',
        'geometry.typed-envelope',
        'observation',
      ],
      toleranceRefs: ['canonical-matrix-epsilon-v1', 'renderer-transform-px-v1'],
      visualRefs: [],
      normalizationRef: null,
    },
    {
      checkId: 'geometry.warp-envelope',
      evaluator: 'typed-envelope',
      expectedSchema: 'circle-control-envelope-quad-v1',
      actualSchema: 'circle-control-envelope-quad-v1',
      requiredEvidence: [
        'geometry.canonical',
        'geometry.renderer',
        'geometry.typed-envelope',
        'observation',
      ],
      toleranceRefs: ['canonical-matrix-epsilon-v1', 'renderer-transform-px-v1'],
      visualRefs: [],
      normalizationRef: null,
    },
  ],
  diagnosticOnlyEvidence: ['obstruction.diagnostic', 'screenshot.diagnostic'],
};

const ORACLE_IMAGE_UPLOAD_REPLACE_V1: OracleDeclaration = {
  schemaVersion: 1,
  oracleProfileId: 'image-upload-replace-v1',
  version: 1,
  evaluatorKind: 'image-upload-replace',
  checks: [
    {
      checkId: 'image.content-distinct',
      evaluator: 'image-structural',
      expectedSchema: 'image-content-distinct-v1',
      actualSchema: 'image-content-fingerprint-v1',
      requiredEvidence: ['image.semantic-baseline', 'image.semantic-observed', 'observation'],
      toleranceRefs: ['canonical-matrix-epsilon-v1'],
      visualRefs: [],
      normalizationRef: null,
    },
    {
      checkId: 'image.frame-stable',
      evaluator: 'renderer-transform',
      expectedSchema: 'image-frame-v1',
      actualSchema: 'image-frame-v1',
      requiredEvidence: ['geometry.renderer', 'observation'],
      toleranceRefs: ['renderer-transform-px-v1'],
      visualRefs: [],
      normalizationRef: null,
    },
    {
      checkId: 'image.raster-current',
      evaluator: 'image-structural',
      expectedSchema: 'raster-current-v1',
      actualSchema: 'raster-accepted-v1',
      requiredEvidence: ['observation', 'raster.accepted'],
      toleranceRefs: ['backing-pixel-edge-v1'],
      visualRefs: [],
      normalizationRef: null,
    },
    {
      checkId: 'image.semantic-transition',
      evaluator: 'image-structural',
      expectedSchema: 'image-semantic-transition-v1',
      actualSchema: 'image-semantic-fingerprint-v1',
      requiredEvidence: ['image.semantic-baseline', 'image.semantic-observed'],
      toleranceRefs: [],
      visualRefs: [],
      normalizationRef: null,
    },
    {
      checkId: 'image.structural-visual',
      evaluator: 'image-structural',
      expectedSchema: 'image-structural-visual-v1',
      actualSchema: 'raster-accepted-v1',
      requiredEvidence: ['geometry.canonical', 'observation', 'raster.accepted'],
      toleranceRefs: ['backing-pixel-edge-v1'],
      visualRefs: ['image-structural-visual-v1'],
      normalizationRef: null,
    },
  ],
  diagnosticOnlyEvidence: ['image.raw-payload.diagnostic', 'screenshot.diagnostic'],
};

const ORACLE_NESTED_OBJECT_MOVE_V1: OracleDeclaration = {
  schemaVersion: 1,
  oracleProfileId: 'nested-object-move-v1',
  version: 1,
  evaluatorKind: 'nested-object-affine',
  checks: [
    {
      checkId: 'containment.parent-chain',
      evaluator: 'nested-object-affine',
      expectedSchema: 'nested-object-parent-chain-v1',
      actualSchema: 'nested-object-parent-chain-v1',
      requiredEvidence: ['geometry.typed-chain-v3', 'observation'],
      toleranceRefs: ['canonical-matrix-epsilon-v1'],
      visualRefs: [],
      normalizationRef: null,
    },
    {
      checkId: 'geometry.delta',
      evaluator: 'nested-object-affine',
      expectedSchema: 'minimum-delta-v1',
      actualSchema: 'nested-object-delta-v1',
      requiredEvidence: ['geometry.typed-chain-v3', 'observation'],
      toleranceRefs: ['canonical-matrix-epsilon-v1', 'renderer-transform-px-v1'],
      visualRefs: [],
      normalizationRef: null,
    },
    {
      checkId: 'geometry.local-invariant',
      evaluator: 'nested-object-affine',
      expectedSchema: 'nested-object-local-invariant-v1',
      actualSchema: 'nested-object-local-invariant-v1',
      requiredEvidence: ['geometry.typed-chain-v3', 'observation'],
      toleranceRefs: ['canonical-matrix-epsilon-v1'],
      visualRefs: [],
      normalizationRef: null,
    },
    {
      checkId: 'geometry.world-composition',
      evaluator: 'nested-object-affine',
      expectedSchema: 'nested-object-world-composition-v1',
      actualSchema: 'nested-object-world-composition-v1',
      requiredEvidence: ['geometry.typed-chain-v3', 'observation'],
      toleranceRefs: ['renderer-transform-px-v1'],
      visualRefs: [],
      normalizationRef: null,
    },
  ],
  diagnosticOnlyEvidence: ['obstruction.diagnostic', 'screenshot.diagnostic'],
};

const ORACLE_CROSSWORD_DETERMINISM_V1: OracleDeclaration = {
  schemaVersion: 1,
  oracleProfileId: 'crossword-determinism-v1',
  version: 1,
  evaluatorKind: 'crossword-determinism',
  checks: [
    {
      checkId: 'crossword.created',
      evaluator: 'crossword-determinism',
      expectedSchema: 'crossword-generation-observation-v1',
      actualSchema: 'crossword-generation-observation-v1',
      requiredEvidence: ['crossword.observation-baseline', 'observation'],
      toleranceRefs: [],
      visualRefs: [],
      normalizationRef: null,
    },
    {
      checkId: 'crossword.different-seed-sensitive',
      evaluator: 'crossword-determinism',
      expectedSchema: 'crossword-sensitive-digest-v1',
      actualSchema: 'crossword-sensitive-digest-v1',
      requiredEvidence: ['crossword.observation-baseline', 'crossword.observation-sensitive'],
      toleranceRefs: [],
      visualRefs: [],
      normalizationRef: null,
    },
    {
      checkId: 'crossword.raster-current',
      evaluator: 'crossword-determinism',
      expectedSchema: 'raster-current-v1',
      actualSchema: 'raster-accepted-v1',
      requiredEvidence: ['crossword.observation-baseline', 'raster.accepted'],
      toleranceRefs: ['backing-pixel-edge-v1'],
      visualRefs: [],
      normalizationRef: null,
    },
    {
      checkId: 'crossword.same-seed-repeatable',
      evaluator: 'crossword-determinism',
      expectedSchema: 'crossword-repeat-digest-v1',
      actualSchema: 'crossword-repeat-digest-v1',
      requiredEvidence: ['crossword.observation-baseline', 'crossword.observation-repeat'],
      toleranceRefs: [],
      visualRefs: [],
      normalizationRef: null,
    },
    {
      checkId: 'crossword.seed-derived',
      evaluator: 'crossword-determinism',
      expectedSchema: 'crossword-seed-derivation-v1',
      actualSchema: 'crossword-seed-derivation-v1',
      requiredEvidence: ['crossword.observation-baseline', 'observation'],
      toleranceRefs: [],
      visualRefs: [],
      normalizationRef: null,
    },
    {
      checkId: 'crossword.semantic-valid',
      evaluator: 'crossword-determinism',
      expectedSchema: 'crossword-semantic-v1',
      actualSchema: 'crossword-semantic-v1',
      requiredEvidence: ['crossword.observation-baseline', 'observation'],
      toleranceRefs: [],
      visualRefs: [],
      normalizationRef: null,
    },
  ],
  diagnosticOnlyEvidence: ['crossword.raw-payload.diagnostic', 'screenshot.diagnostic'],
};

const ORACLE_HISTORY_CROSS_SUBJECT_V1: OracleDeclaration = {
  schemaVersion: 1,
  oracleProfileId: 'history-cross-subject-v1',
  version: 1,
  evaluatorKind: 'history-cross-subject',
  checks: [
    {
      checkId: 'history.depth',
      evaluator: 'history-cross-subject',
      expectedSchema: 'history-transition-expectation-v1',
      actualSchema: 'history-tuple-v1',
      requiredEvidence: ['history.source-snapshot', 'history.transition-snapshot', 'observation'],
      toleranceRefs: [],
      visualRefs: [],
      normalizationRef: null,
    },
    {
      checkId: 'history.meaning',
      evaluator: 'history-cross-subject',
      expectedSchema: 'history-meaning-expectation-v1',
      actualSchema: 'history-meaning-fingerprint-v1',
      requiredEvidence: ['history.source-snapshot', 'history.transition-snapshot'],
      toleranceRefs: [],
      visualRefs: [],
      normalizationRef: null,
    },
  ],
  diagnosticOnlyEvidence: ['history.raw-payload.diagnostic', 'screenshot.diagnostic'],
};

const ORACLE_FRONTEND_RESTORE_V1: OracleDeclaration = {
  schemaVersion: 1,
  oracleProfileId: 'frontend-restore-v1',
  version: 1,
  evaluatorKind: 'frontend-restore',
  checks: [
    {
      checkId: 'serialize.raw-semantic',
      evaluator: 'frontend-restore',
      expectedSchema: 'restore-raw-semantic-expectation-v1',
      actualSchema: 'restore-fact-v1',
      requiredEvidence: [
        'restore.restored-snapshot',
        'restore.route-request',
        'restore.source-snapshot',
      ],
      toleranceRefs: [],
      visualRefs: [],
      normalizationRef: 'artwork-normalized-meaning-v1',
    },
    {
      checkId: 'serialize.roundtrip',
      evaluator: 'frontend-restore',
      expectedSchema: 'restore-roundtrip-expectation-v1',
      actualSchema: 'restore-fact-v1',
      requiredEvidence: [
        'observation',
        'restore.restored-snapshot',
        'restore.route-request',
        'restore.source-snapshot',
      ],
      toleranceRefs: [],
      visualRefs: [],
      normalizationRef: 'artwork-normalized-meaning-v1',
    },
  ],
  diagnosticOnlyEvidence: ['restore.raw-payload.diagnostic', 'screenshot.diagnostic'],
};

const NORMALIZATION_NON_APPLICABLE: Wp5CompatibilityNormalization = { applicable: false };

const NORMALIZATION_FRONTEND_RESTORE: Wp5CompatibilityNormalization = {
  applicable: true,
  normalizationId: 'artwork-normalized-meaning-v1',
  version: 1,
  applicability: 'frontend-serialize-restore',
  meaningRef: 'artwork-product-meaning-v1',
  evaluator: 'restore-normalization-v1',
};

// ── Composed required-check sets (Capability baseline ∪ Subject addition ∪ selection) ──

const MOVE_BASELINE: CapabilityBaselineDeclaration = {
  capability: 'move',
  checks: ['geometry.delta'],
};
const CHANGE_PROPERTIES_BASELINE: CapabilityBaselineDeclaration = {
  capability: 'changeProperties',
  checks: [],
};
const CREATE_BASELINE: CapabilityBaselineDeclaration = { capability: 'create', checks: [] };
const HISTORY_BASELINE: CapabilityBaselineDeclaration = {
  capability: 'history',
  checks: ['history.depth'],
};
const FRONTEND_RESTORE_BASELINE: CapabilityBaselineDeclaration = {
  capability: 'frontendSerializeRestore',
  checks: ['serialize.roundtrip'],
};

const TEXT_MOVE_ADDITION: SubjectAdditionDeclaration = {
  subjectId: 'layer/text',
  capability: 'move',
  checks: [],
};
const OBJECT_MOVE_ADDITION: SubjectAdditionDeclaration = {
  subjectId: 'container/object',
  capability: 'move',
  checks: ['containment.parent-chain', 'geometry.local-invariant', 'geometry.world-composition'],
};
const IMAGE_CHANGE_PROPERTIES_ADDITION: SubjectAdditionDeclaration = {
  subjectId: 'layer/image',
  capability: 'changeProperties',
  checks: [
    'image.content-distinct',
    'image.frame-stable',
    'image.raster-current',
    'image.semantic-transition',
    'image.structural-visual',
  ],
};
const CROSSWORD_CREATE_ADDITION: SubjectAdditionDeclaration = {
  subjectId: 'layer/crossword',
  capability: 'create',
  checks: [
    'crossword.created',
    'crossword.different-seed-sensitive',
    'crossword.raster-current',
    'crossword.same-seed-repeatable',
    'crossword.seed-derived',
    'crossword.semantic-valid',
  ],
};
const EDITOR_HISTORY_ADDITION: SubjectAdditionDeclaration = {
  subjectId: 'artwork/editor',
  capability: 'history',
  checks: ['history.meaning'],
};
const EDITOR_RESTORE_ADDITION: SubjectAdditionDeclaration = {
  subjectId: 'artwork/editor',
  capability: 'frontendSerializeRestore',
  checks: ['serialize.raw-semantic'],
};

/**
 * The seven delivered route correctness projections with their explicit
 * ADR 0022 provenance anchors. Ordering follows the accepted route set; the two
 * frontend-restore representative requests share the single restore route.
 */
export const WP5_COMPATIBILITY_ORACLE: readonly Wp5CompatibilityOracleEntry[] = [
  {
    provenance: ADR_0022_PROVENANCE,
    projection: {
      route: { subjectId: 'layer/text', capability: 'move', variant: 'plain' },
      profileId: 'action-cycle-v1',
      readiness: ACTION_CYCLE_V1,
      capture: CAPTURE_SINGLE_TARGET_V1,
      oracle: ORACLE_GEOMETRY_DELTA_V1,
      capabilityBaseline: MOVE_BASELINE,
      subjectAddition: TEXT_MOVE_ADDITION,
      routeSelection: {
        readinessProfileId: 'action-cycle-v1',
        oracleProfileId: 'geometry-delta-v1',
        checks: [],
      },
      declaredChecks: ['geometry.delta'],
      requiredChecks: ['geometry.delta'],
      tolerances: [CANONICAL_MATRIX_EPSILON, RENDERER_TRANSFORM_PX],
      visuals: [],
      normalization: NORMALIZATION_NON_APPLICABLE,
      nonWeakeningSatisfied: true,
    },
  },
  {
    provenance: ADR_0022_PROVENANCE,
    projection: {
      route: { subjectId: 'layer/text', capability: 'move', variant: 'warp-circle' },
      profileId: 'warped-text-action-cycle-v1',
      readiness: WARPED_TEXT_ACTION_CYCLE_V1,
      capture: CAPTURE_TYPED_ENVELOPE_V1,
      oracle: ORACLE_WARPED_TEXT_CIRCLE_MOVE_V1,
      capabilityBaseline: MOVE_BASELINE,
      subjectAddition: TEXT_MOVE_ADDITION,
      routeSelection: {
        readinessProfileId: 'warped-text-action-cycle-v1',
        oracleProfileId: 'warped-text-circle-move-v1',
        checks: ['geometry.warp-envelope'],
      },
      declaredChecks: ['geometry.delta'],
      requiredChecks: ['geometry.delta', 'geometry.warp-envelope'],
      tolerances: [CANONICAL_MATRIX_EPSILON, RENDERER_TRANSFORM_PX],
      visuals: [],
      normalization: NORMALIZATION_NON_APPLICABLE,
      nonWeakeningSatisfied: true,
    },
  },
  {
    provenance: ADR_0022_PROVENANCE,
    projection: {
      route: { subjectId: 'container/object', capability: 'move', variant: null },
      profileId: 'nested-object-action-cycle-v1',
      readiness: NESTED_OBJECT_ACTION_CYCLE_V1,
      capture: CAPTURE_NESTED_OBJECT_AFFINE_V1,
      oracle: ORACLE_NESTED_OBJECT_MOVE_V1,
      capabilityBaseline: MOVE_BASELINE,
      subjectAddition: OBJECT_MOVE_ADDITION,
      routeSelection: {
        readinessProfileId: 'nested-object-action-cycle-v1',
        oracleProfileId: 'nested-object-move-v1',
        checks: [],
      },
      declaredChecks: ['geometry.delta'],
      requiredChecks: [
        'containment.parent-chain',
        'geometry.delta',
        'geometry.local-invariant',
        'geometry.world-composition',
      ],
      tolerances: [CANONICAL_MATRIX_EPSILON, RENDERER_TRANSFORM_PX],
      visuals: [],
      normalization: NORMALIZATION_NON_APPLICABLE,
      nonWeakeningSatisfied: true,
    },
  },
  {
    provenance: ADR_0022_PROVENANCE,
    projection: {
      route: { subjectId: 'layer/image', capability: 'changeProperties', variant: 'static' },
      profileId: 'image-raster-action-cycle-v1',
      readiness: IMAGE_RASTER_ACTION_CYCLE_V1,
      capture: CAPTURE_RASTER_TARGET_V1,
      oracle: ORACLE_IMAGE_UPLOAD_REPLACE_V1,
      capabilityBaseline: CHANGE_PROPERTIES_BASELINE,
      subjectAddition: IMAGE_CHANGE_PROPERTIES_ADDITION,
      routeSelection: {
        readinessProfileId: 'image-raster-action-cycle-v1',
        oracleProfileId: 'image-upload-replace-v1',
        checks: [],
      },
      declaredChecks: [
        'image.content-distinct',
        'image.frame-stable',
        'image.raster-current',
        'image.semantic-transition',
        'image.structural-visual',
      ],
      requiredChecks: [
        'image.content-distinct',
        'image.frame-stable',
        'image.raster-current',
        'image.semantic-transition',
        'image.structural-visual',
      ],
      tolerances: [BACKING_PIXEL_EDGE, CANONICAL_MATRIX_EPSILON, RENDERER_TRANSFORM_PX],
      visuals: [IMAGE_STRUCTURAL_VISUAL],
      normalization: NORMALIZATION_NON_APPLICABLE,
      nonWeakeningSatisfied: true,
    },
  },
  {
    provenance: ADR_0022_PROVENANCE,
    projection: {
      route: { subjectId: 'layer/crossword', capability: 'create', variant: null },
      profileId: 'crossword-generation-action-cycle-v1',
      readiness: CROSSWORD_GENERATION_ACTION_CYCLE_V1,
      capture: CAPTURE_CROSSWORD_GENERATION_RASTER_V1,
      oracle: ORACLE_CROSSWORD_DETERMINISM_V1,
      capabilityBaseline: CREATE_BASELINE,
      subjectAddition: CROSSWORD_CREATE_ADDITION,
      routeSelection: {
        readinessProfileId: 'crossword-generation-action-cycle-v1',
        oracleProfileId: 'crossword-determinism-v1',
        checks: [],
      },
      declaredChecks: [
        'crossword.created',
        'crossword.different-seed-sensitive',
        'crossword.raster-current',
        'crossword.same-seed-repeatable',
        'crossword.seed-derived',
        'crossword.semantic-valid',
      ],
      requiredChecks: [
        'crossword.created',
        'crossword.different-seed-sensitive',
        'crossword.raster-current',
        'crossword.same-seed-repeatable',
        'crossword.seed-derived',
        'crossword.semantic-valid',
      ],
      tolerances: [BACKING_PIXEL_EDGE],
      visuals: [],
      normalization: NORMALIZATION_NON_APPLICABLE,
      nonWeakeningSatisfied: true,
    },
  },
  {
    provenance: ADR_0022_PROVENANCE,
    projection: {
      route: { subjectId: 'artwork/editor', capability: 'history', variant: null },
      profileId: 'history-transition-v1',
      readiness: HISTORY_TRANSITION_V1,
      capture: CAPTURE_HISTORY_WHOLE_DOCUMENT_V1,
      oracle: ORACLE_HISTORY_CROSS_SUBJECT_V1,
      capabilityBaseline: HISTORY_BASELINE,
      subjectAddition: EDITOR_HISTORY_ADDITION,
      routeSelection: {
        readinessProfileId: 'history-transition-v1',
        oracleProfileId: 'history-cross-subject-v1',
        checks: [],
      },
      declaredChecks: ['history.depth'],
      requiredChecks: ['history.depth', 'history.meaning'],
      tolerances: [],
      visuals: [],
      normalization: NORMALIZATION_NON_APPLICABLE,
      nonWeakeningSatisfied: true,
    },
  },
  {
    provenance: ADR_0022_PROVENANCE,
    projection: {
      route: {
        subjectId: 'artwork/editor',
        capability: 'frontendSerializeRestore',
        variant: null,
      },
      profileId: 'frontend-restore-transition-v1',
      readiness: FRONTEND_RESTORE_TRANSITION_V1,
      capture: CAPTURE_RESTORE_WHOLE_DOCUMENT_V1,
      oracle: ORACLE_FRONTEND_RESTORE_V1,
      capabilityBaseline: FRONTEND_RESTORE_BASELINE,
      subjectAddition: EDITOR_RESTORE_ADDITION,
      routeSelection: {
        readinessProfileId: 'frontend-restore-transition-v1',
        oracleProfileId: 'frontend-restore-v1',
        checks: [],
      },
      declaredChecks: ['serialize.roundtrip'],
      requiredChecks: ['serialize.raw-semantic', 'serialize.roundtrip'],
      tolerances: [],
      visuals: [],
      normalization: NORMALIZATION_FRONTEND_RESTORE,
      nonWeakeningSatisfied: true,
    },
  },
];

/**
 * The diagnostic-only screenshot policy is part of every oracle declaration's
 * evidence inventory; it is exported so the comparison and tests share one
 * independent declaration rather than re-deriving it.
 */
export const WP5_DIAGNOSTIC_SCREENSHOT_VISUAL = DIAGNOSTIC_SCREENSHOT_VISUAL;

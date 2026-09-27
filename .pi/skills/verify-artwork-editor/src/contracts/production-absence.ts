/**
 * Production seam-absence contract (specification 9.1, 16 Gate C; TS-3).
 *
 * Runtime gating is not production absence. A hostile production build may be
 * compiled with the explicit `NEXT_PUBLIC_ARTWORK_VERIFICATION=true` flag, so
 * the only trustworthy proof is:
 *
 * 1. a static scan of the *emitted* client/server JavaScript and manifests for
 *    every reachable observation/setup seam marker; and
 * 2. a real-Chromium visit of the production `/artwork/editor` document that
 *    proves the globals, the registered-Symbol slots, and the seam chunks are
 *    absent on load and stay absent across a reload.
 *
 * This module owns the closed marker vocabulary and the pure evaluators. It
 * imports no product source and no browser runtime, so the same predicate the
 * live proof runs is exactly the predicate a negative-control unit test drives
 * with an injected violation.
 */

import { createDiagnostic, type DiagnosticRecord } from './diagnostics';

/** Version of the production-absence contract itself. */
export const PRODUCTION_ABSENCE_SCHEMA_VERSION = 1;

/** Version of the emitted-artifact scan record. */
export const PRODUCTION_ARTIFACT_SCAN_SCHEMA_VERSION = 1;

/** Version of the browser absence observation record. */
export const PRODUCTION_BROWSER_ABSENCE_SCHEMA_VERSION = 1;

/** The only route the production absence proof exercises. */
export const PRODUCTION_ABSENCE_ROUTE = '/artwork/editor';

/** The observation bridge global (bridge.ts). */
export const OBSERVATION_GLOBAL_MARKER = '__MAKEIT_ARTWORK_VERIFICATION__';

/** The one-shot setup boundary global (setupBoundary.ts). */
export const SETUP_GLOBAL_MARKER = '__MAKEIT_ARTWORK_SETUP__';

/** Registered-Symbol slots: broker delivery, setup lifecycle anchor, document identity. */
export const SETUP_BROKER_SYMBOL_KEY = 'makeit.artwork-setup.broker';
export const SETUP_ANCHOR_SYMBOL_KEY = 'makeit.artwork-setup.anchor';
export const DOCUMENT_ANCHOR_SYMBOL_KEY = 'makeit.artwork-verification.document-anchor';

/**
 * Registered-Symbol slot for the document-scoped observation signal anchor
 * (bridge v3). Seam-unique so its presence can never be coincidence.
 */
export const SIGNAL_ANCHOR_SYMBOL_KEY = 'makeit.artwork-verification.signal-anchor';

/**
 * Seam-unique geometry-schema discriminant (bridge v4 / geometry schema v2).
 * Only the verification geometry-projection module declares it.
 */
export const GEOMETRY_SCHEMA_DISCRIMINANT_MARKER = 'makeit.artwork-verification.geometry.v2';

/** The typed frame-projection kind the geometry schema v2 publishes. */
export const CIRCLE_FRAME_PROJECTION_MARKER = 'circle-text-frame-projection-v1';

/** The circle control-envelope representation kind. */
export const CIRCLE_CONTROL_ENVELOPE_MARKER = 'circle-control-envelope-quad-v1';

/**
 * Seam-unique raster evidence schema discriminant (WP5 Slice 5-E bridge v7).
 * Only `verification/rasterEvidence.ts` declares it.
 */
export const RASTER_SCHEMA_DISCRIMINANT_MARKER = 'makeit.artwork-verification.raster.v3';

/**
 * Seam-unique generated-vector authority-kind discriminant (ADR 0017 R11). Only
 * `verification/rasterEvidence.ts` declares it.
 */
export const GENERATED_VECTOR_AUTHORITY_MARKER = 'generated-vector-projection-v1';

/**
 * Seam-unique mounted-node projection method marker (ADR 0017 R12). Only
 * `verification/rasterEvidence.ts` declares it.
 */
export const GENERATED_VECTOR_PROJECTION_METHOD_MARKER = 'konva-mounted-node-to-canvas-v1';

/**
 * Seam-unique bridge v3 cursor discriminant. Never a generic word such as
 * `cursor`, so the static scan cannot false-positive on unrelated output.
 */
export const CURSOR_DISCRIMINANT_MARKER = 'makeit.artwork-verification.observation-cursor.v1';

/**
 * Seam-unique geometry schema v3 discriminant (WP5 Slice 5-D, bridge v7). Only
 * `verification/nestedObjectGeometry.ts` declares it.
 */
export const NESTED_GEOMETRY_DISCRIMINANT_MARKER = 'makeit.artwork-verification.geometry.v3';

/** The nested-object affine-chain representation kind (ADR 0015 v2). */
export const NESTED_OBJECT_CHAIN_MARKER = 'nested-object-affine-chain-v2';

/** The nested-object setup constructor id (ADR 0015 v2). */
export const NESTED_OBJECT_CONSTRUCTOR_MARKER = 'artwork.nested-object.v2';

/**
 * Dedicated diagnostic-only negative-normalization constructor markers
 * (ADR 0016 R10). Each is a seam-unique literal so a hit is a reachable seam.
 */
export const NEGATIVE_NORMALIZATION_CONSTRUCTOR_MARKER =
  'artwork.nested-object.normalization-negative.v1';
export const NEGATIVE_NORMALIZATION_FIXTURE_MARKER =
  'artwork.fixture.nested-object.normalization-negative';
export const NEGATIVE_NORMALIZATION_LITERAL_PROFILE_MARKER = 'known-malformed-v1-negative';
export const NEGATIVE_NORMALIZATION_LITERALS_MISMATCH_MARKER = 'NEGATIVE_FIXTURE_LITERALS_MISMATCH';
export const NEGATIVE_NORMALIZATION_UNEXPECTEDLY_NORMALIZED_MARKER =
  'NEGATIVE_FIXTURE_UNEXPECTEDLY_NORMALIZED';

/** Closed nested-chain diagnostics that only the v6 seam can emit. */
export const NESTED_OBJECT_DIAGNOSTIC_MARKERS = [
  'GEOMETRY_CHAIN_INVALID',
  'GEOMETRY_CHAIN_ID_MISMATCH',
  'GEOMETRY_PARENT_MISMATCH',
  'GEOMETRY_CAMERA_MISMATCH',
  // ADR 0014 purpose-scoped interaction authority: the v6 seam is the only
  // source of the blocking quad-point failure and the diagnostic-only
  // post-action obstruction code.
  'TARGET_QUAD_INTERACTION_POINT_INVALID',
  'POST_ACTION_HIT_OBSTRUCTED',
] as const;

export type AbsenceMarkerCategory =
  | 'global'
  | 'module-path'
  | 'signal-discriminant'
  | 'setup-discriminant'
  | 'symbol-key';

/** One marker whose presence in executable output proves a reachable seam. */
export interface AbsenceMarker {
  category: AbsenceMarkerCategory;
  value: string;
  rationale: string;
}

/**
 * Closed marker vocabulary. Every entry is a string literal (or a
 * source-module basename) that exists in exactly one seam/import-site and
 * nowhere else in the product source, so a hit is a reachable seam, never a
 * coincidence.
 */
export const PRODUCTION_ABSENCE_MARKERS: readonly AbsenceMarker[] = [
  {
    category: 'global',
    value: OBSERVATION_GLOBAL_MARKER,
    rationale: 'Read-only observation bridge global; must not exist in production output.',
  },
  {
    category: 'global',
    value: SETUP_GLOBAL_MARKER,
    rationale: 'One-shot setup boundary global; must not exist in production output.',
  },
  {
    category: 'symbol-key',
    value: SETUP_BROKER_SYMBOL_KEY,
    rationale: 'Setup authorization broker Symbol slot; must never ship to production.',
  },
  {
    category: 'symbol-key',
    value: SETUP_ANCHOR_SYMBOL_KEY,
    rationale: 'Setup lifecycle anchor Symbol slot; must never ship to production.',
  },
  {
    category: 'symbol-key',
    value: DOCUMENT_ANCHOR_SYMBOL_KEY,
    rationale: 'Shared document-identity anchor Symbol slot; only seam modules key it.',
  },
  {
    category: 'symbol-key',
    value: SIGNAL_ANCHOR_SYMBOL_KEY,
    rationale: 'Bridge v3 observation signal anchor Symbol slot; never ships to production.',
  },
  {
    category: 'module-path',
    value: 'artworkVerificationBridge',
    rationale: 'Observation bridge module path; emitted output must not reach it.',
  },
  {
    category: 'module-path',
    value: 'observationCursor',
    rationale: 'Observation signal/cursor module path; emitted output must not reach it.',
  },
  {
    category: 'module-path',
    value: 'geometryProjection',
    rationale: 'Typed geometry schema v2 module path; only the seam reaches it.',
  },
  {
    category: 'module-path',
    value: 'verification/rasterEvidence',
    rationale: 'Raster evidence module path; only the seam reaches it.',
  },
  {
    category: 'signal-discriminant',
    value: RASTER_SCHEMA_DISCRIMINANT_MARKER,
    rationale: 'Raster schema v3 discriminant; only the raster helper declares it.',
  },
  {
    category: 'signal-discriminant',
    value: GENERATED_VECTOR_AUTHORITY_MARKER,
    rationale: 'Generated-vector raster authority kind; only the raster helper declares it.',
  },
  {
    category: 'signal-discriminant',
    value: GENERATED_VECTOR_PROJECTION_METHOD_MARKER,
    rationale: 'Mounted-node projection method marker; only the raster helper declares it.',
  },
  {
    category: 'signal-discriminant',
    value: GEOMETRY_SCHEMA_DISCRIMINANT_MARKER,
    rationale: 'Geometry schema v2 discriminant; only the projection module declares it.',
  },
  {
    category: 'signal-discriminant',
    value: CIRCLE_FRAME_PROJECTION_MARKER,
    rationale: 'Typed circle frame-projection kind; only the projection module declares it.',
  },
  {
    category: 'signal-discriminant',
    value: CIRCLE_CONTROL_ENVELOPE_MARKER,
    rationale:
      'Circle control-envelope representation kind; only the projection module declares it.',
  },
  {
    category: 'signal-discriminant',
    value: CURSOR_DISCRIMINANT_MARKER,
    rationale: 'Bridge v3 cursor discriminant; only the signal module declares it.',
  },
  {
    category: 'signal-discriminant',
    value: NESTED_GEOMETRY_DISCRIMINANT_MARKER,
    rationale: 'Geometry schema v3 discriminant; only the nested-object module declares it.',
  },
  {
    category: 'signal-discriminant',
    value: NESTED_OBJECT_CHAIN_MARKER,
    rationale:
      'Nested-object affine-chain representation kind; only the nested module declares it.',
  },
  {
    category: 'module-path',
    value: 'verification/nestedObjectGeometry',
    rationale: 'Nested-object geometry module path; only the seam reaches it.',
  },
  {
    category: 'setup-discriminant',
    value: NESTED_OBJECT_CONSTRUCTOR_MARKER,
    rationale: 'Nested-object setup constructor id; only the setup boundary declares it.',
  },
  {
    category: 'setup-discriminant',
    value: NEGATIVE_NORMALIZATION_CONSTRUCTOR_MARKER,
    rationale:
      'Dedicated negative-normalization constructor id; only the setup boundary declares it.',
  },
  {
    category: 'setup-discriminant',
    value: NEGATIVE_NORMALIZATION_FIXTURE_MARKER,
    rationale: 'Negative-normalization fixture id; only the setup boundary declares it.',
  },
  {
    category: 'setup-discriminant',
    value: NEGATIVE_NORMALIZATION_LITERAL_PROFILE_MARKER,
    rationale: 'Negative normalization literal profile; only the setup boundary declares it.',
  },
  {
    category: 'signal-discriminant',
    value: NEGATIVE_NORMALIZATION_LITERALS_MISMATCH_MARKER,
    rationale: 'Negative certificate literal-drift reason; only the setup boundary declares it.',
  },
  {
    category: 'signal-discriminant',
    value: NEGATIVE_NORMALIZATION_UNEXPECTEDLY_NORMALIZED_MARKER,
    rationale:
      'Negative certificate unexpected-fixed-point reason; only the setup boundary declares it.',
  },
  ...NESTED_OBJECT_DIAGNOSTIC_MARKERS.map<AbsenceMarker>((value) => ({
    category: 'signal-discriminant',
    value,
    rationale: 'Nested-object chain diagnostic; only the v6 seam can emit it.',
  })),
  {
    category: 'module-path',
    value: 'artworkSetupBoundary',
    rationale: 'Setup boundary module path; emitted output must not reach it.',
  },
  {
    category: 'module-path',
    value: 'useArtworkVerificationSeams',
    rationale: 'Seam mount hook module path; emitted output must not reach it.',
  },
  {
    category: 'module-path',
    value: 'verification/documentIdentity',
    rationale: 'Shared seam identity module path; emitted output must not reach it.',
  },
  {
    category: 'module-path',
    value: 'verification/normalizedMeaning',
    rationale: 'Product normalized-meaning facade module path; emitted output must not reach it.',
  },
  {
    category: 'module-path',
    value: 'verification/normalizedMeaningCore',
    rationale:
      'Node-importable normalized-meaning core module path; only verification/test code reaches it.',
  },
  {
    category: 'module-path',
    value: 'verification/normalizedMeaningResponse',
    rationale:
      'Normalized-meaning response adapter module path; only the product seam/tests reach it.',
  },
  {
    category: 'signal-discriminant',
    value: 'artwork-product-meaning-v1',
    rationale: 'Normalized-meaning profile id; only the core declares it.',
  },
  {
    category: 'signal-discriminant',
    value: 'NORMALIZED_MEANING_UNUSABLE',
    rationale: 'Normalized-meaning refusal code; only the core declares it.',
  },
  {
    category: 'setup-discriminant',
    value: 'artwork.two-layout-text.v1',
    rationale: 'Setup constructor id; only the setup boundary declares it.',
  },
  {
    category: 'setup-discriminant',
    value: 'artwork.two-layout-text.v2',
    rationale: 'Additive setup constructor v2 id; only the setup boundary declares it.',
  },
  {
    category: 'setup-discriminant',
    value: 'artwork.two-layout-image.v1',
    rationale: 'Additive image setup constructor id; only the setup boundary declares it.',
  },
  {
    category: 'setup-discriminant',
    value: 'fnv1a64',
    rationale: 'Setup fingerprint algorithm; only the setup boundary declares it.',
  },
  ...(
    [
      'SETUP_ALREADY_SEALED',
      'SETUP_AUTHORIZATION_INVALID',
      'SETUP_AUTHORIZATION_MISSING',
      'SETUP_CONSTRUCTOR_UNKNOWN',
      'SETUP_CONSTRUCTOR_VERSION_MISMATCH',
      'FIXTURE_NOT_NORMALIZED',
      'SETUP_GATE_DISABLED',
      'SETUP_HYDRATE_REJECTED',
      'SETUP_INPUT_INVALID',
      'SETUP_REQUEST_INVALID',
      'SETUP_ROUTE_INVALID',
      'SETUP_SCOPE_MISMATCH',
    ] as const
  ).map<AbsenceMarker>((value) => ({
    category: 'setup-discriminant',
    value,
    rationale: 'Setup refusal code; only the setup boundary declares it.',
  })),
];

/** Executable emitted artifacts the static scan reads. */
export const EXECUTABLE_ARTIFACT_EXTENSIONS = ['.js', '.mjs', '.cjs'] as const;

/** Manifest artifacts the static scan reads (Next build/app manifests). */
export const MANIFEST_ARTIFACT_EXTENSION = '.json';

/**
 * A build cache, source map, or dependency directory is not emitted executable
 * output. The scan skips it so a stale-but-unreachable cache entry can never be
 * reported as a reachable seam, and a content-hashed source map can never
 * conceal one.
 */
export const SCAN_SKIPPED_DIRECTORY_NAMES = ['cache', 'node_modules'] as const;
export const SCAN_SKIPPED_SUFFIXES = ['.map'] as const;

export interface ProductionArtifactHit {
  relativePath: string;
  category: AbsenceMarkerCategory;
  marker: string;
}

export interface ProductionArtifactScan {
  schemaVersion: number;
  distDir: string;
  scannedFiles: number;
  hits: readonly ProductionArtifactHit[];
  skipped: { directories: readonly string[]; files: number };
  /** True only when no executable artifact reached a seam marker. */
  clean: boolean;
}

/** Matches one requested browser path against the seam module vocabulary. */
export const SEAM_REQUEST_PATH_PATTERNS: readonly RegExp[] = [
  /artworkVerificationBridge/,
  /artworkSetupBoundary/,
  /useArtworkVerificationSeams/,
  /artwork[/-]verification\/documentIdentity/,
  /artwork[/-]verification\/observationCursor/,
  /artwork[/-]verification\/rasterEvidence/,
  /verification[/_-]normalizedMeaning/,
];

/** True when a file path is emitted executable output or a manifest. */
export function isScannedArtifact(relativePath: string): boolean {
  if (SCAN_SKIPPED_SUFFIXES.some((suffix) => relativePath.endsWith(suffix))) return false;
  if (EXECUTABLE_ARTIFACT_EXTENSIONS.some((extension) => relativePath.endsWith(extension))) {
    return true;
  }
  return relativePath.endsWith(MANIFEST_ARTIFACT_EXTENSION);
}

/** True when a directory name is an unemitted build cache or dependency tree. */
export function isSkippedDirectoryName(name: string): boolean {
  return (SCAN_SKIPPED_DIRECTORY_NAMES as readonly string[]).includes(name);
}

/**
 * Pure marker detection over one artifact's text. Exported so the negative
 * control can prove a specific marker fails the same predicate the live scan
 * uses.
 */
export function scanArtifactContent(
  relativePath: string,
  content: string,
  markers: readonly AbsenceMarker[] = PRODUCTION_ABSENCE_MARKERS,
): ProductionArtifactHit[] {
  const hits: ProductionArtifactHit[] = [];
  for (const marker of markers) {
    if (content.includes(marker.value)) {
      hits.push({ relativePath, category: marker.category, marker: marker.value });
    }
  }
  return hits;
}

/** One requested browser resource path that belongs to a seam module. */
export function seamRequestPaths(requestedPaths: readonly string[]): string[] {
  return requestedPaths.filter((path) => SEAM_REQUEST_PATH_PATTERNS.some((p) => p.test(path)));
}

// ── Browser absence observation ──────────────────────────────────────────────

/**
 * Facts read from a live production document. Every field is reported by the
 * page or the browser request log; nothing is copied from the seam contract, so
 * a violation cannot be absent merely because the harness assumed it.
 */
export interface ProductionBrowserObservation {
  attempt: 'initial' | 'reload';
  httpStatus: number | null;
  finalUrl: string;
  title: string | null;
  /** `typeof window.__MAKEIT_ARTWORK_VERIFICATION__` from the page. */
  observationGlobalType: string;
  /** `typeof window.__MAKEIT_ARTWORK_SETUP__` from the page. */
  setupGlobalType: string;
  brokerSlotPresent: boolean;
  setupAnchorSlotPresent: boolean;
  documentAnchorSlotPresent: boolean;
  /** Bridge v3 document-scoped observation signal anchor slot presence. */
  signalAnchorSlotPresent: boolean;
  /** Every resource URL the browser requested while loading the document. */
  requestedPaths: readonly string[];
}

export interface ProductionAbsenceVerdict {
  clean: boolean;
  violations: readonly string[];
}

function pathnameOf(url: string): string | null {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

/**
 * Evaluates one live observation. A `200` status, a final URL whose path is the
 * expected route (a login redirect changes both), `undefined` for both seam
 * globals, absent registered-Symbol slots, and zero seam requests are the whole
 * contract. Every violation is a stable, machine-readable token.
 */
export function evaluateProductionBrowserAbsence(
  observation: ProductionBrowserObservation,
  expectedRoute: string = PRODUCTION_ABSENCE_ROUTE,
): ProductionAbsenceVerdict {
  const violations: string[] = [];
  const prefix = observation.attempt;

  if (observation.httpStatus !== 200) {
    violations.push(`${prefix}:http-status:${String(observation.httpStatus)}`);
  }
  if (pathnameOf(observation.finalUrl) !== expectedRoute) {
    violations.push(`${prefix}:final-url:${observation.finalUrl}`);
  }
  if (observation.observationGlobalType !== 'undefined') {
    violations.push(`${prefix}:observation-global:${observation.observationGlobalType}`);
  }
  if (observation.setupGlobalType !== 'undefined') {
    violations.push(`${prefix}:setup-global:${observation.setupGlobalType}`);
  }
  if (observation.brokerSlotPresent) {
    violations.push(`${prefix}:symbol-slot:${SETUP_BROKER_SYMBOL_KEY}`);
  }
  if (observation.setupAnchorSlotPresent) {
    violations.push(`${prefix}:symbol-slot:${SETUP_ANCHOR_SYMBOL_KEY}`);
  }
  if (observation.documentAnchorSlotPresent) {
    violations.push(`${prefix}:symbol-slot:${DOCUMENT_ANCHOR_SYMBOL_KEY}`);
  }
  if (observation.signalAnchorSlotPresent) {
    violations.push(`${prefix}:symbol-slot:${SIGNAL_ANCHOR_SYMBOL_KEY}`);
  }
  for (const seam of seamRequestPaths(observation.requestedPaths)) {
    violations.push(`${prefix}:seam-request:${seam}`);
  }

  return { clean: violations.length === 0, violations };
}

export interface ProductionAbsenceProofInput {
  scan: Pick<ProductionArtifactScan, 'clean' | 'hits'>;
  observations: readonly ProductionBrowserObservation[];
}

/**
 * Combined static-scan plus browser verdict. The proof requires a clean scan
 * AND a clean initial load AND a clean reload, so a seam that only appears after
 * a navigation can never pass.
 */
export function evaluateProductionAbsence(
  input: ProductionAbsenceProofInput,
): ProductionAbsenceVerdict {
  const violations: string[] = [];
  for (const hit of input.scan.hits) {
    violations.push(`artifact:${hit.category}:${hit.marker}@${hit.relativePath}`);
  }
  if (!input.scan.clean && input.scan.hits.length === 0) {
    violations.push('artifact:scan-reported-dirty-without-hits');
  }
  if (!input.observations.some((observation) => observation.attempt === 'initial')) {
    violations.push('browser:missing-initial-observation');
  }
  if (!input.observations.some((observation) => observation.attempt === 'reload')) {
    violations.push('browser:missing-reload-observation');
  }
  for (const observation of input.observations) {
    violations.push(...evaluateProductionBrowserAbsence(observation).violations);
  }
  return { clean: violations.length === 0, violations };
}

/** A production-absence violation is a blocking harness contract failure. */
export function productionAbsenceDiagnostic(
  violations: readonly string[],
  context: Record<string, string> = {},
): DiagnosticRecord {
  const detail = `Production seam absence was not proven: ${violations.join('; ')}`;
  return createDiagnostic('PRODUCTION_ABSENCE_VIOLATION', detail, {
    context: { ...context, violations: violations.join(',') },
  });
}

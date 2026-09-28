import { RESOURCE_MANIFEST_SCHEMA_VERSION } from './schema-versions';

/**
 * Content-addressed verification resource contract (WP5 Slice 5-C).
 *
 * Slice 5-C ships two exact checked-in PNGs. The manifest is *authoring data*:
 * it declares the logical id/version, the content-addressed filename, the exact
 * byte length and SHA-256, the PNG MIME and dimensions, the declared structural
 * visual probes, provenance, and license. The resolver and route layer read it;
 * the Oracle compares the accepted page-side observations against it.
 *
 * The manifest never carries a URL, port, blob handle, adapter, workflow,
 * Oracle, script, callback, or expected outcome. Resource identity is semantic:
 * a byte change requires a new logical resource version and a new scenario / case
 * identity, while an authoring-order change moves nothing.
 */

export interface ResourceProbeRational {
  numerator: number;
  denominator: number;
}

export interface ResourceProbe {
  id: string;
  x: ResourceProbeRational;
  y: ResourceProbeRational;
  expectedRgba: readonly [number, number, number, number];
  channelTolerance: number;
}

export interface ResourceStructuralVisual {
  algorithm: string;
  probes: readonly ResourceProbe[];
}

export interface ResourceProvenance {
  origin: string;
  generator: string;
  generatorDescription: string;
  sourceDigestAlgorithm: string;
  containsThirdPartyContent: boolean;
}

export interface ResourceLicense {
  spdxId: string;
  copyrightHolder: string;
  note: string;
}

export interface ResourceManifestEntry {
  logicalId: string;
  version: number;
  filename: string;
  byteLength: number;
  sha256: string;
  mimeType: string;
  dimensions: { width: number; height: number };
  semanticPurpose: string;
  structuralVisual: ResourceStructuralVisual;
  provenance: ResourceProvenance;
  license: ResourceLicense;
}

export interface ResourceManifest {
  schemaVersion: number;
  resources: readonly ResourceManifestEntry[];
}

/** The only license this slice authorizes for its project-generated fixtures. */
export const SUPPORTED_RESOURCE_LICENSES = ['CC0-1.0'] as const;

/** The only structural-visual algorithm this slice authorizes. */
export const SUPPORTED_STRUCTURAL_VISUAL_ALGORITHMS = ['rgba-probes-v1'] as const;

/** The closed approved-operation discriminant a resource binding names. */
export const RESOURCE_USE_OPERATION = 'resource.use';

/** A fixture resource role reference (authoring data only). */
export interface ResourceRef {
  logicalId: string;
  version: number;
  role: string;
}

/**
 * True when the filename is content-addressed for the declared digest, i.e. it
 * contains the exact `--sha256-<digest>.png` suffix. A filename that does not
 * bind its own digest can be swapped without moving any identity.
 */
export function isContentAddressedFilename(filename: string, sha256: string): boolean {
  return filename.endsWith(`--sha256-${sha256}.png`);
}

/** Closed content-addressed filename pattern for a PNG digest. */
export const RESOURCE_FILENAME_PATTERN = /^[a-z0-9][a-z0-9._-]*--sha256-[0-9a-f]{64}\.png$/;

/** Stable semantic key of one resource version. */
export function resourceKey(logicalId: string, version: number): string {
  return `${logicalId}@${version}`;
}

/** The manifest schema version this toolkit reads. */
export const READABLE_RESOURCE_MANIFEST_SCHEMA_VERSION = RESOURCE_MANIFEST_SCHEMA_VERSION;

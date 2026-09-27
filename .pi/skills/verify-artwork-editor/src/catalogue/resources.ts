import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isContentAddressedFilename,
  READABLE_RESOURCE_MANIFEST_SCHEMA_VERSION,
  RESOURCE_FILENAME_PATTERN,
  SUPPORTED_RESOURCE_LICENSES,
  SUPPORTED_STRUCTURAL_VISUAL_ALGORITHMS,
  resourceKey,
  type ResourceManifest,
  type ResourceManifestEntry,
  type ResourceProbe,
  type ResourceProbeRational,
  type ResourceStructuralVisual,
} from '../contracts/resources';

/**
 * Verification resource manifest loading and hostile validation (WP5 Slice 5-C).
 *
 * The manifest is closed: unknown keys, duplicate logical ids or filenames, a
 * non-content-addressed filename, an unsupported schema/license/algorithm,
 * missing provenance/license text, a malformed probe, a traversal path, a
 * symlinked file, bytes outside the resource files root, or a byte
 * length/digest/dimension/MIME disagreement all fail closed before launch.
 */

export type ResourceCatalogueErrorCode =
  | 'RESOURCE_MANIFEST_INVALID'
  | 'RESOURCE_MANIFEST_SCHEMA_UNSUPPORTED'
  | 'RESOURCE_MANIFEST_DUPLICATE'
  | 'RESOURCE_FILE_MISSING'
  | 'RESOURCE_FILE_OUTSIDE_ROOT'
  | 'RESOURCE_FILE_SYMLINK'
  | 'RESOURCE_BYTES_MISMATCH';

export class ResourceCatalogueError extends Error {
  readonly code: ResourceCatalogueErrorCode;

  constructor(code: ResourceCatalogueErrorCode, message: string) {
    super(message);
    this.name = 'ResourceCatalogueError';
    this.code = code;
  }
}

/** Relative location of the manifest inside the toolkit root. */
export const RESOURCE_MANIFEST_RELATIVE_PATH = path.join('fixtures', 'resources', 'manifest.json');

/** Relative location of the resource files root inside the toolkit root. */
export const RESOURCE_FILES_RELATIVE_PATH = path.join('fixtures', 'resources', 'files');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(code: ResourceCatalogueErrorCode, message: string): never {
  throw new ResourceCatalogueError(code, message);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail('RESOURCE_MANIFEST_INVALID', `${label} must be a non-empty string`);
  }
  return value;
}

function requireExactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    fail('RESOURCE_MANIFEST_INVALID', `${label} has unknown keys: ${unknown.join(', ')}`);
  }
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    fail('RESOURCE_MANIFEST_INVALID', `${label} must be a positive integer`);
  }
  return value;
}

function requireSha256(value: unknown, label: string): string {
  const sha = requireString(value, label);
  if (!/^[0-9a-f]{64}$/.test(sha)) {
    fail('RESOURCE_MANIFEST_INVALID', `${label} must be a lowercase 64-hex SHA-256 digest`);
  }
  return sha;
}

/**
 * Rejects any path that is absolute, escapes the resource root, or contains a
 * raw or percent-encoded traversal segment. The filename must additionally be
 * a plain content-addressed PNG name.
 */
export function assertSafeResourceRelativePath(relative: string, label: string): void {
  if (relative.length === 0) {
    fail('RESOURCE_MANIFEST_INVALID', `${label} must not be empty`);
  }
  if (relative.startsWith('/') || relative.startsWith('\\')) {
    fail('RESOURCE_FILE_OUTSIDE_ROOT', `${label} must be a relative path`);
  }
  // Reject a raw or encoded `.`/`..` segment, an encoded separator, a query, or
  // a fragment before any normalization can hide it.
  const decoded = decodeURIComponentSafe(relative);
  for (const candidate of [relative, decoded]) {
    if (candidate.includes('\\') || candidate.includes('?') || candidate.includes('#')) {
      fail('RESOURCE_FILE_OUTSIDE_ROOT', `${label} contains a forbidden character`);
    }
    if (candidate.includes('%2f') || candidate.includes('%2F') || candidate.includes('%5c')) {
      fail('RESOURCE_FILE_OUTSIDE_ROOT', `${label} contains an encoded separator`);
    }
    for (const segment of candidate.split('/')) {
      if (segment === '' || segment === '.' || segment === '..') {
        fail('RESOURCE_FILE_OUTSIDE_ROOT', `${label} contains a traversal or empty segment`);
      }
    }
  }
  if (path.isAbsolute(relative) || path.resolve('/', relative).startsWith('/..')) {
    fail('RESOURCE_FILE_OUTSIDE_ROOT', `${label} escapes the resource root`);
  }
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseRational(raw: unknown, label: string): ResourceProbeRational {
  if (!isRecord(raw)) fail('RESOURCE_MANIFEST_INVALID', `${label} must be an object`);
  requireExactKeys(raw, ['numerator', 'denominator'], label);
  const numerator = requirePositiveInteger(raw.numerator, `${label}.numerator`);
  const denominator = requirePositiveInteger(raw.denominator, `${label}.denominator`);
  return { numerator, denominator };
}

function parseProbe(raw: unknown, label: string): ResourceProbe {
  if (!isRecord(raw)) fail('RESOURCE_MANIFEST_INVALID', `${label} must be an object`);
  requireExactKeys(raw, ['id', 'x', 'y', 'expectedRgba', 'channelTolerance'], label);
  if (
    !Array.isArray(raw.expectedRgba) ||
    raw.expectedRgba.length !== 4 ||
    !raw.expectedRgba.every((entry) => typeof entry === 'number' && Number.isInteger(entry))
  ) {
    fail('RESOURCE_MANIFEST_INVALID', `${label}.expectedRgba must be four integers`);
  }
  const tolerance = raw.channelTolerance;
  if (typeof tolerance !== 'number' || !Number.isInteger(tolerance) || tolerance < 0) {
    fail('RESOURCE_MANIFEST_INVALID', `${label}.channelTolerance must be a non-negative integer`);
  }
  return {
    id: requireString(raw.id, `${label}.id`),
    x: parseRational(raw.x, `${label}.x`),
    y: parseRational(raw.y, `${label}.y`),
    expectedRgba: [
      raw.expectedRgba[0] as number,
      raw.expectedRgba[1] as number,
      raw.expectedRgba[2] as number,
      raw.expectedRgba[3] as number,
    ],
    channelTolerance: tolerance,
  };
}

function parseStructuralVisual(raw: unknown, label: string): ResourceStructuralVisual {
  if (!isRecord(raw)) fail('RESOURCE_MANIFEST_INVALID', `${label} must be an object`);
  requireExactKeys(raw, ['algorithm', 'probes'], label);
  const algorithm = requireString(raw.algorithm, `${label}.algorithm`);
  if (!(SUPPORTED_STRUCTURAL_VISUAL_ALGORITHMS as readonly string[]).includes(algorithm)) {
    fail(
      'RESOURCE_MANIFEST_INVALID',
      `${label}.algorithm "${algorithm}" is not a supported structural-visual algorithm (${SUPPORTED_STRUCTURAL_VISUAL_ALGORITHMS.join(', ')})`,
    );
  }
  if (!Array.isArray(raw.probes) || raw.probes.length === 0) {
    fail('RESOURCE_MANIFEST_INVALID', `${label}.probes must declare at least one probe`);
  }
  const probes = raw.probes.map((entry, index) => parseProbe(entry, `${label}.probes[${index}]`));
  const ids = probes.map((probe) => probe.id);
  if (new Set(ids).size !== ids.length) {
    fail('RESOURCE_MANIFEST_INVALID', `${label}.probes declares a duplicate probe id`);
  }
  return { algorithm, probes };
}

function parseEntry(raw: unknown, index: number): ResourceManifestEntry {
  const label = `resources[${index}]`;
  if (!isRecord(raw)) fail('RESOURCE_MANIFEST_INVALID', `${label} must be an object`);
  requireExactKeys(
    raw,
    [
      'logicalId',
      'version',
      'filename',
      'byteLength',
      'sha256',
      'mimeType',
      'dimensions',
      'semanticPurpose',
      'structuralVisual',
      'provenance',
      'license',
    ],
    label,
  );
  const logicalId = requireString(raw.logicalId, `${label}.logicalId`);
  const version = requirePositiveInteger(raw.version, `${label}.version`);
  const filename = requireString(raw.filename, `${label}.filename`);
  assertSafeResourceRelativePath(filename, `${label}.filename`);
  if (!RESOURCE_FILENAME_PATTERN.test(filename)) {
    fail('RESOURCE_MANIFEST_INVALID', `${label}.filename must be a content-addressed PNG filename`);
  }
  const sha256 = requireSha256(raw.sha256, `${label}.sha256`);
  if (!isContentAddressedFilename(filename, sha256)) {
    fail(
      'RESOURCE_MANIFEST_INVALID',
      `${label}.filename is not content-addressed for its declared sha256`,
    );
  }
  const mimeType = requireString(raw.mimeType, `${label}.mimeType`);
  if (mimeType !== 'image/png') {
    fail('RESOURCE_MANIFEST_INVALID', `${label}.mimeType must be image/png`);
  }
  if (!isRecord(raw.dimensions)) {
    fail('RESOURCE_MANIFEST_INVALID', `${label}.dimensions must be an object`);
  }
  requireExactKeys(raw.dimensions, ['width', 'height'], `${label}.dimensions`);
  const width = requirePositiveInteger(raw.dimensions.width, `${label}.dimensions.width`);
  const height = requirePositiveInteger(raw.dimensions.height, `${label}.dimensions.height`);

  if (!isRecord(raw.provenance)) {
    fail('RESOURCE_MANIFEST_INVALID', `${label}.provenance must be an object`);
  }
  requireExactKeys(
    raw.provenance,
    [
      'origin',
      'generator',
      'generatorDescription',
      'sourceDigestAlgorithm',
      'containsThirdPartyContent',
    ],
    `${label}.provenance`,
  );
  if (typeof raw.provenance.containsThirdPartyContent !== 'boolean') {
    fail(
      'RESOURCE_MANIFEST_INVALID',
      `${label}.provenance.containsThirdPartyContent must be a boolean`,
    );
  }
  const sourceDigestAlgorithm = requireString(
    raw.provenance.sourceDigestAlgorithm,
    `${label}.provenance.sourceDigestAlgorithm`,
  );
  if (sourceDigestAlgorithm !== 'sha256') {
    fail('RESOURCE_MANIFEST_INVALID', `${label}.provenance.sourceDigestAlgorithm must be sha256`);
  }

  if (!isRecord(raw.license)) {
    fail('RESOURCE_MANIFEST_INVALID', `${label}.license must be an object`);
  }
  requireExactKeys(raw.license, ['spdxId', 'copyrightHolder', 'note'], `${label}.license`);
  const spdxId = requireString(raw.license.spdxId, `${label}.license.spdxId`);
  if (!(SUPPORTED_RESOURCE_LICENSES as readonly string[]).includes(spdxId)) {
    fail(
      'RESOURCE_MANIFEST_INVALID',
      `${label}.license.spdxId "${spdxId}" is not a supported license (${SUPPORTED_RESOURCE_LICENSES.join(', ')})`,
    );
  }

  return {
    logicalId,
    version,
    filename,
    byteLength: requirePositiveInteger(raw.byteLength, `${label}.byteLength`),
    sha256,
    mimeType,
    dimensions: { width, height },
    semanticPurpose: requireString(raw.semanticPurpose, `${label}.semanticPurpose`),
    structuralVisual: parseStructuralVisual(raw.structuralVisual, `${label}.structuralVisual`),
    provenance: {
      origin: requireString(raw.provenance.origin, `${label}.provenance.origin`),
      generator: requireString(raw.provenance.generator, `${label}.provenance.generator`),
      generatorDescription: requireString(
        raw.provenance.generatorDescription,
        `${label}.provenance.generatorDescription`,
      ),
      sourceDigestAlgorithm,
      containsThirdPartyContent: raw.provenance.containsThirdPartyContent,
    },
    license: {
      spdxId,
      copyrightHolder: requireString(
        raw.license.copyrightHolder,
        `${label}.license.copyrightHolder`,
      ),
      note: requireString(raw.license.note, `${label}.license.note`),
    },
  };
}

/** Structural manifest parse (no filesystem access). */
export function parseResourceManifest(raw: unknown): ResourceManifest {
  if (!isRecord(raw)) {
    fail('RESOURCE_MANIFEST_INVALID', 'Resource manifest must be an object');
  }
  requireExactKeys(raw, ['schemaVersion', 'resources'], 'manifest');
  if (raw.schemaVersion !== READABLE_RESOURCE_MANIFEST_SCHEMA_VERSION) {
    fail(
      'RESOURCE_MANIFEST_SCHEMA_UNSUPPORTED',
      `Unsupported resource manifest schema version: ${String(raw.schemaVersion)}`,
    );
  }
  if (!Array.isArray(raw.resources) || raw.resources.length === 0) {
    fail('RESOURCE_MANIFEST_INVALID', 'Resource manifest must declare at least one resource');
  }
  const resources = raw.resources.map(parseEntry);
  const keys = resources.map((entry) => resourceKey(entry.logicalId, entry.version));
  if (new Set(keys).size !== keys.length) {
    fail('RESOURCE_MANIFEST_DUPLICATE', 'Resource manifest declares a duplicate logicalId@version');
  }
  const filenames = resources.map((entry) => entry.filename);
  if (new Set(filenames).size !== filenames.length) {
    fail('RESOURCE_MANIFEST_DUPLICATE', 'Resource manifest declares a duplicate filename');
  }
  return {
    schemaVersion: raw.schemaVersion,
    resources: resources.sort((left, right) =>
      resourceKey(left.logicalId, left.version) < resourceKey(right.logicalId, right.version)
        ? -1
        : 1,
    ),
  };
}

/** Decoded PNG header facts read from raw bytes. */
export interface PngHeader {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
  mimeType: 'image/png';
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Parses the IHDR of a non-interlaced 8-bit PNG without decoding pixels. */
export function readPngHeader(bytes: Buffer): PngHeader {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new ResourceCatalogueError(
      'RESOURCE_BYTES_MISMATCH',
      'Resource bytes are not a PNG (missing signature).',
    );
  }
  if (bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw new ResourceCatalogueError(
      'RESOURCE_BYTES_MISMATCH',
      'Resource PNG has no leading IHDR chunk.',
    );
  }
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bitDepth: bytes[24] as number,
    colorType: bytes[25] as number,
    interlace: bytes[28] as number,
    mimeType: 'image/png',
  };
}

export function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Resolves one manifest entry's absolute path, refusing any escape or symlink. */
export function resolveResourceEntryPath(entry: ResourceManifestEntry, filesRoot: string): string {
  assertSafeResourceRelativePath(entry.filename, 'filename');
  const absolute = path.resolve(filesRoot, entry.filename);
  const relative = path.relative(path.resolve(filesRoot), absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('RESOURCE_FILE_OUTSIDE_ROOT', `Resource file escapes the files root: ${entry.filename}`);
  }
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(absolute);
  } catch {
    fail('RESOURCE_FILE_MISSING', `Resource file is unavailable: ${entry.filename}`);
  }
  if (stats.isSymbolicLink()) {
    fail('RESOURCE_FILE_SYMLINK', `Resource file must not be a symlink: ${entry.filename}`);
  }
  if (!stats.isFile()) {
    fail('RESOURCE_FILE_MISSING', `Resource path is not a regular file: ${entry.filename}`);
  }
  return absolute;
}

/**
 * Reads a resource file and verifies byte length, SHA-256, MIME/dimensions, and
 * the RGBA/non-interlaced PNG shape against the manifest. Used at load time and
 * again immediately before every native file dispatch.
 */
export function verifyResourceBytes(
  entry: ResourceManifestEntry,
  filesRoot: string,
): { absolutePath: string; bytes: Buffer } {
  const absolutePath = resolveResourceEntryPath(entry, filesRoot);
  const bytes = readFileSync(absolutePath);
  if (bytes.byteLength !== entry.byteLength) {
    fail(
      'RESOURCE_BYTES_MISMATCH',
      `Resource "${entry.logicalId}" byte length ${bytes.byteLength} does not match manifest ${entry.byteLength}.`,
    );
  }
  if (sha256Of(bytes) !== entry.sha256) {
    fail(
      'RESOURCE_BYTES_MISMATCH',
      `Resource "${entry.logicalId}" SHA-256 does not match manifest.`,
    );
  }
  const header = readPngHeader(bytes);
  if (header.width !== entry.dimensions.width || header.height !== entry.dimensions.height) {
    fail(
      'RESOURCE_BYTES_MISMATCH',
      `Resource "${entry.logicalId}" dimensions ${header.width}x${header.height} do not match manifest ${entry.dimensions.width}x${entry.dimensions.height}.`,
    );
  }
  if (header.bitDepth !== 8 || header.colorType !== 6 || header.interlace !== 0) {
    fail(
      'RESOURCE_BYTES_MISMATCH',
      `Resource "${entry.logicalId}" must be 8-bit RGBA, non-interlaced (got bitDepth=${header.bitDepth}, colorType=${header.colorType}, interlace=${header.interlace}).`,
    );
  }
  return { absolutePath, bytes };
}

function resolveSkillRoot(): string {
  const moduleUrl = import.meta.url;
  if (typeof moduleUrl === 'string' && moduleUrl.startsWith('file:')) {
    return fileURLToPath(new URL('../../', moduleUrl));
  }
  return path.resolve(process.cwd(), path.join('.pi', 'skills', 'verify-artwork-editor'));
}

export interface LoadResourceManifestOptions {
  /** Skill root containing `fixtures/resources/`. Defaults to the toolkit root. */
  rootDir?: string;
}

/**
 * Loads the manifest, structurally validates it, and verifies every declared
 * file's bytes on disk. The result is a fresh deep copy.
 */
export function loadResourceManifest(options: LoadResourceManifestOptions = {}): ResourceManifest {
  const rootDir = options.rootDir ?? resolveSkillRoot();
  const manifestPath = path.join(rootDir, RESOURCE_MANIFEST_RELATIVE_PATH);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
  } catch (error) {
    throw new ResourceCatalogueError(
      'RESOURCE_MANIFEST_INVALID',
      `Resource manifest could not be read as JSON: ${(error as Error).message}`,
    );
  }
  const manifest = parseResourceManifest(raw);
  const filesRoot = path.join(rootDir, RESOURCE_FILES_RELATIVE_PATH);
  for (const entry of manifest.resources) {
    verifyResourceBytes(entry, filesRoot);
  }
  return structuredClone(manifest);
}

/** Exact manifest lookup; a missing resource is `null`, never guessed. */
export function findResource(
  manifest: ResourceManifest,
  logicalId: string,
  version: number,
): ResourceManifestEntry | null {
  return (
    manifest.resources.find(
      (entry) => entry.logicalId === logicalId && entry.version === version,
    ) ?? null
  );
}

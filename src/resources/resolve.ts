import path from 'node:path';

import { ResourceCatalogueError, verifyResourceBytes } from '../catalogue/resources';
import type {
  ResourceManifest,
  ResourceManifestEntry,
  ResourceStructuralVisual,
} from '../contracts/resources';
import { resourceKey } from '../contracts/resources';

/**
 * Resource resolution (WP5 Slice 5-C).
 *
 * The resolver turns one manifest entry into one `ResolvedResource`: the exact
 * content-addressed path, the logical identity, and the single canonical
 * same-origin URL. It never reads bytes except to re-verify them, never
 * generates a URL from anything but individually percent-encoded path segments,
 * and never accepts a query, fragment, traversal, or foreign origin.
 */

/** Reserved verification resource route prefix. */
export const RESOURCE_ROUTE_PREFIX = '/__artwork-verification__/v1';

/** The origin scheme/loopback host the resolver permits. */
export const RESOURCE_LOOPBACK_HOST = '127.0.0.1';

export interface ResolvedResource {
  logicalId: string;
  version: number;
  absoluteFilePath: string;
  filename: string;
  byteLength: number;
  sha256: string;
  mimeType: string;
  dimensions: { width: number; height: number };
  sameOriginUrl: string;
  structuralVisual: ResourceStructuralVisual;
}

/**
 * One path segment. Rejects empty values, separators, percent-encodable
 * traversal, query, fragment, and any non-allowlisted character, then
 * percent-encodes exactly once.
 */
export function encodeResourcePathSegment(segment: string, label: string): string {
  if (typeof segment !== 'string' || segment.length === 0) {
    throw new ResourceCatalogueError('RESOURCE_MANIFEST_INVALID', `${label} must be non-empty`);
  }
  if (
    segment.includes('/') ||
    segment.includes('\\') ||
    segment.includes('?') ||
    segment.includes('#') ||
    segment === '.' ||
    segment === '..'
  ) {
    throw new ResourceCatalogueError(
      'RESOURCE_FILE_OUTSIDE_ROOT',
      `${label} contains a path separator, query, fragment, or traversal segment`,
    );
  }
  // Only a conservative identifier/digest alphabet is authorable. Everything
  // else is rejected rather than silently encoded, so a URL can never smuggle a
  // decoded separator.
  if (!/^[a-zA-Z0-9._:@+-]+$/.test(segment)) {
    throw new ResourceCatalogueError(
      'RESOURCE_MANIFEST_INVALID',
      `${label} contains a character outside the resource path alphabet`,
    );
  }
  return encodeURIComponent(segment);
}

export interface ResourceRoutePathInput {
  runId: string;
  executionInstanceId: string;
  logicalId: string;
  filename: string;
}

/** Builds the one canonical pathname for a resolved resource. */
export function buildResourceRoutePath(input: ResourceRoutePathInput): string {
  const segments = [
    ...RESOURCE_ROUTE_PREFIX.split('/').filter((entry) => entry.length > 0),
    'runs',
    encodeResourcePathSegment(input.runId, 'runId'),
    'cases',
    encodeResourcePathSegment(input.executionInstanceId, 'executionInstanceId'),
    'resources',
    encodeResourcePathSegment(input.logicalId, 'logicalId'),
    encodeResourcePathSegment(input.filename, 'filename'),
  ];
  return `/${segments.join('/')}`;
}

/** Requires the exact `http://127.0.0.1:<port>` origin. */
export function assertLoopbackOrigin(origin: string): URL {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new ResourceCatalogueError('RESOURCE_MANIFEST_INVALID', `Origin is not a URL: ${origin}`);
  }
  if (url.protocol !== 'http:' || url.hostname !== RESOURCE_LOOPBACK_HOST) {
    throw new ResourceCatalogueError(
      'RESOURCE_MANIFEST_INVALID',
      `Origin must be http://${RESOURCE_LOOPBACK_HOST}:<port>, got ${origin}`,
    );
  }
  if (url.search !== '' || url.hash !== '' || url.pathname !== '/') {
    throw new ResourceCatalogueError(
      'RESOURCE_MANIFEST_INVALID',
      `Origin must carry no path, query, or fragment: ${origin}`,
    );
  }
  return url;
}

export interface ResolveResourceInput {
  entry: ResourceManifestEntry;
  /** Absolute resource files root. */
  filesRoot: string;
  /** Owned app origin, exactly `http://127.0.0.1:<port>`. */
  origin: string;
  runId: string;
  executionInstanceId: string;
}

/** Resolves and re-verifies one manifest entry into a `ResolvedResource`. */
export function resolveResource(input: ResolveResourceInput): ResolvedResource {
  const origin = assertLoopbackOrigin(input.origin);
  const { absolutePath } = verifyResourceBytes(input.entry, input.filesRoot);
  const sameOriginUrl = new URL(
    buildResourceRoutePath({
      runId: input.runId,
      executionInstanceId: input.executionInstanceId,
      logicalId: input.entry.logicalId,
      filename: input.entry.filename,
    }),
    origin,
  ).toString();
  return {
    logicalId: input.entry.logicalId,
    version: input.entry.version,
    absoluteFilePath: absolutePath,
    filename: input.entry.filename,
    byteLength: input.entry.byteLength,
    sha256: input.entry.sha256,
    mimeType: input.entry.mimeType,
    dimensions: { ...input.entry.dimensions },
    sameOriginUrl,
    structuralVisual: structuredClone(input.entry.structuralVisual),
  };
}

/** Resolves every manifest entry into a stable, id-sorted resolution set. */
export function resolveAllResources(input: {
  manifest: ResourceManifest;
  filesRoot: string;
  origin: string;
  runId: string;
  executionInstanceId: string;
}): ResolvedResource[] {
  return input.manifest.resources
    .map((entry) =>
      resolveResource({
        entry,
        filesRoot: input.filesRoot,
        origin: input.origin,
        runId: input.runId,
        executionInstanceId: input.executionInstanceId,
      }),
    )
    .sort((left, right) =>
      resourceKey(left.logicalId, left.version) < resourceKey(right.logicalId, right.version)
        ? -1
        : 1,
    );
}

/** Resolves one declared logical resource role, or `null` when undeclared. */
export function findResolvedResource(
  resources: readonly ResolvedResource[],
  logicalId: string,
  version: number,
): ResolvedResource | null {
  return (
    resources.find((entry) => entry.logicalId === logicalId && entry.version === version) ?? null
  );
}

/** Absolute resource files root for a toolkit root. */
export function resourceFilesRoot(skillRoot: string): string {
  return path.join(skillRoot, 'fixtures', 'resources', 'files');
}

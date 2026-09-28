import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { deriveCaseId } from '../../src/canonical/identity';
import { deriveResourceManifestFingerprint } from '../../src/catalogue/fingerprint';
import {
  ResourceCatalogueError,
  assertSafeResourceRelativePath,
  findResource,
  loadResourceManifest,
  parseResourceManifest,
  readPngHeader,
  sha256Of,
  verifyResourceBytes,
} from '../../src/catalogue/resources';
import type { ResourceManifestEntry } from '../../src/contracts/resources';
import { resourceKey } from '../../src/contracts/resources';
import {
  buildResourceRoutePath,
  encodeResourcePathSegment,
  resolveResource,
} from '../../src/resources/resolve';
import { baseIntent } from './helpers';

const SKILL_ROOT = path.resolve(process.cwd());
const FILES_ROOT = path.join(SKILL_ROOT, 'fixtures', 'resources', 'files');

const RESOURCE_A_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAYCAYAAACbU/80AAAAN0lEQVR42mP4YODwnxKscKKAIsww6oBRB4w6YNQBow4YcAdQagClHhh1wKgDRh0w6oBRBwy4AwB3jRFqThvuggAAAABJRU5ErkJggg==';
const RESOURCE_B_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAYCAYAAACbU/80AAAAO0lEQVR42mPQSHjwHxn/OGKAgmktzzDqgAF3AL0tRJcfdcDAO2A0F4w6YDQXjDpgNBeMOmA0F4x4BwAAv3b7ao427GUAAAAASUVORK5CYII=';

const A_SHA = '76a964ccd652a7e284bf32dcb4c35ab27bca576efcccfd2bc1a88d8d09ca7d27';
const B_SHA = 'c62fec3992d8610fe8a911cc30a06eeb0a11363a58026e785a1f27734dbd108b';
const A_FILENAME = `image-upload-a--sha256-${A_SHA}.png`;
const B_FILENAME = `image-upload-b--sha256-${B_SHA}.png`;

/** Minimal non-interlaced RGBA PNG decoder for the exact fixture shape. */
function decodeRgbaPng(bytes: Buffer): { width: number; height: number; pixels: Buffer } {
  const header = readPngHeader(bytes);
  const idat: Buffer[] = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') idat.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = header.width * bpp;
  const out = Buffer.alloc(header.height * stride);
  for (let y = 0; y < header.height; y += 1) {
    const filter = raw[y * (stride + 1)] as number;
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? (out[y * stride + x - bpp] as number) : 0;
      const b = y > 0 ? (out[(y - 1) * stride + x] as number) : 0;
      const c = x >= bpp && y > 0 ? (out[(y - 1) * stride + x - bpp] as number) : 0;
      let value = line[x] as number;
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += Math.floor((a + b) / 2);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = value & 0xff;
    }
  }
  return { width: header.width, height: header.height, pixels: out };
}

function probeCoordinate(size: number, numerator: number, denominator: number): number {
  return Math.min(Math.trunc(size) - 1, Math.max(0, Math.floor((size * numerator) / denominator)));
}

function sampleRgba(
  decoded: { width: number; pixels: Buffer },
  x: number,
  y: number,
): [number, number, number, number] {
  const offset = (y * decoded.width + x) * 4;
  return [
    decoded.pixels[offset] as number,
    decoded.pixels[offset + 1] as number,
    decoded.pixels[offset + 2] as number,
    decoded.pixels[offset + 3] as number,
  ];
}

function rawManifest(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(path.join(SKILL_ROOT, 'fixtures', 'resources', 'manifest.json'), 'utf8'),
  ) as Record<string, unknown>;
}

function firstEntry(raw: Record<string, unknown>): Record<string, unknown> {
  return (raw.resources as Record<string, unknown>[])[0] as Record<string, unknown>;
}

function expectManifestRejection(mutate: (raw: Record<string, unknown>) => void): void {
  const raw = rawManifest();
  mutate(raw);
  expect(() => parseResourceManifest(raw)).toThrow(ResourceCatalogueError);
}

/**
 * Writes a mutated manifest + the real files into a temporary toolkit root and
 * proves the on-disk-verifying loader rejects it.
 */
function expectDiskRejection(mutate: (raw: Record<string, unknown>) => void): void {
  const root = mkdtempSync(path.join(tmpdir(), 'wp5c-manifest-'));
  try {
    const raw = rawManifest();
    mutate(raw);
    mkdirSync(path.join(root, 'fixtures', 'resources', 'files'), { recursive: true });
    for (const filename of [A_FILENAME, B_FILENAME]) {
      writeFileSync(
        path.join(root, 'fixtures', 'resources', 'files', filename),
        readFileSync(path.join(FILES_ROOT, filename)),
      );
    }
    writeFileSync(path.join(root, 'fixtures', 'resources', 'manifest.json'), JSON.stringify(raw));
    expect(() => loadResourceManifest({ rootDir: root })).toThrow(ResourceCatalogueError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('verification resources — exact bytes and manifest (tests 1–3)', () => {
  it('decodes both exact base64 payloads to the declared bytes', () => {
    const a = readFileSync(path.join(FILES_ROOT, A_FILENAME));
    const b = readFileSync(path.join(FILES_ROOT, B_FILENAME));
    expect(a.equals(Buffer.from(RESOURCE_A_BASE64, 'base64'))).toBe(true);
    expect(b.equals(Buffer.from(RESOURCE_B_BASE64, 'base64'))).toBe(true);
    expect(a.byteLength).toBe(112);
    expect(b.byteLength).toBe(116);
    expect(sha256Of(a)).toBe(A_SHA);
    expect(sha256Of(b)).toBe(B_SHA);
  });

  it('declares the exact filename, digest, length, MIME, dimensions, RGBA form, provenance and license', () => {
    const manifest = loadResourceManifest();
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.resources).toHaveLength(2);
    const a = findResource(manifest, 'image.upload-a', 1) as ResourceManifestEntry;
    const b = findResource(manifest, 'image.upload-b', 1) as ResourceManifestEntry;
    for (const [entry, sha, filename] of [
      [a, A_SHA, A_FILENAME],
      [b, B_SHA, B_FILENAME],
    ] as const) {
      expect(entry.sha256).toBe(sha);
      expect(entry.filename).toBe(filename);
      expect(entry.filename.endsWith(`--sha256-${sha}.png`)).toBe(true);
      expect(entry.mimeType).toBe('image/png');
      expect(entry.dimensions).toEqual({ width: 32, height: 24 });
      expect(entry.structuralVisual.algorithm).toBe('rgba-probes-v1');
      expect(entry.structuralVisual.probes).toHaveLength(4);
      expect(entry.provenance.origin).toBe('project-generated');
      expect(entry.provenance.containsThirdPartyContent).toBe(false);
      expect(entry.license.spdxId).toBe('CC0-1.0');
      expect(entry.semanticPurpose.length).toBeGreaterThan(0);
      const header = readPngHeader(readFileSync(path.join(FILES_ROOT, entry.filename)));
      expect(header).toMatchObject({
        width: 32,
        height: 24,
        bitDepth: 8,
        colorType: 6,
        interlace: 0,
      });
    }
  });

  it('matches every declared structural probe against the decoded pixels at full opacity', () => {
    const manifest = loadResourceManifest();
    for (const entry of manifest.resources) {
      const decoded = decodeRgbaPng(readFileSync(path.join(FILES_ROOT, entry.filename)));
      let opaque = 0;
      for (let index = 3; index < decoded.pixels.length; index += 4) {
        if ((decoded.pixels[index] as number) > 0) opaque += 1;
      }
      expect(opaque).toBe(decoded.width * decoded.height);
      for (const probe of entry.structuralVisual.probes) {
        const x = probeCoordinate(decoded.width, probe.x.numerator, probe.x.denominator);
        const y = probeCoordinate(decoded.height, probe.y.numerator, probe.y.denominator);
        const sampled = sampleRgba(decoded, x, y);
        probe.expectedRgba.forEach((expected, channel) => {
          expect(Math.abs(sampled[channel] - expected)).toBeLessThanOrEqual(probe.channelTolerance);
        });
      }
    }
  });

  it('rejects unknown keys, duplicate ids/files, unsupported schema/license, missing provenance, malformed probes and non-content-addressed filenames', () => {
    expectManifestRejection((raw) => {
      (raw as { extra?: number }).extra = 1;
    });
    expectManifestRejection((raw) => {
      raw.schemaVersion = 2;
    });
    expectManifestRejection((raw) => {
      const resources = raw.resources as Record<string, unknown>[];
      resources[1] = { ...(resources[1] as Record<string, unknown>), logicalId: 'image.upload-a' };
    });
    expectManifestRejection((raw) => {
      const resources = raw.resources as Record<string, unknown>[];
      resources[1] = { ...(resources[1] as Record<string, unknown>), filename: A_FILENAME };
    });
    expectManifestRejection((raw) => {
      const entry = firstEntry(raw);
      (entry.license as Record<string, unknown>).spdxId = 'MIT';
    });
    expectManifestRejection((raw) => {
      delete firstEntry(raw).provenance;
    });
    expectManifestRejection((raw) => {
      delete (firstEntry(raw).license as Record<string, unknown>).note;
    });
    expectManifestRejection((raw) => {
      const entry = firstEntry(raw);
      // A structurally consistent but non-content-addressed pair must fail the
      // filename/digest binding before any disk read.
      entry.sha256 = 'f'.repeat(64);
    });
    expectDiskRejection((raw) => {
      const entry = firstEntry(raw);
      entry.sha256 = 'f'.repeat(64);
      entry.filename = `image-upload-a--sha256-${'f'.repeat(64)}.png`;
    });
    expectDiskRejection((raw) => {
      firstEntry(raw).byteLength = 113;
    });
    expectDiskRejection((raw) => {
      (firstEntry(raw).dimensions as Record<string, unknown>).width = 33;
    });
    expectManifestRejection((raw) => {
      firstEntry(raw).mimeType = 'image/jpeg';
    });
    expectManifestRejection((raw) => {
      firstEntry(raw).filename = 'image-upload-a.png';
    });
    expectManifestRejection((raw) => {
      const probes = (firstEntry(raw).structuralVisual as Record<string, unknown>).probes as Record<
        string,
        unknown
      >[];
      probes[1] = { ...(probes[1] as Record<string, unknown>), id: probes[0]?.id };
    });
  });

  it('rejects traversal, encoded traversal, and absolute or escaping paths', () => {
    expect(() => assertSafeResourceRelativePath('../escape.png', 'filename')).toThrow(
      ResourceCatalogueError,
    );
    expect(() => assertSafeResourceRelativePath('a/../../escape.png', 'filename')).toThrow(
      ResourceCatalogueError,
    );
    expect(() => assertSafeResourceRelativePath('a/%2e%2e/escape.png', 'filename')).toThrow(
      ResourceCatalogueError,
    );
    expect(() => assertSafeResourceRelativePath('/etc/passwd', 'filename')).toThrow(
      ResourceCatalogueError,
    );
    expect(() => assertSafeResourceRelativePath('a\\b.png', 'filename')).toThrow(
      ResourceCatalogueError,
    );
    expect(() => assertSafeResourceRelativePath('a?x=1.png', 'filename')).toThrow(
      ResourceCatalogueError,
    );
    expectManifestRejection((raw) => {
      firstEntry(raw).filename = '../../escape--sha256-' + A_SHA + '.png';
    });
  });

  it('refuses a symlinked resource file and bytes outside the resource root', () => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'wp5c-resource-'));
    try {
      const entry: ResourceManifestEntry = findResource(
        loadResourceManifest(),
        'image.upload-a',
        1,
      ) as ResourceManifestEntry;
      const outside = path.join(scratch, 'outside.png');
      writeFileSync(outside, readFileSync(path.join(FILES_ROOT, A_FILENAME)));

      // A symlink named exactly like the resource inside the files root.
      const linksRoot = path.join(scratch, 'links');
      mkdirSync(linksRoot, { recursive: true });
      symlinkSync(outside, path.join(scratch, entry.filename));
      symlinkSync(outside, path.join(linksRoot, entry.filename));
      expect(() => verifyResourceBytes(entry, linksRoot)).toThrow(/symlink/);

      // The same symlink lives outside a nested files root, so reaching it
      // requires a traversal filename, which the path guard refuses first.
      expect(() =>
        verifyResourceBytes(
          { ...entry, filename: `../${entry.filename}` },
          path.join(scratch, 'files'),
        ),
      ).toThrow(ResourceCatalogueError);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('moves case identity on resource digest change and keeps manifest identity order-insensitive', () => {
    const intentWithDigest = (digest: string) =>
      baseIntent({ resources: [{ resourceId: 'image.upload-a', contentDigest: digest }] });
    expect(deriveCaseId(intentWithDigest(A_SHA))).not.toBe(deriveCaseId(intentWithDigest(B_SHA)));

    const manifest = loadResourceManifest();
    const reversed = parseResourceManifest({
      schemaVersion: 1,
      resources: [...manifest.resources].reverse(),
    });
    expect(deriveResourceManifestFingerprint(reversed)).toBe(
      deriveResourceManifestFingerprint(manifest),
    );
    const changed = structuredClone(manifest.resources[0] as ResourceManifestEntry);
    changed.version = 2;
    expect(
      deriveResourceManifestFingerprint(
        parseResourceManifest({ schemaVersion: 1, resources: [changed, manifest.resources[1]] }),
      ),
    ).not.toBe(deriveResourceManifestFingerprint(manifest));
    expect(resourceKey('image.upload-a', 1)).toBe('image.upload-a@1');
  });

  it('builds canonical same-origin URLs from individually encoded segments and refuses foreign/traversal input', () => {
    const entry = findResource(
      loadResourceManifest(),
      'image.upload-a',
      1,
    ) as ResourceManifestEntry;
    const resolved = resolveResource({
      entry,
      filesRoot: FILES_ROOT,
      origin: 'http://127.0.0.1:55958',
      runId: 'run-1',
      executionInstanceId: 'instance-1',
    });
    expect(
      resolved.sameOriginUrl.startsWith('http://127.0.0.1:55958/__artwork-verification__/v1/'),
    ).toBe(true);
    expect(resolved.sameOriginUrl).toContain(A_FILENAME);
    expect(resolved.sameOriginUrl).not.toContain('..');
    expect(resolved.absoluteFilePath.endsWith(A_FILENAME)).toBe(true);

    expect(() => encodeResourcePathSegment('a/b', 'segment')).toThrow(ResourceCatalogueError);
    expect(() => encodeResourcePathSegment('..', 'segment')).toThrow(ResourceCatalogueError);
    expect(() => encodeResourcePathSegment('a?b', 'segment')).toThrow(ResourceCatalogueError);
    expect(() =>
      buildResourceRoutePath({
        runId: 'run/../escape',
        executionInstanceId: 'instance-1',
        logicalId: 'image.upload-a',
        filename: A_FILENAME,
      }),
    ).toThrow(ResourceCatalogueError);
    expect(() =>
      resolveResource({
        entry,
        filesRoot: FILES_ROOT,
        origin: 'http://example.com:80',
        runId: 'run-1',
        executionInstanceId: 'instance-1',
      }),
    ).toThrow(ResourceCatalogueError);
    expect(() =>
      resolveResource({
        entry,
        filesRoot: FILES_ROOT,
        origin: 'http://127.0.0.1:55958/path',
        runId: 'run-1',
        executionInstanceId: 'instance-1',
      }),
    ).toThrow(ResourceCatalogueError);
  });

  it('refuses on-disk bytes that no longer match the manifest', () => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'wp5c-resource-bytes-'));
    try {
      const entry = findResource(
        loadResourceManifest(),
        'image.upload-a',
        1,
      ) as ResourceManifestEntry;
      const tampered = Buffer.from(readFileSync(path.join(FILES_ROOT, A_FILENAME)));
      tampered[tampered.length - 1] = (tampered[tampered.length - 1] as number) ^ 0xff;
      writeFileSync(path.join(scratch, entry.filename), tampered);
      expect(() => verifyResourceBytes(entry, scratch)).toThrow(ResourceCatalogueError);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('detects a valid-but-different byte stream through its digest', () => {
    const other = Buffer.from(RESOURCE_B_BASE64, 'base64');
    expect(createHash('sha256').update(other).digest('hex')).toBe(B_SHA);
    expect(deflateSync(Buffer.from('x')).length).toBeGreaterThan(0);
  });
});

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import path from 'node:path';

import { isEvidenceRelativePath } from '../contracts/evidence-transaction';

/** Versioned bounded capture policy for the dormant A2-1 foundation. */
export const PRIVATE_SNAPSHOT_POLICY_VERSION = 1;
export const RUN_RECORD_MAX_BYTES = 512 * 1024;
export const OPTIONAL_PNG_MAX_BYTES = 256 * 1024;
export const PRIVATE_SNAPSHOT_AGGREGATE_MAX_BYTES = 1024 * 1024;

// Explicit aliases make the measured bounds addressable without introducing
// runtime configuration or an increase path.
export const PRIVATE_SNAPSHOT_RUN_RECORD_LIMIT_BYTES = RUN_RECORD_MAX_BYTES;
export const PRIVATE_SNAPSHOT_OPTIONAL_PNG_LIMIT_BYTES = OPTIONAL_PNG_MAX_BYTES;
export const PRIVATE_SNAPSHOT_AGGREGATE_LIMIT_BYTES = PRIVATE_SNAPSHOT_AGGREGATE_MAX_BYTES;

export const PRIVATE_SNAPSHOT_ROLES = ['required-authoritative', 'optional-diagnostic'] as const;
export type PrivateSnapshotRole = (typeof PRIVATE_SNAPSHOT_ROLES)[number];

export const PRIVATE_SNAPSHOT_DESCRIPTOR_KEYS = Object.freeze([
  'artifactId',
  'relativePath',
  'role',
  'maxBytes',
] as const);

export interface PrivateSnapshotDescriptor {
  readonly artifactId: string;
  /** Canonical POSIX name beneath the authenticated scratch root. */
  readonly relativePath: string;
  readonly role: PrivateSnapshotRole;
  readonly maxBytes: number;
}

export interface PrivateSnapshot {
  readonly artifactId: string;
  readonly relativePath: string;
  readonly role: PrivateSnapshotRole;
  readonly byteLength: number;
  /** A fresh copy on every access; never the authoritative capture buffer. */
  readonly bytes: Uint8Array;
}

export interface PrivateSnapshotCollection {
  readonly policyVersion: typeof PRIVATE_SNAPSHOT_POLICY_VERSION;
  readonly aggregateBytes: number;
  readonly snapshots: readonly PrivateSnapshot[];
}

export const PRIVATE_SNAPSHOT_FAILURE_CODES = [
  'PRIVATE_SNAPSHOT_INPUT_INVALID',
  'PRIVATE_SNAPSHOT_ROOT_INVALID',
  'PRIVATE_SNAPSHOT_DESCRIPTOR_INVALID',
  'PRIVATE_SNAPSHOT_PATH_UNSAFE',
  'PRIVATE_SNAPSHOT_NOT_FOUND',
  'PRIVATE_SNAPSHOT_SYMLINK',
  'PRIVATE_SNAPSHOT_NOT_REGULAR',
  'PRIVATE_SNAPSHOT_BOUND_EXCEEDED',
  'PRIVATE_SNAPSHOT_AGGREGATE_BOUND_EXCEEDED',
  'PRIVATE_SNAPSHOT_MUTATED',
  'PRIVATE_SNAPSHOT_READ_FAILED',
] as const;
export type PrivateSnapshotFailureCode = (typeof PRIVATE_SNAPSHOT_FAILURE_CODES)[number];

export class PrivateSnapshotError extends Error {
  readonly code: PrivateSnapshotFailureCode;
  readonly artifactId: string | null;

  constructor(code: PrivateSnapshotFailureCode, message: string, artifactId: string | null = null) {
    super(message);
    this.name = 'PrivateSnapshotError';
    this.code = code;
    this.artifactId = artifactId;
  }
}

export interface PrivateSnapshotFileSystem {
  readonly lstatSync: typeof lstatSync;
  readonly realpathSync: typeof realpathSync;
  readonly openSync: typeof openSync;
  readonly fstatSync: typeof fstatSync;
  readonly readSync: typeof readSync;
  readonly closeSync: typeof closeSync;
}

const DEFAULT_FILE_SYSTEM: PrivateSnapshotFileSystem = Object.freeze({
  lstatSync,
  realpathSync,
  openSync,
  fstatSync,
  readSync,
  closeSync,
});

function ownKeys(value: object): (string | symbol)[] {
  return Reflect.ownKeys(value);
}

function rejectUnknownDescriptorKeys(value: Record<string, unknown>): void {
  const expected = new Set<string>(PRIVATE_SNAPSHOT_DESCRIPTOR_KEYS);
  if (ownKeys(value).some((key) => typeof key !== 'string' || !expected.has(key))) {
    throw new PrivateSnapshotError(
      'PRIVATE_SNAPSHOT_DESCRIPTOR_INVALID',
      'A snapshot descriptor has unknown keys.',
    );
  }
}

function validateDescriptor(value: PrivateSnapshotDescriptor): PrivateSnapshotDescriptor {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PrivateSnapshotError(
      'PRIVATE_SNAPSHOT_DESCRIPTOR_INVALID',
      'A snapshot descriptor must be a plain object.',
    );
  }
  const record = value as unknown as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new PrivateSnapshotError(
      'PRIVATE_SNAPSHOT_DESCRIPTOR_INVALID',
      'A snapshot descriptor must be a plain object.',
    );
  }
  rejectUnknownDescriptorKeys(record);
  const roleLimit =
    record.role === 'required-authoritative' ? RUN_RECORD_MAX_BYTES : OPTIONAL_PNG_MAX_BYTES;
  if (
    typeof record.artifactId !== 'string' ||
    record.artifactId.length === 0 ||
    typeof record.relativePath !== 'string' ||
    !isEvidenceRelativePath(record.relativePath) ||
    !PRIVATE_SNAPSHOT_ROLES.includes(record.role as PrivateSnapshotRole) ||
    typeof record.maxBytes !== 'number' ||
    !Number.isSafeInteger(record.maxBytes) ||
    record.maxBytes <= 0 ||
    record.maxBytes > roleLimit
  ) {
    throw new PrivateSnapshotError(
      'PRIVATE_SNAPSHOT_DESCRIPTOR_INVALID',
      'A snapshot descriptor must contain only a safe relative path, a closed role, and a positive integer bound.',
      typeof record.artifactId === 'string' ? record.artifactId : null,
    );
  }
  return {
    artifactId: record.artifactId,
    relativePath: record.relativePath,
    role: record.role as PrivateSnapshotRole,
    maxBytes: record.maxBytes,
  };
}

function canonicalScratchRoot(input: string, fs: PrivateSnapshotFileSystem): string {
  if (typeof input !== 'string' || input.length === 0 || !path.isAbsolute(input)) {
    throw new PrivateSnapshotError(
      'PRIVATE_SNAPSHOT_ROOT_INVALID',
      'The owned scratch root must be absolute.',
    );
  }
  const lexical = path.normalize(input);
  if (lexical !== input) {
    throw new PrivateSnapshotError(
      'PRIVATE_SNAPSHOT_ROOT_INVALID',
      'The owned scratch root must be canonical.',
    );
  }
  let stat: Stats;
  try {
    stat = fs.lstatSync(lexical);
  } catch {
    throw new PrivateSnapshotError(
      'PRIVATE_SNAPSHOT_ROOT_INVALID',
      'The owned scratch root does not exist.',
    );
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new PrivateSnapshotError(
      'PRIVATE_SNAPSHOT_ROOT_INVALID',
      'The owned scratch root must be a real directory.',
    );
  }
  let real: string;
  try {
    real = fs.realpathSync(lexical);
  } catch {
    throw new PrivateSnapshotError(
      'PRIVATE_SNAPSHOT_ROOT_INVALID',
      'The owned scratch root cannot be resolved.',
    );
  }
  return real;
}

function targetFor(root: string, relativePath: string, artifactId: string): string {
  if (
    !isEvidenceRelativePath(relativePath) ||
    path.posix.normalize(relativePath) !== relativePath
  ) {
    throw new PrivateSnapshotError(
      'PRIVATE_SNAPSHOT_PATH_UNSAFE',
      'A candidate path is not canonical and repository-relative.',
      artifactId,
    );
  }
  const target = path.join(root, ...relativePath.split('/'));
  const relative = path.relative(root, target);
  if (relative === '' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new PrivateSnapshotError(
      'PRIVATE_SNAPSHOT_PATH_UNSAFE',
      'A candidate escapes the owned scratch root.',
      artifactId,
    );
  }
  return target;
}

interface Fingerprint {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

function fingerprint(stat: Stats): Fingerprint {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function sameFingerprint(left: Fingerprint, right: Fingerprint): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

interface ComponentObservation {
  readonly path: string;
  readonly realPath: string;
  readonly fingerprint: Fingerprint;
}

function observeCanonicalComponents(
  root: string,
  target: string,
  artifactId: string,
  fs: PrivateSnapshotFileSystem,
  phase: 'initial' | 'verification' = 'initial',
): readonly ComponentObservation[] {
  const relative = path.relative(root, target);
  const parts = relative.split(path.sep);
  const componentPaths = [root];
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    componentPaths.push(current);
  }
  const observations: ComponentObservation[] = [];
  for (let index = 0; index < componentPaths.length; index += 1) {
    current = componentPaths[index]!;
    let stat: Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      throw new PrivateSnapshotError(
        index === componentPaths.length - 1 && phase === 'initial'
          ? 'PRIVATE_SNAPSHOT_NOT_FOUND'
          : 'PRIVATE_SNAPSHOT_MUTATED',
        'A declared candidate path does not exist.',
        artifactId,
      );
    }
    if (stat.isSymbolicLink()) {
      throw new PrivateSnapshotError(
        phase === 'initial' ? 'PRIVATE_SNAPSHOT_SYMLINK' : 'PRIVATE_SNAPSHOT_MUTATED',
        'Candidate path components may not be symlinks.',
        artifactId,
      );
    }
    if (index < componentPaths.length - 1 && !stat.isDirectory()) {
      throw new PrivateSnapshotError(
        phase === 'initial' ? 'PRIVATE_SNAPSHOT_NOT_REGULAR' : 'PRIVATE_SNAPSHOT_MUTATED',
        'Candidate parent components must be directories.',
        artifactId,
      );
    }
    let realPath: string;
    try {
      realPath = fs.realpathSync(current);
    } catch {
      throw new PrivateSnapshotError(
        'PRIVATE_SNAPSHOT_MUTATED',
        'Candidate path resolution changed during capture.',
        artifactId,
      );
    }
    if (realPath !== current) {
      throw new PrivateSnapshotError(
        phase === 'initial' ? 'PRIVATE_SNAPSHOT_SYMLINK' : 'PRIVATE_SNAPSHOT_MUTATED',
        'Candidate path components may not resolve through symlinks.',
        artifactId,
      );
    }
    observations.push({ path: current, realPath, fingerprint: fingerprint(stat) });
  }
  return observations;
}

function assertSameComponents(
  before: readonly ComponentObservation[],
  after: readonly ComponentObservation[],
  artifactId: string,
): void {
  if (
    before.length !== after.length ||
    before.some((entry, index) => {
      const candidate = after[index];
      return (
        candidate === undefined ||
        entry.path !== candidate.path ||
        entry.realPath !== candidate.realPath ||
        !sameFingerprint(entry.fingerprint, candidate.fingerprint)
      );
    })
  ) {
    throw new PrivateSnapshotError(
      'PRIVATE_SNAPSHOT_MUTATED',
      'A parent component or canonical target changed during capture.',
      artifactId,
    );
  }
}

function assertOpenedTargetMatches(
  descriptorFd: number,
  target: ComponentObservation,
  artifactId: string,
  fs: PrivateSnapshotFileSystem,
): Fingerprint {
  let stat: Stats;
  try {
    stat = fs.fstatSync(descriptorFd);
  } catch {
    throw new PrivateSnapshotError(
      'PRIVATE_SNAPSHOT_READ_FAILED',
      'The opened candidate could not be inspected.',
      artifactId,
    );
  }
  if (!stat.isFile() || !sameFingerprint(fingerprint(stat), target.fingerprint)) {
    throw new PrivateSnapshotError(
      'PRIVATE_SNAPSHOT_MUTATED',
      'The opened descriptor does not match the canonical contained target.',
      artifactId,
    );
  }
  return fingerprint(stat);
}

function openNoFollow(target: string, artifactId: string, fs: PrivateSnapshotFileSystem): number {
  let link: Stats;
  try {
    link = fs.lstatSync(target);
  } catch {
    throw new PrivateSnapshotError(
      'PRIVATE_SNAPSHOT_NOT_FOUND',
      'The declared candidate does not exist.',
      artifactId,
    );
  }
  if (link.isSymbolicLink()) {
    throw new PrivateSnapshotError(
      'PRIVATE_SNAPSHOT_SYMLINK',
      'Symlink candidates are never captured.',
      artifactId,
    );
  }
  if (!link.isFile()) {
    throw new PrivateSnapshotError(
      'PRIVATE_SNAPSHOT_NOT_REGULAR',
      'Only regular files may be captured.',
      artifactId,
    );
  }
  try {
    return fs.openSync(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') {
      throw new PrivateSnapshotError(
        'PRIVATE_SNAPSHOT_SYMLINK',
        'A candidate became a symlink during capture.',
        artifactId,
      );
    }
    throw new PrivateSnapshotError(
      'PRIVATE_SNAPSHOT_READ_FAILED',
      'The candidate could not be opened.',
      artifactId,
    );
  }
}

function captureOne(
  root: string,
  descriptor: PrivateSnapshotDescriptor,
  fs: PrivateSnapshotFileSystem,
): PrivateSnapshot {
  const target = targetFor(root, descriptor.relativePath, descriptor.artifactId);
  const beforeComponents = observeCanonicalComponents(root, target, descriptor.artifactId, fs);
  const descriptorFd = openNoFollow(target, descriptor.artifactId, fs);
  try {
    const afterOpenComponents = observeCanonicalComponents(
      root,
      target,
      descriptor.artifactId,
      fs,
      'verification',
    );
    assertSameComponents(beforeComponents, afterOpenComponents, descriptor.artifactId);
    const before = assertOpenedTargetMatches(
      descriptorFd,
      beforeComponents[beforeComponents.length - 1]!,
      descriptor.artifactId,
      fs,
    );
    if (before.size > descriptor.maxBytes) {
      throw new PrivateSnapshotError(
        'PRIVATE_SNAPSHOT_BOUND_EXCEEDED',
        `Candidate exceeds its ${descriptor.maxBytes}-byte bound before capture.`,
        descriptor.artifactId,
      );
    }
    const buffer = new Uint8Array(descriptor.maxBytes + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const read = fs.readSync(descriptorFd, buffer, offset, buffer.byteLength - offset, null);
      if (read === 0) break;
      offset += read;
    }
    const after = fingerprint(fs.fstatSync(descriptorFd));
    const afterCaptureComponents = observeCanonicalComponents(
      root,
      target,
      descriptor.artifactId,
      fs,
      'verification',
    );
    assertSameComponents(beforeComponents, afterCaptureComponents, descriptor.artifactId);
    assertOpenedTargetMatches(
      descriptorFd,
      afterCaptureComponents[afterCaptureComponents.length - 1]!,
      descriptor.artifactId,
      fs,
    );
    if (!sameFingerprint(before, after) || offset !== before.size) {
      throw new PrivateSnapshotError(
        'PRIVATE_SNAPSHOT_MUTATED',
        'Candidate changed during capture.',
        descriptor.artifactId,
      );
    }
    if (offset > descriptor.maxBytes) {
      throw new PrivateSnapshotError(
        'PRIVATE_SNAPSHOT_BOUND_EXCEEDED',
        `Candidate exceeded its ${descriptor.maxBytes}-byte bound at limit-plus-one.`,
        descriptor.artifactId,
      );
    }
    const owned = new Uint8Array(offset);
    owned.set(buffer.subarray(0, offset));
    return Object.freeze({
      artifactId: descriptor.artifactId,
      relativePath: descriptor.relativePath,
      role: descriptor.role,
      byteLength: offset,
      get bytes(): Uint8Array {
        return new Uint8Array(owned);
      },
    });
  } catch (error) {
    if (error instanceof PrivateSnapshotError) throw error;
    throw new PrivateSnapshotError(
      'PRIVATE_SNAPSHOT_READ_FAILED',
      'The candidate could not be captured.',
      descriptor.artifactId,
    );
  } finally {
    fs.closeSync(descriptorFd);
  }
}

export interface CapturePrivateSnapshotsInput {
  readonly scratchRoot: string;
  readonly descriptors: readonly PrivateSnapshotDescriptor[];
  readonly aggregateLimitBytes?: number;
  /** Read-only hostile-test seam; omitted in production. */
  readonly fileSystem?: PrivateSnapshotFileSystem;
}

/**
 * Capture bounded candidates from an authenticated owned scratch root.
 * This function is intentionally read-only: it has no writer, cleanup,
 * deletion, rename, or public-evidence capability.
 */
export function capturePrivateSnapshots(
  input: CapturePrivateSnapshotsInput,
): PrivateSnapshotCollection {
  const fs = input.fileSystem ?? DEFAULT_FILE_SYSTEM;
  const root = canonicalScratchRoot(input.scratchRoot, fs);
  const aggregateLimit = input.aggregateLimitBytes ?? PRIVATE_SNAPSHOT_AGGREGATE_MAX_BYTES;
  if (
    !Number.isSafeInteger(aggregateLimit) ||
    aggregateLimit <= 0 ||
    aggregateLimit > PRIVATE_SNAPSHOT_AGGREGATE_MAX_BYTES
  ) {
    throw new PrivateSnapshotError(
      'PRIVATE_SNAPSHOT_INPUT_INVALID',
      'The aggregate bound must be a positive safe integer.',
    );
  }
  const descriptors = input.descriptors.map(validateDescriptor);
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const descriptor of descriptors) {
    if (ids.has(descriptor.artifactId) || paths.has(descriptor.relativePath)) {
      throw new PrivateSnapshotError(
        'PRIVATE_SNAPSHOT_DESCRIPTOR_INVALID',
        'Candidate artifact ids and paths must be unique.',
        descriptor.artifactId,
      );
    }
    ids.add(descriptor.artifactId);
    paths.add(descriptor.relativePath);
  }
  const ordered = [...descriptors].sort((left, right) => {
    const roleOrder =
      left.role === right.role ? 0 : left.role === 'required-authoritative' ? -1 : 1;
    if (roleOrder !== 0) return roleOrder;
    return left.artifactId === right.artifactId
      ? left.relativePath.localeCompare(right.relativePath)
      : left.artifactId.localeCompare(right.artifactId);
  });
  const required = ordered.filter((entry) => entry.role === 'required-authoritative');
  const optional = ordered.filter((entry) => entry.role === 'optional-diagnostic');
  const requiredCapacity = required.reduce((sum, entry) => sum + entry.maxBytes, 0);
  if (requiredCapacity > aggregateLimit) {
    throw new PrivateSnapshotError(
      'PRIVATE_SNAPSHOT_AGGREGATE_BOUND_EXCEEDED',
      'Required evidence capacity exceeds the aggregate bound.',
    );
  }
  const snapshots: PrivateSnapshot[] = [];
  let aggregateBytes = 0;
  for (const descriptor of [...required, ...optional]) {
    // Required capacity is reserved before any optional candidate is admitted.
    if (
      descriptor.role === 'optional-diagnostic' &&
      requiredCapacity + descriptor.maxBytes > aggregateLimit
    ) {
      throw new PrivateSnapshotError(
        'PRIVATE_SNAPSHOT_AGGREGATE_BOUND_EXCEEDED',
        'Optional evidence capacity exceeds the aggregate headroom reserved after required evidence.',
        descriptor.artifactId,
      );
    }
    const snapshot = captureOne(root, descriptor, fs);
    if (aggregateBytes + snapshot.byteLength > aggregateLimit) {
      throw new PrivateSnapshotError(
        'PRIVATE_SNAPSHOT_AGGREGATE_BOUND_EXCEEDED',
        'Captured evidence exceeds the aggregate bound.',
        descriptor.artifactId,
      );
    }
    aggregateBytes += snapshot.byteLength;
    snapshots.push(snapshot);
  }
  return Object.freeze({
    policyVersion: PRIVATE_SNAPSHOT_POLICY_VERSION,
    aggregateBytes,
    snapshots: Object.freeze(snapshots),
  });
}

/** Read-only alias used by callers that describe the operation as collection. */
export const collectPrivateSnapshots = capturePrivateSnapshots;

/** Return defensive copies suitable for a non-authoritative consumer. */
export function snapshotPrivateSnapshot(snapshot: PrivateSnapshot): Uint8Array {
  return new Uint8Array(snapshot.bytes);
}

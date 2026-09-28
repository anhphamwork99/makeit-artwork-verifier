import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';

import { canonicalize, sha256Hex } from '../canonical/canonicalize';
import {
  RETENTION_AUDIT_SCHEMA_VERSION,
  RETENTION_NAMESPACES,
  RETENTION_POLICY,
  RETENTION_SNAPSHOT_SCHEMA_VERSION,
  type RetentionArtifactV1,
  type RetentionAuditOptions,
  type RetentionAuditRecordV1,
  type RetentionFailureCode,
  type RetentionNamespace,
  type RetentionNamespaceWatermarkV1,
  type RetentionRawContentStatus,
  type RetentionReferenceAnomalyV1,
  type RetentionResult,
  type RetentionSnapshotV1,
} from '../contracts/budget-retention';

const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_MAX_DEPTH = 16;
const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_AUDIT_BYTES = 64 * 1024 * 1024;
const MAX_REFERENCE_SCAN_NODES = 50_000;
const DIGEST = /^[0-9a-f]{64}$/;
const AUDIT_ID = /^retention-[0-9a-f]{64}$/;

const NAMESPACE_PATHS: Readonly<Record<RetentionNamespace, string>> = {
  approvals: 'evidence/governance/approvals',
  'budget-measurements': 'evidence/governance/budget/measurements',
  'budget-policies': 'evidence/governance/budget/policies',
  'manifest-lifecycle': 'evidence/governance/manifest-lifecycle',
  proposals: 'evidence/governance/proposals',
  'qualification-authority': 'evidence/governance/qualification-authority',
  'release-runs': 'evidence/governance/release-runs',
  'retention-audit': 'evidence/governance/retention-audit',
  'run-evidence': 'evidence/runs',
  reviews: 'evidence/governance/reviews',
  'suite-evidence': 'evidence/suites',
};

const SCAN_NAMESPACES = [...RETENTION_NAMESPACES];
const encoder = new TextEncoder();

interface NativeStat {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly nlink: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

interface DirectoryStamp {
  readonly absolutePath: string;
  readonly stat: NativeStat;
  readonly namesAndKinds: readonly string[];
}

interface InternalArtifact {
  readonly artifact: RetentionArtifactV1;
  readonly declaredArtifactId: string | null;
  readonly references: readonly string[] | null;
}

interface NamespaceScan {
  readonly watermark: RetentionNamespaceWatermarkV1;
  readonly artifacts: readonly InternalArtifact[];
  readonly directories: readonly DirectoryStamp[];
}

class InventoryRefusal extends Error {
  constructor(readonly code: RetentionFailureCode) {
    super('Retention inventory refused.');
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isSafeRoot(root: string): boolean {
  try {
    return (
      path.isAbsolute(root) &&
      path.normalize(root) === root &&
      lstatSync(root).isDirectory() &&
      !lstatSync(root).isSymbolicLink() &&
      realpathSync(root) === root
    );
  } catch {
    return false;
  }
}

function statBig(absolutePath: string): NativeStat {
  return lstatSync(absolutePath, { bigint: true }) as NativeStat;
}

function sameStat(left: NativeStat, right: NativeStat): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.nlink === right.nlink &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function kindOf(stat: NativeStat): 'file' | 'directory' | 'other' | 'symlink' {
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isDirectory()) return 'directory';
  if (stat.isFile()) return 'file';
  return 'other';
}

function validSegment(segment: string): boolean {
  const hasControlCharacter = [...segment].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
  return (
    segment.length > 0 &&
    segment !== '.' &&
    segment !== '..' &&
    !segment.includes('/') &&
    !segment.includes('\\') &&
    !hasControlCharacter
  );
}

function safeRelative(relativePath: string): boolean {
  if (
    !relativePath ||
    path.posix.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    relativePath.includes('\\')
  )
    return false;
  return relativePath.split('/').every(validSegment);
}

function checkedLimits(options: RetentionAuditOptions): {
  maxFiles: number;
  maxDepth: number;
  maxFileBytes: number;
  maxTotalBytes: number;
} {
  const limits = {
    maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    maxTotalBytes: options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
  };
  if (
    !Number.isSafeInteger(limits.maxFiles) ||
    limits.maxFiles < 1 ||
    !Number.isSafeInteger(limits.maxDepth) ||
    limits.maxDepth < 1 ||
    !Number.isSafeInteger(limits.maxFileBytes) ||
    limits.maxFileBytes < 0 ||
    !Number.isSafeInteger(limits.maxTotalBytes) ||
    limits.maxTotalBytes < 0
  )
    throw new InventoryRefusal('INVENTORY_LIMIT_EXCEEDED');
  return limits;
}

function requireNoFollow(): void {
  const noFollow = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW;
  if (typeof noFollow !== 'number' || !Number.isInteger(noFollow) || noFollow === 0)
    throw new InventoryRefusal('NO_FOLLOW_UNAVAILABLE');
}

function resolveNamespaceRoot(root: string, relative: string): string | null {
  let current = root;
  for (const segment of relative.split('/')) {
    if (!validSegment(segment)) throw new InventoryRefusal('UNSAFE_LOGICAL_PATH');
    current = path.join(current, segment);
    let stat: NativeStat;
    try {
      stat = statBig(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new InventoryRefusal('UNSAFE_FILESYSTEM_OBJECT');
    }
    if (kindOf(stat) !== 'directory' || realpathSync(current) !== current)
      throw new InventoryRefusal('UNSAFE_FILESYSTEM_OBJECT');
  }
  return current;
}

function readStableFile(
  absolutePath: string,
  initial?: NativeStat,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
): { bytes: Buffer; stat: NativeStat } {
  let beforePath: NativeStat;
  try {
    beforePath = initial ?? statBig(absolutePath);
  } catch {
    throw new InventoryRefusal('UNSAFE_FILESYSTEM_OBJECT');
  }
  if (
    kindOf(beforePath) !== 'file' ||
    beforePath.nlink !== 1n ||
    beforePath.size < 0n ||
    beforePath.size > BigInt(maxFileBytes) ||
    beforePath.size > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw new InventoryRefusal('UNSAFE_FILESYSTEM_OBJECT');

  let fd: number;
  try {
    fd = openSync(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw new InventoryRefusal('UNSAFE_FILESYSTEM_OBJECT');
  }
  try {
    const beforeFd = fstatSync(fd, { bigint: true }) as NativeStat;
    if (kindOf(beforeFd) !== 'file' || beforeFd.nlink !== 1n || !sameStat(beforePath, beforeFd))
      throw new InventoryRefusal('SNAPSHOT_CHANGED');

    const size = Number(beforeFd.size);
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(fd, bytes, offset, size - offset, offset);
      if (count <= 0) throw new InventoryRefusal('SNAPSHOT_CHANGED');
      offset += count;
    }

    const afterFd = fstatSync(fd, { bigint: true }) as NativeStat;
    let afterPath: NativeStat;
    try {
      afterPath = statBig(absolutePath);
    } catch {
      throw new InventoryRefusal('SNAPSHOT_CHANGED');
    }
    if (!sameStat(beforeFd, afterFd) || !sameStat(afterFd, afterPath))
      throw new InventoryRefusal('SNAPSHOT_CHANGED');
    return { bytes, stat: afterFd };
  } finally {
    closeSync(fd);
  }
}

function direntKeys(absolutePath: string): string[] {
  let dirents: import('node:fs').Dirent<string>[];
  try {
    dirents = readdirSync(absolutePath, { withFileTypes: true });
  } catch {
    throw new InventoryRefusal('UNSAFE_FILESYSTEM_OBJECT');
  }
  return dirents
    .map((entry) => {
      if (!validSegment(entry.name)) throw new InventoryRefusal('UNSAFE_LOGICAL_PATH');
      return `${entry.name}\0${entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other'}`;
    })
    .sort();
}

function recordDirectory(directory: string, directories: DirectoryStamp[]): NativeStat {
  let stat: NativeStat;
  try {
    stat = statBig(directory);
  } catch {
    throw new InventoryRefusal('SNAPSHOT_CHANGED');
  }
  if (kindOf(stat) !== 'directory' || realpathSync(directory) !== directory)
    throw new InventoryRefusal('UNSAFE_FILESYSTEM_OBJECT');
  const stamp: DirectoryStamp = {
    absolutePath: directory,
    stat,
    namesAndKinds: direntKeys(directory),
  };
  directories.push(stamp);
  return stat;
}

function parseRawJson(bytes: Uint8Array): {
  status: RetentionRawContentStatus;
  value: unknown | null;
} {
  const text = Buffer.from(bytes).toString('utf8');
  try {
    return { status: 'JSON_UNVERIFIED', value: JSON.parse(text) as unknown };
  } catch {
    const first = text.trimStart()[0];
    return {
      status: first === '{' || first === '[' ? 'JSON_PARSE_FAILED' : 'NON_JSON',
      value: null,
    };
  }
}

function collectRawReferenceHints(value: unknown): {
  artifactIds: string[];
  references: string[] | null;
} {
  const artifactIds: string[] = [];
  const references: string[] = [];
  let hasReferenceList = false;
  let visited = 0;
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  while (stack.length > 0) {
    const next = stack.pop();
    if (!next) continue;
    visited += 1;
    if (visited > MAX_REFERENCE_SCAN_NODES || next.depth > 48) {
      return { artifactIds, references: null };
    }
    if (Array.isArray(next.value)) {
      for (const item of next.value) stack.push({ value: item, depth: next.depth + 1 });
      continue;
    }
    if (typeof next.value !== 'object' || next.value === null) continue;
    const record = next.value as Record<string, unknown>;
    if (typeof record.artifactId === 'string' && record.artifactId.length > 0) {
      artifactIds.push(record.artifactId);
    }
    if (Array.isArray(record.references)) {
      hasReferenceList = true;
      for (const item of record.references) {
        if (typeof item === 'string' && item.length > 0) references.push(item);
      }
    }
    for (const [key, child] of Object.entries(record)) {
      if (key !== 'references') stack.push({ value: child, depth: next.depth + 1 });
    }
  }
  return { artifactIds, references: hasReferenceList ? references : null };
}

function scanNamespace(
  root: string,
  namespace: RetentionNamespace,
  limits: ReturnType<typeof checkedLimits>,
  currentFileCount: { value: number },
  currentByteCount: { value: number },
): NamespaceScan {
  const namespaceRoot = resolveNamespaceRoot(root, NAMESPACE_PATHS[namespace]);
  if (namespaceRoot === null) {
    return {
      watermark: {
        namespace,
        presence: 'ABSENT',
        rootIdentity: null,
        fileCount: 0,
        byteCount: 0,
        inventoryDigest: sha256Hex(canonicalize([])),
      },
      artifacts: [],
      directories: [],
    };
  }

  const directories: DirectoryStamp[] = [];
  const artifacts: InternalArtifact[] = [];
  let namespaceBytes = 0;
  function walk(directory: string, relativeDirectory: string, depth: number): void {
    if (depth > limits.maxDepth) throw new InventoryRefusal('INVENTORY_LIMIT_EXCEEDED');
    const before = recordDirectory(directory, directories);
    const beforeNames = directories[directories.length - 1]?.namesAndKinds ?? [];
    for (const nameAndKind of beforeNames) {
      const separator = nameAndKind.lastIndexOf('\0');
      const name = nameAndKind.slice(0, separator);
      const absolute = path.join(directory, name);
      const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      if (!safeRelative(relative)) throw new InventoryRefusal('UNSAFE_LOGICAL_PATH');
      let childStat: NativeStat;
      try {
        childStat = statBig(absolute);
      } catch {
        throw new InventoryRefusal('SNAPSHOT_CHANGED');
      }
      const kind = kindOf(childStat);
      if (kind === 'symlink' || kind === 'other')
        throw new InventoryRefusal('UNSAFE_FILESYSTEM_OBJECT');
      if (kind === 'directory') {
        walk(absolute, relative, depth + 1);
        continue;
      }

      currentFileCount.value += 1;
      if (currentFileCount.value > limits.maxFiles)
        throw new InventoryRefusal('INVENTORY_LIMIT_EXCEEDED');
      const read = readStableFile(absolute, childStat, limits.maxFileBytes);
      const byteCount = read.bytes.byteLength;
      currentByteCount.value += byteCount;
      namespaceBytes += byteCount;
      if (currentByteCount.value > limits.maxTotalBytes)
        throw new InventoryRefusal('INVENTORY_LIMIT_EXCEEDED');
      const raw = parseRawJson(read.bytes);
      const hints =
        raw.value === null
          ? { artifactIds: [], references: null }
          : collectRawReferenceHints(raw.value);
      const objectId = sha256Hex(`${namespace}\0${relative}`);
      const provisional: RetentionArtifactV1 = {
        objectId,
        namespace,
        relativePath: relative,
        byteCount,
        sha256: sha256(read.bytes),
        rawContentStatus: raw.status,
        referenceStatus:
          hints.references === null ? 'REFERENCE_STATUS_UNASSESSED' : 'NO_DECLARED_REFERENCES',
        referenceAnomalies: [],
        disposition: RETENTION_POLICY,
      };
      artifacts.push({
        artifact: provisional,
        declaredArtifactId: hints.artifactIds[0] ?? null,
        references: hints.references,
      });
    }

    const afterNames = direntKeys(directory);
    let after: NativeStat;
    try {
      after = statBig(directory);
    } catch {
      throw new InventoryRefusal('SNAPSHOT_CHANGED');
    }
    if (!sameStat(before, after) || canonicalize(beforeNames) !== canonicalize(afterNames))
      throw new InventoryRefusal('SNAPSHOT_CHANGED');
  }

  walk(namespaceRoot, '', 0);
  const rootStat = statBig(namespaceRoot);
  const fileArtifacts = artifacts
    .map(({ artifact }) => artifact)
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const namespaceInventoryDigest = sha256Hex(
    canonicalize(
      fileArtifacts.map((artifact) => ({
        relativePath: artifact.relativePath,
        byteCount: artifact.byteCount,
        sha256: artifact.sha256,
      })),
    ),
  );
  return {
    watermark: {
      namespace,
      presence: 'PRESENT',
      rootIdentity: sha256Hex(`${namespace}\0${rootStat.dev}:${rootStat.ino}`),
      fileCount: artifacts.length,
      byteCount: namespaceBytes,
      inventoryDigest: namespaceInventoryDigest,
    },
    artifacts,
    directories,
  };
}

function finalizeReferences(scans: readonly NamespaceScan[]): RetentionArtifactV1[] {
  const all = scans.flatMap((scan) => scan.artifacts);
  const targetIds = new Map<string, string[]>();
  for (const item of all) {
    if (item.declaredArtifactId === null) continue;
    const target = targetIds.get(item.declaredArtifactId) ?? [];
    target.push(item.artifact.objectId);
    targetIds.set(item.declaredArtifactId, target);
  }
  const referenceCounts = new Map<string, number>();
  for (const item of all) {
    for (const reference of item.references ?? []) {
      const targets = targetIds.get(reference);
      if (targets) {
        for (const target of targets)
          referenceCounts.set(target, (referenceCounts.get(target) ?? 0) + 1);
      }
    }
  }

  return all.map(({ artifact, declaredArtifactId, references }) => {
    if (references === null) {
      if (declaredArtifactId !== null && (referenceCounts.get(artifact.objectId) ?? 0) === 0) {
        return {
          ...artifact,
          referenceStatus: 'UNREFERENCED_OBJECT',
          referenceAnomalies: [
            {
              code: 'UNREFERENCED_OBJECT',
              objectId: artifact.objectId,
              referenceDigest: sha256Hex(declaredArtifactId),
            },
          ],
        };
      }
      return { ...artifact, referenceStatus: 'REFERENCE_STATUS_UNASSESSED' };
    }
    const dangling = references.filter((reference) => !targetIds.has(reference));
    const anomalies: RetentionReferenceAnomalyV1[] = dangling.map((reference) => ({
      code: 'DANGLING_REFERENCE',
      objectId: artifact.objectId,
      referenceDigest: sha256Hex(reference),
    }));
    const unreferenced =
      declaredArtifactId !== null && (referenceCounts.get(artifact.objectId) ?? 0) === 0;
    if (unreferenced) {
      anomalies.push({
        code: 'UNREFERENCED_OBJECT',
        objectId: artifact.objectId,
        referenceDigest: sha256Hex(declaredArtifactId),
      });
    }
    return {
      ...artifact,
      referenceStatus:
        dangling.length > 0
          ? 'DANGLING_REFERENCES'
          : unreferenced
            ? 'UNREFERENCED_OBJECT'
            : references.length === 0
              ? 'NO_DECLARED_REFERENCES'
              : 'REFERENCES_RESOLVED',
      referenceAnomalies: anomalies,
    };
  });
}

function validateCapturedDirectories(scans: readonly NamespaceScan[]): void {
  for (const scan of scans) {
    for (const directory of scan.directories) {
      let current: NativeStat;
      try {
        current = statBig(directory.absolutePath);
      } catch {
        throw new InventoryRefusal('SNAPSHOT_CHANGED');
      }
      if (
        kindOf(current) !== 'directory' ||
        !sameStat(directory.stat, current) ||
        canonicalize(directory.namesAndKinds) !== canonicalize(direntKeys(directory.absolutePath))
      )
        throw new InventoryRefusal('SNAPSHOT_CHANGED');
    }
  }
}

function resolveCapturedFile(root: string, artifact: RetentionArtifactV1): string {
  if (!safeRelative(artifact.relativePath)) throw new InventoryRefusal('UNSAFE_LOGICAL_PATH');
  const namespaceRoot = resolveNamespaceRoot(root, NAMESPACE_PATHS[artifact.namespace]);
  if (namespaceRoot === null) throw new InventoryRefusal('SNAPSHOT_CHANGED');
  const segments = artifact.relativePath.split('/');
  let parent = namespaceRoot;
  for (const segment of segments.slice(0, -1)) {
    if (!validSegment(segment)) throw new InventoryRefusal('UNSAFE_LOGICAL_PATH');
    parent = path.join(parent, segment);
    let stat: NativeStat;
    try {
      stat = statBig(parent);
    } catch {
      throw new InventoryRefusal('SNAPSHOT_CHANGED');
    }
    if (kindOf(stat) !== 'directory' || realpathSync(parent) !== parent)
      throw new InventoryRefusal('UNSAFE_FILESYSTEM_OBJECT');
  }
  const leaf = segments.at(-1);
  if (!leaf) throw new InventoryRefusal('UNSAFE_LOGICAL_PATH');
  return path.join(parent, leaf);
}

function validateNamespacePresence(
  root: string,
  watermarks: readonly RetentionNamespaceWatermarkV1[],
  permitLaterCreation: boolean,
): void {
  for (const watermark of watermarks) {
    const namespaceRoot = resolveNamespaceRoot(root, NAMESPACE_PATHS[watermark.namespace]);
    if (watermark.presence === 'PRESENT' && namespaceRoot === null)
      throw new InventoryRefusal('SNAPSHOT_CHANGED');
    if (watermark.presence === 'ABSENT' && namespaceRoot !== null && !permitLaterCreation)
      throw new InventoryRefusal('SNAPSHOT_CHANGED');
  }
}

function validateCapturedFiles(
  root: string,
  artifacts: readonly RetentionArtifactV1[],
  maxFileBytes: number,
): void {
  for (const artifact of artifacts) {
    const absolute = resolveCapturedFile(root, artifact);
    const read = readStableFile(absolute, undefined, maxFileBytes);
    if (read.bytes.byteLength !== artifact.byteCount || sha256(read.bytes) !== artifact.sha256)
      throw new InventoryRefusal('SNAPSHOT_CHANGED');
  }
}

function makeSnapshot(root: string, options: RetentionAuditOptions = {}): RetentionSnapshotV1 {
  requireNoFollow();
  if (!isSafeRoot(root)) throw new InventoryRefusal('ROOT_INVALID');
  const limits = checkedLimits(options);
  const fileCount = { value: 0 };
  const byteCount = { value: 0 };
  const scans: NamespaceScan[] = [];
  for (const namespace of SCAN_NAMESPACES) {
    scans.push(scanNamespace(root, namespace, limits, fileCount, byteCount));
  }
  validateCapturedDirectories(scans);
  const watermarks = scans.map((scan) => scan.watermark);
  validateNamespacePresence(root, watermarks, false);
  const artifacts = finalizeReferences(scans).sort((a, b) =>
    a.namespace === b.namespace
      ? a.relativePath.localeCompare(b.relativePath)
      : a.namespace.localeCompare(b.namespace),
  );
  validateCapturedFiles(root, artifacts, limits.maxFileBytes);
  validateCapturedDirectories(scans);
  validateNamespacePresence(root, watermarks, false);

  const capturedAt = options.capturedAt ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(capturedAt)) || new Date(capturedAt).toISOString() !== capturedAt)
    throw new InventoryRefusal('AUDIT_INVALID');
  const namespaceWatermarks = watermarks;
  const body = {
    schemaVersion: RETENTION_SNAPSHOT_SCHEMA_VERSION,
    policy: RETENTION_POLICY,
    capturedAt,
    namespaceWatermarks,
    artifacts,
    totalFileCount: artifacts.length,
    totalByteCount: byteCount.value,
  };
  const snapshotId = sha256Hex(canonicalize(body));
  const unsigned = { ...body, snapshotId };
  return { ...unsigned, digest: sha256Hex(canonicalize(unsigned)) };
}

/** Build a complete raw-byte snapshot without creating or modifying any path. */
export function buildRetentionSnapshot(
  skillRoot: string,
  options: RetentionAuditOptions = {},
): RetentionResult<RetentionSnapshotV1> {
  try {
    return { ok: true, value: makeSnapshot(skillRoot, options) };
  } catch (error) {
    return {
      ok: false,
      code: error instanceof InventoryRefusal ? error.code : 'UNSAFE_FILESYSTEM_OBJECT',
    };
  }
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const own = Reflect.ownKeys(value);
  return (
    own.length === keys.length && own.every((key) => typeof key === 'string' && keys.includes(key))
  );
}

function validArtifact(value: unknown): value is RetentionArtifactV1 {
  if (
    !exactKeys(value, [
      'objectId',
      'namespace',
      'relativePath',
      'byteCount',
      'sha256',
      'rawContentStatus',
      'referenceStatus',
      'referenceAnomalies',
      'disposition',
    ])
  )
    return false;
  return (
    typeof value.objectId === 'string' &&
    DIGEST.test(value.objectId) &&
    RETENTION_NAMESPACES.includes(value.namespace as RetentionNamespace) &&
    typeof value.relativePath === 'string' &&
    safeRelative(value.relativePath) &&
    Number.isSafeInteger(value.byteCount) &&
    (value.byteCount as number) >= 0 &&
    typeof value.sha256 === 'string' &&
    DIGEST.test(value.sha256) &&
    (value.rawContentStatus === 'JSON_PARSE_FAILED' ||
      value.rawContentStatus === 'JSON_UNVERIFIED' ||
      value.rawContentStatus === 'NON_JSON') &&
    (value.referenceStatus === 'DANGLING_REFERENCES' ||
      value.referenceStatus === 'NO_DECLARED_REFERENCES' ||
      value.referenceStatus === 'REFERENCES_RESOLVED' ||
      value.referenceStatus === 'REFERENCE_STATUS_UNASSESSED' ||
      value.referenceStatus === 'UNREFERENCED_OBJECT') &&
    Array.isArray(value.referenceAnomalies) &&
    value.referenceAnomalies.every(
      (anomaly) =>
        exactKeys(anomaly, ['code', 'objectId', 'referenceDigest']) &&
        (anomaly.code === 'DANGLING_REFERENCE' || anomaly.code === 'UNREFERENCED_OBJECT') &&
        typeof anomaly.objectId === 'string' &&
        DIGEST.test(anomaly.objectId) &&
        (anomaly.referenceDigest === null ||
          (typeof anomaly.referenceDigest === 'string' && DIGEST.test(anomaly.referenceDigest))),
    ) &&
    value.disposition === RETENTION_POLICY
  );
}

function validWatermark(value: unknown): value is RetentionNamespaceWatermarkV1 {
  return (
    exactKeys(value, [
      'namespace',
      'presence',
      'rootIdentity',
      'fileCount',
      'byteCount',
      'inventoryDigest',
    ]) &&
    RETENTION_NAMESPACES.includes(value.namespace as RetentionNamespace) &&
    (value.presence === 'ABSENT' || value.presence === 'PRESENT') &&
    (value.rootIdentity === null ||
      (typeof value.rootIdentity === 'string' && DIGEST.test(value.rootIdentity))) &&
    (value.presence === 'ABSENT') === (value.rootIdentity === null) &&
    Number.isSafeInteger(value.fileCount) &&
    (value.fileCount as number) >= 0 &&
    Number.isSafeInteger(value.byteCount) &&
    (value.byteCount as number) >= 0 &&
    typeof value.inventoryDigest === 'string' &&
    DIGEST.test(value.inventoryDigest)
  );
}

function validSnapshot(value: unknown): value is RetentionSnapshotV1 {
  if (
    !exactKeys(value, [
      'schemaVersion',
      'policy',
      'snapshotId',
      'capturedAt',
      'namespaceWatermarks',
      'artifacts',
      'totalFileCount',
      'totalByteCount',
      'digest',
    ])
  )
    return false;
  if (
    value.schemaVersion !== RETENTION_SNAPSHOT_SCHEMA_VERSION ||
    value.policy !== RETENTION_POLICY ||
    typeof value.snapshotId !== 'string' ||
    !DIGEST.test(value.snapshotId) ||
    typeof value.capturedAt !== 'string' ||
    Number.isNaN(Date.parse(value.capturedAt)) ||
    !Array.isArray(value.namespaceWatermarks) ||
    value.namespaceWatermarks.length !== RETENTION_NAMESPACES.length ||
    !value.namespaceWatermarks.every(validWatermark) ||
    new Set(value.namespaceWatermarks.map((item) => item.namespace)).size !==
      RETENTION_NAMESPACES.length ||
    !Array.isArray(value.artifacts) ||
    !value.artifacts.every(validArtifact) ||
    Number.isSafeInteger(value.totalFileCount) !== true ||
    value.totalFileCount !== value.artifacts.length ||
    Number.isSafeInteger(value.totalByteCount) !== true ||
    (value.totalByteCount as number) < 0 ||
    typeof value.digest !== 'string' ||
    !DIGEST.test(value.digest)
  )
    return false;
  const artifactIds = value.artifacts.map((item) => item.objectId);
  if (new Set(artifactIds).size !== artifactIds.length) return false;
  const countedBytes = value.artifacts.reduce((sum, item) => sum + item.byteCount, 0);
  if (!Number.isSafeInteger(countedBytes) || countedBytes !== value.totalByteCount) return false;
  for (const watermark of value.namespaceWatermarks) {
    const namespaceArtifacts = value.artifacts.filter(
      (item) => item.namespace === watermark.namespace,
    );
    const namespaceBytes = namespaceArtifacts.reduce((sum, item) => sum + item.byteCount, 0);
    const inventoryDigest = sha256Hex(
      canonicalize(
        namespaceArtifacts
          .map((item) => ({
            relativePath: item.relativePath,
            byteCount: item.byteCount,
            sha256: item.sha256,
          }))
          .sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
      ),
    );
    if (
      namespaceArtifacts.length !== watermark.fileCount ||
      namespaceBytes !== watermark.byteCount ||
      inventoryDigest !== watermark.inventoryDigest ||
      (watermark.presence === 'ABSENT' && namespaceArtifacts.length !== 0)
    )
      return false;
  }
  for (const artifact of value.artifacts) {
    if (artifact.objectId !== sha256Hex(`${artifact.namespace}\0${artifact.relativePath}`))
      return false;
  }
  const unsigned = {
    schemaVersion: value.schemaVersion,
    policy: value.policy,
    capturedAt: value.capturedAt,
    namespaceWatermarks: value.namespaceWatermarks,
    artifacts: value.artifacts,
    totalFileCount: value.totalFileCount,
    totalByteCount: value.totalByteCount,
  };
  const expectedId = sha256Hex(canonicalize(unsigned));
  const expectedDigest = sha256Hex(canonicalize({ ...unsigned, snapshotId: value.snapshotId }));
  return value.snapshotId === expectedId && value.digest === expectedDigest;
}

function validAudit(value: unknown): value is RetentionAuditRecordV1 {
  if (!exactKeys(value, ['schemaVersion', 'auditId', 'snapshot', 'digest'])) return false;
  if (
    value.schemaVersion !== RETENTION_AUDIT_SCHEMA_VERSION ||
    typeof value.auditId !== 'string' ||
    !AUDIT_ID.test(value.auditId) ||
    !validSnapshot(value.snapshot)
  )
    return false;
  const unsigned = {
    schemaVersion: value.schemaVersion,
    auditId: value.auditId,
    snapshot: value.snapshot,
  };
  return (
    value.auditId === `retention-${value.snapshot.snapshotId}` &&
    value.digest === sha256Hex(canonicalize(unsigned))
  );
}

function readAuditRecord(root: string, auditId: string): RetentionAuditRecordV1 {
  requireNoFollow();
  if (!AUDIT_ID.test(auditId) || !isSafeRoot(root)) throw new InventoryRefusal('AUDIT_INVALID');
  const namespaceRoot = resolveNamespaceRoot(root, NAMESPACE_PATHS['retention-audit']);
  if (namespaceRoot === null) throw new InventoryRefusal('AUDIT_NOT_FOUND');
  const file = path.join(namespaceRoot, `${auditId}.json`);
  let read: { bytes: Buffer; stat: NativeStat };
  try {
    read = readStableFile(file, undefined, MAX_AUDIT_BYTES);
  } catch {
    throw new InventoryRefusal('AUDIT_NOT_FOUND');
  }
  let value: unknown;
  try {
    value = JSON.parse(read.bytes.toString('utf8')) as unknown;
  } catch {
    throw new InventoryRefusal('AUDIT_INVALID');
  }
  if (!validAudit(value) || `${canonicalize(value)}\n` !== read.bytes.toString('utf8'))
    throw new InventoryRefusal('AUDIT_INVALID');
  return value;
}

function validateCapturedSnapshot(root: string, snapshot: RetentionSnapshotV1): void {
  for (const watermark of snapshot.namespaceWatermarks) {
    const namespaceRoot = resolveNamespaceRoot(root, NAMESPACE_PATHS[watermark.namespace]);
    if (watermark.presence === 'PRESENT') {
      if (namespaceRoot === null) throw new InventoryRefusal('SNAPSHOT_CHANGED');
      let rootStat: NativeStat;
      try {
        rootStat = statBig(namespaceRoot);
      } catch {
        throw new InventoryRefusal('SNAPSHOT_CHANGED');
      }
      const currentIdentity = sha256Hex(`${watermark.namespace}\0${rootStat.dev}:${rootStat.ino}`);
      if (currentIdentity !== watermark.rootIdentity)
        throw new InventoryRefusal('SNAPSHOT_CHANGED');
    }
    // A namespace absent at the cutoff may be created by a later legitimate append.
  }

  const internal: InternalArtifact[] = [];
  for (const artifact of snapshot.artifacts) {
    const absolute = resolveCapturedFile(root, artifact);
    const read = readStableFile(absolute, undefined, DEFAULT_MAX_FILE_BYTES);
    if (read.bytes.byteLength !== artifact.byteCount || sha256(read.bytes) !== artifact.sha256)
      throw new InventoryRefusal('SNAPSHOT_CHANGED');
    const raw = parseRawJson(read.bytes);
    const hints =
      raw.value === null
        ? { artifactIds: [], references: null }
        : collectRawReferenceHints(raw.value);
    internal.push({
      artifact: {
        ...artifact,
        rawContentStatus: raw.status,
        referenceStatus:
          hints.references === null ? 'REFERENCE_STATUS_UNASSESSED' : 'NO_DECLARED_REFERENCES',
        referenceAnomalies: [],
      },
      declaredArtifactId: hints.artifactIds[0] ?? null,
      references: hints.references,
    });
  }
  const firstWatermark = snapshot.namespaceWatermarks[0];
  if (!firstWatermark) throw new InventoryRefusal('AUDIT_INVALID');
  const recomputedArtifacts = finalizeReferences([
    {
      watermark: firstWatermark,
      artifacts: internal,
      directories: [],
    },
  ]).sort((left, right) =>
    left.namespace === right.namespace
      ? left.relativePath.localeCompare(right.relativePath)
      : left.namespace.localeCompare(right.namespace),
  );
  if (canonicalize(recomputedArtifacts) !== canonicalize(snapshot.artifacts))
    throw new InventoryRefusal('AUDIT_INVALID');
}

function ensureAuditNamespace(root: string): string {
  const governanceRoot = resolveNamespaceRoot(root, 'evidence/governance');
  if (governanceRoot === null) throw new InventoryRefusal('AUDIT_WRITE_REFUSED');
  const auditRoot = path.join(governanceRoot, 'retention-audit');
  try {
    mkdirSync(auditRoot, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
      throw new InventoryRefusal('AUDIT_WRITE_REFUSED');
  }
  let stat: NativeStat;
  try {
    stat = statBig(auditRoot);
  } catch {
    throw new InventoryRefusal('AUDIT_WRITE_REFUSED');
  }
  if (kindOf(stat) !== 'directory' || realpathSync(auditRoot) !== auditRoot)
    throw new InventoryRefusal('AUDIT_WRITE_REFUSED');
  return auditRoot;
}

function appendRecord(root: string, snapshot: RetentionSnapshotV1): RetentionAuditRecordV1 {
  const auditId = `retention-${snapshot.snapshotId}`;
  const unsigned = { schemaVersion: RETENTION_AUDIT_SCHEMA_VERSION, auditId, snapshot };
  const record: RetentionAuditRecordV1 = { ...unsigned, digest: sha256Hex(canonicalize(unsigned)) };
  const bytes = encoder.encode(`${canonicalize(record)}\n`);
  if (bytes.byteLength > MAX_AUDIT_BYTES) throw new InventoryRefusal('INVENTORY_LIMIT_EXCEEDED');
  const directory = ensureAuditNamespace(root);
  const file = path.join(directory, `${auditId}.json`);
  let fd: number;
  try {
    fd = openSync(
      file,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    throw new InventoryRefusal('AUDIT_WRITE_REFUSED');
  }
  try {
    const stat = fstatSync(fd, { bigint: true }) as NativeStat;
    if (!stat.isFile() || stat.nlink !== 1n) throw new InventoryRefusal('AUDIT_WRITE_REFUSED');
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = writeSync(fd, bytes, offset, bytes.byteLength - offset, offset);
      if (count <= 0) throw new InventoryRefusal('AUDIT_WRITE_REFUSED');
      offset += count;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const persisted = readAuditRecord(root, auditId);
  validateCapturedSnapshot(root, persisted.snapshot);
  return persisted;
}

/** Read and hash governed namespaces, then append one digest-addressed PRESERVE_ALL record. */
export function appendRetentionAudit(
  skillRoot: string,
  options: RetentionAuditOptions = {},
): RetentionResult<RetentionAuditRecordV1> {
  try {
    const snapshot = makeSnapshot(skillRoot, options);
    return { ok: true, value: appendRecord(skillRoot, snapshot) };
  } catch (error) {
    return {
      ok: false,
      code: error instanceof InventoryRefusal ? error.code : 'AUDIT_WRITE_REFUSED',
    };
  }
}

/** Verify a saved raw snapshot without creating directories or requiring namespace-set equality. */
export function readAndVerifyRetentionAudit(
  skillRoot: string,
  auditId: string,
): RetentionResult<RetentionAuditRecordV1> {
  try {
    const record = readAuditRecord(skillRoot, auditId);
    validateCapturedSnapshot(skillRoot, record.snapshot);
    return { ok: true, value: record };
  } catch (error) {
    return {
      ok: false,
      code: error instanceof InventoryRefusal ? error.code : 'AUDIT_INVALID',
    };
  }
}

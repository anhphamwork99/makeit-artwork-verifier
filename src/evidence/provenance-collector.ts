import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
} from 'node:fs';
import path from 'node:path';

import type {
  EvidenceProvenance,
  EvidenceProvenanceDirtyPolicy,
  EvidenceProvenanceIdentity,
} from '../contracts/evidence-transaction';
import {
  buildEvidenceProvenance,
  buildGovernedTreeDigest,
  classifyGovernedProvenancePath,
  isGovernedRepositoryRelativePath,
  type GovernedPathEntry,
  EvidenceProvenancePolicyError,
  selectGovernedProvenanceEntries,
} from './provenance';
import { resolveRepoRoot } from '../runtime/paths';

export interface RepositoryProvenanceInputs {
  readonly repositoryRevision: string;
  readonly dirtyPolicy: EvidenceProvenanceDirtyPolicy;
  readonly governedEntries: readonly GovernedPathEntry[];
  readonly lockfileDigest: string;
}

export interface CollectRepositoryProvenanceOptions {
  readonly repoRoot?: string;
  /** Test seam; production remains the read-only git executable. */
  readonly runGit?: (args: readonly string[], cwd: string) => Uint8Array | string;
}

export const PROVENANCE_COLLECTOR_FAILURE_CODES = [
  'PROVENANCE_COLLECTOR_REPOSITORY_INVALID',
  'PROVENANCE_COLLECTOR_GIT_INVALID',
  'PROVENANCE_COLLECTOR_PATH_INVALID',
  'PROVENANCE_COLLECTOR_PATH_DUPLICATE',
  'PROVENANCE_COLLECTOR_FILE_INVALID',
  'PROVENANCE_COLLECTOR_HASH_FAILED',
] as const;
export type ProvenanceCollectorFailureCode = (typeof PROVENANCE_COLLECTOR_FAILURE_CODES)[number];

export class ProvenanceCollectorError extends Error {
  readonly code: ProvenanceCollectorFailureCode;
  constructor(code: ProvenanceCollectorFailureCode, message: string) {
    super(message);
    this.name = 'ProvenanceCollectorError';
    this.code = code;
  }
}

function isStandaloneGitRoot(repoRoot: string): boolean {
  try {
    const topLevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return path.resolve(topLevel) === repoRoot;
  } catch {
    return false;
  }
}

function defaultRunGit(args: readonly string[], cwd: string): Uint8Array {
  try {
    return execFileSync('git', [...args], {
      cwd,
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new ProvenanceCollectorError(
      'PROVENANCE_COLLECTOR_GIT_INVALID',
      `Read-only git provenance query failed: ${(error as Error).message}`,
    );
  }
}

function text(value: Uint8Array | string): string {
  if (typeof value === 'string') return value;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    throw new ProvenanceCollectorError(
      'PROVENANCE_COLLECTOR_GIT_INVALID',
      'Git output was not valid UTF-8.',
    );
  }
}

function repositoryRelativeGitPaths(value: Uint8Array | string): readonly string[] {
  const raw = text(value);
  // An empty listing is valid; every non-empty listing must have exactly one
  // NUL terminator per identity. Preserve each field byte-for-byte after UTF-8
  // decoding: Git path identity is not a Windows path and must never be
  // rewritten by replacing backslashes or otherwise normalizing aliases.
  if (raw.length === 0) return [];
  if (!raw.endsWith('\0')) {
    throw new ProvenanceCollectorError(
      'PROVENANCE_COLLECTOR_GIT_INVALID',
      'Git path output was not NUL-delimited.',
    );
  }
  const fields = raw.split('\0');
  const entries = fields.slice(0, -1);
  if (entries.some((entry) => entry.length === 0)) {
    throw new ProvenanceCollectorError(
      'PROVENANCE_COLLECTOR_GIT_INVALID',
      'Git path output contained an empty NUL-delimited identity.',
    );
  }
  return entries;
}

function safeRepositoryRoot(repoRoot: string): string {
  if (!path.isAbsolute(repoRoot) || path.normalize(repoRoot) !== repoRoot) {
    throw new ProvenanceCollectorError(
      'PROVENANCE_COLLECTOR_REPOSITORY_INVALID',
      'Repository root must be an absolute canonical path.',
    );
  }
  try {
    const stat = lstatSync(repoRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('not a real directory');
  } catch {
    throw new ProvenanceCollectorError(
      'PROVENANCE_COLLECTOR_REPOSITORY_INVALID',
      'Repository root is not a real directory.',
    );
  }
  return repoRoot;
}

/** Synchronous byte-exact hash over one governed regular file. */
function sha256FileSync(filePath: string): string {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (!before.isFile()) throw new Error('not a regular file');
    const hash = createHash('sha256');
    const chunk = new Uint8Array(64 * 1024);
    while (true) {
      const read = readSync(descriptor, chunk, 0, chunk.byteLength, null);
      if (read === 0) break;
      hash.update(chunk.subarray(0, read));
    }
    const after = fstatSync(descriptor);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error('file mutated during hashing');
    }
    return hash.digest('hex');
  } catch (error) {
    throw new ProvenanceCollectorError(
      'PROVENANCE_COLLECTOR_HASH_FAILED',
      `Governed file could not be hashed: ${(error as Error).message}`,
    );
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function assertRegularGovernedPath(repoRoot: string, relative: string): string {
  const absolute = path.join(repoRoot, ...relative.split('/'));
  const parts = relative.split('/');
  let current = repoRoot;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]!);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(current);
    } catch {
      throw new ProvenanceCollectorError(
        'PROVENANCE_COLLECTOR_FILE_INVALID',
        `Governed path is missing: ${relative}`,
      );
    }
    if (
      stat.isSymbolicLink() ||
      (index < parts.length - 1 && !stat.isDirectory()) ||
      (index === parts.length - 1 && !stat.isFile())
    ) {
      throw new ProvenanceCollectorError(
        'PROVENANCE_COLLECTOR_FILE_INVALID',
        `Governed path is not a regular file: ${relative}`,
      );
    }
  }
  return absolute;
}

interface PackageProvenanceSnapshot {
  readonly schemaVersion: 1;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly identityKind: 'package-snapshot';
  readonly repositoryRevision: string;
  readonly dirtyPolicy: 'clean';
  readonly lockfileDigest: string;
  readonly governedEntries: readonly GovernedPathEntry[];
}

function collectInstalledPackageProvenance(repoRoot: string): RepositoryProvenanceInputs {
  let snapshot: PackageProvenanceSnapshot;
  try {
    snapshot = JSON.parse(
      readFileSync(path.join(repoRoot, 'provenance', 'package-snapshot.json'), 'utf8'),
    ) as PackageProvenanceSnapshot;
  } catch (error) {
    throw new ProvenanceCollectorError(
      'PROVENANCE_COLLECTOR_REPOSITORY_INVALID',
      `Installed verifier package snapshot is unavailable: ${(error as Error).message}`,
    );
  }
  if (
    snapshot.schemaVersion !== 1 ||
    snapshot.identityKind !== 'package-snapshot' ||
    !/^[0-9a-f]{40}$/i.test(snapshot.repositoryRevision) ||
    !/^[0-9a-f]{64}$/i.test(snapshot.lockfileDigest) ||
    !Array.isArray(snapshot.governedEntries)
  ) {
    throw new ProvenanceCollectorError(
      'PROVENANCE_COLLECTOR_REPOSITORY_INVALID',
      'Installed verifier package snapshot is invalid.',
    );
  }
  const packageManifest = JSON.parse(
    readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
  ) as { name?: unknown; version?: unknown };
  if (
    packageManifest.name !== snapshot.packageName ||
    packageManifest.version !== snapshot.packageVersion
  ) {
    throw new ProvenanceCollectorError(
      'PROVENANCE_COLLECTOR_REPOSITORY_INVALID',
      'Installed verifier package identity does not match its snapshot.',
    );
  }

  const unique = new Set<string>();
  const governedEntries = snapshot.governedEntries.map((entry) => {
    const relative = entry.path;
    if (
      typeof relative !== 'string' ||
      typeof entry.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/i.test(entry.sha256) ||
      unique.has(relative) ||
      path.posix.normalize(relative) !== relative ||
      !isGovernedRepositoryRelativePath(relative) ||
      classifyGovernedProvenancePath(relative) === 'prohibited'
    ) {
      throw new ProvenanceCollectorError(
        'PROVENANCE_COLLECTOR_PATH_INVALID',
        'Installed verifier package snapshot contains an unsafe governed path.',
      );
    }
    unique.add(relative);
    const actual = sha256FileSync(assertRegularGovernedPath(repoRoot, relative));
    if (actual !== entry.sha256.toLowerCase()) {
      throw new ProvenanceCollectorError(
        'PROVENANCE_COLLECTOR_HASH_FAILED',
        `Installed verifier package file does not match its snapshot: ${relative}`,
      );
    }
    return Object.freeze({ path: relative, sha256: actual });
  });

  return Object.freeze({
    repositoryRevision: snapshot.repositoryRevision.toLowerCase(),
    dirtyPolicy: 'clean',
    governedEntries: Object.freeze(governedEntries),
    lockfileDigest: snapshot.lockfileDigest.toLowerCase(),
  });
}

/**
 * Collect only repository-relative governed inputs. The returned value contains
 * no repository root, absolute path, cleanup handle, or write capability.
 */
export function collectRepositoryProvenanceInputs(
  options: CollectRepositoryProvenanceOptions = {},
): RepositoryProvenanceInputs {
  const repoRoot = safeRepositoryRoot(options.repoRoot ?? resolveRepoRoot());
  if (options.runGit === undefined && !isStandaloneGitRoot(repoRoot)) {
    return collectInstalledPackageProvenance(repoRoot);
  }
  const runGit = options.runGit ?? defaultRunGit;
  let revision = text(runGit(['rev-parse', 'HEAD'], repoRoot)).trim();
  if (!/^[0-9a-f]{40}$/i.test(revision)) {
    throw new ProvenanceCollectorError(
      'PROVENANCE_COLLECTOR_GIT_INVALID',
      'Git HEAD must be a concrete revision.',
    );
  }
  const names = repositoryRelativeGitPaths(
    runGit(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], repoRoot),
  );
  const unique = new Set<string>();
  const rawEntries: GovernedPathEntry[] = [];
  for (const relative of names) {
    if (
      path.posix.normalize(relative) !== relative ||
      !relative ||
      !relative
        .split('/')
        .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..') ||
      !relative.split('/').every((segment) => !segment.includes('\\')) ||
      !isGovernedRepositoryRelativePath(relative) ||
      classifyGovernedProvenancePath(relative) === 'prohibited'
    ) {
      throw new ProvenanceCollectorError(
        'PROVENANCE_COLLECTOR_PATH_INVALID',
        'Git supplied an unsafe repository path.',
      );
    }
    if (unique.has(relative)) {
      throw new ProvenanceCollectorError(
        'PROVENANCE_COLLECTOR_PATH_DUPLICATE',
        `Git supplied a duplicate path: ${relative}`,
      );
    }
    unique.add(relative);
    const classification = classifyGovernedProvenancePath(relative);
    if (classification === 'excluded') continue;
    const absolute = assertRegularGovernedPath(repoRoot, relative);
    rawEntries.push({ path: relative, sha256: sha256FileSync(absolute) });
  }
  const governedEntries = selectGovernedProvenanceEntries(rawEntries);
  const lockfile = path.join(repoRoot, 'pnpm-lock.yaml');
  const lockfileDigest = sha256FileSync(lockfile);
  const dirtyStatus = text(
    runGit(['status', '--porcelain=v1', '--untracked-files=all'], repoRoot),
  ).trim();
  revision = revision.toLowerCase();
  return Object.freeze({
    repositoryRevision: revision,
    dirtyPolicy: (dirtyStatus.length === 0
      ? 'clean'
      : 'dirty-governed') as EvidenceProvenanceDirtyPolicy,
    governedEntries: Object.freeze(governedEntries.map((entry) => Object.freeze({ ...entry }))),
    lockfileDigest,
  });
}

export interface CollectEvidenceProvenanceInput extends CollectRepositoryProvenanceOptions {
  readonly componentDigests: {
    readonly cliBootstrapDigest: string;
    readonly runnerDigest: string;
    readonly evidenceWriterDigest: string;
    readonly verifierDigest: string;
    readonly runtimeEngineDigest: string;
  };
  readonly catalogueIdentities: readonly EvidenceProvenanceIdentity[];
  readonly profileIdentities: readonly EvidenceProvenanceIdentity[];
}

/** Collect and assemble the closed provenance DTO without persisting it. */
export function collectEvidenceProvenance(
  input: CollectEvidenceProvenanceInput,
): EvidenceProvenance {
  const repository = collectRepositoryProvenanceInputs(input);
  return buildEvidenceProvenance({
    ...repository,
    ...input.componentDigests,
    catalogueIdentities: input.catalogueIdentities,
    profileIdentities: input.profileIdentities,
  });
}

/** Read-only identity helper for callers that need the governed tree digest. */
export function governedTreeDigestFromCollectedInputs(inputs: RepositoryProvenanceInputs): string {
  return buildGovernedTreeDigest(inputs.governedEntries);
}

// Keep the policy error available to consumers without widening the collector's
// write authority; it is useful when adapting governed-entry validation.
export { EvidenceProvenancePolicyError };

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
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

/**
 * Collect only repository-relative governed inputs. The returned value contains
 * no repository root, absolute path, cleanup handle, or write capability.
 */
export function collectRepositoryProvenanceInputs(
  options: CollectRepositoryProvenanceOptions = {},
): RepositoryProvenanceInputs {
  const repoRoot = safeRepositoryRoot(options.repoRoot ?? resolveRepoRoot());
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

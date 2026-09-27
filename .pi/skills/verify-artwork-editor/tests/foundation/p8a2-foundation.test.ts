import { createHash } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  OPTIONAL_PNG_MAX_BYTES,
  PRIVATE_SNAPSHOT_AGGREGATE_MAX_BYTES,
  RUN_RECORD_MAX_BYTES,
  PrivateSnapshotError,
  capturePrivateSnapshots,
  type PrivateSnapshotFileSystem,
} from '../../src/evidence/private-snapshot';
import {
  PROVENANCE_ACTIVE_ENTRY_ROOTS,
  PROVENANCE_COMPONENT_POLICY,
  assertFinalProvenanceComponentPolicy,
} from '../../src/evidence/provenance-component-policy';
import {
  collectRepositoryProvenanceInputs,
  ProvenanceCollectorError,
} from '../../src/evidence/provenance-collector';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(path.join(os.tmpdir(), 'p8a2-foundation-'));
  roots.push(value);
  return value;
}

describe('[P8-A2 A2-1] bounded private snapshots', () => {
  it('captures required candidates first in deterministic order and defensively snapshots bytes', () => {
    const scratch = root();
    mkdirSync(path.join(scratch, 'files'));
    const optional = Buffer.from('png');
    const required = Buffer.from('{"ok":true}');
    writeFileSync(path.join(scratch, 'files/optional.png'), optional);
    writeFileSync(path.join(scratch, 'files/run-record.json'), required);
    const result = capturePrivateSnapshots({
      scratchRoot: scratch,
      descriptors: [
        {
          artifactId: 'optional',
          relativePath: 'files/optional.png',
          role: 'optional-diagnostic',
          maxBytes: OPTIONAL_PNG_MAX_BYTES,
        },
        {
          artifactId: 'run.record',
          relativePath: 'files/run-record.json',
          role: 'required-authoritative',
          maxBytes: RUN_RECORD_MAX_BYTES,
        },
      ],
    });
    expect(result.snapshots.map((entry) => entry.artifactId)).toEqual(['run.record', 'optional']);
    const exposed = result.snapshots[0]!.bytes;
    exposed.fill(0);
    expect([...result.snapshots[0]!.bytes]).toEqual([...required]);
    expect(result.aggregateBytes).toBe(required.length + optional.length);
  });

  it('rejects aliases, symlinks, non-regular files, unsafe paths, and limit-plus-one', () => {
    const scratch = root();
    mkdirSync(path.join(scratch, 'files'));
    writeFileSync(path.join(scratch, 'files/data.bin'), Buffer.alloc(4));
    symlinkSync(path.join(scratch, 'files/data.bin'), path.join(scratch, 'files/link.bin'));
    expect(() =>
      capturePrivateSnapshots({
        scratchRoot: scratch,
        descriptors: [
          {
            artifactId: 'link',
            relativePath: 'files/link.bin',
            role: 'optional-diagnostic',
            maxBytes: 10,
          },
        ],
      }),
    ).toThrowError(PrivateSnapshotError);
    expect(() =>
      capturePrivateSnapshots({
        scratchRoot: scratch,
        descriptors: [
          {
            artifactId: 'too-big',
            relativePath: 'files/data.bin',
            role: 'optional-diagnostic',
            maxBytes: 3,
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: 'PRIVATE_SNAPSHOT_BOUND_EXCEEDED' }));
    expect(() =>
      capturePrivateSnapshots({
        scratchRoot: scratch,
        descriptors: [
          {
            artifactId: 'escape',
            relativePath: '../data.bin',
            role: 'optional-diagnostic',
            maxBytes: 10,
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: 'PRIVATE_SNAPSHOT_DESCRIPTOR_INVALID' }));
  });

  it('rejects closed-key, role, and per-role-cap descriptor violations', () => {
    const scratch = root();
    writeFileSync(path.join(scratch, 'candidate.bin'), 'x');
    const invalidDescriptors = [
      {
        artifactId: 'unknown',
        relativePath: 'candidate.bin',
        role: 'optional-diagnostic',
        maxBytes: 1,
        extra: true,
      },
      { artifactId: 'role', relativePath: 'candidate.bin', role: 'diagnostic', maxBytes: 1 },
      {
        artifactId: 'cap',
        relativePath: 'candidate.bin',
        role: 'optional-diagnostic',
        maxBytes: OPTIONAL_PNG_MAX_BYTES + 1,
      },
    ];
    for (const descriptor of invalidDescriptors) {
      expect(() =>
        capturePrivateSnapshots({ scratchRoot: scratch, descriptors: [descriptor as never] }),
      ).toThrowError(expect.objectContaining({ code: 'PRIVATE_SNAPSHOT_DESCRIPTOR_INVALID' }));
    }
  });

  it('accepts an exact bound and detects parent traversal swaps through the read-only seam', () => {
    const scratch = root();
    mkdirSync(path.join(scratch, 'files'));
    writeFileSync(path.join(scratch, 'files/exact.bin'), Buffer.alloc(8, 7));
    const exact = capturePrivateSnapshots({
      scratchRoot: scratch,
      aggregateLimitBytes: 8,
      descriptors: [
        {
          artifactId: 'exact',
          relativePath: 'files/exact.bin',
          role: 'optional-diagnostic',
          maxBytes: 8,
        },
      ],
    });
    expect(exact.aggregateBytes).toBe(8);

    const base: PrivateSnapshotFileSystem = {
      lstatSync,
      realpathSync,
      openSync,
      fstatSync,
      readSync,
      closeSync,
    };
    let realpathCalls = 0;
    const swappedParent: PrivateSnapshotFileSystem = {
      ...base,
      realpathSync: ((candidate: Parameters<typeof realpathSync>[0]) => {
        realpathCalls += 1;
        const resolved = realpathSync(candidate);
        return realpathCalls >= 5 && String(candidate).endsWith(`${path.sep}files`)
          ? `${resolved}-swapped`
          : resolved;
      }) as typeof realpathSync,
    };
    expect(() =>
      capturePrivateSnapshots({
        scratchRoot: scratch,
        descriptors: [
          {
            artifactId: 'swap',
            relativePath: 'files/exact.bin',
            role: 'optional-diagnostic',
            maxBytes: 8,
          },
        ],
        fileSystem: swappedParent,
      }),
    ).toThrowError(expect.objectContaining({ code: 'PRIVATE_SNAPSHOT_MUTATED' }));

    let mutated = false;
    const mutatingFile: PrivateSnapshotFileSystem = {
      ...base,
      readSync: ((
        fd: Parameters<typeof readSync>[0],
        buffer: Parameters<typeof readSync>[1],
        offset: number,
        length: number,
        position: number | null,
      ) => {
        const count = readSync(fd, buffer, offset, length, position);
        if (!mutated) {
          mutated = true;
          writeFileSync(path.join(scratch, 'files/exact.bin'), Buffer.alloc(9, 8));
        }
        return count;
      }) as typeof readSync,
    };
    expect(() =>
      capturePrivateSnapshots({
        scratchRoot: scratch,
        descriptors: [
          {
            artifactId: 'content-mutation',
            relativePath: 'files/exact.bin',
            role: 'optional-diagnostic',
            maxBytes: 8,
          },
        ],
        fileSystem: mutatingFile,
      }),
    ).toThrowError(expect.objectContaining({ code: 'PRIVATE_SNAPSHOT_MUTATED' }));
  });

  it('rejects duplicate ids and paths, including aliases, missing parents, parent symlinks, and non-regular targets', () => {
    const scratch = root();
    mkdirSync(path.join(scratch, 'real'));
    writeFileSync(path.join(scratch, 'real/file.bin'), 'x');
    symlinkSync(path.join(scratch, 'real'), path.join(scratch, 'parent-link'));
    expect(() =>
      capturePrivateSnapshots({
        scratchRoot: scratch,
        descriptors: [
          {
            artifactId: 'same',
            relativePath: 'real/file.bin',
            role: 'optional-diagnostic',
            maxBytes: 8,
          },
          {
            artifactId: 'same',
            relativePath: 'real/file.bin',
            role: 'optional-diagnostic',
            maxBytes: 8,
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: 'PRIVATE_SNAPSHOT_DESCRIPTOR_INVALID' }));
    expect(() =>
      capturePrivateSnapshots({
        scratchRoot: scratch,
        descriptors: [
          {
            artifactId: 'one',
            relativePath: 'real/file.bin',
            role: 'optional-diagnostic',
            maxBytes: 8,
          },
          {
            artifactId: 'two',
            relativePath: 'real/file.bin',
            role: 'optional-diagnostic',
            maxBytes: 8,
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: 'PRIVATE_SNAPSHOT_DESCRIPTOR_INVALID' }));
    expect(() =>
      capturePrivateSnapshots({
        scratchRoot: scratch,
        descriptors: [
          {
            artifactId: 'alias',
            relativePath: 'real/./file.bin',
            role: 'optional-diagnostic',
            maxBytes: 8,
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: 'PRIVATE_SNAPSHOT_DESCRIPTOR_INVALID' }));
    expect(() =>
      capturePrivateSnapshots({
        scratchRoot: scratch,
        descriptors: [
          {
            artifactId: 'missing',
            relativePath: 'missing.bin',
            role: 'optional-diagnostic',
            maxBytes: 8,
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: 'PRIVATE_SNAPSHOT_NOT_FOUND' }));
    expect(() =>
      capturePrivateSnapshots({
        scratchRoot: scratch,
        descriptors: [
          {
            artifactId: 'parent-link',
            relativePath: 'parent-link/file.bin',
            role: 'optional-diagnostic',
            maxBytes: 8,
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: 'PRIVATE_SNAPSHOT_SYMLINK' }));
    expect(() =>
      capturePrivateSnapshots({
        scratchRoot: scratch,
        descriptors: [
          {
            artifactId: 'directory',
            relativePath: 'real',
            role: 'optional-diagnostic',
            maxBytes: 8,
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: 'PRIVATE_SNAPSHOT_NOT_REGULAR' }));
  });

  it('reserves the required bound before optional capture and never grants cleanup authority', () => {
    const scratch = root();
    writeFileSync(path.join(scratch, 'required.json'), 'x');
    writeFileSync(path.join(scratch, 'optional.png'), 'y');
    expect(() =>
      capturePrivateSnapshots({
        scratchRoot: scratch,
        aggregateLimitBytes: 10,
        descriptors: [
          {
            artifactId: 'required',
            relativePath: 'required.json',
            role: 'required-authoritative',
            maxBytes: 9,
          },
          {
            artifactId: 'optional',
            relativePath: 'optional.png',
            role: 'optional-diagnostic',
            maxBytes: 9,
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: 'PRIVATE_SNAPSHOT_AGGREGATE_BOUND_EXCEEDED' }));
    expect(PRIVATE_SNAPSHOT_AGGREGATE_MAX_BYTES).toBe(1024 * 1024);
  });
});

describe('[P8-A2 A2-1] pre-activation provenance scaffold', () => {
  it('uses the authoritative post-activation closure for final provenance', () => {
    expect(PROVENANCE_COMPONENT_POLICY.authoritativeForFinalProvenance).toBe(true);
    expect(PROVENANCE_COMPONENT_POLICY.phase).toBe('post-activation');
    expect(Object.keys(PROVENANCE_COMPONENT_POLICY.frozenClosures).sort()).toEqual([
      'diagnostic',
      'doctor',
      'production-absence',
      'suite-child',
    ]);
    expect(() => assertFinalProvenanceComponentPolicy()).not.toThrow();
  });

  it('collects only repository-relative governed bytes through a read-only git seam', () => {
    const repo = root();
    mkdirSync(path.join(repo, 'src'), { recursive: true });
    writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 1;');
    writeFileSync(path.join(repo, 'pnpm-lock.yaml'), 'lockfile');
    const calls: string[][] = [];
    const runGit = (args: readonly string[]) => {
      calls.push([...args]);
      if (args[0] === 'rev-parse') return 'a'.repeat(40);
      if (args[0] === 'status') return '';
      return 'pnpm-lock.yaml\0src/a.ts\0';
    };
    const collected = collectRepositoryProvenanceInputs({ repoRoot: repo, runGit });
    expect(collected.repositoryRevision).toBe('a'.repeat(40));
    expect(collected.governedEntries.map((entry) => entry.path)).toEqual([
      'pnpm-lock.yaml',
      'src/a.ts',
    ]);
    expect(JSON.stringify(collected)).not.toContain(repo);
    expect(calls.some((args) => args.includes('-z'))).toBe(true);
  });

  it('rejects malformed NUL framing, preserves backslash identity by rejecting it, and rejects aliases and duplicates', () => {
    const repo = root();
    mkdirSync(path.join(repo, 'src'), { recursive: true });
    writeFileSync(path.join(repo, 'src/a.ts'), 'a');
    writeFileSync(path.join(repo, 'pnpm-lock.yaml'), 'lockfile');
    const run = (listing: Uint8Array | string) => (args: readonly string[]) =>
      args[0] === 'rev-parse' ? 'b'.repeat(40) : args[0] === 'status' ? '' : listing;
    expect(() =>
      collectRepositoryProvenanceInputs({ repoRoot: repo, runGit: run('src/a.ts') }),
    ).toThrowError(expect.objectContaining({ code: 'PROVENANCE_COLLECTOR_GIT_INVALID' }));
    expect(() =>
      collectRepositoryProvenanceInputs({ repoRoot: repo, runGit: run('src/a.ts\0\0') }),
    ).toThrowError(expect.objectContaining({ code: 'PROVENANCE_COLLECTOR_GIT_INVALID' }));
    expect(() =>
      collectRepositoryProvenanceInputs({
        repoRoot: repo,
        runGit: run(new TextEncoder().encode(String.raw`src\a.ts` + '\0')),
      }),
    ).toThrowError(expect.objectContaining({ code: 'PROVENANCE_COLLECTOR_PATH_INVALID' }));
    expect(() =>
      collectRepositoryProvenanceInputs({ repoRoot: repo, runGit: run('src/./a.ts\0') }),
    ).toThrowError(expect.objectContaining({ code: 'PROVENANCE_COLLECTOR_PATH_INVALID' }));
    expect(() =>
      collectRepositoryProvenanceInputs({ repoRoot: repo, runGit: run('src/a.ts\0src/a.ts\0') }),
    ).toThrowError(expect.objectContaining({ code: 'PROVENANCE_COLLECTOR_PATH_DUPLICATE' }));
  });

  it('binds the concrete revision, lockfile digest, dirty policy, and rejects governed symlinks/non-regular files', () => {
    const repo = root();
    mkdirSync(path.join(repo, 'src'), { recursive: true });
    writeFileSync(path.join(repo, 'src/a.ts'), 'a');
    writeFileSync(path.join(repo, 'pnpm-lock.yaml'), 'lockfile');
    const expectedLockDigest = createHash('sha256').update('lockfile').digest('hex');
    const collected = collectRepositoryProvenanceInputs({
      repoRoot: repo,
      runGit: (args) =>
        args[0] === 'rev-parse'
          ? 'C'.repeat(40)
          : args[0] === 'status'
            ? ' M src/a.ts\n'
            : 'pnpm-lock.yaml\0src/a.ts\0',
    });
    expect(collected.repositoryRevision).toBe('c'.repeat(40));
    expect(collected.lockfileDigest).toBe(expectedLockDigest);
    expect(collected.dirtyPolicy).toBe('dirty-governed');
    expect(collected.governedEntries.every((entry) => !path.isAbsolute(entry.path))).toBe(true);

    symlinkSync(path.join(repo, 'src/a.ts'), path.join(repo, 'src/link.ts'));
    expect(() =>
      collectRepositoryProvenanceInputs({
        repoRoot: repo,
        runGit: (args) =>
          args[0] === 'rev-parse'
            ? 'd'.repeat(40)
            : args[0] === 'status'
              ? ''
              : 'pnpm-lock.yaml\0src/link.ts\0',
      }),
    ).toThrowError(expect.objectContaining({ code: 'PROVENANCE_COLLECTOR_FILE_INVALID' }));
    mkdirSync(path.join(repo, 'src/dir'));
    expect(() =>
      collectRepositoryProvenanceInputs({
        repoRoot: repo,
        runGit: (args) =>
          args[0] === 'rev-parse'
            ? 'e'.repeat(40)
            : args[0] === 'status'
              ? ''
              : 'pnpm-lock.yaml\0src/dir\0',
      }),
    ).toThrowError(expect.objectContaining({ code: 'PROVENANCE_COLLECTOR_FILE_INVALID' }));
  });

  it('rejects non-concrete revisions and unsafe supplied git paths', () => {
    const repo = root();
    writeFileSync(path.join(repo, 'pnpm-lock.yaml'), 'lockfile');
    expect(() =>
      collectRepositoryProvenanceInputs({
        repoRoot: repo,
        runGit: (args) =>
          args[0] === 'rev-parse' ? 'HEAD' : args[0] === 'status' ? '' : '../secret\0',
      }),
    ).toThrowError(ProvenanceCollectorError);
  });
});

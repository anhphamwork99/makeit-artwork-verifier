import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  collectRepositoryProvenanceInputs,
  ProvenanceCollectorError,
} from '../../src/evidence/provenance-collector';

const roots: string[] = [];
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function installedPackage() {
  const root = mkdtempSync(path.join(tmpdir(), 'verifier-package-provenance-'));
  roots.push(root);
  mkdirSync(path.join(root, 'src'), { recursive: true });
  mkdirSync(path.join(root, 'provenance'), { recursive: true });
  writeFileSync(path.join(root, 'src/index.ts'), 'export const value = 1;\n');
  writeFileSync(path.join(root, 'package.json'), '{"name":"makeit-artwork-verifier","version":"9.9.9"}\n');
  const snapshot = {
    schemaVersion: 1,
    packageName: 'makeit-artwork-verifier',
    packageVersion: '9.9.9',
    identityKind: 'package-snapshot',
    repositoryRevision: 'a'.repeat(40),
    dirtyPolicy: 'clean',
    lockfileDigest: 'b'.repeat(64),
    governedEntries: [
      { path: 'src/index.ts', sha256: sha256('export const value = 1;\n') },
    ],
  };
  writeFileSync(
    path.join(root, 'provenance/package-snapshot.json'),
    `${JSON.stringify(snapshot, null, 2)}\n`,
  );
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('installed package provenance', () => {
  it('uses and validates the packaged immutable snapshot without a Git checkout', () => {
    const collected = collectRepositoryProvenanceInputs({ repoRoot: installedPackage() });
    expect(collected.repositoryRevision).toBe('a'.repeat(40));
    expect(collected.lockfileDigest).toBe('b'.repeat(64));
    expect(collected.dirtyPolicy).toBe('clean');
    expect(collected.governedEntries).toHaveLength(1);
  });

  it('fails closed when an installed governed file differs from the snapshot', () => {
    const root = installedPackage();
    writeFileSync(path.join(root, 'src/index.ts'), 'tampered\n');
    expect(() => collectRepositoryProvenanceInputs({ repoRoot: root })).toThrowError(
      expect.objectContaining<Partial<ProvenanceCollectorError>>({
        code: 'PROVENANCE_COLLECTOR_HASH_FAILED',
      }),
    );
  });
});

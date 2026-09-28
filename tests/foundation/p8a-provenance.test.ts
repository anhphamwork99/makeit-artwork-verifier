import { describe, expect, it } from 'vitest';

import { deriveProvenanceIdentity } from '../../src/canonical/package8-identity';
import {
  EVIDENCE_PROVENANCE_SCHEMA_VERSION,
  validateEvidenceProvenance,
} from '../../src/contracts/evidence-transaction';
import {
  buildEvidenceProvenance,
  buildGovernedTreeDigest,
  classifyGovernedProvenancePath,
  EVIDENCE_PROVENANCE_POLICY_VERSION,
  EvidenceProvenancePolicyError,
  isGovernedProvenancePath,
  PROVENANCE_EXCLUDED_PREFIXES,
  PROVENANCE_INCLUDED_PREFIXES,
  selectGovernedProvenanceEntries,
  validateGovernedProvenance,
} from '../../src/evidence/provenance';

/**
 * P8-A1 pure repository-relative provenance policy (ADR 0041).
 *
 * Proves governed-byte inclusion/exclusion, path safety, deterministic
 * order-stable dirty-tree digests, and closed-record validation with no
 * filesystem access.
 */

const HEX = (character: string): string => character.repeat(64);

describe('[P8-A1] governed provenance path policy', () => {
  it('classifies included governed inputs', () => {
    for (const path of [
      'src/app.ts',
      'package.json',
      'pnpm-lock.yaml',
      'tsconfig.portable.json',
      'src/x.ts',
      'tests/foundation/x.test.ts',
      'catalogues/readiness/x.v1.json',
      '.pi/skills/verify-artwork-editor/SKILL.md',
    ]) {
      expect(classifyGovernedProvenancePath(path), path).toBe('included');
      expect(isGovernedProvenancePath(path), path).toBe(true);
    }
  });

  it('classifies volatile output and caches as excluded', () => {
    for (const path of [
      'node_modules/x/y.js',
      'tsconfig.tsbuildinfo',
      '.DS_Store',
      'next-env.d.ts',
      'playwright-report/index.html',
      'dist/bundle.js',
      'evidence/runs/x/run-record.json',
      'src/build.log',
    ]) {
      expect(classifyGovernedProvenancePath(path), path).toBe('excluded');
      expect(isGovernedProvenancePath(path), path).toBe(false);
    }
  });

  it('classifies absolute/private/traversal/secret paths as prohibited', () => {
    for (const path of [
      '/Users/secret/x',
      'C:\\secret\\x',
      '../../etc/passwd',
      'file:/tmp/x',
      '.env',
      '.env.local',
      'certs/server.pem',
      'certs/signing.key',
    ]) {
      expect(classifyGovernedProvenancePath(path), path).toBe('prohibited');
    }
  });

  it('never accepts an excluded or prohibited path in the governed digest', () => {
    const governed = selectGovernedProvenanceEntries([
      { path: 'src/a.ts', sha256: HEX('a') },
      { path: 'node_modules/x.js', sha256: HEX('b') },
    ]);
    expect(governed).toEqual([{ path: 'src/a.ts', sha256: HEX('a') }]);
    expect(() => selectGovernedProvenanceEntries([{ path: '.env', sha256: HEX('c') }])).toThrow(
      EvidenceProvenancePolicyError,
    );
    try {
      selectGovernedProvenanceEntries([{ path: '.env', sha256: HEX('c') }]);
    } catch (error) {
      expect((error as EvidenceProvenancePolicyError).code).toBe('PROVENANCE_PATH_PROHIBITED');
    }
    expect(() =>
      selectGovernedProvenanceEntries([{ path: 'src/a.ts', sha256: 'not-hex' }]),
    ).toThrow(EvidenceProvenancePolicyError);
  });

  it('declares a versioned, explicit inclusion/exclusion policy', () => {
    expect(EVIDENCE_PROVENANCE_POLICY_VERSION).toBe(2);
    expect(PROVENANCE_INCLUDED_PREFIXES).toContain('src/');
    expect(PROVENANCE_EXCLUDED_PREFIXES).toContain('node_modules/');
    expect(PROVENANCE_EXCLUDED_PREFIXES.some((prefix) => prefix.includes('evidence/'))).toBe(true);
  });
});

describe('[P8-A1] deterministic dirty-tree digest', () => {
  it('is order-stable and ignores excluded entries', () => {
    const first = buildGovernedTreeDigest([
      { path: 'src/a.ts', sha256: HEX('a') },
      { path: 'src/b.ts', sha256: HEX('b') },
    ]);
    const reordered = buildGovernedTreeDigest([
      { path: 'src/b.ts', sha256: HEX('b') },
      { path: 'src/a.ts', sha256: HEX('a') },
      { path: 'tsconfig.tsbuildinfo', sha256: HEX('c') },
      { path: 'node_modules/x.js', sha256: HEX('d') },
    ]);
    expect(reordered).toBe(first);
  });

  it('changes when a governed source changes', () => {
    const before = buildGovernedTreeDigest([{ path: 'src/a.ts', sha256: HEX('a') }]);
    const after = buildGovernedTreeDigest([{ path: 'src/a.ts', sha256: HEX('9') }]);
    expect(after).not.toBe(before);
  });

  it('changes when a governed path is added or removed', () => {
    const one = buildGovernedTreeDigest([{ path: 'src/a.ts', sha256: HEX('a') }]);
    const two = buildGovernedTreeDigest([
      { path: 'src/a.ts', sha256: HEX('a') },
      { path: 'src/b.ts', sha256: HEX('b') },
    ]);
    expect(two).not.toBe(one);
  });
});

describe('[P8-A1] provenance record assembly', () => {
  const input = {
    repositoryRevision: 'a'.repeat(40),
    dirtyPolicy: 'dirty-governed' as const,
    governedEntries: [{ path: 'src/a.ts', sha256: HEX('a') }],
    lockfileDigest: HEX('b'),
    cliBootstrapDigest: HEX('c'),
    runnerDigest: HEX('d'),
    evidenceWriterDigest: HEX('e'),
    verifierDigest: HEX('f'),
    runtimeEngineDigest: HEX('1'),
    catalogueIdentities: [
      { id: 'catalogue:z', digest: HEX('3') },
      { id: 'catalogue:readiness', digest: HEX('2') },
    ],
    profileIdentities: [{ id: 'profile:image', digest: HEX('4') }],
  };

  it('assembles a closed, canonically sorted provenance record', () => {
    const provenance = buildEvidenceProvenance(input);
    expect(provenance.schemaVersion).toBe(EVIDENCE_PROVENANCE_SCHEMA_VERSION);
    expect(provenance.policyVersion).toBe(EVIDENCE_PROVENANCE_POLICY_VERSION);
    expect(provenance.catalogueIdentities.map((entry) => entry.id)).toEqual([
      'catalogue:readiness',
      'catalogue:z',
    ]);
    expect(validateGovernedProvenance(provenance)).toEqual([]);
  });

  it('rejects an unsupported dirty policy', () => {
    expect(() =>
      buildEvidenceProvenance({ ...input, dirtyPolicy: 'nope' as unknown as 'clean' }),
    ).toThrow(EvidenceProvenancePolicyError);
  });

  it('is stable under irrelevant identity authoring order but sensitive to a digest', () => {
    const base = buildEvidenceProvenance(input);
    const reversed = buildEvidenceProvenance({
      ...input,
      catalogueIdentities: [...input.catalogueIdentities].reverse(),
    });
    expect(deriveProvenanceIdentity(reversed)).toBe(deriveProvenanceIdentity(base));
    const changed = buildEvidenceProvenance({ ...input, verifierDigest: HEX('9') });
    expect(deriveProvenanceIdentity(changed)).not.toBe(deriveProvenanceIdentity(base));
  });

  it('validates a closed record and rejects an unknown key', () => {
    const provenance = buildEvidenceProvenance(input);
    expect(validateEvidenceProvenance(provenance)).toEqual([]);
    expect(
      validateEvidenceProvenance({ ...provenance, secretPath: '/Users/x' }).map(
        (entry) => entry.code,
      ),
    ).toContain('EVIDENCE_UNKNOWN_KEY');
    expect(
      validateEvidenceProvenance({ ...provenance, dirtyTreeDigest: 'not-hex' }).map(
        (entry) => entry.code,
      ),
    ).toContain('EVIDENCE_DIGEST_INVALID');
  });
});

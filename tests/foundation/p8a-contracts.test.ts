import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  buildPackage8IdentityPreimage,
  deriveIntendedInventoryIdentity,
  deriveProvenanceIdentity,
  package8IdentityDigest,
  PACKAGE8_IDENTITY_DOMAINS,
  PACKAGE8_IDENTITY_SCHEMA_VERSION,
} from '../../src/canonical/package8-identity';
import {
  EVIDENCE_ARTIFACT_ENTRY_KEYS,
  EVIDENCE_FINAL_MANIFEST_KEYS,
  EVIDENCE_FINAL_MANIFEST_LABEL,
  EVIDENCE_FINAL_MANIFEST_SCHEMA_VERSION,
  EVIDENCE_INTENDED_INVENTORY_LABEL,
  EVIDENCE_INTENDED_INVENTORY_SCHEMA_VERSION,
  EVIDENCE_PRODUCER_PHASES,
  EVIDENCE_PROVENANCE_KEYS,
  EVIDENCE_PROVENANCE_SCHEMA_VERSION,
  EVIDENCE_REFERENCE_KINDS,
  EVIDENCE_RETENTION_STATUSES,
  EVIDENCE_SANITIZATION_POLICIES,
  EVIDENCE_SEALED_STRICT_SCHEMAS,
  EVIDENCE_SEMANTIC_DIGEST_KINDS,
  EVIDENCE_TRANSACTION_KINDS,
  isEvidenceLogicalId,
  isEvidenceMediaType,
  isEvidenceProducerPhase,
  isEvidenceReferenceKind,
  isEvidenceRelativePath,
  isEvidenceRetentionStatus,
  isEvidenceSanitizationPolicy,
  isEvidenceSemanticDigestKind,
  isEvidenceSha256Digest,
  isEvidenceTransactionKind,
  isPlainDataObject,
  validateEvidenceArtifactEntry,
  validateEvidenceFinalManifest,
  validateEvidenceIntendedInventory,
  type EvidenceArtifactEntry,
  type EvidenceFinalManifest,
  type EvidenceIntendedInventory,
  type EvidenceProvenance,
} from '../../src/contracts/evidence-transaction';
import { deriveSemanticDigest } from '../../src/evidence/semantic-digest';
import { buildInventoryReferenceEdges } from '../../src/evidence/reference-graph';
import { EVIDENCE_PROVENANCE_POLICY_VERSION } from '../../src/evidence/provenance';

/**
 * P8-A1 closed contracts and canonical identities (ADR 0041).
 *
 * Proves the intended-inventory and final-manifest contracts reject unknown
 * keys/discriminants/versions, that path/id/digest predicates are safe, and that
 * Package-8 identities are order-stable and semantically sensitive.
 */

const HEX = (character: string): string => character.repeat(64);

function provenance(): EvidenceProvenance {
  return {
    schemaVersion: EVIDENCE_PROVENANCE_SCHEMA_VERSION,
    policyVersion: EVIDENCE_PROVENANCE_POLICY_VERSION,
    repositoryRevision: 'a'.repeat(40),
    dirtyPolicy: 'dirty-governed',
    dirtyTreeDigest: HEX('b'),
    lockfileDigest: HEX('c'),
    cliBootstrapDigest: HEX('d'),
    runnerDigest: HEX('e'),
    evidenceWriterDigest: HEX('f'),
    verifierDigest: HEX('1'),
    runtimeEngineDigest: HEX('2'),
    catalogueIdentities: [{ id: 'catalogue:readiness', digest: HEX('3') }],
    profileIdentities: [{ id: 'profile:image', digest: HEX('4') }],
  };
}

function artifact(
  artifactId: string,
  overrides: Partial<EvidenceArtifactEntry> = {},
): EvidenceArtifactEntry {
  return {
    artifactId,
    role: 'diagnostic-only',
    mediaType: 'application/json',
    schema: 'schema.v1',
    relativePath: `files/${artifactId.replace(':', '-')}.json`,
    byteLength: 10,
    sha256: HEX('a'),
    semanticDigest: null,
    semanticDigestKind: null,
    producerPhase: 'observation',
    consumedBy: [],
    sanitizationPolicy: 'public-json-guard-v1',
    retentionStatus: 'required-preserve',
    ...overrides,
  };
}

function inventory(overrides: Partial<EvidenceIntendedInventory> = {}): EvidenceIntendedInventory {
  return {
    schemaVersion: EVIDENCE_INTENDED_INVENTORY_SCHEMA_VERSION,
    label: EVIDENCE_INTENDED_INVENTORY_LABEL,
    transactionKind: 'run',
    transactionId: 'run-1',
    provenance: provenance(),
    sealedStrictSchemas: EVIDENCE_SEALED_STRICT_SCHEMAS,
    artifacts: [
      artifact('artifact:doctor-json', {
        role: 'required-authoritative',
        schema: 'doctor.v7',
        consumedBy: ['artifact:summary'],
        semanticDigest: deriveSemanticDigest('canonical-json', { ok: true }),
        semanticDigestKind: 'canonical-json',
      }),
      artifact('artifact:screenshot', { mediaType: 'image/png', producerPhase: 'observation' }),
      artifact('artifact:summary', { producerPhase: 'evaluation' }),
    ],
    createdAtUtc: '2026-09-21T00:00:00.000Z',
    ...overrides,
  };
}

function manifest(
  base: EvidenceIntendedInventory = inventory(),
  overrides: Partial<EvidenceFinalManifest> = {},
): EvidenceFinalManifest {
  return {
    schemaVersion: EVIDENCE_FINAL_MANIFEST_SCHEMA_VERSION,
    label: EVIDENCE_FINAL_MANIFEST_LABEL,
    transactionKind: base.transactionKind,
    transactionId: base.transactionId,
    inventoryIdentity: deriveIntendedInventoryIdentity(base),
    provenanceIdentity: deriveProvenanceIdentity(base.provenance),
    sealedStrictSchemas: EVIDENCE_SEALED_STRICT_SCHEMAS,
    behaviorOutcome: 'PASS',
    transactionResult: 'committed',
    committedArtifacts: base.artifacts.map((entry) => ({
      artifactId: entry.artifactId,
      relativePath: entry.relativePath,
      byteLength: entry.byteLength,
      sha256: entry.sha256,
      semanticDigest: entry.semanticDigest,
    })),
    references: buildInventoryReferenceEdges(base),
    committedAtUtc: '2026-09-21T00:00:01.000Z',
    ...overrides,
  };
}

describe('[P8-A1] closed evidence transaction contracts', () => {
  it('seals the strict correctness schemas as unchanged literals', () => {
    expect(EVIDENCE_SEALED_STRICT_SCHEMAS).toEqual({
      runRecordSchemaVersion: 4,
      suiteRecordSchemaVersion: 2,
      currentChildRecordLabel: 'current-v4',
      suiteRecordLabel: 'suite-v2',
    });
  });

  it('declares unique closed vocabularies', () => {
    for (const vocabulary of [
      EVIDENCE_TRANSACTION_KINDS,
      EVIDENCE_PRODUCER_PHASES,
      EVIDENCE_SANITIZATION_POLICIES,
      EVIDENCE_RETENTION_STATUSES,
      EVIDENCE_REFERENCE_KINDS,
      EVIDENCE_SEMANTIC_DIGEST_KINDS,
    ]) {
      expect(new Set(vocabulary).size).toBe(vocabulary.length);
    }
    expect(EVIDENCE_TRANSACTION_KINDS).toEqual(['run', 'suite']);
  });

  it('guards every discriminant against unknown values', () => {
    expect(isEvidenceTransactionKind('run')).toBe(true);
    expect(isEvidenceTransactionKind('nope')).toBe(false);
    expect(isEvidenceProducerPhase('observation')).toBe(true);
    expect(isEvidenceProducerPhase('nope')).toBe(false);
    expect(isEvidenceSanitizationPolicy('public-json-guard-v1')).toBe(true);
    expect(isEvidenceSanitizationPolicy('nope')).toBe(false);
    expect(isEvidenceRetentionStatus('eligible-later')).toBe(true);
    expect(isEvidenceRetentionStatus('nope')).toBe(false);
    expect(isEvidenceReferenceKind('child-manifest')).toBe(true);
    expect(isEvidenceReferenceKind('nope')).toBe(false);
    expect(isEvidenceSemanticDigestKind('record-set')).toBe(true);
    expect(isEvidenceSemanticDigestKind('nope')).toBe(false);
  });

  it('rejects absolute/private/traversal paths and accepts safe relative paths', () => {
    for (const unsafe of [
      '',
      '/etc/passwd',
      '/Users/secret/x',
      'C:\\secret\\x',
      'file:/tmp/x',
      'blob:http://x',
      '../escape',
      'a/../../b',
      'a//b',
      'a\\b',
      'a\0b',
    ]) {
      expect(isEvidenceRelativePath(unsafe), unsafe).toBe(false);
    }
    for (const safe of ['src/a.ts', 'src/a.ts', 'a/b/c.json']) {
      expect(isEvidenceRelativePath(safe), safe).toBe(true);
    }
  });

  it('guards logical ids, media types, and digests', () => {
    expect(isEvidenceLogicalId('artifact:summary')).toBe(true);
    expect(isEvidenceLogicalId('.')).toBe(false);
    expect(isEvidenceLogicalId('')).toBe(false);
    expect(isEvidenceLogicalId('a b')).toBe(false);
    expect(isEvidenceMediaType('application/json')).toBe(true);
    expect(isEvidenceMediaType('image/png')).toBe(true);
    expect(isEvidenceMediaType('json')).toBe(false);
    expect(isEvidenceMediaType('application/json; charset=utf-8')).toBe(false);
    expect(isEvidenceSha256Digest(HEX('a'))).toBe(true);
    expect(isEvidenceSha256Digest('A'.repeat(64))).toBe(false);
    expect(isEvidenceSha256Digest('abc')).toBe(false);
    expect(isPlainDataObject({})).toBe(true);
    expect(isPlainDataObject(new Date())).toBe(false);
    expect(isPlainDataObject([])).toBe(false);
  });

  it('validates a closed artifact entry, rejecting unknown keys and bad values', () => {
    expect(validateEvidenceArtifactEntry(artifact('artifact:a'))).toEqual([]);
    expect(
      validateEvidenceArtifactEntry({ ...artifact('artifact:a'), extra: 1 }).map((i) => i.code),
    ).toContain('EVIDENCE_UNKNOWN_KEY');
    const missing = { ...artifact('artifact:a') } as Record<string, unknown>;
    delete missing.artifactId;
    expect(validateEvidenceArtifactEntry(missing).map((i) => i.code)).toContain(
      'EVIDENCE_MISSING_KEY',
    );
    expect(
      validateEvidenceArtifactEntry({ ...artifact('artifact:a'), role: 'nope' }).map((i) => i.code),
    ).toContain('EVIDENCE_ARTIFACT_ROLE_UNKNOWN');
    expect(
      validateEvidenceArtifactEntry({ ...artifact('artifact:a'), relativePath: '/abs' }).map(
        (i) => i.code,
      ),
    ).toContain('EVIDENCE_RELATIVE_PATH_INVALID');
    expect(
      validateEvidenceArtifactEntry({
        ...artifact('artifact:a'),
        consumedBy: ['artifact:z', 'artifact:a'],
      }).map((i) => i.code),
    ).toContain('EVIDENCE_REFERENCE_ORDER_INVALID');
    expect(
      validateEvidenceArtifactEntry({
        ...artifact('artifact:a'),
        semanticDigest: HEX('b'),
        semanticDigestKind: null,
      }).map((i) => i.code),
    ).toContain('EVIDENCE_SEMANTIC_DIGEST_KIND_UNKNOWN');
  });

  it('validates a closed run inventory and rejects version/label/order drift', () => {
    expect(validateEvidenceIntendedInventory(inventory())).toEqual([]);
    expect(
      validateEvidenceIntendedInventory({ ...inventory(), schemaVersion: 2 }).map((i) => i.code),
    ).toContain('EVIDENCE_SCHEMA_VERSION_UNSUPPORTED');
    expect(
      validateEvidenceIntendedInventory({ ...inventory(), label: 'nope' }).map((i) => i.code),
    ).toContain('EVIDENCE_LABEL_UNSUPPORTED');
    expect(
      validateEvidenceIntendedInventory({ ...inventory(), transactionKind: 'nope' }).map(
        (i) => i.code,
      ),
    ).toContain('EVIDENCE_TRANSACTION_KIND_UNKNOWN');
    expect(
      validateEvidenceIntendedInventory({
        ...inventory(),
        sealedStrictSchemas: { ...EVIDENCE_SEALED_STRICT_SCHEMAS, runRecordSchemaVersion: 5 },
      }).map((i) => i.code),
    ).toContain('EVIDENCE_SEALED_STRICT_SCHEMA_MISMATCH');
    expect(
      validateEvidenceIntendedInventory({
        ...inventory(),
        sealedStrictSchemas: { ...EVIDENCE_SEALED_STRICT_SCHEMAS, extra: 1 },
      }).map((i) => i.code),
    ).toContain('EVIDENCE_UNKNOWN_KEY');
    const duplicated = inventory({
      artifacts: [artifact('artifact:a'), artifact('artifact:a')],
    });
    expect(validateEvidenceIntendedInventory(duplicated).map((i) => i.code)).toContain(
      'EVIDENCE_ARTIFACT_DUPLICATE_ID',
    );
    const unsorted = inventory({
      artifacts: [artifact('artifact:z'), artifact('artifact:a')],
    });
    expect(validateEvidenceIntendedInventory(unsorted).map((i) => i.code)).toContain(
      'EVIDENCE_ARTIFACT_ORDER_INVALID',
    );
    const empty = inventory({ artifacts: [] });
    expect(validateEvidenceIntendedInventory(empty).map((i) => i.code)).toContain(
      'EVIDENCE_ARTIFACT_EMPTY',
    );
  });

  it('validates a closed committed final manifest', () => {
    expect(validateEvidenceFinalManifest(manifest())).toEqual([]);
    expect(
      validateEvidenceFinalManifest({ ...manifest(), transactionResult: 'partial' }).map(
        (i) => i.code,
      ),
    ).toContain('EVIDENCE_TRANSACTION_RESULT_UNSUPPORTED');
    expect(
      validateEvidenceFinalManifest({ ...manifest(), behaviorOutcome: 'NOPE' }).map((i) => i.code),
    ).toContain('EVIDENCE_OUTCOME_UNKNOWN');
    expect(
      validateEvidenceFinalManifest({ ...manifest(), inventoryIdentity: 'not-hex' }).map(
        (i) => i.code,
      ),
    ).toContain('EVIDENCE_DIGEST_INVALID');
    expect(
      validateEvidenceFinalManifest({
        ...manifest(),
        references: [
          {
            fromArtifactId: 'artifact:summary',
            toArtifactId: 'artifact:x',
            kind: 'nope',
            order: null,
          },
        ],
      }).map((i) => i.code),
    ).toContain('EVIDENCE_REFERENCE_KIND_UNKNOWN');
  });

  it('exposes stable closed key inventories', () => {
    expect(EVIDENCE_ARTIFACT_ENTRY_KEYS).toEqual([
      'artifactId',
      'role',
      'mediaType',
      'schema',
      'relativePath',
      'byteLength',
      'sha256',
      'semanticDigest',
      'semanticDigestKind',
      'producerPhase',
      'consumedBy',
      'sanitizationPolicy',
      'retentionStatus',
    ]);
    expect(EVIDENCE_PROVENANCE_KEYS).toContain('dirtyTreeDigest');
    expect(EVIDENCE_FINAL_MANIFEST_KEYS).toContain('inventoryIdentity');
  });
});

describe('[P8-A1] canonical Package-8 identities', () => {
  it('keeps the preimage domain- and version-separated and auditable', () => {
    const value = { a: 1, b: [2, 3] };
    const preimage = buildPackage8IdentityPreimage(PACKAGE8_IDENTITY_DOMAINS.provenance, value);
    expect(preimage).toContain('evidence-provenance');
    expect(preimage).toContain(`/v${PACKAGE8_IDENTITY_SCHEMA_VERSION}`);
    expect(package8IdentityDigest(PACKAGE8_IDENTITY_DOMAINS.provenance, value)).toBe(
      createHash('sha256').update(preimage, 'utf8').digest('hex'),
    );
  });

  it('is order-stable under object authoring order for an inventory identity', () => {
    const base = inventory();
    const reordered: EvidenceIntendedInventory = {
      createdAtUtc: base.createdAtUtc,
      artifacts: [...base.artifacts],
      sealedStrictSchemas: base.sealedStrictSchemas,
      provenance: base.provenance,
      transactionId: base.transactionId,
      transactionKind: base.transactionKind,
      label: base.label,
      schemaVersion: base.schemaVersion,
    };
    expect(deriveIntendedInventoryIdentity(reordered)).toBe(deriveIntendedInventoryIdentity(base));
  });

  it('is semantically sensitive to a declared artifact change', () => {
    const base = inventory();
    const changed = inventory({
      artifacts: [
        { ...base.artifacts[0]!, sha256: HEX('9') },
        base.artifacts[1]!,
        base.artifacts[2]!,
      ],
    });
    expect(deriveIntendedInventoryIdentity(changed)).not.toBe(
      deriveIntendedInventoryIdentity(base),
    );
  });

  it('normalizes provenance identity order but stays sensitive to a digest', () => {
    const base = provenance();
    const reversed: EvidenceProvenance = {
      ...base,
      catalogueIdentities: [
        { id: 'catalogue:z', digest: HEX('5') },
        { id: 'catalogue:readiness', digest: HEX('3') },
      ],
    };
    const normalized: EvidenceProvenance = {
      ...base,
      catalogueIdentities: [
        { id: 'catalogue:readiness', digest: HEX('3') },
        { id: 'catalogue:z', digest: HEX('5') },
      ],
    };
    expect(deriveProvenanceIdentity(reversed)).toBe(deriveProvenanceIdentity(normalized));
    expect(deriveProvenanceIdentity({ ...base, lockfileDigest: HEX('9') })).not.toBe(
      deriveProvenanceIdentity(base),
    );
  });

  it('separates domains even for identical values', () => {
    const value = { same: true };
    const digests = Object.values(PACKAGE8_IDENTITY_DOMAINS).map((domain) =>
      package8IdentityDigest(domain, value),
    );
    expect(new Set(digests).size).toBe(digests.length);
  });
});

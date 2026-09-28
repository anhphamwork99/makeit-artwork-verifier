import { describe, expect, it } from 'vitest';

import { deriveIntendedInventoryIdentity } from '../../src/canonical/package8-identity';
import {
  EVIDENCE_FINAL_MANIFEST_LABEL,
  EVIDENCE_FINAL_MANIFEST_SCHEMA_VERSION,
  EVIDENCE_INTENDED_INVENTORY_LABEL,
  EVIDENCE_INTENDED_INVENTORY_SCHEMA_VERSION,
  EVIDENCE_PROVENANCE_SCHEMA_VERSION,
  EVIDENCE_SEALED_STRICT_SCHEMAS,
  type EvidenceArtifactEntry,
  type EvidenceFinalManifest,
  type EvidenceIntendedInventory,
  type EvidenceProvenance,
  type EvidenceReference,
} from '../../src/contracts/evidence-transaction';
import { EVIDENCE_PROVENANCE_POLICY_VERSION } from '../../src/evidence/provenance';
import {
  buildInventoryReferenceEdges,
  validateInventoryManifestAgreement,
  validateReferenceGraph,
} from '../../src/evidence/reference-graph';
import { deriveSemanticDigest } from '../../src/evidence/semantic-digest';
import {
  classifyEvidenceTransaction,
  describeLegacyUnverifiable,
  EVIDENCE_TRANSACTION_FAILURE_CLASSES,
  EVIDENCE_TRANSACTION_STATES,
  evaluateFinalizationOutcomes,
  isCommitLastSequence,
  LEGACY_UNVERIFIABLE_LABEL,
  planFinalizationOrder,
  type EvidenceFinalizationOutcome,
} from '../../src/evidence/transaction';

/**
 * P8-A1 reference-graph and transaction-state validators (ADR 0041).
 *
 * Proves run/suite graph constraints (dangling/self/duplicate/cycle/order),
 * inventory↔manifest agreement, the closed transaction-state transitions
 * including the immutable partial transaction, `legacy-unverifiable`, and
 * commit-last finalization semantics.
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
    catalogueIdentities: [],
    profileIdentities: [],
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
        consumedBy: ['artifact:summary'],
        semanticDigest: deriveSemanticDigest('canonical-json', { ok: true }),
        semanticDigestKind: 'canonical-json',
      }),
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
    provenanceIdentity: HEX('e'),
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

const ref = (
  fromArtifactId: string,
  toArtifactId: string,
  kind: EvidenceReference['kind'] = 'consumes',
  order: number | null = null,
): EvidenceReference => ({ fromArtifactId, toArtifactId, kind, order });

describe('[P8-A1] reference graph validators', () => {
  it('derives canonically sorted inventory reference edges', () => {
    const edges = buildInventoryReferenceEdges(inventory());
    expect(edges).toEqual([ref('artifact:summary', 'artifact:doctor-json')]);
  });

  it('accepts a valid run graph and rejects dangling/self/duplicate/cycle edges', () => {
    const base = inventory();
    const artifacts = base.artifacts;
    expect(
      validateReferenceGraph({
        artifacts,
        references: [ref('artifact:summary', 'artifact:doctor-json')],
        transactionKind: 'run',
      }),
    ).toEqual([]);
    expect(
      validateReferenceGraph({
        artifacts,
        references: [ref('artifact:summary', 'artifact:missing')],
        transactionKind: 'run',
      }).map((i) => i.code),
    ).toContain('REFERENCE_DANGLING');
    expect(
      validateReferenceGraph({
        artifacts,
        references: [ref('artifact:summary', 'artifact:summary')],
        transactionKind: 'run',
      }).map((i) => i.code),
    ).toContain('REFERENCE_SELF');
    expect(
      validateReferenceGraph({
        artifacts,
        references: [
          ref('artifact:summary', 'artifact:doctor-json'),
          ref('artifact:summary', 'artifact:doctor-json'),
        ],
        transactionKind: 'run',
      }).map((i) => i.code),
    ).toContain('REFERENCE_DUPLICATE');
    expect(
      validateReferenceGraph({
        artifacts,
        references: [
          ref('artifact:summary', 'artifact:doctor-json'),
          ref('artifact:doctor-json', 'artifact:summary'),
        ],
        transactionKind: 'run',
      }).map((i) => i.code),
    ).toContain('REFERENCE_CYCLE');
    expect(
      validateReferenceGraph({
        artifacts,
        references: [ref('artifact:summary', 'artifact:doctor-json', 'child-manifest')],
        transactionKind: 'run',
      }).map((i) => i.code),
    ).toContain('REFERENCE_KIND_MISMATCH');
  });

  it('enforces canonical child-manifest order for suites', () => {
    const artifacts = [artifact('artifact:child-1'), artifact('artifact:child-2')];
    expect(
      validateReferenceGraph({
        artifacts,
        references: [
          ref('artifact:child-1', 'artifact:child-2', 'child-manifest', 1),
          ref('artifact:child-1', 'artifact:child-2', 'child-manifest', 2),
        ],
        transactionKind: 'suite',
      }).map((i) => i.code),
    ).toContain('REFERENCE_DUPLICATE');
    expect(
      validateReferenceGraph({
        artifacts,
        references: [ref('artifact:child-1', 'artifact:child-2', 'child-manifest', 2)],
        transactionKind: 'suite',
      }).map((i) => i.code),
    ).toContain('REFERENCE_ORDER_INVALID');
    expect(
      validateReferenceGraph({
        artifacts,
        references: [ref('artifact:child-1', 'artifact:child-2', 'consumes', null)],
        transactionKind: 'suite',
      }).map((i) => i.code),
    ).toContain('REFERENCE_KIND_MISMATCH');
  });

  it('validates inventory/manifest agreement', () => {
    const base = inventory();
    const good = manifest(base);
    expect(
      validateInventoryManifestAgreement(base, good, {
        derivedInventoryIdentity: good.inventoryIdentity,
      }),
    ).toEqual([]);
    const missingRequired = manifest(base, {
      committedArtifacts: good.committedArtifacts.filter(
        (a) => a.artifactId !== 'artifact:doctor-json',
      ),
    });
    expect(validateInventoryManifestAgreement(base, missingRequired).map((i) => i.code)).toContain(
      'REFERENCE_REQUIRED_MISSING',
    );
    const changedDigest = manifest(base, {
      committedArtifacts: good.committedArtifacts.map((a) =>
        a.artifactId === 'artifact:doctor-json' ? { ...a, sha256: HEX('9') } : a,
      ),
    });
    expect(validateInventoryManifestAgreement(base, changedDigest).map((i) => i.code)).toContain(
      'REFERENCE_REQUIRED_MISMATCH',
    );
    const changedDiagnostic = manifest(base, {
      committedArtifacts: good.committedArtifacts.map((a) =>
        a.artifactId === 'artifact:summary' ? { ...a, byteLength: a.byteLength + 1 } : a,
      ),
    });
    expect(
      validateInventoryManifestAgreement(base, changedDiagnostic).map((i) => i.code),
    ).toContain('REFERENCE_INVENTORY_MISMATCH');
    const unknown = manifest(base, {
      committedArtifacts: [
        ...good.committedArtifacts,
        {
          artifactId: 'artifact:x',
          relativePath: 'x.json',
          byteLength: 1,
          sha256: HEX('8'),
          semanticDigest: null,
        },
      ],
    });
    expect(validateInventoryManifestAgreement(base, unknown).map((i) => i.code)).toContain(
      'REFERENCE_UNKNOWN_ARTIFACT',
    );
    const omittedEdge = manifest(base, { references: [] });
    expect(validateInventoryManifestAgreement(base, omittedEdge).map((i) => i.code)).toContain(
      'REFERENCE_INVENTORY_MISMATCH',
    );
    const extraEdge = manifest(base, {
      references: [...good.references, ref('artifact:doctor-json', 'artifact:summary', 'derives')],
    });
    expect(validateInventoryManifestAgreement(base, extraEdge).map((i) => i.code)).toContain(
      'REFERENCE_INVENTORY_MISMATCH',
    );
    expect(
      validateInventoryManifestAgreement(base, good, { derivedInventoryIdentity: HEX('0') }).map(
        (i) => i.code,
      ),
    ).toContain('REFERENCE_INVENTORY_MISMATCH');
    expect(
      validateInventoryManifestAgreement(base, manifest(base, { transactionId: 'run-2' })).map(
        (i) => i.code,
      ),
    ).toContain('REFERENCE_TRANSACTION_MISMATCH');
  });
});

describe('[P8-A1] transaction-state classification', () => {
  const all = {
    intendedInventoryPresent: true,
    intendedInventoryValid: true,
    finalManifestPresent: true,
    finalManifestValid: true,
    referencesValid: true,
    strictRecordPresent: false,
    externalFailure: false,
  };

  it('declares closed states and only two failure classes', () => {
    expect(new Set(EVIDENCE_TRANSACTION_STATES).size).toBe(EVIDENCE_TRANSACTION_STATES.length);
    expect(EVIDENCE_TRANSACTION_FAILURE_CLASSES).toEqual([
      'HARNESS_BLOCKED',
      'ENVIRONMENT_FAILURE',
    ]);
  });

  it('commits only the fully valid transaction', () => {
    const committed = classifyEvidenceTransaction(all);
    expect(committed.state).toBe('committed');
    expect(committed.committed).toBe(true);
    expect(committed.creditEligible).toBe(true);
  });

  it('preserves an immutable partial transaction with no credit', () => {
    const partial = classifyEvidenceTransaction({ ...all, finalManifestPresent: false });
    expect(partial.state).toBe('partial-transaction');
    expect(partial.committed).toBe(false);
    expect(partial.creditEligible).toBe(false);
    expect(partial.immutablePartial).toBe(true);
    expect(partial.failureClass).toBeNull();
    const external = classifyEvidenceTransaction({
      ...all,
      finalManifestPresent: false,
      externalFailure: true,
    });
    expect(external.failureClass).toBe('ENVIRONMENT_FAILURE');
  });

  it('classifies every contract/reference invalidity as HARNESS_BLOCKED', () => {
    expect(classifyEvidenceTransaction({ ...all, intendedInventoryValid: false })).toMatchObject({
      state: 'invalid-transaction',
      failureClass: 'HARNESS_BLOCKED',
      failureCode: 'TRANSACTION_INVENTORY_INVALID',
    });
    expect(classifyEvidenceTransaction({ ...all, finalManifestValid: false })).toMatchObject({
      failureClass: 'HARNESS_BLOCKED',
      failureCode: 'TRANSACTION_MANIFEST_INVALID',
    });
    expect(classifyEvidenceTransaction({ ...all, referencesValid: false })).toMatchObject({
      failureClass: 'HARNESS_BLOCKED',
      failureCode: 'TRANSACTION_REFERENCES_INVALID',
    });
    expect(classifyEvidenceTransaction({ ...all, intendedInventoryPresent: false })).toMatchObject({
      state: 'invalid-transaction',
      failureCode: 'TRANSACTION_MANIFEST_WITHOUT_INVENTORY',
    });
  });

  it('represents a manifest-less strict record as legacy-unverifiable', () => {
    const legacy = classifyEvidenceTransaction({
      ...all,
      intendedInventoryPresent: false,
      finalManifestPresent: false,
      strictRecordPresent: true,
    });
    expect(legacy.state).toBe('legacy-unverifiable');
    expect(legacy.creditEligible).toBe(false);
    expect(legacy.preservedForDiagnosis).toBe(true);
    expect(describeLegacyUnverifiable('run')).toMatchObject({
      label: LEGACY_UNVERIFIABLE_LABEL,
      immutable: true,
      creditEligible: false,
      package8ManifestPresent: false,
    });
    expect(
      classifyEvidenceTransaction({
        ...all,
        intendedInventoryPresent: false,
        finalManifestPresent: false,
        strictRecordPresent: false,
      }).state,
    ).toBe('no-transaction');
  });
});

describe('[P8-A1] commit-last finalization', () => {
  it('plans the final manifest strictly last', () => {
    const plan = planFinalizationOrder([
      { kind: 'intended-inventory', relativePath: 'intended-inventory.json' },
      { kind: 'artifact', relativePath: 'files/a.json' },
      { kind: 'final-manifest', relativePath: 'final-manifest.json' },
    ]);
    expect(plan[plan.length - 1]?.kind).toBe('final-manifest');
    expect(isCommitLastSequence(plan)).toBe(true);
  });

  it('refuses a plan whose manifest is not last or is not unique', () => {
    expect(() =>
      planFinalizationOrder([
        { kind: 'final-manifest', relativePath: 'final-manifest.json' },
        { kind: 'artifact', relativePath: 'files/a.json' },
      ]),
    ).toThrow();
    expect(() =>
      planFinalizationOrder([
        { kind: 'intended-inventory', relativePath: 'intended-inventory.json' },
        { kind: 'final-manifest', relativePath: 'a.json' },
        { kind: 'final-manifest', relativePath: 'b.json' },
      ]),
    ).toThrow();
  });

  it('reaches the commit point only when every earlier step succeeded', () => {
    const ok = evaluateFinalizationOutcomes([
      { kind: 'intended-inventory', relativePath: 'i.json', result: 'ok' },
      { kind: 'artifact', relativePath: 'a.json', result: 'ok' },
      { kind: 'final-manifest', relativePath: 'm.json', result: 'ok' },
    ]);
    expect(ok.commitPointReached).toBe(true);

    const failedArtifact: readonly EvidenceFinalizationOutcome[] = [
      { kind: 'intended-inventory', relativePath: 'i.json', result: 'ok' },
      {
        kind: 'artifact',
        relativePath: 'a.json',
        result: 'failed',
        failureClass: 'ENVIRONMENT_FAILURE',
      },
    ];
    const noManifest = evaluateFinalizationOutcomes(failedArtifact);
    expect(noManifest.commitPointReached).toBe(false);
    expect(noManifest.failedStepIndex).toBe(1);
    expect(noManifest.failureClass).toBe('ENVIRONMENT_FAILURE');

    const orderedViolation = evaluateFinalizationOutcomes([
      { kind: 'final-manifest', relativePath: 'm.json', result: 'ok' },
      { kind: 'intended-inventory', relativePath: 'i.json', result: 'ok' },
    ]);
    expect(orderedViolation.commitPointReached).toBe(false);
    expect(orderedViolation.failureCode).toBe('TRANSACTION_COMMIT_ORDER_VIOLATION');
  });
});

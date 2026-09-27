import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  deriveIntendedInventoryIdentity,
  deriveProvenanceIdentity,
} from '../../src/canonical/package8-identity';
import {
  EVIDENCE_FINAL_MANIFEST_FILE_NAME,
  EVIDENCE_FINAL_MANIFEST_LABEL,
  EVIDENCE_FINAL_MANIFEST_SCHEMA_VERSION,
  EVIDENCE_INTENDED_INVENTORY_FILE_NAME,
  EVIDENCE_INTENDED_INVENTORY_LABEL,
  EVIDENCE_INTENDED_INVENTORY_SCHEMA_VERSION,
  EVIDENCE_PROVENANCE_SCHEMA_VERSION,
  EVIDENCE_SEALED_STRICT_SCHEMAS,
  type EvidenceArtifactEntry,
  type EvidenceFinalManifest,
  type EvidenceIntendedInventory,
  type EvidenceProvenance,
} from '../../src/contracts/evidence-transaction';
import { EVIDENCE_PROVENANCE_POLICY_VERSION } from '../../src/evidence/provenance';
import {
  EvidencePublicationError,
  executeEvidencePublication,
  planEvidencePublication,
  type PublicationIo,
  type ValidatedEvidencePublicationPlan,
} from '../../src/evidence/publication';
import { buildInventoryReferenceEdges } from '../../src/evidence/reference-graph';
import {
  inspectSanitizationApproval,
  sanitizeArtifactBytes,
  snapshotSanitizationApproval,
  type SanitizedArtifactApproval,
} from '../../src/evidence/sanitize';
import {
  RunRecordExistsError,
  writeExclusiveExactBytes,
  writeExclusiveRecordFile,
} from '../../src/evidence/writer';

/** ADR 0042 hostile proof for the dormant opaque publication boundary. */

const HEX = (character: string): string => character.repeat(64);
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'p8a-publication-'));
  tempRoots.push(root);
  return root;
}

function provenance(): EvidenceProvenance {
  return {
    schemaVersion: EVIDENCE_PROVENANCE_SCHEMA_VERSION,
    policyVersion: EVIDENCE_PROVENANCE_POLICY_VERSION,
    repositoryRevision: 'a'.repeat(40),
    dirtyPolicy: 'clean',
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

interface Fixture {
  readonly root: string;
  readonly approval: SanitizedArtifactApproval;
  readonly artifact: EvidenceArtifactEntry;
  readonly inventory: EvidenceIntendedInventory;
  readonly manifest: EvidenceFinalManifest;
}

function fixture(
  options: {
    root?: string;
    bytes?: string | Uint8Array;
    artifactId?: string;
    relativePath?: string;
    policy?: 'public-json-guard-v1' | 'opaque-bytes-guard-v1';
  } = {},
): Fixture {
  const root = options.root ?? tempRoot();
  const artifactId = options.artifactId ?? 'artifact:doctor-json';
  const relativePath = options.relativePath ?? 'files/doctor.json';
  const bytes = options.bytes ?? JSON.stringify({ outcome: 'PASS' });
  const policy = options.policy ?? 'public-json-guard-v1';
  const approval = sanitizeArtifactBytes({
    artifactId,
    relativePath,
    role: 'diagnostic-only',
    policy,
    bytes,
  });
  const view = inspectSanitizationApproval(approval);
  if (view.sha256 === null) throw new Error('fixture approval unexpectedly omitted');
  const artifact: EvidenceArtifactEntry = {
    artifactId,
    role: 'diagnostic-only',
    mediaType: policy === 'public-json-guard-v1' ? 'application/json' : 'application/octet-stream',
    schema: 'schema.v1',
    relativePath,
    byteLength: view.byteLength,
    sha256: view.sha256,
    semanticDigest: view.semanticDigest,
    semanticDigestKind: view.semanticDigestKind,
    producerPhase: 'observation',
    consumedBy: [],
    sanitizationPolicy: policy,
    retentionStatus: 'required-preserve',
  };
  const inventory: EvidenceIntendedInventory = {
    schemaVersion: EVIDENCE_INTENDED_INVENTORY_SCHEMA_VERSION,
    label: EVIDENCE_INTENDED_INVENTORY_LABEL,
    transactionKind: 'run',
    transactionId: 'run-1',
    provenance: provenance(),
    sealedStrictSchemas: EVIDENCE_SEALED_STRICT_SCHEMAS,
    artifacts: [artifact],
    createdAtUtc: '2026-09-21T00:00:00.000Z',
  };
  const manifest: EvidenceFinalManifest = {
    schemaVersion: EVIDENCE_FINAL_MANIFEST_SCHEMA_VERSION,
    label: EVIDENCE_FINAL_MANIFEST_LABEL,
    transactionKind: inventory.transactionKind,
    transactionId: inventory.transactionId,
    inventoryIdentity: deriveIntendedInventoryIdentity(inventory),
    provenanceIdentity: deriveProvenanceIdentity(inventory.provenance),
    sealedStrictSchemas: EVIDENCE_SEALED_STRICT_SCHEMAS,
    behaviorOutcome: 'PASS',
    transactionResult: 'committed',
    committedArtifacts: [
      {
        artifactId,
        relativePath,
        byteLength: artifact.byteLength,
        sha256: artifact.sha256,
        semanticDigest: artifact.semanticDigest,
      },
    ],
    references: buildInventoryReferenceEdges(inventory),
    committedAtUtc: '2026-09-21T00:00:01.000Z',
  };
  return { root, approval, artifact, inventory, manifest };
}

function planFor(value: Fixture): ValidatedEvidencePublicationPlan {
  return planEvidencePublication({
    evidenceRoot: value.root,
    inventory: value.inventory,
    manifest: value.manifest,
    artifacts: [
      {
        artifactId: value.artifact.artifactId,
        relativePath: value.artifact.relativePath,
        approval: value.approval,
      },
    ],
  });
}

function recordingIo(calls: string[]): PublicationIo {
  return {
    writeExclusiveBytes(target) {
      calls.push(target);
    },
  };
}

describe('[P8-A1 ADR 0042] additive exact-byte writer', () => {
  it('keeps exact-byte and legacy record writer behavior exclusive', () => {
    const root = tempRoot();
    const exact = path.join(root, 'exact.bin');
    writeExclusiveExactBytes(exact, new Uint8Array([0xff, 0x00, 0x80]));
    expect([...readFileSync(exact)]).toEqual([0xff, 0x00, 0x80]);
    expect(() => writeExclusiveExactBytes(exact, 'changed')).toThrow(RunRecordExistsError);

    const record = path.join(root, 'record.json');
    writeExclusiveRecordFile(record, '{"a":1}');
    expect(readFileSync(record, 'utf8')).toBe('{"a":1}\n');
    expect(() => writeExclusiveRecordFile(record, '{}')).toThrow(RunRecordExistsError);
  });
});

describe('[P8-A1 ADR 0042] opaque validated plan', () => {
  it('returns a frozen data-free handle and publishes inventory, exact artifact, then manifest', () => {
    const value = fixture();
    const plan = planFor(value);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Reflect.ownKeys(plan)).toEqual([]);

    const execution = executeEvidencePublication(plan);
    expect(execution.manifestCommitted).toBe(true);
    expect(execution.records.map((record) => record.relativePath)).toEqual([
      EVIDENCE_INTENDED_INVENTORY_FILE_NAME,
      value.artifact.relativePath,
      EVIDENCE_FINAL_MANIFEST_FILE_NAME,
    ]);
    expect(readFileSync(path.join(value.root, value.artifact.relativePath), 'utf8')).toBe(
      JSON.stringify({ outcome: 'PASS' }),
    );
  });

  it('snapshots opaque bytes across caller mutation after approval and planning', () => {
    const source = new Uint8Array([0xff, 0xfe, 0x00, 0x80]);
    const value = fixture({
      bytes: source,
      relativePath: 'files/opaque.bin',
      policy: 'opaque-bytes-guard-v1',
    });
    source.fill(0);
    const plan = planFor(value);
    const exposedCopy = snapshotSanitizationApproval(value.approval);
    exposedCopy.bytes?.fill(1);
    executeEvidencePublication(plan);
    expect([...readFileSync(path.join(value.root, value.artifact.relativePath))]).toEqual([
      0xff, 0xfe, 0x00, 0x80,
    ]);
  });

  it('preserves a partial transaction and never writes the manifest after artifact I/O failure', () => {
    const value = fixture();
    const calls: string[] = [];
    const io: PublicationIo = {
      writeExclusiveBytes(target, bytes) {
        calls.push(path.basename(target));
        if (target.includes('files/')) throw new Error('injected artifact failure');
        writeFileSync(target, bytes);
      },
    };
    const result = executeEvidencePublication(planFor(value), io);
    expect(result.manifestCommitted).toBe(false);
    expect(result.evaluation.failureClass).toBe('HARNESS_BLOCKED');
    expect(calls).not.toContain(EVIDENCE_FINAL_MANIFEST_FILE_NAME);
    expect(existsSync(path.join(value.root, EVIDENCE_FINAL_MANIFEST_FILE_NAME))).toBe(false);
  });

  it('detects hostile I/O mutation of an outbound byte copy and refuses to commit', () => {
    const approved = new Uint8Array([1, 2, 3]);
    const value = fixture({
      bytes: approved,
      relativePath: 'files/opaque.bin',
      policy: 'opaque-bytes-guard-v1',
    });
    const result = executeEvidencePublication(planFor(value), {
      writeExclusiveBytes(target, bytes) {
        if (typeof bytes !== 'string') bytes.fill(9);
        writeFileSync(target, bytes);
      },
    });
    expect(result.manifestCommitted).toBe(false);
    expect(result.evaluation.failureClass).toBe('HARNESS_BLOCKED');
    expect(existsSync(path.join(value.root, EVIDENCE_FINAL_MANIFEST_FILE_NAME))).toBe(false);
    expect([...(snapshotSanitizationApproval(value.approval).bytes ?? [])]).toEqual([1, 2, 3]);
  });

  it('classifies an existing exclusive target as HARNESS_BLOCKED without overwrite', () => {
    const value = fixture();
    writeFileSync(path.join(value.root, EVIDENCE_FINAL_MANIFEST_FILE_NAME), 'pre-existing');
    const result = executeEvidencePublication(planFor(value));
    expect(result.manifestCommitted).toBe(false);
    expect(result.evaluation.failureClass).toBe('HARNESS_BLOCKED');
    expect(readFileSync(path.join(value.root, EVIDENCE_FINAL_MANIFEST_FILE_NAME), 'utf8')).toBe(
      'pre-existing',
    );
  });
});

describe('[P8-A1 ADR 0042] hostile preflight and runtime forgery', () => {
  it('rejects malformed inventory and manifest documents before filesystem I/O', () => {
    const value = fixture();
    expect(() =>
      planEvidencePublication({
        evidenceRoot: value.root,
        inventory: {} as EvidenceIntendedInventory,
        manifest: value.manifest,
        artifacts: [],
      }),
    ).toThrow(EvidencePublicationError);
    expect(() =>
      planEvidencePublication({
        evidenceRoot: value.root,
        inventory: value.inventory,
        manifest: {} as EvidenceFinalManifest,
        artifacts: [],
      }),
    ).toThrow(EvidencePublicationError);
    expect(readdirSync(value.root)).toEqual([]);
  });

  it('rejects wrong versions, kinds, and nested unknown keys before filesystem I/O', () => {
    const value = fixture();
    const cases: readonly [EvidenceIntendedInventory, EvidenceFinalManifest][] = [
      [{ ...value.inventory, schemaVersion: 2 }, value.manifest],
      [value.inventory, { ...value.manifest, transactionKind: 'suite' }],
      [
        {
          ...value.inventory,
          sealedStrictSchemas: { ...EVIDENCE_SEALED_STRICT_SCHEMAS, extra: 1 },
        } as EvidenceIntendedInventory,
        value.manifest,
      ],
    ];
    for (const [inventory, manifest] of cases) {
      expect(() =>
        planEvidencePublication({
          evidenceRoot: value.root,
          inventory,
          manifest,
          artifacts: [],
        }),
      ).toThrow(EvidencePublicationError);
    }
    expect(readdirSync(value.root)).toEqual([]);
  });

  it('rejects raw, cast, same-prototype, spread, cloned, and reflected-copy handles with zero I/O', () => {
    const value = fixture();
    const valid = planFor(value);
    const reflected = Object.create(Object.getPrototypeOf(valid)) as Record<PropertyKey, unknown>;
    for (const key of Reflect.ownKeys(valid)) reflected[key] = Reflect.get(valid, key);
    const candidates: unknown[] = [
      [],
      {},
      Object.create(Object.getPrototypeOf(valid)),
      { ...(valid as object) },
      structuredClone(valid),
      reflected,
    ];
    for (const candidate of candidates) {
      const calls: string[] = [];
      expect(() =>
        executeEvidencePublication(
          candidate as ValidatedEvidencePublicationPlan,
          recordingIo(calls),
        ),
      ).toThrow(EvidencePublicationError);
      expect(calls).toEqual([]);
    }
  });

  it('rejects forged approval handles, raw bytes, and artifact identity/path substitution', () => {
    const value = fixture();
    const forged = Object.freeze(Object.create(null)) as SanitizedArtifactApproval;
    const attempts = [
      {
        artifactId: value.artifact.artifactId,
        relativePath: value.artifact.relativePath,
        approval: forged,
      },
      {
        artifactId: 'artifact:other',
        relativePath: value.artifact.relativePath,
        approval: value.approval,
      },
      {
        artifactId: value.artifact.artifactId,
        relativePath: 'files/other.json',
        approval: value.approval,
      },
      {
        artifactId: value.artifact.artifactId,
        relativePath: value.artifact.relativePath,
        approval: { bytes: '{}' } as unknown as SanitizedArtifactApproval,
      },
    ];
    for (const artifact of attempts) {
      expect(() =>
        planEvidencePublication({
          evidenceRoot: value.root,
          inventory: value.inventory,
          manifest: value.manifest,
          artifacts: [artifact],
        }),
      ).toThrow(EvidencePublicationError);
    }
    expect(readdirSync(value.root)).toEqual([]);
  });

  it('rejects digest, length, semantic, and reference disagreements', () => {
    const value = fixture();
    const attempts: EvidencePublicationPlanInputLike[] = [
      { inventory: { ...value.inventory, artifacts: [{ ...value.artifact, sha256: HEX('9') }] } },
      {
        manifest: {
          ...value.manifest,
          committedArtifacts: value.manifest.committedArtifacts.map((entry) => ({
            ...entry,
            byteLength: entry.byteLength + 1,
          })),
        },
      },
      {
        manifest: {
          ...value.manifest,
          references: [
            {
              fromArtifactId: value.artifact.artifactId,
              toArtifactId: value.artifact.artifactId,
              kind: 'derives',
              order: null,
            },
          ],
        },
      },
    ];
    for (const attempt of attempts) {
      expect(() =>
        planEvidencePublication({
          evidenceRoot: value.root,
          inventory: attempt.inventory ?? value.inventory,
          manifest: attempt.manifest ?? value.manifest,
          artifacts: [
            {
              artifactId: value.artifact.artifactId,
              relativePath: value.artifact.relativePath,
              approval: value.approval,
            },
          ],
        }),
      ).toThrow(EvidencePublicationError);
    }
    expect(readdirSync(value.root)).toEqual([]);
  });

  it('rejects missing, extra, duplicate, omitted, and reserved-path artifacts', () => {
    const value = fixture();
    const omitted = sanitizeArtifactBytes({
      artifactId: value.artifact.artifactId,
      relativePath: value.artifact.relativePath,
      role: 'diagnostic-only',
      policy: 'public-json-guard-v1',
      bytes: JSON.stringify({ leak: '/Users/secret/x' }),
    });
    const base = {
      evidenceRoot: value.root,
      inventory: value.inventory,
      manifest: value.manifest,
    };
    expect(() => planEvidencePublication({ ...base, artifacts: [] })).toThrow(
      EvidencePublicationError,
    );
    expect(() =>
      planEvidencePublication({
        ...base,
        artifacts: [
          {
            artifactId: value.artifact.artifactId,
            relativePath: value.artifact.relativePath,
            approval: value.approval,
          },
          {
            artifactId: 'artifact:extra',
            relativePath: 'files/extra.json',
            approval: value.approval,
          },
        ],
      }),
    ).toThrow(EvidencePublicationError);
    expect(() =>
      planEvidencePublication({
        ...base,
        artifacts: [
          {
            artifactId: value.artifact.artifactId,
            relativePath: value.artifact.relativePath,
            approval: value.approval,
          },
          {
            artifactId: value.artifact.artifactId,
            relativePath: value.artifact.relativePath,
            approval: value.approval,
          },
        ],
      }),
    ).toThrow(EvidencePublicationError);
    expect(() =>
      planEvidencePublication({
        ...base,
        artifacts: [
          {
            artifactId: value.artifact.artifactId,
            relativePath: value.artifact.relativePath,
            approval: omitted,
          },
        ],
      }),
    ).toThrow(EvidencePublicationError);
    const reserved = fixture({
      root: value.root,
      relativePath: EVIDENCE_INTENDED_INVENTORY_FILE_NAME,
    });
    expect(() => planFor(reserved)).toThrow(EvidencePublicationError);
    expect(readdirSync(value.root)).toEqual([]);
  });
});

interface EvidencePublicationPlanInputLike {
  readonly inventory?: EvidenceIntendedInventory;
  readonly manifest?: EvidenceFinalManifest;
}

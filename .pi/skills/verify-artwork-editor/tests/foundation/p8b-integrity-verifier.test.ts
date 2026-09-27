import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ADVISORY_VERIFIER_CODES,
  ARTIFACT_LENGTH_DETAIL_CODE,
  ARTIFACT_SEMANTIC_DIGEST_DETAIL_CODE,
  ARTIFACT_SHA256_DETAIL_CODE,
  EVIDENCE_AUXILIARY_FAILURE_PROJECTION,
  EVIDENCE_CONTRACT_ISSUE_PROJECTION,
  EVIDENCE_CONTRACT_ISSUE_SOURCE_CODES,
  EVIDENCE_REFERENCE_FAILURE_PROJECTION,
  EVIDENCE_REFERENCE_FAILURE_SOURCE_CODES,
  EVIDENCE_SEMANTIC_DIGEST_FAILURE_SOURCE_CODES,
  EVIDENCE_SANITIZATION_FAILURE_SOURCE_CODES,
  EVIDENCE_PROVENANCE_FAILURE_SOURCE_CODES,
  EVIDENCE_REDACTION_FAILURE_SOURCE_CODES,
  EVIDENCE_VERIFY_CURRENT_TREE_CHECKS,
  EVIDENCE_VERIFY_DETAIL_CODES,
  EVIDENCE_VERIFY_DETAILS_ISSUE_CODES,
  EVIDENCE_VERIFY_DIAGNOSTIC_KEYS,
  EVIDENCE_VERIFY_REPORT_LABEL,
  EVIDENCE_VERIFY_SCHEMA_VERSION,
  EVIDENCE_VERIFY_SOURCE_PROJECTION,
  EVIDENCE_VERIFY_CODES,
  EVIDENCE_VERIFY_FINDING_CLASS_RANKS,
  ENVIRONMENT_FAILURE_VERIFIER_CODES,
  EvidenceVerifyContractError,
  FIXED_INSPECTION_DETAIL_CODES,
  FINAL_RECORD_ISSUE_PROJECTION,
  FINAL_RECORD_ASSEMBLY_ISSUE_SOURCE_CODES,
  FINAL_SUITE_RECORD_ISSUE_PROJECTION,
  FINAL_SUITE_RECORD_ISSUE_SOURCE_CODES,
  PRIMARY_BLOCKING_VERIFIER_CODES,
  RESULT_CONTRACT_ISSUE_SOURCE_CODES,
  canonicalRunSubjectOrdinals,
  canonicalSuiteSubjectOrdinals,
  canonicalizeEvidenceVerifyDetails,
  defaultVerifierFindingClass,
  isAdvisoryVerifierCode,
  isEvidenceVerifyDetailCode,
  isEvidenceVerifyRootRelativePath,
  parseEvidenceVerifyArguments,
  parseEvidenceVerifyDetails,
  primaryPrecedenceIndex,
  projectSourceIssue,
  selectPrimaryVerifierFinding,
  validateEvidenceVerifyDetails,
  type EvidenceVerifyDetails,
  type EvidenceVerifyPrimaryFinding,
} from '../../src/contracts/evidence-verify';
import {
  EVIDENCE_ARTIFACT_ENTRY_KEYS,
  EVIDENCE_CONTRACT_ISSUE_CODES,
  EVIDENCE_FINAL_MANIFEST_KEYS,
  EVIDENCE_INTENDED_INVENTORY_KEYS,
  EVIDENCE_SEALED_STRICT_SCHEMAS,
  validateEvidenceFinalManifest,
  validateEvidenceIntendedInventory,
} from '../../src/contracts/evidence-transaction';
import {
  EVIDENCE_REFERENCE_FAILURE_CODES,
  validateInventoryManifestAgreement,
} from '../../src/evidence/reference-graph';
import {
  FINAL_CURRENT_CHILD_RECORD_SCHEMA_VERSION,
  FINAL_RECORD_ASSEMBLY_ISSUE_CODES,
} from '../../src/contracts/final-record-v4';
import { RESULT_CONTRACT_ISSUE_CODES } from '../../src/contracts/result-agreement';
import {
  FINAL_PUBLIC_RUN_RECORD_KEYS,
  assembleFinalPublicCommandRecordV4,
  readFinalPublicRecord,
} from '../../src/contracts/final-public-record';
import {
  FINAL_SUITE_RECORD_ISSUE_CODES,
  FINAL_SUITE_RECORD_KEYS,
  FINAL_SUITE_RECORD_SCHEMA_VERSION,
  readFinalSuiteRecord,
} from '../../src/contracts/final-suite-record';
import {
  EVIDENCE_SEMANTIC_DIGEST_FAILURE_CODES,
  deriveSemanticDigest,
} from '../../src/evidence/semantic-digest';
import {
  EVIDENCE_PROHIBITED_BYTES_API_VERSION,
  EVIDENCE_PROHIBITED_BYTES_CODES,
  EVIDENCE_SANITIZATION_FAILURE_CODES,
  inspectProhibitedBytes,
  sanitizeArtifactBytes,
  inspectSanitizationApproval,
  type InspectProhibitedBytesInput,
} from '../../src/evidence/sanitize';
import { PROVENANCE_POLICY_FAILURE_CODES } from '../../src/evidence/provenance';
import { REDACTION_FAILURE_CODES } from '../../src/evidence/guard';
import {
  DOCTOR_COMMAND_CHECKS,
  DOCTOR_COMMAND_REQUIRED_EVIDENCE,
  DOCTOR_COMMAND_STATUS_AUTHORITY,
} from '../../src/index';
import { executeDoctorCommandContext } from '../../src/orchestration/doctor-command-execution';
import * as sanitizeModule from '../../src/evidence/sanitize';
import { deriveIntendedInventoryIdentity } from '../../src/canonical/package8-identity';
import {
  EVIDENCE_VERIFY_MAX_ENUMERATED_ENTRIES,
  EVIDENCE_VERIFY_MAX_TRAVERSAL_DEPTH,
  EvidenceVerifyExternalFsError,
  EvidenceVerifyNoFollowUnsupportedError,
  EvidenceVerifyRequestError,
  createNodeEvidenceVerifyFsAdapter,
  detectNodeNoFollowCapability,
  verifyEvidenceRoot,
  type EvidenceVerifyEnvironment,
} from '../../src/evidence/integrity';

/**
 * P8-B WP-B0 — contract, precedence, sanitizer-inspection, and immutable-fixture
 * foundation proof (ADR 0048; plan `p8b-integrity-verifier.md` §7.2/§7.3/§13).
 *
 * This foundation test proves the closed `evidence-verify.v1` contract, the
 * complete source-union projection tables (57 run/public + 18 suite reader
 * issues plus every validator family), the 40/2/38 verifier-code partition and
 * canonical blocking precedence, deterministic subject ordinals and primary
 * selection, the pure read-only `inspectProhibitedBytes` boundary, the
 * duplicate/unknown-argument rejection contract, strict-schema no-delta, and the
 * five-file fixture boundary with byte-stable immutability.
 *
 * It is read-only: it never writes a fixture or an evidence path.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const toolkitRoot = path.resolve(here, '../..');
const fixtureRoot = path.resolve(here, '../integration/fixtures/p8b');
const repoRoot = path.resolve(toolkitRoot, '../../..');

const FIXTURE_FILES = [
  'committed-run/intended-inventory.json',
  'committed-run/final-manifest.json',
  'committed-run/run-record.json',
  'legacy-run/run-record.json',
  'committed-suite/suite-record.json',
] as const;

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function readJson(relative: string): unknown {
  return JSON.parse(readFileSync(path.join(fixtureRoot, relative), 'utf8')) as unknown;
}

function readSource(relative: string): string {
  return readFileSync(path.resolve(repoRoot, relative), 'utf8');
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

function pngWithChunk(type: 'IDAT' | 'tEXt', payload: string): Uint8Array {
  const data = new TextEncoder().encode(payload);
  const chunk = new Uint8Array(12 + data.byteLength);
  new DataView(chunk.buffer).setUint32(0, data.byteLength);
  chunk.set(new TextEncoder().encode(type), 4);
  chunk.set(data, 8);
  const iend = new Uint8Array([0, 0, 0, 0, 73, 69, 78, 68, 0, 0, 0, 0]);
  const result = new Uint8Array(8 + chunk.byteLength + iend.byteLength);
  result.set([137, 80, 78, 71, 13, 10, 26, 10]);
  result.set(chunk, 8);
  result.set(iend, 8 + chunk.byteLength);
  return result;
}

const PNG_SIGNATURE_BYTES = [137, 80, 78, 71, 13, 10, 26, 10] as const;

/** A deliberately framed PNG chunk. CRCs are zero-filled: the inspection
 * boundary validates structural framing, not CRC values. */
function buildPngChunk(
  type: string,
  data: Uint8Array,
  declaredLength = data.byteLength,
): Uint8Array {
  const chunk = new Uint8Array(12 + data.byteLength);
  new DataView(chunk.buffer).setUint32(0, declaredLength);
  chunk.set(new TextEncoder().encode(type), 4);
  chunk.set(data, 8);
  return chunk;
}

function buildPng(
  chunks: readonly Uint8Array[],
  trailingBytes: readonly number[] = [],
): Uint8Array {
  const body = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(PNG_SIGNATURE_BYTES.length + body + trailingBytes.length);
  out.set(PNG_SIGNATURE_BYTES, 0);
  let offset: number = PNG_SIGNATURE_BYTES.length;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  out.set(trailingBytes, offset);
  return out;
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function inspectPngBytes(bytes: Uint8Array) {
  return inspectProhibitedBytes({
    apiVersion: EVIDENCE_PROHIBITED_BYTES_API_VERSION,
    bytes,
    mediaType: 'image/png',
    format: 'png',
    forbiddenRoots: [],
  });
}

function cloneFixture(relative: string): Record<string, unknown> {
  return JSON.parse(JSON.stringify(readJson(relative))) as Record<string, unknown>;
}

function validDetails(): EvidenceVerifyDetails {
  return {
    schemaVersion: EVIDENCE_VERIFY_SCHEMA_VERSION,
    reportLabel: EVIDENCE_VERIFY_REPORT_LABEL,
    scope: 'run',
    requestedId: 'fixture-committed-run-20260918T000000Z-000001',
    rootKind: 'run',
    rootRelativePath: 'evidence/runs/fixture-committed-run-20260918T000000Z-000001',
    transaction: {
      state: 'committed',
      failureClass: null,
      failureCode: null,
      commitPoint: 'committed',
      creditEligible: true,
      immutable: true,
      finalManifestPresent: true,
      finalManifestValid: true,
      strictRecordPresent: true,
      behaviorOutcome: 'PASS',
    },
    checks: [
      { id: 'ROOT_RESOLUTION', category: 'root', result: 'PASS', code: 'VERIFY_ROOT_NOT_FOUND' },
    ],
    artifacts: {
      declaredCount: 1,
      verifiedCount: 1,
      requiredCount: 1,
      diagnosticCount: 0,
      missingIds: [],
      extraRelativePaths: [],
    },
    references: { declaredCount: 0, verifiedCount: 0 },
    provenance: {
      persistedIdentityValid: true,
      currentTreeCheck: 'not-run',
      currentTreeCreditEligible: false,
      repositoryRevisionPresent: true,
      dirtyPolicyPresent: true,
      lockfileDigestPresent: true,
      componentDigestsPresent: true,
      catalogueIdentitiesPresent: true,
      profileIdentitiesPresent: true,
    },
    sanitization: {
      requiredApproved: true,
      diagnosticApproved: true,
      requiredAuthorityPreserved: true,
      prohibitedValuesFound: false,
    },
    suite: null,
    diagnostics: [],
  };
}

function finding(
  code: EvidenceVerifyPrimaryFinding['code'],
  detailCode: EvidenceVerifyPrimaryFinding['detailCode'],
  subjectOrdinal: number | null,
  blockingClass: EvidenceVerifyPrimaryFinding['blockingClass'] = 'HARNESS_BLOCKED',
): EvidenceVerifyPrimaryFinding {
  return { code, detailCode, subjectOrdinal, blockingClass };
}

// ── 1. Verifier-code partition and precedence ────────────────────────────────

describe('[P8-B/B0] verifier code partition and canonical precedence', () => {
  it('closes exactly 40 unique verifier codes', () => {
    expect(EVIDENCE_VERIFY_CODES.length).toBe(40);
    expect(new Set(EVIDENCE_VERIFY_CODES).size).toBe(40);
  });

  it('partitions the code set into exactly 2 advisory and 38 blocking codes', () => {
    expect(ADVISORY_VERIFIER_CODES.length).toBe(2);
    expect(new Set(ADVISORY_VERIFIER_CODES)).toEqual(
      new Set(['VERIFY_PROVENANCE_CURRENT_DRIFT', 'VERIFY_PROVENANCE_CURRENT_UNAVAILABLE']),
    );
    expect(PRIMARY_BLOCKING_VERIFIER_CODES.length).toBe(38);
    expect(new Set(PRIMARY_BLOCKING_VERIFIER_CODES).size).toBe(38);
    const blocking = EVIDENCE_VERIFY_CODES.filter((code) => !isAdvisoryVerifierCode(code));
    expect(sorted(blocking)).toEqual(sorted(PRIMARY_BLOCKING_VERIFIER_CODES));
  });

  it('never admits an advisory code into the blocking precedence constant', () => {
    for (const advisory of ADVISORY_VERIFIER_CODES) {
      expect(PRIMARY_BLOCKING_VERIFIER_CODES as readonly string[]).not.toContain(advisory);
      expect(primaryPrecedenceIndex(advisory)).toBeNull();
    }
  });

  it('assigns each blocking code a unique 1..38 precedence index', () => {
    const indices = PRIMARY_BLOCKING_VERIFIER_CODES.map((code) => primaryPrecedenceIndex(code));
    expect(indices).toEqual([...Array(38)].map((_, index) => index + 1));
    expect(new Set(indices).size).toBe(38);
  });

  it('selects primary by (blockingClass, precedenceIndex, subjectOrdinal)', () => {
    // A harness fault and an external read failure together select HARNESS_BLOCKED.
    const mixed = selectPrimaryVerifierFinding([
      finding('VERIFY_EXTERNAL_READ_FAILURE', 'UNKNOWN_EXCEPTION', 0, 'ENVIRONMENT_FAILURE'),
      finding('VERIFY_ARTIFACT_MISSING', 'ARTIFACT_LENGTH', 5, 'HARNESS_BLOCKED'),
    ]);
    expect(mixed?.code).toBe('VERIFY_ARTIFACT_MISSING');

    // ENVIRONMENT_FAILURE is selectable only when it is the sole blocking class.
    const sole = selectPrimaryVerifierFinding([
      finding('VERIFY_EXTERNAL_READ_FAILURE', 'UNKNOWN_EXCEPTION', null, 'ENVIRONMENT_FAILURE'),
    ]);
    expect(sole?.code).toBe('VERIFY_EXTERNAL_READ_FAILURE');

    // Precedence index breaks a class tie; the earlier index wins.
    const tie = selectPrimaryVerifierFinding([
      finding('VERIFY_ARTIFACT_SHA256_MISMATCH', 'ARTIFACT_SHA256', 0),
      finding('VERIFY_ARTIFACT_MISSING', 'ARTIFACT_LENGTH', 0),
    ]);
    expect(tie?.code).toBe('VERIFY_ARTIFACT_MISSING');

    // Subject ordinal orders deterministically, with null after numeric.
    const ordinals = selectPrimaryVerifierFinding([
      finding('VERIFY_ARTIFACT_MISSING', 'ARTIFACT_LENGTH', null),
      finding('VERIFY_ARTIFACT_MISSING', 'ARTIFACT_LENGTH', 3),
    ]);
    expect(ordinals?.subjectOrdinal).toBe(3);

    expect(selectPrimaryVerifierFinding([])).toBeNull();
    // Class ranks are the fixed canonical ranks.
    expect(EVIDENCE_VERIFY_FINDING_CLASS_RANKS.USAGE).toBe(0);
    expect(EVIDENCE_VERIFY_FINDING_CLASS_RANKS.HARNESS_BLOCKED).toBe(1);
    expect(EVIDENCE_VERIFY_FINDING_CLASS_RANKS.ENVIRONMENT_FAILURE).toBe(2);
    expect(EVIDENCE_VERIFY_FINDING_CLASS_RANKS.PASS).toBe(3);
  });

  it('classifies only root-unreadable and external-read as default environment failures', () => {
    expect(new Set(ENVIRONMENT_FAILURE_VERIFIER_CODES)).toEqual(
      new Set(['VERIFY_ROOT_UNREADABLE', 'VERIFY_EXTERNAL_READ_FAILURE']),
    );
    expect(defaultVerifierFindingClass('VERIFY_ROOT_UNREADABLE')).toBe('ENVIRONMENT_FAILURE');
    expect(defaultVerifierFindingClass('VERIFY_EXTERNAL_READ_FAILURE')).toBe('ENVIRONMENT_FAILURE');
    expect(defaultVerifierFindingClass('VERIFY_ARTIFACT_MISSING')).toBe('HARNESS_BLOCKED');
  });
});

// ── 2. Source-union exhaustiveness and projection uniqueness ─────────────────

describe('[P8-B/B0] source-union projection completeness', () => {
  it('matches the 57-member strict run/public reader union exactly', () => {
    const sourceUnion = [...FINAL_RECORD_ASSEMBLY_ISSUE_CODES, ...RESULT_CONTRACT_ISSUE_CODES];
    expect(FINAL_RECORD_ASSEMBLY_ISSUE_CODES.length).toBe(24);
    expect(RESULT_CONTRACT_ISSUE_CODES.length).toBe(33);
    expect(sourceUnion.length).toBe(57);
    expect(new Set(sourceUnion).size).toBe(57);
    expect(FINAL_RECORD_ISSUE_PROJECTION.length).toBe(57);
    expect(sorted(FINAL_RECORD_ISSUE_PROJECTION.map((row) => row.source))).toEqual(
      sorted(sourceUnion),
    );
    expect(sorted(FINAL_RECORD_ASSEMBLY_ISSUE_SOURCE_CODES)).toEqual(
      sorted(FINAL_RECORD_ASSEMBLY_ISSUE_CODES),
    );
    expect(sorted(RESULT_CONTRACT_ISSUE_SOURCE_CODES)).toEqual(sorted(RESULT_CONTRACT_ISSUE_CODES));
  });

  it('matches the 18-member strict suite reader union exactly', () => {
    expect(FINAL_SUITE_RECORD_ISSUE_CODES.length).toBe(18);
    expect(new Set(FINAL_SUITE_RECORD_ISSUE_CODES).size).toBe(18);
    expect(FINAL_SUITE_RECORD_ISSUE_PROJECTION.length).toBe(18);
    expect(sorted(FINAL_SUITE_RECORD_ISSUE_PROJECTION.map((row) => row.source))).toEqual(
      sorted(FINAL_SUITE_RECORD_ISSUE_CODES),
    );
    expect(sorted(FINAL_SUITE_RECORD_ISSUE_SOURCE_CODES)).toEqual(
      sorted(FINAL_SUITE_RECORD_ISSUE_CODES),
    );
  });

  it('matches every validator family source array exactly', () => {
    expect(sorted(EVIDENCE_REFERENCE_FAILURE_PROJECTION.map((row) => row.sourceCode))).toEqual(
      sorted(EVIDENCE_REFERENCE_FAILURE_CODES),
    );
    expect(sorted(EVIDENCE_CONTRACT_ISSUE_PROJECTION.map((row) => row.sourceCode))).toEqual(
      sorted(EVIDENCE_CONTRACT_ISSUE_CODES),
    );
    const auxiliary = sorted(EVIDENCE_AUXILIARY_FAILURE_PROJECTION.map((row) => row.sourceCode));
    const auxiliaryUnion = [
      ...EVIDENCE_SEMANTIC_DIGEST_FAILURE_CODES,
      ...EVIDENCE_SANITIZATION_FAILURE_CODES,
      ...PROVENANCE_POLICY_FAILURE_CODES,
      ...REDACTION_FAILURE_CODES,
    ];
    expect(auxiliary).toEqual(sorted(auxiliaryUnion));
    expect(sorted(EVIDENCE_REFERENCE_FAILURE_SOURCE_CODES)).toEqual(
      sorted(EVIDENCE_REFERENCE_FAILURE_CODES),
    );
    expect(sorted(EVIDENCE_CONTRACT_ISSUE_SOURCE_CODES)).toEqual(
      sorted(EVIDENCE_CONTRACT_ISSUE_CODES),
    );
    expect(sorted(EVIDENCE_SEMANTIC_DIGEST_FAILURE_SOURCE_CODES)).toEqual(
      sorted(EVIDENCE_SEMANTIC_DIGEST_FAILURE_CODES),
    );
    expect(sorted(EVIDENCE_SANITIZATION_FAILURE_SOURCE_CODES)).toEqual(
      sorted(EVIDENCE_SANITIZATION_FAILURE_CODES),
    );
    expect(sorted(EVIDENCE_PROVENANCE_FAILURE_SOURCE_CODES)).toEqual(
      sorted(PROVENANCE_POLICY_FAILURE_CODES),
    );
    expect(sorted(EVIDENCE_REDACTION_FAILURE_SOURCE_CODES)).toEqual(
      sorted(REDACTION_FAILURE_CODES),
    );
  });

  it('keeps one immutable projection row per source literal with no raw passthrough', () => {
    expect(EVIDENCE_VERIFY_SOURCE_PROJECTION.length).toBe(134);
    const sources = EVIDENCE_VERIFY_SOURCE_PROJECTION.map((row) => row.sourceCode);
    expect(new Set(sources).size).toBe(134);
    for (const row of EVIDENCE_VERIFY_SOURCE_PROJECTION) {
      expect(row.severity).toBe('blocking');
      expect(row.rawPassthrough).toBe(false);
      expect(EVIDENCE_VERIFY_CODES as readonly string[]).toContain(row.verifierCode);
      expect(isAdvisoryVerifierCode(row.verifierCode)).toBe(false);
      expect(isEvidenceVerifyDetailCode(row.detailCode)).toBe(true);
      expect(projectSourceIssue(row.sourceCode)).toEqual(row);
    }
  });

  it('rejects an unmapped source literal instead of inventing a fallback', () => {
    expect(() => projectSourceIssue('SOME_NEW_FUTURE_SOURCE_CODE')).toThrow(
      EvidenceVerifyContractError,
    );
  });

  it('closes the detail-code union over every source literal plus fixed literals', () => {
    const sourceLiterals = new Set([
      ...EVIDENCE_REFERENCE_FAILURE_CODES,
      ...EVIDENCE_CONTRACT_ISSUE_CODES,
      ...EVIDENCE_SEMANTIC_DIGEST_FAILURE_CODES,
      ...EVIDENCE_SANITIZATION_FAILURE_CODES,
      ...PROVENANCE_POLICY_FAILURE_CODES,
      ...REDACTION_FAILURE_CODES,
      ...FINAL_RECORD_ASSEMBLY_ISSUE_CODES,
      ...RESULT_CONTRACT_ISSUE_CODES,
      ...FINAL_SUITE_RECORD_ISSUE_CODES,
    ]);
    expect(new Set(EVIDENCE_VERIFY_DETAIL_CODES).size).toBe(EVIDENCE_VERIFY_DETAIL_CODES.length);
    expect(sorted(EVIDENCE_VERIFY_DETAIL_CODES)).toEqual(
      sorted([...sourceLiterals, ...FIXED_INSPECTION_DETAIL_CODES]),
    );
    expect(isEvidenceVerifyDetailCode('PROHIBITED_BYTES_FOUND')).toBe(true);
    expect(isEvidenceVerifyDetailCode('Not a real source detail text')).toBe(false);
    expect(ARTIFACT_LENGTH_DETAIL_CODE).toBe('ARTIFACT_LENGTH');
    expect(ARTIFACT_SHA256_DETAIL_CODE).toBe('ARTIFACT_SHA256');
    expect(ARTIFACT_SEMANTIC_DIGEST_DETAIL_CODE).toBe('ARTIFACT_SEMANTIC_DIGEST');
  });
});

// ── 3. Deterministic ordinals ────────────────────────────────────────────────

describe('[P8-B/B0] deterministic subject ordinals', () => {
  it('derives run ordinals from sorted artifact ids, never enumeration order', () => {
    const ordinals = canonicalRunSubjectOrdinals(['artifact:z', 'artifact:a', 'artifact:m']);
    expect(ordinals.get('artifact:a')).toBe(0);
    expect(ordinals.get('artifact:m')).toBe(1);
    expect(ordinals.get('artifact:z')).toBe(2);
    expect(ordinals.get('artifact:absent')).toBeUndefined();
  });

  it('derives suite ordinals from suite-v2 child order then sorted artifact ids', () => {
    const ordinals = canonicalSuiteSubjectOrdinals([
      { childKey: 'second', order: 2, artifactIds: ['artifact:b', 'artifact:a'] },
      { childKey: 'first', order: 1, artifactIds: ['artifact:c'] },
      { childKey: 'empty', order: 3, artifactIds: [] },
    ]);
    expect(ordinals.get('first')?.childIndex).toBe(0);
    expect(ordinals.get('first')?.artifactOrdinals.get('artifact:c')).toBe(0);
    expect(ordinals.get('second')?.childIndex).toBe(1);
    expect(ordinals.get('second')?.artifactOrdinals.get('artifact:a')).toBe(1);
    expect(ordinals.get('second')?.artifactOrdinals.get('artifact:b')).toBe(2);
    expect(ordinals.get('second')?.firstOrdinal).toBe(1);
    expect(ordinals.get('empty')?.firstOrdinal).toBe(2);
    expect(ordinals.get('empty')?.artifactOrdinals.size).toBe(0);
  });
});

// ── 4. Closed details DTO validator ──────────────────────────────────────────

describe('[P8-B/B0] closed evidence-verify.v1 details validator', () => {
  it('accepts a canonically closed report', () => {
    expect(validateEvidenceVerifyDetails(validDetails())).toEqual([]);
  });

  it('rejects unknown/missing keys and invalid closed values', () => {
    const withUnknown = { ...validDetails(), extra: true } as unknown;
    expect(validateEvidenceVerifyDetails(withUnknown).map((entry) => entry.code)).toContain(
      'VERIFY_DETAILS_UNKNOWN_KEY',
    );

    const missing = { ...validDetails() } as Record<string, unknown>;
    delete missing.reportLabel;
    expect(validateEvidenceVerifyDetails(missing).map((entry) => entry.code)).toContain(
      'VERIFY_DETAILS_MISSING_KEY',
    );

    const badVersion = { ...validDetails(), schemaVersion: 2 } as unknown;
    expect(validateEvidenceVerifyDetails(badVersion).map((entry) => entry.code)).toContain(
      'VERIFY_DETAILS_INVALID_VALUE',
    );

    const badPath = { ...validDetails(), rootRelativePath: '../escape' } as unknown;
    expect(validateEvidenceVerifyDetails(badPath).map((entry) => entry.code)).toContain(
      'VERIFY_DETAILS_INVALID_VALUE',
    );

    const badScope = { ...validDetails(), scope: 'suite' } as unknown;
    expect(validateEvidenceVerifyDetails(badScope).map((entry) => entry.code)).toContain(
      'VERIFY_DETAILS_INVALID_VALUE',
    );
  });

  it('rejects an advisory code paired with blocking severity and vice versa', () => {
    const advisoryBlocking = {
      ...validDetails(),
      diagnostics: [
        {
          code: 'VERIFY_PROVENANCE_CURRENT_DRIFT',
          severity: 'blocking',
          detailCode: 'CURRENT_TREE_DRIFT',
          subjectOrdinal: null,
        },
      ],
    } as unknown;
    expect(validateEvidenceVerifyDetails(advisoryBlocking).map((entry) => entry.code)).toContain(
      'VERIFY_DETAILS_INCONSISTENT_SEVERITY',
    );

    const blockingDiagnostic = {
      ...validDetails(),
      diagnostics: [
        {
          code: 'VERIFY_ARTIFACT_MISSING',
          severity: 'diagnostic',
          detailCode: 'ARTIFACT_LENGTH',
          subjectOrdinal: 0,
        },
      ],
    } as unknown;
    expect(validateEvidenceVerifyDetails(blockingDiagnostic).map((entry) => entry.code)).toContain(
      'VERIFY_DETAILS_INCONSISTENT_SEVERITY',
    );
  });

  it('rejects an unknown code, unknown detail code, and raw diagnostic passthrough', () => {
    const badCode = {
      ...validDetails(),
      diagnostics: [
        {
          code: 'RESULT_FINGERPRINT_INVALID',
          severity: 'blocking',
          detailCode: 'ARTIFACT_LENGTH',
          subjectOrdinal: 0,
        },
      ],
    } as unknown;
    expect(validateEvidenceVerifyDetails(badCode).map((entry) => entry.code)).toContain(
      'VERIFY_DETAILS_UNKNOWN_CODE',
    );

    const badDetail = {
      ...validDetails(),
      diagnostics: [
        {
          code: 'VERIFY_ARTIFACT_MISSING',
          severity: 'blocking',
          detailCode: 'raw reader text',
          subjectOrdinal: 0,
        },
      ],
    } as unknown;
    expect(validateEvidenceVerifyDetails(badDetail).map((entry) => entry.code)).toContain(
      'VERIFY_DETAILS_UNKNOWN_DETAIL_CODE',
    );

    const rawDetail = {
      ...validDetails(),
      diagnostics: [
        {
          code: 'VERIFY_ARTIFACT_MISSING',
          severity: 'blocking',
          detailCode: 'ARTIFACT_LENGTH',
          subjectOrdinal: 0,
          detail: 'leaked raw value',
        },
      ],
    } as unknown;
    expect(validateEvidenceVerifyDetails(rawDetail).map((entry) => entry.code)).toContain(
      'VERIFY_DETAILS_UNKNOWN_KEY',
    );
    expect(new Set(EVIDENCE_VERIFY_DIAGNOSTIC_KEYS)).toEqual(
      new Set(['code', 'severity', 'detailCode', 'subjectOrdinal']),
    );
  });

  it('enforces canonical diagnostic and check ordering and rejects duplicates', () => {
    const unsorted = {
      ...validDetails(),
      diagnostics: [
        {
          code: 'VERIFY_UNKNOWN_FAILURE',
          severity: 'blocking',
          detailCode: 'UNKNOWN_EXCEPTION',
          subjectOrdinal: null,
        },
        {
          code: 'VERIFY_ARTIFACT_MISSING',
          severity: 'blocking',
          detailCode: 'ARTIFACT_LENGTH',
          subjectOrdinal: 0,
        },
      ],
    } as unknown;
    expect(validateEvidenceVerifyDetails(unsorted).map((entry) => entry.code)).toContain(
      'VERIFY_DETAILS_UNSORTED',
    );

    const duplicateChecks = {
      ...validDetails(),
      checks: [
        { id: 'ROOT_RESOLUTION', category: 'root', result: 'PASS', code: 'VERIFY_ROOT_NOT_FOUND' },
        { id: 'ROOT_RESOLUTION', category: 'root', result: 'PASS', code: 'VERIFY_ROOT_NOT_FOUND' },
      ],
    } as unknown;
    const duplicateIssues = validateEvidenceVerifyDetails(duplicateChecks).map(
      (entry) => entry.code,
    );
    expect(duplicateIssues).toContain('VERIFY_DETAILS_DUPLICATE');
    expect(duplicateIssues).toContain('VERIFY_DETAILS_UNSORTED');
  });

  it('keeps current-tree credit separate from persisted integrity', () => {
    const creditWithoutPass = {
      ...validDetails(),
      provenance: {
        ...validDetails().provenance,
        currentTreeCheck: 'DRIFT',
        currentTreeCreditEligible: true,
      },
    } as unknown;
    expect(validateEvidenceVerifyDetails(creditWithoutPass).map((entry) => entry.code)).toContain(
      'VERIFY_DETAILS_INVALID_VALUE',
    );

    const drift = canonicalizeEvidenceVerifyDetails({
      ...validDetails(),
      transaction: { ...validDetails().transaction, state: 'committed', creditEligible: true },
      provenance: {
        ...validDetails().provenance,
        currentTreeCheck: 'DRIFT',
        currentTreeCreditEligible: false,
      },
      diagnostics: [
        {
          code: 'VERIFY_PROVENANCE_CURRENT_DRIFT',
          severity: 'diagnostic',
          detailCode: 'CURRENT_TREE_DRIFT',
          subjectOrdinal: null,
        },
      ],
    });
    expect(validateEvidenceVerifyDetails(drift)).toEqual([]);
    expect(drift.transaction.creditEligible).toBe(true);
    expect(drift.provenance.currentTreeCreditEligible).toBe(false);
  });

  it('requires a suite object for suite scope and null for run scope', () => {
    const runWithSuite = {
      ...validDetails(),
      suite: {
        recordLabel: 'suite-v2',
        recordSchemaVersion: 2,
        childCount: 1,
        committedChildCount: 1,
        uncommittedChildIds: [],
        suiteTransactionActivation: 'deferred-not-activated',
      },
    } as unknown;
    expect(validateEvidenceVerifyDetails(runWithSuite).map((entry) => entry.code)).toContain(
      'VERIFY_DETAILS_INVALID_VALUE',
    );

    const suite = {
      ...validDetails(),
      scope: 'suite',
      rootKind: 'suite',
      rootRelativePath: 'evidence/suites/fixture-suite-execution-20260918T000100Z-000001',
      suite: {
        recordLabel: 'suite-v2',
        recordSchemaVersion: 2,
        childCount: 1,
        committedChildCount: 1,
        uncommittedChildIds: [],
        suiteTransactionActivation: 'deferred-not-activated',
      },
    } as unknown;
    expect(validateEvidenceVerifyDetails(suite)).toEqual([]);
  });

  it('parses closed details and fails closed with a typed error', () => {
    expect(parseEvidenceVerifyDetails(validDetails()).reportLabel).toBe(
      EVIDENCE_VERIFY_REPORT_LABEL,
    );
    expect(() => parseEvidenceVerifyDetails({ ...validDetails(), schemaVersion: 9 })).toThrow(
      EvidenceVerifyContractError,
    );
    expect(() => parseEvidenceVerifyDetails(validDetails())).not.toThrow();
  });

  it('uses only safe relative root paths and closed detail issue codes', () => {
    expect(isEvidenceVerifyRootRelativePath('evidence/runs/abc-123', 'run')).toBe(true);
    expect(isEvidenceVerifyRootRelativePath('evidence/suites/abc-123', 'suite')).toBe(true);
    expect(isEvidenceVerifyRootRelativePath('/absolute/evidence/runs/abc', 'run')).toBe(false);
    expect(isEvidenceVerifyRootRelativePath('evidence/runs/../escape', 'run')).toBe(false);
    expect(isEvidenceVerifyRootRelativePath('evidence/suites/abc', 'run')).toBe(false);
    expect(new Set(EVIDENCE_VERIFY_DETAILS_ISSUE_CODES).size).toBe(
      EVIDENCE_VERIFY_DETAILS_ISSUE_CODES.length,
    );
  });
});

// ── 5. Sanitizer inspection boundary ─────────────────────────────────────────

describe('[P8-B/B0] pure prohibited-byte inspection boundary', () => {
  const cleanPng = pngWithChunk('IDAT', 'binary-image-payload');
  const forbiddenPng = pngWithChunk('tEXt', 'metadata /private/var/folders/p8b-secret-root tail');
  const opaqueBinary = new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253]);

  it('accepts a clean PNG and never returns bytes/values/paths', () => {
    const result = inspectProhibitedBytes({
      apiVersion: EVIDENCE_PROHIBITED_BYTES_API_VERSION,
      bytes: cleanPng,
      mediaType: 'image/png',
      format: 'png',
      forbiddenRoots: [],
    });
    expect(result).toEqual({
      apiVersion: EVIDENCE_PROHIBITED_BYTES_API_VERSION,
      code: 'PROHIBITED_BYTES_NONE',
      prohibited: false,
    });
    expect(Object.keys(result)).toEqual(['apiVersion', 'code', 'prohibited']);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('finds a prohibited value in PNG metadata without echoing it', () => {
    const root = '/private/var/folders/p8b-secret-root';
    const result = inspectProhibitedBytes({
      apiVersion: EVIDENCE_PROHIBITED_BYTES_API_VERSION,
      bytes: forbiddenPng,
      mediaType: 'image/png',
      format: 'png',
      forbiddenRoots: [root],
    });
    expect(result.code).toBe('PROHIBITED_BYTES_FOUND');
    expect(result.prohibited).toBe(true);
    expect(JSON.stringify(result)).not.toContain('/private');
    expect(JSON.stringify(result)).not.toContain(root);
  });

  it('treats a malformed/truncated PNG as a blocking malformed result', () => {
    const truncated = cleanPng.subarray(0, 12);
    const result = inspectProhibitedBytes({
      apiVersion: EVIDENCE_PROHIBITED_BYTES_API_VERSION,
      bytes: truncated,
      mediaType: 'image/png',
      format: 'png',
      forbiddenRoots: [],
    });
    expect(result.code).toBe('PROHIBITED_BYTES_MALFORMED_PNG');
    expect(result.prohibited).toBe(true);

    const notPng = inspectProhibitedBytes({
      apiVersion: EVIDENCE_PROHIBITED_BYTES_API_VERSION,
      bytes: new TextEncoder().encode('not a png'),
      mediaType: 'image/png',
      format: 'png',
      forbiddenRoots: [],
    });
    expect(notPng.code).toBe('PROHIBITED_BYTES_MALFORMED_PNG');
  });

  it('scans opaque bytes without PNG reinterpretation and detects inside a PNG payload', () => {
    const cleanOpaque = inspectProhibitedBytes({
      apiVersion: EVIDENCE_PROHIBITED_BYTES_API_VERSION,
      bytes: opaqueBinary,
      mediaType: 'opaque',
      format: 'opaque',
      forbiddenRoots: [],
    });
    expect(cleanOpaque.code).toBe('PROHIBITED_BYTES_NONE');

    // The very same PNG-signature bytes scanned as opaque must not be silently
    // treated as a clean PNG; the prohibited metadata text is still found.
    const opaquePng = inspectProhibitedBytes({
      apiVersion: EVIDENCE_PROHIBITED_BYTES_API_VERSION,
      bytes: forbiddenPng,
      mediaType: 'opaque',
      format: 'opaque',
      forbiddenRoots: [],
    });
    expect(opaquePng.code).toBe('PROHIBITED_BYTES_FOUND');
  });

  it('finds a forbidden root in opaque text and an opaque prohibited marker', () => {
    const root = '/Users/someone/private/scratch';
    const withRoot = inspectProhibitedBytes({
      apiVersion: EVIDENCE_PROHIBITED_BYTES_API_VERSION,
      bytes: new TextEncoder().encode(`prefix ${root} suffix`),
      mediaType: 'opaque',
      format: 'opaque',
      forbiddenRoots: [root],
    });
    expect(withRoot.code).toBe('PROHIBITED_BYTES_FOUND');

    const withToken = inspectProhibitedBytes({
      apiVersion: EVIDENCE_PROHIBITED_BYTES_API_VERSION,
      bytes: new TextEncoder().encode('leaked blob:opaque-handle-xyz'),
      mediaType: 'opaque',
      format: 'opaque',
      forbiddenRoots: [],
    });
    expect(withToken.code).toBe('PROHIBITED_BYTES_FOUND');
  });

  it('rejects invalid input, bad pairings, bad version, and unknown keys', () => {
    const invalidInputs: unknown[] = [
      {
        apiVersion: 2,
        bytes: cleanPng,
        mediaType: 'image/png',
        format: 'png',
        forbiddenRoots: [],
      },
      {
        apiVersion: EVIDENCE_PROHIBITED_BYTES_API_VERSION,
        bytes: 'not-bytes',
        mediaType: 'image/png',
        format: 'png',
        forbiddenRoots: [],
      },
      {
        apiVersion: EVIDENCE_PROHIBITED_BYTES_API_VERSION,
        bytes: cleanPng,
        mediaType: 'image/png',
        format: 'opaque',
        forbiddenRoots: [],
      },
      {
        apiVersion: EVIDENCE_PROHIBITED_BYTES_API_VERSION,
        bytes: cleanPng,
        mediaType: 'opaque',
        format: 'png',
        forbiddenRoots: [],
      },
      {
        apiVersion: EVIDENCE_PROHIBITED_BYTES_API_VERSION,
        bytes: cleanPng,
        mediaType: 'image/png',
        format: 'png',
        forbiddenRoots: [42],
      },
      {
        apiVersion: EVIDENCE_PROHIBITED_BYTES_API_VERSION,
        bytes: cleanPng,
        mediaType: 'image/png',
        format: 'png',
        forbiddenRoots: [],
        extra: true,
      },
      null,
      'nope',
    ];
    for (const candidate of invalidInputs) {
      const result = inspectProhibitedBytes(candidate as InspectProhibitedBytesInput);
      expect(result.code).toBe('PROHIBITED_BYTES_INVALID_INPUT');
      expect(result.prohibited).toBe(true);
    }
    expect(new Set(EVIDENCE_PROHIBITED_BYTES_CODES)).toEqual(
      new Set([
        'PROHIBITED_BYTES_NONE',
        'PROHIBITED_BYTES_FOUND',
        'PROHIBITED_BYTES_MALFORMED_PNG',
        'PROHIBITED_BYTES_INVALID_INPUT',
      ]),
    );
  });

  it('adds only the inspection API without approval handles or writer changes', () => {
    const namespaceKeys = Object.keys(sanitizeModule);
    expect(namespaceKeys).toContain('inspectProhibitedBytes');
    expect(namespaceKeys).not.toContain('registerApproval');
    expect(namespaceKeys).not.toContain('requireApproval');
    expect(namespaceKeys).not.toContain('sanitizationApprovals');
    // The plan's literal inspection API has no extra media-type/format exports.
    expect(namespaceKeys).not.toContain('EVIDENCE_PROHIBITED_BYTES_MEDIA_TYPES');
    expect(namespaceKeys).not.toContain('EVIDENCE_PROHIBITED_BYTES_FORMATS');

    // The existing writer boundary still approves safe exact bytes unchanged.
    const approval = sanitizeArtifactBytes({
      artifactId: 'artifact:run-record',
      relativePath: 'run-record.json',
      role: 'required-authoritative',
      policy: 'public-json-guard-v1',
      bytes: JSON.stringify({ outcome: 'PASS' }),
      semanticDigestKind: 'canonical-json',
      semanticValue: { outcome: 'PASS' },
    });
    expect(inspectSanitizationApproval(approval).approval).toBe('approved');
    expect(sorted(EVIDENCE_SANITIZATION_FAILURE_CODES)).toEqual(
      sorted([
        'SANITIZATION_ROLE_UNKNOWN',
        'SANITIZATION_POLICY_UNKNOWN',
        'SANITIZATION_BYTES_INVALID',
        'SANITIZATION_PROHIBITED_VALUE',
        'SANITIZATION_REQUIRED_AUTHORITY_CHANGED',
        'SANITIZATION_REQUIRED_AUTHORITY_OMITTED',
        'SANITIZATION_ARTIFACT_ID_INVALID',
        'SANITIZATION_PATH_INVALID',
        'SANITIZATION_APPROVAL_FORGED',
      ]),
    );
  });

  it('exposes the inspection version constant and stays pure (no filesystem import)', () => {
    expect(EVIDENCE_PROHIBITED_BYTES_API_VERSION).toBe(1);
    const source = readSource('.pi/skills/verify-artwork-editor/src/contracts/evidence-verify.ts');
    expect(source.includes('node:fs')).toBe(false);
    expect(source.includes('node:path')).toBe(false);
  });
});

// ── 6. Argument-rejection contract ───────────────────────────────────────────

describe('[P8-B/B0] duplicate/unknown argument rejection contract', () => {
  it('accepts exactly one --run in either form', () => {
    expect(parseEvidenceVerifyArguments(['--run', 'abc-123'])).toEqual({
      ok: true,
      runId: 'abc-123',
    });
    expect(parseEvidenceVerifyArguments(['--run=abc-123'])).toEqual({
      ok: true,
      runId: 'abc-123',
    });
  });

  it('rejects missing, duplicate, unknown, positional, and missing-value forms', () => {
    const cases: ReadonlyArray<readonly [readonly string[], string]> = [
      [[], 'EVIDENCE_VERIFY_ARGUMENT_MISSING'],
      [['--run', 'a', '--run', 'b'], 'EVIDENCE_VERIFY_ARGUMENT_DUPLICATE'],
      [['--run=a', '--run', 'b'], 'EVIDENCE_VERIFY_ARGUMENT_DUPLICATE'],
      [['--unknown', 'x'], 'EVIDENCE_VERIFY_ARGUMENT_UNKNOWN'],
      [['--run'], 'EVIDENCE_VERIFY_ARGUMENT_MISSING_VALUE'],
      [['--run', '--other'], 'EVIDENCE_VERIFY_ARGUMENT_MISSING_VALUE'],
      [['--run='], 'EVIDENCE_VERIFY_ARGUMENT_MISSING_VALUE'],
      [['positional'], 'EVIDENCE_VERIFY_ARGUMENT_POSITIONAL'],
      [['--run', 'bad/id'], 'EVIDENCE_VERIFY_ARGUMENT_UNSAFE_ID'],
      [['--help'], 'EVIDENCE_VERIFY_ARGUMENT_UNKNOWN'],
    ];
    for (const [argv, failure] of cases) {
      expect(parseEvidenceVerifyArguments(argv)).toEqual({ ok: false, failure });
    }
  });

  it('performs no filesystem access beyond argument parsing', () => {
    const first = parseEvidenceVerifyArguments(['--run', 'abc-123']);
    const second = parseEvidenceVerifyArguments(['--run', 'abc-123']);
    expect(first).toEqual(second);
    // The contract module imports no filesystem surface.
    const source = readSource('.pi/skills/verify-artwork-editor/src/contracts/evidence-verify.ts');
    expect(source.includes('readFileSync')).toBe(false);
    expect(source.includes('writeFileSync')).toBe(false);
  });
});

// ── 7. Strict schema no-delta ────────────────────────────────────────────────

describe('[P8-B/B0] sealed strict-schema no-delta', () => {
  it('preserves the accepted strict-v4 and suite-v2 constants', () => {
    expect(FINAL_CURRENT_CHILD_RECORD_SCHEMA_VERSION).toBe(4);
    expect(FINAL_SUITE_RECORD_SCHEMA_VERSION).toBe(2);
    expect(EVIDENCE_SEALED_STRICT_SCHEMAS.runRecordSchemaVersion).toBe(
      FINAL_CURRENT_CHILD_RECORD_SCHEMA_VERSION,
    );
    expect(EVIDENCE_SEALED_STRICT_SCHEMAS.suiteRecordSchemaVersion).toBe(
      FINAL_SUITE_RECORD_SCHEMA_VERSION,
    );
    expect(EVIDENCE_SEALED_STRICT_SCHEMAS.currentChildRecordLabel).toBe('current-v4');
    expect(EVIDENCE_SEALED_STRICT_SCHEMAS.suiteRecordLabel).toBe('suite-v2');
  });

  it('aligns inspection codes with the fixed detail literals', () => {
    for (const code of EVIDENCE_PROHIBITED_BYTES_CODES) {
      expect(FIXED_INSPECTION_DETAIL_CODES as readonly string[]).toContain(code);
    }
  });
});

// ── 8. Immutable five-file fixture boundary ──────────────────────────────────

describe('[P8-B/B0] immutable five-file fixture boundary', () => {
  it('contains exactly the five named JSON fixtures', () => {
    const committedRun = readdirSync(path.join(fixtureRoot, 'committed-run')).sort();
    const legacyRun = readdirSync(path.join(fixtureRoot, 'legacy-run')).sort();
    const committedSuite = readdirSync(path.join(fixtureRoot, 'committed-suite')).sort();
    expect(committedRun).toEqual(
      ['final-manifest.json', 'intended-inventory.json', 'run-record.json'].sort(),
    );
    expect(legacyRun).toEqual(['run-record.json']);
    expect(committedSuite).toEqual(['suite-record.json']);
    for (const relative of FIXTURE_FILES) {
      expect(statSync(path.join(fixtureRoot, relative)).isFile()).toBe(true);
    }
    // No unsupported legacy result.json/manifest.json is checked in.
    expect(
      readdirSync(fixtureRoot, { recursive: true }).filter(
        (entry) => path.basename(String(entry)) === 'result.json',
      ),
    ).toEqual([]);
  });

  it('keeps every fixture byte-identical across a full read/parse pass', () => {
    const before = FIXTURE_FILES.map((relative) => {
      const bytes = readFileSync(path.join(fixtureRoot, relative));
      const stat = statSync(path.join(fixtureRoot, relative));
      return { relative, digest: sha256(bytes), size: stat.size, mtimeMs: stat.mtimeMs };
    });
    // Exercise the fixtures exactly as a hostile-matrix case would read them.
    for (const relative of FIXTURE_FILES) {
      const parsed = readJson(relative);
      expect(parsed).not.toBeNull();
    }
    const publicRead = readFinalPublicRecord(readJson('committed-run/run-record.json'));
    expect(publicRead.kind).toBe('current-v4');
    const legacyRead = readFinalPublicRecord(readJson('legacy-run/run-record.json'));
    expect(legacyRead.kind).toBe('legacy-v1');
    const suiteRead = readFinalSuiteRecord(readJson('committed-suite/suite-record.json'));
    expect(suiteRead.kind).toBe('suite-v2');

    const after = FIXTURE_FILES.map((relative) => {
      const bytes = readFileSync(path.join(fixtureRoot, relative));
      const stat = statSync(path.join(fixtureRoot, relative));
      return { relative, digest: sha256(bytes), size: stat.size, mtimeMs: stat.mtimeMs };
    });
    expect(after).toEqual(before);
  });

  it('keeps the committed-run Package-8 pair internally valid and agreed', () => {
    const inventory = readJson('committed-run/intended-inventory.json');
    const manifest = readJson('committed-run/final-manifest.json');
    expect(validateEvidenceIntendedInventory(inventory)).toEqual([]);
    expect(validateEvidenceFinalManifest(manifest)).toEqual([]);
    expect(validateInventoryManifestAgreement(inventory as never, manifest as never)).toEqual([]);

    const inventoryRecord = inventory as Record<string, unknown>;
    const manifestRecord = manifest as Record<string, unknown>;
    expect(sorted(Object.keys(inventoryRecord))).toEqual(
      sorted([...EVIDENCE_INTENDED_INVENTORY_KEYS]),
    );
    expect(sorted(Object.keys(manifestRecord))).toEqual(sorted([...EVIDENCE_FINAL_MANIFEST_KEYS]));

    const runBytes = readFileSync(path.join(fixtureRoot, 'committed-run/run-record.json'));
    const artifacts = inventoryRecord.artifacts as readonly Record<string, unknown>[];
    const artifact = artifacts[0] as Record<string, unknown>;
    expect(sorted(Object.keys(artifact))).toEqual(sorted([...EVIDENCE_ARTIFACT_ENTRY_KEYS]));
    expect(artifact.relativePath).toBe('run-record.json');
    expect(artifact.byteLength).toBe(runBytes.byteLength);
    expect(artifact.sha256).toBe(sha256(runBytes));
    expect(artifact.semanticDigest).toBe(
      deriveSemanticDigest('canonical-json', JSON.parse(runBytes.toString('utf8'))),
    );
  });

  it('keeps the fixture records closed at the top level and label/schema consistent', () => {
    const runRecord = readJson('committed-run/run-record.json') as Record<string, unknown>;
    expect(sorted(Object.keys(runRecord))).toEqual(sorted([...FINAL_PUBLIC_RUN_RECORD_KEYS]));
    expect(runRecord.schemaVersion).toBe(FINAL_CURRENT_CHILD_RECORD_SCHEMA_VERSION);

    const suiteRecord = readJson('committed-suite/suite-record.json') as Record<string, unknown>;
    expect(sorted(Object.keys(suiteRecord))).toEqual(sorted([...FINAL_SUITE_RECORD_KEYS]));
    expect(suiteRecord.schemaVersion).toBe(FINAL_SUITE_RECORD_SCHEMA_VERSION);
    expect(suiteRecord.label).toBe('suite-v2');

    const legacy = readJson('legacy-run/run-record.json') as Record<string, unknown>;
    expect(legacy.schemaVersion).toBe(1);
  });

  it('sets current-tree checks as a closed advisory vocabulary', () => {
    expect(new Set(EVIDENCE_VERIFY_CURRENT_TREE_CHECKS)).toEqual(
      new Set(['not-run', 'PASS', 'DRIFT', 'UNAVAILABLE']),
    );
  });
});

// ── 9. PNG structural termination enforcement ────────────────────────────────

describe('[P8-B/B0] PNG structural termination enforcement', () => {
  it('accepts a clean, correctly terminated PNG', () => {
    const clean = buildPng([
      buildPngChunk('IDAT', utf8('image-data')),
      buildPngChunk('IEND', new Uint8Array(0)),
    ]);
    const result = inspectPngBytes(clean);
    expect(result.code).toBe('PROHIBITED_BYTES_NONE');
    expect(result.prohibited).toBe(false);
  });

  it('rejects a non-zero-length IEND', () => {
    const nonZeroIend = buildPng([
      buildPngChunk('IDAT', utf8('image-data')),
      buildPngChunk('IEND', new Uint8Array([0])),
    ]);
    const result = inspectPngBytes(nonZeroIend);
    expect(result.code).toBe('PROHIBITED_BYTES_MALFORMED_PNG');
    expect(result.prohibited).toBe(true);
  });

  it('rejects trailing bytes after a terminal IEND', () => {
    const trailing = buildPng(
      [buildPngChunk('IDAT', utf8('image-data')), buildPngChunk('IEND', new Uint8Array(0))],
      [0x41, 0x42],
    );
    const result = inspectPngBytes(trailing);
    expect(result.code).toBe('PROHIBITED_BYTES_MALFORMED_PNG');
    expect(result.prohibited).toBe(true);
  });

  it('rejects a PNG with no terminal IEND', () => {
    const missingIend = buildPng([buildPngChunk('IDAT', utf8('image-data'))]);
    const result = inspectPngBytes(missingIend);
    expect(result.code).toBe('PROHIBITED_BYTES_MALFORMED_PNG');
    expect(result.prohibited).toBe(true);
  });

  it('rejects a truncated chunk header, chunk data, and chunk CRC', () => {
    const valid = buildPng([
      buildPngChunk('IDAT', utf8('image-data')),
      buildPngChunk('IEND', new Uint8Array(0)),
    ]);

    // Truncated chunk header: only two bytes follow the signature.
    const truncatedHeader = valid.subarray(0, PNG_SIGNATURE_BYTES.length + 2);
    expect(inspectPngBytes(truncatedHeader).code).toBe('PROHIBITED_BYTES_MALFORMED_PNG');

    // Declared chunk data length exceeds the available bytes (truncated data).
    const truncatedData = buildPng([buildPngChunk('IDAT', utf8('data'), 64)]);
    expect(inspectPngBytes(truncatedData).code).toBe('PROHIBITED_BYTES_MALFORMED_PNG');

    // A zero-length chunk header is present but its 4-byte CRC is absent.
    const headerWithoutCrc = new Uint8Array(PNG_SIGNATURE_BYTES.length + 8);
    headerWithoutCrc.set(PNG_SIGNATURE_BYTES, 0);
    headerWithoutCrc.set([0, 0, 0, 0, 73, 69, 78, 68], PNG_SIGNATURE_BYTES.length);
    expect(inspectPngBytes(headerWithoutCrc).code).toBe('PROHIBITED_BYTES_MALFORMED_PNG');
  });
});

// ── 10. Actual reader-branch issue projection ────────────────────────────────

interface ReaderIssueLike {
  readonly code: string;
  readonly detail: string;
}

const PROJECTION_ROW_KEYS = [
  'sourceCode',
  'verifierCode',
  'severity',
  'detailCode',
  'rawPassthrough',
];

/**
 * Project every issue the actual pure reader emitted through the closed mapping
 * and assert the closed target, blocking severity, `rawPassthrough:false`, an
 * exact five-key projection row, and that the raw reader `detail` text (or a
 * fallback code) never survives.
 */
function expectProjectedReaderIssues(
  result: { readonly kind: string; readonly issues: readonly ReaderIssueLike[] },
  knownSources: ReadonlySet<string>,
): void {
  for (const issue of result.issues) {
    expect(knownSources.has(issue.code), `unmapped reader issue ${issue.code}`).toBe(true);
    const row = projectSourceIssue(issue.code);
    expect(row.sourceCode).toBe(issue.code);
    expect(row.detailCode).toBe(issue.code);
    expect(row.severity).toBe('blocking');
    expect(row.rawPassthrough).toBe(false);
    expect(isAdvisoryVerifierCode(row.verifierCode)).toBe(false);
    expect(EVIDENCE_VERIFY_CODES as readonly string[]).toContain(row.verifierCode);
    expect(isEvidenceVerifyDetailCode(row.detailCode)).toBe(true);
    expect(Object.keys(row).sort()).toEqual([...PROJECTION_ROW_KEYS].sort());
    expect(Object.values(row)).not.toContain(issue.detail);
  }
}

describe('[P8-B/B0] actual reader-branch issue projection', () => {
  const RUN_SOURCES = new Set<string>([
    ...FINAL_RECORD_ASSEMBLY_ISSUE_CODES,
    ...RESULT_CONTRACT_ISSUE_CODES,
  ]);
  const SUITE_SOURCES = new Set<string>(FINAL_SUITE_RECORD_ISSUE_CODES);

  it('projects the accepted current-v4 public run-record branch', () => {
    const result = readFinalPublicRecord(readJson('committed-run/run-record.json'));
    expect(result.kind).toBe('current-v4');
    expect(result.issues).toEqual([]);
    expectProjectedReaderIssues(result, RUN_SOURCES);
  });

  it('projects the labelled legacy-v1/v2/v3 run-record branches', () => {
    const v1 = readFinalPublicRecord(readJson('legacy-run/run-record.json'));
    expect(v1.kind).toBe('legacy-v1');
    expect(v1.issues.map((entry) => entry.code)).toContain('RESULT_LEGACY_BOOLEAN_AMBIGUOUS');
    expectProjectedReaderIssues(v1, RUN_SOURCES);

    const v2 = readFinalPublicRecord({
      schemaVersion: 2,
      checks: [{ checkId: 'legacy.check', passed: true }],
    });
    expect(v2.kind).toBe('legacy-v2');
    expectProjectedReaderIssues(v2, RUN_SOURCES);

    const v3 = readFinalPublicRecord({
      schemaVersion: 3,
      checks: [{ checkId: 'legacy.check', passed: false }],
    });
    expect(v3.kind).toBe('legacy-v3');
    expectProjectedReaderIssues(v3, RUN_SOURCES);
  });

  it('projects the mixed/unknown/invalid rejected run-record branches', () => {
    const mixed = readFinalPublicRecord({
      schemaVersion: 3,
      checks: [{ checkId: 'legacy.check', status: 'PASS' }],
    });
    expect(mixed.kind).toBe('mixed');
    expect(mixed.issues.map((entry) => entry.code)).toContain('RESULT_CHECK_SHAPE_MIXED');
    expectProjectedReaderIssues(mixed, RUN_SOURCES);

    const unknown = readFinalPublicRecord({ schemaVersion: 99 });
    expect(unknown.kind).toBe('unknown');
    expect(unknown.issues.map((entry) => entry.code)).toContain(
      'RESULT_SCHEMA_VERSION_UNSUPPORTED',
    );
    expectProjectedReaderIssues(unknown, RUN_SOURCES);

    const notObject = readFinalPublicRecord('not-a-record');
    expect(notObject.kind).toBe('invalid');
    expect(notObject.issues.map((entry) => entry.code)).toContain('FINAL_RECORD_NOT_OBJECT');
    expectProjectedReaderIssues(notObject, RUN_SOURCES);

    const invalidV4 = readFinalPublicRecord({
      ...cloneFixture('committed-run/run-record.json'),
      unexpectedKey: true,
    });
    expect(invalidV4.kind).toBe('invalid');
    expect(invalidV4.issues.length).toBeGreaterThan(0);
    expectProjectedReaderIssues(invalidV4, RUN_SOURCES);
  });

  it('projects the accepted and rejected command-v4 branches', () => {
    const doctor = executeDoctorCommandContext({
      commandAuthority: DOCTOR_COMMAND_STATUS_AUTHORITY,
      checks: DOCTOR_COMMAND_CHECKS.map((check) => ({
        checkId: check.checkId,
        authorityState: 'current' as const,
        matched: true,
        actual: { observed: check.checkId },
      })),
      evidence: DOCTOR_COMMAND_REQUIRED_EVIDENCE.map((evidenceId) => ({
        evidenceId,
        availability: 'authoritative' as const,
      })),
      cleanupSucceeded: true,
    });
    if (doctor.record === null) throw new Error('expected a Doctor command record');
    const assembled = assembleFinalPublicCommandRecordV4({
      command: doctor.record,
      runId: 'fixture-command-run-20260918T000000Z-000001',
      behaviorOutcome: doctor.behaviorOutcome,
      finalOutcome: doctor.finalOutcome,
      launch: {
        attempted: false,
        pid: null,
        processGroupId: null,
        readinessMs: null,
        serverLogArtifactId: null,
      },
      ownership: {
        status: 'not-established',
        runId: 'fixture-command-run-20260918T000000Z-000001',
        allocationFailureCode: 'OWNERSHIP_UNKNOWN',
        requestedPort: null,
      },
      cleanup: null,
      diagnostics: [],
      runError: null,
      recordedAt: '2026-09-18T00:00:00.000Z',
    });
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) throw new Error('expected an assembled public command record');
    const result = readFinalPublicRecord(assembled.record);
    expect(result.kind).toBe('command-v4');
    expect(result.issues).toEqual([]);
    expectProjectedReaderIssues(result, RUN_SOURCES);

    // A bounded command-shaped record is rejected, and every emitted command
    // agreement issue still projects through the closed mapping.
    const invalidCommand = readFinalPublicRecord({
      schemaVersion: 4,
      command: 'doctor',
      commandAuthority: { schemaVersion: 4, command: 'doctor' },
      checks: [],
    });
    expect(invalidCommand.kind).toBe('invalid');
    expect(invalidCommand.issues.length).toBeGreaterThan(0);
    expectProjectedReaderIssues(invalidCommand, RUN_SOURCES);
  });

  it('projects the accepted suite-v2 and labelled legacy-suite branches', () => {
    const current = readFinalSuiteRecord(readJson('committed-suite/suite-record.json'));
    expect(current.kind).toBe('suite-v2');
    expect(current.issues).toEqual([]);
    expectProjectedReaderIssues(current, SUITE_SOURCES);

    const legacySuite = readFinalSuiteRecord({ schemaVersion: 1, command: 'diagnostic' });
    expect(legacySuite.kind).toBe('legacy-suite-v1');
    expect(legacySuite.issues).toEqual([]);
    expectProjectedReaderIssues(legacySuite, SUITE_SOURCES);
  });

  it('projects invalid-suite and nested child/identity/alias/lineage failures', () => {
    const invalid = readFinalSuiteRecord({ schemaVersion: 2 });
    expect(invalid.kind).toBe('invalid');
    expect(invalid.issues.map((entry) => entry.code)).toContain('SUITE_RECORD_MISSING_KEY');
    expectProjectedReaderIssues(invalid, SUITE_SOURCES);

    const base = cloneFixture('committed-suite/suite-record.json');
    const mutations: ReadonlyArray<
      readonly [string, (record: Record<string, unknown>) => void, string]
    > = [
      [
        'nested child invalid',
        (record) => {
          (record.children as unknown[])[0] = 42;
        },
        'SUITE_RECORD_CHILD_INVALID',
      ],
      [
        'child not strict v4',
        (record) => {
          (record.children as Record<string, unknown>[])[0].childRecordSchemaVersion = 3;
        },
        'SUITE_RECORD_CHILD_NOT_STRICT_V4',
      ],
      [
        'child identity mismatch',
        (record) => {
          (record.children as Record<string, unknown>[])[0].materializationFingerprint =
            'not-a-fingerprint';
        },
        'SUITE_RECORD_CHILD_IDENTITY_MISMATCH',
      ],
      [
        'child execution aliased',
        (record) => {
          const child = (record.children as Record<string, unknown>[])[0];
          child.executionId = child.runId;
        },
        'SUITE_RECORD_CHILD_EXECUTION_ALIASED',
      ],
      [
        'child lineage mismatch',
        (record) => {
          (record.children as Record<string, unknown>[])[0].parentSuiteExecutionId =
            'other-suite-execution';
        },
        'SUITE_RECORD_LINEAGE_MISMATCH',
      ],
      [
        'child duplicate',
        (record) => {
          const children = record.children as Record<string, unknown>[];
          const copy = JSON.parse(JSON.stringify(children[0])) as Record<string, unknown>;
          copy.order = 2;
          children.push(copy);
          record.executedCount = 2;
          record.declaredCaseCount = 2;
          record.canonicalOrder = [1, 2];
        },
        'SUITE_RECORD_CHILD_DUPLICATE',
      ],
    ];

    for (const [label, mutate, expectedCode] of mutations) {
      const record = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
      mutate(record);
      const result = readFinalSuiteRecord(record);
      expect(result.kind, label).toBe('invalid');
      expect(
        result.issues.map((entry) => entry.code),
        label,
      ).toContain(expectedCode);
      expectProjectedReaderIssues(result, SUITE_SOURCES);
    }
  });
});

// ── 11. P8-B WP-B1 — read-only run verifier core ─────────────────────────────

/**
 * WP-B1 core proof (ADR 0048; plan §8–§12). Every case runs against an isolated
 * copy inside a unique OS-temporary directory resolved through the injected
 * no-follow read-only adapter. The five checked-in fixtures and every accepted
 * evidence root are never touched.
 */
const B1_RUN_ID = 'fixture-committed-run-20260918T000000Z-000001';
const B1_COMMITTED_FILES = [
  'intended-inventory.json',
  'final-manifest.json',
  'run-record.json',
] as const;
const B1_TEMP_DIRS: string[] = [];
const B1_FIXTURE_HASHES = new Map<string, string>(
  FIXTURE_FILES.map((relative) => [
    relative,
    sha256(readFileSync(path.join(fixtureRoot, relative))),
  ]),
);

afterEach(() => {
  while (B1_TEMP_DIRS.length > 0) {
    rmSync(B1_TEMP_DIRS.pop() as string, { recursive: true, force: true });
  }
  for (const relative of FIXTURE_FILES) {
    expect(sha256(readFileSync(path.join(fixtureRoot, relative)))).toBe(
      B1_FIXTURE_HASHES.get(relative),
    );
  }
});

interface B1Harness {
  readonly runId: string;
  readonly tmp: string;
  readonly evidenceDir: string;
  readonly root: string;
}

function b1Setup(mutate?: (harness: B1Harness) => void, runId = B1_RUN_ID): B1Harness {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'p8b-b1-'));
  B1_TEMP_DIRS.push(tmp);
  const evidenceDir = path.join(tmp, 'evidence');
  const root = path.join(evidenceDir, 'runs', runId);
  mkdirSync(root, { recursive: true });
  for (const name of B1_COMMITTED_FILES) {
    writeFileSync(
      path.join(root, name),
      readFileSync(path.join(fixtureRoot, 'committed-run', name)),
    );
  }
  const harness: B1Harness = { runId, tmp, evidenceDir, root };
  if (mutate !== undefined) mutate(harness);
  return harness;
}

function b1Env(
  harness: B1Harness,
  overrides: Partial<EvidenceVerifyEnvironment> = {},
): EvidenceVerifyEnvironment {
  return {
    evidenceBaseDir: harness.evidenceDir,
    fs: createNodeEvidenceVerifyFsAdapter(),
    ...overrides,
  };
}

function b1Verify(
  harness: B1Harness,
  overrides: Partial<EvidenceVerifyEnvironment> = {},
): EvidenceVerifyDetails {
  return verifyEvidenceRoot({ requestedId: harness.runId }, b1Env(harness, overrides));
}

function b1ReadJson(harness: B1Harness, name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(harness.root, name), 'utf8')) as Record<string, unknown>;
}

function b1WriteJson(harness: B1Harness, name: string, value: unknown): void {
  writeFileSync(path.join(harness.root, name), JSON.stringify(value, null, 2));
}

function b1Valid(details: EvidenceVerifyDetails): void {
  expect(validateEvidenceVerifyDetails(details)).toEqual([]);
  for (const diagnostic of details.diagnostics) {
    expect(isAdvisoryVerifierCode(diagnostic.code)).toBe(diagnostic.severity === 'diagnostic');
  }
  const failureClass = details.transaction.failureClass;
  expect(
    failureClass === null ||
      failureClass === 'HARNESS_BLOCKED' ||
      failureClass === 'ENVIRONMENT_FAILURE',
  ).toBe(true);
}

function b1ExpectCode(
  details: EvidenceVerifyDetails,
  code: string,
  failureClass: 'ENVIRONMENT_FAILURE' | 'HARNESS_BLOCKED' = 'HARNESS_BLOCKED',
): void {
  b1Valid(details);
  expect(details.transaction.failureCode).toBe(code);
  expect(details.transaction.failureClass).toBe(failureClass);
  expect(details.transaction.creditEligible).toBe(false);
}

/** Re-declare one artifact's exact bytes so the committed metadata stays agreed. */
function b1RewriteRunRecord(
  harness: B1Harness,
  mutate: (record: Record<string, unknown>) => void,
): void {
  const record = b1ReadJson(harness, 'run-record.json');
  mutate(record);
  const bytes = new TextEncoder().encode(JSON.stringify(record, null, 2));
  writeFileSync(path.join(harness.root, 'run-record.json'), bytes);
  const inventory = b1ReadJson(harness, 'intended-inventory.json');
  const manifest = b1ReadJson(harness, 'final-manifest.json');
  const sha = sha256(bytes);
  const semantic = deriveSemanticDigest('canonical-json', record);
  const inventoryArtifact = (inventory.artifacts as Record<string, unknown>[])[0] as Record<
    string,
    unknown
  >;
  inventoryArtifact.byteLength = bytes.byteLength;
  inventoryArtifact.sha256 = sha;
  inventoryArtifact.semanticDigest = semantic;
  const committed = (manifest.committedArtifacts as Record<string, unknown>[])[0] as Record<
    string,
    unknown
  >;
  committed.byteLength = bytes.byteLength;
  committed.sha256 = sha;
  committed.semanticDigest = semantic;
  manifest.inventoryIdentity = deriveIntendedInventoryIdentity(
    inventory as unknown as Parameters<typeof deriveIntendedInventoryIdentity>[0],
  );
  b1WriteJson(harness, 'intended-inventory.json', inventory);
  b1WriteJson(harness, 'final-manifest.json', manifest);
}

describe('[P8-B/B1] run verifier core — valid committed run', () => {
  it('reports committed PASS with every persisted check passing', () => {
    const details = b1Verify(b1Setup());
    b1Valid(details);
    expect(details.scope).toBe('run');
    expect(details.rootKind).toBe('run');
    expect(details.rootRelativePath).toBe(`evidence/runs/${B1_RUN_ID}`);
    expect(details.transaction).toEqual({
      state: 'committed',
      failureClass: null,
      failureCode: null,
      commitPoint: 'committed',
      creditEligible: true,
      immutable: true,
      finalManifestPresent: true,
      finalManifestValid: true,
      strictRecordPresent: true,
      behaviorOutcome: 'PASS',
    });
    expect(details.checks.length).toBe(20);
    expect(details.checks.every((check) => check.result === 'PASS')).toBe(true);
    expect(details.artifacts).toEqual({
      declaredCount: 1,
      verifiedCount: 1,
      requiredCount: 1,
      diagnosticCount: 0,
      missingIds: [],
      extraRelativePaths: [],
    });
    expect(details.references).toEqual({ declaredCount: 0, verifiedCount: 0 });
    expect(details.provenance.persistedIdentityValid).toBe(true);
    expect(details.provenance.currentTreeCheck).toBe('not-run');
    expect(details.sanitization).toEqual({
      requiredApproved: true,
      diagnosticApproved: true,
      requiredAuthorityPreserved: true,
      prohibitedValuesFound: false,
    });
    expect(details.suite).toBeNull();
    expect(details.diagnostics).toEqual([]);
  });

  it('retains historical behaviorOutcome BUG as data while reporting PASS', () => {
    const harness = b1Setup();
    const manifest = b1ReadJson(harness, 'final-manifest.json');
    manifest.behaviorOutcome = 'BUG';
    b1WriteJson(harness, 'final-manifest.json', manifest);
    const details = b1Verify(harness);
    b1Valid(details);
    expect(details.transaction.state).toBe('committed');
    expect(details.transaction.failureCode).toBeNull();
    expect(details.transaction.creditEligible).toBe(true);
    expect(details.transaction.behaviorOutcome).toBe('BUG');
    expect(details.diagnostics).toEqual([]);
  });

  it('is deterministic across repeated reads of unchanged bytes', () => {
    const harness = b1Setup();
    const first = b1Verify(harness);
    const second = b1Verify(harness);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('reports current-tree DRIFT as an advisory PASS with no current-tree credit', () => {
    const harness = b1Setup();
    const details = b1Verify(harness, { currentTree: () => ({ currentTreeCheck: 'DRIFT' }) });
    b1Valid(details);
    expect(details.transaction.state).toBe('committed');
    expect(details.transaction.failureCode).toBeNull();
    expect(details.transaction.failureClass).toBeNull();
    expect(details.transaction.creditEligible).toBe(true);
    expect(details.provenance.currentTreeCheck).toBe('DRIFT');
    expect(details.provenance.currentTreeCreditEligible).toBe(false);
    expect(details.provenance.persistedIdentityValid).toBe(true);
    expect(details.diagnostics.map((entry) => entry.code)).toEqual([
      'VERIFY_PROVENANCE_CURRENT_DRIFT',
    ]);
  });

  it('reports advisory current-tree UNAVAILABLE without ENVIRONMENT_FAILURE', () => {
    const harness = b1Setup();
    const details = b1Verify(harness, {
      currentTree: () => {
        throw new EvidenceVerifyExternalFsError('EIO', 'optional collector unavailable');
      },
    });
    b1Valid(details);
    expect(details.transaction.failureClass).toBeNull();
    expect(details.transaction.creditEligible).toBe(true);
    expect(details.provenance.currentTreeCheck).toBe('UNAVAILABLE');
    expect(details.provenance.currentTreeCreditEligible).toBe(false);
    expect(details.provenance.persistedIdentityValid).toBe(true);
    expect(details.diagnostics.map((entry) => entry.code)).toEqual([
      'VERIFY_PROVENANCE_CURRENT_UNAVAILABLE',
    ]);
  });
});

describe('[P8-B/B1] run verifier core — atomic hostile rows', () => {
  it('detects a missing artifact and records its id', () => {
    const harness = b1Setup();
    rmSync(path.join(harness.root, 'run-record.json'));
    const details = b1Verify(harness);
    expect(details.transaction.state).toBe('committed');
    expect(details.artifacts.missingIds).toEqual(['artifact:run-record']);
    b1ExpectCode(details, 'VERIFY_ARTIFACT_MISSING');
  });

  it('detects an extra regular file and an extra binary file', () => {
    const text = b1Setup();
    writeFileSync(path.join(text.root, 'server.log'), 'not evidence');
    const textDetails = b1Verify(text);
    expect(textDetails.artifacts.extraRelativePaths).toEqual(['server.log']);
    b1ExpectCode(textDetails, 'VERIFY_ARTIFACT_EXTRA');

    const binary = b1Setup();
    writeFileSync(path.join(binary.root, 'tmp.bin'), new Uint8Array([0, 1, 2, 3]));
    const binaryDetails = b1Verify(binary);
    expect(binaryDetails.artifacts.extraRelativePaths).toEqual(['tmp.bin']);
    b1ExpectCode(binaryDetails, 'VERIFY_ARTIFACT_EXTRA');
  });

  it('detects a byte-length mismatch and a SHA-256 mismatch', () => {
    const truncated = b1Setup();
    const original = readFileSync(path.join(truncated.root, 'run-record.json'));
    writeFileSync(
      path.join(truncated.root, 'run-record.json'),
      original.subarray(0, original.length - 8),
    );
    b1ExpectCode(b1Verify(truncated), 'VERIFY_ARTIFACT_LENGTH_MISMATCH');

    const flipped = b1Setup();
    const bytes = readFileSync(path.join(flipped.root, 'run-record.json'));
    bytes[10] = (bytes[10] as number) ^ 1;
    writeFileSync(path.join(flipped.root, 'run-record.json'), bytes);
    b1ExpectCode(b1Verify(flipped), 'VERIFY_ARTIFACT_SHA256_MISMATCH');
  });

  it('detects a semantic-digest-only mismatch with exactly one code', () => {
    const harness = b1Setup();
    const inventory = b1ReadJson(harness, 'intended-inventory.json');
    const manifest = b1ReadJson(harness, 'final-manifest.json');
    const wrong = 'a'.repeat(64);
    (
      (inventory.artifacts as Record<string, unknown>[])[0] as Record<string, unknown>
    ).semanticDigest = wrong;
    (
      (manifest.committedArtifacts as Record<string, unknown>[])[0] as Record<string, unknown>
    ).semanticDigest = wrong;
    manifest.inventoryIdentity = deriveIntendedInventoryIdentity(
      inventory as unknown as Parameters<typeof deriveIntendedInventoryIdentity>[0],
    );
    b1WriteJson(harness, 'intended-inventory.json', inventory);
    b1WriteJson(harness, 'final-manifest.json', manifest);
    const details = b1Verify(harness);
    expect(new Set(details.diagnostics.map((entry) => entry.code))).toEqual(
      new Set(['VERIFY_ARTIFACT_SEMANTIC_DIGEST_MISMATCH']),
    );
    expect(details.transaction.state).toBe('committed');
    b1ExpectCode(details, 'VERIFY_ARTIFACT_SEMANTIC_DIGEST_MISMATCH');
  });

  it('detects a dangling consumedBy id and an unknown reference endpoint', () => {
    const dangling = b1Setup();
    const danglingInventory = b1ReadJson(dangling, 'intended-inventory.json');
    const danglingManifest = b1ReadJson(dangling, 'final-manifest.json');
    (
      (danglingInventory.artifacts as Record<string, unknown>[])[0] as Record<string, unknown>
    ).consumedBy = ['artifact:ghost'];
    danglingManifest.inventoryIdentity = deriveIntendedInventoryIdentity(
      danglingInventory as unknown as Parameters<typeof deriveIntendedInventoryIdentity>[0],
    );
    b1WriteJson(dangling, 'intended-inventory.json', danglingInventory);
    b1WriteJson(dangling, 'final-manifest.json', danglingManifest);
    b1ExpectCode(b1Verify(dangling), 'VERIFY_REFERENCE_DANGLING');

    const unknown = b1Setup();
    const unknownManifest = b1ReadJson(unknown, 'final-manifest.json');
    unknownManifest.references = [
      {
        fromArtifactId: 'artifact:run-record',
        toArtifactId: 'artifact:ghost',
        kind: 'derives',
        order: null,
      },
    ];
    b1WriteJson(unknown, 'final-manifest.json', unknownManifest);
    b1ExpectCode(b1Verify(unknown), 'VERIFY_REFERENCE_UNKNOWN_ID');
  });

  it('detects unknown schema, unknown label, and unknown discriminant', () => {
    const schema = b1Setup();
    const schemaInventory = b1ReadJson(schema, 'intended-inventory.json');
    schemaInventory.schemaVersion = 99;
    b1WriteJson(schema, 'intended-inventory.json', schemaInventory);
    const schemaDetails = b1Verify(schema);
    expect(schemaDetails.transaction.state).toBe('invalid-transaction');
    b1ExpectCode(schemaDetails, 'VERIFY_UNKNOWN_SCHEMA');

    const label = b1Setup();
    const labelManifest = b1ReadJson(label, 'final-manifest.json');
    labelManifest.label = 'final-manifest.v9';
    b1WriteJson(label, 'final-manifest.json', labelManifest);
    b1ExpectCode(b1Verify(label), 'VERIFY_UNKNOWN_LABEL');

    const discriminant = b1Setup();
    const discriminantInventory = b1ReadJson(discriminant, 'intended-inventory.json');
    const discriminantManifest = b1ReadJson(discriminant, 'final-manifest.json');
    (
      (discriminantInventory.artifacts as Record<string, unknown>[])[0] as Record<string, unknown>
    ).role = 'bogus-role';
    discriminantManifest.inventoryIdentity = deriveIntendedInventoryIdentity(
      discriminantInventory as unknown as Parameters<typeof deriveIntendedInventoryIdentity>[0],
    );
    b1WriteJson(discriminant, 'intended-inventory.json', discriminantInventory);
    b1WriteJson(discriminant, 'final-manifest.json', discriminantManifest);
    b1ExpectCode(b1Verify(discriminant), 'VERIFY_UNKNOWN_DISCRIMINANT');
  });

  it('detects weakened, missing, and redacted required authority', () => {
    const weakened = b1Setup();
    const weakenedInventory = b1ReadJson(weakened, 'intended-inventory.json');
    const weakenedManifest = b1ReadJson(weakened, 'final-manifest.json');
    (
      (weakenedInventory.artifacts as Record<string, unknown>[])[0] as Record<string, unknown>
    ).role = 'diagnostic-only';
    weakenedManifest.inventoryIdentity = deriveIntendedInventoryIdentity(
      weakenedInventory as unknown as Parameters<typeof deriveIntendedInventoryIdentity>[0],
    );
    b1WriteJson(weakened, 'intended-inventory.json', weakenedInventory);
    b1WriteJson(weakened, 'final-manifest.json', weakenedManifest);
    b1ExpectCode(b1Verify(weakened), 'VERIFY_REQUIRED_AUTHORITY_WEAKENED');

    const missing = b1Setup();
    const missingManifest = b1ReadJson(missing, 'final-manifest.json');
    missingManifest.committedArtifacts = [];
    b1WriteJson(missing, 'final-manifest.json', missingManifest);
    b1ExpectCode(b1Verify(missing), 'VERIFY_REQUIRED_AUTHORITY_MISSING');

    const redacted = b1Setup();
    const redactedInventory = b1ReadJson(redacted, 'intended-inventory.json');
    const redactedManifest = b1ReadJson(redacted, 'final-manifest.json');
    const redactedArtifact = (
      redactedInventory.artifacts as Record<string, unknown>[]
    )[0] as Record<string, unknown>;
    redactedArtifact.semanticDigest = null;
    redactedArtifact.semanticDigestKind = null;
    (
      (redactedManifest.committedArtifacts as Record<string, unknown>[])[0] as Record<
        string,
        unknown
      >
    ).semanticDigest = null;
    redactedManifest.inventoryIdentity = deriveIntendedInventoryIdentity(
      redactedInventory as unknown as Parameters<typeof deriveIntendedInventoryIdentity>[0],
    );
    b1WriteJson(redacted, 'intended-inventory.json', redactedInventory);
    b1WriteJson(redacted, 'final-manifest.json', redactedManifest);
    b1ExpectCode(b1Verify(redacted), 'VERIFY_REQUIRED_AUTHORITY_REDACTED');
  });

  it('detects secret/authorization, absolute/private path, and customer markers', () => {
    const secret = b1Setup();
    b1RewriteRunRecord(secret, (record) => {
      record.authorizationToken = 'sk-ABCDEFGHIJKLMNOPQRSTUVWX';
    });
    const secretDetails = b1Verify(secret);
    expect(secretDetails.transaction.state).toBe('committed');
    b1ExpectCode(secretDetails, 'VERIFY_SECRET_OR_AUTHORIZATION_MARKER');
    expect(JSON.stringify(secretDetails)).not.toContain('sk-ABCDEFGHIJKLMNOPQRSTUVWX');

    const pathDetails = (() => {
      const harness = b1Setup();
      const manifest = b1ReadJson(harness, 'final-manifest.json');
      manifest.note = '/private/var/folders/p8b-secret';
      b1WriteJson(harness, 'final-manifest.json', manifest);
      return b1Verify(harness);
    })();
    expect(pathDetails.transaction.state).toBe('invalid-transaction');
    b1ExpectCode(pathDetails, 'VERIFY_PRIVATE_OR_ABSOLUTE_PATH');
    expect(JSON.stringify(pathDetails)).not.toContain('/private/var');

    const customer = b1Setup();
    b1RewriteRunRecord(customer, (record) => {
      record.customerEmail = 'customer@example.com';
    });
    const customerDetails = b1Verify(customer);
    expect(customerDetails.transaction.state).toBe('committed');
    b1ExpectCode(customerDetails, 'VERIFY_PRODUCTION_CUSTOMER_MARKER');
    expect(JSON.stringify(customerDetails)).not.toContain('customer@example.com');
  });

  it('detects a persisted provenance identity mismatch', () => {
    const harness = b1Setup();
    const manifest = b1ReadJson(harness, 'final-manifest.json');
    manifest.provenanceIdentity = 'a'.repeat(64);
    b1WriteJson(harness, 'final-manifest.json', manifest);
    const details = b1Verify(harness);
    expect(details.transaction.state).toBe('committed');
    expect(details.provenance.persistedIdentityValid).toBe(false);
    b1ExpectCode(details, 'VERIFY_PROVENANCE_IDENTITY_MISMATCH');
  });

  it('rejects a symlink and a non-regular declared artifact without following it', () => {
    const symlink = b1Setup();
    const symlinkPath = path.join(symlink.root, 'run-record.json');
    rmSync(symlinkPath);
    symlinkSync(path.join(symlink.root, 'intended-inventory.json'), symlinkPath);
    b1ExpectCode(b1Verify(symlink), 'VERIFY_ARTIFACT_SYMLINK');

    const nonRegular = b1Setup();
    const directoryPath = path.join(nonRegular.root, 'run-record.json');
    rmSync(directoryPath);
    mkdirSync(directoryPath);
    b1ExpectCode(b1Verify(nonRegular), 'VERIFY_ARTIFACT_SYMLINK');
  });

  it('rejects a path-traversal declared artifact path', () => {
    const harness = b1Setup();
    const manifest = b1ReadJson(harness, 'final-manifest.json');
    (
      (manifest.committedArtifacts as Record<string, unknown>[])[0] as Record<string, unknown>
    ).relativePath = '../escape/run-record.json';
    b1WriteJson(harness, 'final-manifest.json', manifest);
    b1ExpectCode(b1Verify(harness), 'VERIFY_ARTIFACT_PATH_INVALID');
  });

  it('detects a post-read metadata mutation', () => {
    const harness = b1Setup();
    const real = createNodeEvidenceVerifyFsAdapter();
    const target = path.join(harness.root, 'run-record.json');
    let mutated = false;
    const fs = {
      ...real,
      readFile: (absolutePath: string): Uint8Array => {
        const bytes = real.readFile(absolutePath);
        if (!mutated && absolutePath === target) {
          mutated = true;
          writeFileSync(
            absolutePath,
            new TextEncoder().encode(`${new TextDecoder().decode(bytes)} `),
          );
        }
        return bytes;
      },
    };
    b1ExpectCode(b1Verify(harness, { fs }), 'VERIFY_POST_FINALIZATION_MUTATION');
  });

  it('maps a proven external read failure to ENVIRONMENT_FAILURE', () => {
    const harness = b1Setup();
    const real = createNodeEvidenceVerifyFsAdapter();
    const fs = {
      ...real,
      readFile: (absolutePath: string): Uint8Array => {
        if (absolutePath.endsWith('run-record.json')) {
          throw new EvidenceVerifyExternalFsError('EIO', 'injected external read failure');
        }
        return real.readFile(absolutePath);
      },
    };
    const details = b1Verify(harness, { fs });
    b1ExpectCode(details, 'VERIFY_EXTERNAL_READ_FAILURE', 'ENVIRONMENT_FAILURE');
    expect(details.transaction.state).toBe('committed');
  });

  it('maps an unknown throw to HARNESS_BLOCKED without raw passthrough', () => {
    const harness = b1Setup();
    const real = createNodeEvidenceVerifyFsAdapter();
    const fs = {
      ...real,
      readFile: (): Uint8Array => {
        throw 'not-an-Error';
      },
    };
    const details = b1Verify(harness, { fs });
    b1ExpectCode(details, 'VERIFY_UNKNOWN_FAILURE');
    expect(JSON.stringify(details)).not.toContain('not-an-Error');
  });

  it('prefers HARNESS_BLOCKED when a harness fault and a read failure are mixed', () => {
    const harness = b1Setup();
    writeFileSync(path.join(harness.root, 'server.log'), 'x');
    const real = createNodeEvidenceVerifyFsAdapter();
    const fs = {
      ...real,
      readFile: (absolutePath: string): Uint8Array => {
        if (absolutePath.endsWith('final-manifest.json')) {
          throw new EvidenceVerifyExternalFsError('EIO', 'injected external read failure');
        }
        return real.readFile(absolutePath);
      },
    };
    const details = b1Verify(harness, { fs });
    b1Valid(details);
    expect(details.transaction.failureClass).toBe('HARNESS_BLOCKED');
    expect(details.transaction.failureCode).toBe('VERIFY_ARTIFACT_EXTRA');
  });
});

describe('[P8-B/B1] run verifier core — transaction classification', () => {
  it('classifies a partial transaction (inventory without manifest)', () => {
    const harness = b1Setup();
    rmSync(path.join(harness.root, 'final-manifest.json'));
    const details = b1Verify(harness);
    expect(details.transaction.state).toBe('partial-transaction');
    expect(details.transaction.immutable).toBe(true);
    expect(details.transaction.commitPoint).toBe('not-committed');
    b1ExpectCode(details, 'VERIFY_PARTIAL_NO_MANIFEST');
  });

  it('classifies an invalid transaction and never repairs it', () => {
    const harness = b1Setup();
    writeFileSync(path.join(harness.root, 'intended-inventory.json'), '{ not json');
    const details = b1Verify(harness);
    expect(details.transaction.state).toBe('invalid-transaction');
    b1ExpectCode(details, 'VERIFY_JSON_INVALID');
    expect(readFileSync(path.join(harness.root, 'intended-inventory.json'), 'utf8')).toBe(
      '{ not json',
    );
  });

  it('classifies a labelled historical record as legacy-unverifiable', () => {
    const harness = b1Setup();
    rmSync(path.join(harness.root, 'final-manifest.json'));
    rmSync(path.join(harness.root, 'intended-inventory.json'));
    const runId = 'fixture-legacy-run-20260101T000000Z-000001';
    const root = path.join(harness.evidenceDir, 'runs', runId);
    mkdirSync(root, { recursive: true });
    writeFileSync(
      path.join(root, 'run-record.json'),
      readFileSync(path.join(fixtureRoot, 'legacy-run', 'run-record.json')),
    );
    const details = verifyEvidenceRoot({ requestedId: runId }, b1Env(harness));
    expect(details.transaction.state).toBe('legacy-unverifiable');
    expect(details.transaction.creditEligible).toBe(false);
    b1ExpectCode(details, 'VERIFY_LEGACY_UNVERIFIABLE');
    expect(readdirSync(root)).toEqual(['run-record.json']);
  });

  it('classifies a strict current-v4 record without Package-8 documents as legacy-unverifiable', () => {
    const harness = b1Setup();
    rmSync(path.join(harness.root, 'final-manifest.json'));
    rmSync(path.join(harness.root, 'intended-inventory.json'));
    const details = b1Verify(harness);
    expect(details.transaction.state).toBe('legacy-unverifiable');
    expect(details.transaction.strictRecordPresent).toBe(true);
    b1ExpectCode(details, 'VERIFY_LEGACY_UNVERIFIABLE');
  });

  it('classifies an unsupported legacy filename candidate as no-transaction', () => {
    const harness = b1Setup();
    rmSync(path.join(harness.root, 'final-manifest.json'));
    rmSync(path.join(harness.root, 'intended-inventory.json'));
    rmSync(path.join(harness.root, 'run-record.json'));
    writeFileSync(path.join(harness.root, 'result.json'), '{}');
    writeFileSync(path.join(harness.root, 'manifest.json'), '{}');
    const details = b1Verify(harness);
    expect(details.transaction.state).toBe('no-transaction');
    expect(details.transaction.creditEligible).toBe(false);
    expect(details.artifacts.extraRelativePaths).toEqual([]);
    b1Valid(details);
  });

  it('classifies an empty root as no-transaction without inventing evidence', () => {
    const harness = b1Setup();
    rmSync(path.join(harness.root, 'final-manifest.json'));
    rmSync(path.join(harness.root, 'intended-inventory.json'));
    rmSync(path.join(harness.root, 'run-record.json'));
    const details = b1Verify(harness);
    expect(details.transaction.state).toBe('no-transaction');
    b1Valid(details);
  });

  it('resolves not-found, ambiguous, and non-root roots deterministically', () => {
    const empty = b1Setup();
    const notFound = verifyEvidenceRoot({ requestedId: 'absent-run-id' }, b1Env(empty));
    b1ExpectCode(notFound, 'VERIFY_ROOT_NOT_FOUND');

    const ambiguous = b1Setup();
    mkdirSync(path.join(ambiguous.evidenceDir, 'suites', B1_RUN_ID), { recursive: true });
    b1ExpectCode(b1Verify(ambiguous), 'VERIFY_ID_AMBIGUOUS');

    const fileRoot = b1Setup();
    rmSync(fileRoot.root, { recursive: true });
    writeFileSync(fileRoot.root, 'not a directory');
    b1ExpectCode(b1Verify(fileRoot), 'VERIFY_NOT_A_ROOT');

    const symlinkRoot = b1Setup();
    const symlinkTarget = path.join(symlinkRoot.tmp, 'elsewhere');
    mkdirSync(symlinkTarget);
    rmSync(symlinkRoot.root, { recursive: true });
    symlinkSync(symlinkTarget, symlinkRoot.root);
    b1ExpectCode(b1Verify(symlinkRoot), 'VERIFY_NOT_A_ROOT');
  });

  it('never silently prefers a suite root and does not activate it', () => {
    const harness = b1Setup();
    const suiteId = 'fixture-suite-execution-20260918T000100Z-000001';
    const suiteRoot = path.join(harness.evidenceDir, 'suites', suiteId);
    mkdirSync(suiteRoot, { recursive: true });
    writeFileSync(
      path.join(suiteRoot, 'suite-record.json'),
      readFileSync(path.join(fixtureRoot, 'committed-suite', 'suite-record.json')),
    );
    const details = verifyEvidenceRoot({ requestedId: suiteId }, b1Env(harness));
    b1Valid(details);
    expect(details.scope).toBe('suite');
    expect(details.suite?.suiteTransactionActivation).toBe('deferred-not-activated');
    expect(readdirSync(suiteRoot)).toEqual(['suite-record.json']);
  });
});

describe('[P8-B/B1] run verifier core — read, parse, and no-write closure', () => {
  it('reads each JSON input exactly once through the injected adapter', () => {
    const harness = b1Setup();
    const real = createNodeEvidenceVerifyFsAdapter();
    expect(Object.keys(real).sort()).toEqual(['lstat', 'readFile', 'readdir']);
    const reads = new Map<string, number>();
    const fs = {
      ...real,
      readFile: (absolutePath: string): Uint8Array => {
        reads.set(absolutePath, (reads.get(absolutePath) ?? 0) + 1);
        return real.readFile(absolutePath);
      },
    };
    const details = b1Verify(harness, { fs });
    expect(details.transaction.state).toBe('committed');
    expect(reads.size).toBe(3);
    for (const count of reads.values()) expect(count).toBe(1);
  });

  it('exposes no write, cleanup, publication, or wrapper call edge', () => {
    const source = readSource('.pi/skills/verify-artwork-editor/src/evidence/integrity.ts');
    for (const token of [
      'writeFileSync',
      'writeFile(',
      'mkdirSync',
      'renameSync',
      'unlinkSync',
      'rmSync',
      'rmdirSync',
      'appendFileSync',
      'chmodSync',
      'truncateSync',
      'copyFileSync',
      'createWriteStream',
      'writeSync',
    ]) {
      expect(source.includes(token), token).toBe(false);
    }
    expect(source.includes('readFinalPublicRecordFile')).toBe(false);
    expect(source.includes('readFinalSuiteRecordFile')).toBe(false);
    expect(source.includes('readFileSync')).toBe(false);
    expect(source.includes('O_NOFOLLOW')).toBe(true);
    expect(source.includes('O_RDONLY')).toBe(true);
  });
});

describe('[P8-B/B1] run verifier core — root containment before any read', () => {
  it('rejects a symlinked runs parent before reading any transaction bytes', () => {
    const harness = b1Setup();
    const decoy = path.join(harness.tmp, 'decoy-runs');
    mkdirSync(path.join(decoy, harness.runId), { recursive: true });
    for (const name of B1_COMMITTED_FILES) {
      writeFileSync(
        path.join(decoy, harness.runId, name),
        readFileSync(path.join(fixtureRoot, 'committed-run', name)),
      );
    }
    rmSync(path.join(harness.evidenceDir, 'runs'), { recursive: true, force: true });
    symlinkSync(decoy, path.join(harness.evidenceDir, 'runs'));

    const real = createNodeEvidenceVerifyFsAdapter();
    let reads = 0;
    const fs = {
      ...real,
      readFile: (absolutePath: string): Uint8Array => {
        reads += 1;
        return real.readFile(absolutePath);
      },
    };
    const details = b1Verify(harness, { fs });
    b1ExpectCode(details, 'VERIFY_NOT_A_ROOT');
    expect(reads).toBe(0);
  });

  it('rejects a symlinked evidence base before reading any transaction bytes', () => {
    const harness = b1Setup();
    const realBase = path.join(harness.tmp, 'real-evidence');
    mkdirSync(path.join(realBase, 'runs', harness.runId), { recursive: true });
    for (const name of B1_COMMITTED_FILES) {
      writeFileSync(
        path.join(realBase, 'runs', harness.runId, name),
        readFileSync(path.join(fixtureRoot, 'committed-run', name)),
      );
    }
    rmSync(harness.evidenceDir, { recursive: true, force: true });
    symlinkSync(realBase, harness.evidenceDir);

    const real = createNodeEvidenceVerifyFsAdapter();
    let reads = 0;
    const fs = {
      ...real,
      readFile: (absolutePath: string): Uint8Array => {
        reads += 1;
        return real.readFile(absolutePath);
      },
    };
    const details = b1Verify(harness, { fs });
    b1ExpectCode(details, 'VERIFY_NOT_A_ROOT');
    expect(reads).toBe(0);
  });

  it('rejects a non-directory runs ancestor', () => {
    const harness = b1Setup();
    rmSync(path.join(harness.evidenceDir, 'runs'), { recursive: true, force: true });
    writeFileSync(path.join(harness.evidenceDir, 'runs'), 'not a directory');
    b1ExpectCode(b1Verify(harness), 'VERIFY_NOT_A_ROOT');
  });

  it('rejects a traversal-shaped request id before touching the filesystem', () => {
    const harness = b1Setup();
    const real = createNodeEvidenceVerifyFsAdapter();
    let calls = 0;
    const fs = {
      ...real,
      lstat: (absolutePath: string): ReturnType<typeof real.lstat> => {
        calls += 1;
        return real.lstat(absolutePath);
      },
    };
    expect(() => verifyEvidenceRoot({ requestedId: '../escape' }, b1Env(harness, { fs }))).toThrow(
      EvidenceVerifyRequestError,
    );
    expect(calls).toBe(0);
  });
});

describe('[P8-B/B1] run verifier core — disappearance after enumeration', () => {
  it('treats a read-time ENOENT on a transaction document as a blocking mutation', () => {
    const harness = b1Setup();
    const real = createNodeEvidenceVerifyFsAdapter();
    const reads = new Map<string, number>();
    const fs = {
      ...real,
      readFile: (absolutePath: string): Uint8Array => {
        reads.set(absolutePath, (reads.get(absolutePath) ?? 0) + 1);
        if (absolutePath.endsWith('intended-inventory.json')) {
          const error = new Error('document disappeared') as Error & { code: string };
          error.code = 'ENOENT';
          throw error;
        }
        return real.readFile(absolutePath);
      },
    };
    const details = b1Verify(harness, { fs });
    b1ExpectCode(details, 'VERIFY_POST_FINALIZATION_MUTATION');
    expect(details.transaction.creditEligible).toBe(false);
    // No retry: the disappeared document is read at most once.
    expect(reads.get(path.join(harness.root, 'intended-inventory.json'))).toBe(1);
  });

  it('treats a read-time ENOENT on a declared artifact as a blocking mutation', () => {
    const harness = b1Setup();
    const real = createNodeEvidenceVerifyFsAdapter();
    let runRecordReads = 0;
    const fs = {
      ...real,
      readFile: (absolutePath: string): Uint8Array => {
        if (absolutePath.endsWith('run-record.json')) {
          runRecordReads += 1;
          const error = new Error('artifact disappeared') as Error & { code: string };
          error.code = 'ENOENT';
          throw error;
        }
        return real.readFile(absolutePath);
      },
    };
    const details = b1Verify(harness, { fs });
    b1ExpectCode(details, 'VERIFY_POST_FINALIZATION_MUTATION');
    expect(runRecordReads).toBe(1);
  });

  it('treats a disappeared post-read stat as a blocking mutation', () => {
    const harness = b1Setup();
    const real = createNodeEvidenceVerifyFsAdapter();
    let runRecordStats = 0;
    const fs = {
      ...real,
      lstat: (absolutePath: string): ReturnType<typeof real.lstat> => {
        if (absolutePath.endsWith('run-record.json')) {
          runRecordStats += 1;
          if (runRecordStats >= 2) return null;
        }
        return real.lstat(absolutePath);
      },
    };
    const details = b1Verify(harness, { fs });
    b1ExpectCode(details, 'VERIFY_POST_FINALIZATION_MUTATION');
    expect(runRecordStats).toBe(2);
  });
});

describe('[P8-B/B1] run verifier core — exact allowed set and traversal bounds', () => {
  it('rejects an unexpected directory and its nested file exactly', () => {
    const harness = b1Setup();
    mkdirSync(path.join(harness.root, 'scratch'));
    writeFileSync(path.join(harness.root, 'scratch', 'nested.bin'), new Uint8Array([1, 2, 3]));
    const details = b1Verify(harness);
    b1ExpectCode(details, 'VERIFY_ARTIFACT_EXTRA');
    expect(details.artifacts.extraRelativePaths).toContain('scratch');
    expect(details.artifacts.extraRelativePaths).toContain('scratch/nested.bin');
  });

  it('rejects an extra empty directory', () => {
    const harness = b1Setup();
    mkdirSync(path.join(harness.root, 'unexpected-dir'));
    const details = b1Verify(harness);
    b1ExpectCode(details, 'VERIFY_ARTIFACT_EXTRA');
    expect(details.artifacts.extraRelativePaths).toEqual(['unexpected-dir']);
  });

  it('flags a traversal depth overflow instead of silently truncating', () => {
    const harness = b1Setup();
    const segments = Array.from(
      { length: EVIDENCE_VERIFY_MAX_TRAVERSAL_DEPTH + 1 },
      (_, index) => `d${index}`,
    );
    let current = harness.root;
    for (const segment of segments) {
      current = path.join(current, segment);
      mkdirSync(current);
    }
    const deepest = current;
    const real = createNodeEvidenceVerifyFsAdapter();
    const readdirPaths: string[] = [];
    const fs = {
      ...real,
      readdir: (absolutePath: string): ReturnType<typeof real.readdir> => {
        readdirPaths.push(absolutePath);
        return real.readdir(absolutePath);
      },
    };
    const details = b1Verify(harness, { fs });
    b1Valid(details);
    expect(details.transaction.creditEligible).toBe(false);
    expect(details.transaction.failureCode).toBe('VERIFY_ARTIFACT_EXTRA');
    // The traversal stops at the bound: the over-deep directory is never opened.
    expect(readdirPaths).not.toContain(deepest);
  });

  it('flags an entry-bound overflow instead of silently truncating enumeration', () => {
    const harness = b1Setup();
    const real = createNodeEvidenceVerifyFsAdapter();
    const total = EVIDENCE_VERIFY_MAX_ENUMERATED_ENTRIES + 8;
    const names = Array.from(
      { length: total },
      (_, index) => `zz-extra-${String(index).padStart(5, '0')}.log`,
    );
    const fakePaths = new Set(names.map((name) => path.join(harness.root, name)));
    let fakeStats = 0;
    const fileStat = { kind: 'file' as const, size: 0, mtimeMs: 1, ctimeMs: 1, ino: 1, dev: 1 };
    const fs = {
      ...real,
      readdir: (absolutePath: string): ReturnType<typeof real.readdir> =>
        absolutePath === harness.root
          ? names.map((name) => ({ name, kind: 'file' as const }))
          : real.readdir(absolutePath),
      lstat: (absolutePath: string): ReturnType<typeof real.lstat> => {
        if (fakePaths.has(absolutePath)) {
          fakeStats += 1;
          return fileStat;
        }
        return real.lstat(absolutePath);
      },
    };
    const details = b1Verify(harness, { fs });
    b1Valid(details);
    expect(details.transaction.creditEligible).toBe(false);
    expect(fakeStats).toBeGreaterThan(0);
    expect(fakeStats).toBeLessThanOrEqual(EVIDENCE_VERIFY_MAX_ENUMERATED_ENTRIES);
    expect(fakeStats).toBeLessThan(total);
  });

  it('flags an enumeration mutation when a dirent kind disagrees with lstat', () => {
    const harness = b1Setup();
    const real = createNodeEvidenceVerifyFsAdapter();
    const fs = {
      ...real,
      readdir: (absolutePath: string): ReturnType<typeof real.readdir> => {
        const dirents = real.readdir(absolutePath);
        if (absolutePath === harness.root) {
          return dirents.map((dirent) =>
            dirent.name === 'run-record.json'
              ? { name: dirent.name, kind: 'directory' as const }
              : dirent,
          );
        }
        return dirents;
      },
    };
    const details = b1Verify(harness, { fs });
    b1Valid(details);
    expect(details.transaction.creditEligible).toBe(false);
    expect(details.transaction.failureCode).toBe('VERIFY_POST_FINALIZATION_MUTATION');
  });
});

describe('[P8-B/B1] run verifier core — no-follow capability', () => {
  it('feature-detects the platform no-follow guarantee', () => {
    const capability = detectNodeNoFollowCapability();
    expect(['supported', 'unsupported']).toContain(capability.support);
  });

  it('fails closed when the adapter cannot honour a no-follow read', () => {
    expect(() => createNodeEvidenceVerifyFsAdapter({ support: 'unsupported' })).toThrow(
      EvidenceVerifyNoFollowUnsupportedError,
    );
    let caught: unknown = null;
    try {
      createNodeEvidenceVerifyFsAdapter({ support: 'unsupported' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EvidenceVerifyExternalFsError);
    expect((caught as Error).message).not.toContain('/');
  });

  it('refuses to read the filesystem when the declared capability is unsupported', () => {
    const harness = b1Setup();
    const real = createNodeEvidenceVerifyFsAdapter();
    let calls = 0;
    const fs = {
      lstat: (absolutePath: string): ReturnType<typeof real.lstat> => {
        calls += 1;
        return real.lstat(absolutePath);
      },
      readdir: (absolutePath: string): ReturnType<typeof real.readdir> => {
        calls += 1;
        return real.readdir(absolutePath);
      },
      readFile: (absolutePath: string): Uint8Array => {
        calls += 1;
        return real.readFile(absolutePath);
      },
    };
    const details = b1Verify(harness, {
      fs,
      noFollowCapability: { support: 'unsupported' },
    });
    b1ExpectCode(details, 'VERIFY_ROOT_UNREADABLE', 'ENVIRONMENT_FAILURE');
    expect(calls).toBe(0);
  });
});

describe('[P8-B/B1] run verifier core — prohibited scheme detection', () => {
  it('detects a blob:/file: scheme value while exempting a legitimate logical id', () => {
    const harness = b1Setup();
    const manifest = b1ReadJson(harness, 'final-manifest.json');
    manifest.exportRef = 'blob:opaque-handle-123';
    b1WriteJson(harness, 'final-manifest.json', manifest);
    b1ExpectCode(b1Verify(harness), 'VERIFY_PRIVATE_OR_ABSOLUTE_PATH');

    // The accepted committed fixture itself carries `profile:diagnostic`
    // provenance identities; the valid-run baseline proves they are not flagged.
    const baseline = b1Verify(b1Setup());
    expect(baseline.transaction.failureCode).toBeNull();
    expect(baseline.transaction.creditEligible).toBe(true);
  });
});

// ── 12. ADR 0051C — PNG IDAT privacy-scan alignment ─────────────────────────

/**
 * ADR 0051C amendment proof. For a non-JSON artifact declared `image/png` the
 * verifier keeps the accepted structural PNG inspection but privacy-scans only
 * the data payloads of non-`IDAT` chunks: PNG signature bytes, chunk
 * length/type framing, CRC bytes, and compressed `IDAT` payload bytes are
 * never decoded or privacy-scanned. Generic opaque artifacts keep the complete
 * full-byte scan and JSON artifacts keep the unchanged recursive scan. Every
 * case runs against an isolated OS-temporary copy and proves the tested root
 * stays byte-for-byte unchanged.
 */
// Escape-invariant composition of the demonstrated UNC-backslash form (two
// consecutive backslashes): composed from char codes so no tooling layer can
// silently halve the backslash run before the payload reaches the verifier.
const PNG_BACKSLASH = String.fromCharCode(92);
const UNC_BACKSLASH_VALUE = `img ${PNG_BACKSLASH}${PNG_BACKSLASH}secret-host${PNG_BACKSLASH}private-share tail`;
const UNC_BACKSLASH_METADATA = `metadata ${PNG_BACKSLASH}${PNG_BACKSLASH}secret-host${PNG_BACKSLASH}private-share tail`;
const PNG_CATEGORY_SAMPLES: readonly (readonly [string, string])[] = [
  ['UNC', UNC_BACKSLASH_VALUE],
  ['secret', 'img Bearer sk-ABCDEFGHIJKLMNOPQRSTUVWX tail'],
  ['customer', 'img customer@example.com tail'],
  ['private-root', 'img /private/var/folders/p8b-secret-root tail'],
  ['file:', 'img file:private-thing tail'],
  ['blob:', 'img blob:opaque-handle-123 tail'],
];

const PNG_PRIVATE_ROOTS: readonly string[] = [
  '/private/var/folders/p8b-secret-root',
  'registered-private-root',
];

const PNG_PROBE_VALUES: readonly string[] = [
  'secret-host',
  'private-share',
  'sk-ABCDEFGHIJKLMNOPQRSTUVWX',
  'customer@example.com',
  'p8b-secret-root',
  'private-thing',
  'opaque-handle-123',
  'registered-private-root',
];

function checkOf(details: EvidenceVerifyDetails, id: string) {
  return details.checks.find((check) => check.id === id);
}

/** Declare one extra diagnostic artifact; both documents stay artifactId-sorted. */
function b1AddDeclaredArtifact(
  harness: B1Harness,
  relativePath: string,
  mediaType: string,
  schema: string,
  bytes: Uint8Array,
): void {
  writeFileSync(path.join(harness.root, relativePath), bytes);
  const inventory = b1ReadJson(harness, 'intended-inventory.json');
  const manifest = b1ReadJson(harness, 'final-manifest.json');
  const entry: Record<string, unknown> = {
    artifactId: 'artifact:diagram',
    role: 'diagnostic-only',
    mediaType,
    schema,
    relativePath,
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
    semanticDigest: null,
    semanticDigestKind: null,
    producerPhase: 'observation',
    consumedBy: [],
    sanitizationPolicy: 'opaque-bytes-guard-v1',
    retentionStatus: 'eligible-later',
  };
  const committed: Record<string, unknown> = {
    artifactId: 'artifact:diagram',
    relativePath,
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
    semanticDigest: null,
  };
  const byId = (a: Record<string, unknown>, b: Record<string, unknown>): number =>
    String(a.artifactId) < String(b.artifactId) ? -1 : 1;
  inventory.artifacts = [...(inventory.artifacts as Record<string, unknown>[]), entry].sort(byId);
  manifest.committedArtifacts = [
    ...(manifest.committedArtifacts as Record<string, unknown>[]),
    committed,
  ].sort(byId);
  manifest.inventoryIdentity = deriveIntendedInventoryIdentity(
    inventory as unknown as Parameters<typeof deriveIntendedInventoryIdentity>[0],
  );
  b1WriteJson(harness, 'intended-inventory.json', inventory);
  b1WriteJson(harness, 'final-manifest.json', manifest);
}

function b1RootDigests(harness: B1Harness): Record<string, string> {
  const digests: Record<string, string> = {};
  for (const name of readdirSync(harness.root).sort()) {
    digests[name] = sha256(readFileSync(path.join(harness.root, name)));
  }
  return digests;
}

function b1ArtifactCase(
  bytes: Uint8Array,
  options: {
    readonly relativePath?: string;
    readonly mediaType?: string;
    readonly schema?: string;
    readonly forbiddenRoots?: readonly string[];
  } = {},
): EvidenceVerifyDetails {
  const harness = b1Setup();
  b1AddDeclaredArtifact(
    harness,
    options.relativePath ?? 'diagram.png',
    options.mediaType ?? 'image/png',
    options.schema ?? 'png',
    bytes,
  );
  const before = b1RootDigests(harness);
  const details = b1Verify(harness, {
    forbiddenRoots: options.forbiddenRoots ?? PNG_PRIVATE_ROOTS,
  });
  // ADR 0051C: verifier execution leaves every tested evidence root
  // byte-for-byte unchanged.
  expect(b1RootDigests(harness)).toEqual(before);
  b1Valid(details);
  return details;
}

function pngTextIdat(text: string, idat: string): Uint8Array {
  return buildPng([
    buildPngChunk('tEXt', utf8(text)),
    buildPngChunk('IDAT', utf8(idat)),
    buildPngChunk('IEND', new Uint8Array(0)),
  ]);
}

describe('[P8-B/B1] run verifier core — PNG IDAT privacy-scan alignment (ADR 0051C)', () => {
  it('passes a valid PNG whose prohibited-looking sequences occur only in IDAT payloads', () => {
    const combined = PNG_CATEGORY_SAMPLES.map(([, payload]) => payload).join(' ');
    const details = b1ArtifactCase(pngTextIdat('ordinary public metadata', combined));
    expect(details.transaction).toEqual({
      state: 'committed',
      failureClass: null,
      failureCode: null,
      commitPoint: 'committed',
      creditEligible: true,
      immutable: true,
      finalManifestPresent: true,
      finalManifestValid: true,
      strictRecordPresent: true,
      behaviorOutcome: 'PASS',
    });
    expect(details.sanitization).toEqual({
      requiredApproved: true,
      diagnosticApproved: true,
      requiredAuthorityPreserved: true,
      prohibitedValuesFound: false,
    });
    expect(details.diagnostics).toEqual([]);
    expect(details.checks.every((check) => check.result === 'PASS')).toBe(true);
    expect(details.artifacts.declaredCount).toBe(2);
    expect(details.artifacts.verifiedCount).toBe(2);
  });

  it('passes for each prohibited-looking category confined to IDAT payloads', () => {
    for (const [label, payload] of PNG_CATEGORY_SAMPLES) {
      const details = b1ArtifactCase(pngTextIdat('ordinary public metadata', payload));
      expect(details.transaction.state, label).toBe('committed');
      expect(details.transaction.failureCode, label).toBeNull();
      expect(details.transaction.creditEligible, label).toBe(true);
      expect(details.sanitization.prohibitedValuesFound, label).toBe(false);
    }
  });

  it('keeps secret and customer markers in non-IDAT metadata blocking with exact category codes', () => {
    // Hostile-matrix row 15 `secret-opaque-metadata` authoritative tuple:
    // committed state, VERIFY_SECRET_OR_AUTHORIZATION_MARKER primary, exit 2,
    // credit ineligible.
    const secret = b1ArtifactCase(
      pngTextIdat('leaked Bearer sk-ABCDEFGHIJKLMNOPQRSTUVWX', 'img bytes'),
    );
    expect(secret.transaction.state).toBe('committed');
    expect(secret.transaction.failureClass).toBe('HARNESS_BLOCKED');
    expect(secret.transaction.failureCode).toBe('VERIFY_SECRET_OR_AUTHORIZATION_MARKER');
    expect(secret.transaction.creditEligible).toBe(false);
    expect(secret.diagnostics.map((entry) => entry.code)).toEqual([
      'VERIFY_SECRET_OR_AUTHORIZATION_MARKER',
    ]);
    expect(checkOf(secret, 'SECRET_SCAN')).toEqual({
      id: 'SECRET_SCAN',
      category: 'privacy',
      result: 'FAIL',
      code: 'VERIFY_SECRET_OR_AUTHORIZATION_MARKER',
    });
    expect(secret.sanitization.prohibitedValuesFound).toBe(true);
    expect(JSON.stringify(secret)).not.toContain('sk-ABCDEFGHIJKLMNOPQRSTUVWX');

    const customer = b1ArtifactCase(pngTextIdat('contact customer@example.com now', 'img bytes'));
    expect(customer.transaction.state).toBe('committed');
    expect(customer.transaction.failureClass).toBe('HARNESS_BLOCKED');
    expect(customer.transaction.failureCode).toBe('VERIFY_PRODUCTION_CUSTOMER_MARKER');
    expect(customer.transaction.creditEligible).toBe(false);
    expect(customer.diagnostics.map((entry) => entry.code)).toEqual([
      'VERIFY_PRODUCTION_CUSTOMER_MARKER',
    ]);
    expect(checkOf(customer, 'CUSTOMER_MARKER_SCAN')).toEqual({
      id: 'CUSTOMER_MARKER_SCAN',
      category: 'privacy',
      result: 'FAIL',
      code: 'VERIFY_PRODUCTION_CUSTOMER_MARKER',
    });
    expect(customer.sanitization.prohibitedValuesFound).toBe(true);
    expect(JSON.stringify(customer)).not.toContain('customer@example.com');
  });

  it('keeps private/UNC/file:/blob:/registered-root metadata values blocking with exact category codes', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['private-root', 'metadata /private/var/folders/p8b-secret-root tail'],
      ['UNC', UNC_BACKSLASH_METADATA],
      ['file:', 'ref file:private-thing'],
      ['blob:', 'handle blob:opaque-handle-123'],
      ['registered-root', 'x registered-private-root y'],
    ];
    const reports: EvidenceVerifyDetails[] = [];
    for (const [label, payload] of cases) {
      const details = b1ArtifactCase(pngTextIdat(payload, 'img bytes'));
      reports.push(details);
      expect(details.transaction.state, label).toBe('committed');
      expect(details.transaction.failureClass, label).toBe('HARNESS_BLOCKED');
      expect(details.transaction.creditEligible, label).toBe(false);
      // The private-path category keeps its exact blocking code at the
      // PATH_SCAN check and as a blocking diagnostic; the unchanged frozen
      // primary precedence (PRIMARY_BLOCKING_VERIFIER_CODES order) keeps the
      // preserved SANITIZATION code primary for these co-finding cases.
      expect(checkOf(details, 'PATH_SCAN'), label).toEqual({
        id: 'PATH_SCAN',
        category: 'privacy',
        result: 'FAIL',
        code: 'VERIFY_PRIVATE_OR_ABSOLUTE_PATH',
      });
      expect(checkOf(details, 'SANITIZATION_GUARD'), label).toEqual({
        id: 'SANITIZATION_GUARD',
        category: 'sanitization',
        result: 'FAIL',
        code: 'VERIFY_SANITIZATION_PROHIBITED_VALUE',
      });
      expect(sorted(details.diagnostics.map((entry) => entry.code)), label).toEqual([
        'VERIFY_PRIVATE_OR_ABSOLUTE_PATH',
        'VERIFY_SANITIZATION_PROHIBITED_VALUE',
      ]);
      expect(details.transaction.failureCode, label).toBe('VERIFY_SANITIZATION_PROHIBITED_VALUE');
      expect(details.sanitization.prohibitedValuesFound, label).toBe(true);
    }
    for (const details of reports) {
      const serialized = JSON.stringify(details);
      for (const value of PNG_PROBE_VALUES) {
        expect(serialized, value).not.toContain(value);
      }
    }
  });

  it('keeps malformed, truncated, missing-IEND, non-zero-IEND, and trailing-byte PNGs blocking', () => {
    const complete = pngTextIdat('meta', 'data-image-bytes');
    const shapes: readonly (readonly [string, Uint8Array])[] = [
      ['malformed', new TextEncoder().encode('not a png at all')],
      ['truncated', complete.subarray(0, complete.byteLength - 4)],
      [
        'missing-IEND',
        buildPng([
          buildPngChunk('tEXt', utf8('meta')),
          buildPngChunk('IDAT', utf8('data-image-bytes')),
        ]),
      ],
      [
        'non-zero-IEND',
        buildPng([
          buildPngChunk('IDAT', utf8('data-image-bytes')),
          buildPngChunk('IEND', new Uint8Array([1])),
        ]),
      ],
      [
        'trailing-bytes',
        buildPng(
          [
            buildPngChunk('IDAT', utf8('data-image-bytes')),
            buildPngChunk('IEND', new Uint8Array(0)),
          ],
          [...utf8('trailing Bearer sk-ABCDEFGHIJKLMNOPQRSTUVWX')],
        ),
      ],
    ];
    for (const [label, bytes] of shapes) {
      const details = b1ArtifactCase(bytes);
      expect(details.transaction.state, label).toBe('committed');
      b1ExpectCode(details, 'VERIFY_SANITIZATION_PROHIBITED_VALUE');
      expect(sorted(details.diagnostics.map((entry) => entry.code)), label).toEqual([
        'VERIFY_SANITIZATION_PROHIBITED_VALUE',
      ]);
      expect(details.diagnostics[0]?.detailCode, label).toBe('PROHIBITED_BYTES_MALFORMED_PNG');
    }
  });

  it('keeps the complete full-byte scan for generic opaque artifacts', () => {
    const combined = PNG_CATEGORY_SAMPLES.map(([, payload]) => payload).join(' ');
    const asPng = pngTextIdat('ordinary public metadata', combined);
    // The very same bytes declared opaque keep the complete full-byte scan and
    // reject every prohibited-looking sequence with the exact category codes.
    const opaque = b1ArtifactCase(asPng, {
      mediaType: 'application/octet-stream',
      schema: 'octets',
      relativePath: 'diagram.bin',
    });
    expect(opaque.transaction.failureClass).toBe('HARNESS_BLOCKED');
    expect(opaque.transaction.creditEligible).toBe(false);
    expect(sorted(opaque.diagnostics.map((entry) => entry.code))).toEqual([
      'VERIFY_PRIVATE_OR_ABSOLUTE_PATH',
      'VERIFY_PRODUCTION_CUSTOMER_MARKER',
      'VERIFY_SANITIZATION_PROHIBITED_VALUE',
      'VERIFY_SECRET_OR_AUTHORIZATION_MARKER',
    ]);
    expect(checkOf(opaque, 'SECRET_SCAN')?.code).toBe('VERIFY_SECRET_OR_AUTHORIZATION_MARKER');
    expect(checkOf(opaque, 'PATH_SCAN')?.code).toBe('VERIFY_PRIVATE_OR_ABSOLUTE_PATH');
    expect(checkOf(opaque, 'CUSTOMER_MARKER_SCAN')?.code).toBe('VERIFY_PRODUCTION_CUSTOMER_MARKER');
    expect(checkOf(opaque, 'SANITIZATION_GUARD')?.code).toBe(
      'VERIFY_SANITIZATION_PROHIBITED_VALUE',
    );
    // ...while the exact same bytes declared image/png verify as PASS: a valid
    // PNG is never silently reclassified as opaque and an opaque artifact is
    // never silently reclassified as a clean PNG.
    const declaredPng = b1ArtifactCase(asPng);
    expect(declaredPng.transaction.failureCode).toBeNull();
    expect(declaredPng.transaction.creditEligible).toBe(true);
    expect(declaredPng.sanitization.prohibitedValuesFound).toBe(false);
  });
});

// ── 13. ADR 0051C amendment v2 — malformed PNG single-authority governance ───

/**
 * ADR 0051C amendment v2 proof. `inspectProhibitedBytes` is the only
 * structural-validity authority for a declared PNG: when it classifies the
 * bytes with its malformed-PNG structural result the verdict governs the
 * artifact alone, the non-IDAT payload extractor never runs, and no secondary
 * PATH/SECRET/CUSTOMER privacy finding is emitted. Hostile payloads carried
 * anywhere in such a malformed PNG (complete non-IDAT chunks before the
 * framing defect, nonzero-`IEND` data, trailing bytes) therefore never reach
 * the privacy scan and never leak into the report. Structurally valid PNGs
 * keep the unchanged non-IDAT-only scanning and metadata category behavior.
 */
// Pre-defect hostile text carries the secret/customer forms the privacy scan
// flags while staying outside the authority's path-form metadata policy, so
// the authoritative walk reaches the framing defect and classifies the PNG
// malformed. Path-family hostile forms live only in positions no structural
// walk ever scans (nonzero-IEND data, trailing bytes).
const MALFORMED_SAFE_HOSTILE_TEXT =
  'img Bearer sk-ABCDEFGHIJKLMNOPQRSTUVWX tail; img customer@example.com tail';
const MALFORMED_DEFECT_HOSTILE_TEXT = PNG_CATEGORY_SAMPLES.map(([, payload]) => payload).join(' ');

function pngAuthorityCode(bytes: Uint8Array): string {
  return inspectProhibitedBytes({
    apiVersion: EVIDENCE_PROHIBITED_BYTES_API_VERSION,
    bytes,
    mediaType: 'image/png',
    format: 'png',
    forbiddenRoots: PNG_PRIVATE_ROOTS,
  }).code;
}

function malformedPngFamilies(): readonly (readonly [string, Uint8Array])[] {
  const hostileText = buildPngChunk('tEXt', utf8(MALFORMED_SAFE_HOSTILE_TEXT));
  const idat = buildPngChunk('IDAT', utf8('img bytes'));
  const terminalIend = buildPngChunk('IEND', new Uint8Array(0));
  const complete = buildPng([hostileText, idat, terminalIend]);
  return [
    // End of stream inside a chunk header (three stray framing bytes).
    ['truncated-framing', buildPng([hostileText, idat], [0, 0, 8])],
    // End of stream inside chunk data (six of eight IDAT data bytes present).
    ['truncated-data', complete.subarray(0, complete.byteLength - 18)],
    // End of stream inside chunk CRC (two of four IDAT CRC bytes present).
    ['truncated-CRC', complete.subarray(0, complete.byteLength - 14)],
    // Complete chunks with no terminal IEND at all.
    ['missing-IEND', buildPng([hostileText, idat])],
    // Hostile payload carried by a nonzero-length terminal IEND's data bytes.
    [
      'nonzero-IEND-hostile-payload',
      buildPng([idat, buildPngChunk('IEND', utf8(MALFORMED_DEFECT_HOSTILE_TEXT))]),
    ],
    // Hostile payload carried by trailing bytes after a zero-length IEND.
    [
      'trailing-bytes-hostile-payload',
      buildPng(
        [hostileText, idat, terminalIend],
        [...utf8(`tail ${MALFORMED_DEFECT_HOSTILE_TEXT}`)],
      ),
    ],
  ];
}

describe('[P8-B/B1] run verifier core — malformed PNG single-authority governance (ADR 0051C v2)', () => {
  it('governs every malformed PNG family solely by the authoritative malformed-PNG structural result', () => {
    for (const [label, bytes] of malformedPngFamilies()) {
      // The sole structural authority classifies every family malformed.
      expect(pngAuthorityCode(bytes), label).toBe('PROHIBITED_BYTES_MALFORMED_PNG');
      const details = b1ArtifactCase(bytes);
      expect(details.transaction.state, label).toBe('committed');
      b1ExpectCode(details, 'VERIFY_SANITIZATION_PROHIBITED_VALUE');
      expect(
        details.diagnostics.map((entry) => [entry.code, entry.detailCode]),
        label,
      ).toEqual([['VERIFY_SANITIZATION_PROHIBITED_VALUE', 'PROHIBITED_BYTES_MALFORMED_PNG']]);
      // No secondary PATH/SECRET/CUSTOMER privacy finding: the non-IDAT payload
      // extractor never runs on an authority-classified malformed PNG.
      for (const id of ['PATH_SCAN', 'SECRET_SCAN', 'CUSTOMER_MARKER_SCAN']) {
        expect(checkOf(details, id)?.result, `${label}/${id}`).toBe('PASS');
      }
      expect(details.sanitization.prohibitedValuesFound, label).toBe(true);
      // The complete report never leaks any hostile value.
      const serialized = JSON.stringify(details);
      for (const value of PNG_PROBE_VALUES) {
        expect(serialized, `${label}/${value}`).not.toContain(value);
      }
    }
  });

  it('never privacy-scans hostile payloads carried by nonzero-IEND data or trailing bytes', () => {
    const placements: readonly (readonly [string, Uint8Array])[] = [
      [
        'nonzero-IEND-data',
        buildPng([
          buildPngChunk('IDAT', utf8('img bytes')),
          buildPngChunk('IEND', utf8(MALFORMED_DEFECT_HOSTILE_TEXT)),
        ]),
      ],
      [
        'trailing-bytes',
        buildPng(
          [buildPngChunk('IDAT', utf8('img bytes')), buildPngChunk('IEND', new Uint8Array(0))],
          [...utf8(MALFORMED_DEFECT_HOSTILE_TEXT)],
        ),
      ],
    ];
    for (const [label, bytes] of placements) {
      expect(pngAuthorityCode(bytes), label).toBe('PROHIBITED_BYTES_MALFORMED_PNG');
      const details = b1ArtifactCase(bytes);
      b1ExpectCode(details, 'VERIFY_SANITIZATION_PROHIBITED_VALUE');
      expect(
        details.diagnostics.map((entry) => [entry.code, entry.detailCode]),
        label,
      ).toEqual([['VERIFY_SANITIZATION_PROHIBITED_VALUE', 'PROHIBITED_BYTES_MALFORMED_PNG']]);
      for (const id of ['PATH_SCAN', 'SECRET_SCAN', 'CUSTOMER_MARKER_SCAN']) {
        expect(checkOf(details, id)?.result, `${label}/${id}`).toBe('PASS');
      }
      const serialized = JSON.stringify(details);
      for (const value of PNG_PROBE_VALUES) {
        expect(serialized, `${label}/${value}`).not.toContain(value);
      }
    }
  });
});

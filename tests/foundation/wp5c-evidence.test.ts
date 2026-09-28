import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { canonicalize } from '../../src/canonical/canonicalize';
import {
  CHECK_RESULT_CONTRACT_SCHEMA_VERSION,
  CLEANUP_RESULT_SCHEMA_VERSION,
} from '../../src/contracts/schema-versions';
import { RUN_OWNERSHIP_RECORD_SCHEMA_VERSION } from '../../src/contracts/schema-versions';
import type {
  ActionCycleCorrectnessIdentity,
  CorrectnessCheckResult,
} from '../../src/contracts/correctness';
import type {
  FinalCurrentChildRecordV4,
  FinalNestedProjectionV4,
} from '../../src/contracts/final-record-v4';
import { readFinalRecord } from '../../src/contracts/final-record-reader';
import type { AssembleFinalPublicRunRecordV4Input } from '../../src/contracts/final-public-record';
import type { CleanupResult, RunOwnershipRecord } from '../../src/contracts/runtime';
import { captureCleanupAuthoritySnapshot } from '../../src/evidence/cleanup-authority';
import { readFinalPublicRecordFile } from '../../src/evidence/final-reader';
import { writeFinalPublicRunRecordV4 } from '../../src/evidence/final-writer';
import {
  RedactionRejectedError,
  assertPublicRecordSafe,
  serializePublicRecord,
  textContainsProhibitedValue,
} from '../../src/evidence/guard';
import {
  PublicPathError,
  buildCleanupProjection,
  buildEstablishedOwnership,
  buildNotEstablishedOwnership,
  buildPublicLaunchFacts,
  normalizeLexicalAbsolutePath,
  ownershipRecordFingerprint,
  publicPathFingerprint,
  validateArtifactBasename,
  validatePublicRelativePath,
  type PublicCleanupProjection,
  type PublicLaunchFacts,
  type PublicOwnershipProjection,
  type RunRecordFingerprints,
  type RunRecordReadiness,
} from '../../src/evidence/public-dto';
import {
  ACCEPTED_PRE_5F_V2_LABEL,
  LEGACY_V1_LABEL,
  LEGACY_V3_LABEL,
  classifyLegacyRunRecord,
  parseLegacyRunRecordOrThrow,
} from '../../src/evidence/reader';
import { RunRecordExistsError, RunRecordWriteError } from '../../src/evidence/writer';

const RUN_ID = 'run-1';
const REPO_ROOT = '/repo';
const SKILL_ROOT = '/repo/agents/verify-artwork-editor';
const SCRATCH_ROOT = '/tmp/makeit-artwork-verification-run-1';
const EVIDENCE_ROOT = '/repo/evidence/runs/run-1';
const DIST_DIR = '/repo/.next/verify-runs/run-1';
const SERVER_LOG = `${EVIDENCE_ROOT}/server.log`;

const FORBIDDEN = [REPO_ROOT, SKILL_ROOT, SCRATCH_ROOT, EVIDENCE_ROOT, DIST_DIR, SERVER_LOG];

function ownershipRecord(overrides: Partial<RunOwnershipRecord> = {}): RunOwnershipRecord {
  return {
    schemaVersion: RUN_OWNERSHIP_RECORD_SCHEMA_VERSION,
    owner: 'verify-artwork-editor',
    state: 'launched',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    processPid: 111,
    processGroupId: 111,
    ownedCommand: ['/usr/local/bin/node', 'next', 'dev'],
    serverLogPath: SERVER_LOG,
    repoConfigSnapshot: null,
    activeCase: null,
    runId: RUN_ID,
    repoRoot: REPO_ROOT,
    skillRoot: SKILL_ROOT,
    repoRelativeDistDir: `.next/verify-runs/${RUN_ID}`,
    distDir: DIST_DIR,
    scratchRoot: SCRATCH_ROOT,
    evidenceRoot: EVIDENCE_ROOT,
    routeNamespace: `verify:${RUN_ID}:routes`,
    storageNamespace: `verify:${RUN_ID}:storage`,
    port: 55958,
    baseUrl: 'http://127.0.0.1:55958',
    environmentCellId: 'chromium-desktop-1440x1000',
    ...overrides,
  };
}

function cleanupResult(overrides: Partial<CleanupResult> = {}): CleanupResult {
  return {
    schemaVersion: CLEANUP_RESULT_SCHEMA_VERSION,
    runId: RUN_ID,
    attempted: true,
    complete: true,
    alreadyClean: false,
    refusedReason: null,
    detail: 'Owned run resources removed.',
    verification: {
      processSignalled: 111,
      processEscalated: false,
      processDead: true,
      portClosed: true,
      distDirRemoved: true,
      scratchRemoved: true,
      configRestored: true,
      browserClosed: true,
      evidencePreserved: true,
    },
    diagnostics: [],
    ...overrides,
  };
}

/**
 * Historical pre-5F public payload shape. The current authority is the strict
 * v4 `FinalPublicRunRecordV4`; this local fixture is retained only to exercise
 * the still-shared operational projection vocabulary and the redaction guard.
 */
interface LegacyPublicPayload {
  runId: string;
  caseId: string;
  materializationFingerprint: string;
  planFingerprint: string;
  profile: string;
  provenance: string;
  evidenceDepth: string;
  environmentCellId: string;
  repository: { commit: string | null; dirty: boolean | null; lockfileDigest: string };
  fingerprints: RunRecordFingerprints;
  adapter: { adapterId: string; compatibilityVersion: number };
  workflow: { workflowId: string; version: number };
  fixture: { fixtureId: string; constructorId: string; constructorVersion: number };
  observationId: string;
  targets: { role: string; elementId: string }[];
  requiredChecks: { checkId: string; passed: boolean; evidenceIds: string[] }[];
  readiness: RunRecordReadiness;
  behaviorOutcome: string | null;
  finalOutcome: string;
  launch: PublicLaunchFacts;
  ownership: PublicOwnershipProjection;
  cleanup: PublicCleanupProjection | null;
  diagnostics: readonly unknown[];
  runError: string | null;
  image: unknown;
}

function validPayload(overrides: Partial<LegacyPublicPayload> = {}): LegacyPublicPayload {
  const record = ownershipRecord();
  return {
    runId: RUN_ID,
    caseId: 'case-1',
    materializationFingerprint: 'm'.repeat(64),
    planFingerprint: 'p'.repeat(64),
    profile: 'diagnostic',
    provenance: 'diagnostic-request',
    evidenceDepth: 'deep',
    environmentCellId: 'chromium-desktop-1440x1000',
    repository: { commit: null, dirty: null, lockfileDigest: 'd'.repeat(64) },
    fingerprints: {
      registry: 'r',
      applicationInventory: 'a',
      operationCatalogue: 'o',
      adapterCatalogue: 'ad',
      workflowCatalogue: 'w',
      workflowSteps: 'ws',
      coverageModel: null,
      readinessProfile: 'image-raster-action-cycle-v1@1',
      oracleProfile: 'image-upload-replace-v1@1',
    },
    adapter: { adapterId: 'image-specialized', compatibilityVersion: 2 },
    workflow: { workflowId: 'image.upload-replace', version: 1 },
    fixture: {
      fixtureId: 'layer-image-change-properties-upload-replace',
      constructorId: 'artwork.two-layout-image.v1',
      constructorVersion: 1,
    },
    observationId: 'obs-1',
    targets: [{ role: 'target', elementId: 'layout-image-a-image-1' }],
    requiredChecks: [
      { checkId: 'image.semantic-transition', passed: true, evidenceIds: ['observation:obs-1'] },
    ],
    readiness: {
      profileId: 'image-raster-action-cycle-v1',
      timingCategory: 'RESOURCE_RENDER_V1',
      deadlineMs: 8_000,
      wakeSource: 'already-advanced',
      fallbackPollCount: 0,
      watchdogWaits: 0,
      rendererStableFrames: 3,
      timings: {},
    },
    behaviorOutcome: 'PASS',
    finalOutcome: 'PASS',
    launch: buildPublicLaunchFacts({
      attempted: true,
      pid: 111,
      processGroupId: 111,
      readinessMs: 1234,
      serverLogPath: SERVER_LOG,
    }),
    ownership: buildEstablishedOwnership(
      record,
      'launched',
      `.next/verify-runs/${RUN_ID}`,
      'agents/verify-artwork-editor',
    ),
    cleanup: buildCleanupProjection(cleanupResult()),
    diagnostics: [],
    runError: null,
    image: null,
    ...overrides,
  };
}

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempRoot(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vt-evidence-v2-'));
  temps.push(dir);
  return dir;
}

const HEX = (char: string): string => char.repeat(64);

const COMPONENT_FINGERPRINTS = {
  readiness: HEX('a'),
  capture: HEX('b'),
  oracle: HEX('c'),
  capabilityBaseline: HEX('d'),
  subjectAddition: HEX('e'),
  requiredCheckSet: HEX('f'),
  tolerances: HEX('0'),
  visuals: HEX('1'),
  normalization: HEX('2'),
};

const RESOLVED_PROFILE_FINGERPRINT = HEX('9');

const ACTION_CYCLE: ActionCycleCorrectnessIdentity = {
  schemaVersion: CHECK_RESULT_CONTRACT_SCHEMA_VERSION,
  actionCycleId: 'image-cycle-1',
  resolvedProfileFingerprint: RESOLVED_PROFILE_FINGERPRINT,
  readinessFingerprint: COMPONENT_FINGERPRINTS.readiness,
};

/** One closed PASS check bound to the single image Action Cycle. */
function statusCheck(checkId: string): CorrectnessCheckResult {
  return {
    schemaVersion: CHECK_RESULT_CONTRACT_SCHEMA_VERSION,
    checkId,
    status: 'PASS',
    expected: {},
    actual: {},
    evidenceIds: [],
    toleranceRefs: [],
    visualRefs: [],
    normalizationRef: null,
    actionCycleRef: ACTION_CYCLE.actionCycleId,
    consumedComponentFingerprints: {
      resolvedProfile: RESOLVED_PROFILE_FINGERPRINT,
      requiredCheckSet: COMPONENT_FINGERPRINTS.requiredCheckSet,
      oracle: COMPONENT_FINGERPRINTS.oracle,
      capture: COMPONENT_FINGERPRINTS.capture,
      tolerances: COMPONENT_FINGERPRINTS.tolerances,
      visuals: COMPONENT_FINGERPRINTS.visuals,
      normalization: COMPONENT_FINGERPRINTS.normalization,
    },
  };
}

function actionCycleProjection(): FinalNestedProjectionV4 {
  return {
    schemaVersion: 4,
    family: 'action-cycle',
    actionCycles: [ACTION_CYCLE],
    readiness: {
      profileId: 'image-raster-action-cycle-v1',
      timingCategory: 'RESOURCE_RENDER_V1',
      deadlineMs: 8_000,
      signalWatchdogMs: 500,
      stableFrames: 3,
    },
  };
}

function imageProjection(checks: readonly CorrectnessCheckResult[]): FinalNestedProjectionV4 {
  return {
    schemaVersion: 4,
    family: 'image',
    cycles: [
      {
        checkpoint: 'after-upload-current',
        mode: 'upload',
        outcome: 'PASS',
        observationId: 'obs-1',
        tornRecaptureCount: 0,
        actionCycleRef: ACTION_CYCLE.actionCycleId,
        checks,
      },
    ],
  };
}

/** A complete closed strict v4 child carrying the image nested projection. */
function validChild(checks: readonly CorrectnessCheckResult[]): FinalCurrentChildRecordV4 {
  return {
    schemaVersion: 4,
    runId: RUN_ID,
    caseId: 'case-1',
    materializationFingerprint: HEX('3'),
    planFingerprint: HEX('4'),
    profile: 'diagnostic',
    observationId: 'obs-1',
    resolvedProfileFingerprint: RESOLVED_PROFILE_FINGERPRINT,
    componentFingerprints: COMPONENT_FINGERPRINTS,
    actionCycles: [ACTION_CYCLE],
    requiredChecks: checks,
    nestedProjections: [actionCycleProjection(), imageProjection(checks)],
  };
}

/** The safe operational projections the current public v4 record adds. */
function operationalFields(
  overrides: Partial<Omit<AssembleFinalPublicRunRecordV4Input, 'child'>> = {},
): Omit<AssembleFinalPublicRunRecordV4Input, 'child'> {
  return {
    provenance: 'diagnostic-request',
    evidenceDepth: 'deep',
    environmentCellId: 'chromium-desktop-1440x1000',
    repository: { commit: null, dirty: null, lockfileDigest: HEX('5') },
    fingerprints: {
      registry: 'r',
      applicationInventory: 'a',
      operationCatalogue: 'o',
      adapterCatalogue: 'ad',
      workflowCatalogue: 'w',
      workflowSteps: 'ws',
      coverageModel: null,
      readinessProfile: 'image-raster-action-cycle-v1@1',
      oracleProfile: 'image-upload-replace-v1@1',
    },
    adapter: { adapterId: 'image-specialized', compatibilityVersion: 2 },
    workflow: { workflowId: 'image.upload-replace', version: 1 },
    fixture: {
      fixtureId: 'layer-image-change-properties-upload-replace',
      constructorId: 'artwork.two-layout-image.v1',
      constructorVersion: 1,
    },
    targets: [],
    readiness: {
      profileId: 'image-raster-action-cycle-v1',
      timingCategory: 'RESOURCE_RENDER_V1',
      deadlineMs: 8_000,
      wakeSource: 'already-advanced',
      fallbackPollCount: 0,
      watchdogWaits: 0,
      rendererStableFrames: 3,
      timings: {},
    },
    behaviorOutcome: 'PASS',
    finalOutcome: 'PASS',
    launch: buildPublicLaunchFacts({
      attempted: false,
      pid: null,
      processGroupId: null,
      readinessMs: null,
      serverLogPath: null,
    }),
    ownership: buildNotEstablishedOwnership({
      runId: RUN_ID,
      allocationFailureCode: 'OWNERSHIP_UNKNOWN',
      requestedPort: null,
    }),
    cleanup: null,
    diagnostics: [],
    runError: null,
    recordedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('WP5 Slice 5-C R13 — schema v2 retained-field completeness', () => {
  it('retains the complete allowlisted public field set', () => {
    const record = validPayload();
    expect(record.ownership.status).toBe('established');
    expect(record.cleanup?.complete).toBe(true);
    expect(record.readiness.deadlineMs).toBe(8_000);
    expect(record.requiredChecks[0]?.checkId).toBe('image.semantic-transition');
    expect(record.launch.serverLogArtifactId).toBe('server.log');
    expect(record.fixture.constructorId).toBe('artwork.two-layout-image.v1');
    expect(record.fingerprints.oracleProfile).toBe('image-upload-replace-v1@1');
  });

  it('omits every former absolute allocation and server-log field', () => {
    const serialized = JSON.stringify(validPayload());
    expect(serialized).not.toContain('"allocation"');
    expect(serialized).not.toContain('"serverLogPath"');
    for (const forbidden of FORBIDDEN) expect(serialized).not.toContain(forbidden);
  });
});

describe('WP5 Slice 5-C R13 — domain-separated path and ownership fingerprints', () => {
  it('is deterministic per role, run id and exact path', () => {
    const first = publicPathFingerprint('next-dist-dir', RUN_ID, DIST_DIR);
    const second = publicPathFingerprint('next-dist-dir', RUN_ID, DIST_DIR);
    expect(first).toEqual(second);
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(first.domain).toBe('makeit:public-path-ref:v1');
    expect(first.role).toBe('next-dist-dir');
    expect(JSON.stringify(first)).not.toContain(DIST_DIR);
  });

  it('isolates one changed path to its own path fingerprint and the ownership fingerprint', () => {
    const base = ownershipRecord();
    const baseFingerprint = ownershipRecordFingerprint(base);
    const moved = ownershipRecord({ scratchRoot: '/tmp/makeit-artwork-verification-run-1-moved' });
    expect(ownershipRecordFingerprint(moved)).not.toBe(baseFingerprint);
    expect(publicPathFingerprint('scratch-root', RUN_ID, base.scratchRoot)).not.toEqual(
      publicPathFingerprint('scratch-root', RUN_ID, moved.scratchRoot),
    );
    // A role with the same path is unchanged.
    expect(publicPathFingerprint('repository', RUN_ID, base.repoRoot)).toEqual(
      publicPathFingerprint('repository', RUN_ID, moved.repoRoot),
    );
  });

  it('normalizes a lexical absolute path and rejects a relative one', () => {
    expect(normalizeLexicalAbsolutePath('/repo//a/./b')).toBe('/repo/a/b');
    expect(() => normalizeLexicalAbsolutePath('relative/path')).toThrow(PublicPathError);
  });
});

describe('WP5 Slice 5-C R13 — role-specific relative path and basename validators', () => {
  it('accepts only the exact canonical skill-root and next-dist-dir names', () => {
    expect(
      validatePublicRelativePath('skill-root', 'agents/verify-artwork-editor', RUN_ID),
    ).toBe('agents/verify-artwork-editor');
    // Historical records keep their original public projection.
    expect(
      validatePublicRelativePath('skill-root', '.pi/skills/verify-artwork-editor', RUN_ID),
    ).toBe('.pi/skills/verify-artwork-editor');
    expect(validatePublicRelativePath('next-dist-dir', `.next/verify-runs/${RUN_ID}`, RUN_ID)).toBe(
      `.next/verify-runs/${RUN_ID}`,
    );
    expect(() => validatePublicRelativePath('skill-root', 'other/skill', RUN_ID)).toThrow();
    expect(() =>
      validatePublicRelativePath('next-dist-dir', '.next/verify-runs/other', RUN_ID),
    ).toThrow();
  });

  it('rejects absolute, drive, UNC, file:, encoded, traversal and query forms', () => {
    const rejected = [
      '/etc/passwd',
      'C:\\windows\\system32',
      '\\\\server\\share',
      'file:///tmp/x',
      'a/../b',
      'a/%2e%2e/b',
      'a%2Fb',
      'a\\b',
      'a?b=c',
      'a#frag',
      '',
    ];
    for (const value of rejected) {
      expect(() => validatePublicRelativePath('next-dist-dir', value, RUN_ID)).toThrow();
    }
  });

  it('rejects a basename containing a separator or traversal', () => {
    expect(validateArtifactBasename('server.log')).toBe('server.log');
    for (const value of ['a/b', 'a\\b', '..', '.', '', '%2f']) {
      expect(() => validateArtifactBasename(value)).toThrow();
    }
  });

  it('forbids non-permitted roles from exposing a relative path', () => {
    for (const role of ['repository', 'scratch-root', 'evidence-root', 'temp'] as const) {
      expect(() => validatePublicRelativePath(role, 'a/b', RUN_ID)).toThrow();
    }
  });
});

describe('WP5 Slice 5-C R13 — complete plain-JSON recursive guard', () => {
  it('accepts a same-origin loopback URL but rejects a blob handle', () => {
    expect(() =>
      assertPublicRecordSafe(
        { url: 'http://127.0.0.1:55958/__artwork-verification__/v1/runs/run-1/resources/a' },
        { forbiddenPaths: FORBIDDEN },
      ),
    ).not.toThrow();
    expect(() =>
      assertPublicRecordSafe({ url: 'blob:http://127.0.0.1:1/abc' }, { forbiddenPaths: FORBIDDEN }),
    ).toThrow(RedactionRejectedError);
  });

  it('rejects a prohibited value in an object key without leaking the key', () => {
    let failure: RedactionRejectedError | null = null;
    try {
      assertPublicRecordSafe(
        { secure: true, nested: { 'blob:http://127.0.0.1/secret': 'x' } },
        { forbiddenPaths: FORBIDDEN },
      );
    } catch (error) {
      failure = error as RedactionRejectedError;
    }
    expect(failure?.code).toBe('REDACTION_PROHIBITED_VALUE');
    expect(failure?.trail).toBe('record.nested.<key:1>');
    expect(failure?.message).not.toContain('secret');
  });

  it('uses an ordinal placeholder for arbitrary keys in the trail', () => {
    expect(() =>
      assertPublicRecordSafe(
        { 'weird key!': { 'another key!': '/etc/passwd' } },
        { forbiddenPaths: FORBIDDEN },
      ),
    ).toThrowError(/record\.<key:1>\.<key:1>/);
  });

  it('rejects cycles and every prohibited non-JSON type', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => assertPublicRecordSafe(cyclic)).toThrow(/cycle/i);

    class Custom {}
    const prohibited: unknown[] = [
      undefined,
      () => 1,
      Symbol('x'),
      1n,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      new Date(),
      new Map(),
      new Set(),
      new Error('boom'),
      new Custom(),
      // sparse array
      (() => {
        const sparse = new Array(3);
        sparse[1] = 1;
        return sparse;
      })(),
    ];
    for (const value of prohibited) {
      expect(() => assertPublicRecordSafe({ value })).toThrow(RedactionRejectedError);
    }
  });

  it('rejects raw, mixed-case, embedded, encoded and serialized-byte leaks', () => {
    const leaks = [
      'blob:http://127.0.0.1/1/a',
      'BLOB:http://127.0.0.1/1/a',
      'prefix-blob:http://x',
      'blob%3Ahttp%3A%2F%2F127.0.0.1%2F1%2Fa',
      'file:///etc/passwd',
      'C:\\Users\\secret',
      '\\\\server\\share',
      '/Users/private/workspace/secret',
      '/tmp/leak',
      '/private/var/tmp/x',
      `${REPO_ROOT}/leak`,
      `${SKILL_ROOT}/fixtures/resources/files/a.png`,
      `${SCRATCH_ROOT}/ownership.json`,
      `${EVIDENCE_ROOT}/server.log`,
    ];
    for (const leak of leaks) {
      expect(() => assertPublicRecordSafe({ detail: leak }, { forbiddenPaths: FORBIDDEN })).toThrow(
        RedactionRejectedError,
      );
    }
    expect(textContainsProhibitedValue(`${SCRATCH_ROOT}/x`, FORBIDDEN)).toBe(true);
  });

  it('does not reproduce the offending value in the thrown error', () => {
    let failure: RedactionRejectedError | null = null;
    try {
      assertPublicRecordSafe(
        { detail: `${SCRATCH_ROOT}/ownership.json` },
        { forbiddenPaths: FORBIDDEN },
      );
    } catch (error) {
      failure = error as RedactionRejectedError;
    }
    expect(failure).not.toBeNull();
    expect(failure?.message).toBe(
      'Redaction rejected: REDACTION_PROHIBITED_VALUE at record.detail',
    );
    expect(failure?.message).not.toContain(SCRATCH_ROOT);
  });

  it('serializes only an accepted plain object', () => {
    const serialized = serializePublicRecord({ ok: true, nested: [1, 'two'] });
    expect(JSON.parse(serialized)).toEqual({ ok: true, nested: [1, 'two'] });
    expect(JSON.parse(serializePublicRecord({ text: 'literal\\separator' }))).toEqual({
      text: 'literal\\separator',
    });
    expect(() => serializePublicRecord({ value: undefined })).toThrow(RedactionRejectedError);
    expect(() => serializePublicRecord({ text: '\\\\server\\share' })).toThrow(
      RedactionRejectedError,
    );
  });

  it('is a backstop over the exact serialized bytes', () => {
    expect(() =>
      serializePublicRecord({ text: `${REPO_ROOT}/a` }, { forbiddenPaths: FORBIDDEN }),
    ).toThrow(RedactionRejectedError);
  });
});

describe('WP5 Slice 5-C R13 — ownership projection honest union', () => {
  it('marks a failed allocation not-established with no process/port/resource claim', () => {
    const projection = buildNotEstablishedOwnership({
      runId: RUN_ID,
      allocationFailureCode: 'PORT_UNAVAILABLE',
      requestedPort: 55958,
    });
    expect(projection.status).toBe('not-established');
    expect(projection.requestedPort).toEqual({ requested: 55958, owned: false });
    expect(JSON.stringify(projection)).not.toContain('ownershipFingerprint');
    expect(JSON.stringify(projection)).not.toContain('processGroupId');
  });

  it('marks an established lease with a verified fingerprint and owned resources', () => {
    const snapshot = captureCleanupAuthoritySnapshot(ownershipRecord());
    expect(snapshot.publicOwnership.status).toBe('established');
    expect(snapshot.ownershipFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.publicOwnership.ownershipFingerprint).toBe(snapshot.ownershipFingerprint);
    expect(snapshot.publicOwnership.port).toBe(55958);
    expect(snapshot.sensitiveRoots.map((entry) => entry.role)).toContain('scratch-root');
  });

  it('keeps the snapshot fingerprint equal to the canonical private-record digest', () => {
    const record = ownershipRecord();
    const expected = ownershipRecordFingerprint(record);
    expect(captureCleanupAuthoritySnapshot(record).ownershipFingerprint).toBe(expected);
    // Provenance only: the exact record preimage is reproducible.
    expect(canonicalize(record).length).toBeGreaterThan(0);
  });

  it('projects the toolkit-relative skill root as a closed constant, never a traversal', () => {
    // An explicit app-root run owns a different checkout than the toolkit, but the
    // public `skill-root` role must stay toolkit-relative. Deriving it from the
    // app root would leak a `../..` traversal and fail the closed projection.
    const appRootRecord = ownershipRecord({ repoRoot: '/some/fe-checkout' });
    const snapshot = captureCleanupAuthoritySnapshot(appRootRecord);
    expect(snapshot.publicOwnership.resources.skillRoot.relativePath).toBe(
      'agents/verify-artwork-editor',
    );
    expect(JSON.stringify(snapshot.publicOwnership)).not.toContain('..');
  });
});

describe('WP5 Slice 5-C R13 — allowlisted cleanup projection', () => {
  it('retains structured cleanup facts without raw detail or diagnostics', () => {
    const projection = buildCleanupProjection(
      cleanupResult({
        complete: false,
        detail: `scratch ${SCRATCH_ROOT} could not be removed`,
        verification: {
          ...cleanupResult().verification,
          scratchRemoved: false,
          configRestored: false,
        },
        diagnostics: [
          {
            code: 'CLEANUP_IO_FAILED',
            severity: 'blocking',
            detail: `failed on ${SCRATCH_ROOT}`,
            subjectId: null,
            applicationKind: null,
            context: { path: SCRATCH_ROOT },
          },
        ],
      }),
    );
    expect(projection.complete).toBe(false);
    expect(projection.facts.scratchRemoved).toBe(false);
    expect(projection.facts.configRestored).toBe(false);
    expect(projection.diagnostics).toEqual([
      { code: 'CLEANUP_IO_FAILED', resourceRole: 'owned-resource' },
    ]);
    expect(JSON.stringify(projection)).not.toContain(SCRATCH_ROOT);
    expect(JSON.stringify(projection)).not.toContain('could not be removed');
  });

  it('never turns a refused cleanup into apparent success', () => {
    const projection = buildCleanupProjection(
      cleanupResult({
        attempted: false,
        complete: false,
        refusedReason: 'PROCESS_GROUP_UNVERIFIABLE',
      }),
    );
    expect(projection.attempted).toBe(false);
    expect(projection.complete).toBe(false);
    expect(projection.refusedReason).toBe('PROCESS_GROUP_UNVERIFIABLE');
  });
});

describe('WP5 Slice 5-C R13 — historical v1/v2/v3 legacy reader discrimination', () => {
  it('labels a v1 record legacy and never coerces it to the current v4 shape', () => {
    const classification = classifyLegacyRunRecord({ schemaVersion: 1, command: 'diagnostic' });
    expect(classification.kind).toBe('legacy-v1');
    expect(classification.label).toBe(LEGACY_V1_LABEL);
    const read = readFinalRecord({ schemaVersion: 1, command: 'diagnostic' });
    expect(read.legacy).toBe(true);
    expect(read.current).toBe(false);
    expect(read.ambiguous).toBe(true);
  });

  it('accepts a v2 record only as the historical pre-5F public projection', () => {
    const classification = classifyLegacyRunRecord({ schemaVersion: 2, command: 'diagnostic' });
    expect(classification.kind).toBe('legacy-v2');
    expect(classification.label).toBe(ACCEPTED_PRE_5F_V2_LABEL);
    expect(readFinalRecord({ schemaVersion: 2, command: 'diagnostic' }).legacy).toBe(true);
  });

  it('reads a v3 record as legacy, never as the current public projection', () => {
    const classification = classifyLegacyRunRecord({ schemaVersion: 3, command: 'diagnostic' });
    expect(classification.kind).toBe('legacy-v3');
    expect(classification.label).toBe(LEGACY_V3_LABEL);
    const read = readFinalRecord({ schemaVersion: 3, command: 'diagnostic' });
    expect(read.legacy).toBe(true);
    expect(read.current).toBe(false);
  });

  it('fails closed on an unknown schema version', () => {
    expect(classifyLegacyRunRecord({ schemaVersion: 99 }).kind).toBe('unknown');
    expect(() => parseLegacyRunRecordOrThrow({ schemaVersion: 99 })).toThrow(/Unsupported/);
    expect(classifyLegacyRunRecord(null).kind).toBe('unknown');
  });
});

describe('WP5 Slice 5-C R13 — exclusive safe writes and rejection record', () => {
  it('writes a guarded strict v4 record and refuses to overwrite it', () => {
    const root = tempRoot();
    const checks = [statusCheck('image.semantic-transition')];
    const written = writeFinalPublicRunRecordV4({
      child: validChild(checks),
      ...operationalFields(),
      evidenceRoot: root,
    });
    const onDisk = JSON.parse(readFileSync(written.path, 'utf8')) as { schemaVersion: number };
    expect(onDisk.schemaVersion).toBe(4);
    const read = readFinalPublicRecordFile(written.path);
    expect(read.kind).toBe('current-v4');
    expect(read.current).toBe(true);
    expect(read.legacy).toBe(false);
    expect(() =>
      writeFinalPublicRunRecordV4({
        child: validChild(checks),
        ...operationalFields(),
        evidenceRoot: root,
      }),
    ).toThrow(RunRecordExistsError);
    expect(readFileSync(written.path, 'utf8')).toBe(`${written.serialized}\n`);
  });

  it('never writes an unsafe candidate to disk', () => {
    const root = tempRoot();
    expect(() =>
      writeFinalPublicRunRecordV4({
        child: validChild([statusCheck('image.semantic-transition')]),
        ...operationalFields({ runError: `leak ${SCRATCH_ROOT}/ownership.json` }),
        evidenceRoot: root,
        forbiddenPaths: FORBIDDEN,
      }),
    ).toThrow(RedactionRejectedError);
    expect(() => readFileSync(path.join(root, 'run-record.json'), 'utf8')).toThrow();
  });

  it('fails closed instead of writing a durable HARNESS_BLOCKED rejection record', () => {
    const root = tempRoot();
    // The removed rejection record forced HARNESS_BLOCKED; the current writer
    // refuses any child carrying a legacy boolean authority, writing nothing.
    const rejected = {
      ...validChild([statusCheck('image.semantic-transition')]),
      requiredChecks: [{ ...statusCheck('image.semantic-transition'), passed: true }],
    } as unknown as FinalCurrentChildRecordV4;
    expect(() =>
      writeFinalPublicRunRecordV4({
        child: rejected,
        ...operationalFields({ behaviorOutcome: 'PASS', finalOutcome: 'HARNESS_BLOCKED' }),
        evidenceRoot: root,
      }),
    ).toThrow(RunRecordWriteError);
    expect(existsSync(path.join(root, 'run-record.json'))).toBe(false);

    // The current durable reader discriminates only a complete v4 record; a
    // historical rejection-shaped v3 record stays legacy and is never coerced.
    const read = readFinalRecord({
      schemaVersion: 3,
      command: 'diagnostic',
      finalOutcome: 'HARNESS_BLOCKED',
      rejection: { code: 'REDACTION_PROHIBITED_VALUE', trail: 'record.detail' },
    });
    expect(read.legacy).toBe(true);
    expect(read.current).toBe(false);
    expect(read.kind).toBe('legacy-v3');
  });

  it('keeps the rejected candidate value off disk because no record is written', () => {
    const root = tempRoot();
    const leaked = `${SCRATCH_ROOT}/ownership.json`;
    let failure: unknown;
    try {
      writeFinalPublicRunRecordV4({
        child: validChild([statusCheck('image.semantic-transition')]),
        ...operationalFields({ runError: `rejected ${leaked}` }),
        evidenceRoot: root,
        forbiddenPaths: [leaked],
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(RedactionRejectedError);
    expect((failure as Error).message).not.toContain(leaked);
    expect(existsSync(path.join(root, 'run-record.json'))).toBe(false);
  });
});

describe('WP5 Slice 5-C R13 — safe diagnostic projector', () => {
  it('redacts a path-bearing diagnostic while preserving the safe code', async () => {
    const { redactDiagnostics, redactRecordText } = await import('../../src/evidence/public-dto');
    const projected = redactDiagnostics(
      [
        {
          code: 'CLEANUP_IO_FAILED',
          severity: 'blocking',
          detail: `failed on ${SCRATCH_ROOT}`,
          subjectId: null,
          applicationKind: null,
          context: { path: SCRATCH_ROOT, reason: 'eacces' },
        },
      ],
      FORBIDDEN,
    );
    expect(projected[0]?.code).toBe('CLEANUP_IO_FAILED');
    expect(projected[0]?.detail).toBe('[redacted: private value]');
    expect(projected[0]?.context).toEqual({ reason: 'eacces' });
    expect(redactRecordText(`boom ${SCRATCH_ROOT}`, FORBIDDEN)).toBe('[redacted: private value]');
    expect(redactRecordText('clean', FORBIDDEN)).toBe('clean');
  });
});

describe('WP5 Slice 5-C R13 — writer rejection reaches a safe terminal path', () => {
  it('accepts a v2 record containing only a safe loopback URL and no private paths', () => {
    const record = validPayload({
      image: {
        cycles: [],
        resources: [
          {
            logicalId: 'image.upload-a',
            version: 1,
            filename: 'image-upload-a--sha256-abc.png',
            byteLength: 112,
            sha256: 'abc',
            mimeType: 'image/png',
          },
        ],
        resourceManifestFingerprint: 'mf',
        routeOwnership: [
          {
            logicalId: 'image.upload-a',
            version: 1,
            url: 'http://127.0.0.1:55958/__artwork-verification__/v1/runs/run-1/resources/image.upload-a/a.png',
          },
        ],
        requestLog: { schemaVersion: 1, records: [] },
        preflight: [],
      } as never,
    });
    const serialized = serializePublicRecord(record, { forbiddenPaths: FORBIDDEN });
    expect(serialized).toContain('http://127.0.0.1:55958');
    expect(serialized).not.toContain('blob:');
  });
});

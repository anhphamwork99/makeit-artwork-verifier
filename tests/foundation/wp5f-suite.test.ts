import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { evaluateGeometryDeltaOracle } from '../../src/index';
import { projectOrdinaryTextLiveFact } from '../../src/adapters/text-live-facts';
import { deriveWorkflowStepCatalogueFingerprint } from '../../src/catalogue/fingerprint';
import { loadCatalogueBundle } from '../../src/catalogue/load';
import { loadDiagnosticSuite, resolveSuiteRequests } from '../../src/catalogue/suite';
import { runDiagnosticSuiteCommand } from '../../src/cli/suite';
import type { DiagnosticRunFacts } from '../../src/cli/diagnostic';
import type {
  ActionCycleCorrectnessIdentity,
  ResolvedCorrectnessProfile,
} from '../../src/contracts/correctness';
import type { Outcome } from '../../src/contracts/discriminants';
import {
  readFinalSuiteRecord,
  validateFinalSuiteRecordV2,
  type FinalSuiteChildRecordV2,
} from '../../src/contracts/final-suite-record';
import type { CleanupResult, RunOwnershipRecord } from '../../src/contracts/runtime';
import {
  CHECK_RESULT_CONTRACT_SCHEMA_VERSION,
  DIAGNOSTIC_SUITE_RESULT_SCHEMA_VERSION,
  DIAGNOSTIC_SUITE_SCHEMA_VERSION,
} from '../../src/contracts/schema-versions';
import {
  REPRESENTATIVE_SUITE_CASE_COUNT,
  REPRESENTATIVE_SUITE_ID,
  deriveDiagnosticSuiteFingerprint,
  diagnosticSuiteRequestProblem,
  parseDiagnosticSuite,
  suiteLineageViolations,
  type PublicSuiteLineageV1,
} from '../../src/contracts/suite';
import { readFinalPublicRecordFile } from '../../src/evidence/final-reader';
import { readFinalSuiteRecordFile } from '../../src/evidence/final-suite-reader';
import {
  buildCleanupProjection,
  buildEstablishedOwnership,
  buildPublicLaunchFacts,
} from '../../src/evidence/public-dto';
import { RunRecordExistsError } from '../../src/evidence/writer';
import type { DiagnosticExecutionOutcome } from '../../src/orchestration/diagnostic-execution';
import {
  runFinalDiagnosticActivePath,
  runFinalSuiteActivePath,
  type FinalActivePathRunOperationals,
  type FinalDiagnosticActivePathInput,
  type FinalSuiteActivePathInput,
  type FinalSuiteAggregateContext,
  type FinalSuiteMemberInput,
} from '../../src/orchestration/final-active-path';
import {
  aggregateSuiteChildren,
  suiteSeverityOf,
  type SuiteChildOutcome,
} from '../../src/orchestration/suite-execution';
import type { MaterializedExecutionEnvelopeV1 } from '../../src/planner/execution-materialization';
import {
  planCase,
  planCaseForExecution,
  type PlanForExecutionResult,
} from '../../src/planner/plan-case';
import { DEFAULT_ENVIRONMENT_CELL_ID } from '../../src/runtime/environment';
import type {
  FinalExecutionObservation,
  FinalExecutionPayload,
} from '../../src/runtime/execute-plan';
import { resolveToolkitRoot } from '../../src/runtime/paths';

/**
 * Representative Diagnostic suite (ADR 0019 R12–R14; design §7).
 *
 * These tests prove the closed declaration/request contract, the deterministic
 * aggregate precedence, and the sequential coordinator's ownership behaviour
 * with injected children. The real all-PASS eight-child run is a separate
 * real-browser proof; nothing here launches.
 */

const MIGRATED_STABLE_REQUESTS: readonly { stable: string; priorFixture: string }[] = [
  { stable: 'layer-text-move-drag-ordinary.json', priorFixture: 'layer-text-move.request.json' },
  {
    stable: 'layer-text-move-drag-warped-nested.json',
    priorFixture: 'layer-text-move-warped.request.json',
  },
  {
    stable: 'layer-image-upload-replace.json',
    priorFixture: 'layer-image-upload-replace.request.json',
  },
  {
    stable: 'container-object-move-nested-rotated.json',
    priorFixture: 'container-object-move.request.json',
  },
  { stable: 'layer-crossword-create.json', priorFixture: 'layer-crossword-create.request.json' },
];

function skillRoot(): string {
  return resolveToolkitRoot();
}

function requestPath(name: string): string {
  return path.join(skillRoot(), 'cases', 'diagnostic', 'requests', name);
}

function priorFixturePath(name: string): string {
  return path.join(skillRoot(), 'tests', 'integration', 'fixtures', name);
}

const createdDirs: string[] = [];

afterEach(() => {
  for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PROVENANCE_HEAVY_SUITE_TIMEOUT_MS = 15_000;

function runSuite(input: Parameters<typeof runDiagnosticSuiteCommand>[0]) {
  let evidenceRoot = input.evidenceRoot;
  if (evidenceRoot === undefined) {
    const parent = mkdtempSync(path.join(os.tmpdir(), 'suite-aggregate-parent-'));
    createdDirs.push(parent);
    evidenceRoot = path.join(realpathSync(parent), 'aggregate');
  }
  const appRoot = process.env.MAKEIT_ARTWORK_APP_ROOT;
  if (!appRoot) {
    throw new Error('wp5f-suite tests require MAKEIT_ARTWORK_APP_ROOT.');
  }
  return runDiagnosticSuiteCommand({
    appRoot,
    ...input,
    evidenceRoot,
  });
}

describe('[ADR 0019 R12] representative suite declaration', () => {
  it('declares exactly eight members in canonical order with stable request paths', () => {
    const loaded = loadDiagnosticSuite(REPRESENTATIVE_SUITE_ID);
    expect(loaded.suite.schemaVersion).toBe(DIAGNOSTIC_SUITE_SCHEMA_VERSION);
    expect(loaded.suite.suiteId).toBe(REPRESENTATIVE_SUITE_ID);
    expect(loaded.suite.profile).toBe('diagnostic');
    expect(loaded.suite.execution).toBe('sequential-independent-runs');
    expect(loaded.suite.cases).toHaveLength(REPRESENTATIVE_SUITE_CASE_COUNT);
    expect(loaded.suite.cases.map((entry) => entry.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    for (const entry of loaded.suite.cases) {
      expect(entry.request.startsWith('cases/diagnostic/requests/')).toBe(true);
      expect(entry.request).not.toContain('tests/');
      expect(entry.expectedOutcome).toBe('PASS');
    }
    expect(loaded.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reads every stable request exactly once and never a tests/** fixture', () => {
    const loaded = loadDiagnosticSuite(REPRESENTATIVE_SUITE_ID);
    const requests = resolveSuiteRequests(loaded);
    expect(requests).toHaveLength(REPRESENTATIVE_SUITE_CASE_COUNT);
    for (const entry of requests) {
      expect(entry.absolutePath.startsWith(path.join(skillRoot(), 'cases'))).toBe(true);
      expect(entry.request).toBeTypeOf('object');
    }
  });

  it('binds each declared caseId to the planner identity of its stable request', () => {
    const bundle = loadCatalogueBundle();
    const loaded = loadDiagnosticSuite(REPRESENTATIVE_SUITE_ID);
    for (const member of resolveSuiteRequests(loaded)) {
      const plan = planCase(member.request, { catalogues: bundle });
      expect(plan.status).toBe('PLANNED');
      if (plan.status !== 'PLANNED') continue;
      expect(plan.caseId).toBe(member.declaration.caseId);
      expect(plan.request.profile).toBe('diagnostic');
    }
  });

  it('rejects every duplicate, gap, non-canonical order, duplicate request, and duplicate caseId', () => {
    const declaration = buildDeclaration() as { cases: readonly unknown[] };
    expect(declaration.cases).toHaveLength(REPRESENTATIVE_SUITE_CASE_COUNT);
  });
});

function buildDeclaration(): unknown {
  const loaded = loadDiagnosticSuite(REPRESENTATIVE_SUITE_ID);
  return JSON.parse(
    JSON.stringify({
      schemaVersion: loaded.suite.schemaVersion,
      suiteId: loaded.suite.suiteId,
      version: loaded.suite.version,
      profile: loaded.suite.profile,
      execution: loaded.suite.execution,
      cases: loaded.suite.cases,
    }),
  ) as unknown;
}

interface MutableDeclaration {
  schemaVersion: number;
  suiteId: string;
  version: number;
  profile: string;
  execution: string;
  cases: { order: number; caseId: string; request: string; expectedOutcome: string }[];
}

/**
 * Copies the real declaration and its eight stable requests into an isolated
 * temporary skill root so negative declaration/request mutations never touch
 * the checked-in suite. The declaration is rewritten byte-for-byte from the
 * loader, so only the requested mutation differs.
 */
function writeTempSuiteRoot(
  mutate: (declaration: MutableDeclaration) => void,
  options: { mutateRequest?: (index: number, request: Record<string, unknown>) => unknown } = {},
): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'suite-root-extra-'));
  createdDirs.push(root);
  mkdirSync(path.join(root, 'cases', 'diagnostic', 'suites'), { recursive: true });
  mkdirSync(path.join(root, 'cases', 'diagnostic', 'requests'), { recursive: true });
  const loaded = loadDiagnosticSuite(REPRESENTATIVE_SUITE_ID);
  const declaration = JSON.parse(
    JSON.stringify({
      schemaVersion: loaded.suite.schemaVersion,
      suiteId: loaded.suite.suiteId,
      version: loaded.suite.version,
      profile: loaded.suite.profile,
      execution: loaded.suite.execution,
      cases: loaded.suite.cases,
    }),
  ) as MutableDeclaration;
  mutate(declaration);
  declaration.cases.forEach((entry, index) => {
    const source = readFileSync(path.join(skillRoot(), entry.request), 'utf8');
    const parsed = JSON.parse(source) as Record<string, unknown>;
    const next =
      options.mutateRequest === undefined ? parsed : options.mutateRequest(index, parsed);
    const fileName = entry.request.split('/').pop() as string;
    writeFileSync(
      path.join(root, 'cases', 'diagnostic', 'requests', fileName),
      `${JSON.stringify(next, null, 2)}\n`,
      'utf8',
    );
    entry.request = `cases/diagnostic/requests/${fileName}`;
  });
  writeFileSync(
    path.join(root, 'cases', 'diagnostic', 'suites', 'representative.v1.json'),
    `${JSON.stringify(declaration, null, 2)}\n`,
    'utf8',
  );
  return root;
}

describe('[ADR 0019 R12] closed suite validation', () => {
  const valid = buildDeclaration() as {
    cases: { order: number; caseId: string; request: string; expectedOutcome: string }[];
    [key: string]: unknown;
  };

  it('rejects an unknown suite id before reading any file', () => {
    expect(() => parseDiagnosticSuite(valid, 'not-a-suite')).toThrow(/Unknown Diagnostic suite/);
  });

  it('rejects an unsupported schema version and a mismatched identity', () => {
    expect(() =>
      parseDiagnosticSuite({ ...valid, schemaVersion: 2 }, REPRESENTATIVE_SUITE_ID),
    ).toThrow(/unsupported schema version/);
    expect(() =>
      parseDiagnosticSuite({ ...valid, suiteId: 'other' }, REPRESENTATIVE_SUITE_ID),
    ).toThrow(/does not match requested suite/);
  });

  it('rejects a wrong profile, a wrong execution model, and a non-PASS expectation', () => {
    expect(() =>
      parseDiagnosticSuite({ ...valid, profile: 'release' }, REPRESENTATIVE_SUITE_ID),
    ).toThrow(/profile must be/);
    expect(() =>
      parseDiagnosticSuite({ ...valid, execution: 'parallel' }, REPRESENTATIVE_SUITE_ID),
    ).toThrow(/execution must be/);
    const mutated = JSON.parse(JSON.stringify(valid)) as typeof valid;
    mutated.cases[2]!.expectedOutcome = 'BUG';
    expect(() => parseDiagnosticSuite(mutated, REPRESENTATIVE_SUITE_ID)).toThrow(/expectedOutcome/);
  });

  it('rejects a duplicate order, a gap, and an unordered declaration', () => {
    const duplicate = JSON.parse(JSON.stringify(valid)) as typeof valid;
    duplicate.cases[1]!.order = 1;
    expect(() => parseDiagnosticSuite(duplicate, REPRESENTATIVE_SUITE_ID)).toThrow(
      /duplicate order/,
    );

    const gap = JSON.parse(JSON.stringify(valid)) as typeof valid;
    gap.cases[7]!.order = 9;
    expect(() => parseDiagnosticSuite(gap, REPRESENTATIVE_SUITE_ID)).toThrow(
      /contiguous canonical order/,
    );

    const unordered = JSON.parse(JSON.stringify(valid)) as typeof valid;
    unordered.cases[0]!.order = 2;
    unordered.cases[1]!.order = 1;
    expect(() => parseDiagnosticSuite(unordered, REPRESENTATIVE_SUITE_ID)).toThrow(
      /authored in canonical order/,
    );
  });

  it('rejects a duplicate request and a duplicate caseId', () => {
    const duplicateRequest = JSON.parse(JSON.stringify(valid)) as typeof valid;
    duplicateRequest.cases[3]!.request = duplicateRequest.cases[2]!.request;
    expect(() => parseDiagnosticSuite(duplicateRequest, REPRESENTATIVE_SUITE_ID)).toThrow(
      /duplicate request/,
    );
    const duplicateCase = JSON.parse(JSON.stringify(valid)) as typeof valid;
    duplicateCase.cases[3]!.caseId = duplicateCase.cases[2]!.caseId;
    expect(() => parseDiagnosticSuite(duplicateCase, REPRESENTATIVE_SUITE_ID)).toThrow(
      /duplicate caseId/,
    );
  });

  it('rejects an incomplete or over-declared representative membership', () => {
    const short = JSON.parse(JSON.stringify(valid)) as typeof valid;
    short.cases = short.cases.slice(0, 7);
    expect(() => parseDiagnosticSuite(short, REPRESENTATIVE_SUITE_ID)).toThrow(
      /exactly 8 representative members/,
    );
    const long = JSON.parse(JSON.stringify(valid)) as typeof valid;
    const extra = JSON.parse(JSON.stringify(long.cases[0]!)) as (typeof long.cases)[number];
    extra.order = 9;
    extra.request = 'cases/diagnostic/requests/extra.json';
    extra.caseId = 'extra-case';
    long.cases.push(extra);
    expect(() => parseDiagnosticSuite(long, REPRESENTATIVE_SUITE_ID)).toThrow(
      /exactly 8 representative members/,
    );
  });

  it('rejects traversal, absolute, encoded, and out-of-root request paths', () => {
    expect(
      diagnosticSuiteRequestProblem('cases/diagnostic/requests/../fixtures/x.json'),
    ).not.toBeNull();
    expect(
      diagnosticSuiteRequestProblem('cases/diagnostic/requests/../../secret.json'),
    ).not.toBeNull();
    expect(diagnosticSuiteRequestProblem('/abs/requests/x.json')).not.toBeNull();
    expect(diagnosticSuiteRequestProblem('C:/requests/x.json')).not.toBeNull();
    expect(diagnosticSuiteRequestProblem('cases\\diagnostic\\requests\\x.json')).not.toBeNull();
    expect(diagnosticSuiteRequestProblem('cases/diagnostic/requests/%2e%2e/x.json')).not.toBeNull();
    expect(diagnosticSuiteRequestProblem('tests/integration/fixtures/x.json')).not.toBeNull();
    expect(diagnosticSuiteRequestProblem('cases/diagnostic/requests/sub/x.json')).not.toBeNull();
    expect(diagnosticSuiteRequestProblem('cases/diagnostic/requests/x.json')).toBeNull();
  });

  it('fails closed on an unavailable declared request before any child', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'suite-root-'));
    createdDirs.push(root);
    mkdirSync(path.join(root, 'cases', 'diagnostic', 'suites'), { recursive: true });
    mkdirSync(path.join(root, 'cases', 'diagnostic', 'requests'), { recursive: true });
    const declaration = JSON.parse(JSON.stringify(valid)) as typeof valid;
    declaration.cases = declaration.cases.map((entry, index) => ({
      ...entry,
      order: index + 1,
      request: `cases/diagnostic/requests/absent-${index + 1}.json`,
    }));
    writeFileSync(
      path.join(root, 'cases', 'diagnostic', 'suites', 'representative.v1.json'),
      JSON.stringify(declaration),
      'utf8',
    );

    let calls = 0;
    const result = await runSuite({
      suiteId: REPRESENTATIVE_SUITE_ID,
      rootDir: root,
      runId: `suite-missing-case-${Date.now()}`,
      runChild: async () => {
        calls += 1;
        throw new Error('must not be called');
      },
    });
    expect(calls).toBe(0);
    expect(result.status).toBe('HARNESS_BLOCKED');
    expect(result.launchAttempted).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toContain('DIAGNOSTIC_SUITE_INVALID');
  });

  it('is deterministic: the same declaration yields the same fingerprint', () => {
    const loaded = loadDiagnosticSuite(REPRESENTATIVE_SUITE_ID);
    expect(deriveDiagnosticSuiteFingerprint(loaded.suite)).toBe(loaded.fingerprint);
  });

  it('rejects a stale declared case identity before launching any child', async () => {
    const root = writeTempSuiteRoot((declaration) => {
      declaration.cases[0]!.caseId = 'stale-case-identity';
    });
    let calls = 0;
    const result = await runSuite({
      suiteId: REPRESENTATIVE_SUITE_ID,
      rootDir: root,
      runId: `suite-stale-case-${Date.now()}`,
      runChild: async () => {
        calls += 1;
        throw new Error('must not be called');
      },
    });
    expect(calls).toBe(0);
    expect(result.status).toBe('HARNESS_BLOCKED');
    expect(result.launchAttempted).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toContain('DIAGNOSTIC_SUITE_INVALID');
  });

  it('rejects a non-Diagnostic member request before launching any child', async () => {
    const loaded = loadDiagnosticSuite(REPRESENTATIVE_SUITE_ID);
    const root = writeTempSuiteRoot((declaration) => declaration, {
      mutateRequest: (index, request) => {
        if (index !== 4) return request;
        return { ...request, profile: 'release' };
      },
    });
    let calls = 0;
    const result = await runSuite({
      suiteId: REPRESENTATIVE_SUITE_ID,
      rootDir: root,
      runId: `suite-wrong-profile-${Date.now()}`,
      runChild: async () => {
        calls += 1;
        throw new Error('must not be called');
      },
    });
    expect(calls).toBe(0);
    expect(result.status).toBe('HARNESS_BLOCKED');
    expect(result.launchAttempted).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toContain('DIAGNOSTIC_SUITE_INVALID');
    expect(loaded.suite.cases[4]?.request).toContain('layer-crossword-create.json');
  });
});

describe('[ADR 0019 R12] stable request migration parity', () => {
  it('materializes identically to the prior accepted fixture for every migrated 5-A–5-E request', () => {
    const bundle = loadCatalogueBundle();
    for (const entry of MIGRATED_STABLE_REQUESTS) {
      const stable = planCase(JSON.parse(readJson(requestPath(entry.stable))) as unknown, {
        catalogues: bundle,
      });
      const prior = planCase(
        JSON.parse(readJson(priorFixturePath(entry.priorFixture))) as unknown,
        { catalogues: bundle },
      );
      expect(stable.status, entry.stable).toBe('PLANNED');
      expect(prior.status, entry.priorFixture).toBe('PLANNED');
      if (stable.status !== 'PLANNED' || prior.status !== 'PLANNED') continue;
      expect(stable.caseId, entry.stable).toBe(prior.caseId);
      expect(stable.materializationFingerprint, entry.stable).toBe(
        prior.materializationFingerprint,
      );
      expect(stable.planFingerprint, entry.stable).toBe(prior.planFingerprint);
    }
  });
});

function readJson(target: string): string {
  return readFileSync(target, 'utf8');
}

// ── Current suite orchestration fixtures ─────────────────────────────────────

const bundle = loadCatalogueBundle();
const resolvedRequests = resolveSuiteRequests(loadDiagnosticSuite(REPRESENTATIVE_SUITE_ID));

const REPRESENTATIVE_FILES = [
  'layer-text-move-drag-ordinary.json',
  'layer-text-move-drag-warped-nested.json',
  'layer-image-upload-replace.json',
  'container-object-move-nested-rotated.json',
  'layer-crossword-create.json',
  'artwork-editor-history-undo-redo.json',
  'artwork-editor-serialize-restore-normalized.json',
  'artwork-editor-serialize-restore-mixed-raw.json',
] as const;

function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'suite-artifact-'));
  createdDirs.push(root);
  return root;
}

function representativeRequest(fileName: string): unknown {
  const entry = resolvedRequests.find(
    (candidate) => path.basename(candidate.relativePath) === fileName,
  );
  if (entry === undefined) throw new Error(`missing representative request ${fileName}`);
  return entry.request;
}

interface PreparedCase {
  readonly fileName: string;
  readonly planning: Extract<PlanForExecutionResult, { status: 'PLANNED' }>;
  readonly envelope: MaterializedExecutionEnvelopeV1;
  readonly profile: ResolvedCorrectnessProfile;
  readonly actionCycle: ActionCycleCorrectnessIdentity;
}

const preparedCache = new Map<string, PreparedCase>();

function prepare(fileName: string): PreparedCase {
  const cached = preparedCache.get(fileName);
  if (cached !== undefined) return cached;
  const planning = planCaseForExecution(representativeRequest(fileName), { catalogues: bundle });
  if (planning.status !== 'PLANNED')
    throw new Error(`${fileName} did not plan: ${planning.status}`);
  if (planning.envelope === null) throw new Error(`${fileName} produced no envelope`);
  const envelope = planning.envelope;
  const profile = envelope.correctnessProfile as unknown as ResolvedCorrectnessProfile;
  const prepared: PreparedCase = {
    fileName,
    planning,
    envelope,
    profile,
    actionCycle: {
      schemaVersion: CHECK_RESULT_CONTRACT_SCHEMA_VERSION,
      actionCycleId: `suite-cycle-${fileName}`,
      resolvedProfileFingerprint: profile.resolvedFingerprint,
      readinessFingerprint: profile.componentFingerprints.readiness,
    },
  };
  preparedCache.set(fileName, prepared);
  return prepared;
}

function readinessPolicy(profile: ResolvedCorrectnessProfile) {
  return {
    policy: {
      profileId: profile.readiness.profileId,
      deadlineCategory: profile.readiness.deadlineCategory,
      deadlineMs: profile.readiness.deadlineMs,
      signalWatchdogMs: profile.readiness.signalWatchdogMs,
      fallbackCadenceMs: [...profile.readiness.fallbackCadenceMs],
      stableFrames: profile.readiness.stableFrames,
      quiescenceRequired: profile.readiness.quiescenceRequired,
      stableFrameRequired: profile.readiness.stableFrameRequired,
    },
    observation: { outcome: 'unusable', authority: 'missing' },
  };
}

function authoritativeEvidence(profile: ResolvedCorrectnessProfile) {
  return profile.requiredAuthoritativeEvidence.map((evidenceId) => ({
    evidenceId,
    availability: 'authoritative' as const,
  }));
}

/**
 * The delivered no-authority payload for one compiled family. It is
 * family-discriminant-correct (so it reaches the kernel without an adapter or
 * discriminant disagreement) yet carries no authority, so every required check
 * classifies `UNUSABLE` and the child is `HARNESS_BLOCKED`. It deliberately
 * avoids the full per-family PASS fixture set.
 */
function noAuthorityPayload(prepared: PreparedCase): FinalExecutionPayload {
  const kind = prepared.profile.oracle.evaluatorKind;
  switch (kind) {
    case 'geometry-delta':
      return {
        evaluatorKind: 'geometry-delta',
        projection: null,
        minimumDelta: null,
        delta: null,
        evidence: [],
      };
    case 'warped-text-envelope':
      return {
        evaluatorKind: 'warped-text-envelope',
        projection: null,
        minimumDelta: null,
        oracle: null,
        evidence: [],
      };
    case 'nested-object-affine':
      return {
        evaluatorKind: 'nested-object-affine',
        projection: null,
        minimumDelta: null,
        oracle: null,
        evidence: [],
      };
    case 'image-upload-replace':
      return {
        evaluatorKind: 'image-upload-replace',
        projection: {
          schemaVersion: 4 as const,
          family: 'image' as const,
          cycles: [
            {
              checkpoint: 'after-upload-current',
              mode: 'upload',
              outcome: 'HARNESS_BLOCKED',
              observationId: null,
              tornRecaptureCount: 0,
              actionCycleRef: prepared.actionCycle.actionCycleId,
            },
          ],
        },
        mode: 'upload',
        targetId: 'suite-image-target',
        expectedLayoutId: 'suite-image-layout',
        expectedFrame: { x: 0, y: 0, width: 32, height: 24, rotation: 0 },
        expectedResource: {
          logicalId: 'image.upload-a',
          version: 1,
          sha256: 'f'.repeat(64),
          byteLength: 1,
          mimeType: 'image/png',
          dimensions: { width: 32, height: 24 },
          probes: [],
        },
        acceptedUpload: null,
        oracle: null,
        raster: null,
        readiness: readinessPolicy(prepared.profile) as never,
        evidence: [],
      };
    case 'crossword-determinism':
      return {
        evaluatorKind: 'crossword-determinism',
        projection: {
          schemaVersion: 4 as const,
          family: 'crossword' as const,
          providerId: 'playwright-clock-fixed-wall-v1',
          namespace: 'crossword.create.date-now.v1',
          comparisonProfileId: 'crossword-determinism-comparison-v1',
          executions: (['A1', 'A2', 'B'] as const).map((executionRole) => ({
            executionRole,
            clockBaselineUtc: '2026-01-01T00:00:00.000Z',
            expectedSeed: 1,
            actualSeed: 1,
            hostLayoutId: 'suite-crossword-host',
            createdTargetId: 'suite-crossword-target',
            words: [],
            semanticDigest: '0'.repeat(64),
            actionCycleRef: prepared.actionCycle.actionCycleId,
          })),
          comparison: {
            sameSeedEqual: true,
            sameWordsEqual: true,
            sameSemanticDigestEqual: true,
            controlSeedDifferent: false,
            controlWordsEqual: true,
            controlSemanticDigestDifferent: false,
          },
        },
        clock: null,
        sourceFingerprintExpected: '',
        executions: [],
        oracle: null,
        evidence: [],
      };
    case 'history-cross-subject':
      return {
        evaluatorKind: 'history-cross-subject',
        projection: {
          schemaVersion: 4 as const,
          family: 'history' as const,
          normalizationProfileId: 'artwork-product-meaning-v1',
          readinessProfileId: prepared.profile.readiness.profileId,
          oracleProfileId: prepared.profile.oracle.oracleProfileId,
          timingCategory: prepared.profile.readiness.deadlineCategory,
          deadlineMs: prepared.profile.readiness.deadlineMs,
          retainedLayoutId: 'suite-history-layout',
          finalHistory: { pastDepth: 0, futureDepth: 0, baselineClean: true },
          actionCycleRef: prepared.actionCycle.actionCycleId,
        },
        retainedLayoutId: null,
        setup: [],
        actions: [],
        finalHistory: null,
        readiness: readinessPolicy(prepared.profile) as never,
        oracle: null,
        evidence: [],
      };
    case 'frontend-restore':
      return {
        evaluatorKind: 'frontend-restore',
        projection: {
          schemaVersion: 4 as const,
          family: 'restore' as const,
          normalizationProfileId: 'artwork-normalized-meaning-v1',
          readinessProfileId: prepared.profile.readiness.profileId,
          oracleProfileId: prepared.profile.oracle.oracleProfileId,
          timingCategory: prepared.profile.readiness.deadlineCategory,
          deadlineMs: prepared.profile.readiness.deadlineMs,
          scenarioId: 'serialize-roundtrip',
          sourceDocumentId: 'suite-restore-source',
          restoredDocumentId: 'suite-restore-restored',
          actionCycleRef: prepared.actionCycle.actionCycleId,
        },
        schemaVersion: 1,
        transition: {},
        meaning: {},
        rawSemantics: {},
        source: null,
        restored: null,
        setup: [],
        readiness: readinessPolicy(prepared.profile) as never,
        oracle: null,
        evidence: [],
      };
  }
}

/** A trustworthy ordinary-Text PASS payload for the representative text case. */
function passTextPayload(prepared: PreparedCase): FinalExecutionPayload {
  const checkId = prepared.profile.requiredChecks[0]?.checkId as string;
  const delta = projectOrdinaryTextLiveFact(
    evaluateGeometryDeltaOracle({
      minimumDelta: { x: 40, y: 20 },
      canonicalBefore: { x: 100, y: 100 },
      canonicalAfter: { x: 150, y: 130 },
      renderedBefore: { x: 100, y: 100 },
      renderedAfter: { x: 150, y: 130 },
    }),
  );
  return {
    evaluatorKind: 'geometry-delta',
    projection: null,
    minimumDelta: { x: 40, y: 20 },
    delta: { ...delta, checkId },
    evidence: authoritativeEvidence(prepared.profile),
  };
}

/** A product-mismatch ordinary-Text BUG payload. */
function bugTextPayload(prepared: PreparedCase): FinalExecutionPayload {
  const checkId = prepared.profile.requiredChecks[0]?.checkId as string;
  const delta = projectOrdinaryTextLiveFact(
    evaluateGeometryDeltaOracle({
      minimumDelta: { x: 40, y: 20 },
      canonicalBefore: { x: 100, y: 100 },
      canonicalAfter: { x: 105, y: 105 },
      renderedBefore: { x: 100, y: 100 },
      renderedAfter: { x: 105, y: 105 },
    }),
  );
  return {
    evaluatorKind: 'geometry-delta',
    projection: null,
    minimumDelta: { x: 40, y: 20 },
    delta: { ...delta, checkId },
    evidence: authoritativeEvidence(prepared.profile),
  };
}

// ── Safe operational fixtures ────────────────────────────────────────────────

const OWNERSHIP_FIXTURE: RunOwnershipRecord = {
  runId: 'suite-owned-run',
  repoRoot: '/suite-fixture-repo',
  skillRoot: '/suite-fixture-repo/agents/verify-artwork-editor',
  repoRelativeDistDir: '.next/verify-runs/suite-owned-run',
  distDir: '/suite-fixture-repo/.next/verify-runs/suite-owned-run',
  scratchRoot: '/suite-fixture-scratch/suite-owned-run',
  evidenceRoot: '/suite-fixture-evidence/suite-owned-run',
  routeNamespace: 'suite-route-namespace',
  storageNamespace: 'suite-storage-namespace',
  port: 4321,
  baseUrl: 'http://127.0.0.1:4321',
  environmentCellId: DEFAULT_ENVIRONMENT_CELL_ID,
  schemaVersion: 1,
  owner: 'verify-artwork-editor',
  state: 'launched',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  processPid: 4242,
  processGroupId: 4242,
  ownedCommand: null,
  serverLogPath: '/suite-fixture-scratch/suite-owned-run/server.log',
  repoConfigSnapshot: null,
  activeCase: null,
};

const CLEANUP_FIXTURE: CleanupResult = {
  schemaVersion: 1,
  runId: 'suite-owned-run',
  attempted: true,
  complete: true,
  alreadyClean: false,
  refusedReason: null,
  detail: 'fixture cleanup',
  verification: {
    processSignalled: 15,
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
};

/** The operational region of the public v4 child record, tied to one run id. */
function operationalFor(
  prepared: PreparedCase,
  runId: string,
  overrides: Partial<FinalActivePathRunOperationals> = {},
): FinalActivePathRunOperationals {
  const contracts = prepared.planning.materializedCase.contracts;
  const route = prepared.planning.materializedCase.route;
  const fixture = prepared.planning.materializedCase.fixture;
  const profile = prepared.profile;
  return {
    provenance: prepared.planning.request.provenance,
    evidenceDepth: prepared.planning.request.evidenceDepth,
    environmentCellId: DEFAULT_ENVIRONMENT_CELL_ID,
    repository: {
      commit: contracts.registryFingerprint.slice(0, 40),
      dirty: true,
      lockfileDigest: contracts.applicationInventoryFingerprint,
    },
    fingerprints: {
      registry: contracts.registryFingerprint,
      applicationInventory: contracts.applicationInventoryFingerprint,
      operationCatalogue: contracts.operationCatalogueFingerprint,
      adapterCatalogue: contracts.adapterCatalogueFingerprint,
      workflowCatalogue: contracts.workflowCatalogueFingerprint,
      workflowSteps: deriveWorkflowStepCatalogueFingerprint(bundle.workflowStepCatalogue),
      coverageModel: contracts.coverageModelFingerprint,
      readinessProfile: `${profile.readiness.profileId}@${profile.readiness.schemaVersion}`,
      oracleProfile: `${profile.oracle.oracleProfileId}@${profile.oracle.schemaVersion}`,
    },
    adapter: {
      adapterId: route.adapterId,
      compatibilityVersion: route.adapterCompatibilityVersion,
    },
    workflow: { workflowId: route.workflowId, version: contracts.workflowVersion },
    fixture:
      fixture === undefined
        ? { fixtureId: 'suite-no-fixture', constructorId: 'suite-none', constructorVersion: 1 }
        : {
            fixtureId: fixture.fixtureId,
            constructorId: fixture.constructorId,
            constructorVersion: fixture.constructorVersion,
          },
    targets: [{ role: 'suite-target-role', elementId: 'suite-target-element' }],
    readiness: {
      profileId: profile.readiness.profileId,
      timingCategory: profile.readiness.deadlineCategory,
      deadlineMs: profile.readiness.deadlineMs,
      wakeSource: 'none',
      fallbackPollCount: 0,
      watchdogWaits: 0,
      rendererStableFrames: 0,
      timings: { setup: 12, action: 34 },
    },
    launch: buildPublicLaunchFacts({
      attempted: true,
      pid: 4242,
      processGroupId: 4242,
      readinessMs: 812,
      serverLogPath: '/suite-fixture-scratch/suite-owned-run/server.log',
    }),
    ownership: buildEstablishedOwnership(
      { ...OWNERSHIP_FIXTURE, runId },
      'launched',
      `.next/verify-runs/${runId}`,
      'agents/verify-artwork-editor',
    ),
    cleanup: buildCleanupProjection({ ...CLEANUP_FIXTURE, runId }),
    diagnostics: [],
    runError: null,
    recordedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Wraps one executor family payload in the exact envelope-bound handoff. */
function observationOf(
  prepared: PreparedCase,
  payload: FinalExecutionPayload,
): FinalExecutionObservation {
  return {
    envelope: prepared.envelope,
    actionCycle: prepared.actionCycle,
    payload,
    observationId: 'suite-observation',
  };
}

/**
 * Builds the facts the suite CLI's `runChild` seam hands back for one member.
 * The observation is family-discriminant-correct: real text PASS/BUG for the
 * ordinary text member, and a no-authority payload for every other family. An
 * allocation refusal and an incomplete cleanup are the environment-failure
 * shapes.
 */
function factsFor(
  fileName: string,
  options: {
    readonly observation?: FinalExecutionPayload;
    readonly cleanupSucceeded?: boolean;
    readonly allocationFailed?: boolean;
  } = {},
): DiagnosticRunFacts {
  const prepared = prepare(fileName);
  const allocationFailed = options.allocationFailed === true;
  const runId = `representative-v1-member-${fileName}`;
  return {
    planning: prepared.planning,
    prelaunch: allocationFailed
      ? {
          kind: 'allocation-failed',
          reason: 'PORT_UNAVAILABLE',
          detail: 'the configured port is already occupied',
        }
      : {
          kind: 'reserved',
          allocationId: `suite-allocation-${fileName}`,
          executionInstanceId: `suite-instance-${fileName}`,
        },
    observation: allocationFailed
      ? null
      : observationOf(prepared, options.observation ?? noAuthorityPayload(prepared)),
    runId,
    cleanupSucceeded: options.cleanupSucceeded ?? true,
    externalFailure: allocationFailed,
    operational: operationalFor(prepared, runId),
    durable: { evidenceRoot: tempRoot() },
    allocation: null,
    launch: null,
    cleanup: null,
    evidenceRoot: null,
    diagnostics: [],
  };
}

const SUITE_AGGREGATE_CONTEXT: FinalSuiteAggregateContext = {
  suiteExecutionId: 'representative-suite-execution',
  suiteLineageId: 'representative@v1#representative-suite-execution',
  suiteFingerprint: 'a'.repeat(64),
  repository: { commit: 'suite-commit', dirty: true, lockfileDigest: 'suite-lockfile' },
  startedAt: '2026-01-01T00:00:00.000Z',
  endedAt: '2026-01-01T00:01:00.000Z',
  durationMs: 60_000,
  recordedAt: '2026-01-01T00:01:00.000Z',
};

function memberFor(
  fileName: string,
  order: number,
  overrides: Partial<FinalSuiteMemberInput> = {},
): FinalSuiteMemberInput {
  const prepared = prepare(fileName);
  const runId = `representative-v1-c${order}-member`;
  return {
    planning: prepared.planning,
    prelaunch: {
      kind: 'reserved',
      allocationId: `suite-allocation-${order}`,
      executionInstanceId: `suite-instance-${order}`,
    },
    observation:
      order === 1
        ? observationOf(prepared, passTextPayload(prepared))
        : observationOf(prepared, noAuthorityPayload(prepared)),
    runId,
    cleanupSucceeded: true,
    operational: operationalFor(prepared, runId),
    durable: { evidenceRoot: tempRoot() },
    order,
    caseId: prepared.planning.caseId,
    requestPath: `cases/diagnostic/requests/${fileName}`,
    expectedOutcome: 'PASS',
    ...overrides,
  };
}

function representativeMembers(): FinalSuiteMemberInput[] {
  return REPRESENTATIVE_FILES.map((fileName, index) => memberFor(fileName, index + 1));
}

function suiteRunInput(
  overrides: Partial<FinalSuiteActivePathInput> = {},
): FinalSuiteActivePathInput {
  return {
    suiteId: REPRESENTATIVE_SUITE_ID,
    suiteVersion: 1,
    declaredCaseCount: REPRESENTATIVE_SUITE_CASE_COUNT,
    members: representativeMembers(),
    aggregate: SUITE_AGGREGATE_CONTEXT,
    suiteDurable: { evidenceRoot: tempRoot() },
    ...overrides,
  };
}

function standaloneInput(
  prepared: PreparedCase,
  overrides: Partial<FinalDiagnosticActivePathInput> = {},
): FinalDiagnosticActivePathInput {
  const runId = `standalone-${prepared.fileName}`;
  return {
    planning: prepared.planning,
    prelaunch: {
      kind: 'reserved',
      allocationId: `standalone-allocation-${prepared.fileName}`,
      executionInstanceId: `standalone-instance-${prepared.fileName}`,
    },
    observation: observationOf(prepared, passTextPayload(prepared)),
    runId,
    cleanupSucceeded: true,
    operational: operationalFor(prepared, runId),
    durable: { evidenceRoot: tempRoot() },
    ...overrides,
  };
}

// ── Synthetic children for the pure aggregation layer ────────────────────────

function syntheticChild(input: {
  readonly order: number;
  readonly status: Outcome;
  readonly behaviorOutcome?: Outcome | null;
  readonly caseId?: string;
  readonly request?: string;
  readonly identityAgrees?: boolean;
  readonly envelope?: MaterializedExecutionEnvelopeV1 | null;
  readonly record?: DiagnosticExecutionOutcome['record'];
}): SuiteChildOutcome {
  const caseId = input.caseId ?? `case-${input.order}`;
  const execution: DiagnosticExecutionOutcome = {
    finalOutcome: input.status,
    behaviorOutcome: input.behaviorOutcome === undefined ? input.status : input.behaviorOutcome,
    launchAttempted: false,
    prelaunch: false,
    caseId,
    materializationFingerprint: null,
    planFingerprint: null,
    evaluatorKind: null,
    compatibilityVersion: null,
    requiredChecks: [],
    unusableCheckIds: [],
    failingCheckIds: [],
    record: input.record ?? null,
    issues: [],
    diagnostics: [],
  };
  return {
    order: input.order,
    caseId,
    request: input.request ?? `cases/diagnostic/requests/case-${input.order}.json`,
    expectedOutcome: 'PASS',
    envelope: input.envelope ?? null,
    execution,
    identityAgrees: input.identityAgrees ?? true,
  };
}

function allPassChildren(): SuiteChildOutcome[] {
  return Array.from({ length: REPRESENTATIVE_SUITE_CASE_COUNT }, (_, index) =>
    syntheticChild({ order: index + 1, status: 'PASS' }),
  );
}

const LEGACY_V3_CHILD_RECORD = {
  schemaVersion: 3,
  command: 'diagnostic',
  recordedAt: '2026-01-01T00:00:00.000Z',
  runId: 'legacy-run',
  caseId: 'case-1',
  materializationFingerprint: null,
  planFingerprint: null,
  requiredChecks: [{ checkId: 'geometry.delta', passed: true }],
};

const STALE_ENVELOPE = {
  caseId: 'case-1',
  materializationFingerprint: null,
  planFingerprint: null,
  correctnessProfile: { resolvedFingerprint: 'stale', requiredChecks: [] },
} as unknown as MaterializedExecutionEnvelopeV1;

describe('[ADR 0019 R13] aggregate precedence', () => {
  it('ranks ENVIRONMENT_FAILURE > HARNESS_BLOCKED > BUG > PASS', () => {
    expect(suiteSeverityOf('PASS')).toBeLessThan(suiteSeverityOf('BUG'));
    expect(suiteSeverityOf('BUG')).toBeLessThan(suiteSeverityOf('HARNESS_BLOCKED'));
    expect(suiteSeverityOf('HARNESS_BLOCKED')).toBeLessThan(suiteSeverityOf('ENVIRONMENT_FAILURE'));
  });

  it('passes only when every declared child passed with a complete canonical execution', () => {
    const result = aggregateSuiteChildren({
      declaredCaseCount: REPRESENTATIVE_SUITE_CASE_COUNT,
      children: allPassChildren(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.finalStatus).toBe('PASS');
    expect(result.decision.behaviorStatus).toBe('PASS');
    expect(result.decision.complete).toBe(true);
    expect(result.decision.pass).toBe(true);
    expect(result.decision.children).toHaveLength(REPRESENTATIVE_SUITE_CASE_COUNT);
    expect(result.decision.children.map((child) => child.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('keeps BUG above PASS but below HARNESS_BLOCKED and ENVIRONMENT_FAILURE', () => {
    const result = aggregateSuiteChildren({
      declaredCaseCount: 3,
      children: [
        syntheticChild({ order: 1, status: 'PASS' }),
        syntheticChild({ order: 2, status: 'BUG' }),
        syntheticChild({ order: 3, status: 'PASS' }),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.finalStatus).toBe('BUG');
    expect(result.decision.complete).toBe(true);
    expect(result.decision.pass).toBe(false);
    expect(result.decision.children[1]?.finalOutcome).toBe('BUG');
    expect(result.decision.children[1]?.expectedMet).toBe(false);
  });

  it('ranks an environment failure above a harness block without rewriting a verdict', () => {
    const result = aggregateSuiteChildren({
      declaredCaseCount: 2,
      children: [
        syntheticChild({ order: 1, status: 'HARNESS_BLOCKED' }),
        syntheticChild({ order: 2, status: 'ENVIRONMENT_FAILURE' }),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.finalStatus).toBe('ENVIRONMENT_FAILURE');
    expect(result.decision.children[0]?.finalOutcome).toBe('HARNESS_BLOCKED');
    expect(result.decision.children[1]?.finalOutcome).toBe('ENVIRONMENT_FAILURE');
  });

  it('never claims PASS when execution was incomplete or externally interrupted', () => {
    const incomplete = aggregateSuiteChildren({
      declaredCaseCount: REPRESENTATIVE_SUITE_CASE_COUNT,
      children: allPassChildren(),
      stoppedOnCleanup: true,
    });
    expect(incomplete.ok).toBe(true);
    if (!incomplete.ok) return;
    expect(incomplete.decision.complete).toBe(false);
    expect(incomplete.decision.finalStatus).toBe('HARNESS_BLOCKED');
    expect(incomplete.decision.pass).toBe(false);

    const interrupted = aggregateSuiteChildren({
      declaredCaseCount: REPRESENTATIVE_SUITE_CASE_COUNT,
      children: allPassChildren(),
      interrupted: true,
    });
    expect(interrupted.ok).toBe(true);
    if (!interrupted.ok) return;
    expect(interrupted.decision.finalStatus).toBe('ENVIRONMENT_FAILURE');
    // Every declared child executed, yet an external interruption can never be
    // reported as a passing suite.
    expect(interrupted.decision.complete).toBe(true);
    expect(interrupted.decision.behaviorStatus).toBe('PASS');
    expect(interrupted.decision.pass).toBe(false);
  });

  it('refuses a member-count mismatch, a non-canonical order, and a duplicate member', () => {
    const count = aggregateSuiteChildren({
      declaredCaseCount: REPRESENTATIVE_SUITE_CASE_COUNT,
      children: allPassChildren().slice(0, 7),
    });
    expect(count.ok).toBe(false);
    if (!count.ok)
      expect(count.issues.map((issue) => issue.code)).toContain('SUITE_MEMBER_COUNT_MISMATCH');

    const unordered = aggregateSuiteChildren({
      declaredCaseCount: 2,
      children: [
        syntheticChild({ order: 2, status: 'PASS' }),
        syntheticChild({ order: 1, status: 'PASS' }),
      ],
    });
    expect(unordered.ok).toBe(false);
    if (!unordered.ok)
      expect(unordered.issues.map((issue) => issue.code)).toContain('SUITE_ORDER_INVALID');

    const duplicate = aggregateSuiteChildren({
      declaredCaseCount: 2,
      children: [
        syntheticChild({ order: 1, status: 'PASS', caseId: 'same' }),
        syntheticChild({ order: 2, status: 'PASS', caseId: 'same' }),
      ],
    });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok)
      expect(duplicate.issues.map((issue) => issue.code)).toContain('SUITE_ORDER_INVALID');
  });

  it('refuses a member whose declared identity disagrees with its resolved case', () => {
    const result = aggregateSuiteChildren({
      declaredCaseCount: 2,
      children: [
        syntheticChild({ order: 1, status: 'PASS', identityAgrees: false }),
        syntheticChild({ order: 2, status: 'PASS' }),
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.issues.map((issue) => issue.code)).toContain('SUITE_MEMBER_IDENTITY_MISMATCH');
  });

  it('refuses a legacy or invalid child record without rewriting a verdict', () => {
    const legacy = aggregateSuiteChildren({
      declaredCaseCount: 2,
      children: [
        syntheticChild({
          order: 1,
          status: 'PASS',
          envelope: STALE_ENVELOPE,
          record: LEGACY_V3_CHILD_RECORD as never,
        }),
        syntheticChild({ order: 2, status: 'PASS' }),
      ],
    });
    expect(legacy.ok).toBe(false);
    if (!legacy.ok)
      expect(legacy.issues.map((issue) => issue.code)).toContain('SUITE_CHILD_LEGACY_RECORD');

    const invalid = aggregateSuiteChildren({
      declaredCaseCount: 2,
      children: [
        syntheticChild({
          order: 1,
          status: 'PASS',
          envelope: STALE_ENVELOPE,
          record: { schemaVersion: 99 } as never,
        }),
        syntheticChild({ order: 2, status: 'PASS' }),
      ],
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok)
      expect(invalid.issues.map((issue) => issue.code)).toContain('SUITE_CHILD_INVALID_RECORD');
  });
});

describe('[ADR 0019 R12/R13] sequential coordinator with injected children', () => {
  it('rejects unsafe, aliased, and occupied aggregation roots before any child', async () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), 'suite-root-guard-'));
    createdDirs.push(parent);
    const canonicalParent = realpathSync(parent);
    const leaf = path.join(canonicalParent, 'aggregate');
    const alias = path.join(canonicalParent, 'alias');
    const danglingLeaf = path.join(canonicalParent, 'dangling-leaf');
    symlinkSync(canonicalParent, alias, 'dir');
    symlinkSync(path.join(canonicalParent, 'missing-target'), danglingLeaf, 'file');
    mkdirSync(leaf);
    const sentinel = path.join(leaf, 'keep.txt');
    writeFileSync(sentinel, 'preserve this file\n');
    let calls = 0;
    const run = (evidenceRoot: string) =>
      runSuite({
        suiteId: REPRESENTATIVE_SUITE_ID,
        runId: `suite-root-guard-${Date.now()}-${calls}`,
        evidenceRoot,
        runChild: async () => {
          calls += 1;
          throw new Error('unsafe aggregation root launched a child');
        },
      });

    const invalid = await run(`${canonicalParent}/./invalid-leaf`);
    const aliased = await run(path.join(alias, 'aliased-leaf'));
    const dangling = await run(danglingLeaf);
    const occupied = await run(leaf);

    expect([invalid, aliased, dangling, occupied].map((result) => result.status)).toEqual([
      'HARNESS_BLOCKED',
      'HARNESS_BLOCKED',
      'HARNESS_BLOCKED',
      'HARNESS_BLOCKED',
    ]);
    expect(calls).toBe(0);
    expect(readFileSync(sentinel, 'utf8')).toBe('preserve this file\n');
    expect(existsSync(path.join(canonicalParent, 'invalid-leaf'))).toBe(false);
    expect(existsSync(path.join(canonicalParent, 'aliased-leaf'))).toBe(false);
    expect(lstatSync(danglingLeaf).isSymbolicLink()).toBe(true);
  });

  it('executes eight unique children in canonical order', {
    timeout: PROVENANCE_HEAVY_SUITE_TIMEOUT_MS,
  }, async () => {
    const loaded = loadDiagnosticSuite(REPRESENTATIVE_SUITE_ID);
    const calls: { casePath: string; runId: string }[] = [];
    const suiteId = `suite-order-${Date.now()}`;
    const result = await runSuite({
      suiteId: REPRESENTATIVE_SUITE_ID,
      runId: suiteId,
      runChild: async (input) => {
        calls.push(input);
        return { ok: true, facts: factsFor(path.basename(input.casePath)) };
      },
    });

    expect(result.details?.executedCount).toBe(8);
    expect(result.details?.pass).toBe(false);
    expect(result.details?.complete).toBe(true);
    expect(calls).toHaveLength(8);
    expect(new Set(calls.map((entry) => entry.runId)).size).toBe(8);
    calls.forEach((entry, index) => {
      expect(entry.runId.startsWith(`representative-v1-c${index + 1}-`)).toBe(true);
      expect(entry.casePath).toBe(
        requestPath(loaded.suite.cases[index]!.request.split('/').pop()!),
      );
    });
    expect(result.details?.children.map((child) => child.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(result.details?.suiteRecordPath).not.toBeNull();
  });

  it('populates each child with the closed suite lineage before its run', {
    timeout: PROVENANCE_HEAVY_SUITE_TIMEOUT_MS,
  }, async () => {
    const loaded = loadDiagnosticSuite(REPRESENTATIVE_SUITE_ID);
    const lineages: PublicSuiteLineageV1[] = [];
    const suiteId = `suite-lineage-${Date.now()}`;
    const result = await runSuite({
      suiteId: REPRESENTATIVE_SUITE_ID,
      runId: suiteId,
      runChild: async (input) => {
        lineages.push(input.suiteLineage);
        return { ok: true, facts: factsFor(path.basename(input.casePath)) };
      },
    });

    expect(result.details?.executedCount).toBe(8);
    expect(lineages).toHaveLength(8);
    lineages.forEach((lineage, index) => {
      expect(lineage).toEqual({
        suiteId: REPRESENTATIVE_SUITE_ID,
        suiteVersion: loaded.suite.version,
        executionId: suiteId,
        order: index + 1,
      });
      expect(suiteLineageViolations(lineage)).toEqual([]);
    });
    // The execution id binds the child to this exact suite execution, never to
    // the child run id.
    expect(lineages.every((lineage) => lineage.executionId === suiteId)).toBe(true);
  });

  it('continues after a completed-cleanup BUG and preserves the child outcome unrewritten', {
    timeout: PROVENANCE_HEAVY_SUITE_TIMEOUT_MS,
  }, async () => {
    const seen: string[] = [];
    const suiteId = `suite-bug-${Date.now()}`;
    const result = await runSuite({
      suiteId: REPRESENTATIVE_SUITE_ID,
      runId: suiteId,
      runChild: async (input) => {
        seen.push(input.runId);
        const fileName = path.basename(input.casePath);
        const isText = fileName === 'layer-text-move-drag-ordinary.json';
        return {
          ok: true,
          facts: factsFor(fileName, {
            observation: isText ? bugTextPayload(prepare(fileName)) : undefined,
          }),
        };
      },
    });

    expect(seen).toHaveLength(8);
    expect(new Set(seen).size).toBe(8);
    const bugChild = result.details?.children.find((child) => child.order === 1);
    expect(bugChild?.status).toBe('BUG');
    expect(bugChild?.outcome).toBe('BUG');
    expect(bugChild?.expectedMet).toBe(false);
    // The remaining children still executed and remain explicit.
    expect(
      result.details?.children.filter((child) => child.status === 'HARNESS_BLOCKED'),
    ).toHaveLength(7);
  });

  it('stops before the next child when a child cleanup is incomplete', async () => {
    let calls = 0;
    const suiteId = `suite-stop-${Date.now()}`;
    const result = await runSuite({
      suiteId: REPRESENTATIVE_SUITE_ID,
      runId: suiteId,
      runChild: async (input) => {
        calls += 1;
        const fileName = path.basename(input.casePath);
        const order = Number(input.runId.split('-c')[1]?.split('-')[0] ?? '1');
        return { ok: true, facts: factsFor(fileName, { cleanupSucceeded: order !== 2 }) };
      },
    });

    expect(calls).toBe(2);
    expect(result.details?.executedCount).toBe(2);
    expect(result.details?.stoppedEarly).toBe(true);
    expect(result.details?.complete).toBe(false);
    expect(result.status).toBe('HARNESS_BLOCKED');
    expect(result.diagnostics.map((entry) => entry.code)).toContain('DIAGNOSTIC_SUITE_INCOMPLETE');
  });

  it('fails closed as bound when a child cannot allocate (occupied-port shape)', {
    timeout: PROVENANCE_HEAVY_SUITE_TIMEOUT_MS,
  }, async () => {
    const suiteId = `suite-env-${Date.now()}`;
    const result = await runSuite({
      suiteId: REPRESENTATIVE_SUITE_ID,
      runId: suiteId,
      runChild: async (input) => {
        const fileName = path.basename(input.casePath);
        const order = Number(input.runId.split('-c')[1]?.split('-')[0] ?? '1');
        return { ok: true, facts: factsFor(fileName, { allocationFailed: order === 2 }) };
      },
    });

    expect(result.status).toBe('ENVIRONMENT_FAILURE');
    expect(result.outcome).toBe('ENVIRONMENT_FAILURE');
    expect(result.launchAttempted).toBe(false);
    expect(result.details?.executedCount).toBe(8);
    expect(result.details?.complete).toBe(true);
    const failedChild = result.details?.children.find((child) => child.order === 2);
    expect(failedChild?.outcome).toBe('ENVIRONMENT_FAILURE');
    // A failed allocation fabricates no child record and never rewrites a
    // delivered child verdict.
    expect(result.details?.children[0]?.outcome).toBe('HARNESS_BLOCKED');
  });

  it('surfaces a sanitized strict-v4 child finalization refusal in the suite summary', {
    timeout: PROVENANCE_HEAVY_SUITE_TIMEOUT_MS,
  }, async () => {
    const suiteId = `suite-finalization-${Date.now()}`;
    const collisionRoot = tempRoot();
    writeFileSync(path.join(collisionRoot, 'run-record.json'), '{"existing":true}');

    const result = await runSuite({
      suiteId: REPRESENTATIVE_SUITE_ID,
      runId: suiteId,
      runChild: async (input) => {
        const fileName = path.basename(input.casePath);
        const facts = factsFor(fileName);
        const order = Number(input.runId.split('-c')[1]?.split('-')[0] ?? '1');
        return {
          ok: true,
          facts:
            order === 2
              ? {
                  ...facts,
                  durable: {
                    evidenceRoot: collisionRoot,
                    forbiddenPaths: [collisionRoot],
                  },
                }
              : facts,
        };
      },
    });

    expect(result.status).toBe('ENVIRONMENT_FAILURE');
    const failedChild = result.details?.children.find((child) => child.order === 2);
    expect(failedChild?.outcome).toBe('HARNESS_BLOCKED');
    expect(failedChild?.finalizationError).toBe(
      'Package-8 publication did not commit the final manifest (HARNESS_BLOCKED).',
    );
    expect(JSON.stringify(result)).not.toContain(collisionRoot);
    expect(
      result.details?.children
        .filter((child) => child.order !== 2)
        .every((child) => child.finalizationError === null),
    ).toBe(true);
  });

  it('aggregates a mixed PASS/ENVIRONMENT_FAILURE/HARNESS_BLOCKED result without rewriting a child', {
    timeout: PROVENANCE_HEAVY_SUITE_TIMEOUT_MS,
  }, async () => {
    const suiteId = `suite-mixed-${Date.now()}`;
    const result = await runSuite({
      suiteId: REPRESENTATIVE_SUITE_ID,
      runId: suiteId,
      runChild: async (input) => {
        const fileName = path.basename(input.casePath);
        const order = Number(input.runId.split('-c')[1]?.split('-')[0] ?? '1');
        const isText = fileName === 'layer-text-move-drag-ordinary.json';
        return {
          ok: true,
          facts: factsFor(fileName, {
            allocationFailed: order === 3,
            observation: isText ? passTextPayload(prepare(fileName)) : undefined,
          }),
        };
      },
    });

    expect(result.status).toBe('ENVIRONMENT_FAILURE');
    expect(result.details?.complete).toBe(true);
    expect(result.details?.pass).toBe(false);
    expect(result.details?.children.map((child) => child.status)).toEqual([
      'PASS',
      'HARNESS_BLOCKED',
      'ENVIRONMENT_FAILURE',
      'HARNESS_BLOCKED',
      'HARNESS_BLOCKED',
      'HARNESS_BLOCKED',
      'HARNESS_BLOCKED',
      'HARNESS_BLOCKED',
    ]);
    expect(result.details?.children[0]?.outcome).toBe('PASS');
    expect(result.details?.children[2]?.outcome).toBe('ENVIRONMENT_FAILURE');
  });

  it('never retries a failed child and never repeats a run id', {
    timeout: PROVENANCE_HEAVY_SUITE_TIMEOUT_MS,
  }, async () => {
    const runIds: string[] = [];
    const suiteId = `suite-noretry-${Date.now()}`;
    await runSuite({
      suiteId: REPRESENTATIVE_SUITE_ID,
      runId: suiteId,
      runChild: async (input) => {
        runIds.push(input.runId);
        const fileName = path.basename(input.casePath);
        const isText = fileName === 'layer-text-move-drag-ordinary.json';
        return {
          ok: true,
          facts: factsFor(fileName, {
            observation: isText ? bugTextPayload(prepare(fileName)) : undefined,
          }),
        };
      },
    });
    expect(runIds).toHaveLength(8);
    expect(new Set(runIds).size).toBe(8);
  });

  it('rejects an unsafe suite execution id before any child', async () => {
    let calls = 0;
    const result = await runSuite({
      suiteId: REPRESENTATIVE_SUITE_ID,
      runId: '../escape',
      runChild: async () => {
        calls += 1;
        throw new Error('must not run');
      },
    });
    expect(calls).toBe(0);
    expect(result.status).toBe('HARNESS_BLOCKED');
    expect(result.diagnostics.map((entry) => entry.code)).toContain('DIAGNOSTIC_SUITE_INVALID');
  });

  it('refuses a resolved child case identity that disagrees with the declaration', async () => {
    const suiteId = `suite-identity-${Date.now()}`;
    const result = await runSuite({
      suiteId: REPRESENTATIVE_SUITE_ID,
      runId: suiteId,
      runChild: async (input) => {
        const order = Number(input.runId.split('-c')[1]?.split('-')[0] ?? '1');
        if (order === 1) return { ok: true, facts: factsFor('layer-image-upload-replace.json') };
        return { ok: true, facts: factsFor(path.basename(input.casePath)) };
      },
    });
    expect(result.status).toBe('HARNESS_BLOCKED');
    expect(result.details?.complete).toBe(false);
    // No aggregate can be assembled from a refused identity; the CLI reports
    // the fail-closed status and writes no suite record.
    expect(result.details?.aggregateStatus).toBe('HARNESS_BLOCKED');
    expect(result.details?.suiteRecordPath).toBeNull();
  });
});

describe('[ADR 0019 R13] guarded aggregate suite record', () => {
  it('writes a closed suite-v2 record that reads back with safe relative references', () => {
    const outcome = runFinalSuiteActivePath(suiteRunInput());
    expect(outcome.preflight.ok).toBe(true);
    expect(outcome.suite.record?.schemaVersion).toBe(2);
    expect(outcome.suite.record?.label).toBe('suite-v2');
    expect(outcome.suite.record?.command).toBe('diagnostic');
    expect(outcome.suite.record?.suiteId).toBe(REPRESENTATIVE_SUITE_ID);
    expect(outcome.suite.record?.canonicalOrder).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(outcome.suite.record?.children).toHaveLength(REPRESENTATIVE_SUITE_CASE_COUNT);
    expect(outcome.suite.durable.wrote).toBe(true);

    const recordPath = outcome.suite.durable.path as string;
    const read = readFinalSuiteRecordFile(recordPath);
    expect(read.kind).toBe('suite-v2');
    expect(read.legacy).toBe(false);
    expect(read.current).toBe(true);

    const serialized = readFileSync(recordPath, 'utf8');
    expect(serialized).not.toContain('blob:');
    expect(serialized).not.toContain(skillRoot());
    expect(serialized).not.toContain(os.tmpdir());
    for (const child of outcome.suite.record?.children ?? []) {
      expect(diagnosticSuiteRequestProblem(child.request)).toBeNull();
    }
    for (const child of outcome.children) {
      expect(child.durable.path).not.toBeNull();
      expect(readFinalPublicRecordFile(child.durable.path as string).kind).toBe('current-v4');
    }
  });

  it('leaves child evidence untouched and yields non-PASS when the aggregate write fails', () => {
    const outcome = runFinalSuiteActivePath(
      suiteRunInput({
        writeSuiteRecord: () => {
          throw new RunRecordExistsError('simulated guarded write refusal');
        },
      }),
    );

    expect(outcome.suite.durable.required).toBe(true);
    expect(outcome.suite.durable.wrote).toBe(false);
    expect(outcome.suite.durable.error).toMatch(/simulated guarded write refusal/);
    expect(outcome.finalOutcome).toBe('ENVIRONMENT_FAILURE');
    expect(outcome.cli.details?.suiteRecordPath).toBeNull();
    expect(outcome.cli.details?.pass).toBe(false);
    // Children remain fully executed and explicit, and their records are intact.
    expect(outcome.children).toHaveLength(REPRESENTATIVE_SUITE_CASE_COUNT);
    expect(outcome.children.every((child) => child.durable.wrote)).toBe(true);
    expect(
      outcome.children.every(
        (child) => child.durable.path !== null && existsSync(child.durable.path),
      ),
    ).toBe(true);
  });

  it('never overwrites an existing suite-v2 record (exclusive write)', () => {
    const evidenceRoot = tempRoot();
    const first = runFinalSuiteActivePath(suiteRunInput({ suiteDurable: { evidenceRoot } }));
    expect(first.suite.durable.wrote).toBe(true);
    const recordPath = first.suite.durable.path as string;
    const before = readFileSync(recordPath, 'utf8');

    const second = runFinalSuiteActivePath(suiteRunInput({ suiteDurable: { evidenceRoot } }));
    expect(second.suite.durable.wrote).toBe(false);
    expect(second.suite.durable.error).toMatch(/already exists|overwrite/i);
    expect(readFileSync(recordPath, 'utf8')).toBe(before);
  });

  it('rejects a leaked absolute or private path through the recursive redaction guard', () => {
    const leakRoot = tempRoot();
    const members = representativeMembers().map((member, index) =>
      index === 0 ? { ...member, requestPath: `${leakRoot}/secret.json` } : member,
    );
    const outcome = runFinalSuiteActivePath(
      suiteRunInput({
        members,
        suiteDurable: { evidenceRoot: tempRoot(), forbiddenPaths: [leakRoot] },
      }),
    );
    expect(outcome.suite.durable.wrote).toBe(false);
    expect(outcome.suite.durable.error).toMatch(/Redaction rejected|REDACTION_PROHIBITED_VALUE/);
    expect(outcome.cli.details?.suiteRecordPath).toBeNull();
    expect(outcome.finalOutcome).toBe('ENVIRONMENT_FAILURE');
  });

  it('exposes a historical schema-1 aggregate only through the immutable legacy reader', () => {
    const legacy = {
      schemaVersion: DIAGNOSTIC_SUITE_RESULT_SCHEMA_VERSION,
      command: 'diagnostic',
      suiteId: REPRESENTATIVE_SUITE_ID,
      aggregateStatus: 'PASS',
      children: [],
    };
    const read = readFinalSuiteRecord(legacy);
    expect(read.kind).toBe('legacy-suite-v1');
    expect(read.legacy).toBe(true);
    expect(read.current).toBe(false);
    expect(read.schemaVersion).toBe(DIAGNOSTIC_SUITE_RESULT_SCHEMA_VERSION);
    expect(read.record).toEqual(legacy);
    expect(validateFinalSuiteRecordV2(legacy).ok).toBe(false);

    const target = path.join(tempRoot(), 'suite-record.json');
    writeFileSync(target, `${JSON.stringify(legacy)}\n`, 'utf8');
    expect(readFinalSuiteRecordFile(target).kind).toBe('legacy-suite-v1');
  });
});

describe('[ADR 0019 R11] suite-v2 aggregate lineage', () => {
  const validLineage: PublicSuiteLineageV1 = {
    suiteId: REPRESENTATIVE_SUITE_ID,
    suiteVersion: 1,
    executionId: 'representative-v1-20260918T183748Z-a3748b',
    order: 3,
  };

  it('accepts exactly the closed suite id/version/execution id/order shape', () => {
    expect(suiteLineageViolations(validLineage)).toEqual([]);
  });

  it('rejects unknown/missing keys, an unknown suite id, and non-positive version/order', () => {
    expect(suiteLineageViolations({ ...validLineage, runId: 'leaked-child-run-id' })).toContain(
      'unknown-key:runId',
    );
    const missing = { ...validLineage } as Record<string, unknown>;
    delete missing.order;
    expect(suiteLineageViolations(missing)).toContain('missing-key:order');
    expect(suiteLineageViolations({ ...validLineage, suiteId: 'not-a-suite' })).toContain(
      'suiteId:not-closed',
    );
    expect(suiteLineageViolations({ ...validLineage, suiteVersion: 0 })).toContain(
      'suiteVersion:not-positive-integer',
    );
    expect(suiteLineageViolations({ ...validLineage, order: 1.5 })).toContain(
      'order:not-positive-integer',
    );
  });

  it('rejects an unsafe execution id that could act as a path segment', () => {
    for (const executionId of [
      '../escape',
      'representative/../../etc/passwd',
      '/absolute/suite',
      '..',
      '',
      'C:/suite',
    ]) {
      expect(suiteLineageViolations({ ...validLineage, executionId })).toContain(
        'executionId:not-safe',
      );
    }
  });

  it('persists the immutable lineage on every aggregate child without aliasing the run id', () => {
    const outcome = runFinalSuiteActivePath(suiteRunInput());
    const children = outcome.suite.record?.children as
      | readonly FinalSuiteChildRecordV2[]
      | undefined;
    expect(children).toHaveLength(REPRESENTATIVE_SUITE_CASE_COUNT);
    (children ?? []).forEach((child, index) => {
      expect(child.suiteLineageId).toBe(SUITE_AGGREGATE_CONTEXT.suiteLineageId);
      expect(child.parentSuiteExecutionId).toBe(SUITE_AGGREGATE_CONTEXT.suiteExecutionId);
      expect(child.executionId).toBe(`${SUITE_AGGREGATE_CONTEXT.suiteExecutionId}#${index + 1}`);
      expect(child.executionId).not.toBe(child.runId);
      expect(child.childRecordLabel).toBe('current-v4');
      expect(child.childRecordSchemaVersion).toBe(4);
    });
  });

  it('reads each child back as current-v4 and never leaks lineage into a child record', () => {
    const outcome = runFinalSuiteActivePath(suiteRunInput());
    for (const child of outcome.children) {
      const read = readFinalPublicRecordFile(child.durable.path as string);
      expect(read.kind).toBe('current-v4');
      expect(Object.hasOwn(read.record as object, 'suiteLineage')).toBe(false);
    }

    // A standalone (non-suite) run carries no suite lineage at all.
    const standalone = runFinalDiagnosticActivePath(
      standaloneInput(prepare('layer-text-move-drag-ordinary.json')),
    );
    const standaloneRead = readFinalPublicRecordFile(standalone.durable.path as string);
    expect(standaloneRead.kind).toBe('current-v4');
    expect(Object.hasOwn(standaloneRead.record as object, 'suiteLineage')).toBe(false);
  });

  it('refuses a legacy or mixed child readback before any aggregate is written', () => {
    const craftedLegacy = JSON.stringify({
      schemaVersion: 2,
      command: 'diagnostic',
      checks: [{ checkId: 'geometry.delta', passed: false }],
    });
    const craftedMixed = JSON.stringify({
      schemaVersion: 3,
      command: 'diagnostic',
      checks: [{ checkId: 'geometry.delta', status: 'PASS' }],
    });
    for (const [expected, crafted] of [
      [/legacy/i, craftedLegacy],
      [/mixed/i, craftedMixed],
    ] as const) {
      const outcome = runFinalSuiteActivePath(
        suiteRunInput({
          members: representativeMembers().map((member, index) =>
            index === 0
              ? {
                  ...member,
                  writeRecord: () => {
                    const target = path.join(tempRoot(), 'run-record.json');
                    writeFileSync(target, `${crafted}\n`, 'utf8');
                    return { path: target, serialized: crafted, record: null as never };
                  },
                }
              : member,
          ),
        }),
      );
      expect(outcome.suite.durable.wrote).toBe(false);
      expect(outcome.suite.durable.error).toMatch(expected);
      expect(outcome.cli.details?.suiteRecordPath).toBeNull();
      expect(outcome.finalOutcome).toBe('ENVIRONMENT_FAILURE');
    }
  });
});

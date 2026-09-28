import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { deriveIntendedInventoryIdentity } from '../../src/canonical/package8-identity';
import {
  EVIDENCE_VERIFY_DETAILS,
  runEvidenceVerifyCommand,
  type EvidenceVerifyCommandOptions,
} from '../../src/cli/evidence';
import {
  EVIDENCE_VERIFY_CHECK_IDS,
  EVIDENCE_VERIFY_REPORT_LABEL,
  EVIDENCE_VERIFY_SCHEMA_VERSION,
  parseEvidenceVerifyArguments,
  validateEvidenceVerifyDetails,
  type EvidenceVerifyDetails,
} from '../../src/contracts/evidence-verify';
import {
  EvidenceVerifyExternalFsError,
  createNodeEvidenceVerifyFsAdapter,
  verifyEvidenceRoot,
  type EvidenceVerifyEnvironment,
} from '../../src/evidence/integrity';
import { captureCliResult } from './helpers';

/**
 * P8-B WP-B2 integration proof (ADR 0048; plan §11–§12, §19).
 *
 * Exercises the single `evidence verify --run <id>` CLI end to end: the exact
 * parser rejection surface, the closed `evidence-verify.v1` envelope, the
 * existing status/exit mapping, deterministic output, the narrow suite-v2 plus
 * committed-child-manifest check, advisory current-tree handling, and the
 * no-leak/no-`BUG` guarantees. Every case runs against a byte-preserving copy
 * inside a unique OS-temporary directory; the checked-in fixtures and every
 * accepted evidence root are never touched.
 *
 * The dispatch surface (`runCli`) is exercised through the registered
 * `captureCliResult` helper, so this file never statically imports the changed
 * public barrel or the dynamic-dispatch module.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(HERE, 'fixtures', 'p8b');

const RUN_ID = 'fixture-committed-run-20260918T000000Z-000001';
const SUITE_ID = 'fixture-suite-execution-20260918T000100Z-000001';
const LEGACY_RUN_ID = 'fixture-legacy-run-20260101T000000Z-000001';
const COMMITTED_RUN_FILES = [
  'intended-inventory.json',
  'final-manifest.json',
  'run-record.json',
] as const;

const TEMP_DIRS: string[] = [];

afterEach(() => {
  while (TEMP_DIRS.length > 0) {
    rmSync(TEMP_DIRS.pop() as string, { recursive: true, force: true });
  }
});

interface EvidenceHarness {
  readonly tmp: string;
  readonly evidenceDir: string;
}

function makeHarness(): EvidenceHarness {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'p8b-b2-'));
  TEMP_DIRS.push(tmp);
  const evidenceDir = path.join(tmp, 'evidence');
  mkdirSync(path.join(evidenceDir, 'runs'), { recursive: true });
  mkdirSync(path.join(evidenceDir, 'suites'), { recursive: true });
  return { tmp, evidenceDir };
}

function copyCommittedRun(evidenceDir: string, runId: string = RUN_ID): string {
  const root = path.join(evidenceDir, 'runs', runId);
  mkdirSync(root, { recursive: true });
  for (const name of COMMITTED_RUN_FILES) {
    writeFileSync(
      path.join(root, name),
      readFileSync(path.join(FIXTURE_ROOT, 'committed-run', name)),
    );
  }
  return root;
}

function copyLegacyRun(evidenceDir: string, runId: string = LEGACY_RUN_ID): string {
  const root = path.join(evidenceDir, 'runs', runId);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    path.join(root, 'run-record.json'),
    readFileSync(path.join(FIXTURE_ROOT, 'legacy-run', 'run-record.json')),
  );
  return root;
}

function copySuite(
  evidenceDir: string,
  mutate?: (record: Record<string, unknown>) => void,
  suiteId: string = SUITE_ID,
): { root: string; record: Record<string, unknown> } {
  const root = path.join(evidenceDir, 'suites', suiteId);
  mkdirSync(root, { recursive: true });
  const record = JSON.parse(
    readFileSync(path.join(FIXTURE_ROOT, 'committed-suite', 'suite-record.json'), 'utf8'),
  ) as Record<string, unknown>;
  if (mutate !== undefined) mutate(record);
  writeFileSync(path.join(root, 'suite-record.json'), JSON.stringify(record, null, 2));
  return { root, record };
}

/**
 * A valid suite-v2 explicit no-record refusal child: it declares no child
 * record at all, so it carries the `no-record-refusal` label and null child
 * identities. A Gate-F credited suite must reject it as
 * `VERIFY_SUITE_CHILD_NOT_COMMITTED` without resolving or mutating any root.
 */
function noRecordRefusalChild(order: number, runId: string): Record<string, unknown> {
  const suffix = String(order).padStart(6, '0');
  return {
    order,
    caseId: `no-record-case-${order}`,
    request: `no-record/request/${order}`,
    expectedOutcome: 'PASS',
    runId,
    executionId: `no-record-child-execution-20260918T000100Z-${suffix}`,
    parentSuiteExecutionId: SUITE_ID,
    suiteLineageId: 'fixture-suite-lineage-20260918T000000Z-000001',
    recordPresent: false,
    childRecordLabel: 'no-record-refusal',
    childRecordSchemaVersion: null,
    childProfile: null,
    materializationFingerprint: null,
    planFingerprint: null,
    expectedMet: false,
    behaviorOutcome: null,
    finalOutcome: 'HARNESS_BLOCKED',
    cleanupComplete: true,
    startedAt: '2026-09-18T00:00:00.000Z',
    endedAt: '2026-09-18T00:00:30.000Z',
    durationMs: 30000,
    runRecordRole: 'run-record',
  };
}

function writeJson(target: string, value: unknown): void {
  writeFileSync(target, JSON.stringify(value, null, 2));
}

function commandOptions(
  harness: EvidenceHarness,
  overrides: Partial<EvidenceVerifyCommandOptions> = {},
): EvidenceVerifyCommandOptions {
  return {
    evidenceBaseDir: harness.evidenceDir,
    fs: createNodeEvidenceVerifyFsAdapter(),
    currentTree: () => ({ currentTreeCheck: 'PASS' }),
    forbiddenRoots: [],
    ...overrides,
  };
}

function verify(
  harness: EvidenceHarness,
  runId: string,
  overrides: Partial<EvidenceVerifyCommandOptions> = {},
): ReturnType<typeof runEvidenceVerifyCommand> {
  return runEvidenceVerifyCommand(['--run', runId], commandOptions(harness, overrides));
}

function detailsOf(result: ReturnType<typeof runEvidenceVerifyCommand>): EvidenceVerifyDetails {
  const details = result.details;
  if (details === null) throw new Error('expected a verifier details object');
  expect(validateEvidenceVerifyDetails(details)).toEqual([]);
  return details;
}

function mutateRunFile(
  harness: EvidenceHarness,
  name: string,
  mutate: (record: Record<string, unknown>) => void,
): void {
  const target = path.join(harness.evidenceDir, 'runs', RUN_ID, name);
  const record = JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>;
  mutate(record);
  writeJson(target, record);
}

describe('[P8-B/B2] evidence verify CLI — closed envelope and mapping', () => {
  it('emits exactly one deterministic PASS envelope with closed details', () => {
    const harness = makeHarness();
    copyCommittedRun(harness.evidenceDir);

    const result = verify(harness, RUN_ID);
    expect(result.command).toBe('evidence');
    expect(result.subcommand).toBe('verify');
    expect(result.schemaVersion).toBe(2);
    expect(result.status).toBe('PASS');
    expect(result.exitCode).toBe(0);
    expect(result.outcome).toBeNull();
    expect(result.launchAttempted).toBe(false);
    expect(result.diagnostics).toEqual([]);
    expect(result.detail).toBe(EVIDENCE_VERIFY_DETAILS.pass);

    const details = detailsOf(result);
    expect(details.schemaVersion).toBe(EVIDENCE_VERIFY_SCHEMA_VERSION);
    expect(details.reportLabel).toBe(EVIDENCE_VERIFY_REPORT_LABEL);
    expect(details.scope).toBe('run');
    expect(details.rootKind).toBe('run');
    expect(details.rootRelativePath).toBe(`evidence/runs/${RUN_ID}`);
    expect(details.transaction.state).toBe('committed');
    expect(details.transaction.creditEligible).toBe(true);
    expect(details.suite).toBeNull();

    const first = JSON.stringify(verify(harness, RUN_ID), null, 2);
    const second = JSON.stringify(verify(harness, RUN_ID), null, 2);
    expect(second).toBe(first);
    expect(JSON.parse(first)).toBeTruthy();
  });

  it('maps a missing artifact to HARNESS_BLOCKED with a stable primary code', () => {
    const harness = makeHarness();
    const root = copyCommittedRun(harness.evidenceDir);
    rmSync(path.join(root, 'run-record.json'));

    const result = verify(harness, RUN_ID);
    expect(result.status).toBe('HARNESS_BLOCKED');
    expect(result.exitCode).toBe(2);
    expect(result.outcome).toBeNull();
    expect(result.detail).toBe(EVIDENCE_VERIFY_DETAILS.blocked);
    const details = detailsOf(result);
    expect(details.transaction.state).toBe('committed');
    expect(details.transaction.creditEligible).toBe(false);
    expect(details.transaction.failureCode).toBe('VERIFY_ARTIFACT_MISSING');
    expect(details.artifacts.missingIds).toEqual(['artifact:run-record']);
  });

  it('maps an external read failure to ENVIRONMENT_FAILURE', () => {
    const harness = makeHarness();
    copyCommittedRun(harness.evidenceDir);
    const real = createNodeEvidenceVerifyFsAdapter();
    const fs: EvidenceVerifyEnvironment['fs'] = {
      ...real,
      readFile: (absolutePath: string): Uint8Array => {
        if (absolutePath.endsWith('run-record.json')) {
          throw new EvidenceVerifyExternalFsError('EIO', 'injected external read failure');
        }
        return real.readFile(absolutePath);
      },
    };

    const result = verify(harness, RUN_ID, { fs });
    expect(result.status).toBe('ENVIRONMENT_FAILURE');
    expect(result.exitCode).toBe(2);
    expect(result.detail).toBe(EVIDENCE_VERIFY_DETAILS.environment);
    const details = detailsOf(result);
    expect(details.transaction.failureCode).toBe('VERIFY_EXTERNAL_READ_FAILURE');
    expect(details.transaction.failureClass).toBe('ENVIRONMENT_FAILURE');
  });

  it('classifies a labelled historical run as legacy-unverifiable', () => {
    const harness = makeHarness();
    copyLegacyRun(harness.evidenceDir);

    const result = verify(harness, LEGACY_RUN_ID);
    expect(result.status).toBe('HARNESS_BLOCKED');
    const details = detailsOf(result);
    expect(details.transaction.state).toBe('legacy-unverifiable');
    expect(details.transaction.creditEligible).toBe(false);
    expect(details.transaction.failureCode).toBe('VERIFY_LEGACY_UNVERIFIABLE');
  });

  it('never emits BUG for a verifier finding and retains a historical BUG outcome', () => {
    const harness = makeHarness();
    copyCommittedRun(harness.evidenceDir);
    const bugged = verify(harness, RUN_ID, {
      currentTree: () => ({ currentTreeCheck: 'PASS' }),
    });
    expect(bugged.status).not.toBe('BUG');

    // A committed manifest that retained behaviorOutcome BUG is data, not a
    // verifier failure: the command still PASSes and never reclassifies it.
    mutateRunFile(harness, 'final-manifest.json', (manifest) => {
      manifest.behaviorOutcome = 'BUG';
    });
    const result = verify(harness, RUN_ID);
    expect(result.status).toBe('PASS');
    expect(result.outcome).toBeNull();
    const details = detailsOf(result);
    expect(details.transaction.behaviorOutcome).toBe('BUG');
    expect(details.transaction.creditEligible).toBe(true);
  });
});

describe('[P8-B/B2] evidence verify CLI — advisory current-tree results', () => {
  it('keeps persisted PASS while reporting advisory DRIFT', () => {
    const harness = makeHarness();
    copyCommittedRun(harness.evidenceDir);
    const result = verify(harness, RUN_ID, { currentTree: () => ({ currentTreeCheck: 'DRIFT' }) });
    expect(result.status).toBe('PASS');
    expect(result.exitCode).toBe(0);
    const details = detailsOf(result);
    expect(details.transaction.failureCode).toBeNull();
    expect(details.provenance.currentTreeCheck).toBe('DRIFT');
    expect(details.provenance.currentTreeCreditEligible).toBe(false);
    expect(details.provenance.persistedIdentityValid).toBe(true);
    expect(details.diagnostics.map((entry) => entry.code)).toEqual([
      'VERIFY_PROVENANCE_CURRENT_DRIFT',
    ]);
  });

  it('keeps persisted PASS while reporting advisory UNAVAILABLE', () => {
    const harness = makeHarness();
    copyCommittedRun(harness.evidenceDir);
    const result = verify(harness, RUN_ID, {
      currentTree: () => {
        throw new EvidenceVerifyExternalFsError('EIO', 'optional collector unavailable');
      },
    });
    expect(result.status).toBe('PASS');
    const details = detailsOf(result);
    expect(details.transaction.failureClass).toBeNull();
    expect(details.provenance.currentTreeCheck).toBe('UNAVAILABLE');
    expect(details.provenance.currentTreeCreditEligible).toBe(false);
    expect(details.diagnostics.map((entry) => entry.code)).toEqual([
      'VERIFY_PROVENANCE_CURRENT_UNAVAILABLE',
    ]);
  });
});

describe('[P8-B/B2] evidence verify CLI — no prohibited-value leakage', () => {
  it('never echoes an injected secret or absolute path', () => {
    const harness = makeHarness();
    copyCommittedRun(harness.evidenceDir);
    mutateRunFile(harness, 'final-manifest.json', (manifest) => {
      manifest.note = '/private/var/folders/p8b-b2-secret';
      manifest.apiKey = 'sk-ABCDEFGHIJKLMNOPQRSTUVWX';
    });

    const result = verify(harness, RUN_ID);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('/private/var');
    expect(serialized).not.toContain('sk-ABCDEFGHIJKLMNOPQRSTUVWX');
    expect(serialized).not.toContain(harness.tmp);
    expect(result.status).toBe('HARNESS_BLOCKED');
    detailsOf(result);
  });
});

describe('[P8-B/B2] evidence verify CLI — narrow suite verification', () => {
  it('passes a valid suite-v2 whose record-bearing child is committed', () => {
    const harness = makeHarness();
    copyCommittedRun(harness.evidenceDir);
    copySuite(harness.evidenceDir);

    const result = verify(harness, SUITE_ID);
    expect(result.status).toBe('PASS');
    expect(result.exitCode).toBe(0);
    const details = detailsOf(result);
    expect(details.scope).toBe('suite');
    expect(details.rootKind).toBe('suite');
    expect(details.rootRelativePath).toBe(`evidence/suites/${SUITE_ID}`);
    expect(details.transaction.state).toBe('committed');
    expect(details.transaction.creditEligible).toBe(true);
    expect(details.transaction.commitPoint).toBe('not-applicable');
    expect(details.suite).toEqual({
      recordLabel: 'suite-v2',
      recordSchemaVersion: 2,
      childCount: 1,
      committedChildCount: 1,
      uncommittedChildIds: [],
      suiteTransactionActivation: 'deferred-not-activated',
    });
    expect(details.diagnostics).toEqual([]);
  });

  it('rejects a suite-level transaction document as activation', () => {
    const harness = makeHarness();
    copyCommittedRun(harness.evidenceDir);
    const suite = copySuite(harness.evidenceDir);
    writeFileSync(
      path.join(suite.root, 'intended-inventory.json'),
      readFileSync(path.join(FIXTURE_ROOT, 'committed-run', 'intended-inventory.json')),
    );

    const result = verify(harness, SUITE_ID);
    expect(result.status).toBe('HARNESS_BLOCKED');
    const details = detailsOf(result);
    expect(details.transaction.failureCode).toBe('VERIFY_SUITE_TRANSACTION_ACTIVATED');
    expect(details.suite?.suiteTransactionActivation).toBe('forbidden-activated');
    expect(details.transaction.creditEligible).toBe(false);
  });

  it('rejects a record-bearing child with no committed run root', () => {
    const harness = makeHarness();
    copySuite(harness.evidenceDir);

    const result = verify(harness, SUITE_ID);
    expect(result.status).toBe('HARNESS_BLOCKED');
    const details = detailsOf(result);
    expect(details.transaction.failureCode).toBe('VERIFY_SUITE_CHILD_NOT_COMMITTED');
    expect(details.suite?.committedChildCount).toBe(0);
    expect(details.suite?.uncommittedChildIds).toEqual([RUN_ID]);
  });

  it('rejects an explicit no-record-refusal child and leaves suite/child roots immutable', () => {
    const harness = makeHarness();
    const childRoot = copyCommittedRun(harness.evidenceDir);
    const suiteRecordPath = path.join(harness.evidenceDir, 'suites', SUITE_ID, 'suite-record.json');
    // One committed record-bearing child plus two explicit no-record refusals
    // whose child order and run-id order disagree, so a sorted uncommitted list
    // proves canonical ordering rather than insertion order.
    copySuite(harness.evidenceDir, (record) => {
      const committed = (record.children as Record<string, unknown>[])[0] as Record<
        string,
        unknown
      >;
      record.children = [
        { ...committed, order: 1 },
        noRecordRefusalChild(2, 'no-record-run-zeta-20260918T000000Z-000002'),
        noRecordRefusalChild(3, 'no-record-run-alpha-20260918T000000Z-000003'),
      ];
      record.declaredCaseCount = 3;
      record.executedCount = 3;
      record.canonicalOrder = [1, 2, 3];
      record.aggregateStatus = 'HARNESS_BLOCKED';
    });

    const suiteRecordBefore = readFileSync(suiteRecordPath);
    const childRootEntriesBefore = readdirSync(childRoot).sort();
    const childBytesBefore = COMMITTED_RUN_FILES.map((name) =>
      readFileSync(path.join(childRoot, name)),
    );

    let suiteCalls = 0;
    const result = verify(harness, SUITE_ID, {
      currentTree: () => {
        suiteCalls += 1;
        return { currentTreeCheck: 'PASS' };
      },
    });

    expect(result.status).toBe('HARNESS_BLOCKED');
    expect(result.exitCode).toBe(2);
    const details = detailsOf(result);
    expect(details.scope).toBe('suite');
    expect(details.transaction.state).toBe('committed');
    expect(details.transaction.creditEligible).toBe(false);
    expect(details.transaction.failureCode).toBe('VERIFY_SUITE_CHILD_NOT_COMMITTED');
    expect(details.suite).toEqual({
      recordLabel: 'suite-v2',
      recordSchemaVersion: 2,
      childCount: 3,
      committedChildCount: 1,
      uncommittedChildIds: [
        'no-record-run-alpha-20260918T000000Z-000003',
        'no-record-run-zeta-20260918T000000Z-000002',
      ],
      suiteTransactionActivation: 'deferred-not-activated',
    });

    // A suite child never recursively runs the current-tree provider.
    expect(suiteCalls).toBe(0);

    // No suite transaction is activated and neither the suite nor the committed
    // child root moves a single byte.
    expect(readFileSync(suiteRecordPath).equals(suiteRecordBefore)).toBe(true);
    expect(readdirSync(childRoot).sort()).toEqual(childRootEntriesBefore);
    COMMITTED_RUN_FILES.forEach((name, index) => {
      expect(
        readFileSync(path.join(childRoot, name)).equals(childBytesBefore[index] as Buffer),
      ).toBe(true);
    });
  });

  it('rejects a child run root without a final manifest', () => {
    const harness = makeHarness();
    const root = copyCommittedRun(harness.evidenceDir);
    copySuite(harness.evidenceDir);
    rmSync(path.join(root, 'final-manifest.json'));

    const result = verify(harness, SUITE_ID);
    expect(result.status).toBe('HARNESS_BLOCKED');
    const details = detailsOf(result);
    expect(details.transaction.failureCode).toBe('VERIFY_SUITE_CHILD_NOT_COMMITTED');
  });

  it('detects a child identity mismatch for a field present in the run record', () => {
    const harness = makeHarness();
    copyCommittedRun(harness.evidenceDir);
    copySuite(harness.evidenceDir, (record) => {
      const children = record.children as Record<string, unknown>[];
      (children[0] as Record<string, unknown>).behaviorOutcome = 'BUG';
    });

    const result = verify(harness, SUITE_ID);
    expect(result.status).toBe('HARNESS_BLOCKED');
    const details = detailsOf(result);
    expect(details.transaction.failureCode).toBe('VERIFY_SUITE_CHILD_IDENTITY_MISMATCH');
    expect(details.suite?.committedChildCount).toBe(1);
  });

  it('never recursively runs the current-tree provider for suite children', () => {
    const harness = makeHarness();
    copyCommittedRun(harness.evidenceDir);
    copySuite(harness.evidenceDir);

    let suiteCalls = 0;
    const suiteResult = verify(harness, SUITE_ID, {
      currentTree: () => {
        suiteCalls += 1;
        return { currentTreeCheck: 'PASS' };
      },
    });
    expect(suiteResult.status).toBe('PASS');
    expect(suiteCalls).toBe(0);

    let runCalls = 0;
    const runResult = verify(harness, RUN_ID, {
      currentTree: () => {
        runCalls += 1;
        return { currentTreeCheck: 'PASS' };
      },
    });
    expect(runResult.status).toBe('PASS');
    expect(runCalls).toBe(1);
  });
});

describe('[P8-B/B2] evidence verify CLI — parser rejection before filesystem access', () => {
  it('rejects duplicate, unknown, positional, missing-value, and unsafe arguments as USAGE', () => {
    const rejections: readonly { argv: string[]; failure: string }[] = [
      { argv: ['--run', 'one', '--run', 'two'], failure: 'EVIDENCE_VERIFY_ARGUMENT_DUPLICATE' },
      { argv: ['--run=one', '--run', 'two'], failure: 'EVIDENCE_VERIFY_ARGUMENT_DUPLICATE' },
      { argv: ['--bogus', 'value'], failure: 'EVIDENCE_VERIFY_ARGUMENT_UNKNOWN' },
      { argv: ['stray'], failure: 'EVIDENCE_VERIFY_ARGUMENT_POSITIONAL' },
      { argv: ['--run'], failure: 'EVIDENCE_VERIFY_ARGUMENT_MISSING_VALUE' },
      { argv: ['--run='], failure: 'EVIDENCE_VERIFY_ARGUMENT_MISSING_VALUE' },
      { argv: [], failure: 'EVIDENCE_VERIFY_ARGUMENT_MISSING' },
      { argv: ['--run', '../escape'], failure: 'EVIDENCE_VERIFY_ARGUMENT_UNSAFE_ID' },
    ];
    for (const entry of rejections) {
      const parsed = parseEvidenceVerifyArguments(entry.argv);
      expect(parsed.ok, entry.argv.join(' ')).toBe(false);
      if (!parsed.ok) expect(parsed.failure, entry.argv.join(' ')).toBe(entry.failure);

      // The command rejects locally: a probe adapter that would throw on any
      // access proves no filesystem call happens for a usage rejection.
      const result = runEvidenceVerifyCommand(entry.argv, {
        evidenceBaseDir: '/nonexistent/' + entry.failure,
        fs: {
          lstat: () => {
            throw new Error('filesystem access attempted for a usage rejection');
          },
          readdir: () => {
            throw new Error('filesystem access attempted for a usage rejection');
          },
          readFile: () => {
            throw new Error('filesystem access attempted for a usage rejection');
          },
        },
        currentTree: () => ({ currentTreeCheck: 'PASS' }),
        forbiddenRoots: [],
      });
      expect(result.status, entry.argv.join(' ')).toBe('USAGE');
      expect(result.exitCode, entry.argv.join(' ')).toBe(64);
      expect(result.details, entry.argv.join(' ')).toBeNull();
      expect(result.outcome, entry.argv.join(' ')).toBeNull();
      expect(result.diagnostics.map((entry) => entry.code)).toContain('CLI_USAGE_INVALID');
    }
  });

  it('rejects prohibited file:/blob: scheme ids as USAGE before any filesystem access', () => {
    for (const id of ['file:foo', 'FILE:foo', 'blob:foo', 'BLOB:foo']) {
      const parsed = parseEvidenceVerifyArguments(['--run', id]);
      expect(parsed.ok, id).toBe(false);
      if (!parsed.ok) expect(parsed.failure, id).toBe('EVIDENCE_VERIFY_ARGUMENT_UNSAFE_ID');

      // A probe adapter that throws on any access, and a current-tree provider
      // that throws too, prove the scheme rejection precedes environment
      // construction and any root resolution.
      const result = runEvidenceVerifyCommand(['--run', id], {
        evidenceBaseDir: '/nonexistent/prohibited-scheme',
        fs: {
          lstat: () => {
            throw new Error('filesystem access attempted for a usage rejection');
          },
          readdir: () => {
            throw new Error('filesystem access attempted for a usage rejection');
          },
          readFile: () => {
            throw new Error('filesystem access attempted for a usage rejection');
          },
        },
        currentTree: () => {
          throw new Error('current-tree access attempted for a usage rejection');
        },
        forbiddenRoots: [],
      });
      expect(result.status, id).toBe('USAGE');
      expect(result.exitCode, id).toBe(64);
      expect(result.details, id).toBeNull();
      expect(result.outcome, id).toBeNull();
      expect(result.launchAttempted, id).toBe(false);
      expect(
        result.diagnostics.map((entry) => entry.code),
        id,
      ).toContain('CLI_USAGE_INVALID');

      // The prohibited raw id is never echoed into the envelope.
      const serialized = JSON.stringify(result);
      const lowered = serialized.toLowerCase();
      expect(lowered, id).not.toContain('file:');
      expect(lowered, id).not.toContain('blob:');
      expect(serialized, id).not.toContain('foo');
    }
  });

  it('accepts colon-containing logical ids that are not prohibited schemes', () => {
    for (const id of ['profile:diagnostic', 'artifact:run-record']) {
      expect(parseEvidenceVerifyArguments(['--run', id])).toEqual({ ok: true, runId: id });
    }

    // A legitimate colon id still resolves as an ordinary (missing) root rather
    // than a usage rejection, so the scheme guard is not a blanket colon ban.
    const harness = makeHarness();
    const result = verify(harness, 'profile:diagnostic');
    expect(result.status).toBe('HARNESS_BLOCKED');
    expect(result.details).not.toBeNull();
    const details = detailsOf(result);
    expect(details.requestedId).toBe('profile:diagnostic');
    expect(details.transaction.failureCode).toBe('VERIFY_ROOT_NOT_FOUND');
  });

  it('keeps the bare deferred evidence command unchanged', async () => {
    const { code, result } = await captureCliResult<{
      status: string;
      exitCode: number;
      detail: string;
      diagnostics: { code: string }[];
    }>(['evidence']);
    expect(code).toBe(3);
    expect(result.status).toBe('NOT_IMPLEMENTED');
    expect(result.exitCode).toBe(3);
    expect(result.diagnostics.map((entry) => entry.code)).toContain('CLI_NOT_IMPLEMENTED');
  });

  it('dispatches a valid evidence verify invocation through the CLI envelope', async () => {
    const { code, stdout, result } = await captureCliResult<{
      status: string;
      exitCode: number;
      command: string;
      subcommand: string;
      outcome: string | null;
      launchAttempted: boolean;
    }>(['evidence', 'verify', '--run', 'nonexistent-id']);
    expect(code).toBe(2);
    expect(result.command).toBe('evidence');
    expect(result.subcommand).toBe('verify');
    expect(result.status).toBe('HARNESS_BLOCKED');
    expect(result.exitCode).toBe(2);
    expect(result.outcome).toBeNull();
    expect(result.launchAttempted).toBe(false);
    // Exactly one JSON document on stdout.
    expect(stdout.trimEnd().split('\n}\n{').length).toBe(1);
    expect(() => JSON.parse(stdout)).not.toThrow();
  });
});

describe('[P8-B/B2] evidence verifier public exports', () => {
  it('exposes the tested CLI and core surface', () => {
    expect(typeof runEvidenceVerifyCommand).toBe('function');
    expect(typeof verifyEvidenceRoot).toBe('function');
    expect(EVIDENCE_VERIFY_DETAILS.pass).toBe('evidence root passed integrity verification');
    expect(typeof parseEvidenceVerifyArguments).toBe('function');
    expect(EVIDENCE_VERIFY_CHECK_IDS).toContain('SUITE_CHILD_MANIFESTS');

    const harness = makeHarness();
    copyCommittedRun(harness.evidenceDir);
    const direct = verifyEvidenceRoot(
      { requestedId: RUN_ID },
      {
        evidenceBaseDir: harness.evidenceDir,
        fs: createNodeEvidenceVerifyFsAdapter(),
        forbiddenRoots: [],
      },
    );
    expect(validateEvidenceVerifyDetails(direct)).toEqual([]);
    expect(direct.provenance.currentTreeCheck).toBe('not-run');
    expect(direct.transaction.state).toBe('committed');
  });
});

// ── ADR 0051C — PNG IDAT privacy-scan alignment at the CLI boundary ─────────

/**
 * ADR 0051C CLI proof: a structurally valid PNG whose prohibited-looking
 * sequences occur only in compressed `IDAT` payload bytes produces the normal
 * closed `PASS` envelope, while equivalent content in a non-`IDAT` metadata
 * chunk stays `HARNESS_BLOCKED` at exit 2 without leaking any offending value.
 * Every case runs against an isolated OS-temporary copy and proves the tested
 * root stays byte-for-byte unchanged.
 */
// Escape-invariant composition of the demonstrated UNC-backslash form (two
// consecutive backslashes), immune to tooling-level backslash halving.
const CLI_BACKSLASH = String.fromCharCode(92);
const CLI_UNC_VALUE = `img ${CLI_BACKSLASH}${CLI_BACKSLASH}secret-host${CLI_BACKSLASH}private-share tail`;

const CLI_PNG_SAMPLES: readonly string[] = [
  CLI_UNC_VALUE,
  'img Bearer sk-ABCDEFGHIJKLMNOPQRSTUVWX tail',
  'img customer@example.com tail',
  'img /private/var/folders/p8b-secret-root tail',
  'img file:private-thing tail',
  'img blob:opaque-handle-123 tail',
];

const CLI_PROBE_VALUES: readonly string[] = [
  'secret-host',
  'private-share',
  'sk-ABCDEFGHIJKLMNOPQRSTUVWX',
  'customer@example.com',
  'p8b-secret-root',
  'private-thing',
  'opaque-handle-123',
];

const CLI_PNG_ROOTS: readonly string[] = [
  '/private/var/folders/p8b-secret-root',
  'registered-private-root',
];

function cliChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.byteLength);
  new DataView(chunk.buffer).setUint32(0, data.byteLength);
  chunk.set(new TextEncoder().encode(type), 4);
  chunk.set(data, 8);
  return chunk;
}

function cliPng(chunks: readonly Uint8Array[]): Uint8Array {
  const body = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(8 + body + 12);
  out.set([137, 80, 78, 71, 13, 10, 26, 10]);
  let offset = 8;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  out.set([0, 0, 0, 0, 73, 69, 78, 68, 0, 0, 0, 0], offset);
  return out;
}

function sha256Exact(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function rootDigests(root: string): Record<string, string> {
  const digests: Record<string, string> = {};
  for (const name of readdirSync(root).sort()) {
    digests[name] = sha256Exact(readFileSync(path.join(root, name)));
  }
  return digests;
}

/** Declare one extra diagnostic artifact; both documents stay artifactId-sorted. */
function declareExtraArtifact(
  root: string,
  relativePath: string,
  mediaType: string,
  schema: string,
  bytes: Uint8Array,
): void {
  writeFileSync(path.join(root, relativePath), bytes);
  const read = (name: string): Record<string, unknown> =>
    JSON.parse(readFileSync(path.join(root, name), 'utf8')) as Record<string, unknown>;
  const byId = (a: Record<string, unknown>, b: Record<string, unknown>): number =>
    String(a.artifactId) < String(b.artifactId) ? -1 : 1;
  const inventory = read('intended-inventory.json');
  const manifest = read('final-manifest.json');
  const entry: Record<string, unknown> = {
    artifactId: 'artifact:diagram',
    role: 'diagnostic-only',
    mediaType,
    schema,
    relativePath,
    byteLength: bytes.byteLength,
    sha256: sha256Exact(bytes),
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
    sha256: sha256Exact(bytes),
    semanticDigest: null,
  };
  inventory.artifacts = [...(inventory.artifacts as Record<string, unknown>[]), entry].sort(byId);
  manifest.committedArtifacts = [
    ...(manifest.committedArtifacts as Record<string, unknown>[]),
    committed,
  ].sort(byId);
  manifest.inventoryIdentity = deriveIntendedInventoryIdentity(
    inventory as unknown as Parameters<typeof deriveIntendedInventoryIdentity>[0],
  );
  writeJson(path.join(root, 'intended-inventory.json'), inventory);
  writeJson(path.join(root, 'final-manifest.json'), manifest);
}

describe('[P8-B/B2] evidence verify CLI — PNG IDAT privacy-scan alignment (ADR 0051C)', () => {
  it('emits the closed PASS envelope for a PNG whose prohibited-looking sequences occur only in IDAT', () => {
    const harness = makeHarness();
    const root = copyCommittedRun(harness.evidenceDir);
    const bytes = cliPng([
      cliChunk('tEXt', new TextEncoder().encode('ordinary public metadata')),
      cliChunk('IDAT', new TextEncoder().encode(CLI_PNG_SAMPLES.join(' '))),
    ]);
    declareExtraArtifact(root, 'diagram.png', 'image/png', 'png', bytes);
    const before = rootDigests(root);
    const result = verify(harness, RUN_ID, { forbiddenRoots: CLI_PNG_ROOTS });
    expect(rootDigests(root)).toEqual(before);
    expect(result.command).toBe('evidence');
    expect(result.subcommand).toBe('verify');
    expect(result.schemaVersion).toBe(2);
    expect(result.status).toBe('PASS');
    expect(result.exitCode).toBe(0);
    expect(result.outcome).toBeNull();
    expect(result.launchAttempted).toBe(false);
    expect(result.diagnostics).toEqual([]);
    expect(result.detail).toBe(EVIDENCE_VERIFY_DETAILS.pass);
    const details = detailsOf(result);
    expect(details.transaction.state).toBe('committed');
    expect(details.transaction.creditEligible).toBe(true);
    expect(details.transaction.failureCode).toBeNull();
    expect(details.sanitization).toEqual({
      requiredApproved: true,
      diagnosticApproved: true,
      requiredAuthorityPreserved: true,
      prohibitedValuesFound: false,
    });
  });

  it('maps prohibited PNG metadata to HARNESS_BLOCKED exit 2 without leaking offending values', () => {
    const harness = makeHarness();
    const root = copyCommittedRun(harness.evidenceDir);
    const bytes = cliPng([
      cliChunk('tEXt', new TextEncoder().encode(CLI_PNG_SAMPLES.join(' '))),
      cliChunk('IDAT', new TextEncoder().encode('img bytes')),
    ]);
    declareExtraArtifact(root, 'diagram.png', 'image/png', 'png', bytes);
    const before = rootDigests(root);
    const result = verify(harness, RUN_ID, { forbiddenRoots: CLI_PNG_ROOTS });
    expect(rootDigests(root)).toEqual(before);
    expect(result.status).toBe('HARNESS_BLOCKED');
    expect(result.exitCode).toBe(2);
    expect(result.detail).toBe(EVIDENCE_VERIFY_DETAILS.blocked);
    const details = detailsOf(result);
    expect(details.transaction.state).toBe('committed');
    expect(details.transaction.failureClass).toBe('HARNESS_BLOCKED');
    expect(details.transaction.creditEligible).toBe(false);
    expect(details.sanitization.prohibitedValuesFound).toBe(true);
    const serialized = JSON.stringify(result);
    for (const value of CLI_PROBE_VALUES) {
      expect(serialized, value).not.toContain(value);
    }
    expect(serialized).not.toContain(harness.tmp);
  });
});

// ── ADR 0051C v2 — malformed PNG single-authority governance at the CLI ─────

/**
 * ADR 0051C amendment v2 CLI proof: every malformed PNG family (truncated
 * framing/data/CRC, missing `IEND`, nonzero `IEND` carrying a hostile payload,
 * trailing bytes carrying a hostile payload) is governed solely by the
 * authoritative malformed-PNG structural result. The non-IDAT payload
 * extractor never runs on such input, so the closed `HARNESS_BLOCKED` exit-2
 * envelope carries exactly the sanitization finding, emits no secondary
 * PATH/SECRET/CUSTOMER privacy finding, leaks no offending value, and leaves
 * the tested root byte-for-byte unchanged.
 */
function cliConcat(head: Uint8Array, tail: Uint8Array): Uint8Array {
  const out = new Uint8Array(head.byteLength + tail.byteLength);
  out.set(head, 0);
  out.set(tail, head.byteLength);
  return out;
}

describe('[P8-B/B2] evidence verify CLI — malformed PNG single-authority governance (ADR 0051C v2)', () => {
  it('blocks every malformed PNG family by the authoritative result with no secondary privacy findings or leaks', () => {
    const text = (value: string): Uint8Array => new TextEncoder().encode(value);
    const safeHostile =
      'img Bearer sk-ABCDEFGHIJKLMNOPQRSTUVWX tail; img customer@example.com tail';
    const defectHostile = CLI_PNG_SAMPLES.join(' ');
    const hostileTextChunk = cliChunk('tEXt', text(safeHostile));
    const idatChunk = cliChunk('IDAT', text('img bytes'));
    const complete = cliPng([hostileTextChunk, idatChunk]);
    const families: readonly (readonly [string, Uint8Array])[] = [
      // End of stream inside a chunk header (six of twelve IEND bytes present).
      ['truncated-framing', complete.subarray(0, complete.byteLength - 6)],
      // End of stream inside chunk data (six of eight IDAT data bytes present).
      ['truncated-data', complete.subarray(0, complete.byteLength - 18)],
      // End of stream inside chunk CRC (two of four IDAT CRC bytes present).
      ['truncated-CRC', complete.subarray(0, complete.byteLength - 14)],
      // Complete chunks with no terminal IEND at all.
      ['missing-IEND', complete.subarray(0, complete.byteLength - 12)],
      // Hostile payload carried by a nonzero-length terminal IEND's data bytes.
      ['nonzero-IEND-hostile-payload', cliPng([cliChunk('IEND', text(defectHostile))])],
      // Hostile payload carried by trailing bytes after a zero-length IEND.
      [
        'trailing-bytes-hostile-payload',
        cliConcat(cliPng([hostileTextChunk, idatChunk]), text(`tail ${defectHostile}`)),
      ],
    ];
    for (const [label, bytes] of families) {
      const harness = makeHarness();
      const root = copyCommittedRun(harness.evidenceDir);
      declareExtraArtifact(root, 'diagram.png', 'image/png', 'png', bytes);
      const before = rootDigests(root);
      const result = verify(harness, RUN_ID, { forbiddenRoots: CLI_PNG_ROOTS });
      expect(rootDigests(root), label).toEqual(before);
      expect(result.status, label).toBe('HARNESS_BLOCKED');
      expect(result.exitCode, label).toBe(2);
      expect(result.detail, label).toBe(EVIDENCE_VERIFY_DETAILS.blocked);
      const details = detailsOf(result);
      expect(details.transaction.state, label).toBe('committed');
      expect(details.transaction.failureClass, label).toBe('HARNESS_BLOCKED');
      expect(details.transaction.failureCode, label).toBe('VERIFY_SANITIZATION_PROHIBITED_VALUE');
      expect(details.transaction.creditEligible, label).toBe(false);
      expect(
        details.diagnostics.map((entry) => [entry.code, entry.detailCode]),
        label,
      ).toEqual([['VERIFY_SANITIZATION_PROHIBITED_VALUE', 'PROHIBITED_BYTES_MALFORMED_PNG']]);
      // No secondary PATH/SECRET/CUSTOMER privacy finding at the CLI boundary.
      for (const id of ['PATH_SCAN', 'SECRET_SCAN', 'CUSTOMER_MARKER_SCAN']) {
        const check = details.checks.find((entry) => entry.id === id);
        expect(check?.result, `${label}/${id}`).toBe('PASS');
      }
      const serialized = JSON.stringify(result);
      for (const value of CLI_PROBE_VALUES) {
        expect(serialized, `${label}/${value}`).not.toContain(value);
      }
      expect(serialized, label).not.toContain(harness.tmp);
    }
  });
});

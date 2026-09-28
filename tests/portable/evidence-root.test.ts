import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { allocateRun } from '../../src/allocation/allocate';
import { ownershipRecordPathFor, scratchRootFor } from '../../src/allocation/lease';
import { releaseAllRunPortReservations } from '../../src/allocation/port-reservation';
import { cleanupRun } from '../../src/cleanup/cleanup';
import { runDiagnosticCommand } from '../../src/cli/diagnostic';
import { runEvidenceVerifyCommand } from '../../src/cli/evidence';
import { runDiagnosticSuiteCommand } from '../../src/cli/suite';
import type { CliResult } from '../../src/contracts/runtime';
import type { EvidenceVerifyFsAdapter } from '../../src/evidence/integrity';
import {
  EVIDENCE_ROOT_ENV,
  defaultEvidenceBaseDir,
  evidenceRunRoot,
  evidenceRunRootRelativePath,
  evidenceSuiteRoot,
  evidenceSuiteRootRelativePath,
  explicitEvidenceRootProblem,
  resolveEvidenceRoot,
} from '../../src/runtime/evidence-root';
import { generateRunId } from '../../src/runtime/run-id';
import { resolveToolkitRoot } from '../../src/runtime/paths';

/**
 * Adapter-selectable evidence root (ADR 0119; private extraction plan WP3).
 *
 * The toolkit writes durable evidence under its own bundled skill directory by
 * default. A thin FE adapter may set exactly one optional, adapter-owned
 * environment variable to an existing application-owned directory so that
 * evidence survives package regeneration. These tests pin the closed contract
 * without any FE checkout or browser:
 *
 *  - unset ⇒ the toolkit default is untouched;
 *  - a set canonical absolute directory is used verbatim by run, suite, and
 *    `evidence verify`;
 *  - blank / relative / root / unnormalized / missing / file / symlink values
 *    are refused before any allocation, launch, read, or write;
 *  - a run allocated under one evidence base refuses non-destructively when the
 *    same base is not present at cleanup;
 *  - no absolute evidence path ever enters the public JSON envelope.
 */

const PORTABLE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = path.join(PORTABLE_ROOT, 'fixtures');
const APP_ROOT_COMPATIBLE = path.join(FIXTURES_ROOT, 'app-root-compatible');

const tmpBases: string[] = [];
const trackedRunIds: string[] = [];

/** A canonical (symlink-free) scratch directory, as required by the contract. */
function makeCanonicalBase(prefix = 'vt-evidence-root-'): string {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpBases.push(base);
  return base;
}

function trackRun(runId: string): string {
  trackedRunIds.push(runId);
  return runId;
}

async function withEvidenceRoot<T>(
  value: string | undefined,
  run: () => Promise<T> | T,
): Promise<T> {
  const previous = process.env[EVIDENCE_ROOT_ENV];
  if (value === undefined) delete process.env[EVIDENCE_ROOT_ENV];
  else process.env[EVIDENCE_ROOT_ENV] = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env[EVIDENCE_ROOT_ENV];
    else process.env[EVIDENCE_ROOT_ENV] = previous;
  }
}

function codes(result: Pick<CliResult<unknown>, 'diagnostics'>): string[] {
  return result.diagnostics.map((entry) => entry.code);
}

afterEach(async () => {
  await releaseAllRunPortReservations();
  for (const runId of trackedRunIds.splice(0)) {
    rmSync(scratchRootFor(runId), { recursive: true, force: true });
  }
  for (const base of tmpBases.splice(0)) {
    rmSync(base, { recursive: true, force: true });
  }
  delete process.env[EVIDENCE_ROOT_ENV];
});

describe('[ADR 0119] evidence root resolution defaults and canonical explicit roots', () => {
  it('keeps the toolkit-owned default when the adapter variable is unset', () => {
    const resolution = resolveEvidenceRoot({});
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.origin).toBe('default');
      expect(resolution.baseDir).toBe(defaultEvidenceBaseDir());
    }
    // The default is the bundled skill evidence directory, unchanged.
    expect(defaultEvidenceBaseDir()).toBe(path.join(resolveToolkitRoot(), 'evidence'));
    expect(resolveEvidenceRoot({ [EVIDENCE_ROOT_ENV]: undefined }).ok).toBe(true);
  });

  it('accepts an existing canonical absolute directory and uses it verbatim', () => {
    const base = makeCanonicalBase();
    const resolution = resolveEvidenceRoot({ [EVIDENCE_ROOT_ENV]: base });
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.origin).toBe('environment');
      expect(resolution.baseDir).toBe(base);
    }
    expect(explicitEvidenceRootProblem(base)).toBeNull();
    expect(base).not.toBe(defaultEvidenceBaseDir());
  });

  it('refuses blank, relative, root, unnormalized, missing, file and symlink values', () => {
    const base = makeCanonicalBase();
    const filePath = path.join(base, 'not-a-directory.txt');
    writeFileSync(filePath, 'x\n');
    const link = path.join(base, 'alias');
    symlinkSync(base, link, 'dir');

    const cases: Array<[string, string]> = [
      ['blank', '   '],
      ['relative', 'relative/evidence-root'],
      ['filesystem root', path.parse(base).root],
      ['unnormalized dot', `${base}/.`],
      ['unnormalized traversal', `${base}/nested/..`],
      ['trailing slash', `${base}/`],
      ['missing', path.join(base, 'definitely-missing')],
      ['file', filePath],
      ['symlink', link],
    ];
    for (const [label, value] of cases) {
      const problem = explicitEvidenceRootProblem(value);
      expect(problem, `${label} must be refused`).not.toBeNull();
      expect(resolveEvidenceRoot({ [EVIDENCE_ROOT_ENV]: value }).ok).toBe(false);
      // A problem string never echoes the raw adapter value.
      expect(problem).not.toContain(base);
    }
  });
});

/**
 * The evidence *run* root must reflect the selected base. `allocateRun` is the
 * earliest allocation boundary: a valid base is used for the owned evidence
 * root, an invalid base refuses before any port, scratch lease, or artifact.
 */
describe('[ADR 0119] Diagnostic run allocation uses the selected evidence root', () => {
  it('derives the owned run evidence root under the selected adapter base', async () => {
    const base = makeCanonicalBase();
    const runId = trackRun(generateRunId());

    const result = await withEvidenceRoot(base, () =>
      allocateRun({ runId, appRoot: APP_ROOT_COMPATIBLE }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.allocation.evidenceRoot).toBe(evidenceRunRoot(base, runId));
      expect(result.allocation.evidenceRoot.startsWith(`${base}${path.sep}`)).toBe(true);
      // Never the toolkit-owned default run root.
      expect(result.allocation.evidenceRoot).not.toBe(
        path.join(defaultEvidenceBaseDir(), 'runs', runId),
      );
    }

    const cleanup = await withEvidenceRoot(base, () =>
      cleanupRun(runId, { expectedAppRoot: APP_ROOT_COMPATIBLE }),
    );
    expect(cleanup.complete).toBe(true);
    expect(existsSync(scratchRootFor(runId))).toBe(false);
  });

  it('refuses an invalid adapter base before any port or scratch lease is created', async () => {
    const runId = trackRun(generateRunId());
    const sentinel = path.join(makeCanonicalBase(), 'definitely-missing');

    const result = await withEvidenceRoot(sentinel, () =>
      allocateRun({ runId, appRoot: APP_ROOT_COMPATIBLE }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('EVIDENCE_ROOT_INVALID');
      // The raw adapter value never appears in the refusal detail.
      expect(result.detail).not.toContain(sentinel);
    }
    expect(existsSync(scratchRootFor(runId))).toBe(false);
    expect(existsSync(ownershipRecordPathFor(runId))).toBe(false);
  });
});

describe('[ADR 0119] Diagnostic and suite surfaces refuse an unusable adapter base', () => {
  it('refuses Diagnostic as HARNESS_BLOCKED before plan, allocation, launch or write', async () => {
    const base = makeCanonicalBase();
    const sentinel = path.join(base, 'definitely-missing');
    const runId = trackRun('vt-evidence-env-diagnostic-invalid');

    const result = await withEvidenceRoot(sentinel, () =>
      runDiagnosticCommand({
        casePath: path.join(
          resolveToolkitRoot(),
          'cases',
          'diagnostic',
          'requests',
          'layer-text-move-drag-ordinary.json',
        ),
        appRoot: APP_ROOT_COMPATIBLE,
        runId,
      }),
    );
    expect(result.status).toBe('HARNESS_BLOCKED');
    expect(result.launchAttempted).toBe(false);
    expect(codes(result)).toContain('EVIDENCE_ROOT_ENV_INVALID');
    expect(result.details?.allocation).toBeNull();
    expect(result.details?.launch).toBeNull();
    expect(result.details?.durable.wrote).toBe(false);
    expect(result.details?.evidenceRoot).toBeNull();
    expect(existsSync(scratchRootFor(runId))).toBe(false);
    // The public envelope never echoes the raw adapter value.
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  it('refuses the whole Diagnostic suite before the first child', async () => {
    const base = makeCanonicalBase();
    const sentinel = path.join(base, 'definitely-missing');
    const suiteExecutionId = 'vt-evidence-env-suite-invalid';

    const result = await withEvidenceRoot(sentinel, () =>
      runDiagnosticSuiteCommand({ suiteId: 'representative', runId: suiteExecutionId }),
    );
    expect(result.status).toBe('HARNESS_BLOCKED');
    expect(result.launchAttempted).toBe(false);
    expect(codes(result)).toContain('EVIDENCE_ROOT_ENV_INVALID');
    expect(result.details?.executedCount).toBe(0);
    expect(result.details?.children).toEqual([]);
    expect(result.details?.suiteRecordPath).toBeNull();
  });
});

/**
 * The same environment must be present at cleanup. `ownershipRecordIsVerifiable`
 * derives the expected evidence root from the current process environment, so a
 * run allocated under one base refuses non-destructively under any other base
 * (or under the toolkit default) and cleans exactly its own resources only when
 * the original base is present again.
 */
describe('[ADR 0119] cleanup requires the same evidence base that allocated the run', () => {
  it('refuses non-destructively on a mismatched base, then cleans with the exact base', async () => {
    const allocatedBase = makeCanonicalBase('vt-evidence-root-alloc-');
    const otherBase = makeCanonicalBase('vt-evidence-root-other-');
    const runId = trackRun(generateRunId());

    const allocated = await withEvidenceRoot(allocatedBase, () =>
      allocateRun({ runId, appRoot: APP_ROOT_COMPATIBLE }),
    );
    expect(allocated.ok).toBe(true);
    expect(existsSync(ownershipRecordPathFor(runId))).toBe(true);

    // A different (valid) base must refuse without killing or deleting anything.
    const mismatched = await withEvidenceRoot(otherBase, () =>
      cleanupRun(runId, { expectedAppRoot: APP_ROOT_COMPATIBLE }),
    );
    expect(mismatched.attempted).toBe(false);
    expect(mismatched.complete).toBe(false);
    expect(mismatched.refusedReason).toBe('OWNERSHIP_RECORD_INVALID');
    expect(existsSync(ownershipRecordPathFor(runId))).toBe(true);
    expect(existsSync(scratchRootFor(runId))).toBe(true);

    // The toolkit default (variable unset) is also a mismatch: the same env must
    // be present, never silently reverted to the bundled location.
    const defaulted = await withEvidenceRoot(undefined, () =>
      cleanupRun(runId, { expectedAppRoot: APP_ROOT_COMPATIBLE }),
    );
    expect(defaulted.attempted).toBe(false);
    expect(defaulted.refusedReason).toBe('OWNERSHIP_RECORD_INVALID');
    expect(existsSync(scratchRootFor(runId))).toBe(true);

    // The exact original base cleans only its own resources.
    const cleaned = await withEvidenceRoot(allocatedBase, () =>
      cleanupRun(runId, { expectedAppRoot: APP_ROOT_COMPATIBLE }),
    );
    expect(cleaned.complete).toBe(true);
    expect(existsSync(scratchRootFor(runId))).toBe(false);
  });
});

/**
 * The suite aggregation root is derived from the selected base, and the public
 * projection is always relative.
 */
describe('[ADR 0119] suite aggregation root follows the selected base', () => {
  it('derives the suite root and its relative public projection from the base', () => {
    const base = makeCanonicalBase();
    const resolution = resolveEvidenceRoot({ [EVIDENCE_ROOT_ENV]: base });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;

    expect(evidenceSuiteRoot(resolution.baseDir, 'suite-abc')).toBe(
      path.join(base, 'suites', 'suite-abc'),
    );
    expect(evidenceRunRoot(resolution.baseDir, 'run-abc')).toBe(
      path.join(base, 'runs', 'run-abc'),
    );
    // Public projections are relative and never carry the absolute base.
    expect(evidenceSuiteRootRelativePath('suite-abc')).toBe('suites/suite-abc/suite-record.json');
    expect(evidenceRunRootRelativePath('run-abc')).toBe('runs/run-abc');
    for (const projection of [
      evidenceSuiteRootRelativePath('suite-abc'),
      evidenceRunRootRelativePath('run-abc'),
    ]) {
      expect(path.isAbsolute(projection)).toBe(false);
      expect(projection).not.toContain(base);
    }
  });
});

/**
 * `evidence verify` reads only the selected adapter base: it fails closed
 * without any filesystem access for an unusable value, reports a found-but-
 * invalid root under the selected base, and a missing id elsewhere.
 */
describe('[ADR 0119] evidence verify reads only the selected base', () => {
  it('fails closed without touching the filesystem for an unusable adapter base', async () => {
    const base = makeCanonicalBase();
    const sentinel = path.join(base, 'definitely-missing');
    const touched: string[] = [];
    const throwingFs: EvidenceVerifyFsAdapter = {
      lstat: () => {
        touched.push('lstat');
        throw new Error('filesystem must not be touched for an invalid evidence base');
      },
      readdir: () => {
        touched.push('readdir');
        throw new Error('filesystem must not be touched for an invalid evidence base');
      },
      readFile: () => {
        touched.push('readFile');
        throw new Error('filesystem must not be touched for an invalid evidence base');
      },
    };

    const result = await withEvidenceRoot(sentinel, () =>
      runEvidenceVerifyCommand(['--run', trackRun('vt-evidence-env-verify-invalid')], {
        fs: throwingFs,
      }),
    );
    expect(result.status).not.toBe('PASS');
    expect(result.details?.transaction.failureCode).toBe('VERIFY_ROOT_UNREADABLE');
    expect(touched).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  it('reads the run root under the selected base, never the toolkit default', async () => {
    const base = makeCanonicalBase();
    const runId = trackRun('vt-evidence-env-verify-found');
    // A run directory that exists but holds no transaction documents is found
    // through the selected base and classified as an invalid transaction.
    mkdirSync(evidenceRunRoot(base, runId), { recursive: true });

    const found = await withEvidenceRoot(base, () =>
      runEvidenceVerifyCommand(['--run', runId]),
    );
    expect(found.status).not.toBe('PASS');
    expect(found.details?.transaction.failureCode).toBe('VERIFY_TRANSACTION_INVALID');

    // An id absent from an otherwise valid base is a root-not-found, proving the
    // selected base (not a stale/other root) is the one resolved.
    const otherBase = makeCanonicalBase();
    const missing = await withEvidenceRoot(otherBase, () =>
      runEvidenceVerifyCommand(['--run', runId]),
    );
    expect(missing.details?.transaction.failureCode).toBe('VERIFY_ROOT_NOT_FOUND');
  });
});

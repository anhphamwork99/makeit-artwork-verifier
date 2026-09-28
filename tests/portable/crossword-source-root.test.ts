import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { compilePreparedExecutionCandidate } from '../../src/cli/diagnostic';
import { CROSSWORD_STORE_SOURCE_PATH } from '../../src/contracts/crossword';
import { executeCrosswordPlan } from '../../src/runtime/execute-crossword-plan';
import {
  crosswordSourcePaths,
  readCrosswordSourceContract,
  readLegacyCrosswordSourceContractFromCwd,
} from '../../src/runtime/crossword-source';
import { resolveToolkitRoot } from '../../src/runtime/paths';

/**
 * Focused generated-Crossword source-root binding (ADR 0017 R4 / ADR 0118).
 *
 * The accepted Crossword source contract belongs to the explicit FE application
 * root, not to `process.cwd()` or the toolkit checkout. These portable tests
 * prove that:
 *
 * - planning reads the source at the supplied app root and binds its content
 *   fingerprint, failing closed with `CROSSWORD_SOURCE_DRIFT` when the root has
 *   no matching source (never the toolkit cwd's ENOENT);
 * - two distinct explicit roots produce two distinct fingerprints, so the read
 *   cannot silently resolve to a shared cwd;
 * - the runtime executor re-reads the same root from the owned allocation and
 *   fails drift instead of rebaselining on a changed source;
 * - the no-root cwd seam stays explicit and testable for legacy callers.
 *
 * The synthetic fixture roots are minimal structural stand-ins, not product
 * source: they satisfy only the published R4 predicates.
 */

const PORTABLE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = path.join(PORTABLE_ROOT, 'fixtures');
const APP_ROOT_A = path.join(FIXTURES_ROOT, 'app-root-crossword-a');
const APP_ROOT_B = path.join(FIXTURES_ROOT, 'app-root-crossword-b');
const APP_ROOT_DRIFT = path.join(FIXTURES_ROOT, 'app-root-crossword-drift');
const APP_ROOT_NO_SOURCE = path.join(FIXTURES_ROOT, 'app-root-compatible');

function crosswordRequest(): unknown {
  return JSON.parse(
    readFileSync(
      path.join(resolveToolkitRoot(), 'cases', 'diagnostic', 'requests', 'layer-crossword-create.json'),
      'utf8',
    ),
  );
}

describe('[ADR 0118] crossword source paths bind to an explicit app root', () => {
  it('resolves the exact absolute product files under the supplied root', () => {
    const paths = crosswordSourcePaths(APP_ROOT_A);
    expect(paths.storeSourcePath).toBe(
      path.join(APP_ROOT_A, ...CROSSWORD_STORE_SOURCE_PATH.split('/')),
    );
    expect(path.isAbsolute(paths.storeSourcePath)).toBe(true);
    expect(paths.storeSourcePath.startsWith(APP_ROOT_A)).toBe(true);
    // Bound to the explicit root, never the repository-relative cwd path.
    expect(paths.storeSourcePath).not.toBe(path.resolve(CROSSWORD_STORE_SOURCE_PATH));
    expect(paths.storeSourcePath).toBe(path.join(APP_ROOT_A, ...CROSSWORD_STORE_SOURCE_PATH.split('/')));
  });

  it('reads and validates the source at the explicit root', () => {
    const read = readCrosswordSourceContract(APP_ROOT_A);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('binds two distinct explicit roots to distinct fingerprints', () => {
    const readA = readCrosswordSourceContract(APP_ROOT_A);
    const readB = readCrosswordSourceContract(APP_ROOT_B);
    expect(readA.ok && readB.ok).toBe(true);
    if (readA.ok && readB.ok) expect(readA.fingerprint).not.toBe(readB.fingerprint);
  });

  it('keeps the no-root legacy cwd seam explicit and fails closed in the toolkit', () => {
    // The toolkit root deliberately does not vendor the product source, so the
    // legacy cwd-relative seam is unusable here — which is exactly why the
    // public Diagnostic path must supply an explicit app root.
    const legacy = readLegacyCrosswordSourceContractFromCwd();
    expect(legacy.ok).toBe(false);
    if (!legacy.ok) expect(legacy.detail).toContain(CROSSWORD_STORE_SOURCE_PATH);
  });
});

describe('[ADR 0118] planning binds Crossword source to the explicit app root', () => {
  it('compiles the Crossword case against an explicit root and binds its fingerprint', () => {
    const compiled = compilePreparedExecutionCandidate(crosswordRequest(), APP_ROOT_A);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const read = readCrosswordSourceContract(APP_ROOT_A);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(compiled.candidate.planning.plan.fixture?.crosswordSourceFingerprint).toBe(
      read.fingerprint,
    );
    expect(compiled.candidate.planning.materializedCase.fixture?.crosswordSourceFingerprint).toBe(
      read.fingerprint,
    );
  });

  it('reports truthful CROSSWORD_SOURCE_DRIFT when the explicit root has no source', () => {
    const compiled = compilePreparedExecutionCandidate(crosswordRequest(), APP_ROOT_NO_SOURCE);
    expect(compiled.ok).toBe(false);
    if (compiled.ok) return;
    expect(compiled.planning.status).toBe('HARNESS_BLOCKED');
    if (compiled.planning.status !== 'HARNESS_BLOCKED') return;
    expect(compiled.planning.code).toBe('CROSSWORD_SOURCE_DRIFT');
    // The unreadable path is the supplied root's, never the toolkit cwd's.
    const detail = compiled.planning.diagnostic.detail;
    expect(detail).toContain(path.join(APP_ROOT_NO_SOURCE, ...CROSSWORD_STORE_SOURCE_PATH.split('/')));
    expect(detail).toContain('The generated-Crossword product source could not be read:');
  });

  it('reports CROSSWORD_SOURCE_DRIFT when the explicit root violates the source contract', () => {
    const compiled = compilePreparedExecutionCandidate(crosswordRequest(), APP_ROOT_DRIFT);
    expect(compiled.ok).toBe(false);
    if (compiled.ok) return;
    expect(compiled.planning.status).toBe('HARNESS_BLOCKED');
    if (compiled.planning.status !== 'HARNESS_BLOCKED') return;
    expect(compiled.planning.code).toBe('CROSSWORD_SOURCE_DRIFT');
  });
});

describe('[ADR 0118] runtime re-checks the same owned app-root files', () => {
  function crosswordInput(appRoot: string, repoRoot: string) {
    const compiled = compilePreparedExecutionCandidate(crosswordRequest(), appRoot);
    if (!compiled.ok) throw new Error(`fixture case did not plan: ${compiled.planning.status}`);
    const openPage = vi.fn();
    const input = {
      allocation: { repoRoot },
      caseId: compiled.candidate.planning.caseId,
      intent: compiled.candidate.planning.materializedCase.intent,
      plan: compiled.candidate.planning.plan,
      adapter: {},
      fixture: { inputs: {} },
      workflowSteps: [],
      environment: {},
      openPage,
    } as unknown as Parameters<typeof executeCrosswordPlan>[0];
    return { input, openPage };
  }

  function codes(diagnostics: readonly { code: string }[]): string[] {
    return diagnostics.map((entry) => entry.code);
  }

  it('accepts the same owned files and never re-reads the toolkit cwd', async () => {
    const { input, openPage } = crosswordInput(APP_ROOT_A, APP_ROOT_A);
    const result = await executeCrosswordPlan(input);
    // Same root and fingerprint: the source gate passes and the drive stops on
    // the next, unrelated prerequisite instead of reporting drift.
    expect(codes(result.behavior.diagnostics)).not.toContain('CROSSWORD_SOURCE_DRIFT');
    expect(codes(result.behavior.diagnostics)).toContain('CROSSWORD_CLOCK_PROFILE_INVALID');
    expect(openPage).not.toHaveBeenCalled();
  });

  it('fails drift when the owned root has a different source revision', async () => {
    const { input, openPage } = crosswordInput(APP_ROOT_A, APP_ROOT_B);
    const result = await executeCrosswordPlan(input);
    expect(result.crossword.outcome).toBe('HARNESS_BLOCKED');
    expect(codes(result.behavior.diagnostics)).toContain('CROSSWORD_SOURCE_DRIFT');
    expect(result.finalObservation).toBeNull();
    expect(openPage).not.toHaveBeenCalled();
  });

  it('fails drift when the owned root exposes no source rather than rebaselining', async () => {
    const { input, openPage } = crosswordInput(APP_ROOT_A, APP_ROOT_NO_SOURCE);
    const result = await executeCrosswordPlan(input);
    expect(result.crossword.outcome).toBe('HARNESS_BLOCKED');
    expect(codes(result.behavior.diagnostics)).toContain('CROSSWORD_SOURCE_DRIFT');
    expect(result.finalObservation).toBeNull();
    expect(openPage).not.toHaveBeenCalled();
  });
});

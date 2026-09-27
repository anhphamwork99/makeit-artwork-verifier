import { describe, expect, it } from 'vitest';

import {
  GENERIC_ENGINE_FILES,
  runBranchCheck,
  scanSource,
  subjectTokens,
} from '../../scripts/verify-engine-branching.mjs';

describe('[Gate A] AST branch audit over the generic engine surface (TS-1)', () => {
  it('passes over every declared generic engine module', () => {
    const result = runBranchCheck();

    expect(result.violations).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.engineFiles.length).toBeGreaterThanOrEqual(18);
    expect(result.tokenCount).toBeGreaterThan(0);
  });

  it('declares the production generic engine surface explicitly', () => {
    expect(GENERIC_ENGINE_FILES).toEqual(
      expect.arrayContaining([
        'src/canonical/canonicalize.ts',
        'src/canonical/identity.ts',
        'src/catalogue/load.ts',
        'src/catalogue/resolve.ts',
        'src/catalogue/fingerprint.ts',
        'src/registry/reconcile.ts',
        'src/registry/validate.ts',
        'src/routing/resolve.ts',
        'src/planner/normalize-intent.ts',
        'src/planner/materialize.ts',
        'src/planner/compile-plan.ts',
        'src/planner/preflight.ts',
        'src/planner/plan-case.ts',
        'src/allocation/reserve.ts',
        'src/allocation/ownership.ts',
        'src/runtime/outcomes.ts',
      ]),
    );
  });

  it('derives its Subject tokens from the verification catalogues', () => {
    const tokens = subjectTokens();

    expect(tokens).toContain('layer/text');
    expect(tokens).toContain('layer');
    expect(tokens).toContain('text');
    expect(tokens).toContain('crossword');
  });

  it('detects real Subject branching instead of being vacuous', () => {
    const tokens = subjectTokens();

    expect(scanSource("const x = subject.kind === 'crossword';", 'fake.ts', tokens)).toHaveLength(
      1,
    );
    expect(
      scanSource("switch (subject.family) { case 'layer': break; }", 'fake.ts', tokens),
    ).toHaveLength(1);
    expect(
      scanSource("const allowed = kinds.includes('starmap');", 'fake.ts', tokens),
    ).toHaveLength(1);
    expect(scanSource("const parent = relationships['object'];", 'fake.ts', tokens)).toHaveLength(
      1,
    );
  });

  it('does not flag declarative catalogue data or JavaScript type checks', () => {
    const tokens = subjectTokens();

    expect(
      scanSource(
        "const kinds = ['layout', 'text', 'image', 'crossword', 'starmap', 'object'];",
        'fake.ts',
        tokens,
      ),
    ).toHaveLength(0);
    expect(
      scanSource(
        "const declaration = { subjectId: 'layer/text', family: 'layer' };",
        'fake.ts',
        tokens,
      ),
    ).toHaveLength(0);
    expect(
      scanSource("if (typeof value === 'object') return true;", 'fake.ts', tokens),
    ).toHaveLength(0);
    expect(
      scanSource(
        "switch (typeof value) { case 'object': return 1; default: return 0; }",
        'fake.ts',
        tokens,
      ),
    ).toHaveLength(0);
  });
});

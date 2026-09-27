import { describe, expect, it } from 'vitest';

import {
  CROSSWORD_DEFAULT_WORDS,
  CROSSWORD_SEMANTIC_DIGEST_DOMAIN,
  type CrosswordLayoutFactsV1,
  compareCrosswordRepresentative,
  crosswordSemanticDigest,
  crosswordSemanticPayloadFromLayerShape,
  validateCrosswordLayoutStructure,
  validateCrosswordSourceContract,
} from '../../src/contracts/crossword';
import { canonicalize, sha256Hex } from '../../src/canonical/canonicalize';

/**
 * Deterministic Crossword semantic contract (ADR 0017 R4/R6/R7/R8).
 *
 * These are pure predicate tests over synthetic facts: no browser layout, seed,
 * or digest is stored as an expectation.
 */

/** A minimal valid crossing layout over a two-word override set. */
function validFacts(): CrosswordLayoutFactsV1 {
  return {
    words: ['AB', 'BC'],
    cells: [
      { row: 0, col: 0, letter: 'A' },
      { row: 0, col: 1, letter: 'B' },
      { row: 1, col: 1, letter: 'C' },
    ],
    placedWords: [
      { word: 'AB', row: 0, col: 0, direction: 'across', intersections: 0 },
      { word: 'BC', row: 0, col: 1, direction: 'down', intersections: 1 },
    ],
    omittedWords: [],
    width: 2,
    height: 2,
    minRow: 0,
    minCol: 0,
    maxRow: 1,
    maxCol: 1,
    intersections: 1,
  };
}

const TWO_WORDS = ['AB', 'BC'];

function validate(facts: CrosswordLayoutFactsV1) {
  return validateCrosswordLayoutStructure(facts, TWO_WORDS);
}

describe('crossword structural interpretation (R7)', () => {
  it('accepts a structurally consistent layout and emits a closed payload', () => {
    const result = validate(validFacts());
    expect(result.ok).toBe(true);
    expect(result.payload).not.toBeNull();
    expect(result.payload?.schemaVersion).toBe(1);
    expect(result.payload?.layout.width).toBe(2);
    expect(result.payload?.layout.height).toBe(2);
  });

  it('rejects out-of-bounds, duplicate, and misordered cells', () => {
    const outOfBounds = validFacts();
    outOfBounds.cells = [...outOfBounds.cells, { row: 9, col: 9, letter: 'Z' }];
    expect(validate(outOfBounds).findings.map((f) => f.code)).toContain(
      'CROSSWORD_CELL_OUT_OF_BOUNDS',
    );

    const duplicate = validFacts();
    duplicate.cells = [...duplicate.cells, { row: 0, col: 0, letter: 'A' }];
    expect(validate(duplicate).findings.map((f) => f.code)).toContain('CROSSWORD_CELL_DUPLICATE');
  });

  it('rejects placed words that disagree with their cells', () => {
    const disagreeing = validFacts();
    disagreeing.cells = [
      { row: 0, col: 0, letter: 'A' },
      { row: 0, col: 1, letter: 'X' },
      { row: 1, col: 1, letter: 'C' },
    ];
    expect(validate(disagreeing).findings.map((f) => f.code)).toContain(
      'CROSSWORD_PLACED_LETTER_MISMATCH',
    );
  });

  it('rejects bound, word-multiset, and intersection inconsistencies', () => {
    const badBounds = validFacts();
    badBounds.width = 3;
    expect(validate(badBounds).findings.map((f) => f.code)).toContain(
      'CROSSWORD_BOUNDS_INCONSISTENT',
    );

    const undeclared = validFacts();
    undeclared.omittedWords = ['ZZ'];
    expect(validate(undeclared).findings.map((f) => f.code)).toContain('CROSSWORD_UNDECLARED_WORD');

    const badIntersections = validFacts();
    badIntersections.placedWords = [
      { word: 'AB', row: 0, col: 0, direction: 'across', intersections: 0 },
      { word: 'BC', row: 0, col: 1, direction: 'down', intersections: 2 },
    ];
    expect(validate(badIntersections).findings.map((f) => f.code)).toContain(
      'CROSSWORD_INTERSECTIONS_INCONSISTENT',
    );

    const badAggregate = validFacts();
    badAggregate.intersections = 5;
    expect(validate(badAggregate).findings.map((f) => f.code)).toContain(
      'CROSSWORD_INTERSECTIONS_INCONSISTENT',
    );
  });

  it('refuses to normalize a malformed layout into passing evidence', () => {
    const malformed = validFacts();
    malformed.cells = [];
    const result = validate(malformed);
    expect(result.ok).toBe(false);
    expect(result.payload).toBeNull();
  });
});

describe('crossword semantic digest (R6)', () => {
  it('uses the exact versioned domain and canonical payload', () => {
    expect(CROSSWORD_SEMANTIC_DIGEST_DOMAIN).toBe('makeit:crossword-layout-semantic:v1');
    const payload = validate(validFacts()).payload as NonNullable<
      ReturnType<typeof validate>['payload']
    >;
    const expected = sha256Hex(`${CROSSWORD_SEMANTIC_DIGEST_DOMAIN}\0${canonicalize(payload)}`);
    expect(crosswordSemanticDigest(payload)).toBe(expected);
    expect(crosswordSemanticDigest(payload)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('excludes the seed, runtime ids, and layer frame from the digest', () => {
    const base = {
      id: 'runtime-one',
      generationSeed: 1767323045000,
      x: 10,
      y: 20,
      width: 360,
      height: 360,
      words: ['AB', 'BC'],
      layout: {
        cells: [
          { row: 0, col: 0, letter: 'A' },
          { row: 0, col: 1, letter: 'B' },
          { row: 1, col: 1, letter: 'C' },
        ],
        placedWords: [
          { word: 'AB', row: 0, col: 0, direction: 'across', intersections: 0 },
          { word: 'BC', row: 0, col: 1, direction: 'down', intersections: 1 },
        ],
        omittedWords: [],
        width: 2,
        height: 2,
        minRow: 0,
        minCol: 0,
        maxRow: 1,
        maxCol: 1,
        intersections: 1,
      },
    };
    const first = crosswordSemanticPayloadFromLayerShape(base, TWO_WORDS);
    // The runtime-only id/seed/frame mutation stays outside the narrow
    // `{ words, layout }` semantic input type, so it is never an excess property.
    const mutatedSeedLayer = {
      ...base,
      id: 'runtime-two',
      generationSeed: 123456789,
      x: 999,
      y: 999,
      width: 111,
      height: 222,
    };
    const mutatedSeed = crosswordSemanticPayloadFromLayerShape(mutatedSeedLayer, TWO_WORDS);
    expect(first.ok && mutatedSeed.ok).toBe(true);
    expect(crosswordSemanticDigest(first.payload!)).toBe(
      crosswordSemanticDigest(mutatedSeed.payload!),
    );
  });

  it('is sensitive to every included generated-layout field', () => {
    const payload = validate(validFacts()).payload!;
    const baseline = crosswordSemanticDigest(payload);

    const cellMutation = structuredClone(payload);
    (cellMutation.layout.cells[2] as { letter: string }).letter = 'D';
    expect(crosswordSemanticDigest(cellMutation)).not.toBe(baseline);

    const placedMutation = structuredClone(payload);
    (placedMutation.layout.placedWords[1] as { intersections: number }).intersections = 0;
    expect(crosswordSemanticDigest(placedMutation)).not.toBe(baseline);

    const boundsMutation = structuredClone(payload);
    (boundsMutation.layout as { minRow: number }).minRow = -1;
    expect(crosswordSemanticDigest(boundsMutation)).not.toBe(baseline);

    const wordOrderMutation = structuredClone(payload);
    wordOrderMutation.words = [...wordOrderMutation.words].reverse();
    expect(crosswordSemanticDigest(wordOrderMutation)).not.toBe(baseline);
  });

  it('canonicalizes cell order without changing the digest', () => {
    const shuffled = validFacts();
    shuffled.cells = [
      { row: 1, col: 1, letter: 'C' },
      { row: 0, col: 1, letter: 'B' },
      { row: 0, col: 0, letter: 'A' },
    ];
    const ordered = validFacts();
    expect(crosswordSemanticDigest(validate(shuffled).payload!)).toBe(
      crosswordSemanticDigest(validate(ordered).payload!),
    );
  });
});

describe('approved representative predicate (R8)', () => {
  it('requires same words, a different seed, and a different digest', () => {
    expect(
      compareCrosswordRepresentative({
        wordsA: [...CROSSWORD_DEFAULT_WORDS],
        wordsB: [...CROSSWORD_DEFAULT_WORDS],
        seedA: 1767323045000,
        seedB: 123456789,
        semanticDigestA: 'a'.repeat(64),
        semanticDigestB: 'b'.repeat(64),
      }),
    ).toEqual({
      wordsEqual: true,
      seedDifferent: true,
      semanticDigestDifferent: true,
      sensitive: true,
    });
    expect(
      compareCrosswordRepresentative({
        wordsA: [...CROSSWORD_DEFAULT_WORDS],
        wordsB: [...CROSSWORD_DEFAULT_WORDS],
        seedA: 1767323045000,
        seedB: 1767323045002,
        semanticDigestA: 'a'.repeat(64),
        semanticDigestB: 'a'.repeat(64),
      }).sensitive,
    ).toBe(false);
  });
});

describe('source-currentness contract (R4)', () => {
  const storeSource = [
    "export const DEFAULT_CROSSWORD_WORDS = ['MAKEIT', 'CROSSWORD', 'HELLO'];",
    'function createDefaultArtworkCrosswordLayer() {',
    '  const seed = Date.now();',
    '  const words = [...DEFAULT_CROSSWORD_WORDS];',
    '  const layout = generateCrosswordLayout(words, seed);',
    '  return { crossword: { words, layout, generationSeed: seed } };',
    '}',
  ].join('\n');
  const generatorSource = 'export function generateCrosswordLayout(words, seed) { return {}; }';

  it('accepts the accepted source shape and derives a stable fingerprint', () => {
    const first = validateCrosswordSourceContract({ storeSource, generatorSource });
    const second = validateCrosswordSourceContract({ storeSource, generatorSource });
    expect(first.ok).toBe(true);
    expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it('fails closed when the seed read, default words, or generator boundary changes', () => {
    const twoReads = storeSource.replace(
      '  const seed = Date.now();',
      '  const seed = Date.now();\n  const seed = Date.now();',
    );
    expect(validateCrosswordSourceContract({ storeSource: twoReads, generatorSource }).ok).toBe(
      false,
    );

    const wrongClock = storeSource.replace(
      'const seed = Date.now();',
      'const seed = performance.now();',
    );
    expect(validateCrosswordSourceContract({ storeSource: wrongClock, generatorSource }).ok).toBe(
      false,
    );

    const renamedWords = storeSource.replace("['MAKEIT', 'CROSSWORD', 'HELLO']", "['MAKEIT']");
    expect(validateCrosswordSourceContract({ storeSource: renamedWords, generatorSource }).ok).toBe(
      false,
    );

    const implicitSeed = storeSource.replace(
      'generateCrosswordLayout(words, seed)',
      'generateCrosswordLayout(words)',
    );
    expect(validateCrosswordSourceContract({ storeSource: implicitSeed, generatorSource }).ok).toBe(
      false,
    );

    const randomGenerator = `${generatorSource} // Math.random()`;
    expect(
      validateCrosswordSourceContract({ storeSource, generatorSource: randomGenerator }).ok,
    ).toBe(false);
  });
});

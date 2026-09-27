import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { generateCrosswordLayout } from '@/lib/artwork/crosswordEngine/layout';
import {
  CROSSWORD_GENERATOR_SOURCE_PATH,
  CROSSWORD_STORE_SOURCE_PATH,
  compareCrosswordRepresentative,
  crosswordSemanticDigest,
  crosswordSemanticPayloadFromLayerShape,
  validateCrosswordSourceContract,
} from '../../src/contracts/crossword';

/**
 * Pure generator/source contract proof at the accepted product fingerprint
 * (ADR 0017 R4/R6/R8).
 *
 * Reproduces the class of check the materialization performs: the accepted
 * product source still satisfies the seed/default-word/generator-boundary
 * contract, the fixed A/B representative currently produces distinct complete
 * semantic payloads, and the approved 2 ms collision remains a diagnostic-only
 * collision. No browser result, expected layout, or expected digest is stored:
 * every value below is recomputed from the product generator.
 */

const STORE_SOURCE = readFileSync(CROSSWORD_STORE_SOURCE_PATH, 'utf8');
const GENERATOR_SOURCE = readFileSync(CROSSWORD_GENERATOR_SOURCE_PATH, 'utf8');

const SEED_A = Date.parse('2026-01-02T03:04:05.000Z');
const SEED_B = Date.parse('1970-01-02T10:17:36.789Z');
const SEED_A_COLLISION = Date.parse('2026-01-02T03:04:05.002Z');
const WORDS = ['MAKEIT', 'CROSSWORD', 'HELLO'];

function digestForSeed(seed: number): string {
  const layout = generateCrosswordLayout([...WORDS], seed);
  const result = crosswordSemanticPayloadFromLayerShape({ words: WORDS, layout });
  expect(result.ok, result.findings.map((finding) => finding.detail).join('; ')).toBe(true);
  return crosswordSemanticDigest(result.payload!);
}

describe('crossword source contract at the accepted product revision (R4)', () => {
  it('binds the store seed read, default words, and generator boundary', () => {
    const result = validateCrosswordSourceContract({
      storeSource: STORE_SOURCE,
      generatorSource: GENERATOR_SOURCE,
    });
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('fixed representative separation at the accepted generator fingerprint (R8)', () => {
  it('places every default word with no omissions', () => {
    for (const seed of [SEED_A, SEED_B]) {
      const layout = generateCrosswordLayout([...WORDS], seed);
      expect(layout.omittedWords).toEqual([]);
      expect([...layout.placedWords].map((placed) => placed.word).sort()).toEqual(
        [...WORDS].sort(),
      );
      const result = crosswordSemanticPayloadFromLayerShape({ words: WORDS, layout });
      expect(result.ok).toBe(true);
    }
  });

  it('repeats the same seed and separates the approved different seed', () => {
    const digestA1 = digestForSeed(SEED_A);
    const digestA2 = digestForSeed(SEED_A);
    const digestB = digestForSeed(SEED_B);
    expect(digestA1).toBe(digestA2);
    const comparison = compareCrosswordRepresentative({
      wordsA: WORDS,
      wordsB: WORDS,
      seedA: SEED_A,
      seedB: SEED_B,
      semanticDigestA: digestA1,
      semanticDigestB: digestB,
    });
    expect(comparison).toEqual({
      wordsEqual: true,
      seedDifferent: true,
      semanticDigestDifferent: true,
      sensitive: true,
    });
  });

  it('documents the diagnostic-only 2 ms collision without claiming universal injectivity', () => {
    // The approved collision is diagnostic-only and earns no Gate E credit. It
    // proves the intentional-BUG classifier and must never be presented as a
    // product requirement that every distinct seed produce a distinct layout.
    expect(digestForSeed(SEED_A_COLLISION)).toBe(digestForSeed(SEED_A));
  });
});

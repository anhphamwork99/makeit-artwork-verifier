// @ts-nocheck
// Synthetic portable fixture that deliberately VIOLATES the ADR 0017 R4 source
// contract: the ordered default word set is wrong and the initial seed is no
// longer passed to the generator. Reading this root must produce drift.
export const DEFAULT_CROSSWORD_WORDS = ['MAKEIT', 'HELLO'];

export function createDefaultArtworkCrosswordLayer() {
  const seed = Date.now();
  return generateCrosswordLayout(DEFAULT_CROSSWORD_WORDS);
}
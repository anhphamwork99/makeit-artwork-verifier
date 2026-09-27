// @ts-nocheck
// Synthetic portable fixture (ADR 0118 focused test). This is NOT product
// source: it is a minimal structural stand-in that satisfies the ADR 0017 R4
// source contract so planning/runtime can be proved to read the explicit app
// root. It declares the exact ordered default word set, reads Date.now() exactly
// once as the initial seed, and passes that seed explicitly to the generator.
export const DEFAULT_CROSSWORD_WORDS = ['MAKEIT', 'CROSSWORD', 'HELLO'];

export function createDefaultArtworkCrosswordLayer(words = DEFAULT_CROSSWORD_WORDS) {
  const seed = Date.now();
  return generateCrosswordLayout(words, seed);
}
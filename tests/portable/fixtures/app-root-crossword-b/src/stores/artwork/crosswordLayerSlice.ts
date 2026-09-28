// @ts-nocheck
// Synthetic portable fixture variant B (ADR 0118 focused test). Identical
// contract shape to root A with distinct content, so a root-bound read yields a
// different fingerprint and a cwd-bound read cannot produce either.
export const DEFAULT_CROSSWORD_WORDS = ['MAKEIT', 'CROSSWORD', 'HELLO'];

export function createDefaultArtworkCrosswordLayer(words = DEFAULT_CROSSWORD_WORDS) {
  const seed = Date.now();
  return generateCrosswordLayout(words, seed);
}
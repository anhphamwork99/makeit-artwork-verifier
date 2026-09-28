// @ts-nocheck
// Synthetic portable fixture (ADR 0118 focused test). Structural stand-in for
// the product crossword generator boundary; it uses no randomness, worker,
// fetch, await, or Promise so the R4 source contract holds.
export function generateCrosswordLayout(words, seed) {
  return { words, seed };
}
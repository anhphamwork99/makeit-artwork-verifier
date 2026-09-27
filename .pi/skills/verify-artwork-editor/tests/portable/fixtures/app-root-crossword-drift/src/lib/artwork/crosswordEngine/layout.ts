// @ts-nocheck
// Synthetic portable fixture that deliberately VIOLATES the ADR 0017 R4 source
// contract: the generator now depends on randomness.
export function generateCrosswordLayout(words, seed) {
  return { words, seed, salt: Math.random() };
}
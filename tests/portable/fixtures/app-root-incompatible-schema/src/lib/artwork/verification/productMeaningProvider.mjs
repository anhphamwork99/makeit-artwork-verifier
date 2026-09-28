/**
 * Synthetic provider declaring an unsupported contract schema version
 * (portable test fixture). Every other field is contract-shaped, so the loader
 * must refuse specifically as `PROVIDER_INCOMPATIBLE`, not as a malformed
 * export.
 */
const PROFILE_ID = 'artwork-product-meaning-v1';

function noopMeaning(value) {
  return value;
}

export const productMeaningProvider = {
  schemaVersion: 2,
  profileId: PROFILE_ID,
  normalizeArtworkProductMeaning: noopMeaning,
  canonicalizeNormalizedMeaning: noopMeaning,
  fingerprintNormalizedMeaning: noopMeaning,
  extractRawCrosswordSemanticPayload: () => null,
};

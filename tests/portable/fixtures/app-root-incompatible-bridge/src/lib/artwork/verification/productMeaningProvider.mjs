export const productMeaningProvider = Object.freeze({
  schemaVersion: 1,
  profileId: 'artwork-product-meaning-v1',
  hostCompatibility: Object.freeze({
    schemaVersion: 1,
    bridgeVersion: 8,
    capabilities: Object.freeze({}),
  }),
  normalizeArtworkProductMeaning() {
    return {
      schemaVersion: 1,
      profileId: 'artwork-product-meaning-v1',
      layouts: [],
    };
  },
  canonicalizeNormalizedMeaning() {
    return '{}';
  },
  fingerprintNormalizedMeaning() {
    return 'fixture';
  },
  extractRawCrosswordSemanticPayload() {
    return null;
  },
});

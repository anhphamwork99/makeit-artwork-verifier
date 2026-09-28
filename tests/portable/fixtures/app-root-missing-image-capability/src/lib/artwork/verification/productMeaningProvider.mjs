const SCHEMA_VERSION = 1;
const PROFILE_ID = 'artwork-product-meaning-v1';

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry)).join(',')}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
    .join(',')}}`;
}

export const productMeaningProvider = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  profileId: PROFILE_ID,
  hostCompatibility: Object.freeze({
    schemaVersion: 1,
    bridgeVersion: 7,
    capabilities: Object.freeze({
      'history.semantic-transition': 'meaning-revision-v1',
      'nested-object.identity-wrapper': 'chain-v1',
    }),
  }),
  normalizeArtworkProductMeaning(snapshot) {
    const source = snapshot !== null && typeof snapshot === 'object' ? snapshot : {};
    return {
      schemaVersion: SCHEMA_VERSION,
      profileId: PROFILE_ID,
      layouts: Array.isArray(source.layouts) ? source.layouts : [],
    };
  },
  canonicalizeNormalizedMeaning(value) {
    return canonicalize(value);
  },
  fingerprintNormalizedMeaning(value) {
    return canonicalize(value);
  },
  extractRawCrosswordSemanticPayload() {
    return null;
  },
});

/**
 * Synthetic compatible product-meaning provider (portable test fixture).
 *
 * This is a toolkit-owned, dependency-free stand-in for the FE-owned provider
 * described by ADR 0118. It exists only to prove that the standalone loader
 * accepts a contract-compatible module read from an explicit app root without
 * any FE checkout present. It is never imported by toolkit runtime code.
 */
const SCHEMA_VERSION = 1;
const PROFILE_ID = 'artwork-product-meaning-v1';

function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
    .join(',')}}`;
}

function fingerprint(value) {
  const text = canonicalize(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fixture-${hash.toString(16).padStart(8, '0')}`;
}

export const productMeaningProvider = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  profileId: PROFILE_ID,
  normalizeArtworkProductMeaning(snapshot) {
    const source = snapshot !== null && typeof snapshot === 'object' ? snapshot : {};
    const layouts = Array.isArray(source.layouts) ? source.layouts : [];
    return { schemaVersion: SCHEMA_VERSION, profileId: PROFILE_ID, layouts };
  },
  canonicalizeNormalizedMeaning(value) {
    return canonicalize(value);
  },
  fingerprintNormalizedMeaning(value) {
    return fingerprint(value);
  },
  extractRawCrosswordSemanticPayload(value) {
    if (value === null || typeof value !== 'object' || value.marker !== true) {
      return null;
    }
    return {
      marker: true,
      generationSeed: Number.isFinite(value.generationSeed) ? value.generationSeed : 0,
      words: Array.isArray(value.words) ? value.words.map((word) => String(word)) : [],
      layout: value.layout ?? null,
    };
  },
});

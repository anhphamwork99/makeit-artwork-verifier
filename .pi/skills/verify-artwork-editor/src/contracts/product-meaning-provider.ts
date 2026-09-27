/**
 * Typed product-meaning provider contract (ADR 0118).
 *
 * The FE-owned normalized-meaning core remains the single implementation of
 * normalization, canonicalization, fingerprinting and raw Crossword extraction.
 * The standalone toolkit never vendors, shims or reimplements it. Instead the
 * toolkit owns this narrow contract and a scoped loader that reads exactly one
 * FE-owned provider module from the explicit, validated `--app-root` during
 * Diagnostic preflight, then injects the validated provider into the history and
 * restore executors.
 *
 * This module is pure data/type declaration: it imports nothing and therefore
 * stays loadable in every toolkit runtime (Node CLI, Vitest) without an
 * application alias.
 */

/** Closed schema version of the provider contract this toolkit accepts. */
export const PRODUCT_MEANING_PROVIDER_SCHEMA_VERSION = 1;

/** Stable profile identity of the FE-owned normalized product meaning. */
export const PRODUCT_MEANING_PROVIDER_PROFILE_ID = 'artwork-product-meaning-v1';

/**
 * Single accepted relative path of the FE-owned narrow provider module,
 * resolved against the explicit `--app-root`. WP3 owns authoring this FE export;
 * product behavior and the meaning core stay unchanged.
 */
export const PRODUCT_MEANING_PROVIDER_ENTRY_RELATIVE_PATH =
  'src/lib/artwork/verification/productMeaningProvider.mjs';

/** The named export the FE provider module must publish. */
export const PRODUCT_MEANING_PROVIDER_EXPORT_NAME = 'productMeaningProvider';

/**
 * Opaque normalized Artwork meaning. The provider owns the closed shape; the
 * toolkit only canonicalizes and fingerprints it.
 */
export interface NormalizedArtworkMeaningView {
  readonly schemaVersion: number;
  readonly profileId: string;
  readonly layouts: readonly unknown[];
}

/** Bounded raw Crossword semantics extracted from an un-normalized payload. */
export interface RawCrosswordSemanticPayloadView {
  readonly marker: true;
  readonly generationSeed: number;
  readonly words: readonly string[];
  readonly layout: unknown;
}

/**
 * The narrow, versioned provider the toolkit injects into the meaning-dependent
 * executors. It is deliberately structural: the FE core's functions satisfy it
 * without the toolkit importing an FE store or product type.
 */
export interface ProductMeaningProviderV1 {
  readonly schemaVersion: number;
  readonly profileId: string;
  normalizeArtworkProductMeaning(snapshot: unknown): NormalizedArtworkMeaningView;
  canonicalizeNormalizedMeaning(value: unknown): string;
  fingerprintNormalizedMeaning(value: unknown): string;
  extractRawCrosswordSemanticPayload(value: unknown): RawCrosswordSemanticPayloadView | null;
}

/** The FE provider module's required named export container. */
export interface ProductMeaningProviderEnvelopeV1 {
  readonly productMeaningProvider: ProductMeaningProviderV1;
}

export type ProductMeaningProviderValidation =
  | { readonly ok: true; readonly provider: ProductMeaningProviderV1 }
  | {
      readonly ok: false;
      readonly code: 'PROVIDER_CONTRACT_INVALID' | 'PROVIDER_INCOMPATIBLE';
      readonly detail: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFunction(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === 'function';
}

/**
 * Validates one candidate provider export against the exact contract. It fails
 * closed: a missing function, an unknown contract schema, or a foreign meaning
 * profile is rejected rather than coerced. No fallback implementation exists.
 */
export function validateProductMeaningProvider(
  candidate: unknown,
): ProductMeaningProviderValidation {
  if (!isRecord(candidate)) {
    return {
      ok: false,
      code: 'PROVIDER_CONTRACT_INVALID',
      detail: 'The product meaning provider export is not an object.',
    };
  }

  const schemaVersion = candidate.schemaVersion;
  if (!Number.isInteger(schemaVersion)) {
    return {
      ok: false,
      code: 'PROVIDER_CONTRACT_INVALID',
      detail: 'The product meaning provider declares no integer `schemaVersion`.',
    };
  }
  if (schemaVersion !== PRODUCT_MEANING_PROVIDER_SCHEMA_VERSION) {
    return {
      ok: false,
      code: 'PROVIDER_INCOMPATIBLE',
      detail: `The product meaning provider declares contract schema ${String(schemaVersion)}; this toolkit requires ${PRODUCT_MEANING_PROVIDER_SCHEMA_VERSION}.`,
    };
  }

  if (candidate.profileId !== PRODUCT_MEANING_PROVIDER_PROFILE_ID) {
    return {
      ok: false,
      code: 'PROVIDER_INCOMPATIBLE',
      detail: `The product meaning provider declares profile ${JSON.stringify(candidate.profileId)}; this toolkit requires ${JSON.stringify(PRODUCT_MEANING_PROVIDER_PROFILE_ID)}.`,
    };
  }

  const requiredFunctions = [
    'normalizeArtworkProductMeaning',
    'canonicalizeNormalizedMeaning',
    'fingerprintNormalizedMeaning',
    'extractRawCrosswordSemanticPayload',
  ] as const;
  for (const name of requiredFunctions) {
    if (!isFunction(candidate[name])) {
      return {
        ok: false,
        code: 'PROVIDER_CONTRACT_INVALID',
        detail: `The product meaning provider is missing the required function \`${name}\`.`,
      };
    }
  }

  return { ok: true, provider: candidate as unknown as ProductMeaningProviderV1 };
}

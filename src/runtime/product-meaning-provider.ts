import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  PRODUCT_MEANING_PROVIDER_ENTRY_RELATIVE_PATH,
  PRODUCT_MEANING_PROVIDER_EXPORT_NAME,
  validateProductMeaningProvider,
  type ProductMeaningProviderV1,
} from '../contracts/product-meaning-provider';

/**
 * Scoped product-meaning provider loader (ADR 0118).
 *
 * The provider is read only from the explicit, caller-supplied `--app-root`.
 * Nothing here infers an adjacent checkout, consults the toolkit/skill location,
 * or falls back to a vendored/shimmed implementation. Every failure is a typed,
 * structured preflight refusal raised before allocation, process launch, browser
 * creation or evidence creation.
 */

export type ProductMeaningProviderFailureCode =
  | 'APP_ROOT_MISSING'
  | 'APP_ROOT_UNRESOLVED'
  | 'APP_ROOT_INVALID'
  | 'APP_ROOT_NOT_DIRECTORY'
  | 'PROVIDER_ENTRY_MISSING'
  | 'PROVIDER_LOAD_FAILED'
  | 'PROVIDER_CONTRACT_INVALID'
  | 'PROVIDER_INCOMPATIBLE';

export interface ProductMeaningProviderRef {
  /** Absolute, validated application root the provider was loaded from. */
  readonly appRoot: string;
  /** Absolute path of the loaded provider module. */
  readonly entryPath: string;
  /** The validated FE-owned provider. */
  readonly provider: ProductMeaningProviderV1;
}

export type ProductMeaningProviderResolution =
  | { readonly ok: true; readonly ref: ProductMeaningProviderRef }
  | {
      readonly ok: false;
      readonly code: ProductMeaningProviderFailureCode;
      readonly detail: string;
    };

export interface ResolvedAppRoot {
  readonly appRoot: string;
}

export type AppRootResolution =
  | { readonly ok: true; readonly appRoot: string }
  | { readonly ok: false; readonly code: ProductMeaningProviderFailureCode; readonly detail: string };

/**
 * Resolves and validates an explicit application root.
 *
 * The value must be a non-empty path that exists and is a directory, and it is
 * canonicalized with `realpathSync` so every downstream identity (allocation,
 * launch cwd, provider entry, cleanup authority) binds to the same real root.
 * A symlink is not an identity: it can be retargeted after allocation, so the
 * real path — never the lexical spelling — is the accepted root (ADR 0119).
 * If the real path cannot be established the root fails closed; there is no
 * fallback to the lexical path and no absolute path is echoed in the refusal.
 */
export function resolveAppRoot(appRoot: string | undefined): AppRootResolution {
  if (typeof appRoot !== 'string' || appRoot.trim().length === 0) {
    return {
      ok: false,
      code: 'APP_ROOT_MISSING',
      detail: 'An explicit non-empty `--app-root <path>` is required for Diagnostic preflight.',
    };
  }
  const absolute = path.resolve(appRoot.trim());
  if (!existsSync(absolute)) {
    return {
      ok: false,
      code: 'APP_ROOT_UNRESOLVED',
      detail: `The supplied --app-root does not exist: ${absolute}`,
    };
  }
  let canonical: string;
  try {
    canonical = realpathSync(absolute);
  } catch {
    return {
      ok: false,
      code: 'APP_ROOT_UNRESOLVED',
      detail: 'The supplied --app-root could not be resolved to a real directory.',
    };
  }
  if (canonical === path.parse(canonical).root) {
    return {
      ok: false,
      code: 'APP_ROOT_INVALID',
      detail: 'The filesystem root is not a valid application root.',
    };
  }
  let isDirectory = false;
  try {
    isDirectory = statSync(canonical).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    return {
      ok: false,
      code: 'APP_ROOT_NOT_DIRECTORY',
      detail: 'The supplied --app-root is not a directory.',
    };
  }
  return { ok: true, appRoot: canonical };
}

export function productMeaningProviderEntryPath(appRoot: string): string {
  return path.join(appRoot, ...PRODUCT_MEANING_PROVIDER_ENTRY_RELATIVE_PATH.split('/'));
}

/**
 * Loads and validates the FE-owned product-meaning provider from the explicit
 * application root. The dynamic import is deliberately the only module load of
 * the FE meaning implementation; it happens at preflight, never during or after
 * allocation.
 */
export async function loadProductMeaningProvider(
  appRoot: string | undefined,
): Promise<ProductMeaningProviderResolution> {
  const resolved = resolveAppRoot(appRoot);
  if (!resolved.ok) {
    return resolved;
  }

  const entryPath = productMeaningProviderEntryPath(resolved.appRoot);
  if (!existsSync(entryPath)) {
    return {
      ok: false,
      code: 'PROVIDER_ENTRY_MISSING',
      detail: `The application root does not expose the required product meaning provider at ${PRODUCT_MEANING_PROVIDER_ENTRY_RELATIVE_PATH}.`,
    };
  }

  let moduleNamespace: unknown;
  try {
    moduleNamespace = await import(pathToFileURL(entryPath).href);
  } catch (error) {
    return {
      ok: false,
      code: 'PROVIDER_LOAD_FAILED',
      detail: `The product meaning provider could not be loaded: ${(error as Error).message}`,
    };
  }

  const candidate = (moduleNamespace as Record<string, unknown> | null)?.[
    PRODUCT_MEANING_PROVIDER_EXPORT_NAME
  ];
  const validated = validateProductMeaningProvider(candidate);
  if (!validated.ok) {
    return validated;
  }

  return {
    ok: true,
    ref: { appRoot: resolved.appRoot, entryPath, provider: validated.provider },
  };
}

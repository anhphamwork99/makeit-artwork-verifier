import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  CROSSWORD_GENERATOR_SOURCE_PATH,
  CROSSWORD_STORE_SOURCE_PATH,
  validateCrosswordSourceContract,
} from '../contracts/crossword';

/**
 * Generated-Crossword product-source reader (ADR 0017 R4 / ADR 0118).
 *
 * The accepted Crossword source contract is a property of the FE application
 * checkout, never of the toolkit repository or the process working directory.
 * Both planning and the runtime executor therefore read the exact same two
 * absolute files under one explicit, validated application root:
 *
 * - {@link crosswordSourcePaths} resolves the absolute files for one root;
 * - {@link readCrosswordSourceContract} reads and validates them there;
 * - {@link readLegacyCrosswordSourceContractFromCwd} is the explicit legacy
 *   seam for callers that predate the explicit app root. It resolves the same
 *   repository-relative constants against the process working directory and is
 *   never used by the public Diagnostic path.
 *
 * The fingerprint is computed by `validateCrosswordSourceContract` over source
 * content only, so binding to the app root changes which files are read without
 * changing the accepted fingerprint semantics.
 */

export interface CrosswordSourcePaths {
  /** Absolute product store source that owns the initial seed. */
  readonly storeSourcePath: string;
  /** Absolute product generator source that owns the layout boundary. */
  readonly generatorSourcePath: string;
}

export type CrosswordSourceReadResult =
  | { readonly ok: true; readonly fingerprint: string }
  | { readonly ok: false; readonly detail: string };

/**
 * Resolves the two exact absolute product-source files for one explicit app
 * root. The root is resolved to an absolute path so every reader — planning and
 * the runtime recheck — binds to the same files regardless of `process.cwd()`.
 */
export function crosswordSourcePaths(appRoot: string): CrosswordSourcePaths {
  const absoluteRoot = path.resolve(appRoot.trim());
  return {
    storeSourcePath: path.join(absoluteRoot, ...CROSSWORD_STORE_SOURCE_PATH.split('/')),
    generatorSourcePath: path.join(absoluteRoot, ...CROSSWORD_GENERATOR_SOURCE_PATH.split('/')),
  };
}

function readCrosswordSourcePaths(paths: CrosswordSourcePaths): CrosswordSourceReadResult {
  try {
    const source = validateCrosswordSourceContract({
      storeSource: readFileSync(paths.storeSourcePath, 'utf8'),
      generatorSource: readFileSync(paths.generatorSourcePath, 'utf8'),
    });
    if (!source.ok) {
      return {
        ok: false,
        detail: source.findings.map((finding) => finding.detail).join('; '),
      };
    }
    return { ok: true, fingerprint: source.fingerprint };
  } catch (error) {
    return {
      ok: false,
      detail: `The generated-Crossword product source could not be read: ${(error as Error).message}`,
    };
  }
}

/**
 * Reads and validates the generated-Crossword product source at one explicit,
 * caller-supplied application root. Nothing here consults `process.cwd()` or
 * the toolkit/skill location, and there is no fallback to a vendored copy. A
 * missing or malformed root fails closed as an unreadable source rather than
 * throwing.
 */
export function readCrosswordSourceContract(appRoot: string): CrosswordSourceReadResult {
  if (typeof appRoot !== 'string' || appRoot.trim().length === 0) {
    return {
      ok: false,
      detail:
        'The generated-Crossword product source could not be read: no explicit application root was supplied.',
    };
  }
  return readCrosswordSourcePaths(crosswordSourcePaths(appRoot));
}

/**
 * Legacy cwd-relative read retained only for pre-app-root callers and focused
 * tests. It resolves the repository-relative constants against `process.cwd()`
 * and is deliberately named so the public Diagnostic path cannot reach it by
 * accident.
 */
export function readLegacyCrosswordSourceContractFromCwd(): CrosswordSourceReadResult {
  return readCrosswordSourcePaths({
    storeSourcePath: CROSSWORD_STORE_SOURCE_PATH,
    generatorSourcePath: CROSSWORD_GENERATOR_SOURCE_PATH,
  });
}

import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import { resolveToolkitRoot } from './paths';

/**
 * Adapter-selectable evidence root (ADR 0119; private extraction plan WP3).
 *
 * The standalone toolkit writes its durable evidence under its own bundled
 * skill directory by default. When the toolkit is consumed as a dependency by
 * the FE application (a checkout of `node_modules/`), that default is not
 * durable: the package directory is regenerated on install. A thin FE adapter
 * wrapper may therefore set one explicit, optional environment variable to an
 * existing directory the application owns:
 *
 *   MAKEIT_ARTWORK_EVIDENCE_ROOT=<absolute path to an existing evidence base>
 *
 * The environment is **adapter-owned**. It is not a normal CLI requirement and
 * an operator running the toolkit directly should never need to set it: with the
 * variable unset the toolkit behaves exactly as before. The value names the
 * evidence *base* directory that contains the `runs/` and `suites/`
 * subdirectories, so it affects the Diagnostic run root, the Diagnostic suite
 * aggregation root, and `evidence verify` reading consistently.
 *
 * Structural validation/canonicalization is enforced before any evidence is
 * read or written:
 *
 *  - the value must be a non-blank absolute path;
 *  - it must be lexically normalized (no `..`/`.` traversal, no trailing slash);
 *  - it must not be the filesystem root;
 *  - it must be an existing directory whose canonical `realpath` equals the
 *    supplied value, so neither the directory nor any ancestor may be a
 *    symbolic link (a symlink can be retargeted between write and verify);
 *  - the same resolved value is used for allocation, cleanup ownership
 *    comparison, suite aggregation, and evidence verification, so a mismatched
 *    value can never redirect a delete, adopt another root, or report a false
 *    PASS.
 *
 * Absolute paths never enter public output: every public record/envelope
 * projection is relative to the evidence base or redacted.
 */

/** The single explicit, optional, adapter-owned evidence base environment name. */
export const EVIDENCE_ROOT_ENV = 'MAKEIT_ARTWORK_EVIDENCE_ROOT';

/** Subdirectory names under the evidence base. */
export const EVIDENCE_RUNS_DIR_NAME = 'runs';
export const EVIDENCE_SUITES_DIR_NAME = 'suites';

export type EvidenceRootOrigin = 'default' | 'environment';

export interface ResolvedEvidenceRoot {
  /** Absolute evidence base directory containing the `runs/`/`suites/` subdirectories. */
  readonly baseDir: string;
  /** `default` when the toolkit skill evidence directory is used, else `environment`. */
  readonly origin: EvidenceRootOrigin;
}

export type EvidenceRootResolution =
  | ({ readonly ok: true } & ResolvedEvidenceRoot)
  | { readonly ok: false; readonly problem: string };

/** The toolkit-owned default evidence base: `<skill root>/evidence`. */
export function defaultEvidenceBaseDir(): string {
  return path.join(resolveToolkitRoot(), 'evidence');
}

/**
 * Structural validation/canonicalization of an explicit adapter-supplied
 * evidence base. Returns a fixed, non-sensitive problem string (never echoing
 * the raw value) for the first structural failure, or `null` when acceptable.
 */
export function explicitEvidenceRootProblem(value: string): string | null {
  if (value.trim().length === 0) {
    return `${EVIDENCE_ROOT_ENV} must not be blank when it is set.`;
  }
  if (!path.isAbsolute(value)) {
    return `${EVIDENCE_ROOT_ENV} must be an absolute path to an existing directory.`;
  }
  if (path.normalize(value) !== value) {
    return `${EVIDENCE_ROOT_ENV} must be a lexically normalized absolute path (no "." or ".." segments).`;
  }
  if (value === path.parse(value).root) {
    return `${EVIDENCE_ROOT_ENV} must not be the filesystem root.`;
  }
  let canonical: string;
  try {
    canonical = realpathSync(value);
  } catch {
    return `${EVIDENCE_ROOT_ENV} must be an existing, readable directory.`;
  }
  if (canonical !== value) {
    return `${EVIDENCE_ROOT_ENV} must not resolve through a symbolic link.`;
  }
  let isDirectory = false;
  try {
    isDirectory = existsSync(value) && statSync(value).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    return `${EVIDENCE_ROOT_ENV} must be an existing directory.`;
  }
  return null;
}

/**
 * Resolve the evidence base for this process. The environment is only read when
 * the variable is set; an unset variable preserves the toolkit default exactly.
 * A set-but-invalid value is a fail-closed refusal, never a silent fallback.
 */
export function resolveEvidenceRoot(
  env: Readonly<Record<string, string | undefined>> = process.env,
): EvidenceRootResolution {
  const raw = env[EVIDENCE_ROOT_ENV];
  if (raw === undefined) {
    return { ok: true, baseDir: defaultEvidenceBaseDir(), origin: 'default' };
  }
  const problem = explicitEvidenceRootProblem(raw);
  if (problem !== null) return { ok: false, problem };
  return { ok: true, baseDir: raw, origin: 'environment' };
}

/**
 * The evidence base directory for path derivation and ownership comparison.
 *
 * A configured but invalid value falls back to the toolkit default *only* for
 * the boolean/comparison derivations (`evidenceRootFor` inside ownership
 * verification). Every write/read boundary refuses an invalid value explicitly
 * before touching evidence, so this fallback can never be used to write into the
 * wrong root.
 */
export function evidenceBaseDir(
  resolution: EvidenceRootResolution = resolveEvidenceRoot(),
): string {
  return resolution.ok ? resolution.baseDir : defaultEvidenceBaseDir();
}

/** Absolute run evidence root for one run id under an explicit base. */
export function evidenceRunRoot(baseDir: string, runId: string): string {
  return path.join(baseDir, EVIDENCE_RUNS_DIR_NAME, runId);
}

/** Absolute suite aggregation root for one suite execution id under an explicit base. */
export function evidenceSuiteRoot(baseDir: string, suiteExecutionId: string): string {
  return path.join(baseDir, EVIDENCE_SUITES_DIR_NAME, suiteExecutionId);
}

/** Relative, public-safe projection of a run evidence root (never absolute). */
export function evidenceRunRootRelativePath(runId: string): string {
  return `${EVIDENCE_RUNS_DIR_NAME}/${runId}`;
}

/** Relative, public-safe projection of a suite aggregation root (never absolute). */
export function evidenceSuiteRootRelativePath(suiteExecutionId: string): string {
  return `${EVIDENCE_SUITES_DIR_NAME}/${suiteExecutionId}/suite-record.json`;
}

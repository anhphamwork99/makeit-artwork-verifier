import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Toolkit/application path resolution shared by the owned-runtime modules.
 *
 * Under Node ESM (the CLI and the launch/cleanup runtime) `import.meta.url` is a
 * file URL, so the toolkit root is resolved from this module. Under a
 * browser-like test environment it is not, so the current working directory is
 * the explicit toolkit root used by the test configuration.
 */

const SKILL_ROOT_RELATIVE_PATH = path.join('.pi', 'skills', 'verify-artwork-editor');

export function resolveToolkitRoot(): string {
  const moduleUrl = import.meta.url;
  if (typeof moduleUrl === 'string' && moduleUrl.startsWith('file:')) {
    return path.resolve(fileURLToPath(new URL('../../', moduleUrl)));
  }
  return path.resolve(process.cwd());
}

/** Agent-facing Pi skill root; executable source and data do not live here. */
export function resolveSkillRoot(): string {
  return path.join(resolveToolkitRoot(), SKILL_ROOT_RELATIVE_PATH);
}

export function resolveRepoRoot(): string {
  return resolveToolkitRoot();
}

/** Repo-relative owned Next output namespace (specification 10). */
export const VERIFY_DIST_DIR_ROOT = '.next/verify-runs';

export const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isSafeRunId(value: unknown): value is string {
  return typeof value === 'string' && RUN_ID_PATTERN.test(value) && value !== '.' && value !== '..';
}

export function repoRelativeDistDir(runId: string): string {
  return `${VERIFY_DIST_DIR_ROOT}/${runId}`;
}

/**
 * The closed public `skill-root` role value, derived independently of any
 * application root.
 *
 * The agent skill remains at
 * `<toolkit repository root>/.pi/skills/verify-artwork-editor` even though the
 * executable package source and data now live at the toolkit root. Deriving
 * this from an explicit application `repoRoot` would leak a traversal for an
 * app-root run and fail the closed public projection.
 */
export function toolkitRelativeSkillRoot(skillRoot: string): string {
  const toolkitRepositoryRoot = path.resolve(skillRoot, '..', '..', '..');
  return path.relative(toolkitRepositoryRoot, skillRoot).split(path.sep).join('/');
}

/**
 * Structural safety of a recorded owned-repository (application) root.
 *
 * The app root is an attacker-influenceable value read back from writable
 * scratch state, so ownership verification accepts only an absolute,
 * lexically-normalized path that is neither the filesystem root nor an empty
 * value, is an existing directory, and is already its own canonical path
 * (`realpathSync(value) === value`). A symlink (or any path through one) can be
 * retargeted after allocation, so it is not a stable identity and fails closed
 * (ADR 0119). The value is always supplied explicitly by the caller/allocation;
 * it is never a mutable global, an environment default, or inferred from the
 * toolkit location.
 */
export function isVerifiableRepositoryRoot(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (!path.isAbsolute(value)) return false;
  if (path.normalize(value) !== value) return false;
  if (value === path.parse(value).root) return false;
  let canonical: string;
  try {
    canonical = realpathSync(value);
  } catch {
    return false;
  }
  if (canonical !== value) return false;
  let isDirectory = false;
  try {
    isDirectory = existsSync(value) && statSync(value).isDirectory();
  } catch {
    isDirectory = false;
  }
  return isDirectory;
}

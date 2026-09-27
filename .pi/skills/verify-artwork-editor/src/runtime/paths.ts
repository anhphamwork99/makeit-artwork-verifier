import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Repository-relative path resolution shared by the owned-runtime modules.
 *
 * Under Node ESM (the CLI and the launch/cleanup runtime) `import.meta.url` is a
 * file URL, so the toolkit and repository are resolved from this module. Under a
 * browser-like test environment it is not, so the repository-relative toolkit
 * path is used instead.
 */

const SKILL_ROOT_RELATIVE_PATH = path.join('.pi', 'skills', 'verify-artwork-editor');

export function resolveSkillRoot(): string {
  const moduleUrl = import.meta.url;
  if (typeof moduleUrl === 'string' && moduleUrl.startsWith('file:')) {
    return fileURLToPath(new URL('../../', moduleUrl));
  }
  return path.resolve(process.cwd(), SKILL_ROOT_RELATIVE_PATH);
}

export function resolveRepoRoot(): string {
  return path.resolve(resolveSkillRoot(), '..', '..', '..');
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

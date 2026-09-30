#!/usr/bin/env node
/**
 * Repeatable transfer / inventory guard for the private standalone toolkit.
 *
 * The WP1 transfer boundary is an explicit allowlist plus a small set of
 * authorized WP2 additions. This guard re-checks that boundary without a
 * network call and without Git:
 *
 *   1. Ignore-rule self-check — the `.gitignore` must exclude machine-local
 *      planning/provenance while keeping the repository-owned maintenance
 *      Project Home trackable, and must exclude evidence, dependencies,
 *      credentials, and generated caches.
 *   2. Exclusion check — no forbidden path may enter the would-be-tracked
 *      inventory. The only `.planning/` exception is the explicit maintenance
 *      Project Home allowlist.
 *   3. File-set / provenance check — every would-be-tracked file is either part
 *      of the WP1 manifest (pristine or intentionally edited) or an authorized
 *      WP2 addition. An unaccounted file is a hard failure.
 *   4. Secret heuristic — added/edited files are scanned for high-confidence
 *      secret signatures; home-path/email sentinels are warnings only.
 *
 * Intentional edits to allowlisted files are reported (so a reviewer can see
 * them) but never fail the guard: WP2 deliberately edits source and docs.
 *
 * Usage:
 *   node scripts/verify-transfer.mjs [--root <dir>] [--json] [--strict]
 *
 * Exit codes: 0 clean, 1 boundary violation, 2 usage error.
 */

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '..');

const SKILL_RELATIVE = 'agents/verify-artwork-editor';
const MAINTENANCE_PROJECT_RELATIVE = '.planning/maintain-verification-skills';
const COMPATIBILITY_SKILL_RELATIVE = '.agents/skills/verify-artwork-editor';
const COMPATIBILITY_SKILL_TARGET = '../../agents/verify-artwork-editor';
const MANIFEST_RELATIVE = 'provenance/source-manifest.sha256';

const MANIFEST_RELOCATIONS = new Map([
  ['features/README.md', 'docs/features/README.md'],
  ['features/layer-selection-transform.md', 'docs/features/layer-selection-transform.md'],
  ['features/layout-management.md', 'docs/features/layout-management.md'],
  ['features/multi-selection-grouping.md', 'docs/features/multi-selection-grouping.md'],
  ['features/text-layer-creation.md', 'docs/features/text-layer-creation.md'],
  ['features/undo-redo-persistence.md', 'docs/features/undo-redo-persistence.md'],
  ['references/test-case-contract.md', 'docs/archive/legacy-test-case-contract.md'],
  ['scripts/drive-case.mjs', 'docs/archive/legacy/drive-case.mjs'],
  ['scripts/verify_artwork.py', 'docs/archive/legacy/verify_artwork.py'],
]);

const RETIRED_MANIFEST_PATHS = new Set(['tsconfig.json']);

/** Paths that must never be part of the transferred inventory. */
const FORBIDDEN_PATH_SEGMENTS = new Set([
  '.planning',
  'node_modules',
  '.pnpm-store',
  '.next',
  '.turbo',
  '.cache',
  '.vitest',
  'node_modules',
  'playwright-report',
  'test-results',
]);

/** Forbidden basenames / extensions checked across the whole inventory. */
const FORBIDDEN_NAME_PATTERNS = [
  /^\.env(\.|$)/,
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /\.pfx$/,
  /(^|[-_.])credentials?([-_.]|$)/i,
  /(^|[-_.])secrets?([-_.]|$)/i,
  /^id_rsa/,
];

/**
 * Authorized WP2 additions at the repository root (repo-relative). A trailing
 * slash authorizes every file under that directory.
 */
const AUTHORIZED_ROOT_ADDITIONS = [
  '.gitignore',
  '.gitattributes',
  '.npmrc',
  'package.json',
  'pnpm-lock.yaml',
  'tsconfig.portable.json',
  'vitest.config.ts',
  'vitest.browser.config.ts',
  'vitest.portable.config.ts',
  'vitest.fe-hosted.config.ts',
  'bin/',
  'scripts/',
  'provenance/',
  'docs/',
  'integrations/',
  'agents/',
  '.agents/',
  '.planning/maintain-verification-skills/',
  'AGENTS.md',
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
];

/**
 * Authorized WP2 additions inside the toolkit skill tree (skill-relative).
 * A trailing slash authorizes every file under that path.
 */
const AUTHORIZED_SKILL_ADDITIONS = [
  'src/contracts/host-compatibility.ts',
  'src/contracts/product-meaning-provider.ts',
  'src/cli/host.ts',
  'src/runtime/crossword-source.ts',
  'src/runtime/product-meaning-provider.ts',
  'src/runtime/evidence-root.ts',
  'src/browser/browser-unavailable.ts',
  'src/runtime/local-diagnostics.ts',
  'tests/foundation/browser-unavailable-outcome.test.ts',
  'tests/foundation/browser-unavailable.test.ts',
  'tests/foundation/host-compatibility.test.ts',
  'src/version.ts',
  'tests/portable/contract.test.ts',
  'tests/portable/crossword-source-root.test.ts',
  'tests/portable/evidence-root.test.ts',
  'tests/portable/refusal.test.ts',
  'tests/portable/fixtures/',
  'tests/portable/package-root-layout.test.ts',
  'tests/portable/package-install-provenance.test.ts',
];

/** Ignore-rule self-check: representative paths and the rule that must hide each. */
const IGNORE_SELF_CHECK = [
  ['.planning/source-manifest.sha256', 'planning inventory'],
  ['.planning/maintain-verification-skills/PROJECT.md', null],
  ['evidence/runs/example/run-record.json', 'top-level evidence'],
  ['node_modules/vitest/index.js', 'dependencies'],
  ['.env', 'environment file'],
  ['.env.local', 'environment file variant'],
  ['local.pem', 'private key material'],
  ['.next/verify-runs/x/dist.json', 'next build output'],
  ['src/evidence/private-snapshot.ts', null], // must NOT be ignored
  ['src/coverage/models.ts', null], // must NOT be ignored
];

/** High-confidence secret signatures. Kept as fragments so this file never matches itself. */
const HIGH_CONFIDENCE_SECRETS = [
  new RegExp('-----BEGIN [A-Z ]*' + 'PRIVATE KEY-----'),
  new RegExp('\\bAKIA' + '[0-9A-Z]{16}\\b'),
  new RegExp('\\bghp_' + '[A-Za-z0-9]{36}\\b'),
  new RegExp('\\bsk-' + '[A-Za-z0-9]{24,}\\b'),
];

const HOME_PATH_REGEX = /(?:^|[^A-Za-z0-9._-])\/(?:Users|home)\/([A-Za-z0-9._-]+)/;

/** Synthetic placeholder user segments used by redaction fixtures. */
const PLACEHOLDER_HOME_USERS = new Set([
  'example',
  'example-user',
  'example_user',
  'exampleuser',
  'private',
  'secret',
  'someone',
  'user',
  'username',
  'owner',
  'test',
  'x',
]);

/**
 * Compile one gitignore-style rule into a matcher description.
 * Returns null for blank/comment lines.
 */
function parseIgnoreRule(rawLine) {
  let line = rawLine.replace(/\r$/, '');
  if (line.trim() === '' || line.startsWith('#')) return null;
  let negated = false;
  if (line.startsWith('!')) {
    negated = true;
    line = line.slice(1);
  }
  line = line.replace(/\s+$/, '');
  if (line === '') return null;
  const dirOnly = line.endsWith('/');
  if (dirOnly) line = line.slice(0, -1);
  const anchored = line.includes('/');
  if (line.startsWith('/')) line = line.slice(1);
  const segments = line.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) return null;
  return { negated, dirOnly, anchored, segments };
}

function segmentToRegExp(segment) {
  let source = '';
  for (const char of segment) {
    if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

function matchSegments(ruleSegments, candidateSegments, anchored) {
  if (anchored) {
    if (ruleSegments.length !== candidateSegments.length) return false;
    return ruleSegments.every((segment, index) => segmentToRegExp(segment).test(candidateSegments[index]));
  }
  const maxStart = candidateSegments.length - ruleSegments.length;
  for (let start = 0; start <= maxStart; start += 1) {
    const matched = ruleSegments.every((segment, offset) =>
      segmentToRegExp(segment).test(candidateSegments[start + offset]),
    );
    if (matched) return true;
  }
  return false;
}

function ruleMatches(rule, segments) {
  if (rule.dirOnly) {
    for (let depth = 1; depth <= segments.length; depth += 1) {
      if (matchSegments(rule.segments, segments.slice(0, depth), rule.anchored)) return true;
    }
    return false;
  }
  return matchSegments(rule.segments, segments, rule.anchored);
}

function buildIgnoreMatcher(gitignoreSource) {
  const rules = gitignoreSource
    .split('\n')
    .map(parseIgnoreRule)
    .filter((rule) => rule !== null);
  return (relativePath) => {
    const segments = relativePath.split('/').filter((segment) => segment !== '');
    let ignored = false;
    for (const rule of rules) {
      if (ruleMatches(rule, segments)) ignored = !rule.negated;
    }
    return ignored;
  };
}

function listFiles(root) {
  const files = [];
  const walk = (relativeDir) => {
    const absoluteDir = relativeDir === '' ? root : path.join(root, relativeDir);
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      if (relativeDir === '' && entry.name === '.git') continue;
      const relative = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) walk(relative);
      else if (entry.isFile() || entry.isSymbolicLink()) files.push(relative);
    }
  };
  walk('');
  return files.sort();
}

function sha256File(absolutePath) {
  return createHash('sha256').update(readFileSync(absolutePath)).digest('hex');
}

function readManifest(root) {
  const manifestPath = path.join(root, MANIFEST_RELATIVE);
  if (!existsSync(manifestPath)) return null;
  const source = readFileSync(manifestPath);
  const entries = new Map();
  for (const line of source.toString('utf8').split('\n')) {
    const trimmed = line.replace(/\r$/, '');
    if (trimmed.trim() === '') continue;
    const separator = trimmed.indexOf('  ');
    if (separator === -1) continue;
    entries.set(trimmed.slice(separator + 2), trimmed.slice(0, separator));
  }
  return { entries, digest: createHash('sha256').update(source).digest('hex') };
}

function isAllowedMaintenanceProjectPath(relativePath) {
  return (
    relativePath === MAINTENANCE_PROJECT_RELATIVE ||
    relativePath.startsWith(`${MAINTENANCE_PROJECT_RELATIVE}/`)
  );
}

function isAuthorized(relativePath, authorized) {
  return authorized.some((entry) =>
    entry.endsWith('/')
      ? relativePath === entry.slice(0, -1) || relativePath.startsWith(entry)
      : relativePath === entry,
  );
}

function firstMatch(line, patterns) {
  return patterns.find((pattern) => pattern.test(line));
}

function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT, json: false, strict: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--root') {
      index += 1;
      if (argv[index] === undefined) return { error: '`--root` requires a path.' };
      options.root = path.resolve(argv[index]);
    } else if (token === '--json') options.json = true;
    else if (token === '--strict') options.strict = true;
    else if (token === '--help' || token === '-h') options.help = true;
    else return { error: `Unknown argument: ${token}` };
  }
  return { options };
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    process.stderr.write(`${parsed.error}\n`);
    process.exit(2);
  }
  const { options } = parsed;
  if (options.help) {
    process.stdout.write(
      'Usage: node scripts/verify-transfer.mjs [--root <dir>] [--json] [--strict]\n',
    );
    process.exit(0);
  }

  const root = options.root;
  const violations = [];
  const warnings = [];

  const gitignorePath = path.join(root, '.gitignore');
  if (!existsSync(gitignorePath)) {
    violations.push('Missing .gitignore at repository root.');
  }
  const isIgnored = existsSync(gitignorePath)
    ? buildIgnoreMatcher(readFileSync(gitignorePath, 'utf8'))
    : () => false;

  // 1. Ignore-rule self-check: exclusions must hide real, sensitive paths and
  //    must not accidentally hide product-owned source directories.
  for (const [candidate, expectedIgnored] of IGNORE_SELF_CHECK) {
    if (expectedIgnored === null) {
      if (isIgnored(candidate)) {
        violations.push(`Ignore rule hides product-owned path that must stay tracked: ${candidate}`);
      }
      continue;
    }
    if (!isIgnored(candidate)) {
      violations.push(`Ignore rule does not exclude ${expectedIgnored}: ${candidate}`);
    }
  }

  const allFiles = listFiles(root);
  const inventory = allFiles.filter((relative) => !isIgnored(relative));

  const compatibilitySkillPath = path.join(root, COMPATIBILITY_SKILL_RELATIVE);
  if (!existsSync(compatibilitySkillPath)) {
    violations.push(`Missing cross-harness compatibility skill link: ${COMPATIBILITY_SKILL_RELATIVE}`);
  } else if (!lstatSync(compatibilitySkillPath).isSymbolicLink()) {
    violations.push(`Compatibility skill path must be a symlink: ${COMPATIBILITY_SKILL_RELATIVE}`);
  } else if (readlinkSync(compatibilitySkillPath) !== COMPATIBILITY_SKILL_TARGET) {
    violations.push(
      `Compatibility skill link must target ${COMPATIBILITY_SKILL_TARGET}: ${COMPATIBILITY_SKILL_RELATIVE}`,
    );
  }

  // 2. Exclusion check over the would-be-tracked inventory.
  for (const relative of inventory) {
    const segments = relative.split('/');
    const forbiddenSegment = segments.find((segment) => FORBIDDEN_PATH_SEGMENTS.has(segment));
    if (forbiddenSegment !== undefined && !isAllowedMaintenanceProjectPath(relative)) {
      violations.push(`Forbidden path segment "${forbiddenSegment}" would be tracked: ${relative}`);
    }
    const name = path.posix.basename(relative);
    const nameMatch = firstMatch(name, FORBIDDEN_NAME_PATTERNS);
    if (nameMatch !== undefined) {
      violations.push(`Forbidden file name would be tracked: ${relative}`);
    }
    if (relative.startsWith(`${SKILL_RELATIVE}/evidence/`)) {
      violations.push(`Evidence file would be tracked: ${relative}`);
    }
  }

  // 3. File-set / provenance check.
  const manifest = readManifest(root);
  const pristine = [];
  const edited = [];
  const added = [];

  if (manifest === null) {
    warnings.push(
      `Provenance manifest ${MANIFEST_RELATIVE} is absent; skipping SHA-256 comparison. ` +
        'Run this guard where the WP1 planning artifacts exist.',
    );
  }

  for (const relative of inventory) {
    const skillRelative = relative.startsWith(`${SKILL_RELATIVE}/`)
      ? relative.slice(SKILL_RELATIVE.length + 1)
      : null;
    const manifestKey = manifest?.entries.has(relative)
      ? relative
      : skillRelative !== null && manifest?.entries.has(skillRelative)
        ? skillRelative
        : null;
    if (manifest !== null && manifestKey !== null) {
      const expected = manifest.entries.get(manifestKey);
      const actual = sha256File(path.join(root, relative));
      if (actual === expected) pristine.push(relative);
      else edited.push(relative);
      continue;
    }
    if (
      isAuthorized(relative, AUTHORIZED_ROOT_ADDITIONS) ||
      isAuthorized(relative, AUTHORIZED_SKILL_ADDITIONS)
    ) {
      added.push(relative);
    } else {
      violations.push(`Unaccounted repository file is not in the source manifest or authorized additions: ${relative}`);
    }
  }

  if (manifest !== null) {
    const presentFiles = new Set(inventory);
    const presentSkillFiles = new Set(
      inventory
        .filter((relative) => relative.startsWith(`${SKILL_RELATIVE}/`))
        .map((relative) => relative.slice(SKILL_RELATIVE.length + 1)),
    );
    for (const manifestPath of manifest.entries.keys()) {
      const relocatedPath = MANIFEST_RELOCATIONS.get(manifestPath);
      if (
        !presentFiles.has(manifestPath) &&
        !presentSkillFiles.has(manifestPath) &&
        (relocatedPath === undefined || !presentFiles.has(relocatedPath)) &&
        !RETIRED_MANIFEST_PATHS.has(manifestPath)
      ) {
        violations.push(`Allowlisted source file is missing from the transfer: ${manifestPath}`);
      }
    }
  }

  // 4. Secret heuristic on new/changed material only. Allowlisted content was
  //    already reviewed in WP1; this catches material introduced by WP2.
  const scrutinized = [...edited, ...added].filter((relative) => !relative.startsWith('tests/'));
  for (const relative of scrutinized) {
    const absolute = path.join(root, relative);
    let source;
    try {
      source = readFileSync(absolute, 'utf8');
    } catch {
      continue; // binary fixture; name rules already covered it
    }
    const lines = source.split('\n');
    for (const [index, line] of lines.entries()) {
      if (firstMatch(line, HIGH_CONFIDENCE_SECRETS) !== undefined) {
        violations.push(`High-confidence secret signature at ${relative}:${index + 1}`);
      }
      const homeMatch = HOME_PATH_REGEX.exec(line);
      if (homeMatch !== null && !PLACEHOLDER_HOME_USERS.has(homeMatch[1])) {
        warnings.push(`Non-placeholder absolute home path at ${relative}:${index + 1}`);
      }
    }
  }

  const summary = {
    root,
    manifest: manifest === null ? null : { path: MANIFEST_RELATIVE, digest: manifest.digest, entries: manifest.entries.size },
    inventoryFiles: inventory.length,
    pristine: pristine.length,
    edited: edited.length,
    added: added.length,
    editedFiles: edited,
    addedFiles: added,
    warnings,
    violations,
  };

  const failed = violations.length > 0 || (options.strict && warnings.length > 0);
  const status = failed ? 'FAIL' : 'PASS';

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ status, ...summary }, null, 2)}\n`);
  } else {
    process.stdout.write('verify-transfer — toolkit transfer/inventory guard\n');
    process.stdout.write(`root:            ${root}\n`);
    if (manifest === null) process.stdout.write('manifest:        absent (provenance comparison skipped)\n');
    else process.stdout.write(`manifest:        ${MANIFEST_RELATIVE} (${manifest.entries.size} entries, sha256 ${manifest.digest})\n`);
    process.stdout.write(`inventory files: ${inventory.length}\n`);
    process.stdout.write(`pristine (WP1):  ${pristine.length}\n`);
    process.stdout.write(`edited (WP2):    ${edited.length}\n`);
    process.stdout.write(`added (WP2):     ${added.length}\n`);
    if (edited.length > 0) {
      process.stdout.write('\nIntentionally edited allowlisted files (not a failure):\n');
      for (const relative of edited) process.stdout.write(`  ~ ${relative}\n`);
    }
    if (warnings.length > 0) {
      process.stdout.write('\nWarnings:\n');
      for (const warning of warnings) process.stdout.write(`  ! ${warning}\n`);
    }
    if (violations.length > 0) {
      process.stdout.write('\nViolations:\n');
      for (const violation of violations) process.stdout.write(`  x ${violation}\n`);
    }
    process.stdout.write(`\nRESULT: ${status}\n`);
  }

  process.exit(failed ? 1 : 0);
}

main();

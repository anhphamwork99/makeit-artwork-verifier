import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { canonicalize, sha256Hex } from '../canonical/canonicalize';
import { CatalogueLoadError, loadCatalogueBundle } from '../catalogue/load';
import { loadDiagnosticSuite, resolveSuiteRequests } from '../catalogue/suite';
import type { CliResult } from '../contracts/runtime';
import { DiagnosticSuiteValidationError } from '../contracts/suite';
import {
  generateExecutableSelectionManifest,
  validateExecutableSelectionManifest,
} from '../governance/executable-selection-manifest';
import { normalizeCaseRequest } from '../planner/normalize-intent';
import {
  EnvironmentCatalogueError,
  loadEnvironmentCatalogue,
  resolveEnvironmentCell,
} from '../runtime/environment';
import { resolveToolkitRoot } from '../runtime/paths';
import { buildCliResult, usageDiagnostic } from './output';

type ManifestContext = Parameters<typeof generateExecutableSelectionManifest>[0];
type Generation = ReturnType<typeof generateExecutableSelectionManifest>;
type Validation = ReturnType<typeof validateExecutableSelectionManifest>;

export interface ManifestCommandOptions {
  /** Owned test root; production always uses the repository toolkit root. */
  readonly skillRoot?: string;
  readonly loadContext?: () => ManifestContext;
}

export interface ManifestCommandDetails {
  readonly reportLabel: 'manifest-command.v1';
  readonly artifact: string | null;
  readonly generation: Generation | null;
  readonly validation: Validation | null;
  readonly failureCode: string | null;
  readonly releaseCredit: false;
}

const MAX_DRAFT_BYTES = 4 * 1024 * 1024;
const DRAFT_DIRECTORY = 'cases/selection-manifests/drafts';

class ManifestFileError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

type Invocation = { action: 'generate' } | { action: 'validate'; file: string };

/** Parse the untouched token vector; the shared parser collapses duplicates. */
function parseInvocation(argv: readonly string[]): Invocation | null {
  if (argv.length !== 3) return null;
  const [action, flag, value] = argv;
  if (!value || value.startsWith('--')) return null;
  if (action === 'generate' && flag === '--profile' && value === 'release') {
    return { action };
  }
  if (action === 'validate' && flag === '--manifest') return { action, file: value };
  return null;
}

function loadCurrentContext(root: string): ManifestContext {
  const environmentCatalogue = loadEnvironmentCatalogue({ rootDir: root });
  const requestTemplates = resolveSuiteRequests(
    loadDiagnosticSuite('representative', { rootDir: root }),
  ).map((member) => {
    const normalized = normalizeCaseRequest(member.request);
    if (!normalized.ok) throw new ManifestFileError('MANIFEST_TEMPLATE_INVALID');
    const { intent } = normalized.request;
    return {
      templateId: path.basename(member.relativePath, '.json'),
      subjectId: intent.subjectId,
      capability: intent.capability,
      scenarioId: intent.scenario,
      intent,
    };
  });
  return {
    catalogues: loadCatalogueBundle({ rootDir: root }),
    environmentCatalogue,
    requiredCell: resolveEnvironmentCell(environmentCatalogue),
    requestTemplates,
  };
}

function requireCanonicalDirectory(directory: string): void {
  if (realpathSync(directory) !== directory || !lstatSync(directory).isDirectory()) {
    throw new ManifestFileError('MANIFEST_UNSAFE_PATH');
  }
}

/** A regular, bounded, no-follow read; private paths never enter public errors. */
function readDraftBytes(file: string): string {
  const absolute = path.resolve(file);
  requireCanonicalDirectory(path.dirname(absolute));
  const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_DRAFT_BYTES || stat.nlink !== 1) {
      throw new ManifestFileError('MANIFEST_UNSAFE_FILE');
    }
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length !== stat.size) {
      throw new ManifestFileError('MANIFEST_CHANGED_DURING_READ');
    }
    const after = fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
      throw new ManifestFileError('MANIFEST_CHANGED_DURING_READ');
    }
    return bytes.subarray(0, length).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function persistDraft(root: string, draft: unknown): string {
  const bytes = `${canonicalize(draft)}\n`;
  if (Buffer.byteLength(bytes) > MAX_DRAFT_BYTES) {
    throw new ManifestFileError('MANIFEST_TOO_LARGE');
  }
  const canonicalRoot = path.resolve(root);
  requireCanonicalDirectory(canonicalRoot);
  let directory = canonicalRoot;
  for (const segment of DRAFT_DIRECTORY.split('/')) {
    directory = path.join(directory, segment);
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    requireCanonicalDirectory(directory);
  }
  const relative = `${DRAFT_DIRECTORY}/draft-${sha256Hex(bytes)}.json`;
  const file = path.join(canonicalRoot, relative);
  let fd: number;
  try {
    fd = openSync(
      file,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (readDraftBytes(file) !== bytes) throw new ManifestFileError('MANIFEST_ARTIFACT_COLLISION');
    return relative;
  }
  try {
    writeFileSync(fd, bytes, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return relative;
}

export function runManifestCommand(
  argv: readonly string[],
  options: ManifestCommandOptions = {},
): CliResult<ManifestCommandDetails> {
  const invocation = parseInvocation(argv);
  if (!invocation) {
    return buildCliResult({
      command: 'manifest',
      status: 'USAGE',
      detail:
        'Expected manifest generate --profile release or manifest validate --manifest <file>.',
      diagnostics: [usageDiagnostic('Invalid manifest command arguments.')],
    });
  }
  const details: ManifestCommandDetails = {
    reportLabel: 'manifest-command.v1',
    artifact: null,
    generation: null,
    validation: null,
    failureCode: null,
    releaseCredit: false,
  };
  try {
    const root = options.skillRoot ?? resolveToolkitRoot();
    const current = options.loadContext ? options.loadContext() : loadCurrentContext(root);
    if (invocation.action === 'generate') {
      const generation = generateExecutableSelectionManifest(current);
      if (generation.status !== 'GENERATED_DRAFT') {
        return buildCliResult({
          command: 'manifest',
          subcommand: invocation.action,
          status: 'HARNESS_BLOCKED',
          detail: 'Manifest generation refused; no executable draft was published.',
          details: { ...details, generation },
        });
      }
      const artifact = persistDraft(root, generation.draft);
      return buildCliResult({
        command: 'manifest',
        subcommand: invocation.action,
        status: 'PASS',
        detail: 'Generated an unapproved executable manifest draft; no Release credit.',
        details: { ...details, artifact, generation },
      });
    }
    let draft: unknown;
    try {
      draft = JSON.parse(readDraftBytes(invocation.file));
    } catch (error) {
      if (error instanceof SyntaxError) throw new ManifestFileError('MANIFEST_JSON_INVALID');
      throw error;
    }
    const validation = validateExecutableSelectionManifest(draft, current);
    return buildCliResult({
      command: 'manifest',
      subcommand: invocation.action,
      status: validation.valid ? 'PASS' : 'HARNESS_BLOCKED',
      detail: validation.valid
        ? 'Manifest draft matches current planning inputs; no approval or Release credit.'
        : 'Manifest draft validation refused.',
      details: { ...details, validation },
    });
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    const unsafe =
      error instanceof ManifestFileError ||
      error instanceof CatalogueLoadError ||
      error instanceof EnvironmentCatalogueError ||
      error instanceof DiagnosticSuiteValidationError ||
      code === 'ELOOP' ||
      code === 'ENOENT';
    return buildCliResult({
      command: 'manifest',
      subcommand: invocation.action,
      status: unsafe ? 'HARNESS_BLOCKED' : 'ENVIRONMENT_FAILURE',
      detail: 'Manifest operation refused; no approval or Release credit.',
      details: {
        ...details,
        failureCode:
          error instanceof ManifestFileError ? error.code : 'MANIFEST_INPUT_OR_IO_UNAVAILABLE',
      },
    });
  }
}

import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { loadCatalogueBundle } from '../../src/catalogue/load';
import { loadDiagnosticSuite, resolveSuiteRequests } from '../../src/catalogue/suite';
import * as manifestCli from '../../src/cli/manifest';
import { runCli } from '../../src/cli/main';
import { normalizeCaseRequest } from '../../src/planner/normalize-intent';
import { loadEnvironmentCatalogue, resolveEnvironmentCell } from '../../src/runtime/environment';

const { runManifestCommand } = manifestCli;
type LoadContext = NonNullable<
  NonNullable<Parameters<typeof runManifestCommand>[1]>['loadContext']
>;
let context: ReturnType<LoadContext>;
const roots: string[] = [];

function ownedRoot(): string {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'manifest-cli-test-')));
  roots.push(root);
  return root;
}

beforeAll(() => {
  const environmentCatalogue = loadEnvironmentCatalogue();
  context = {
    catalogues: loadCatalogueBundle(),
    environmentCatalogue,
    requiredCell: resolveEnvironmentCell(environmentCatalogue),
    requestTemplates: resolveSuiteRequests(loadDiagnosticSuite('representative')).map((member) => {
      const normalized = normalizeCaseRequest(member.request);
      if (!normalized.ok) throw new Error('Checked-in representative request must be valid');
      const { intent } = normalized.request;
      return {
        templateId: path.basename(member.relativePath, '.json'),
        subjectId: intent.subjectId,
        capability: intent.capability,
        scenarioId: intent.scenario,
        intent,
      };
    }),
  };
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function generate(root: string) {
  return runManifestCommand(['generate', '--profile', 'release'], {
    skillRoot: root,
    loadContext: () => context,
  });
}

function generatedFile(root: string): string {
  const result = generate(root);
  expect(result.status).toBe('PASS');
  expect(result.launchAttempted).toBe(false);
  expect(result.details?.releaseCredit).toBe(false);
  const relative = result.details?.artifact;
  if (!relative) throw new Error('Expected persisted draft');
  expect(path.isAbsolute(relative)).toBe(false);
  return path.join(root, relative);
}

describe('executable manifest CLI', () => {
  it.each([
    [],
    ['generate'],
    ['generate', '--profile', 'diagnostic'],
    ['generate', '--profile'],
    ['generate', '--profile=release'],
    ['generate', '--profile', 'release', '--profile', 'release'],
    ['generate', '--profile', 'release', '--unknown'],
    ['generate', '--profile', 'release', 'extra'],
    ['validate', '--manifest'],
    ['validate', '--manifest', '--profile'],
    ['validate', '--manifest', 'draft.json', '--manifest', 'other.json'],
    ['approve', '--manifest', 'draft.json'],
  ])('rejects malformed tokens before loading inputs: %j', (...tokens) => {
    const loadContext = vi.fn(() => context);
    const result = runManifestCommand(tokens, { loadContext });
    expect(result.status).toBe('USAGE');
    expect(result.exitCode).toBe(64);
    expect(result.launchAttempted).toBe(false);
    expect(loadContext).not.toHaveBeenCalled();
  });

  it('generates a real Release-planned draft, reads it back and preserves identical existing bytes', () => {
    const root = ownedRoot();
    const file = generatedFile(root);
    const before = readFileSync(file);
    const beforeStat = statSync(file);
    const draft = JSON.parse(before.toString('utf8'));
    expect(draft.state).toBe('GENERATED_DRAFT');
    expect(generatedFile(root)).toBe(file);
    expect(readFileSync(file)).toEqual(before);
    expect(statSync(file).mtimeMs).toBe(beforeStat.mtimeMs);
    const result = runManifestCommand(['validate', '--manifest', file], {
      loadContext: () => context,
    });
    expect(result.status).toBe('PASS');
    expect(result.details?.validation?.valid).toBe(true);
    expect(result.details?.releaseCredit).toBe(false);
    expect(JSON.stringify(result)).not.toContain(root);
  });

  it('validates through public CLI dispatch with a single structured result and no launch', async () => {
    const file = generatedFile(ownedRoot());
    const chunks: string[] = [];
    const code = await runCli(['manifest', 'validate', '--manifest', file], {
      stdout: (chunk) => chunks.push(chunk),
    });
    const result = JSON.parse(chunks.join(''));
    expect(code).toBe(0);
    expect(result.command).toBe('manifest');
    expect(result.status).toBe('PASS');
    expect(result.launchAttempted).toBe(false);
    expect(result.details.releaseCredit).toBe(false);
    expect(JSON.stringify(result)).not.toContain(file);
  });

  it('dispatches public generation to the real writer using an owned test root', async () => {
    const root = ownedRoot();
    const spy = vi
      .spyOn(manifestCli, 'runManifestCommand')
      .mockImplementation((argv) =>
        runManifestCommand(argv, { skillRoot: root, loadContext: () => context }),
      );
    try {
      const chunks: string[] = [];
      const code = await runCli(['manifest', 'generate', '--profile', 'release'], {
        stdout: (chunk) => chunks.push(chunk),
      });
      const result = JSON.parse(chunks.join(''));
      expect(code).toBe(0);
      expect(spy).toHaveBeenCalledWith(['generate', '--profile', 'release']);
      expect(result.status).toBe('PASS');
      expect(result.launchAttempted).toBe(false);
      expect(result.details.releaseCredit).toBe(false);
      const draft = JSON.parse(readFileSync(path.join(root, result.details.artifact), 'utf8'));
      expect(draft).toEqual(result.details.generation.draft);
      expect(JSON.stringify(result)).not.toContain(root);
    } finally {
      spy.mockRestore();
    }
  });

  it('retains a conflicting draft instead of overwriting it', () => {
    const root = ownedRoot();
    const file = generatedFile(root);
    writeFileSync(file, '{"corrupted":true}\n');
    const result = generate(root);
    expect(result.status).toBe('HARNESS_BLOCKED');
    expect(result.details?.failureCode).toBe('MANIFEST_ARTIFACT_COLLISION');
    expect(readFileSync(file, 'utf8')).toBe('{"corrupted":true}\n');
    const validation = runManifestCommand(['validate', '--manifest', file], {
      loadContext: () => context,
    });
    expect(validation.status).toBe('HARNESS_BLOCKED');
  });

  it('publishes no artifact when no selected case has a runnable template', () => {
    const root = ownedRoot();
    const result = runManifestCommand(['generate', '--profile', 'release'], {
      skillRoot: root,
      loadContext: () => ({ ...context, requestTemplates: [] }),
    });
    expect(result.status).toBe('HARNESS_BLOCKED');
    expect(result.details?.artifact).toBeNull();
    expect(result.details?.releaseCredit).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  it('refuses an existing output symlink without following or replacing it', () => {
    const root = ownedRoot();
    const file = generatedFile(root);
    const target = path.join(ownedRoot(), 'sentinel.json');
    writeFileSync(target, 'preserve sentinel');
    rmSync(file);
    symlinkSync(target, file);
    expect(generate(root).status).toBe('HARNESS_BLOCKED');
    expect(readFileSync(target, 'utf8')).toBe('preserve sentinel');
  });

  it('rejects draft edits and malformed JSON without approving or repairing either', () => {
    const file = generatedFile(ownedRoot());
    const draft = JSON.parse(readFileSync(file, 'utf8'));
    draft.contentFingerprint = '0'.repeat(64);
    writeFileSync(file, JSON.stringify(draft));
    expect(
      runManifestCommand(['validate', '--manifest', file], { loadContext: () => context }).status,
    ).toBe('HARNESS_BLOCKED');
    writeFileSync(file, '{');
    const invalid = runManifestCommand(['validate', '--manifest', file], {
      loadContext: () => context,
    });
    expect(invalid.status).toBe('HARNESS_BLOCKED');
    expect(invalid.details?.failureCode).toBe('MANIFEST_JSON_INVALID');
    expect(readFileSync(file, 'utf8')).toBe('{');
  });

  it('refuses symlinked draft directories and input leaves without touching their target', () => {
    const root = ownedRoot();
    const target = ownedRoot();
    symlinkSync(target, path.join(root, 'cases'), 'dir');
    expect(generate(root).status).toBe('HARNESS_BLOCKED');
    const sentinel = path.join(target, 'sentinel.json');
    writeFileSync(sentinel, '{"sentinel":true}');
    const alias = path.join(root, 'alias.json');
    symlinkSync(sentinel, alias);
    const result = runManifestCommand(['validate', '--manifest', alias], {
      loadContext: () => context,
    });
    expect(result.status).toBe('HARNESS_BLOCKED');
    expect(readFileSync(sentinel, 'utf8')).toBe('{"sentinel":true}');
  });

  it('reports missing input and oversized input without leaking paths', () => {
    const root = ownedRoot();
    const file = path.join(root, 'missing.json');
    const missing = runManifestCommand(['validate', '--manifest', file], {
      loadContext: () => context,
    });
    expect(missing.status).toBe('HARNESS_BLOCKED');
    expect(JSON.stringify(missing)).not.toContain(root);
    writeFileSync(file, ' '.repeat(4 * 1024 * 1024 + 1));
    const oversized = runManifestCommand(['validate', '--manifest', file], {
      loadContext: () => context,
    });
    expect(oversized.status).toBe('HARNESS_BLOCKED');
    expect(oversized.details?.failureCode).toBe('MANIFEST_UNSAFE_FILE');
  });

  it('reports external I/O failure through the standard environment status without raw errors', () => {
    const result = runManifestCommand(['generate', '--profile', 'release'], {
      loadContext: () => {
        throw new Error('private-path-and-secret');
      },
    });
    expect(result.status).toBe('ENVIRONMENT_FAILURE');
    expect(result.exitCode).toBe(2);
    expect(result.launchAttempted).toBe(false);
    expect(JSON.stringify(result)).not.toContain('private-path-and-secret');
  });
});

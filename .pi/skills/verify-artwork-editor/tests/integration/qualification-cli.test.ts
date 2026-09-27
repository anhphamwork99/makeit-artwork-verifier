import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { loadCatalogueBundle } from '../../src/catalogue/load';
import { loadDiagnosticSuite, resolveSuiteRequests } from '../../src/catalogue/suite';
import { buildCliResult } from '../../src/cli/output';
import {
  compilePreparedExecutionCandidate,
  type PreparedExecutionCandidate,
} from '../../src/cli/diagnostic';
import type { ExecutableManifestValidationContext } from '../../src/contracts/executable-selection-manifest';
import { normalizeCaseRequest } from '../../src/planner/normalize-intent';
import { generateExecutableSelectionManifest } from '../../src/governance/executable-selection-manifest';
import type {
  QualificationRuntimeDependencies,
  VerifiedChild,
} from '../../src/governance/qualification-runtime';
import { loadEnvironmentCatalogue, resolveEnvironmentCell } from '../../src/runtime/environment';
import { resolveSkillRoot } from '../../src/runtime/paths';
import { runCli } from '../../src/cli/main';

function context(): ExecutableManifestValidationContext {
  const root = resolveSkillRoot();
  const environmentCatalogue = loadEnvironmentCatalogue({ rootDir: root });
  const requestTemplates = resolveSuiteRequests(
    loadDiagnosticSuite('representative', { rootDir: root }),
  ).map((member) => {
    const normalized = normalizeCaseRequest(member.request);
    if (!normalized.ok) throw new Error('invalid representative request');
    return {
      templateId: path.basename(member.relativePath, '.json'),
      subjectId: normalized.request.intent.subjectId,
      capability: normalized.request.intent.capability,
      scenarioId: normalized.request.intent.scenario,
      intent: normalized.request.intent,
    };
  });
  return {
    catalogues: loadCatalogueBundle({ rootDir: root }),
    environmentCatalogue,
    requiredCell: resolveEnvironmentCell(environmentCatalogue),
    requestTemplates,
  };
}

function envelope(stdout: string): {
  status: string;
  command: string;
  details: Record<string, unknown>;
} {
  return JSON.parse(stdout) as {
    status: string;
    command: string;
    details: Record<string, unknown>;
  };
}

describe('qualify CLI dispatch', () => {
  it('dispatches prepare and one-shot run using an owned authority root', async () => {
    const fixtureRoot = realpathSync(
      mkdtempSync(path.join(realpathSync(tmpdir()), 'qualification-cli-')),
    );
    const skillRoot = path.join(fixtureRoot, 'skill');
    const fs = await import('node:fs/promises');
    await fs.mkdir(skillRoot);
    const candidateDir = path.join(skillRoot, 'cases', 'selection-manifests', 'drafts');
    await fs.mkdir(candidateDir, { recursive: true });
    const current = context();
    const generated = generateExecutableSelectionManifest(current);
    expect(generated.status).toBe('GENERATED_DRAFT');
    if (generated.status !== 'GENERATED_DRAFT') {
      rmSync(fixtureRoot, { recursive: true, force: true });
      return;
    }
    const candidatePath = path.join(candidateDir, 'draft.json');
    writeFileSync(candidatePath, JSON.stringify(generated.draft));
    const entryIds = generated.draft.content.entries.slice(0, 3).map((entry) => entry.entryId);
    const children = new Map<string, PreparedExecutionCandidate>();
    const dependencies: QualificationRuntimeDependencies = {
      skillRoot,
      repoRoot: process.cwd(),
      loadContext: () => current,
      compileCandidate: compilePreparedExecutionCandidate,
      runCandidate: async ({ preparedCandidate, runId }) => {
        children.set(runId, preparedCandidate);
        return buildCliResult({
          command: 'diagnostic',
          status: 'PASS',
          outcome: 'PASS',
          detail: 'pass',
          details: null,
        });
      },
      collectSourceDigest: () => 'd'.repeat(64),
      readAndVerifyChild: (runId): VerifiedChild => {
        const candidate = children.get(runId);
        if (!candidate)
          return {
            valid: false,
            recordDigest: null,
            outcome: null,
            cleanupVerified: false,
            evidenceVerified: false,
            code: 'CHILD_RECORD_INVALID',
          };
        return {
          valid: true,
          recordDigest: 'e'.repeat(64),
          outcome: 'PASS',
          cleanupVerified: true,
          evidenceVerified: true,
          code: null,
          runId,
          caseId: candidate.identity.caseId,
          materializationFingerprint: candidate.identity.materializationFingerprint,
          planFingerprint: candidate.identity.planFingerprint,
          cellId: candidate.identity.cellId,
          profile: 'release',
          provenance: 'manifest',
          evidenceDepth: 'standard',
        };
      },
      makeId: randomUUID,
    };
    let output = '';
    const qualification = {
      skillRoot,
      repoRoot: process.cwd(),
      loadContext: () => current,
      runtime: { dependencies },
    };
    try {
      const preparedCode = await runCli(
        [
          'qualify',
          'prepare',
          '--candidate',
          candidatePath,
          '--entry',
          entryIds[0] as string,
          '--entry',
          entryIds[1] as string,
          '--entry',
          entryIds[2] as string,
          '--rationale',
          'Three distinct entries provide fixed admission coverage.',
        ],
        {
          stdout: (chunk) => {
            output += chunk;
          },
          qualification,
        },
      );
      expect(preparedCode).toBe(0);
      const prepared = envelope(output);
      expect(prepared.command).toBe('qualify');
      expect(prepared.status).toBe('PASS');
      expect(prepared.details.state).toBe('PREDECLARED');
      const batchId = prepared.details.batchId as string;

      output = '';
      const runCode = await runCli(['qualify', 'run', '--batch', batchId], {
        stdout: (chunk) => {
          output += chunk;
        },
        qualification,
      });
      expect(runCode).toBe(0);
      const run = envelope(output);
      expect(run.status).toBe('PASS');
      expect(run.details.state).toBe('REVIEW_READY');
      expect(run.details.releaseCredit).toBe(false);
      expect(run.details.attempts as unknown[]).toHaveLength(3);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('reports a missing batch without creating qualification authority paths', async () => {
    const fixtureRoot = realpathSync(
      mkdtempSync(path.join(realpathSync(tmpdir()), 'qualification-cli-missing-')),
    );
    const skillRoot = path.join(fixtureRoot, 'skill');
    const fs = await import('node:fs/promises');
    await fs.mkdir(skillRoot);
    const dependencies: QualificationRuntimeDependencies = {
      skillRoot,
      repoRoot: fixtureRoot,
      loadContext: () => {
        throw new Error('A missing batch must not load a candidate context.');
      },
      compileCandidate: () => {
        throw new Error('A missing batch must not compile a candidate.');
      },
      runCandidate: async () => {
        throw new Error('A missing batch must not execute.');
      },
      collectSourceDigest: () => 'd'.repeat(64),
      readAndVerifyChild: () => {
        throw new Error('A missing batch cannot have children.');
      },
      makeId: randomUUID,
    };
    let output = '';
    try {
      const code = await runCli(['qualify', 'run', '--batch', `qbatch-${randomUUID()}`], {
        stdout: (chunk) => {
          output += chunk;
        },
        qualification: {
          skillRoot,
          repoRoot: fixtureRoot,
          runtime: { dependencies },
        },
      });

      expect(code).not.toBe(0);
      expect(envelope(output)).toMatchObject({
        command: 'qualify',
        status: 'HARNESS_BLOCKED',
      });
      expect(existsSync(path.join(skillRoot, 'evidence'))).toBe(false);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('rejects duplicate singleton flags before loading context or touching the candidate path', async () => {
    const fixtureRoot = realpathSync(
      mkdtempSync(path.join(realpathSync(tmpdir()), 'qualification-cli-usage-')),
    );
    let loads = 0;
    let output = '';
    try {
      const code = await runCli(
        [
          'qualify',
          'prepare',
          '--candidate',
          '/unreadable/a.json',
          '--candidate',
          '/unreadable/b.json',
          '--entry',
          'a',
          '--entry',
          'b',
          '--entry',
          'c',
          '--rationale',
          'Fixed sample.',
        ],
        {
          stdout: (chunk) => {
            output += chunk;
          },
          qualification: {
            skillRoot: fixtureRoot,
            repoRoot: process.cwd(),
            loadContext: () => {
              loads += 1;
              throw new Error('must not load');
            },
          },
        },
      );
      expect(code).toBe(64);
      expect(envelope(output).status).toBe('USAGE');
      expect(loads).toBe(0);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});

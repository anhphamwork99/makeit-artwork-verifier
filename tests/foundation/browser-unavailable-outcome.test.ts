import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { browserUnavailableFromLaunchError } from '../../src/browser/browser-unavailable';
import { runDiagnosticCommand, type DiagnosticCliDetails } from '../../src/cli/diagnostic';
import type { EnvironmentCell } from '../../src/contracts/runtime';
import { executePlan } from '../../src/runtime/execute-plan';
import { resolveToolkitRoot } from '../../src/runtime/paths';
import { removeTestRunArtifacts, uniqueRunId } from '../integration/helpers';

/**
 * Post-launch browser-precondition outcome classification.
 *
 * Proves the exact live failure shape (owned server ready, then the Playwright
 * browser unavailable) is reported as a structured harness/environment block
 * with a meaningful, path-free `BROWSER_UNAVAILABLE` diagnostic — instead of a
 * generic thrown exception whose public detail is fully redacted.
 *
 * The outcome stays `HARNESS_BLOCKED` with `launchAttempted: true`: the
 * orchestration external-pre-authority branch is reserved for failures decided
 * before the owned server launch, and reusing it here would falsely report
 * `launchAttempted: false` for a run whose server was demonstrably ready.
 *
 * The SEAMS are substituted so no real Next server or browser is launched:
 *  - `launchServer` reports a successful owned launch, exactly as the live run
 *    observed (readinessMs recorded);
 *  - `execute` runs the real `executePlan` drive with a throwing `openPage`, so
 *    the real post-launch catch and the real CLI classification are exercised.
 */

const PRIVATE_EXECUTABLE_PATH =
  '/Users/example-user/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';

const APP_ROOT = path.join(resolveToolkitRoot(), 'tests', 'portable', 'fixtures', 'app-root-compatible');

function textCasePath(): string {
  return path.join(
    resolveToolkitRoot(),
    'cases',
    'diagnostic',
    'requests',
    'layer-text-move-drag-ordinary.json',
  );
}

const created: string[] = [];

afterEach(() => {
  for (const runId of created.splice(0)) removeTestRunArtifacts(runId);
});

describe('[browser-unavailable] live Text case environment classification', () => {
  it('reports HARNESS_BLOCKED with a path-free BROWSER_UNAVAILABLE diagnostic and exact cleanup', async () => {
    const runId = uniqueRunId('vt-browser-unavailable-outcome');
    created.push(runId);

    const result = await runDiagnosticCommand({
      casePath: textCasePath(),
      appRoot: APP_ROOT,
      runId,
      launchServer: async ({ allocation }) =>
        ({
          ok: true as const,
          pid: 4242424,
          processGroupId: 4242424,
          command: [],
          serverLogPath: path.join(allocation.scratchRoot, 'server.log'),
          readinessMs: 1234,
        }),
      execute: (input) =>
        executePlan({
          ...input,
          openPage: async () => {
            throw browserUnavailableFromLaunchError(
              new Error(
                `browserType.launch: Executable doesn't exist at ${PRIVATE_EXECUTABLE_PATH}`,
              ),
              input.environment as Pick<EnvironmentCell, 'cellId' | 'browserKind'>,
            );
          },
        }),
    });

    // A structured, honest harness block: the run really did launch and clean
    // up, so `launchAttempted` and the recorded launch facts are preserved.
    expect(result.status).toBe('HARNESS_BLOCKED');
    expect(result.exitCode).toBe(2);
    expect(result.outcome).toBe('HARNESS_BLOCKED');
    expect(result.launchAttempted).toBe(true);

    const details = result.details as DiagnosticCliDetails;
    expect(details.finalOutcome).toBe('HARNESS_BLOCKED');
    expect(details.behaviorOutcome).toBeNull();
    expect(details.issues).toContain('OBSERVATION_PAYLOAD_MALFORMED');
    expect(details.launch).not.toBeNull();
    expect(details.launch?.readinessMs).toBe(1234);
    expect(details.cleanup?.complete).toBe(true);
    expect(details.runRecordPath).toBeNull();

    // The meaningful diagnostic survives publicly and leaks no private path.
    const codes = result.diagnostics.map((entry) => entry.code);
    expect(codes).toContain('BROWSER_UNAVAILABLE');
    // The browser cause is never collapsed into the generic launch code.
    expect(codes).not.toContain('RUNTIME_LAUNCH_FAILED');
    const meaningful = result.diagnostics.find((entry) => entry.code === 'BROWSER_UNAVAILABLE');
    expect(meaningful?.detail).toContain('chromium-desktop-1440x1000');
    expect(meaningful?.detail).toContain('chromium_headless_shell-1243');
    expect(meaningful?.detail).not.toContain('/Users/');
    for (const entry of result.diagnostics) {
      expect(entry.detail).not.toContain(PRIVATE_EXECUTABLE_PATH);
    }
  });
});

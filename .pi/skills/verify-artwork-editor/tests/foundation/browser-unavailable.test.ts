import { describe, expect, it } from 'vitest';

import {
  BROWSER_INSTALL_HINT,
  BrowserUnavailableError,
  browserUnavailableFromLaunchError,
  isBrowserUnavailableError,
} from '../../src/browser/browser-unavailable';
import type { EnvironmentCell, RunAllocation } from '../../src/contracts/runtime';
import { executePlan, type ExecutePlanInput } from '../../src/runtime/execute-plan';
import {
  LOCAL_RUNTIME_DIAGNOSTIC_PREFIX,
  captureLocalRuntimeDiagnostic,
  type LocalDiagnosticSink,
} from '../../src/runtime/local-diagnostics';

/**
 * Post-launch browser-precondition exception (private standalone toolkit).
 *
 * The first live Text case against the detached FE checkout failed after the
 * owned server was ready because the toolkit's Playwright revision was never
 * downloaded into this environment. The launcher threw a low-level error whose
 * message embedded a machine-local absolute executable path.
 *
 * These tests pin the fix's two invariants:
 *  1. the public diagnostic is path-free, actionable and names the exact
 *     environment cause, so no redaction pass has to erase it;
 *  2. the raw machine-local stack is preserved locally (a bounded, injectable
 *     sink) and never enters the public/durable result.
 */

const PRIVATE_EXECUTABLE_PATH =
  '/Users/example-user/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';

const ENVIRONMENT = {
  cellId: 'chromium-desktop-1440x1000',
  browserKind: 'chromium',
} as const;

function playwrightLaunchError(): Error {
  return new Error(
    `browserType.launch: Executable doesn't exist at ${PRIVATE_EXECUTABLE_PATH}\n` +
      'Looks like Playwright was just installed or updated.\n' +
      'Please run the following command to download new browsers: npx playwright install',
  );
}

describe('[browser-unavailable] path-free public classification', () => {
  it('names the environment cause without embedding the machine-local path', () => {
    const failure = browserUnavailableFromLaunchError(playwrightLaunchError(), ENVIRONMENT);

    expect(failure).toBeInstanceOf(BrowserUnavailableError);
    expect(isBrowserUnavailableError(failure)).toBe(true);
    expect(failure.message).toContain(ENVIRONMENT.cellId);
    expect(failure.message).toContain('chromium');
    expect(failure.message).toContain('chromium_headless_shell-1243');
    expect(failure.message).toContain(BROWSER_INSTALL_HINT);
    // The public message never carries the private absolute path...
    expect(failure.message).not.toContain(PRIVATE_EXECUTABLE_PATH);
    expect(failure.message).not.toContain('/Users/');
    // ...while the raw text is preserved for the local-only sink.
    expect(failure.rawDetail).toContain(PRIVATE_EXECUTABLE_PATH);
    expect(failure.rawStack ?? '').toContain(PRIVATE_EXECUTABLE_PATH);
  });

  it('falls back to a generic safe reason for a non-executable launch failure', () => {
    const failure = browserUnavailableFromLaunchError(
      new Error('browserType.launch: Target page, context or browser has been closed'),
      ENVIRONMENT,
    );
    expect(failure.message).toContain(ENVIRONMENT.cellId);
    expect(failure.message).toContain('could not be started');
    expect(failure.message).not.toContain('/Users/');
  });
});

describe('[browser-unavailable] local-only raw stack capture', () => {
  it('writes the exact private stack to the injected sink and returns it', () => {
    const failure = browserUnavailableFromLaunchError(playwrightLaunchError(), ENVIRONMENT);
    const written: string[] = [];
    const sink: LocalDiagnosticSink = { write: (text) => written.push(text) };

    const captured = captureLocalRuntimeDiagnostic(failure, {
      rawStack: failure.rawStack,
      sink,
    });

    expect(captured.startsWith(LOCAL_RUNTIME_DIAGNOSTIC_PREFIX)).toBe(true);
    expect(captured).toContain(PRIVATE_EXECUTABLE_PATH);
    expect(written).toHaveLength(1);
    expect(written[0]).toContain(PRIVATE_EXECUTABLE_PATH);
  });
});

describe('[browser-unavailable] executePlan post-launch exception', () => {
  function stubbedInput(openPage: () => Promise<never>): ExecutePlanInput {
    return {
      allocation: {
        runId: 'vt-browser-unavailable',
        baseUrl: 'http://127.0.0.1:0',
      } as unknown as RunAllocation,
      caseId: 'vt-browser-unavailable-case',
      intent: {},
      plan: { requiredChecks: [] },
      envelope: {},
      adapter: {},
      fixture: { semanticTargetRoles: [] },
      workflowSteps: [],
      environment: {
        cellId: ENVIRONMENT.cellId,
        browserKind: 'chromium',
      } as unknown as EnvironmentCell,
      meaningProvider: {},
      openPage,
    } as unknown as ExecutePlanInput;
  }

  it('reports BROWSER_UNAVAILABLE with a path-free detail instead of a raw thrown message', async () => {
    const failure = browserUnavailableFromLaunchError(playwrightLaunchError(), ENVIRONMENT);
    const result = await executePlan(stubbedInput(async () => Promise.reject(failure)));

    expect(result.environmentInvalid).toBe(true);
    expect(result.finalObservation).toBeNull();
    expect(result.browserClose).toEqual({ closed: true, detail: null });

    const diagnostic = result.behavior.diagnostics.find(
      (entry) => entry.code === 'BROWSER_UNAVAILABLE',
    );
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.severity).toBe('blocking');
    expect(diagnostic?.detail).toContain(ENVIRONMENT.cellId);
    expect(diagnostic?.detail).not.toContain('/Users/');
    // The misleading generic post-launch code is not emitted for this cause.
    expect(
      result.behavior.diagnostics.some((entry) => entry.code === 'RUNTIME_LAUNCH_FAILED'),
    ).toBe(false);
  });
});

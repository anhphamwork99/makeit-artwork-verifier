import { pathToFileURL } from 'node:url';

import { isDeferredCliCommand } from '../contracts/discriminants';
import { createDiagnostic } from '../contracts/diagnostics';
import { TOOLKIT_NAME, TOOLKIT_VERSION } from '../version';
import type { CliResult } from '../contracts/runtime';
import { parseArgs } from './args';
import { buildCliResult, emitCliResult, runWithCliStdout, usageDiagnostic } from './output';
import { installTerminationSignalHandlers } from './termination';
import type { BudgetCommandOptions } from './budget';
import type { QualificationCommandOptions } from './qualification';
import type { ReleaseCommandOptions } from './release';
import type { RetentionCommandOptions } from './retention';

/**
 * Stable `pnpm verify:artwork` entry point (TS-2).
 *
 * Implemented by this Work Package: `validate --all`, `plan`, `doctor`,
 * `diagnostic` (`--case` and the representative `--suite`), `cleanup`, and
 * `production-absence`, and executable manifest draft generation/validation.
 * Every future TS-2 command fails non-zero with a
 * structured `NOT_IMPLEMENTED` result rather than succeeding silently, and
 * unknown commands are usage errors.
 */

function usage(command: string, detail: string): CliResult<never> {
  return buildCliResult<never>({
    command,
    status: 'USAGE',
    detail,
    diagnostics: [usageDiagnostic(detail, { context: { command } })],
  });
}

function notImplemented(command: string, subcommand: string | null): CliResult<never> {
  const detail = `Command "${subcommand ? `${command} ${subcommand}` : command}" is part of the TS-2 CLI contract but is not implemented by this Work Package. No action was taken.`;
  return buildCliResult<never>({
    command,
    subcommand,
    status: 'NOT_IMPLEMENTED',
    detail,
    diagnostics: [createDiagnostic('CLI_NOT_IMPLEMENTED', detail, { context: { command } })],
  });
}

/**
 * Release Credit is a separate deferred profile. A Release-only flag must not
 * be silently ignored by a correctness command, because doing so could make a
 * caller believe it exercised a stronger assurance profile than it did.
 * `manifest generate --profile release` is the one authoring command that is
 * explicitly allowed to name that deferred profile.
 */
function releaseProfileRefusal(parsed: ReturnType<typeof parseArgs>): string | null {
  const correctnessCommands = [
    'validate',
    'plan',
    'doctor',
    'diagnostic',
    'cleanup',
    'production-absence',
  ];
  if (!correctnessCommands.includes(parsed.command ?? '')) return null;
  const profile = parsed.flags.get('profile');
  if (profile === 'release') {
    return 'The Release Credit profile is deferred and cannot be selected by this command; use the Diagnostic profile.';
  }
  const releaseOnlyFlags = [
    'release',
    'release-credit',
    'approval',
    'policy-root',
    'timing-witness',
  ];
  if (releaseOnlyFlags.some((flag) => parsed.flags.has(flag) || parsed.booleans.has(flag))) {
    return 'Release-only flags are deferred and cannot be used by this command; no action was taken.';
  }
  return null;
}

/**
 * The token vector after the `evidence verify` positionals, preserving any
 * duplicate `--run` occurrence the shared parser would collapse into one map
 * entry. The subcommand is located by positional position (never by name), so a
 * stray `verify` value token is never mistaken for the command.
 */
function evidenceVerifyArguments(argv: readonly string[]): readonly string[] {
  const positionalIndexes: number[] = [];
  for (let index = 0; index < argv.length && positionalIndexes.length < 2; index += 1) {
    if (!(argv[index] as string).startsWith('--')) positionalIndexes.push(index);
  }
  const subcommandIndex = positionalIndexes[1];
  return subcommandIndex === undefined ? argv : argv.slice(subcommandIndex + 1);
}

export interface RunCliOptions {
  /**
   * Test/harness seam: capture this invocation's stdout without mutating the
   * global `process.stdout`. Every async continuation of the invocation is
   * routed to this sink, so a late-resolving run cannot contaminate another
   * capture. Omitted in production, where the envelope goes to real stdout.
   */
  stdout?: (chunk: string) => void;
  /** Harness-owned test dependency injection; no argv token can set this value. */
  qualification?: QualificationCommandOptions;
  /** Harness-owned Release dependencies; never exposed through command-line flags. */
  release?: ReleaseCommandOptions;
  /** Harness-owned retention root; never exposed through command-line flags. */
  retention?: RetentionCommandOptions;
  /** Harness-owned budget dependencies; never exposed through command-line flags. */
  budget?: BudgetCommandOptions;
}

export function runCli(argv: readonly string[], options: RunCliOptions = {}): Promise<number> {
  if (options.stdout) {
    return runWithCliStdout(options.stdout, () => runCliInvocations(argv, options));
  }
  return runCliInvocations(argv, options);
}

async function runCliInvocations(argv: readonly string[], options: RunCliOptions): Promise<number> {
  const parsed = parseArgs(argv);
  const { command, subcommand } = parsed;

  // Help is a first-class usage request rather than an unknown command. It is
  // evaluated before the missing-command guard so bare `--help` answers it.
  if (command === 'version' || parsed.booleans.has('version')) {
    return emitCliResult(
      buildCliResult<never>({
        command: command === 'version' ? 'version' : (command ?? 'version'),
        status: 'PASS',
        detail: `${TOOLKIT_NAME} ${TOOLKIT_VERSION}`,
      }),
    );
  }

  if (command === 'help' || parsed.booleans.has('help')) {
    return emitCliResult(
      usage(
        command === 'help' ? '(help)' : (command ?? '(help)'),
        [
          'Profiles:',
          '  diagnostic — required current-source correctness (PASS/BUG/HARNESS_BLOCKED/ENVIRONMENT_FAILURE).',
          '  qualify — optional reproducibility, non-creditable and separate from Diagnostic.',
          '  release — deferred Release Credit; unavailable in the correctness phase.',
          'Commands:',
          '  validate --all',
          '  plan --case <request.json> --out <dir>',
          '  doctor [--run-id <id>] [--readiness-timeout-ms <n>] [--keep-dist-dir]',
          '  diagnostic --case <request.json> --app-root <path> [--run-id <id>] [--port <n>] [--keep-dist-dir]',
          '  diagnostic --suite <suite-id> --app-root <path> [--run-id <suite-execution-id>]',
          '  cleanup --run-id <id>',
          '  production-absence [--run-id <id>] [--build-timeout-ms <n>] [--start-timeout-ms <n>]',
          '  evidence verify --run <run-or-suite-execution-id>',
          '  manifest generate --profile release',
          '  manifest validate --manifest <draft.json>',
          '  qualify prepare --candidate <draft.json> --entry <id> --entry <id> --entry <id> --rationale <text>',
          '  qualify run --batch <id>',
          '  release activate --manifest <draft.json> --batch <id> --approval <id>',
          '  release run --manifest <draft.json>',
          '  budget calibrate --manifest <draft.json>',
          '  budget measure --calibration <id> --qualification <id> --retention <id>',
          '  budget inspect --set <measurement-set-id>',
          '  budget inspect --proposal <proposal-id>',
          '  budget inspect --approved <approval-id>',
          '  retention audit',
          'Flags:',
          '  --app-root <path>  Explicit application checkout that owns the product-meaning provider; required by diagnostic and validated before allocation.',
          '  --version          Print the toolkit name and version.',
          '  --help             Print this schema-versioned command surface.',
        ].join('\n'),
      ),
    );
  }

  if (command === null) {
    return emitCliResult(
      usage(
        '(none)',
        'No command supplied. Expected one of: validate, plan, doctor, diagnostic, cleanup, production-absence, evidence, manifest.',
      ),
    );
  }

  const deferredProfileRefusal = releaseProfileRefusal(parsed);
  if (deferredProfileRefusal !== null) {
    return emitCliResult(usage(command, deferredProfileRefusal));
  }

  switch (command) {
    case 'manifest': {
      const { runManifestCommand } = await import('./manifest');
      return emitCliResult(runManifestCommand(argv.slice(1)));
    }
    case 'qualify': {
      const { runQualificationCommand } = await import('./qualification');
      return emitCliResult(await runQualificationCommand(argv.slice(1), options.qualification));
    }
    case 'release': {
      const { runReleaseCommand } = await import('./release');
      return emitCliResult(await runReleaseCommand(argv.slice(1), options.release));
    }
    case 'retention': {
      const { runRetentionCommand } = await import('./retention');
      return emitCliResult(runRetentionCommand(argv.slice(1), options.retention));
    }
    case 'budget': {
      const { runBudgetCommand } = await import('./budget');
      return emitCliResult(await runBudgetCommand(argv.slice(1), options.budget));
    }
    case 'validate': {
      if (!parsed.booleans.has('all') || subcommand !== null) {
        return emitCliResult(usage('validate', 'validate requires exactly `validate --all`.'));
      }
      const { runValidateAll } = await import('./validate');
      return emitCliResult(runValidateAll());
    }
    case 'evidence': {
      if (subcommand !== 'verify') {
        // Every other `evidence` subcommand stays on the deferred TS-2 surface
        // and fails closed exactly as it did before this Work Package.
        return emitCliResult(notImplemented('evidence', subcommand));
      }
      const { runEvidenceVerifyCommand } = await import('./evidence');
      return emitCliResult(runEvidenceVerifyCommand(evidenceVerifyArguments(argv)));
    }
    case 'plan': {
      const casePath = parsed.flags.get('case');
      const outDir = parsed.flags.get('out');
      if (casePath === undefined || outDir === undefined) {
        return emitCliResult(
          usage('plan', 'plan requires `--case <request.json>` and `--out <dir>`.'),
        );
      }
      const { runPlan } = await import('./plan');
      return emitCliResult(runPlan({ casePath, outDir }));
    }
    case 'doctor': {
      const runId = parsed.flags.get('run-id');
      const deadlineRaw = parsed.flags.get('readiness-timeout-ms');
      const readinessDeadlineMs = deadlineRaw === undefined ? undefined : Number(deadlineRaw);
      if (readinessDeadlineMs !== undefined && !Number.isFinite(readinessDeadlineMs)) {
        return emitCliResult(usage('doctor', '`--readiness-timeout-ms` must be a finite number.'));
      }
      const { runDoctorCommand } = await import('./doctor');
      return emitCliResult(
        await runDoctorCommand({
          runId,
          readinessDeadlineMs,
          keepDistDir: parsed.booleans.has('keep-dist-dir'),
        }),
      );
    }
    case 'diagnostic': {
      const casePath = parsed.flags.get('case');
      const suiteId = parsed.flags.get('suite');
      if (casePath !== undefined && suiteId !== undefined) {
        return emitCliResult(
          usage(
            'diagnostic',
            'diagnostic accepts exactly one of `--case <request.json>` or `--suite <suite-id>`.',
          ),
        );
      }
      if (suiteId !== undefined) {
        if (suiteId.length === 0) {
          return emitCliResult(usage('diagnostic', '`--suite` requires a non-empty suite id.'));
        }
        if (parsed.flags.has('port') || parsed.booleans.has('keep-dist-dir')) {
          return emitCliResult(
            usage(
              'diagnostic',
              '`--suite` allocates independent resources per child; `--port` and `--keep-dist-dir` are not accepted with it.',
            ),
          );
        }
        const runId = parsed.flags.get('run-id');
        const appRoot = parsed.flags.get('app-root');
        const { runDiagnosticSuiteCommand } = await import('./suite');
        return emitCliResult(
          await runDiagnosticSuiteCommand({
            suiteId,
            ...(runId === undefined ? {} : { runId }),
            ...(appRoot === undefined ? {} : { appRoot }),
          }),
        );
      }
      if (casePath === undefined) {
        return emitCliResult(
          usage(
            'diagnostic',
            'diagnostic requires `--case <request.json>` or `--suite <suite-id>`.',
          ),
        );
      }
      const portRaw = parsed.flags.get('port');
      const port = portRaw === undefined ? undefined : Number(portRaw);
      if (port !== undefined && (!Number.isInteger(port) || port <= 0 || port > 65_535)) {
        return emitCliResult(usage('diagnostic', '`--port` must be an integer in 1..65535.'));
      }
      const runId = parsed.flags.get('run-id');
      const appRoot = parsed.flags.get('app-root');
      const { runDiagnosticCommand } = await import('./diagnostic');
      return emitCliResult(
        await runDiagnosticCommand({
          casePath,
          runId,
          port,
          keepDistDir: parsed.booleans.has('keep-dist-dir'),
          ...(appRoot === undefined ? {} : { appRoot }),
        }),
      );
    }
    case 'cleanup': {
      const runId = parsed.flags.get('run-id');
      if (runId === undefined) {
        return emitCliResult(usage('cleanup', 'cleanup requires `--run-id <run-id>`.'));
      }
      const { runCleanupCommand } = await import('./cleanup');
      return emitCliResult(await runCleanupCommand(runId));
    }
    case 'production-absence': {
      if (subcommand !== null) {
        return emitCliResult(
          usage('production-absence', 'production-absence takes no subcommand.'),
        );
      }
      const runId = parsed.flags.get('run-id');
      const buildRaw = parsed.flags.get('build-timeout-ms');
      const startRaw = parsed.flags.get('start-timeout-ms');
      const buildDeadlineMs = buildRaw === undefined ? undefined : Number(buildRaw);
      const startDeadlineMs = startRaw === undefined ? undefined : Number(startRaw);
      if (buildDeadlineMs !== undefined && !Number.isFinite(buildDeadlineMs)) {
        return emitCliResult(
          usage('production-absence', '`--build-timeout-ms` must be a finite number.'),
        );
      }
      if (startDeadlineMs !== undefined && !Number.isFinite(startDeadlineMs)) {
        return emitCliResult(
          usage('production-absence', '`--start-timeout-ms` must be a finite number.'),
        );
      }
      const { runProductionAbsenceCommand } = await import('./production-absence');
      return emitCliResult(
        await runProductionAbsenceCommand({
          runId,
          buildDeadlineMs,
          startDeadlineMs,
          keepDistDir: parsed.booleans.has('keep-dist-dir'),
        }),
      );
    }
    default: {
      if (isDeferredCliCommand(command)) {
        return emitCliResult(notImplemented(command, subcommand));
      }
      return emitCliResult(usage(command, `Unknown command "${command}".`));
    }
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  // Bounded terminal safety net: SIGINT/SIGTERM during Doctor routes to exact
  // cleanup of the single active run id and exits non-zero with a structured
  // result. No broad process-name or port sweep is ever performed.
  installTerminationSignalHandlers();
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 2;
    });
}

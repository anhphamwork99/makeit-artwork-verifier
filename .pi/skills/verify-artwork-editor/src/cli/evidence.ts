import os from 'node:os';
import path from 'node:path';

import {
  parseEvidenceVerifyArguments,
  type EvidenceVerifyDetails,
} from '../contracts/evidence-verify';
import type { CliResult } from '../contracts/runtime';
import {
  EvidenceVerifyRequestError,
  createCurrentTreeProvenanceProvider,
  createNodeEvidenceVerifyFsAdapter,
  verifyEvidenceRoot,
  type EvidenceVerifyEnvironment,
  type EvidenceVerifyFsAdapter,
} from '../evidence/integrity';
import { resolveRepoRoot, resolveSkillRoot } from '../runtime/paths';
import { buildCliResult, usageDiagnostic } from './output';

/**
 * `pnpm verify:artwork evidence verify --run <run-or-suite-execution-id>`
 * (ADR 0048 WP-B2; plan §11).
 *
 * The single read-only evidence-verification entry point. It parses the exact
 * P8-B argument vector with the pure, filesystem-free parser (so duplicate
 * `--run`, duplicate/unknown flags, unknown positionals, missing values, and
 * `--flag=value`/separate-value ambiguity are rejected before any root access),
 * resolves exactly one committed run or suite-v2 root, and emits exactly one
 * deterministic `evidence-verify.v1` JSON envelope through the existing CLI
 * status/exit mapping. It never writes, repairs, adopts, deletes, publishes, or
 * clears any evidence root, and it never emits `BUG` for a verifier finding.
 */

/** The fixed `detail` strings permitted for the evidence-verify command. */
export const EVIDENCE_VERIFY_DETAILS = Object.freeze({
  pass: 'evidence root passed integrity verification',
  blocked: 'evidence root is not creditable',
  environment: 'evidence verification requires external resource',
  usage: 'invalid evidence verification request',
});

export interface EvidenceVerifyCommandOptions {
  /** Test seam: absolute evidence base directory. Defaults to the toolkit root. */
  readonly evidenceBaseDir?: string;
  /** Test seam: read-only no-follow filesystem adapter. */
  readonly fs?: EvidenceVerifyFsAdapter;
  /** Test seam: optional current-tree provider. Defaults to the production one. */
  readonly currentTree?: EvidenceVerifyEnvironment['currentTree'];
  /** Registered private roots rejected by inspection; never emitted. */
  readonly forbiddenRoots?: readonly string[];
}

function productionEvidenceBaseDir(): string {
  return path.join(resolveSkillRoot(), 'evidence');
}

function productionForbiddenRoots(): readonly string[] {
  return [resolveRepoRoot(), resolveSkillRoot(), os.tmpdir()];
}

/**
 * Build the read-only environment. The default adapter is the capability-checked
 * no-follow Node adapter and the default current-tree provider recomputes the
 * governed repository identities through the accepted read-only collector. Both
 * are injectable for tests; no injection can add a write or cleanup edge.
 */
function buildEvidenceVerifyEnvironment(
  options: EvidenceVerifyCommandOptions,
): EvidenceVerifyEnvironment {
  const env: EvidenceVerifyEnvironment = {
    evidenceBaseDir: options.evidenceBaseDir ?? productionEvidenceBaseDir(),
    fs: options.fs ?? createNodeEvidenceVerifyFsAdapter(),
    forbiddenRoots: options.forbiddenRoots ?? productionForbiddenRoots(),
    currentTree: options.currentTree ?? createCurrentTreeProvenanceProvider(),
  };
  return env;
}

function evidenceVerifyUsage(failure: string): CliResult<EvidenceVerifyDetails> {
  return buildCliResult<EvidenceVerifyDetails>({
    command: 'evidence',
    subcommand: 'verify',
    status: 'USAGE',
    detail: EVIDENCE_VERIFY_DETAILS.usage,
    launchAttempted: false,
    outcome: null,
    details: null,
    diagnostics: [
      usageDiagnostic(EVIDENCE_VERIFY_DETAILS.usage, {
        context: { command: 'evidence', subcommand: 'verify', failure },
      }),
    ],
  });
}

/**
 * Run one `evidence verify` invocation. `argv` is exactly the token vector after
 * the `evidence verify` positionals, preserving duplicates the generic parser
 * would collapse. The result carries the validated closed details object for
 * every non-usage outcome; a usage rejection never touches the filesystem.
 */
export function runEvidenceVerifyCommand(
  argv: readonly string[],
  options: EvidenceVerifyCommandOptions = {},
): CliResult<EvidenceVerifyDetails> {
  const parsed = parseEvidenceVerifyArguments(argv);
  if (!parsed.ok) {
    return evidenceVerifyUsage(parsed.failure);
  }

  let details: EvidenceVerifyDetails;
  try {
    details = verifyEvidenceRoot(
      { requestedId: parsed.runId },
      buildEvidenceVerifyEnvironment(options),
    );
  } catch (error) {
    // The parser already guarantees a safe logical id; a residual request
    // invariant failure is an invalid invocation, never a filesystem read.
    if (error instanceof EvidenceVerifyRequestError) {
      return evidenceVerifyUsage('EVIDENCE_VERIFY_ARGUMENT_UNSAFE_ID');
    }
    throw error;
  }

  const failureClass = details.transaction.failureClass;
  const status = failureClass ?? 'PASS';
  const detail =
    status === 'PASS'
      ? EVIDENCE_VERIFY_DETAILS.pass
      : status === 'ENVIRONMENT_FAILURE'
        ? EVIDENCE_VERIFY_DETAILS.environment
        : EVIDENCE_VERIFY_DETAILS.blocked;

  return buildCliResult<EvidenceVerifyDetails>({
    command: 'evidence',
    subcommand: 'verify',
    status,
    detail,
    launchAttempted: false,
    outcome: null,
    details,
    diagnostics: [],
  });
}

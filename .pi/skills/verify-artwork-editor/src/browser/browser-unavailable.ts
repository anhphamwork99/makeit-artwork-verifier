import type { EnvironmentCell } from '../contracts/runtime';

/**
 * Typed browser-precondition failure (post-launch runtime exception).
 *
 * The Playwright launcher throws a low-level error whose message embeds the
 * machine-local absolute executable path (for example
 * `/Users/<name>/Library/Caches/ms-playwright/chromium_headless_shell-1243/…`).
 * That raw text is a private value: it must never enter the public CLI envelope
 * or the durable evidence record. At the same time the operator running the
 * CLI locally still needs the exact stack.
 *
 * This error therefore separates the two concerns:
 *  - `message` is a path-free, actionable public description derived only from
 *    known-safe facts (the environment cell identity and the Playwright browser
 *    revision token), so a redaction pass never has to erase it;
 *  - `rawDetail`/`rawStack` preserve the exact thrown text for a local-only
 *    diagnostic sink and are never serialized into a public result.
 */
export class BrowserUnavailableError extends Error {
  /** Exact thrown text, including any machine-local path. Local-only. */
  readonly rawDetail: string;
  /** Exact thrown stack, including any machine-local path. Local-only. */
  readonly rawStack: string | null;
  /** The original thrown value, retained for diagnostics. Local-only. */
  readonly rawCause: unknown;

  constructor(input: {
    message: string;
    rawDetail: string;
    rawStack: string | null;
    rawCause: unknown;
  }) {
    super(input.message);
    this.name = 'BrowserUnavailableError';
    this.rawDetail = input.rawDetail;
    this.rawStack = input.rawStack;
    this.rawCause = input.rawCause;
  }
}

export function isBrowserUnavailableError(error: unknown): error is BrowserUnavailableError {
  return error instanceof BrowserUnavailableError;
}

/** Path-free Playwright revision token, e.g. `chromium_headless_shell-1243`. */
const REVISION_TOKEN = /(chromium(?:_headless_shell)?-\d+)/i;
const EXECUTABLE_MISSING = /Executable doesn't exist/i;

export const BROWSER_INSTALL_HINT =
  "Install the pinned Playwright browsers (for example 'npx playwright install chromium') and retry.";

/**
 * Builds the sanitized, actionable failure for a Playwright launch error.
 *
 * The public message interpolates only the environment cell id, the browser
 * kind, and a revision token matched out of the raw text. The raw absolute path
 * is deliberately never copied into the message, so no generic path scrubber is
 * required to keep the public result safe.
 */
export function browserUnavailableFromLaunchError(
  error: unknown,
  environment: Pick<EnvironmentCell, 'cellId' | 'browserKind'>,
): BrowserUnavailableError {
  const rawDetail = error instanceof Error ? error.message : String(error);
  const rawStack = error instanceof Error ? (error.stack ?? error.message) : null;
  const revision = REVISION_TOKEN.exec(rawDetail)?.[1] ?? null;
  const executableMissing = EXECUTABLE_MISSING.test(rawDetail);

  const reason = executableMissing
    ? revision === null
      ? 'the Playwright browser executable is unavailable'
      : `the Playwright browser executable for revision '${revision}' is unavailable`
    : 'the browser process could not be started';

  const message =
    `The ${environment.browserKind} browser for environment cell '${environment.cellId}' ` +
    `could not be launched because ${reason}. ${BROWSER_INSTALL_HINT}`;

  return new BrowserUnavailableError({ message, rawDetail, rawStack, rawCause: error });
}

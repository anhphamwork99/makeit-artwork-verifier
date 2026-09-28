/**
 * Local-only runtime diagnostic capture.
 *
 * A thrown runtime error frequently embeds a machine-local absolute path (for
 * example a Playwright browser executable path or an application checkout). The
 * public CLI envelope and the durable evidence record must never carry such a
 * value, so those surfaces redact it. The operator running the CLI locally still
 * needs the exact stack to diagnose the failure.
 *
 * This module writes the unredacted stack to the local process `stderr` stream,
 * which is not part of the structured CLI envelope and not part of durable
 * evidence. It is deliberately a bounded side channel: it never mutates the
 * result and never serializes into a public/durable artifact.
 */

export const LOCAL_RUNTIME_DIAGNOSTIC_PREFIX = '[verify-artwork:local-runtime-diagnostic]';

/** Minimal writer seam so the local capture is testable without touching stderr. */
export interface LocalDiagnosticSink {
  write(text: string): void;
}

/** Default sink: the real, local process stderr. */
export const defaultLocalDiagnosticSink: LocalDiagnosticSink = {
  write: (text) => {
    process.stderr.write(text);
  },
};

export interface LocalRuntimeDiagnosticInput {
  /** Exact thrown stack, including any machine-local path. */
  readonly rawStack?: string | null;
  /** Optional capturing sink; defaults to process stderr. */
  readonly sink?: LocalDiagnosticSink;
}

/**
 * Writes the exact thrown stack to the local-only sink.
 *
 * Returns the captured text so a caller/test can observe what was written
 * without depending on process stderr. It is best-effort: a sink that throws
 * never replaces the original runtime failure.
 */
export function captureLocalRuntimeDiagnostic(
  error: unknown,
  input: LocalRuntimeDiagnosticInput = {},
): string {
  const rawStack =
    input.rawStack ?? (error instanceof Error ? (error.stack ?? error.message) : String(error));
  const text = `${LOCAL_RUNTIME_DIAGNOSTIC_PREFIX}\n${rawStack}\n`;
  const sink = input.sink ?? defaultLocalDiagnosticSink;
  try {
    sink.write(text);
  } catch {
    // Local diagnostics are best-effort; never mask the original failure.
  }
  return text;
}

/**
 * Bounded HTTP readiness polling (specification 10).
 *
 * Readiness is bounded infrastructure polling only: it establishes that the
 * owned server is accepting requests before any browser or Doctor work. It is
 * never a correctness check, never an unbounded wait, and never a fixed sleep.
 */

export interface ReadinessProbeInput {
  url: string;
  deadlineMs: number;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
  /** Returns false as soon as the owned process is known to have exited. */
  isProcessAlive?: () => boolean;
  fetchImpl?: typeof fetch;
}

export type ReadinessResult =
  | { ready: true; attempts: number; elapsedMs: number; lastStatus: number | null }
  | {
      ready: false;
      attempts: number;
      elapsedMs: number;
      lastError: string;
      processExited: boolean;
    };

function nowMs(): number {
  return Date.now();
}

export async function waitForHttpReadiness(input: ReadinessProbeInput): Promise<ReadinessResult> {
  const pollIntervalMs = input.pollIntervalMs ?? 250;
  const requestTimeoutMs = input.requestTimeoutMs ?? 2_000;
  const doFetch = input.fetchImpl ?? fetch;
  const start = nowMs();
  const deadline = start + input.deadlineMs;
  let attempts = 0;
  let lastError = 'no response';
  let lastStatus: number | null = null;

  for (;;) {
    attempts += 1;
    if (input.isProcessAlive && !input.isProcessAlive()) {
      return {
        ready: false,
        attempts,
        elapsedMs: nowMs() - start,
        lastError: 'owned server process exited before readiness',
        processExited: true,
      };
    }

    try {
      const response = await doFetch(input.url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      lastStatus = response.status;
      if (response.status >= 200 && response.status < 400) {
        return { ready: true, attempts, elapsedMs: nowMs() - start, lastStatus };
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    const remaining = deadline - nowMs();
    if (remaining <= 0) {
      return {
        ready: false,
        attempts,
        elapsedMs: nowMs() - start,
        lastError,
        processExited: false,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remaining)));
  }
}

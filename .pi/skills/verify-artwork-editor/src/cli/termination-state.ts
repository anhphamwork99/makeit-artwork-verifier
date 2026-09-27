/**
 * Shared idle state for signal-driven termination.
 *
 * Kept separate from the termination handler and the CLI envelope builder so the
 * in-flight command flow can observe "a structured termination result was
 * already emitted" without importing the handler (and without an import cycle).
 */
let terminationEmitted = false;

export function markTerminationEmitted(): void {
  terminationEmitted = true;
}

export function terminationWasEmitted(): boolean {
  return terminationEmitted;
}

/** Test-only reset; production never clears the flag once set. */
export function resetTerminationStateForTests(): void {
  terminationEmitted = false;
}

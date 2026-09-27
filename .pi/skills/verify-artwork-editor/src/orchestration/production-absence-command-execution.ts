import { PRODUCTION_ABSENCE_COMMAND_AUTHORITY } from '../commands/production-absence-command-context';
import {
  executeCommandContext,
  type CommandExecutionContextInput,
  type CommandExecutionOutcome,
} from './command-execution';

/**
 * P7-B2-D2 production-absence command execution adapter (ADR 0029 §4 B2-D;
 * post-cutover current path, ADR 0032 §E3-S2).
 *
 * This binds the accepted B1-G production-absence command authority to the
 * shared current command-context orchestration so the current `pnpm
 * verify:artwork production-absence` boundary has an exact, already-proven
 * counterpart. It consumes the versioned production-absence authority plus the
 * raw static-scan/browser facts, evidence-role availability, external-failure,
 * and cleanup facts, and never a compiled correctness profile or a materialized
 * execution envelope.
 *
 * It is reached only through the current final façade by the production-absence
 * CLI entry, and it references no legacy boolean/v3 classifier, writer, or
 * public projection.
 */
export function executeProductionAbsenceCommandContext(
  input: CommandExecutionContextInput,
): CommandExecutionOutcome {
  return executeCommandContext(PRODUCTION_ABSENCE_COMMAND_AUTHORITY, input);
}

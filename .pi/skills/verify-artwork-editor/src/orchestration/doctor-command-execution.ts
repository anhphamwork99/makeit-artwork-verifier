import { DOCTOR_COMMAND_AUTHORITY } from '../commands/doctor-command-context';
import {
  executeCommandContext,
  type CommandExecutionContextInput,
  type CommandExecutionOutcome,
} from './command-execution';

/**
 * P7-B2-D2 Doctor command execution adapter (ADR 0029 §4 B2-D; post-cutover
 * current path, ADR 0032 §E3-S2).
 *
 * This binds the accepted B1-G Doctor command authority to the shared current
 * command-context orchestration so the current `pnpm verify:artwork doctor`
 * boundary has an exact, already-proven counterpart. It consumes the versioned
 * Doctor authority plus the raw active Doctor facts, evidence-role availability,
 * external-failure, and cleanup facts, and never a compiled correctness profile
 * or a materialized execution envelope.
 *
 * It is reached only through the current final façade by the Doctor CLI entry,
 * and it references no legacy boolean/v3 classifier, writer, or public
 * projection.
 */
export function executeDoctorCommandContext(
  input: CommandExecutionContextInput,
): CommandExecutionOutcome {
  return executeCommandContext(DOCTOR_COMMAND_AUTHORITY, input);
}

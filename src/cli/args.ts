/**
 * Minimal argv parser for the stable `pnpm verify:artwork` surface (TS-2).
 *
 * Values are never coerced: `--all` is a boolean flag, `--case <path>` is a
 * string. Unknown commands and missing required values are surfaced by the
 * command handlers as structured usage errors.
 */

export interface ParsedArgs {
  command: string | null;
  subcommand: string | null;
  flags: Map<string, string>;
  booleans: Set<string>;
  positionals: string[];
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags = new Map<string, string>();
  const booleans = new Set<string>();
  const positionals: string[] = [];
  let command: string | null = null;
  let subcommand: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token.startsWith('--')) {
      const body = token.slice(2);
      const equalsIndex = body.indexOf('=');
      if (equalsIndex >= 0) {
        flags.set(body.slice(0, equalsIndex), body.slice(equalsIndex + 1));
        continue;
      }
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(body, next);
        index += 1;
      } else {
        booleans.add(body);
      }
      continue;
    }
    if (command === null) {
      command = token;
    } else if (subcommand === null) {
      subcommand = token;
    } else {
      positionals.push(token);
    }
  }

  return { command, subcommand, flags, booleans, positionals };
}

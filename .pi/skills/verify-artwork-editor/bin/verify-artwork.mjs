#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Thin launcher for the stable `pnpm verify:artwork` surface (TS-2).
 *
 * The implementation is TypeScript; this shim keeps the public command stable
 * while running the TS entry point through the repository's `tsx` dev tool. It
 * forwards argv and the child's exit code unchanged.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(here, '..');
const repoRoot = path.resolve(skillRoot, '..', '..', '..');
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const entry = path.join(skillRoot, 'src', 'cli', 'main.ts');

const result = spawnSync(process.execPath, [tsxCli, entry, ...process.argv.slice(2)], {
  cwd: repoRoot,
  stdio: 'inherit',
});

if (result.error) {
  process.stderr.write(`${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);

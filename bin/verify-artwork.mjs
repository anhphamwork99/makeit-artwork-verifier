#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Thin, path-relative launcher for the standalone toolkit CLI.
 *
 * The implementation is TypeScript, so this shim runs the TS entry point
 * through the toolkit's own `tsx` dev dependency and forwards argv and the
 * child's exit code unchanged. Nothing here hardcodes an absolute path or infers
 * an application checkout: the toolkit root is derived from this file's own
 * location and the application root is an explicit `--app-root` CLI input.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const toolkitRoot = path.resolve(here, '..');
const skillRoot = path.join(toolkitRoot, '.pi', 'skills', 'verify-artwork-editor');
const tsxCli = path.join(toolkitRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const entry = path.join(skillRoot, 'src', 'cli', 'main.ts');

const result = spawnSync(process.execPath, [tsxCli, entry, ...process.argv.slice(2)], {
  cwd: toolkitRoot,
  stdio: 'inherit',
});

if (result.error) {
  process.stderr.write(`${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);

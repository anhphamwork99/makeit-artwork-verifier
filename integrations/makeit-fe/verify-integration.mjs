#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const appRootIndex = process.argv.indexOf('--app-root');
const suppliedRoot = appRootIndex >= 0 ? process.argv[appRootIndex + 1] : null;
if (!suppliedRoot) {
  process.stderr.write('Usage: node verify-integration.mjs --app-root <official-fe-checkout>\n');
  process.exit(64);
}

const appRoot = path.resolve(suppliedRoot);
if (!existsSync(appRoot) || realpathSync(appRoot) !== appRoot) {
  process.stderr.write('The app root must be an existing canonical directory.\n');
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
const expectedDependency = 'github:anhphamwork99/makeit-artwork-verifier#v0.3.3';
const actualDependency = manifest.devDependencies?.['makeit-artwork-verifier'];
const requiredPaths = [
  'scripts/artwork-verifier-package.mjs',
  'scripts/verify-artwork.mjs',
  'src/lib/artwork/artworkVerificationBridge.ts',
  'src/lib/artwork/verification/productMeaningProvider.mjs',
  'src/hooks/artwork/verification/useArtworkVerificationSeams.ts',
];
const problems = [];

if (actualDependency !== expectedDependency) {
  problems.push(`package pin mismatch: expected ${expectedDependency}, received ${String(actualDependency)}`);
}
if (existsSync(path.join(appRoot, '.gitmodules'))) {
  problems.push('legacy .gitmodules is still present');
}
if (existsSync(path.join(appRoot, '.tooling', 'makeit-artwork-verifier'))) {
  problems.push('legacy verifier submodule path is still present');
}
for (const relative of requiredPaths) {
  if (!existsSync(path.join(appRoot, relative))) problems.push(`missing ${relative}`);
}

if (problems.length > 0) {
  process.stderr.write(`${problems.map((problem) => `- ${problem}`).join('\n')}\n`);
  process.exit(2);
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: appRoot, stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('pnpm', ['test:verify:adapter']);
run('pnpm', ['verify:artwork:setup']);
run('pnpm', ['verify:artwork:host']);
process.stdout.write('PASS: MakeIt FE Integration Kit static boundary and focused host gates\n');

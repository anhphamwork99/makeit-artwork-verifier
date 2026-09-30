#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'provenance', 'package-snapshot.json');
const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const roots = ['bin', 'src', 'cases', 'catalogues', 'fixtures', 'governance', 'agents'];
// Package managers normalize package.json while packing; name/version are validated separately.
const singleFiles = ['tsconfig.portable.json'];

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function walk(relative, output) {
  const absolute = path.join(root, relative);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) throw new Error(`Package snapshot refuses symlink: ${relative}`);
  if (stat.isFile()) {
    output.push({ path: relative.split(path.sep).join('/'), sha256: sha256(absolute) });
    return;
  }
  if (!stat.isDirectory()) throw new Error(`Package snapshot refuses non-file: ${relative}`);
  for (const entry of readdirSync(absolute).sort()) walk(path.join(relative, entry), output);
}

const governedEntries = [];
for (const relative of [...roots, ...singleFiles]) walk(relative, governedEntries);
governedEntries.sort((a, b) => a.path.localeCompare(b.path));
const lockfileDigest = sha256(path.join(root, 'pnpm-lock.yaml'));
const identityInput = JSON.stringify({
  name: packageJson.name,
  version: packageJson.version,
  lockfileDigest,
  governedEntries,
});
const repositoryRevision = createHash('sha1').update(identityInput).digest('hex');
const snapshot = {
  schemaVersion: 1,
  packageName: packageJson.name,
  packageVersion: packageJson.version,
  identityKind: 'package-snapshot',
  repositoryRevision,
  dirtyPolicy: 'clean',
  lockfileDigest,
  governedEntries,
};
writeFileSync(manifestPath, `${JSON.stringify(snapshot, null, 2)}\n`);
process.stdout.write(`${manifestPath}\n`);

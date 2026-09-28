import { existsSync, lstatSync, readlinkSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { defaultEvidenceBaseDir } from '../../src/runtime/evidence-root';
import { resolveSkillRoot, resolveToolkitRoot } from '../../src/runtime/paths';

function relativeFiles(root: string, current = root): string[] {
  return readdirSync(current)
    .flatMap((name) => {
      const absolute = path.join(current, name);
      if (statSync(absolute).isDirectory()) return relativeFiles(root, absolute);
      return [path.relative(root, absolute).split(path.sep).join('/')];
    })
    .sort();
}

describe('package-root ownership boundary', () => {
  it('keeps the agent skill thin and instruction-only', () => {
    expect(relativeFiles(resolveSkillRoot())).toEqual([
      'SKILL.md',
      'references/cold-agent.md',
    ]);
    const toolkitRoot = resolveToolkitRoot();
    const compatibilityLink = path.join(
      toolkitRoot,
      '.agents',
      'skills',
      'verify-artwork-editor',
    );
    expect(lstatSync(compatibilityLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(compatibilityLink)).toBe('../../agents/verify-artwork-editor');
    expect(
      existsSync(path.join(toolkitRoot, '.pi', 'skills', 'verify-artwork-editor', 'SKILL.md')),
    ).toBe(false);
  });

  it('owns executable source, tests, package data, governance and evidence outside the skill', () => {
    const toolkitRoot = resolveToolkitRoot();
    for (const relative of [
      'src',
      'tests',
      'cases',
      'catalogues',
      'fixtures',
      'governance/authorities',
    ]) {
      expect(statSync(path.join(toolkitRoot, relative)).isDirectory(), relative).toBe(true);
    }
    expect(defaultEvidenceBaseDir()).toBe(path.join(toolkitRoot, 'evidence'));
    expect(defaultEvidenceBaseDir().startsWith(resolveSkillRoot())).toBe(false);
    for (const relative of ['bin/verify-artwork.mjs', 'scripts/verify-transfer.mjs']) {
      expect(statSync(path.join(toolkitRoot, relative)).isFile(), relative).toBe(true);
    }
  });
});

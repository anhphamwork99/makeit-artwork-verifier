import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import { describe, expect, it } from 'vitest';

import { sha256Hex } from '../../src/canonical/canonicalize';
import { DOCTOR_COMMAND_STATUS_AUTHORITY } from '../../src/commands/doctor-command-context';
import { PRODUCTION_ABSENCE_COMMAND_STATUS_AUTHORITY } from '../../src/commands/production-absence-command-context';
import {
  EVIDENCE_FINAL_MANIFEST_LABEL,
  EVIDENCE_FINAL_MANIFEST_SCHEMA_VERSION,
  EVIDENCE_INTENDED_INVENTORY_LABEL,
  EVIDENCE_INTENDED_INVENTORY_SCHEMA_VERSION,
  EVIDENCE_SEALED_STRICT_SCHEMAS,
  isEvidenceByteSequence,
} from '../../src/contracts/evidence-transaction';
import { FINAL_CURRENT_CHILD_RECORD_SCHEMA_VERSION } from '../../src/contracts/final-record-v4';
import { FINAL_SUITE_RECORD_SCHEMA_VERSION } from '../../src/contracts/final-suite-record';
import { inspectSanitizationApproval, sanitizeArtifactBytes } from '../../src/evidence/sanitize';
import {
  PROVENANCE_ACTIVE_ENTRY_ROOTS,
  PROVENANCE_COMPONENT_POLICY,
  type ProvenanceFlow,
} from '../../src/evidence/provenance-component-policy';
import { buildEvidenceProvenance, validateGovernedProvenance } from '../../src/evidence/provenance';
import { deriveSemanticDigest } from '../../src/evidence/semantic-digest';
import {
  FINAL_SWITCH_AUDIT_CONSUMER_MODULES,
  FINAL_SWITCH_GOVERNANCE_EVIDENCE_READERS,
  FINAL_SWITCH_E3_ROLLBACK_FILES,
  FINAL_SWITCH_E3_WRITE_SET,
  FINAL_SWITCH_MANIFEST,
  finalSwitchManifestIssues,
  finalSwitchModuleSpecifiers,
  type FinalSwitchManifestView,
} from '../../src/orchestration/final-switch-manifest';
import { deriveFlowProvenanceIdentities } from '../../src/orchestration/final-active-path';
import { loadEnvironmentCatalogue, resolveEnvironmentCell } from '../../src/runtime/environment';
import { resolveRepoRoot, resolveToolkitRoot } from '../../src/runtime/paths';

/**
 * P8-A1 dormant-path closure proof (ADR 0041).
 *
 * Proves the preserved Package-8 implementation is genuinely dormant and did not
 * change any accepted active behavior:
 *
 * - no active source path (CLI, runtime, browser, adapter, orchestration, barrel,
 *   or final v4/suite writer) imports a Package-8 module;
 * - the strict current-v4 and suite-v2 correctness schemas remain unchanged and
 *   are never reached by a Package-8 module;
 * - the frozen E3 write set and its identical rollback set are byte-for-byte
 *   unchanged, and no Package-8 source or test joins them;
 * - the closure manifest accounts for every Package-8 importer through the exact
 *   read-only registrations, so the audit over the real repository view is clean;
 * - the byte-authority boundary accepts a cross-realm `Uint8Array` through the
 *   realm-safe predicate rather than a fragile `instanceof` check.
 *
 * This test only reads source text and drives pure/dormant primitives; it
 * activates no runtime, CLI, browser, or producer path.
 */

const skillRoot = resolveToolkitRoot();
const repoRoot = resolveRepoRoot();

/** Every dormant Package-8 source module, `src/`-relative without the extension. */
const P8A1_SOURCE_MODULES: readonly string[] = [
  'src/contracts/evidence-transaction',
  'src/canonical/package8-identity',
  'src/evidence/provenance',
  'src/evidence/publication',
  'src/evidence/reference-graph',
  'src/evidence/sanitize',
  'src/evidence/semantic-digest',
  'src/evidence/transaction',
];

const P8A2_SOURCE_MODULES: readonly string[] = [
  'src/evidence/private-snapshot',
  'src/evidence/provenance-collector',
  'src/evidence/provenance-component-policy',
];

const DORMANT_SOURCE_MODULES: readonly string[] = [...P8A1_SOURCE_MODULES, ...P8A2_SOURCE_MODULES];

/** Every focused P8-A1 test file. */
const P8A1_TEST_FILES: readonly string[] = [
  'tests/foundation/p8a-contracts.test.ts',
  'tests/foundation/p8a-dormant-closure.test.ts',
  'tests/foundation/p8a-provenance.test.ts',
  'tests/foundation/p8a-publication.test.ts',
  'tests/foundation/p8a-reference-transaction.test.ts',
  'tests/foundation/p8a-sanitize.test.ts',
];

/**
 * The Package-8 tests genuinely discovered by the changed-module audit: the
 * publication test imports the retained exact-byte old-authority writer and the
 * dormancy test imports this frozen manifest. They are registered read-only.
 */
const P8A1_DISCOVERED_TEST_FILES: readonly string[] = [
  'tests/foundation/p8a-dormant-closure.test.ts',
  'tests/foundation/p8a-publication.test.ts',
];

/** The focused P8-B integrity-verifier test registered read-only by ADR 0049. */
const P8B_FOUNDATION_TEST = 'tests/foundation/p8b-integrity-verifier.test.ts';

/** The final v4/suite-v2 authority module prefixes a dormant module must never reach. */
const FINAL_AUTHORITY_PREFIXES: readonly string[] = [
  'src/contracts/final-',
  'src/evidence/final-',
  'src/orchestration/final-',
];

const ACTIVE_PATH_PREFIXES: readonly string[] = [
  'src/cli/',
  'src/runtime/',
  'src/browser/',
  'src/adapters/',
  'src/orchestration/',
];

function readTsFiles(dir: string, prefix: string): { path: string; text: string }[] {
  const files: { path: string; text: string }[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(target);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      files.push({
        path: `${prefix}/${path.relative(dir, target)}`,
        text: readFileSync(target, 'utf8'),
      });
    }
  };
  walk(dir);
  return files;
}

/** The real repository view the closure audit consumes, exactly as it does. */
function repositoryView(): FinalSwitchManifestView {
  return {
    sourceFiles: readTsFiles(path.join(skillRoot, 'src'), 'src'),
    testFiles: readTsFiles(path.join(skillRoot, 'tests'), 'tests'),
    fixturePaths: FINAL_SWITCH_MANIFEST.historicalFixtures.filter((relative) =>
      existsSync(path.join(repoRoot, relative)),
    ),
  };
}

/**
 * Resolve every repository-relative module edge of one file, mirroring the
 * manifest's own specifier resolution so the proof reconciles the real source
 * instead of trusting a hand-written path list.
 */
function moduleEdges(fromPath: string, text: string): readonly string[] {
  const segments = fromPath.split('/').slice(0, -1);
  const targets = new Set<string>();
  for (const specifier of finalSwitchModuleSpecifiers(text)) {
    if (!specifier.startsWith('.')) continue;
    const parts = [...segments];
    for (const part of specifier.split('/')) {
      if (part === '' || part === '.') continue;
      if (part === '..') parts.pop();
      else parts.push(part);
    }
    targets.add(parts.join('/').replace(/\.(ts|js|mjs|cjs)$/, ''));
  }
  return [...targets];
}

describe('[P8-A1] Package-8 closure', () => {
  it('is reached only through exact accepted producer, audit-consumer, and governance-reader registries', () => {
    const view = repositoryView();
    const dormant = new Set(DORMANT_SOURCE_MODULES);
    const activeImporterAllowlist = [
      'src/cli/doctor.ts',
      'src/cli/production-absence.ts',
      'src/orchestration/final-active-path.ts',
    ];
    const importers: string[] = [];
    for (const file of view.sourceFiles) {
      const moduleId = file.path.replace(/\.ts$/, '');
      if (dormant.has(moduleId)) continue;
      const reaches = moduleEdges(file.path, file.text).filter((target) => dormant.has(target));
      if (reaches.length > 0) importers.push(file.path);
    }
    // Every importer of a Package-8 module is either an accepted P8-A active
    // producer importer, P8-B read-only audit consumer, or governance reader.
    const expectedImporters = [
      ...activeImporterAllowlist,
      ...FINAL_SWITCH_AUDIT_CONSUMER_MODULES,
      ...Object.keys(FINAL_SWITCH_GOVERNANCE_EVIDENCE_READERS),
    ].sort();
    expect(importers.sort()).toEqual(expectedImporters);

    // The P8-B audit consumers are dormant read-only: they are never P8-A active
    // producer importers and none of them sits on an active path prefix.
    for (const module of FINAL_SWITCH_AUDIT_CONSUMER_MODULES) {
      expect(activeImporterAllowlist, module).not.toContain(module);
      expect(
        ACTIVE_PATH_PREFIXES.some((prefix) => module.startsWith(prefix)),
        module,
      ).toBe(false);
    }

    // No active path outside the exact ADR-0046 activation allowlist reaches a
    // Package-8 module, and the public barrel exposes no Package-8 surface.
    for (const file of view.sourceFiles) {
      if (!ACTIVE_PATH_PREFIXES.some((prefix) => file.path.startsWith(prefix))) continue;
      if (activeImporterAllowlist.includes(file.path)) continue;
      if (Object.hasOwn(FINAL_SWITCH_GOVERNANCE_EVIDENCE_READERS, file.path)) continue;
      if (FINAL_SWITCH_AUDIT_CONSUMER_MODULES.includes(file.path)) continue;
      expect(
        moduleEdges(file.path, file.text).some((target) => dormant.has(target)),
        file.path,
      ).toBe(false);
    }
    const barrel = readFileSync(path.join(skillRoot, 'src/index.ts'), 'utf8');
    expect(moduleEdges('src/index.ts', barrel).some((target) => dormant.has(target))).toBe(false);

    // AC-3 (ADR 0049) — the two audit consumers and the focused P8-B test stay
    // outside every active identity: active CLI, final authority/façade,
    // retained read-only, producers, E3 write/rollback, P8-A2 active roots, and
    // the four frozen component closures. `integrity.ts` is a read-only
    // consumer, never final authority.
    const activeRoots = Object.values(PROVENANCE_ACTIVE_ENTRY_ROOTS).flat();
    for (const module of FINAL_SWITCH_AUDIT_CONSUMER_MODULES) {
      const governed = `.pi/skills/verify-artwork-editor/${module}`;
      expect(FINAL_SWITCH_MANIFEST.activeCliEntries, module).not.toContain(module);
      expect(FINAL_SWITCH_MANIFEST.finalAuthorityFiles, module).not.toContain(module);
      expect(FINAL_SWITCH_MANIFEST.facadeFiles, module).not.toContain(module);
      expect(FINAL_SWITCH_MANIFEST.retainedReadOnlyFiles, module).not.toContain(module);
      expect(FINAL_SWITCH_MANIFEST.diagnosticProducerFiles, module).not.toContain(module);
      expect(FINAL_SWITCH_MANIFEST.commandProducerFiles, module).not.toContain(module);
      expect(FINAL_SWITCH_MANIFEST.contractsEvidenceFiles, module).not.toContain(module);
      expect(FINAL_SWITCH_MANIFEST.plannerOrchestrationFiles, module).not.toContain(module);
      expect(FINAL_SWITCH_E3_WRITE_SET, module).not.toContain(module);
      expect(FINAL_SWITCH_E3_ROLLBACK_FILES, module).not.toContain(module);
      expect(FINAL_SWITCH_MANIFEST.e2rWriteSet, module).not.toContain(module);
      expect(activeRoots, module).not.toContain(governed);
      for (const flow of FLOWS) {
        expect(PROVENANCE_COMPONENT_POLICY.frozenClosures[flow], `${flow}/${module}`).not.toContain(
          governed,
        );
      }
    }
    expect(FINAL_SWITCH_MANIFEST.finalModuleImporters).toContain('src/evidence/integrity.ts');
    expect(FINAL_SWITCH_MANIFEST.finalAuthorityFiles).not.toContain('src/evidence/integrity.ts');
    expect(FINAL_SWITCH_E3_WRITE_SET).not.toContain(P8B_FOUNDATION_TEST);
    expect(FINAL_SWITCH_E3_ROLLBACK_FILES).not.toContain(P8B_FOUNDATION_TEST);
    expect(FINAL_SWITCH_MANIFEST.e2rWriteSet).not.toContain(P8B_FOUNDATION_TEST);
  });

  it('keeps the strict v4 and suite-v2 correctness schemas unchanged', () => {
    expect(FINAL_CURRENT_CHILD_RECORD_SCHEMA_VERSION).toBe(4);
    expect(FINAL_SUITE_RECORD_SCHEMA_VERSION).toBe(2);
    expect(EVIDENCE_SEALED_STRICT_SCHEMAS).toEqual({
      runRecordSchemaVersion: 4,
      suiteRecordSchemaVersion: 2,
      currentChildRecordLabel: 'current-v4',
      suiteRecordLabel: 'suite-v2',
    });

    // A dormant Package-8 module must never reach or widen a final v4/suite module.
    for (const moduleId of DORMANT_SOURCE_MODULES) {
      const text = readFileSync(path.join(skillRoot, `${moduleId}.ts`), 'utf8');
      const reachesFinal = moduleEdges(`${moduleId}.ts`, text).some((target) =>
        FINAL_AUTHORITY_PREFIXES.some((prefix) => target.startsWith(prefix)),
      );
      expect(reachesFinal, moduleId).toBe(false);
    }

    // AC-7 (ADR 0049) — inventory-v1 and manifest-v1 remain sealed and the
    // closure bookkeeping is complete without reopening the strict schemas.
    expect(EVIDENCE_INTENDED_INVENTORY_SCHEMA_VERSION).toBe(1);
    expect(EVIDENCE_FINAL_MANIFEST_SCHEMA_VERSION).toBe(1);
    expect(EVIDENCE_INTENDED_INVENTORY_LABEL).toBe('intended-inventory.v1');
    expect(EVIDENCE_FINAL_MANIFEST_LABEL).toBe('final-manifest.v1');
    expect(finalSwitchManifestIssues(repositoryView())).toEqual([]);
    expect(FINAL_SWITCH_MANIFEST.finalModuleImporters).toContain('src/evidence/integrity.ts');
    expect(FINAL_SWITCH_MANIFEST.discoveredChangedModuleTests).toContain(P8B_FOUNDATION_TEST);
    for (const fixture of FINAL_SWITCH_MANIFEST.historicalFixtures) {
      expect(FINAL_SWITCH_E3_WRITE_SET, fixture).not.toContain(fixture);
    }
  });

  it('registers the exact read-only Package-8 closure edges with no CLI activation', () => {
    expect(finalSwitchManifestIssues(repositoryView())).toEqual([]);
    expect(FINAL_SWITCH_MANIFEST.retainedReadOnlyFiles).toContain('src/evidence/publication.ts');
    for (const test of P8A1_TEST_FILES) {
      expect(FINAL_SWITCH_MANIFEST.migratedTests, test).not.toContain(test);
      expect(FINAL_SWITCH_MANIFEST.replacedArchitectureTests, test).not.toContain(test);
      expect(FINAL_SWITCH_MANIFEST.retainedTestSupport, test).not.toContain(test);
    }
    for (const test of P8A1_DISCOVERED_TEST_FILES) {
      expect(FINAL_SWITCH_MANIFEST.discoveredChangedModuleTests, test).toContain(test);
    }
    const registeredP8a1 = FINAL_SWITCH_MANIFEST.discoveredChangedModuleTests.filter((entry) =>
      P8A1_TEST_FILES.includes(entry),
    );
    expect([...registeredP8a1].sort()).toEqual([...P8A1_DISCOVERED_TEST_FILES].sort());
    for (const entry of FINAL_SWITCH_MANIFEST.activeCliEntries) {
      const text = readFileSync(path.join(skillRoot, entry), 'utf8');
      expect(
        moduleEdges(entry, text).some((target) => P8A1_SOURCE_MODULES.includes(target)),
        entry,
      ).toBe(false);
    }

    // AC-1 (ADR 0049) — the audit-consumer registry is immutable, sorted,
    // duplicate-free, and exactly the two named modules with no wildcard,
    // prefix, or directory-derived inclusion.
    expect(Object.isFrozen(FINAL_SWITCH_AUDIT_CONSUMER_MODULES)).toBe(true);
    expect([...FINAL_SWITCH_AUDIT_CONSUMER_MODULES]).toEqual([
      'src/contracts/evidence-verify.ts',
      'src/evidence/integrity.ts',
    ]);
    expect([...FINAL_SWITCH_AUDIT_CONSUMER_MODULES]).toEqual(
      [...FINAL_SWITCH_AUDIT_CONSUMER_MODULES].sort(),
    );
    expect(new Set(FINAL_SWITCH_AUDIT_CONSUMER_MODULES).size).toBe(
      FINAL_SWITCH_AUDIT_CONSUMER_MODULES.length,
    );
    const dormantModules = new Set(DORMANT_SOURCE_MODULES);
    const governedEdges = (module: string): readonly string[] =>
      moduleEdges(module, readFileSync(path.join(skillRoot, module), 'utf8'));
    const view = repositoryView();
    for (const module of FINAL_SWITCH_AUDIT_CONSUMER_MODULES) {
      expect(module, module).toMatch(/^src\/[a-z0-9-]+\/[a-z0-9-]+\.ts$/);
      expect(module, module).not.toContain('*');
      expect(existsSync(path.join(skillRoot, module)), module).toBe(true);
    }

    // AC-2 (ADR 0049) — both registered modules really import a governed dormant
    // Package-8 module; `integrity.ts` really reaches an accepted final module;
    // an unregistered copy of that required edge fails the real audit; and
    // edge-free entries fail the registry's own real-edge validator.
    for (const module of FINAL_SWITCH_AUDIT_CONSUMER_MODULES) {
      expect(
        governedEdges(module).some((target) => dormantModules.has(target)),
        `${module} reaches a governed dormant Package-8 module`,
      ).toBe(true);
    }
    expect(
      governedEdges('src/evidence/integrity.ts').some((target) =>
        FINAL_AUTHORITY_PREFIXES.some((prefix) => target.startsWith(prefix)),
      ),
    ).toBe(true);
    const unregisteredEdge: FinalSwitchManifestView = {
      sourceFiles: [
        ...view.sourceFiles,
        {
          path: 'src/evidence/integrity-unregistered.ts',
          text: readFileSync(path.join(skillRoot, 'src/evidence/integrity.ts'), 'utf8'),
        },
      ],
      testFiles: view.testFiles,
      fixturePaths: view.fixturePaths,
    };
    expect(finalSwitchManifestIssues(unregisteredEdge).map((entry) => entry.code)).toContain(
      'MANIFEST_FINAL_EDGE_UNMANIFESTED',
    );
    const edgeFree = (entries: readonly string[]): string[] =>
      entries.filter(
        (module) => !governedEdges(module).some((target) => dormantModules.has(target)),
      );
    expect(edgeFree(FINAL_SWITCH_AUDIT_CONSUMER_MODULES)).toEqual([]);
    expect(edgeFree(['src/runtime/paths.ts'])).toEqual(['src/runtime/paths.ts']);

    // AC-4 (ADR 0049) — rogue source importers, final-module importers, and
    // changed-module tests still fail with the applicable closure codes.
    const withSource = (path: string, text: string): FinalSwitchManifestView => ({
      sourceFiles: [...view.sourceFiles, { path, text }],
      testFiles: view.testFiles,
      fixturePaths: view.fixturePaths,
    });
    const withTest = (path: string, text: string): FinalSwitchManifestView => ({
      sourceFiles: view.sourceFiles,
      testFiles: [...view.testFiles, { path, text }],
      fixturePaths: view.fixturePaths,
    });
    expect(
      finalSwitchManifestIssues(
        withSource(
          'src/cli/rogue-audit-consumer.ts',
          "import { classifyOutcome } from '../runtime/outcomes';\n",
        ),
      ).map((entry) => entry.code),
    ).toContain('MANIFEST_SRC_CLOSURE_INCOMPLETE');
    expect(
      finalSwitchManifestIssues(
        withSource(
          'src/evidence/rogue-final-consumer.ts',
          "import { readFinalPublicRecord } from '../contracts/final-public-record';\n",
        ),
      ).map((entry) => entry.code),
    ).toContain('MANIFEST_FINAL_EDGE_UNMANIFESTED');
    expect(
      finalSwitchManifestIssues(
        withTest(
          'tests/foundation/rogue-p8b-consumer.test.ts',
          "import { readFinalPublicRecord } from '../../src/contracts/final-public-record';\n",
        ),
      ).map((entry) => entry.code),
    ).toContain('MANIFEST_TEST_CLOSURE_INCOMPLETE');
  });

  it('admits only exact prospective governance reader edges without widening historical authority', () => {
    const registry = FINAL_SWITCH_GOVERNANCE_EVIDENCE_READERS;
    expect(Object.isFrozen(registry)).toBe(true);
    expect(registry).toEqual({
      'src/governance/qualification-runtime.ts': [
        'src/contracts/final-public-record',
        'src/evidence/integrity',
        'src/evidence/provenance-collector',
      ],
      'src/governance/release-runtime.ts': ['src/evidence/provenance-collector'],
      'src/governance/budget.ts': [
        'src/contracts/final-public-record',
        'src/contracts/final-record-v4',
        'src/evidence/final-reader',
        'src/evidence/provenance-collector',
      ],
    });
    const governedTarget = (target: string) =>
      DORMANT_SOURCE_MODULES.includes(target) ||
      target === 'src/evidence/integrity' ||
      FINAL_AUTHORITY_PREFIXES.some((prefix) => target.startsWith(prefix));
    const actualEdges = (module: string, source: string) =>
      [...new Set(moduleEdges(module, source).filter(governedTarget))].sort();
    for (const [module, targets] of Object.entries(registry)) {
      expect(Object.isFrozen(targets)).toBe(true);
      const source = readFileSync(path.join(skillRoot, module), 'utf8');
      expect(actualEdges(module, source)).toEqual(targets);
      expect(actualEdges(module, source + "\nimport '../evidence/publication';")).not.toEqual(
        targets,
      );
      expect(FINAL_SWITCH_AUDIT_CONSUMER_MODULES).not.toContain(module);
      const importsFinalAuthority = targets.some((target) =>
        FINAL_AUTHORITY_PREFIXES.some((prefix) => target.startsWith(prefix)),
      );
      if (importsFinalAuthority)
        expect(FINAL_SWITCH_MANIFEST.finalModuleImporters).toContain(module);
      else expect(FINAL_SWITCH_MANIFEST.finalModuleImporters).not.toContain(module);
      for (const entries of [
        FINAL_SWITCH_MANIFEST.finalAuthorityFiles,
        FINAL_SWITCH_MANIFEST.diagnosticProducerFiles,
        FINAL_SWITCH_MANIFEST.commandProducerFiles,
        FINAL_SWITCH_E3_WRITE_SET,
        FINAL_SWITCH_E3_ROLLBACK_FILES,
      ])
        expect(entries).not.toContain(module);
      const governed = `.pi/skills/verify-artwork-editor/${module}`;
      expect(Object.values(PROVENANCE_ACTIVE_ENTRY_ROOTS).flat()).not.toContain(governed);
      for (const flow of FLOWS)
        expect(PROVENANCE_COMPONENT_POLICY.frozenClosures[flow]).not.toContain(governed);
    }
    const view = repositoryView();
    expect(
      finalSwitchManifestIssues({
        ...view,
        sourceFiles: [
          ...view.sourceFiles,
          {
            path: 'src/governance/unregistered-reader.ts',
            text: "import { readFinalPublicRecord } from '../contracts/final-public-record';",
          },
        ],
      }).map((issue) => issue.code),
    ).toContain('MANIFEST_FINAL_EDGE_UNMANIFESTED');
  });

  it('preserves the frozen E3 write and rollback invariants unchanged', () => {
    expect(FINAL_SWITCH_E3_WRITE_SET).toHaveLength(88);
    expect([...FINAL_SWITCH_E3_WRITE_SET].sort()).toEqual(
      [...FINAL_SWITCH_E3_ROLLBACK_FILES].sort(),
    );
    expect(FINAL_SWITCH_MANIFEST.e3WriteSet).toEqual(FINAL_SWITCH_E3_WRITE_SET);
    expect(FINAL_SWITCH_MANIFEST.rollbackFiles).toEqual(FINAL_SWITCH_E3_ROLLBACK_FILES);
    expect(FINAL_SWITCH_MANIFEST.e3RollbackBaseline).toBe('accepted-e2r-tree');
    for (const moduleId of DORMANT_SOURCE_MODULES) {
      expect(FINAL_SWITCH_E3_WRITE_SET).not.toContain(`${moduleId}.ts`);
    }
    for (const test of P8A1_TEST_FILES) {
      expect(FINAL_SWITCH_E3_WRITE_SET).not.toContain(test);
    }

    // AC-6 (ADR 0049) — the E3 write and rollback sets stay at exactly 88 paths
    // with the P8-B consumers and the focused test outside both.
    expect(FINAL_SWITCH_E3_ROLLBACK_FILES).toHaveLength(88);
    for (const module of FINAL_SWITCH_AUDIT_CONSUMER_MODULES) {
      expect(FINAL_SWITCH_E3_WRITE_SET, module).not.toContain(module);
      expect(FINAL_SWITCH_E3_ROLLBACK_FILES, module).not.toContain(module);
    }
    expect(FINAL_SWITCH_E3_WRITE_SET).not.toContain(P8B_FOUNDATION_TEST);
    expect(FINAL_SWITCH_E3_ROLLBACK_FILES).not.toContain(P8B_FOUNDATION_TEST);
  });

  it('accepts cross-realm Uint8Array evidence bytes through a realm-safe predicate', () => {
    const foreign = vm.runInNewContext(
      'new Uint8Array([123, 34, 97, 34, 58, 49, 125])',
    ) as Uint8Array;
    // The realm crossing is real: a `instanceof Uint8Array` guard would reject it.
    expect(foreign instanceof Uint8Array).toBe(false);
    expect(isEvidenceByteSequence(foreign)).toBe(true);
    expect(isEvidenceByteSequence({ [Symbol.toStringTag]: 'Uint8Array' })).toBe(false);

    const text = new TextDecoder().decode(foreign);
    expect(text).toBe('{"a":1}');
    expect(deriveSemanticDigest('byte-stream', foreign)).toBe(
      deriveSemanticDigest('byte-stream', text),
    );

    const state = sanitizeArtifactBytes({
      artifactId: 'artifact:cross-realm',
      relativePath: 'files/cross-realm.json',
      role: 'diagnostic-only',
      policy: 'public-json-guard-v1',
      bytes: foreign,
    });
    const view = inspectSanitizationApproval(state);
    expect(view.approval).toBe('approved');
    expect(view.sha256).toBe(sha256Hex(text));
  });
});

/**
 * P8-A2 A2-4 provenance closure + flow-identity drift proof (ADR 0046 A2-3/A2-4).
 *
 * Two independent regressions are covered:
 *
 * 1. the frozen post-activation *component closures* are regenerated here from a
 *    private recursive static `import`/`re-export` traversal of the live
 *    `src/**` graph, entirely independent of the policy arrays, and compared for
 *    exact set equality across all four flows;
 * 2. `finalProvenance` binds closed, deterministic, flow-specific catalogue and
 *    profile identities derived from the real accepted prepared-record and
 *    environment/command authorities, never empty and never schema-widening.
 */

const FLOWS: readonly ProvenanceFlow[] = [
  'diagnostic',
  'doctor',
  'production-absence',
  'suite-child',
];

/** The four authoritative closure counts accepted for A2-3 post-activation. */
const EXPECTED_CLOSURE_COUNTS: Readonly<Record<ProvenanceFlow, number>> = Object.freeze({
  diagnostic: 156,
  doctor: 156,
  'production-absence': 159,
  'suite-child': 158,
});

// ── Independent static closure traversal ─────────────────────────────────────

/**
 * Every repository-local module specifier a source text imports, re-exports, or
 * dynamically imports. This is a deliberately private re-implementation (never
 * the production `finalSwitchModuleSpecifiers`) so the traversal cannot agree
 * with the policy by construction.
 */
function staticModuleSpecifiers(text: string): readonly string[] {
  const specifiers = new Set<string>();
  for (const match of text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) specifiers.add(match[1]!);
  for (const match of text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) specifiers.add(match[1]!);
  for (const match of text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g))
    specifiers.add(match[1]!);
  return [...specifiers];
}

/** Resolve one relative specifier against an importing `src/`-relative module. */
function resolveRelative(fromModule: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const segments = fromModule.split('/').slice(0, -1);
  for (const part of specifier.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') segments.pop();
    else segments.push(part);
  }
  return segments.join('/').replace(/\.(ts|js|mjs|cjs)$/, '');
}

/** Every `src/`-relative TypeScript module and its source text. */
function readSourceGraph(): Map<string, string> {
  const graph = new Map<string, string>();
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(absolute, relative);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      graph.set(relative, readFileSync(absolute, 'utf8'));
    }
  };
  walk(path.join(skillRoot, 'src'), '');
  return graph;
}

const sourceGraph = readSourceGraph();

/** The recursive static closure of the active roots, as governed repo-relative paths. */
function computeClosure(roots: readonly string[]): readonly string[] {
  const closure = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const root = pending.pop()!;
    const module = root
      .replace(/^\.pi\/skills\/verify-artwork-editor\/src\//, '')
      .replace(/\.ts$/, '');
    if (closure.has(module)) continue;
    const text = sourceGraph.get(module) ?? sourceGraph.get(`${module}.ts`);
    if (text === undefined) {
      throw new Error(`Unresolved repository-local module: ${root}`);
    }
    closure.add(module);
    for (const specifier of staticModuleSpecifiers(text)) {
      const target = resolveRelative(module, specifier);
      if (target !== null) pending.push(target);
    }
  }
  return [...closure].sort().map((module) => `src/${module}.ts`);
}

describe('[P8-A2 A2-4] frozen component closures regenerate exactly', () => {
  it('rebuilds every flow closure from the live src graph and matches the frozen arrays exactly', () => {
    for (const flow of FLOWS) {
      const recomputed = computeClosure(PROVENANCE_ACTIVE_ENTRY_ROOTS[flow]);
      const frozen = PROVENANCE_COMPONENT_POLICY.frozenClosures[flow];
      const frozenSet = new Set(frozen);
      const recomputedSet = new Set(recomputed);
      const missing = recomputed.filter((entry) => !frozenSet.has(entry));
      const extra = frozen.filter((entry) => !recomputedSet.has(entry));
      expect(missing, `${flow}: absent from frozen closure`).toEqual([]);
      expect(extra, `${flow}: present only in frozen closure`).toEqual([]);
      expect(recomputed.length, `${flow}: closure count`).toBe(EXPECTED_CLOSURE_COUNTS[flow]);
      expect(frozen.length, `${flow}: frozen count`).toBe(EXPECTED_CLOSURE_COUNTS[flow]);
    }

    // AC-5 (ADR 0049) — the four forward closures regenerate exactly at
    // 156/156/159/158 and never include a P8-B audit consumer.
    expect(EXPECTED_CLOSURE_COUNTS).toEqual({
      diagnostic: 156,
      doctor: 156,
      'production-absence': 159,
      'suite-child': 158,
    });
    for (const flow of FLOWS) {
      const recomputed = computeClosure(PROVENANCE_ACTIVE_ENTRY_ROOTS[flow]);
      for (const module of FINAL_SWITCH_AUDIT_CONSUMER_MODULES) {
        expect(recomputed, `${flow} excludes ${module}`).not.toContain(
          `.pi/skills/verify-artwork-editor/${module}`,
        );
      }
    }
  });

  it('keeps every frozen closure sorted and duplicate-free', () => {
    for (const flow of FLOWS) {
      const frozen = [...PROVENANCE_COMPONENT_POLICY.frozenClosures[flow]];
      const sorted = [...new Set(frozen)].sort();
      expect(frozen, `${flow}: sorted and unique`).toEqual(sorted);
    }
  });

  it('binds runtime/environment-facts.ts into the production-absence closure', () => {
    const productionAbsence = PROVENANCE_COMPONENT_POLICY.frozenClosures['production-absence'];
    expect(productionAbsence).toContain(
      'src/runtime/environment-facts.ts',
    );
  });
});

// ── Flow-specific provenance identities ──────────────────────────────────────

const HEX = (character: string): string => character.repeat(64);

/** The prepared-record argument type of the identity adapter (private to the test). */
type PreparedRecordArg = Parameters<typeof deriveFlowProvenanceIdentities>[1];

const environmentAuthority = (() => {
  const catalogue = loadEnvironmentCatalogue();
  return { catalogue, cell: resolveEnvironmentCell(catalogue) };
})();

function runRecord(): PreparedRecordArg {
  return {
    command: 'diagnostic',
    profile: 'action-cycle-v1',
    resolvedProfileFingerprint: HEX('a'),
    componentFingerprints: {
      readiness: HEX('b'),
      capture: HEX('c'),
      oracle: HEX('d'),
      capabilityBaseline: HEX('e'),
      subjectAddition: HEX('f'),
      requiredCheckSet: HEX('1'),
      tolerances: HEX('2'),
      visuals: HEX('3'),
      normalization: HEX('4'),
    },
    fingerprints: {
      registry: HEX('5'),
      applicationInventory: HEX('6'),
      operationCatalogue: HEX('7'),
      adapterCatalogue: HEX('8'),
      workflowCatalogue: HEX('9'),
      workflowSteps: HEX('b'),
      coverageModel: HEX('c'),
      readinessProfile: HEX('d'),
      oracleProfile: HEX('e'),
    },
  } as unknown as PreparedRecordArg;
}

function commandRecord(
  command: 'doctor' | 'production-absence',
  authority: { readonly commandAuthorityId: string; readonly commandAuthorityFingerprint: string },
): PreparedRecordArg {
  return { command, commandAuthority: authority } as unknown as PreparedRecordArg;
}

const doctorRecord = commandRecord('doctor', DOCTOR_COMMAND_STATUS_AUTHORITY);
const productionRecord = commandRecord(
  'production-absence',
  PRODUCTION_ABSENCE_COMMAND_STATUS_AUTHORITY,
);

function identifiers(entries: readonly { readonly id: string }[]): string[] {
  return entries.map((entry) => entry.id);
}

function expectClosedIdentities(
  entries: readonly { readonly id: string; readonly digest: string }[],
): void {
  const ids = identifiers(entries);
  expect(new Set(ids).size, 'identity ids are unique').toBe(ids.length);
  expect(ids, 'identity ids are sorted').toEqual([...ids].sort());
  for (const entry of entries) {
    expect(entry.digest, `${entry.id} digest is lowercase SHA-256`).toMatch(/^[a-f0-9]{64}$/);
  }
}

describe('[P8-A2 A2-4] flow-specific provenance identities', () => {
  it('binds non-empty materialized catalogue/profile identities for Diagnostic and suite-child', () => {
    for (const flow of ['diagnostic', 'suite-child'] as const) {
      const identities = deriveFlowProvenanceIdentities(flow, runRecord(), null);
      expect(identities.catalogueIdentities.length).toBeGreaterThan(0);
      expect(identities.profileIdentities.length).toBeGreaterThan(0);
      expectClosedIdentities(identities.catalogueIdentities);
      expectClosedIdentities(identities.profileIdentities);
      expect(identifiers(identities.catalogueIdentities)).toContain('catalogue:registry');
      expect(identifiers(identities.profileIdentities)).toContain(
        'profile:resolved:action-cycle-v1',
      );
      expect(
        identifiers(identities.profileIdentities).some((id) => id.startsWith('component:')),
      ).toBe(true);
    }
  });

  it('binds command authority plus environment catalogue/cell for Doctor with empty profiles', () => {
    const identities = deriveFlowProvenanceIdentities('doctor', doctorRecord, environmentAuthority);
    expect(identities.profileIdentities).toEqual([]);
    expectClosedIdentities(identities.catalogueIdentities);
    const ids = identifiers(identities.catalogueIdentities);
    expect(ids).toContain('command-authority:doctor-result-v7');
    expect(ids).toContain('environment:catalogue');
    expect(ids).toContain('environment:cell:chromium-desktop-1440x1000');
    expect(ids).not.toContain('production-absence:contract');
    expect(ids).not.toContain('production-absence:static-scan-policy');
  });

  it('adds production-absence contract and static-scan policy identities with empty profiles', () => {
    const identities = deriveFlowProvenanceIdentities(
      'production-absence',
      productionRecord,
      environmentAuthority,
    );
    expect(identities.profileIdentities).toEqual([]);
    expectClosedIdentities(identities.catalogueIdentities);
    const ids = identifiers(identities.catalogueIdentities);
    expect(ids).toContain('command-authority:production-absence-v1');
    expect(ids).toContain('environment:catalogue');
    expect(ids).toContain('environment:cell:chromium-desktop-1440x1000');
    expect(ids).toContain('production-absence:contract');
    expect(ids).toContain('production-absence:static-scan-policy');
  });

  it('is deterministic and differs where the flow authority differs', () => {
    const first = deriveFlowProvenanceIdentities('doctor', doctorRecord, environmentAuthority);
    const second = deriveFlowProvenanceIdentities('doctor', doctorRecord, environmentAuthority);
    expect(second).toEqual(first);

    const doctorIds = identifiers(first.catalogueIdentities);
    const productionIds = identifiers(
      deriveFlowProvenanceIdentities('production-absence', productionRecord, environmentAuthority)
        .catalogueIdentities,
    );
    expect(doctorIds).not.toEqual(productionIds);

    const run = deriveFlowProvenanceIdentities('diagnostic', runRecord(), null);
    expect(identifiers(run.catalogueIdentities)).not.toEqual(doctorIds);
    expect(identifiers(run.profileIdentities).length).toBeGreaterThan(
      identifiers(first.profileIdentities).length,
    );
  });

  it('refuses a record family that contradicts the declared flow', () => {
    expect(() => deriveFlowProvenanceIdentities('diagnostic', doctorRecord, null)).toThrow();
    expect(() =>
      deriveFlowProvenanceIdentities('doctor', runRecord(), environmentAuthority),
    ).toThrow();
    expect(() => deriveFlowProvenanceIdentities('doctor', doctorRecord, null)).toThrow();
  });

  it('remains a complete closed record that validates without a schema widening', () => {
    const identities = deriveFlowProvenanceIdentities(
      'production-absence',
      productionRecord,
      environmentAuthority,
    );
    const provenance = buildEvidenceProvenance({
      repositoryRevision: 'a'.repeat(40),
      dirtyPolicy: 'dirty-governed',
      governedEntries: [{ path: 'src/a.ts', sha256: HEX('a') }],
      lockfileDigest: HEX('b'),
      cliBootstrapDigest: HEX('c'),
      runnerDigest: HEX('d'),
      evidenceWriterDigest: HEX('e'),
      verifierDigest: HEX('f'),
      runtimeEngineDigest: HEX('1'),
      catalogueIdentities: identities.catalogueIdentities,
      profileIdentities: identities.profileIdentities,
    });
    expect(validateGovernedProvenance(provenance)).toEqual([]);
    expect(provenance.catalogueIdentities.length).toBe(identities.catalogueIdentities.length);
  });
});

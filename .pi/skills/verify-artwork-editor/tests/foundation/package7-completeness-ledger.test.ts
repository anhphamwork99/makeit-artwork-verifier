import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ACCEPTED_REPRESENTATIVE_SUITE_EXECUTION_ID,
  PACKAGE7_COMPLETENESS_DIMENSIONS,
  PACKAGE7_COMPLETENESS_LEDGER_RELATIVE_PATH,
  PACKAGE7_COMPLETENESS_LEDGER_SCHEMA_VERSION,
  PACKAGE7_COMPLETENESS_STATUSES,
  buildPackage7CompletenessLedger,
  completenessLedgerArtifactPath,
  deriveCorrectnessCatalogueFingerprint,
  isPackage7AcceptedSuiteState,
  isPackage7CompletenessDimension,
  isPackage7CompletenessStatus,
  loadDiagnosticSuite,
  persistCompletenessLedgerFile,
  projectAcceptedRepresentativeSuite,
  resolveSuiteRequests,
  serializeCompletenessLedger,
} from '../../src/index';
import type { CatalogueBundle } from '../../src/index';
import { deriveCoverageModelFingerprint } from '../../src/catalogue/fingerprint';
import { selectCoverage } from '../../src/coverage/select';
import { resolveSkillRoot } from '../../src/runtime/paths';
import { defaultBundle } from './helpers';

/**
 * Package 7 Slice C completeness ledger tests (gap-plan §5 P7-C; ADR 0039).
 *
 * These tests prove the ledger is closed, deterministic, byte-stable, and that
 * every dimension stays separate: the 65 declared bindings, 7 Coverage Models,
 * 55 selected Release assignments, 8 accepted representative Diagnostic cases,
 * 7 compiled profiles, diagnostic-only scenarios, runtime availability, and
 * Release credit are never collapsed into one another and Release credit is
 * always false. No browser launch and no product-source write occurs.
 */

const SUITE_ID = ACCEPTED_REPRESENTATIVE_SUITE_EXECUTION_ID;
const evidenceRoot = path.join(resolveSkillRoot(), 'evidence');
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function buildDefault() {
  return buildPackage7CompletenessLedger({ bundle: defaultBundle() });
}

/** A bundle whose semantically unordered authoring arrays are reversed. */
function reorderedBundle(): CatalogueBundle {
  const bundle = defaultBundle();
  return {
    ...bundle,
    coverageCatalogue: {
      ...bundle.coverageCatalogue,
      models: [...bundle.coverageCatalogue.models].reverse(),
    },
    subjectCatalogue: {
      ...bundle.subjectCatalogue,
      declarations: [...bundle.subjectCatalogue.declarations].reverse(),
    },
  };
}

/** A bundle with the correctness route-selection authoring order reversed. */
function reversedRouteSelectionBundle(): CatalogueBundle {
  const bundle = defaultBundle();
  return {
    ...bundle,
    correctnessCatalogue: {
      ...bundle.correctnessCatalogue,
      routeSelections: [...bundle.correctnessCatalogue.routeSelections].reverse(),
    },
  };
}

function sha256File(target: string): { sha256: string; bytes: number } {
  const bytes = readFileSync(target);
  return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}

/**
 * Copies the accepted suite record and exactly its eight strict-v4 child run
 * records into a private temporary evidence root, so the failure matrix can
 * tamper with an isolated copy and never mutates the accepted historical
 * evidence.
 */
function privateAcceptedEvidenceRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'p7c-evidence-'));
  tempRoots.push(root);
  const suiteDir = path.join(evidenceRoot, 'suites', SUITE_ID);
  mkdirSync(path.join(root, 'suites'), { recursive: true });
  cpSync(suiteDir, path.join(root, 'suites', SUITE_ID), { recursive: true });
  const record = JSON.parse(readFileSync(path.join(suiteDir, 'suite-record.json'), 'utf8')) as {
    children: { runId: string }[];
  };
  for (const child of record.children) {
    mkdirSync(path.join(root, 'runs'), { recursive: true });
    cpSync(path.join(evidenceRoot, 'runs', child.runId), path.join(root, 'runs', child.runId), {
      recursive: true,
    });
  }
  return root;
}

function declaredRepresentativeMembers(): { order: number; caseId: string; request: string }[] {
  return resolveSuiteRequests(loadDiagnosticSuite('representative')).map((member) => ({
    order: member.declaration.order,
    caseId: member.declaration.caseId,
    request: member.declaration.request,
  }));
}

function suiteRecordAbsolute(root: string): string {
  return path.join(root, 'suites', SUITE_ID, 'suite-record.json');
}

function readSuiteRecord(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(suiteRecordAbsolute(root), 'utf8')) as Record<string, unknown>;
}

function writeSuiteRecord(root: string, value: unknown): void {
  writeFileSync(suiteRecordAbsolute(root), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function runRecordAbsolute(root: string, runId: string): string {
  return path.join(root, 'runs', runId, 'run-record.json');
}

describe('[P7-C] closed completeness ledger contract', () => {
  it('declares exactly the six separate dimensions and closed vocabularies', () => {
    expect(PACKAGE7_COMPLETENESS_LEDGER_SCHEMA_VERSION).toBe(1);
    expect(PACKAGE7_COMPLETENESS_DIMENSIONS).toEqual([
      'binding-model',
      'correctness-profile',
      'runtime-availability',
      'release-assignment',
      'diagnostic-scenario',
      'release-credit',
    ]);
    expect(PACKAGE7_COMPLETENESS_STATUSES).toEqual([
      'complete',
      'incomplete',
      'unavailable',
      'deferred',
    ]);
    expect(isPackage7CompletenessDimension('binding-model')).toBe(true);
    expect(isPackage7CompletenessDimension('release-ready')).toBe(false);
    expect(isPackage7CompletenessStatus('incomplete')).toBe(true);
    expect(isPackage7CompletenessStatus('passed')).toBe(false);
    expect(isPackage7AcceptedSuiteState('accepted')).toBe(true);
    expect(isPackage7AcceptedSuiteState('credited')).toBe(false);
    expect(PACKAGE7_COMPLETENESS_LEDGER_RELATIVE_PATH).toBe(
      'evidence/package7-completeness-ledger.v1.json',
    );
  });

  it('reports every dimension and count as its own separate quantity', () => {
    const { ledger } = buildDefault();
    expect(ledger.schemaVersion).toBe(1);
    expect(ledger.artifactId).toBe('package7-completeness-ledger');
    expect(ledger.branch).toBe('P7-C');
    expect(ledger.catalogueFingerprint).toBe(
      deriveCorrectnessCatalogueFingerprint(defaultBundle().correctnessCatalogue),
    );
    expect(ledger.dimensions.map((entry) => entry.dimension)).toEqual([
      ...PACKAGE7_COMPLETENESS_DIMENSIONS,
    ]);
    const byName = new Map(ledger.dimensions.map((entry) => [entry.dimension, entry]));
    expect(byName.get('binding-model')?.count).toBe(65);
    expect(byName.get('correctness-profile')?.count).toBe(7);
    expect(byName.get('runtime-availability')?.count).toBe(7);
    expect(byName.get('release-assignment')?.count).toBe(55);
    expect(byName.get('diagnostic-scenario')?.count).toBe(11);
    expect(byName.get('release-credit')?.count).toBe(0);
    // No dimension may borrow another dimension's count.
    expect(byName.get('binding-model')?.count).not.toBe(byName.get('release-assignment')?.count);
    expect(byName.get('release-assignment')?.count).not.toBe(
      byName.get('diagnostic-scenario')?.count,
    );
  });

  it('keeps 65 declared bindings, 55 selected assignments, and 8 accepted cases non-conflated', () => {
    const { ledger } = buildDefault();
    expect(ledger.counts).toMatchObject({
      declaredBindings: 65,
      coverageModels: 7,
      bindingsWithoutModels: 58,
      compiledProfiles: 7,
      selectedReleaseAssignments: 55,
      releaseAssignmentsExecuted: 0,
      acceptedRepresentativeCases: 8,
      diagnosticOnlyScenarios: 11,
      runtimeAvailableSelections: 7,
    });
    expect(ledger.counts.selectedReleaseAssignments).not.toBe(
      ledger.counts.acceptedRepresentativeCases,
    );
    expect(ledger.counts.declaredBindings).not.toBe(ledger.counts.selectedReleaseAssignments);
    expect(ledger.bindings).toHaveLength(65);
    expect(
      ledger.bindings.reduce<Record<string, number>>((acc, entry) => {
        acc[entry.state] = (acc[entry.state] ?? 0) + 1;
        return acc;
      }, {}),
    ).toEqual({ 'compiled-profile': 6, 'coverage-model-only': 1, 'profile-unavailable': 58 });
  });

  it('derives the per-model Release/Diagnostic splits through the selector, never hardcoded', () => {
    const bundle = defaultBundle();
    const { ledger } = buildDefault();
    let releaseSum = 0;
    let diagnosticOnlySum = 0;
    for (const entry of ledger.coverageModels) {
      const model = bundle.coverageCatalogue.models.find(
        (candidate) =>
          candidate.subjectId === entry.subjectId && candidate.capability === entry.capability,
      );
      if (!model) throw new Error(`missing model ${entry.subjectId}|${entry.capability}`);
      const modelFingerprint = deriveCoverageModelFingerprint(model);
      const release = selectCoverage({ model, modelFingerprint, profile: 'release', seed: null });
      const diagnostic = selectCoverage({
        model,
        modelFingerprint,
        profile: 'diagnostic',
        seed: null,
      });
      expect(entry.modelFingerprint).toBe(modelFingerprint);
      expect(entry.selectedReleaseAssignments).toBe(release.cases.length);
      expect(entry.selectedDiagnosticCases).toBe(diagnostic.cases.length);
      expect(entry.selectedDiagnosticCases).toBeGreaterThanOrEqual(
        entry.selectedReleaseAssignments,
      );
      expect(entry.diagnosticOnlyScenarios).toBe(
        model.scenarios.filter((scenario) => scenario.eligibility === 'diagnostic-only').length,
      );
      releaseSum += entry.selectedReleaseAssignments;
      diagnosticOnlySum += entry.diagnosticOnlyScenarios;
    }
    expect(ledger.coverageModels).toHaveLength(7);
    expect(releaseSum).toBe(55);
    expect(diagnosticOnlySum).toBe(11);
  });

  it('reports model-only and profile-unavailable states without false credit', () => {
    const { ledger } = buildDefault();
    const containment = ledger.bindings.find(
      (entry) => entry.subjectId === 'container/object' && entry.capability === 'changeContainment',
    );
    expect(containment).toMatchObject({
      state: 'coverage-model-only',
      coverageModelPresent: true,
      routeSelectionPresent: false,
      runtimeAvailable: false,
      representativeCaseAccepted: false,
      releaseCredit: false,
    });

    const absent = ledger.bindings.find((entry) => entry.state === 'profile-unavailable');
    expect(absent).toBeDefined();
    expect(absent?.coverageModelPresent).toBe(false);
    expect(absent?.routeSelectionPresent).toBe(false);
    expect(absent?.runtimeAvailable).toBe(false);
    expect(absent?.representativeCaseAccepted).toBe(false);
    expect(absent?.detail).toContain('profile unavailable');

    const containmentModel = ledger.coverageModels.find(
      (entry) => entry.subjectId === 'container/object' && entry.capability === 'changeContainment',
    );
    expect(containmentModel).toMatchObject({
      bindingState: 'coverage-model-only',
      runtimeAvailable: false,
      representativeCases: 0,
      releaseCredit: false,
    });
  });

  it('reports selected-not-executed Release assignments without conflating them with executions', () => {
    const { ledger } = buildDefault();
    const release = ledger.dimensions.find((entry) => entry.dimension === 'release-assignment');
    expect(release?.status).toBe('incomplete');
    expect(release?.count).toBe(55);
    expect(release?.qualification).toContain('have been executed');
    expect(release?.qualification).toContain('Gate G');
    expect(ledger.counts.releaseAssignmentsExecuted).toBe(0);
    // Runtime availability is a capability, never an executed result.
    expect(
      ledger.compiledProfiles.every(
        (entry) => entry.runtimeAvailable && entry.releaseCredit === false,
      ),
    ).toBe(true);
  });

  it('reports diagnostic-only scenarios as Diagnostic infrastructure with no Release credit', () => {
    const { ledger } = buildDefault();
    const diagnostic = ledger.dimensions.find((entry) => entry.dimension === 'diagnostic-scenario');
    expect(diagnostic?.status).toBe('deferred');
    expect(diagnostic?.count).toBe(11);
    expect(diagnostic?.qualification).toContain('never satisfy a Release obligation');
    expect(ledger.coverageModels.some((entry) => entry.diagnosticOnlyScenarios > 0)).toBe(true);
    expect(ledger.acceptedRepresentativeSuite.state).toBe('accepted');
    expect(ledger.acceptedRepresentativeSuite.releaseCredit).toBe(false);
    expect(
      ledger.acceptedRepresentativeSuite.children.every(
        (child) => child.finalOutcome === 'PASS' && child.cleanupComplete,
      ),
    ).toBe(true);
  });

  it('always records Release credit as false everywhere', () => {
    const { ledger } = buildDefault();
    expect(ledger.releaseCreditGranted).toBe(false);
    expect(ledger.integrityVerificationPerformed).toBe(false);
    expect(ledger.dimensions.every((entry) => entry.releaseCredit === false)).toBe(true);
    expect(ledger.bindings.every((entry) => entry.releaseCredit === false)).toBe(true);
    expect(ledger.coverageModels.every((entry) => entry.releaseCredit === false)).toBe(true);
    expect(ledger.compiledProfiles.every((entry) => entry.releaseCredit === false)).toBe(true);
    const serialized = serializeCompletenessLedger(ledger);
    expect(serialized).not.toContain('"releaseCredit": true');
    expect(/(^|\s)"releaseCreditGranted": true/.test(serialized)).toBe(false);
  });

  it('carries the explicit Gate F/G/H and Release nonclaims', () => {
    const { ledger } = buildDefault();
    const joined = ledger.nonClaims.join('\n');
    expect(joined).toContain('Gate F');
    expect(joined).toContain('Gate G');
    expect(joined).toContain('Gate H');
    expect(joined).toContain('Package 8');
    expect(joined).toContain('Release credit is never granted');
  });

  it('reports accepted representative bindings: six compiled bindings carry the eight cases', () => {
    const { ledger } = buildDefault();
    const accepted = ledger.bindings.filter((entry) => entry.representativeCaseAccepted);
    expect(accepted.map((entry) => `${entry.subjectId}|${entry.capability}`).sort()).toEqual([
      'artwork/editor|frontendSerializeRestore',
      'artwork/editor|history',
      'container/object|move',
      'layer/crossword|create',
      'layer/image|changeProperties',
      'layer/text|move',
    ]);
    expect(
      ledger.coverageModels.reduce((total, entry) => total + entry.representativeCases, 0),
    ).toBe(8);
  });
});

describe('[P7-C] accepted representative suite read-only projection', () => {
  it('accepts the strict current-v4 suite and records observed digests without integrity claims', () => {
    const { ledger } = buildDefault();
    const projection = ledger.acceptedRepresentativeSuite;
    expect(projection.state).toBe('accepted');
    expect(projection.acceptedCaseCount).toBe(8);
    expect(projection.declaredCaseCount).toBe(8);
    expect(projection.children).toHaveLength(8);
    expect(projection.integrityVerified).toBe(false);
    expect(projection.integrityOwner).toBe('package-8');
    expect(projection.suiteRecordPath).toBe(`evidence/suites/${SUITE_ID}/suite-record.json`);

    const suiteObserved = sha256File(
      path.join(evidenceRoot, 'suites', SUITE_ID, 'suite-record.json'),
    );
    expect(projection.suiteRecordObservedSha256).toBe(suiteObserved.sha256);
    expect(projection.suiteRecordObservedBytes).toBe(suiteObserved.bytes);

    for (const child of projection.children) {
      expect(child.recordIdentitySatisfied).toBe(true);
      const observed = sha256File(path.join(evidenceRoot, 'runs', child.runId, 'run-record.json'));
      expect(child.observedSha256).toBe(observed.sha256);
      expect(child.observedBytes).toBe(observed.bytes);
      expect(child.recordPath).toBe(`evidence/runs/${child.runId}/run-record.json`);
      expect(child.recordPath.startsWith('/')).toBe(false);
    }

    // The accepted children match the declared representative members in order.
    const declared = resolveSuiteRequests(loadDiagnosticSuite('representative'));
    expect(projection.children.map((child) => child.caseId)).toEqual(
      declared.map((member) => member.declaration.caseId),
    );
    expect(projection.children.map((child) => child.request)).toEqual(
      declared.map((member) => member.declaration.request),
    );
  });
});

describe('[P7-C] accepted-suite failure matrix (isolated copies, no accepted-evidence mutation)', () => {
  it('reports an absent accepted suite as a blocking finding with zero credited cases', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'p7c-empty-'));
    tempRoots.push(root);
    const { projection, findings } = projectAcceptedRepresentativeSuite({ evidenceRootDir: root });
    expect(projection.state).toBe('absent');
    expect(projection.acceptedCaseCount).toBe(0);
    expect(projection.suiteRecordObservedSha256).toBeNull();
    expect(findings.map((finding) => finding.code)).toEqual(['COMPLETENESS_ACCEPTED_SUITE_ABSENT']);

    const { ledger, findings: buildFindings } = buildPackage7CompletenessLedger({
      bundle: defaultBundle(),
      acceptedSuite: { evidenceRootDir: root },
    });
    expect(ledger.counts.acceptedRepresentativeCases).toBe(0);
    expect(ledger.acceptedRepresentativeSuite.state).toBe('absent');
    expect(buildFindings.some((finding) => finding.severity === 'blocking')).toBe(true);
  });

  it('rejects malformed, non-strict, and tampered accepted suite records', () => {
    const root = privateAcceptedEvidenceRoot();

    const malformed = mkdtempSync(path.join(os.tmpdir(), 'p7c-malformed-'));
    tempRoots.push(malformed);
    mkdirSync(path.join(malformed, 'suites', SUITE_ID), { recursive: true });
    writeFileSync(
      path.join(malformed, 'suites', SUITE_ID, 'suite-record.json'),
      '{not json',
      'utf8',
    );
    expect(
      projectAcceptedRepresentativeSuite({ evidenceRootDir: malformed }).projection.state,
    ).toBe('invalid');

    const legacyRoot = privateAcceptedEvidenceRoot();
    const legacy = readSuiteRecord(legacyRoot);
    // A historical schema-1 record without a label is the labelled legacy branch.
    delete legacy.label;
    legacy.schemaVersion = 1;
    writeSuiteRecord(legacyRoot, legacy);
    expect(
      projectAcceptedRepresentativeSuite({ evidenceRootDir: legacyRoot }).projection.state,
    ).toBe('invalid');

    const statusRoot = privateAcceptedEvidenceRoot();
    const status = readSuiteRecord(statusRoot);
    status.aggregateStatus = 'BUG';
    writeSuiteRecord(statusRoot, status);
    const statusResult = projectAcceptedRepresentativeSuite({ evidenceRootDir: statusRoot });
    expect(statusResult.projection.state).toBe('invalid');
    expect(statusResult.projection.qualification).toContain('aggregateStatus');

    const childCaseRoot = privateAcceptedEvidenceRoot();
    const childCase = readSuiteRecord(childCaseRoot);
    (childCase.children as Record<string, unknown>[])[0].request =
      'cases/diagnostic/requests/not-a-real-request.json';
    writeSuiteRecord(childCaseRoot, childCase);
    const childCaseResult = projectAcceptedRepresentativeSuite({
      evidenceRootDir: childCaseRoot,
      declaredMembers: declaredRepresentativeMembers(),
    });
    expect(childCaseResult.projection.state).toBe('invalid');
    expect(childCaseResult.projection.qualification).toContain('declared representative member');
  });

  it('rejects a tampered or non-strict child run record as an identity mismatch', () => {
    const tamperedRoot = privateAcceptedEvidenceRoot();
    const tamperedSuite = readSuiteRecord(tamperedRoot);
    const firstChild = (tamperedSuite.children as { runId: string }[])[0];
    const tamperedRecord = JSON.parse(
      readFileSync(runRecordAbsolute(tamperedRoot, firstChild.runId), 'utf8'),
    ) as Record<string, unknown>;
    tamperedRecord.caseId = 'ffffffff';
    writeFileSync(
      runRecordAbsolute(tamperedRoot, firstChild.runId),
      `${JSON.stringify(tamperedRecord)}\n`,
      'utf8',
    );
    const tampered = projectAcceptedRepresentativeSuite({ evidenceRootDir: tamperedRoot });
    expect(tampered.projection.state).toBe('invalid');
    expect(tampered.projection.qualification).toContain('identity disagrees');

    const legacyRoot = privateAcceptedEvidenceRoot();
    const legacySuite = readSuiteRecord(legacyRoot);
    const legacyChild = (legacySuite.children as { runId: string }[])[1];
    const legacyRecord = JSON.parse(
      readFileSync(runRecordAbsolute(legacyRoot, legacyChild.runId), 'utf8'),
    ) as Record<string, unknown>;
    legacyRecord.schemaVersion = 3;
    writeFileSync(
      runRecordAbsolute(legacyRoot, legacyChild.runId),
      `${JSON.stringify(legacyRecord)}\n`,
      'utf8',
    );
    const legacyResult = projectAcceptedRepresentativeSuite({ evidenceRootDir: legacyRoot });
    expect(legacyResult.projection.state).toBe('invalid');
    expect(legacyResult.projection.qualification).toContain('not a strict current-v4 run record');
  });
});

describe('[P7-C] deterministic builder and atomic persistence', () => {
  it('is order-stable and byte-stable across repeated builds', () => {
    const first = buildPackage7CompletenessLedger({ bundle: defaultBundle() });
    const second = buildPackage7CompletenessLedger({ bundle: defaultBundle() });
    const reordered = buildPackage7CompletenessLedger({ bundle: reorderedBundle() });

    expect(serializeCompletenessLedger(first.ledger)).toBe(
      serializeCompletenessLedger(second.ledger),
    );
    expect(first.ledger.fingerprint).toBe(second.ledger.fingerprint);
    // Reordering semantically unordered authoring arrays changes no identity.
    expect(reordered.ledger.fingerprint).toBe(first.ledger.fingerprint);
    expect(serializeCompletenessLedger(reordered.ledger)).toBe(
      serializeCompletenessLedger(first.ledger),
    );

    // Route-selection authoring order changes only the catalogue document
    // fingerprint; the ledger's derived profile/model lists stay sorted.
    const routesReordered = buildPackage7CompletenessLedger({
      bundle: reversedRouteSelectionBundle(),
    });
    expect(routesReordered.ledger.compiledProfiles).toEqual(first.ledger.compiledProfiles);
    expect(routesReordered.ledger.coverageModels).toEqual(first.ledger.coverageModels);
    expect(routesReordered.ledger.bindings).toEqual(first.ledger.bindings);
  });

  it('persists the same bytes across repeated atomic writes', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'p7c-persist-'));
    tempRoots.push(root);
    const target = path.join(root, 'package7-completeness-ledger.v1.json');
    const first = buildDefault();
    const second = buildDefault();
    const written1 = persistCompletenessLedgerFile(first.ledger, target);
    const bytes1 = readFileSync(target);
    const written2 = persistCompletenessLedgerFile(second.ledger, target);
    const bytes2 = readFileSync(target);
    expect(written1.sha256).toBe(written2.sha256);
    expect(bytes1.equals(bytes2)).toBe(true);
    expect(written1.relativePath).toBe(PACKAGE7_COMPLETENESS_LEDGER_RELATIVE_PATH);
    // The durable artifact never carries a timestamp or absolute private path.
    const text = bytes1.toString('utf8');
    expect(text).not.toMatch(/recordedAt|generatedAt|\/Users\/|\/home\//);
    expect(
      completenessLedgerArtifactPath().endsWith(
        PACKAGE7_COMPLETENESS_LEDGER_RELATIVE_PATH.replaceAll('/', path.sep),
      ),
    ).toBe(true);
  });
});

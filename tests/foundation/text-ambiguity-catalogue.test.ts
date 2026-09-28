import { describe, expect, it } from 'vitest';

import {
  CIRCLE_ENVELOPE_GEOMETRY_PROFILE,
  textSpecializedAdapter,
} from '../../src/adapters/text-specialized';
import {
  FixtureCatalogueError,
  parseBindingFixtureCatalogue,
  resolveBindingFixture,
} from '../../src/catalogue/fixtures';
import { loadCatalogueBundle } from '../../src/catalogue/load';
import type { AdapterElementFact } from '../../src/contracts/adapter';
import type { CaseIntent } from '../../src/contracts/case-model';
import type { BindingCoverageModel } from '../../src/contracts/coverage';
import type { BindingFixture } from '../../src/contracts/fixtures';
import { resolveCaseCoverage } from '../../src/coverage/resolve';

/**
 * ADR 0012 R1/R2/R3/R4/R7 — governed diagnostic-only Text ambiguity authoring.
 *
 * Focused catalogue and selector-integrity contract for the two new scenarios
 * and two exact fixture bindings. These assertions are browser-free: they prove
 * the authoring data, the absence of behavioral credit, and that
 * `geometryProfile` remains a typed precondition rather than a matching key.
 */

const AMBIGUOUS_BINDINGS = [
  {
    scenarioId: 'drag-ordinary-ambiguous',
    fixtureId: 'layer-text-move-drag-ordinary-ambiguous',
    constructorId: 'artwork.two-layout-text.v1',
    constructorVersion: 1,
    variant: 'plain',
  },
  {
    scenarioId: 'drag-warped-nested-ambiguous',
    fixtureId: 'layer-text-move-drag-warped-nested-ambiguous',
    constructorId: 'artwork.two-layout-text.v2',
    constructorVersion: 2,
    variant: 'warp-circle',
  },
] as const;

function textMoveModel(): BindingCoverageModel {
  const model = loadCatalogueBundle().coverageCatalogue.models.find(
    (entry) => entry.subjectId === 'layer/text' && entry.capability === 'move',
  );
  if (!model) throw new Error('layer/text×move model is missing');
  return model;
}

function requireFixture(fixtureId: string): BindingFixture {
  const fixture = loadCatalogueBundle().fixtureCatalogue.fixtures.find(
    (entry) => entry.fixtureId === fixtureId,
  );
  if (!fixture) throw new Error(`fixture "${fixtureId}" is missing`);
  return fixture;
}

function ambiguityIntent(entry: (typeof AMBIGUOUS_BINDINGS)[number]): CaseIntent {
  return {
    subjectId: 'layer/text',
    capability: 'move',
    variant: entry.variant,
    scenario: entry.scenarioId,
    preState: { x: 10, y: 10 },
    operations: [{ discriminant: 'move.by', parameters: { dx: 80, dy: 40 } }],
    expected: { minimumDelta: { x: 40, y: 20 } },
    resources: [],
  };
}

describe('[Gate B/C] governed Text ambiguity authoring (ADR 0012 R1/R4)', () => {
  it('declares both scenarios as diagnostic-only and resolves each independently', () => {
    const model = textMoveModel();

    for (const entry of AMBIGUOUS_BINDINGS) {
      const scenario = model.scenarios.find((candidate) => candidate.id === entry.scenarioId);
      expect(scenario).toBeDefined();
      expect(scenario?.eligibility).toBe('diagnostic-only');

      const diagnostic = resolveCaseCoverage({
        model,
        intent: ambiguityIntent(entry),
        profile: 'diagnostic',
        provenance: 'diagnostic-request',
      });
      expect(diagnostic.ok).toBe(true);
      if (diagnostic.ok) {
        expect(diagnostic.coverage.scenario.id).toBe(entry.scenarioId);
        expect(diagnostic.coverage.assignments['rendering-mode']).toBe(
          entry.variant === 'plain' ? 'plain' : 'warp-circle',
        );
      }

      const release = resolveCaseCoverage({
        model,
        intent: ambiguityIntent(entry),
        profile: 'release',
        provenance: 'manifest',
      });
      expect(release.ok).toBe(false);
      if (!release.ok) expect(release.finding.code).toBe('COVERAGE_SCENARIO_INELIGIBLE');
    }
  });

  it('adds no Factor, partition, scenario obligation, or Release requirement', () => {
    const model = textMoveModel();

    expect(model.baselineScenarioId).toBe('drag-ordinary');
    expect(model.factors.map((factor) => factor.id)).toEqual([
      'ancestry',
      'displacement',
      'interaction',
      'rendering-mode',
    ]);
    for (const entry of AMBIGUOUS_BINDINGS) {
      expect(
        model.obligations.some(
          (obligation) =>
            obligation.match.kind === 'scenario' &&
            obligation.match.scenarioId === entry.scenarioId,
        ),
      ).toBe(false);
      expect(model.obligations.some((obligation) => obligation.id.includes('ambiguous'))).toBe(
        false,
      );
    }
  });
});

describe('[Gate B] governed Text ambiguity fixture bindings (ADR 0012 R1/R2/R7)', () => {
  it('publishes exactly one binding per scenario with the governed constructor and role', () => {
    const catalogue = loadCatalogueBundle().fixtureCatalogue;

    for (const entry of AMBIGUOUS_BINDINGS) {
      const matches = catalogue.fixtures.filter(
        (fixture) => fixture.scenarioId === entry.scenarioId,
      );
      expect(matches).toHaveLength(1);
      const fixture = matches[0] as BindingFixture;
      expect(fixture.fixtureId).toBe(entry.fixtureId);
      expect(fixture.subjectId).toBe('layer/text');
      expect(fixture.capability).toBe('move');
      expect(fixture.constructorId).toBe(entry.constructorId);
      expect(fixture.constructorVersion).toBe(entry.constructorVersion);
      expect(
        resolveBindingFixture(catalogue, {
          subjectId: 'layer/text',
          capability: 'move',
          scenarioId: entry.scenarioId,
        }),
      ).toEqual(fixture);
    }
  });

  it('materializes exactly two candidates: no ordinary warp key and two circle warps', () => {
    const ordinary = requireFixture('layer-text-move-drag-ordinary-ambiguous');
    const warped = requireFixture('layer-text-move-drag-warped-nested-ambiguous');

    const ordinaryLayouts = ordinary.inputs.layouts as ReadonlyArray<Record<string, unknown>>;
    expect(ordinaryLayouts).toHaveLength(2);
    expect(ordinaryLayouts.every((layout) => !Object.hasOwn(layout, 'warp'))).toBe(true);
    expect(JSON.stringify(ordinary.inputs)).not.toContain('"warp"');

    const warpedLayouts = warped.inputs.layouts as ReadonlyArray<Record<string, unknown>>;
    expect(warpedLayouts).toHaveLength(2);
    for (const layout of warpedLayouts) {
      expect(Object.keys(layout).sort()).toEqual(['id', 'name', 'text', 'warp', 'x', 'y']);
      expect(layout.warp).toBe('circle');
    }
  });

  it('confines geometryProfile to the warped binding and keeps the contract exact', () => {
    const ordinary = requireFixture('layer-text-move-drag-ordinary-ambiguous');
    const warped = requireFixture('layer-text-move-drag-warped-nested-ambiguous');

    expect(ordinary.semanticTargetRoles).toEqual([
      { role: 'target', kind: 'text', layoutRole: 'any', resolution: 'pre-action-existing' },
    ]);
    expect(warped.semanticTargetRoles).toEqual([
      {
        role: 'target',
        kind: 'text',
        layoutRole: 'any',
        resolution: 'pre-action-existing',
        geometryProfile: 'circle-control-envelope-quad-v1',
      },
    ]);
    expect(warped.semanticTargetRoles[0]?.geometryProfile).toBe(CIRCLE_ENVELOPE_GEOMETRY_PROFILE);
    expect(ordinary.semanticTargetRoles.some((role) => 'geometryProfile' in role)).toBe(false);
  });

  it('rejects a duplicate binding key and undeclared targeting keys', () => {
    const catalogue = loadCatalogueBundle().fixtureCatalogue;

    const duplicated = structuredClone(catalogue);
    const first = duplicated.fixtures[0] as BindingFixture;
    duplicated.fixtures = [...duplicated.fixtures, { ...first, fixtureId: 'duplicate-binding' }];
    let duplicateError: unknown;
    try {
      parseBindingFixtureCatalogue(duplicated);
    } catch (error) {
      duplicateError = error;
    }
    expect(duplicateError).toBeInstanceOf(FixtureCatalogueError);
    expect((duplicateError as FixtureCatalogueError).code).toBe('FIXTURE_CATALOGUE_DUPLICATE');

    // Candidate id, occurrence, warp type, first-match, selector, and coordinate
    // fields are not part of the governed role contract and stay rejected.
    for (const [key, value] of [
      ['candidateId', 'layout-a-text-1'],
      ['occurrence', 1],
      ['warpType', 'circle'],
      ['firstMatch', true],
      ['selector', '.konvajs-content'],
      ['x', 10],
      ['y', 20],
    ] as const) {
      const targeted = structuredClone(catalogue);
      targeted.fixtures = targeted.fixtures.map((fixture) =>
        fixture.fixtureId === 'layer-text-move-drag-ordinary-ambiguous'
          ? {
              ...fixture,
              semanticTargetRoles: [
                {
                  role: 'target',
                  kind: 'text',
                  layoutRole: 'any',
                  resolution: 'pre-action-existing',
                  [key]: value,
                },
              ],
            }
          : fixture,
      );
      let targetedError: unknown;
      try {
        parseBindingFixtureCatalogue(targeted);
      } catch (error) {
        targetedError = error;
      }
      expect(targetedError).toBeInstanceOf(FixtureCatalogueError);
      expect((targetedError as FixtureCatalogueError).code).toBe('FIXTURE_CATALOGUE_INVALID');
    }
  });
});

describe('[Gate C] geometryProfile is a precondition, never a selector (ADR 0012 R3)', () => {
  it('keeps a mixed ordinary/circle candidate pair at two matches for the same role', () => {
    const adapter = textSpecializedAdapter();
    const candidates: AdapterElementFact[] = [
      { id: 'layout-a-text-1', kind: 'text', parentId: 'layout-a', mounted: true },
      { id: 'layout-b-text-1', kind: 'text', parentId: 'layout-b', mounted: true },
    ];

    // The element-fact surface carries no warp distinction, so a mixed
    // ordinary/circle pair matches exactly like any other two-Text document.
    // That is why the typed profile may never be promoted to a matching key.
    for (const role of [
      {
        role: 'target',
        kind: 'text',
        layoutRole: 'any' as const,
        resolution: 'pre-action-existing' as const,
      },
      {
        role: 'target',
        kind: 'text',
        layoutRole: 'any' as const,
        resolution: 'pre-action-existing' as const,
        geometryProfile: CIRCLE_ENVELOPE_GEOMETRY_PROFILE,
      },
    ]) {
      const resolutions = adapter.resolveTargets({
        phase: 'pre-action',
        roles: [role],
        elements: candidates,
        activeLayoutId: 'layout-a',
      });
      expect(resolutions).toHaveLength(1);
      expect(resolutions[0]?.status).toBe('ambiguous');
      expect(resolutions[0]?.matchCount).toBe(2);
      expect(resolutions[0]?.target).toBeNull();
      expect([...(resolutions[0]?.matchedElementIds ?? [])].sort()).toEqual([
        'layout-a-text-1',
        'layout-b-text-1',
      ]);
    }
  });

  it('carries the declared profile to a uniquely resolved target instead of filtering on it', () => {
    const adapter = textSpecializedAdapter();
    const resolutions = adapter.resolveTargets({
      phase: 'pre-action',
      roles: [
        {
          role: 'target',
          kind: 'text',
          layoutRole: 'any',
          resolution: 'pre-action-existing',
          geometryProfile: CIRCLE_ENVELOPE_GEOMETRY_PROFILE,
        },
      ],
      elements: [{ id: 'layout-a-text-1', kind: 'text', parentId: 'layout-a', mounted: true }],
      activeLayoutId: 'layout-a',
    });

    expect(resolutions[0]?.status).toBe('resolved');
    expect(resolutions[0]?.target?.elementId).toBe('layout-a-text-1');
    expect(resolutions[0]?.target?.geometryProfile).toBe(CIRCLE_ENVELOPE_GEOMETRY_PROFILE);
  });
});

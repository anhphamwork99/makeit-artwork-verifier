import { describe, expect, it } from 'vitest';

import {
  EnvironmentCatalogueError,
  loadEnvironmentCatalogue,
  parseEnvironmentCatalogue,
  resolveEnvironmentCell,
} from '../../src/runtime/environment';
import { deriveLaunchability } from '../../src/planner/launchability';
import { planCase } from '../../src/planner/plan-case';
import { resolveBindingFixture } from '../../src/catalogue/fixtures';
import {
  baseIntent,
  defaultBundle,
  diagnosticRequest,
  planned,
  releaseRequest,
} from '../foundation/helpers';

describe('[Gate B] static plan launchability projection (TS-2)', () => {
  it('reports a planned case for a fully delivered binding as launchable', () => {
    const result = planned(planCase(releaseRequest()));
    const launchability = deriveLaunchability(result.outputs.preflightReport);

    expect(launchability.launchable).toBe(true);
    expect(launchability.deferredStages).toEqual([]);
    expect(launchability.blockers).toEqual([]);
  });

  it('delivers the warped binding once its v2 fixture and adapter are present', () => {
    const result = planned(
      planCase(
        releaseRequest({
          ...baseIntent(),
          variant: 'warp-circle',
          scenario: 'drag-warped-nested',
        }),
      ),
    );
    const launchability = deriveLaunchability(result.outputs.preflightReport);

    expect(launchability.launchable).toBe(true);
    expect(launchability.deferredStages).toEqual([]);
    expect(launchability.blockers).toEqual([]);
  });

  it('refuses to launch the warped binding when its fixture is absent', () => {
    const bundle = defaultBundle();
    const fixtureCatalogue = structuredClone(bundle.fixtureCatalogue);
    fixtureCatalogue.fixtures = fixtureCatalogue.fixtures.filter(
      (fixture) => fixture.scenarioId !== 'drag-warped-nested',
    );
    const result = planned(
      planCase(
        releaseRequest({
          ...baseIntent(),
          variant: 'warp-circle',
          scenario: 'drag-warped-nested',
        }),
        { catalogues: { ...bundle, fixtureCatalogue } },
      ),
    );
    const launchability = deriveLaunchability(result.outputs.preflightReport);

    expect(launchability.launchable).toBe(false);
    expect(launchability.deferredStages).toEqual(['P5', 'P7']);
    expect(launchability.blockers.join(' ')).toContain('P5-deferred');
    expect(launchability.blockers.join(' ')).toContain('P7-deferred');
  });

  it('keeps a rejected attempt explicitly not launchable and names the rejection', () => {
    const result = planCase(
      releaseRequest({ ...releaseRequest().intent, subjectId: 'layer/ghost' }),
    );
    if (result.status === 'PLANNED') throw new Error('expected a rejected plan');
    expect(result.status).toBe('HARNESS_BLOCKED');
    const launchability = deriveLaunchability(result.report);

    expect(launchability.launchable).toBe(false);
    expect(launchability.blockers.join(' ')).toContain('plan-rejected');
  });
});

describe('[spec 9.3] governed environment cell catalogue', () => {
  it('resolves the initial Chromium desktop cell with the declared determinism profile', () => {
    const catalogue = loadEnvironmentCatalogue();
    const cell = resolveEnvironmentCell(catalogue);

    expect(cell.cellId).toBe('chromium-desktop-1440x1000');
    expect(cell.classification).toBe('required-credit');
    expect(cell.viewport).toEqual({ width: 1440, height: 1000 });
    expect(cell.deviceScaleFactor).toBe(1);
    expect(cell.locale).toBe('en-US');
    expect(cell.timezoneId).toBe('UTC');
    expect(cell.colorScheme).toBe('light');
    expect(cell.reducedMotion).toBe('no-preference');
    expect(cell.permissions).toEqual([]);
    expect(cell.geolocation).toBeNull();
    expect(cell.storageState).toBeNull();
  });

  it('fails closed on an undeclared cell', () => {
    const catalogue = loadEnvironmentCatalogue();
    expect(() => resolveEnvironmentCell(catalogue, 'mobile-safari')).toThrow(
      EnvironmentCatalogueError,
    );
  });

  it('rejects a reused storage state and unknown classifications', () => {
    expect(() =>
      parseEnvironmentCatalogue({
        schemaVersion: 1,
        cells: [
          {
            cellId: 'bad',
            classification: 'sometimes',
            browserKind: 'chromium',
            browserChannel: 'bundled',
            playwrightVersion: '1.0.0',
            viewport: { width: 100, height: 100 },
            deviceScaleFactor: 1,
            locale: 'en-US',
            timezoneId: 'UTC',
            colorScheme: 'light',
            reducedMotion: 'no-preference',
            permissions: [],
            geolocation: null,
            storageState: null,
          },
        ],
      }),
    ).toThrow(EnvironmentCatalogueError);
  });
});

const AMBIGUITY_BINDINGS = [
  {
    label: 'ordinary',
    variant: 'plain',
    scenario: 'drag-ordinary-ambiguous',
    fixtureId: 'layer-text-move-drag-ordinary-ambiguous',
  },
  {
    label: 'circle-warped',
    variant: 'warp-circle',
    scenario: 'drag-warped-nested-ambiguous',
    fixtureId: 'layer-text-move-drag-warped-nested-ambiguous',
  },
] as const;

function ambiguityRequest(entry: (typeof AMBIGUITY_BINDINGS)[number]) {
  return diagnosticRequest(baseIntent({ variant: entry.variant, scenario: entry.scenario }));
}

describe('[Gate B] governed Text ambiguity launchability (ADR 0012 R1/R7)', () => {
  it.each(
    AMBIGUITY_BINDINGS,
  )('delivers the $label ambiguity binding once its fixture is present', (entry) => {
    const result = planned(planCase(ambiguityRequest(entry)));
    const launchability = deriveLaunchability(result.outputs.preflightReport);

    expect(launchability.launchable).toBe(true);
    expect(launchability.deferredStages).toEqual([]);
    expect(launchability.blockers).toEqual([]);
    expect(
      resolveBindingFixture(defaultBundle().fixtureCatalogue, {
        subjectId: 'layer/text',
        capability: 'move',
        scenarioId: entry.scenario,
      })?.fixtureId,
    ).toBe(entry.fixtureId);
  });

  it.each(
    AMBIGUITY_BINDINGS,
  )('requires the $label scenario’s own fixture with no fallback', (entry) => {
    const bundle = defaultBundle();
    const fixtureCatalogue = structuredClone(bundle.fixtureCatalogue);
    fixtureCatalogue.fixtures = fixtureCatalogue.fixtures.filter(
      (fixture) => fixture.fixtureId !== entry.fixtureId,
    );

    const removed = planned(
      planCase(ambiguityRequest(entry), {
        catalogues: { ...bundle, fixtureCatalogue },
      }),
    );
    const removedLaunchability = deriveLaunchability(removed.outputs.preflightReport);
    expect(removedLaunchability.launchable).toBe(false);
    expect(removedLaunchability.deferredStages).toEqual(['P5', 'P7']);
    expect(removedLaunchability.blockers.join(' ')).toContain('P5-deferred');
    expect(removedLaunchability.blockers.join(' ')).toContain('P7-deferred');
    // The removed scenario still resolves its own distinct fixture key; nothing
    // falls back to the accepted PASS/BUG fixture.
    expect(removed.materializedCase.intent.scenario).toBe(entry.scenario);

    // Only the scenario whose fixture was removed becomes non-launchable.
    for (const other of AMBIGUITY_BINDINGS) {
      if (other.fixtureId === entry.fixtureId) continue;
      const sibling = planned(
        planCase(ambiguityRequest(other), {
          catalogues: { ...bundle, fixtureCatalogue },
        }),
      );
      expect(deriveLaunchability(sibling.outputs.preflightReport).launchable).toBe(true);
    }
  });

  it('keeps the accepted PASS/BUG fixtures resolvable and unchanged', () => {
    const catalogue = defaultBundle().fixtureCatalogue;
    for (const [scenarioId, fixtureId] of [
      ['drag-ordinary', 'layer-text-move-drag-ordinary'],
      ['drag-warped-nested', 'layer-text-move-drag-warped-nested'],
    ] as const) {
      expect(
        resolveBindingFixture(catalogue, {
          subjectId: 'layer/text',
          capability: 'move',
          scenarioId,
        })?.fixtureId,
      ).toBe(fixtureId);
    }
    // No governed ambiguity scenario falls back to an accepted fixture.
    for (const entry of AMBIGUITY_BINDINGS) {
      expect(
        resolveBindingFixture(catalogue, {
          subjectId: 'layer/text',
          capability: 'move',
          scenarioId: entry.scenario,
        })?.fixtureId,
      ).toBe(entry.fixtureId);
    }
  });

  it.each(
    AMBIGUITY_BINDINGS,
  )('rejects a Release plan for the $label ambiguity scenario before launch', (entry) => {
    const result = planCase(
      releaseRequest(baseIntent({ variant: entry.variant, scenario: entry.scenario })),
    );
    expect(result.status).toBe('HARNESS_BLOCKED');
    expect(result.launchAttempted).toBe(false);
    if (result.status !== 'HARNESS_BLOCKED') throw new Error('expected a blocked plan result');
    expect(result.code).toBe('COVERAGE_SCENARIO_INELIGIBLE');
    expect(deriveLaunchability(result.report).launchable).toBe(false);
  });
});

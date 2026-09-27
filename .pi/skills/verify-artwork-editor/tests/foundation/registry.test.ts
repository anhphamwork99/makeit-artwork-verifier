import { describe, expect, it } from 'vitest';

import { ARTWORK_LAYER_REGISTRY } from '@/lib/artwork/layers/registry';

import {
  loadCatalogueBundle,
  parseAdapterCatalogue,
  parseWorkflowCatalogue,
} from '../../src/catalogue/load';
import { planCase } from '../../src/planner/plan-case';
import { reconcileRegistry } from '../../src/registry/reconcile';
import type { DiagnosticCode } from '../../src/contracts/diagnostics';
import {
  catalogueWithSyntheticShape,
  cloneCatalogue,
  cloneInventory,
  defaultBundle,
  planned,
  releaseRequest,
  requireDeclaration,
} from './helpers';

function reconcileWithCatalogue(
  mutate: (catalogue: ReturnType<typeof cloneCatalogue>) => void,
  kinds?: string[],
) {
  const bundle = defaultBundle();
  const catalogue = cloneCatalogue(bundle.subjectCatalogue);
  mutate(catalogue);
  const inventory = cloneInventory(bundle.applicationInventory);
  if (kinds) inventory.kinds = kinds;
  return reconcileRegistry({
    subjectCatalogue: catalogue,
    applicationInventory: inventory,
    adapterCatalogue: bundle.adapterCatalogue,
    workflowCatalogue: bundle.workflowCatalogue,
  });
}

function bindingFor(
  catalogue: ReturnType<typeof cloneCatalogue>,
  subjectId: string,
  capability: string,
): { workflowId: string } {
  const declaration = requireDeclaration(catalogue, subjectId);
  const binding = declaration.capabilityBindings.find((entry) => entry.capability === capability);
  if (!binding) throw new Error(`Binding "${subjectId}:${capability}" is missing`);
  return binding;
}

function codes(findings: readonly { code: DiagnosticCode }[]): DiagnosticCode[] {
  return findings.map((finding) => finding.code);
}

describe('[Gate A] application reconciliation (TS-1)', () => {
  it('reconciles every current ARTWORK_LAYER_REGISTRY key against the declared inventory', () => {
    const { applicationInventory } = loadCatalogueBundle();

    expect(applicationInventory.kinds).toEqual(Object.keys(ARTWORK_LAYER_REGISTRY).sort());
    expect(applicationInventory.source).toBe(
      'src/lib/artwork/layers/registry.ts#ARTWORK_LAYER_REGISTRY',
    );
  });

  it('resolves the closed default registry as READY with complete coverage', () => {
    const result = reconcileRegistry(loadCatalogueBundle());

    expect(result.status).toBe('READY');
    expect(result.coverageStatus).toBe('complete');
    expect(result.findings).toEqual([]);
    expect(result.registryFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.resolvedSubjects.map((subject) => subject.subjectId)).toEqual([
      'artwork/editor',
      'container/layout',
      'container/object',
      'layer/crossword',
      'layer/image',
      'layer/starmap',
      'layer/text',
      'layer/vector',
      'selection/current',
    ]);
  });

  it('warns without blocking when an application kind has no Verification Subject', () => {
    const bundle = defaultBundle();
    const inventory = cloneInventory(bundle.applicationInventory);
    inventory.kinds.push('shape');
    inventory.kinds.sort();

    const result = reconcileRegistry({
      subjectCatalogue: bundle.subjectCatalogue,
      applicationInventory: inventory,
    });

    expect(result.status).toBe('READY');
    expect(result.coverageStatus).toBe('incomplete');
    expect(result.findings).toEqual([
      expect.objectContaining({
        code: 'SUBJECT_REGISTRATION_MISSING',
        severity: 'warning',
        applicationKind: 'shape',
      }),
    ]);
    // A missing-registration warning is coverage metadata only: it must not
    // change the resolved registry identity of an otherwise unchanged registry.
    expect(result.registryFingerprint).toBe(reconcileRegistry(defaultBundle()).registryFingerprint);
  });

  it('blocks a stale application source binding', () => {
    const result = reconcileWithCatalogue((catalogue) => {
      requireDeclaration(catalogue, 'layer/text').applicationKind = 'shape-does-not-exist';
    });

    expect(result.status).toBe('HARNESS_BLOCKED');
    expect(codes(result.findings)).toContain('SUBJECT_SOURCE_STALE');
    expect(
      result.findings.find((finding) => finding.code === 'SUBJECT_SOURCE_STALE')?.severity,
    ).toBe('blocking');
  });

  it('blocks a malformed application source binding', () => {
    const result = reconcileWithCatalogue((catalogue) => {
      requireDeclaration(catalogue, 'layer/text').applicationKind = null;
    });

    expect(result.status).toBe('HARNESS_BLOCKED');
    expect(codes(result.findings)).toContain('SUBJECT_SOURCE_MALFORMED');
  });

  it('blocks a verification-native Subject that declares an application source', () => {
    const result = reconcileWithCatalogue((catalogue) => {
      requireDeclaration(catalogue, 'artwork/editor').applicationKind = 'layout';
    });

    expect(result.status).toBe('HARNESS_BLOCKED');
    expect(codes(result.findings)).toContain('SUBJECT_SOURCE_MALFORMED');
  });

  it('blocks a duplicate Subject identity', () => {
    const result = reconcileWithCatalogue((catalogue) => {
      catalogue.declarations.push(structuredClone(requireDeclaration(catalogue, 'layer/text')));
    });

    expect(result.status).toBe('HARNESS_BLOCKED');
    expect(codes(result.findings)).toContain('SUBJECT_DUPLICATE');
  });

  it('blocks an ambiguous application binding owned by two Subjects', () => {
    const result = reconcileWithCatalogue((catalogue) => {
      const extra = structuredClone(requireDeclaration(catalogue, 'layer/image'));
      extra.subjectId = 'layer/image-shadow';
      catalogue.declarations.push(extra);
    });

    expect(result.status).toBe('HARNESS_BLOCKED');
    expect(codes(result.findings)).toContain('SUBJECT_REGISTRATION_AMBIGUOUS');
  });

  it('blocks a relationship that references an unknown Subject', () => {
    const result = reconcileWithCatalogue((catalogue) => {
      requireDeclaration(catalogue, 'layer/text').allowedReferences = ['layer/ghost'];
    });

    expect(result.status).toBe('HARNESS_BLOCKED');
    expect(codes(result.findings)).toContain('SUBJECT_RELATIONSHIP_UNKNOWN');
  });

  it('blocks an unknown Subject family', () => {
    const result = reconcileWithCatalogue((catalogue) => {
      const declaration = requireDeclaration(catalogue, 'layer/text');
      (declaration as { family: string }).family = 'sticker';
    });

    expect(result.status).toBe('HARNESS_BLOCKED');
    expect(codes(result.findings)).toContain('SUBJECT_FAMILY_UNKNOWN');
  });

  it('blocks an incompatible adapter compatibility version', () => {
    const result = reconcileWithCatalogue((catalogue) => {
      requireDeclaration(catalogue, 'layer/text').adapter = {
        adapterId: 'text-specialized',
        compatibilityVersion: 0,
      };
    });

    expect(result.status).toBe('HARNESS_BLOCKED');
    expect(codes(result.findings)).toContain('SUBJECT_ADAPTER_INCOMPATIBLE');
  });

  it('blocks a capability binding that declares an unknown Capability', () => {
    const result = reconcileWithCatalogue((catalogue) => {
      const declaration = requireDeclaration(catalogue, 'layer/text');
      declaration.capabilityBindings = [
        {
          capability: 'teleport' as never,
          workflowId: 'shared.teleport',
          variantIndependent: false,
          checks: [],
        },
      ];
    });

    expect(result.status).toBe('HARNESS_BLOCKED');
    expect(codes(result.findings)).toContain('SUBJECT_BINDING_INVALID');
  });

  it('records the resolved registry and application-inventory fingerprints separately', () => {
    const result = reconcileRegistry(defaultBundle());

    expect(result.registryFingerprint).not.toBe(result.applicationInventoryFingerprint);
    expect(result.applicationInventoryFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.adapterCatalogueFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.workflowCatalogueFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('blocks a resolved adapter that the adapter catalogue does not declare', () => {
    const result = reconcileWithCatalogue((catalogue) => {
      requireDeclaration(catalogue, 'layer/vector').adapter = {
        adapterId: 'ghost-specialized',
        compatibilityVersion: 1,
      };
    });

    expect(result.status).toBe('HARNESS_BLOCKED');
    expect(codes(result.findings)).toContain('SUBJECT_ADAPTER_UNKNOWN');
    expect(
      result.findings.find((finding) => finding.code === 'SUBJECT_ADAPTER_UNKNOWN')?.severity,
    ).toBe('blocking');
  });

  it('blocks an adapter compatibility version that disagrees with the adapter catalogue', () => {
    const result = reconcileWithCatalogue((catalogue) => {
      requireDeclaration(catalogue, 'layer/vector').adapter = {
        adapterId: 'default',
        compatibilityVersion: 9,
      };
    });

    expect(result.status).toBe('HARNESS_BLOCKED');
    expect(codes(result.findings)).toContain('SUBJECT_ADAPTER_INCOMPATIBLE');
  });

  it('blocks a binding workflow that the workflow catalogue does not declare', () => {
    const result = reconcileWithCatalogue((catalogue) => {
      bindingFor(catalogue, 'layer/text', 'move').workflowId = 'shared.ghost';
    });

    expect(result.status).toBe('HARNESS_BLOCKED');
    expect(codes(result.findings)).toContain('SUBJECT_WORKFLOW_UNKNOWN');
  });

  it('blocks a workflow whose declared Capability contradicts the binding', () => {
    const result = reconcileWithCatalogue((catalogue) => {
      bindingFor(catalogue, 'layer/text', 'move').workflowId = 'shared.create';
    });

    expect(result.status).toBe('HARNESS_BLOCKED');
    expect(codes(result.findings)).toContain('SUBJECT_WORKFLOW_CAPABILITY_MISMATCH');
  });

  it('is stable under authoring order changes', () => {
    const bundle = defaultBundle();
    const reversedCatalogue = cloneCatalogue(bundle.subjectCatalogue);
    reversedCatalogue.declarations.reverse();
    const reversedInventory = cloneInventory(bundle.applicationInventory);
    reversedInventory.kinds.reverse();
    const reversedOperations = {
      ...bundle.operationCatalogue,
      operations: [...bundle.operationCatalogue.operations].reverse(),
    };
    const reversedAdapters = parseAdapterCatalogue({
      ...bundle.adapterCatalogue,
      adapters: [...bundle.adapterCatalogue.adapters].reverse(),
    });
    const reversedWorkflows = parseWorkflowCatalogue({
      ...bundle.workflowCatalogue,
      workflows: [...bundle.workflowCatalogue.workflows].reverse(),
    });

    const base = reconcileRegistry(bundle);
    const shuffled = reconcileRegistry({
      subjectCatalogue: reversedCatalogue,
      applicationInventory: reversedInventory,
      operationCatalogue: reversedOperations,
      adapterCatalogue: reversedAdapters,
      workflowCatalogue: reversedWorkflows,
    });

    expect(shuffled.registryFingerprint).toBe(base.registryFingerprint);
    expect(shuffled.applicationInventoryFingerprint).toBe(base.applicationInventoryFingerprint);
    expect(shuffled.operationCatalogueFingerprint).toBe(base.operationCatalogueFingerprint);
    expect(shuffled.adapterCatalogueFingerprint).toBe(base.adapterCatalogueFingerprint);
    expect(shuffled.workflowCatalogueFingerprint).toBe(base.workflowCatalogueFingerprint);
    expect(shuffled.resolvedSubjects).toEqual(base.resolvedSubjects);
  });
});

describe('[Gate A] declarative extensibility (TS-1)', () => {
  it('plans a case for a Subject added only as catalogue data', () => {
    const { catalogue, inventory } = catalogueWithSyntheticShape();
    const extended = reconcileRegistry({
      subjectCatalogue: catalogue,
      applicationInventory: inventory,
    });

    expect(extended.status).toBe('READY');
    expect(extended.coverageStatus).toBe('complete');
    expect(extended.resolvedSubjects.map((subject) => subject.subjectId)).toContain('layer/shape');
    expect(extended.registryFingerprint).not.toBe(
      reconcileRegistry(defaultBundle()).registryFingerprint,
    );

    const result = planned(
      planCase(
        releaseRequest({
          subjectId: 'layer/shape',
          capability: 'move',
          variant: null,
          scenario: 'drag-shape',
          preState: { x: 0, y: 0 },
          operations: [{ discriminant: 'move.by', parameters: { dx: 10, dy: 10 } }],
          expected: { minimumDelta: { x: 5, y: 5 } },
          resources: [],
        }),
        {
          catalogues: {
            ...defaultBundle(),
            subjectCatalogue: catalogue,
            applicationInventory: inventory,
          },
        },
      ),
    );

    expect(result.materializedCase.route.adapterId).toBe('default');
    expect(result.materializedCase.route.workflowId).toBe('shared.move');
    expect(result.plan.requiredChecks).toEqual(['geometry.delta']);
  });
});

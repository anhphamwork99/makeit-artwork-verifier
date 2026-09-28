import { describe, expect, it } from 'vitest';

import {
  CatalogueLoadError,
  loadCatalogueBundle,
  parseAdapterCatalogue,
  parseApplicationInventory,
  parseOperationCatalogue,
  parseSubjectCatalogue,
  parseWorkflowCatalogue,
} from '../../src/catalogue/load';
import { defaultBundle } from './helpers';

function expectLoadError(run: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(CatalogueLoadError);
  expect((thrown as CatalogueLoadError).code).toBe(code);
}

describe('[Gate A] versioned catalogue loading (TS-1)', () => {
  it('loads the verification-owned Subject, application and operation catalogues', () => {
    const bundle = loadCatalogueBundle();

    expect(bundle.subjectCatalogue.schemaVersion).toBe(1);
    expect(bundle.applicationInventory.schemaVersion).toBe(1);
    expect(bundle.operationCatalogue.schemaVersion).toBe(1);
    expect(Object.keys(bundle.subjectCatalogue.familyDefaults).sort()).toEqual([
      'artwork',
      'container',
      'layer',
      'selection',
    ]);
    expect(bundle.subjectCatalogue.declarations.length).toBeGreaterThanOrEqual(9);
    expect(
      bundle.operationCatalogue.operations.map((operation) => operation.discriminant),
    ).toContain('move.by');
  });

  it('loads the versioned adapter and workflow executable catalogues', () => {
    const bundle = loadCatalogueBundle();

    expect(bundle.adapterCatalogue.schemaVersion).toBe(1);
    expect(bundle.workflowCatalogue.schemaVersion).toBe(1);
    const adapterIds = bundle.adapterCatalogue.adapters.map((entry) => entry.adapterId);
    const workflowIds = bundle.workflowCatalogue.workflows.map((entry) => entry.workflowId);
    expect(adapterIds).toEqual([...adapterIds].sort());
    expect(adapterIds).toEqual(
      expect.arrayContaining(['default', 'image-specialized', 'text-specialized']),
    );
    expect(workflowIds).toEqual([...workflowIds].sort());
    expect(workflowIds).toEqual(expect.arrayContaining(['shared.move', 'text.editContent']));
  });

  it('normalizes authoring order so catalogue fingerprints cannot drift on reordering', () => {
    const bundle = defaultBundle();
    const reordered = parseOperationCatalogue({
      ...bundle.operationCatalogue,
      operations: [...bundle.operationCatalogue.operations].reverse(),
    });
    const reorderedInventory = parseApplicationInventory({
      ...bundle.applicationInventory,
      kinds: [...bundle.applicationInventory.kinds].reverse(),
    });
    const reorderedAdapters = parseAdapterCatalogue({
      ...bundle.adapterCatalogue,
      adapters: [...bundle.adapterCatalogue.adapters].reverse(),
    });
    const reorderedWorkflows = parseWorkflowCatalogue({
      ...bundle.workflowCatalogue,
      workflows: [...bundle.workflowCatalogue.workflows].reverse(),
    });

    expect(reordered.operations.map((operation) => operation.discriminant)).toEqual(
      bundle.operationCatalogue.operations.map((operation) => operation.discriminant),
    );
    expect(reorderedInventory.kinds).toEqual(bundle.applicationInventory.kinds);
    expect(reorderedAdapters.adapters.map((entry) => entry.adapterId)).toEqual(
      bundle.adapterCatalogue.adapters.map((entry) => entry.adapterId),
    );
    expect(reorderedWorkflows.workflows.map((entry) => entry.workflowId)).toEqual(
      bundle.workflowCatalogue.workflows.map((entry) => entry.workflowId),
    );
  });

  it('fails closed on malformed executable catalogues', () => {
    expectLoadError(
      () => parseAdapterCatalogue({ schemaVersion: 99, adapters: [] }),
      'CATALOGUE_SCHEMA_UNSUPPORTED',
    );
    expectLoadError(
      () => parseAdapterCatalogue({ schemaVersion: 1, adapters: [] }),
      'CATALOGUE_SHAPE_INVALID',
    );
    expectLoadError(
      () =>
        parseAdapterCatalogue({
          schemaVersion: 1,
          adapters: [
            { adapterId: 'default', compatibilityVersion: 1 },
            { adapterId: 'default', compatibilityVersion: 1 },
          ],
        }),
      'ADAPTER_CATALOGUE_DUPLICATE',
    );
    expectLoadError(
      () =>
        parseAdapterCatalogue({
          schemaVersion: 1,
          adapters: [{ adapterId: 'default', compatibilityVersion: 0 }],
        }),
      'CATALOGUE_SHAPE_INVALID',
    );
    expectLoadError(
      () => parseWorkflowCatalogue({ schemaVersion: 2, workflows: [] }),
      'CATALOGUE_SCHEMA_UNSUPPORTED',
    );
    expectLoadError(
      () => parseWorkflowCatalogue({ schemaVersion: 1, workflows: [] }),
      'CATALOGUE_SHAPE_INVALID',
    );
    expectLoadError(
      () =>
        parseWorkflowCatalogue({
          schemaVersion: 1,
          workflows: [{ workflowId: 'shared.move', version: 1, capability: 'teleport' }],
        }),
      'WORKFLOW_UNKNOWN_CAPABILITY',
    );
    expectLoadError(
      () =>
        parseWorkflowCatalogue({
          schemaVersion: 1,
          workflows: [
            { workflowId: 'shared.move', version: 1, capability: 'move' },
            { workflowId: 'shared.move', version: 1, capability: 'move' },
          ],
        }),
      'WORKFLOW_CATALOGUE_DUPLICATE',
    );
  });

  it('fails closed on an unsupported catalogue schema version', () => {
    const bundle = defaultBundle();

    expectLoadError(
      () => parseSubjectCatalogue({ ...bundle.subjectCatalogue, schemaVersion: 99 }),
      'CATALOGUE_SCHEMA_UNSUPPORTED',
    );
    expectLoadError(
      () => parseOperationCatalogue({ ...bundle.operationCatalogue, schemaVersion: 2 }),
      'CATALOGUE_SCHEMA_UNSUPPORTED',
    );
    expectLoadError(
      () => parseApplicationInventory({ ...bundle.applicationInventory, schemaVersion: 3 }),
      'CATALOGUE_SCHEMA_UNSUPPORTED',
    );
  });

  it('fails closed on a malformed Subject declaration', () => {
    const bundle = defaultBundle();

    expectLoadError(
      () =>
        parseSubjectCatalogue({
          ...bundle.subjectCatalogue,
          declarations: [{ ...bundle.subjectCatalogue.declarations[0], subjectId: 'Layer/Text' }],
        }),
      'CATALOGUE_SHAPE_INVALID',
    );
    expectLoadError(
      () =>
        parseSubjectCatalogue({
          ...bundle.subjectCatalogue,
          declarations: [{ ...bundle.subjectCatalogue.declarations[0], capabilityBindings: null }],
        }),
      'CATALOGUE_SHAPE_INVALID',
    );
  });

  it('fails closed on a duplicate or unknown executable operation discriminant', () => {
    expectLoadError(
      () =>
        parseOperationCatalogue({
          schemaVersion: 1,
          operations: [
            { discriminant: 'move.by', capability: 'move' },
            { discriminant: 'move.by', capability: 'move' },
          ],
        }),
      'OPERATION_DISCRIMINANT_DUPLICATE',
    );
    expectLoadError(
      () =>
        parseOperationCatalogue({
          schemaVersion: 1,
          operations: [{ discriminant: 'teleport.to', capability: 'teleport' }],
        }),
      'OPERATION_UNKNOWN_CAPABILITY',
    );
    expectLoadError(
      () => parseOperationCatalogue({ schemaVersion: 1, operations: [] }),
      'CATALOGUE_SHAPE_INVALID',
    );
  });

  it('fails closed on an empty or duplicated application-kind inventory', () => {
    expectLoadError(
      () => parseApplicationInventory({ schemaVersion: 1, source: 'x', kinds: [] }),
      'CATALOGUE_SHAPE_INVALID',
    );
    expectLoadError(
      () => parseApplicationInventory({ schemaVersion: 1, source: 'x', kinds: ['text', 'text'] }),
      'APPLICATION_INVENTORY_DUPLICATE',
    );
  });

  it('reports a missing catalogue file without inventing a partial catalogue', () => {
    expectLoadError(
      () => loadCatalogueBundle({ rootDir: 'does/not/exist' }),
      'CATALOGUE_FILE_MISSING',
    );
  });

  it('reports invalid catalogue JSON as a load failure', () => {
    expectLoadError(() => parseSubjectCatalogue('not-a-catalogue'), 'CATALOGUE_SHAPE_INVALID');
  });
});

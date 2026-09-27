import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCatalogueBundle } from '../../src/catalogue/load';
import {
  DEFAULT_ENVIRONMENT_CELL_ID,
  loadEnvironmentCatalogue,
  resolveEnvironmentCell,
} from '../../src/runtime/environment';
import {
  generateExecutableSelectionManifest,
  validateExecutableSelectionManifest,
  type ExecutableManifestValidationContext,
  type ExecutableScenarioRequestTemplate,
} from '../../src/index';

const skillRoot = path.resolve(process.cwd(), '.pi/skills/verify-artwork-editor');
const requestFiles = [
  'artwork-editor-history-undo-redo.json',
  'artwork-editor-serialize-restore-mixed-raw.json',
  'artwork-editor-serialize-restore-normalized.json',
  'container-object-move-nested-rotated.json',
  'layer-crossword-create.json',
  'layer-image-upload-replace.json',
  'layer-text-move-drag-ordinary.json',
  'layer-text-move-drag-warped-nested.json',
] as const;

function templates(): ExecutableScenarioRequestTemplate[] {
  return requestFiles.map((file) => {
    const request = JSON.parse(
      readFileSync(path.join(skillRoot, 'cases/diagnostic/requests', file), 'utf8'),
    );
    return {
      templateId: file.replace(/\.json$/, ''),
      subjectId: request.intent.subjectId,
      capability: request.intent.capability,
      scenarioId: request.intent.scenario,
      intent: request.intent,
    };
  });
}

function current(): ExecutableManifestValidationContext {
  const environmentCatalogue = loadEnvironmentCatalogue();
  return {
    catalogues: loadCatalogueBundle(),
    requestTemplates: templates(),
    environmentCatalogue,
    requiredCell: resolveEnvironmentCell(environmentCatalogue, DEFAULT_ENVIRONMENT_CELL_ID),
  };
}

describe('executable selection-manifest draft', () => {
  it('derives planner-confirmed Release entries and accounts for every selected case once', () => {
    const result = generateExecutableSelectionManifest(current());
    expect(result.status).toBe('GENERATED_DRAFT');
    expect(result.releaseCredit).toBe(false);
    expect(result.accounting.complete).toBe(true);
    expect(result.accounting.entryCount).toBeGreaterThan(0);
    expect(result.draft).not.toBeNull();
    const draft = result.draft;
    if (!draft) throw new Error('Expected a generated manifest draft');
    expect(draft.state).toBe('GENERATED_DRAFT');
    expect(
      draft.content.entries.every(
        (entry) =>
          entry.request.profile === 'release' &&
          entry.request.provenance === 'manifest' &&
          entry.request.evidenceDepth === 'standard' &&
          entry.caseId.length > 0 &&
          entry.materializationFingerprint.length > 0 &&
          entry.planFingerprint.length > 0,
      ),
    ).toBe(true);
    const selected = draft.content.bindings.reduce(
      (total, binding) => total + binding.selection.cases.length,
      0,
    );
    expect(selected).toBe(result.accounting.selectedCaseCount);
    expect(selected).toBe(
      draft.content.entries.length +
        draft.content.exclusions.filter((row) => row.caseKey !== null).length,
    );
    expect(draft.content.bindings.every((binding) => binding.selection.profile === 'release')).toBe(
      true,
    );
  });

  it('is deterministic across membership ordering and rejects edited or unknown candidate data', () => {
    const base = current();
    const first = generateExecutableSelectionManifest(base);
    const permuted = generateExecutableSelectionManifest({
      ...base,
      requestTemplates: [...base.requestTemplates].reverse(),
      environmentCatalogue: {
        ...base.environmentCatalogue,
        cells: [...base.environmentCatalogue.cells].reverse(),
      },
      catalogues: {
        ...base.catalogues,
        coverageCatalogue: {
          ...base.catalogues.coverageCatalogue,
          models: [...base.catalogues.coverageCatalogue.models].reverse(),
        },
      },
    });
    expect(first.draft).not.toBeNull();
    expect(permuted.draft).toEqual(first.draft);
    expect(validateExecutableSelectionManifest(first.draft, base)).toEqual({
      status: 'VALID',
      valid: true,
      issues: [],
      releaseCredit: false,
    });

    const initialDraft = first.draft;
    if (!initialDraft) throw new Error('Expected a generated manifest draft');
    const edited = structuredClone(initialDraft);
    const firstEntry = edited.content.entries[0];
    if (!firstEntry) throw new Error('Expected at least one generated entry');
    firstEntry.planFingerprint = '0'.repeat(64);
    expect(validateExecutableSelectionManifest(edited, base).valid).toBe(false);
    const unknown = { ...initialDraft, unexpected: true };
    expect(validateExecutableSelectionManifest(unknown, base).valid).toBe(false);
    expect(
      validateExecutableSelectionManifest({ ...initialDraft, schemaVersion: 99 }, base).issues,
    ).toEqual(['MALFORMED_INPUT']);
    const hiddenUnknown = structuredClone(initialDraft);
    Object.defineProperty(hiddenUnknown, 'unexpected', { value: true, enumerable: false });
    expect(validateExecutableSelectionManifest(hiddenUnknown, base).issues).toEqual([
      'MALFORMED_INPUT',
    ]);
    const prototype = Object.create({ injected: true }) as object;
    expect(validateExecutableSelectionManifest(prototype, base).issues).toEqual([
      'MALFORMED_INPUT',
    ]);
    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, 'schemaVersion', { get: () => 1, enumerable: true });
    expect(validateExecutableSelectionManifest(accessor, base).issues).toEqual(['MALFORMED_INPUT']);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(validateExecutableSelectionManifest(cyclic, base).issues).toEqual(['MALFORMED_INPUT']);

    const changedTemplates = [...base.requestTemplates];
    const firstTemplate = changedTemplates[0];
    if (!firstTemplate) throw new Error('Expected a request template');
    changedTemplates[0] = { ...firstTemplate, templateId: `${firstTemplate.templateId}-changed` };
    expect(
      validateExecutableSelectionManifest(initialDraft, {
        ...base,
        requestTemplates: changedTemplates,
      }).valid,
    ).toBe(false);
  });

  it('keeps the full draft deterministic when multiple out-of-matrix cells are reordered', () => {
    const base = current();
    const optionalCells = [
      {
        ...base.requiredCell,
        cellId: 'optional-z',
        classification: 'diagnostic-only' as const,
      },
      {
        ...base.requiredCell,
        cellId: 'optional-a',
        classification: 'excluded-with-reason' as const,
      },
    ];
    const catalogue = {
      ...base.environmentCatalogue,
      cells: [base.requiredCell, ...optionalCells],
    };
    const first = generateExecutableSelectionManifest({ ...base, environmentCatalogue: catalogue });
    const reordered = generateExecutableSelectionManifest({
      ...base,
      environmentCatalogue: {
        ...catalogue,
        cells: [base.requiredCell, ...optionalCells].reverse(),
      },
    });
    expect(first.status).toBe('GENERATED_DRAFT');
    expect(reordered.status).toBe('GENERATED_DRAFT');
    expect(reordered.draft).toEqual(first.draft);
    expect(
      first.draft?.content.exclusions
        .filter((row) => row.code === 'ENVIRONMENT_OUT_OF_MATRIX')
        .map((row) => row.cellId),
    ).toEqual(['optional-a', 'optional-z']);
  });

  it('rejects a same-id environment cell whose declared facts drift from the current catalogue', () => {
    const base = current();
    const changed = {
      ...base,
      requiredCell: { ...base.requiredCell, locale: 'fr-FR' },
    };
    const result = generateExecutableSelectionManifest(changed);
    expect(result.status).toBe('HARNESS_BLOCKED');
    expect(result.code).toBe('INVALID_INPUT');
    expect(result.draft).toBeNull();
    expect(result.releaseCredit).toBe(false);
    const changedVersion = generateExecutableSelectionManifest({
      ...base,
      requiredCell: { ...base.requiredCell, playwrightVersion: '1.0.0' },
    });
    expect(changedVersion.status).toBe('HARNESS_BLOCKED');
    expect(changedVersion.code).toBe('INVALID_INPUT');
    const duplicateCell = generateExecutableSelectionManifest({
      ...base,
      environmentCatalogue: {
        ...base.environmentCatalogue,
        cells: [...base.environmentCatalogue.cells, base.requiredCell],
      },
    });
    expect(duplicateCell.status).toBe('HARNESS_BLOCKED');
    expect(duplicateCell.code).toBe('INVALID_INPUT');
  });

  it('fails closed with the full exclusion ledger when no approved templates can plan', () => {
    const result = generateExecutableSelectionManifest({ ...current(), requestTemplates: [] });
    expect(result.status).toBe('HARNESS_BLOCKED');
    expect(result.code).toBe('NO_RUNNABLE_ENTRIES');
    expect(result.draft).toBeNull();
    expect(result.accounting.selectedCaseCount).toBeGreaterThan(0);
    expect(result.accounting.exclusionCount).toBeGreaterThan(0);
    expect(result.accounting.complete).toBe(true);
    expect(result.accounting.bindings.length).toBeGreaterThan(0);
    expect(
      result.accounting.bindings.reduce((sum, binding) => sum + binding.selection.cases.length, 0),
    ).toBe(result.accounting.exclusions.filter((row) => row.caseKey !== null).length);
    expect(result.releaseCredit).toBe(false);
  });

  it('rejects duplicate coverage bindings before generating a candidate', () => {
    const base = current();
    const models = base.catalogues.coverageCatalogue.models;
    const first = models[0];
    if (!first) throw new Error('Expected a current coverage model');
    const result = generateExecutableSelectionManifest({
      ...base,
      catalogues: {
        ...base.catalogues,
        coverageCatalogue: { ...base.catalogues.coverageCatalogue, models: [...models, first] },
      },
    });
    expect(result.status).toBe('HARNESS_BLOCKED');
    expect(result.code).toBe('INVALID_INPUT');
    expect(result.draft).toBeNull();
    expect(result.releaseCredit).toBe(false);
  });
});

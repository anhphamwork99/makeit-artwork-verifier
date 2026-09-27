import { loadCatalogueBundle, type CatalogueBundle } from '../../src/catalogue/load';
import type {
  CaseIntent,
  CaseRequest,
  PlanResult,
  PlannedPlan,
} from '../../src/contracts/case-model';
import type {
  ApplicationInventory,
  SubjectCatalogue,
  SubjectDeclaration,
} from '../../src/contracts/catalogues';
import type { ExecutionInstanceResult } from '../../src/contracts/execution';

/**
 * Shared fixtures for the production verification foundation contract suite.
 *
 * Every fixture is authoring data: tests mutate cloned catalogues to prove that
 * reconciliation and routing decisions are driven by declarations rather than
 * by any Subject-name branch in the engine.
 */

export function defaultBundle(): CatalogueBundle {
  return loadCatalogueBundle();
}

export function cloneCatalogue(catalogue: SubjectCatalogue): SubjectCatalogue {
  return structuredClone(catalogue);
}

export function cloneInventory(inventory: ApplicationInventory): ApplicationInventory {
  return structuredClone(inventory);
}

export function findDeclaration(
  catalogue: SubjectCatalogue,
  subjectId: string,
): SubjectDeclaration | undefined {
  return catalogue.declarations.find((declaration) => declaration.subjectId === subjectId);
}

export function requireDeclaration(
  catalogue: SubjectCatalogue,
  subjectId: string,
): SubjectDeclaration {
  const declaration = findDeclaration(catalogue, subjectId);
  if (!declaration) throw new Error(`Fixture declaration "${subjectId}" is missing`);
  return declaration;
}

/** A synthetic Subject added purely as catalogue data, with no engine change. */
export function syntheticShapeDeclaration(): SubjectDeclaration {
  return {
    subjectId: 'layer/shape',
    label: 'Shape Layer',
    family: 'layer',
    origin: 'application-backed',
    applicationKind: 'shape',
    variants: [],
    adapter: null,
    allowedParents: null,
    allowedReferences: null,
    allowedChildren: null,
    capabilityBindings: [
      {
        capability: 'move',
        workflowId: 'shared.move',
        variantIndependent: true,
        checks: ['geometry.delta'],
      },
    ],
  };
}

export function catalogueWithSyntheticShape(): {
  catalogue: SubjectCatalogue;
  inventory: ApplicationInventory;
} {
  const bundle = defaultBundle();
  const catalogue = cloneCatalogue(bundle.subjectCatalogue);
  catalogue.declarations.push(syntheticShapeDeclaration());
  const inventory = cloneInventory(bundle.applicationInventory);
  inventory.kinds.push('shape');
  inventory.kinds.sort();
  return { catalogue, inventory };
}

export function baseIntent(overrides: Partial<CaseIntent> = {}): CaseIntent {
  return {
    subjectId: 'layer/text',
    capability: 'move',
    variant: 'plain',
    scenario: 'drag-ordinary',
    preState: { x: 10, y: 10 },
    operations: [{ discriminant: 'move.by', parameters: { dx: 80, dy: 40 } }],
    expected: { minimumDelta: { x: 40, y: 20 } },
    resources: [],
    ...overrides,
  };
}

export function releaseRequest(intent: CaseIntent = baseIntent()): CaseRequest {
  return {
    schemaVersion: 1,
    profile: 'release',
    provenance: 'manifest',
    evidenceDepth: 'standard',
    intent,
  };
}

export function diagnosticRequest(intent: CaseIntent = baseIntent()): CaseRequest {
  return {
    schemaVersion: 1,
    profile: 'diagnostic',
    provenance: 'diagnostic-request',
    evidenceDepth: 'deep',
    intent,
  };
}

export function planned(result: PlanResult): PlannedPlan {
  if (result.status !== 'PLANNED') {
    throw new Error(`Expected PLANNED, received ${result.status}: ${JSON.stringify(result)}`);
  }
  return result;
}

export function instance(
  overrides: Partial<ExecutionInstanceResult> = {},
): ExecutionInstanceResult {
  return {
    executionInstanceId: 'instance-1',
    caseId: 'case-1',
    materializationFingerprint: 'materialization-1',
    planFingerprint: 'plan-1',
    profile: 'release',
    provenance: 'manifest',
    evidenceDepth: 'standard',
    outcome: 'PASS',
    requiredChecks: [{ checkId: 'geometry.delta', passed: true }],
    diagnosticEvidence: [],
    cleanupSucceeded: true,
    predecessor: null,
    ...overrides,
  };
}

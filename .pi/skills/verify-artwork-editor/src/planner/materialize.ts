import type {
  CaseIntent,
  ContractVersions,
  MaterializedCase,
  MaterializedSubject,
  ResolvedFixtureBinding,
} from '../contracts/case-model';
import type { ResolvedSubject } from '../contracts/catalogues';
import type { ResolvedRoute } from '../contracts/case-model';
import { MATERIALIZED_CASE_SCHEMA_VERSION } from '../contracts/schema-versions';

/**
 * Case materialization (decision 0007 stage 5, specification 8.3).
 *
 * The materialized case is the complete immutable resolution of semantic intent
 * against the authoritative catalogues: Subject, adapter, workflow, required
 * checks, and every contract version that produced it. Contract implementation
 * versions live here and never in `caseId`.
 */

export interface ContractVersionInput {
  subjectCatalogueSchemaVersion: number;
  registryFingerprint: string;
  applicationInventoryFingerprint: string;
  operationCatalogueFingerprint: string;
  adapterCatalogueFingerprint: string;
  workflowCatalogueFingerprint: string;
  familyDefaultVersion: number;
  adapterCompatibilityVersion: number;
  workflowVersion: number;
  coverageModelFingerprint: string;
  correctnessProfileFingerprint: string;
}

export function buildContractVersions(input: ContractVersionInput): ContractVersions {
  return { ...input };
}

/**
 * Resolves the effective workflow version. An explicit context override wins so
 * tests and later Work Packages can inject a contract revision; otherwise the
 * authoritative workflow catalogue version is used. A malformed override falls
 * back to the catalogue instead of inventing a version.
 */
export function resolveWorkflowVersion(
  workflowVersions: Readonly<Record<string, number>>,
  workflowId: string,
  catalogueVersion: number,
): number {
  const declared = workflowVersions[workflowId];
  return typeof declared === 'number' && Number.isInteger(declared) && declared > 0
    ? declared
    : catalogueVersion;
}

export interface MaterializeCaseInput {
  caseId: string;
  intent: CaseIntent;
  subject: ResolvedSubject;
  route: ResolvedRoute;
  contracts: ContractVersions;
  fixture?: ResolvedFixtureBinding;
}

export function materializeSubject(subject: ResolvedSubject): MaterializedSubject {
  return {
    subjectId: subject.subjectId,
    family: subject.family,
    origin: subject.origin,
    applicationKind: subject.applicationKind,
    adapter: { ...subject.adapter },
  };
}

export function materializeCase(input: MaterializeCaseInput): MaterializedCase {
  return {
    schemaVersion: MATERIALIZED_CASE_SCHEMA_VERSION,
    caseId: input.caseId,
    intent: input.intent,
    subject: materializeSubject(input.subject),
    route: { ...input.route, checks: [...input.route.checks] },
    contracts: { ...input.contracts },
    ...(input.fixture === undefined ? {} : { fixture: { ...input.fixture } }),
  };
}

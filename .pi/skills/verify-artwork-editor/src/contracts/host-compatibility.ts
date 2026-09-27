import { OBSERVATION_BRIDGE_VERSION } from './seam';

/**
 * Narrow FE-host compatibility descriptor consumed during CLI preflight.
 *
 * This is intentionally not a general plugin or semver framework. The toolkit
 * validates one schema, one observation-bridge version and only the capability
 * versions required by the selected workflow(s). Unknown extra capabilities
 * are tolerated so an older pinned toolkit can run against a newer compatible
 * FE host without weakening any requirement it understands.
 */

/** Closed schema version of the host compatibility descriptor. */
export const HOST_COMPATIBILITY_SCHEMA_VERSION = 1;

/** Closed capability/version requirements currently understood by the toolkit. */
export const HOST_CAPABILITY_REQUIREMENTS = Object.freeze({
  'image-upload.public-control': 'role-name-v1',
  'nested-object.identity-wrapper': 'chain-v1',
  'history.semantic-transition': 'meaning-revision-v1',
} as const);

export type HostCapabilityId = keyof typeof HOST_CAPABILITY_REQUIREMENTS;

/** FE-owned declaration embedded in the product-meaning provider export. */
export interface HostCompatibilityDescriptorV1 {
  readonly schemaVersion: number;
  readonly bridgeVersion: number;
  readonly capabilities: Readonly<Record<string, string>>;
}

export type HostCompatibilityDiagnosticCode =
  | 'HOST_COMPATIBILITY_DESCRIPTOR_INVALID'
  | 'HOST_BRIDGE_VERSION_INCOMPATIBLE'
  | 'HOST_CAPABILITY_MISSING'
  | 'HOST_CAPABILITY_INCOMPATIBLE';

export type HostCompatibilityAssessment =
  | {
      readonly ok: true;
      readonly descriptor: HostCompatibilityDescriptorV1;
      readonly requiredCapabilities: readonly HostCapabilityId[];
    }
  | {
      readonly ok: false;
      readonly code: HostCompatibilityDiagnosticCode;
      readonly detail: string;
      readonly context: Readonly<Record<string, string>>;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizedCapabilityRequirements(
  workflowIds: readonly string[],
): readonly HostCapabilityId[] {
  const required = new Set<HostCapabilityId>();
  for (const workflowId of workflowIds) {
    if (workflowId === 'image.upload-replace') {
      required.add('image-upload.public-control');
    } else if (workflowId === 'object.move') {
      required.add('nested-object.identity-wrapper');
    } else if (workflowId === 'shared.history') {
      required.add('history.semantic-transition');
    }
  }
  return [...required].sort();
}

/**
 * Returns the exact host capabilities required by the selected workflow set.
 * Workflows without a specialized compatibility boundary require only the
 * global descriptor and bridge-version checks.
 */
export function requiredHostCapabilitiesForWorkflows(
  workflowIds: readonly string[],
): readonly HostCapabilityId[] {
  return normalizedCapabilityRequirements(workflowIds);
}

/**
 * Validates the FE declaration and the selected plan's exact requirements.
 * Every failure is a pre-allocation harness refusal; none is a product `BUG`.
 */
export function assessHostCompatibility(
  candidate: unknown,
  workflowIds: readonly string[],
): HostCompatibilityAssessment {
  if (!isRecord(candidate)) {
    return {
      ok: false,
      code: 'HOST_COMPATIBILITY_DESCRIPTOR_INVALID',
      detail: 'The FE host exposes no object-valued compatibility descriptor.',
      context: {},
    };
  }

  if (
    !Number.isInteger(candidate.schemaVersion) ||
    candidate.schemaVersion !== HOST_COMPATIBILITY_SCHEMA_VERSION
  ) {
    return {
      ok: false,
      code: 'HOST_COMPATIBILITY_DESCRIPTOR_INVALID',
      detail: `The FE host compatibility descriptor must declare schema ${HOST_COMPATIBILITY_SCHEMA_VERSION}.`,
      context: {
        expectedSchemaVersion: String(HOST_COMPATIBILITY_SCHEMA_VERSION),
        observedSchemaVersion: String(candidate.schemaVersion),
      },
    };
  }

  if (!Number.isInteger(candidate.bridgeVersion)) {
    return {
      ok: false,
      code: 'HOST_COMPATIBILITY_DESCRIPTOR_INVALID',
      detail: 'The FE host compatibility descriptor declares no integer bridge version.',
      context: {},
    };
  }
  if (candidate.bridgeVersion !== OBSERVATION_BRIDGE_VERSION) {
    return {
      ok: false,
      code: 'HOST_BRIDGE_VERSION_INCOMPATIBLE',
      detail: `The FE host declares observation bridge v${String(candidate.bridgeVersion)}; this toolkit requires v${OBSERVATION_BRIDGE_VERSION}.`,
      context: {
        expectedBridgeVersion: String(OBSERVATION_BRIDGE_VERSION),
        observedBridgeVersion: String(candidate.bridgeVersion),
      },
    };
  }

  if (!isRecord(candidate.capabilities)) {
    return {
      ok: false,
      code: 'HOST_COMPATIBILITY_DESCRIPTOR_INVALID',
      detail: 'The FE host compatibility descriptor declares no capability map.',
      context: {},
    };
  }
  for (const [capabilityId, version] of Object.entries(candidate.capabilities)) {
    if (
      capabilityId.trim().length === 0 ||
      typeof version !== 'string' ||
      version.trim().length === 0
    ) {
      return {
        ok: false,
        code: 'HOST_COMPATIBILITY_DESCRIPTOR_INVALID',
        detail:
          'The FE host compatibility descriptor contains an invalid capability declaration.',
        context: {},
      };
    }
  }
  const capabilities = candidate.capabilities as Readonly<Record<string, string>>;

  const requiredCapabilities = normalizedCapabilityRequirements(workflowIds);
  for (const capabilityId of requiredCapabilities) {
    const expectedVersion = HOST_CAPABILITY_REQUIREMENTS[capabilityId];
    const observedVersion = capabilities[capabilityId];
    if (observedVersion === undefined) {
      return {
        ok: false,
        code: 'HOST_CAPABILITY_MISSING',
        detail: `The selected Diagnostic plan requires FE host capability "${capabilityId}" at version "${expectedVersion}", but the host does not declare it.`,
        context: { capabilityId, expectedVersion },
      };
    }
    if (observedVersion !== expectedVersion) {
      return {
        ok: false,
        code: 'HOST_CAPABILITY_INCOMPATIBLE',
        detail: `The selected Diagnostic plan requires FE host capability "${capabilityId}" at version "${expectedVersion}", but the host declares "${observedVersion}".`,
        context: { capabilityId, expectedVersion, observedVersion },
      };
    }
  }

  return {
    ok: true,
    descriptor: candidate as unknown as HostCompatibilityDescriptorV1,
    requiredCapabilities,
  };
}

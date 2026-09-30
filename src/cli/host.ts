import { createDiagnostic } from '../contracts/diagnostics';
import {
  assessHostCompatibility,
  type HostCompatibilityDescriptorV1,
} from '../contracts/host-compatibility';
import type { CliResult } from '../contracts/runtime';
import { loadProductMeaningProvider } from '../runtime/product-meaning-provider';
import { buildCliResult } from './output';

export interface HostDoctorDetails {
  readonly appRootValidated: boolean;
  readonly providerEntryLoaded: boolean;
  readonly providerSchemaVersion: number | null;
  readonly providerProfileId: string | null;
  readonly compatibility: HostCompatibilityDescriptorV1 | null;
  readonly requiredCapabilities: readonly string[];
}

function emptyDetails(): HostDoctorDetails {
  return {
    appRootValidated: false,
    providerEntryLoaded: false,
    providerSchemaVersion: null,
    providerProfileId: null,
    compatibility: null,
    requiredCapabilities: [],
  };
}

/**
 * Read-only, pre-allocation compatibility probe for an arbitrary FE checkout.
 *
 * Unlike the runtime Doctor, this command never allocates a port, starts Next,
 * launches a browser or writes evidence. Repository names and remotes are
 * intentionally irrelevant: compatibility is decided only by the versioned
 * provider and host descriptor loaded from the explicit application root.
 */
export async function runHostDoctorCommand(
  appRoot: string | undefined,
): Promise<CliResult<HostDoctorDetails>> {
  if (typeof appRoot !== 'string' || appRoot.trim().length === 0) {
    const detail = 'host doctor requires an explicit `--app-root <path>`.';
    return buildCliResult({
      command: 'host',
      subcommand: 'doctor',
      status: 'USAGE',
      detail,
      launchAttempted: false,
      details: emptyDetails(),
      diagnostics: [createDiagnostic('CLI_USAGE_INVALID', detail)],
    });
  }

  const providerResult = await loadProductMeaningProvider(appRoot);
  if (!providerResult.ok) {
    const detail = 'Host product-meaning provider preflight failed.';
    return buildCliResult({
      command: 'host',
      subcommand: 'doctor',
      status: 'HARNESS_BLOCKED',
      detail,
      launchAttempted: false,
      details: emptyDetails(),
      diagnostics: [
        createDiagnostic('PRODUCT_MEANING_PROVIDER_UNAVAILABLE', detail, {
          context: { appRootCode: providerResult.code },
        }),
      ],
    });
  }

  const provider = providerResult.ref.provider;
  const compatibility = assessHostCompatibility(provider.hostCompatibility, []);
  if (!compatibility.ok) {
    return buildCliResult({
      command: 'host',
      subcommand: 'doctor',
      status: 'HARNESS_BLOCKED',
      detail: compatibility.detail,
      launchAttempted: false,
      details: {
        ...emptyDetails(),
        appRootValidated: true,
        providerEntryLoaded: true,
        providerSchemaVersion: provider.schemaVersion,
        providerProfileId: provider.profileId,
      },
      diagnostics: [
        createDiagnostic(compatibility.code, compatibility.detail, {
          context: compatibility.context,
        }),
      ],
    });
  }

  return buildCliResult({
    command: 'host',
    subcommand: 'doctor',
    status: 'PASS',
    detail: 'The application checkout satisfies the versioned verifier host contract.',
    launchAttempted: false,
    details: {
      appRootValidated: true,
      providerEntryLoaded: true,
      providerSchemaVersion: provider.schemaVersion,
      providerProfileId: provider.profileId,
      compatibility: compatibility.descriptor,
      requiredCapabilities: compatibility.requiredCapabilities,
    },
  });
}

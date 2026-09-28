import type { AdapterCatalogue, AdapterDeclaration } from '../contracts/catalogues';
import type { SubjectAdapter } from '../contracts/adapter';
import { createDiagnostic, type DiagnosticRecord } from '../contracts/diagnostics';
import { imageSpecializedAdapter } from './image-specialized';
import { objectSpecializedAdapter } from './object-specialized';
import { textSpecializedAdapter } from './text-specialized';
import { generatedSpecializedAdapter } from './generated-specialized';
import { defaultAdapter } from './default-specialized';

/**
 * Data-routed adapter registry (specification 6.3; WP5 Slice 5-A).
 *
 * The registry is a declarative data map from catalogue `adapterId` to an
 * implemented `SubjectAdapter`. There is no branch on Subject identity, family,
 * application kind, or renderer flag: the engine resolves exactly one adapter
 * per Subject by catalogue data and then looks up its implementation here.
 *
 * An adapter id that the catalogue declares but this toolkit has not delivered,
 * or a compatibility-version disagreement, is a blocking *pre-launch*
 * `ADAPTER_IMPLEMENTATION_UNAVAILABLE`, so an undelivered slice cannot silently
 * launch.
 */

export const ADAPTER_IMPLEMENTATIONS: Readonly<Record<string, SubjectAdapter>> = {
  default: defaultAdapter(),
  'generated-specialized': generatedSpecializedAdapter(),
  'image-specialized': imageSpecializedAdapter(),
  'object-specialized': objectSpecializedAdapter(),
  'text-specialized': textSpecializedAdapter(),
};

export interface AdapterRegistryInput {
  catalogue: AdapterCatalogue;
  declaration: AdapterDeclaration;
}

export type AdapterRegistryResult =
  | { ok: true; adapter: SubjectAdapter }
  | { ok: false; finding: DiagnosticRecord };

export function resolveAdapterImplementation(input: AdapterRegistryInput): AdapterRegistryResult {
  const declared = input.catalogue.adapters.find(
    (entry) => entry.adapterId === input.declaration.adapterId,
  );
  if (!declared) {
    return {
      ok: false,
      finding: createDiagnostic(
        'ADAPTER_IMPLEMENTATION_UNAVAILABLE',
        `Adapter "${input.declaration.adapterId}" is not declared in the approved adapter catalogue.`,
        { context: { adapterId: input.declaration.adapterId } },
      ),
    };
  }
  if (declared.compatibilityVersion !== input.declaration.compatibilityVersion) {
    return {
      ok: false,
      finding: createDiagnostic(
        'ADAPTER_IMPLEMENTATION_UNAVAILABLE',
        `Adapter "${input.declaration.adapterId}" declares compatibility v${input.declaration.compatibilityVersion} but the catalogue declares v${declared.compatibilityVersion}.`,
        {
          context: {
            adapterId: input.declaration.adapterId,
            declaredVersion: String(declared.compatibilityVersion),
            requestedVersion: String(input.declaration.compatibilityVersion),
          },
        },
      ),
    };
  }
  const implementation = ADAPTER_IMPLEMENTATIONS[input.declaration.adapterId];
  if (!implementation) {
    return {
      ok: false,
      finding: createDiagnostic(
        'ADAPTER_IMPLEMENTATION_UNAVAILABLE',
        `Adapter "${input.declaration.adapterId}" is declared and version-compatible but no toolkit implementation is delivered.`,
        { context: { adapterId: input.declaration.adapterId } },
      ),
    };
  }
  if (implementation.compatibilityVersion !== input.declaration.compatibilityVersion) {
    return {
      ok: false,
      finding: createDiagnostic(
        'ADAPTER_IMPLEMENTATION_UNAVAILABLE',
        `Adapter implementation "${implementation.adapterId}" is version ${implementation.compatibilityVersion}, not the requested ${input.declaration.compatibilityVersion}.`,
        { context: { adapterId: input.declaration.adapterId } },
      ),
    };
  }
  return { ok: true, adapter: implementation };
}

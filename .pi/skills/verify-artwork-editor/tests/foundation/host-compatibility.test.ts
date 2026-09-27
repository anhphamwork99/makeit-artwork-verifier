import { describe, expect, it } from 'vitest';

import {
  HOST_CAPABILITY_REQUIREMENTS,
  assessHostCompatibility,
  requiredHostCapabilitiesForWorkflows,
} from '../../src/contracts/host-compatibility';

const compatible = Object.freeze({
  schemaVersion: 1,
  bridgeVersion: 7,
  capabilities: Object.freeze({
    ...HOST_CAPABILITY_REQUIREMENTS,
    'future.extra-capability': 'v99',
  }),
});

describe('FE host compatibility preflight', () => {
  it('derives only the capabilities used by selected workflows', () => {
    expect(
      requiredHostCapabilitiesForWorkflows([
        'shared.move',
        'image.upload-replace',
        'shared.history',
        'image.upload-replace',
      ]),
    ).toEqual(['history.semantic-transition', 'image-upload.public-control']);
  });

  it('accepts compatible selected capabilities and ignores unknown extras', () => {
    const result = assessHostCompatibility(compatible, [
      'image.upload-replace',
      'object.move',
      'shared.history',
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.requiredCapabilities).toEqual([
        'history.semantic-transition',
        'image-upload.public-control',
        'nested-object.identity-wrapper',
      ]);
    }
  });

  it('rejects a missing selected capability without allocation semantics', () => {
    const result = assessHostCompatibility(
      {
        schemaVersion: 1,
        bridgeVersion: 7,
        capabilities: { 'history.semantic-transition': 'meaning-revision-v1' },
      },
      ['image.upload-replace'],
    );
    expect(result).toMatchObject({
      ok: false,
      code: 'HOST_CAPABILITY_MISSING',
      context: {
        capabilityId: 'image-upload.public-control',
        expectedVersion: 'role-name-v1',
      },
    });
  });

  it('rejects a selected capability version mismatch', () => {
    const result = assessHostCompatibility(
      {
        schemaVersion: 1,
        bridgeVersion: 7,
        capabilities: {
          'nested-object.identity-wrapper': 'chain-v2',
        },
      },
      ['object.move'],
    );
    expect(result).toMatchObject({
      ok: false,
      code: 'HOST_CAPABILITY_INCOMPATIBLE',
      context: {
        capabilityId: 'nested-object.identity-wrapper',
        expectedVersion: 'chain-v1',
        observedVersion: 'chain-v2',
      },
    });
  });

  it('rejects an incompatible bridge version even for an unprofiled workflow', () => {
    const result = assessHostCompatibility(
      { schemaVersion: 1, bridgeVersion: 8, capabilities: {} },
      ['shared.move'],
    );
    expect(result).toMatchObject({
      ok: false,
      code: 'HOST_BRIDGE_VERSION_INCOMPATIBLE',
    });
  });
});

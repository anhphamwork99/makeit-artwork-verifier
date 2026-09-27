import { describe, expect, it } from 'vitest';

import type { ResolvedSubject } from '../../src/contracts/catalogues';
import { reconcileRegistry } from '../../src/registry/reconcile';
import {
  evaluateVariantPolicy,
  resolveAdapterForSubject,
  resolveCapabilityBinding,
  resolveRoute,
} from '../../src/routing/resolve';
import { defaultBundle } from './helpers';

function resolvedSubject(subjectId: string): ResolvedSubject {
  const reconciliation = reconcileRegistry(defaultBundle());
  const subject = reconciliation.resolvedSubjects.find((entry) => entry.subjectId === subjectId);
  if (!subject) throw new Error(`Resolved Subject "${subjectId}" is missing`);
  return subject;
}

describe('[Gate A] declarative adapter and workflow routing (TS-1)', () => {
  it('resolves the declaration-declared specialized adapter for a whole Subject', () => {
    const subject = resolvedSubject('layer/text');

    expect(resolveAdapterForSubject(subject)).toEqual({
      adapterId: 'text-specialized',
      compatibilityVersion: 3,
    });
    expect(subject.adapterProvenance).toBe('override');
  });

  it('inherits the family-default adapter with explicit provenance', () => {
    const subject = resolvedSubject('layer/vector');

    expect(resolveAdapterForSubject(subject)).toEqual({
      adapterId: 'default',
      compatibilityVersion: 1,
    });
    expect(subject.adapterProvenance).toBe('family-default');
    expect(subject.familyDefaultVersion).toBe(1);
  });

  it('selects one image-specialized adapter for layer/image', () => {
    const subject = resolvedSubject('layer/image');

    expect(resolveAdapterForSubject(subject)).toEqual({
      adapterId: 'image-specialized',
      compatibilityVersion: 2,
    });
    expect(subject.adapterProvenance).toBe('override');

    const adapters = new Set<string>();
    for (const binding of subject.capabilityBindings) {
      const route = resolveRoute(subject, binding.capability);
      expect(route.ok).toBe(true);
      if (route.ok) adapters.add(route.route.adapterId);
    }
    expect([...adapters]).toEqual(['image-specialized']);
  });

  it('keeps one adapter for every Capability binding of a Subject', () => {
    const subject = resolvedSubject('layer/text');
    const adapters = new Set<string>();

    for (const binding of subject.capabilityBindings) {
      const route = resolveRoute(subject, binding.capability);
      expect(route.ok).toBe(true);
      if (route.ok) adapters.add(route.route.adapterId);
    }

    expect([...adapters]).toEqual(['text-specialized']);
  });

  it('resolves the workflow and required checks from the Capability binding', () => {
    const route = resolveRoute(resolvedSubject('layer/text'), 'move');

    expect(route.ok).toBe(true);
    if (route.ok) {
      expect(route.route).toEqual({
        subjectId: 'layer/text',
        adapterId: 'text-specialized',
        adapterCompatibilityVersion: 3,
        workflowId: 'shared.move',
        capability: 'move',
        checks: ['geometry.delta'],
      });
    }
  });

  it('reports an unsupported Capability as a blocking finding', () => {
    const resolution = resolveCapabilityBinding(resolvedSubject('selection/current'), 'rotate');

    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.finding.code).toBe('CAPABILITY_UNSUPPORTED');
      expect(resolution.finding.severity).toBe('blocking');
    }
  });

  it('accepts a declared variant as declared coverage', () => {
    const subject = resolvedSubject('layer/text');
    const binding = resolveCapabilityBinding(subject, 'move');

    expect(binding.ok).toBe(true);
    if (binding.ok) {
      const policy = evaluateVariantPolicy(subject, binding.binding, 'warp-circle');
      expect(policy.status).toBe('declared');
      expect(policy.finding).toBeNull();
      expect(policy.blocked).toBe(false);
      expect(policy.coverageIncomplete).toBe(false);
    }
  });

  it('warns without blocking an unknown variant on a variant-independent binding', () => {
    const subject = resolvedSubject('layer/text');
    const binding = resolveCapabilityBinding(subject, 'move');

    expect(binding.ok).toBe(true);
    if (binding.ok) {
      const policy = evaluateVariantPolicy(subject, binding.binding, 'unseen-runtime-variant');
      expect(policy.status).toBe('unknown');
      expect(policy.blocked).toBe(false);
      expect(policy.coverageIncomplete).toBe(true);
      expect(policy.finding).toMatchObject({
        code: 'SUBJECT_VARIANT_UNKNOWN',
        severity: 'warning',
        subjectId: 'layer/text',
      });
    }
  });

  it('blocks an unknown variant on a binding without validated variant independence', () => {
    const subject = resolvedSubject('layer/text');
    const binding = resolveCapabilityBinding(subject, 'editContent');

    expect(binding.ok).toBe(true);
    if (binding.ok) {
      expect(binding.binding.variantIndependent).toBe(false);
      const policy = evaluateVariantPolicy(subject, binding.binding, 'warp-does-not-exist');
      expect(policy.status).toBe('unknown');
      expect(policy.blocked).toBe(true);
    }
  });
});

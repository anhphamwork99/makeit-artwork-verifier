import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Request, Route } from '@playwright/test';

import { findResource, loadResourceManifest } from '../../src/catalogue/resources';
import type { ResourceManifestEntry } from '../../src/contracts/resources';
import { resolveResource, type ResolvedResource } from '../../src/resources/resolve';
import { registerResourceRoutes, resourceResponseHeaders } from '../../src/resources/routes';
import { fulfilledCount } from '../../src/resources/request-log';

const SKILL_ROOT = path.resolve(process.cwd(), '.pi', 'skills', 'verify-artwork-editor');
const FILES_ROOT = path.join(SKILL_ROOT, 'fixtures', 'resources', 'files');
const ORIGIN = 'http://127.0.0.1:55958';

class FakeRoute {
  fulfilled: { status?: number; headers?: Record<string, string>; body?: unknown } | null = null;
  aborted: string | null = null;
  continued = false;

  async fulfill(options: { status?: number; headers?: Record<string, string>; body?: unknown }) {
    this.fulfilled = options;
  }

  async abort(code?: string) {
    this.aborted = code ?? 'failed';
  }

  async continue() {
    this.continued = true;
  }
}

class FakeRequest {
  constructor(
    private readonly requestUrl: string,
    private readonly requestMethod: string,
  ) {}

  url() {
    return this.requestUrl;
  }

  method() {
    return this.requestMethod;
  }
}

type Matcher = (url: URL) => boolean;
type Handler = (route: Route, request: Request) => Promise<void>;

class FakeContext {
  readonly entries: { id: symbol; matcher: Matcher; handler: Handler }[] = [];

  async route(matcher: Matcher, handler: Handler): Promise<void> {
    this.entries.push({ id: Symbol('handler'), matcher, handler });
  }

  async unroute(matcher: Matcher, handler: Handler): Promise<void> {
    const index = this.entries.findIndex(
      (entry) => entry.matcher === matcher && entry.handler === handler,
    );
    if (index >= 0) this.entries.splice(index, 1);
  }

  async dispatch(url: string, method = 'GET'): Promise<FakeRoute | null> {
    for (const entry of this.entries) {
      if (entry.matcher(new URL(url))) {
        const route = new FakeRoute();
        await entry.handler(
          route as unknown as Route,
          new FakeRequest(url, method) as unknown as Request,
        );
        return route;
      }
    }
    return null;
  }
}

function entry(logicalId: string): ResourceManifestEntry {
  return findResource(loadResourceManifest(), logicalId, 1) as ResourceManifestEntry;
}

function resourceFor(logicalId: string): ResolvedResource {
  return resolveResource({
    entry: entry(logicalId),
    filesRoot: FILES_ROOT,
    origin: ORIGIN,
    runId: 'run-1',
    executionInstanceId: 'instance-1',
  });
}

async function install(): Promise<{
  context: FakeContext;
  installed: Awaited<ReturnType<typeof registerResourceRoutes>>;
  resources: ResolvedResource[];
}> {
  const context = new FakeContext();
  const resources = [resourceFor('image.upload-a'), resourceFor('image.upload-b')];
  const installed = await registerResourceRoutes({
    context: context as never,
    origin: ORIGIN,
    resources,
    runId: 'run-1',
  });
  return { context, installed, resources };
}

describe('verification resource routes — ownership, shape, denial, cleanup (tests 5–10)', () => {
  it('fulfills exactly one A and one B preflight request with deterministic bytes and headers', async () => {
    const { context, installed, resources } = await install();
    for (const resource of resources) {
      const route = await context.dispatch(resource.sameOriginUrl);
      expect(route?.fulfilled?.status).toBe(200);
      expect(route?.fulfilled?.headers).toEqual(resourceResponseHeaders(resource));
      expect((route?.fulfilled?.body as Buffer | undefined)?.byteLength).toBe(resource.byteLength);
      expect(
        (route?.fulfilled?.body as Buffer).equals(
          readFileSync(path.join(FILES_ROOT, resource.filename)),
        ),
      ).toBe(true);
    }
    expect(installed.declaredRequestCount()).toBe(2);
    expect(fulfilledCount(installed.log, 'image.upload-a')).toBe(1);
    expect(fulfilledCount(installed.log, 'image.upload-b')).toBe(1);
    expect(installed.log.records.every((record) => record.disposition === 'fulfilled')).toBe(true);
  });

  it('denies and logs wrong method, query, path, host, undeclared resource and reserved escapes', async () => {
    const { context, installed } = await install();
    const a = resourceFor('image.upload-a');

    await context.dispatch(a.sameOriginUrl, 'POST');
    await context.dispatch(`${a.sameOriginUrl}?x=1`);
    await context.dispatch('http://127.0.0.1:55958/__artwork-verification__/v1/undeclared');
    await context.dispatch('http://127.0.0.1:55958/__artwork-verification__/v1/runs/other/escape');
    await context.dispatch('http://192.168.1.5:80/__artwork-verification__/v1/resource');
    await context.dispatch('http://evil.example.com/__artwork-verification__/v1/resource');

    const denied = installed.log.records.filter(
      (record) =>
        record.disposition === 'denied-undeclared' || record.disposition === 'denied-shape',
    );
    expect(denied).toHaveLength(6);
    // The wrong-method request addresses a declared resource path but is
    // denied by shape; no declared request is ever fulfilled here.
    expect(installed.declaredRequestCount()).toBe(1);
    expect(fulfilledCount(installed.log, 'image.upload-a')).toBe(0);
  });

  it('denies external non-loopback traffic while leaving owned loopback app traffic untouched', async () => {
    const { context, installed } = await install();
    const external = await context.dispatch('https://api.example.com/data');
    expect(external?.aborted).toBe('blockedbyclient');
    const hmr = await context.dispatch('http://127.0.0.1:55958/_next/static/chunk.js');
    expect(hmr).toBeNull();
    expect(
      installed.log.records.filter((record) => record.disposition === 'denied-undeclared'),
    ).toHaveLength(1);
  });

  it('unregisters only the exact owned handler by identity', async () => {
    const { context, installed } = await install();
    expect(context.entries).toHaveLength(1);
    await installed.unregister();
    expect(context.entries).toHaveLength(0);
    // A second unregister is a no-op and never removes a foreign handler.
    const foreign = context.entries.length;
    await installed.unregister();
    expect(context.entries).toHaveLength(foreign);
  });

  it('records route facts that carry no product authority for any Oracle check', async () => {
    const { context, installed } = await install();
    const a = resourceFor('image.upload-a');
    await context.dispatch(a.sameOriginUrl);
    const record = installed.log.records[0];
    expect(record).toBeDefined();
    expect(Object.keys(record as object).sort()).toEqual(
      [
        'canonicalPath',
        'consumer',
        'disposition',
        'expectedSha256',
        'fulfilledAtMs',
        'logicalId',
        'matchedAtMs',
        'method',
        'originMatched',
        'requestFinishedAtMs',
        'requestId',
        'requestStartedAtMs',
        'resourceVersion',
        'responseByteLength',
        'responseStatus',
        'schemaVersion',
      ].sort(),
    );
    // No rendered RGBA, probe, decoded-dimension, or observation field exists,
    // so a route record can never satisfy an image Oracle check.
    expect(JSON.stringify(record)).not.toContain('rgba');
    expect(JSON.stringify(record)).not.toContain('probe');
    expect(JSON.stringify(record)).not.toContain('observationId');
  });
});

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { BrowserContext, Request, Route } from '@playwright/test';

import { sha256Of } from '../catalogue/resources';
import { createDiagnostic, type DiagnosticRecord } from '../contracts/diagnostics';
import type { ResolvedResource } from './resolve';
import { RESOURCE_LOOPBACK_HOST, RESOURCE_ROUTE_PREFIX, assertLoopbackOrigin } from './resolve';
import {
  beginResourceRequest,
  createResourceRequestLog,
  type ResourceRequestLog,
} from './request-log';

/**
 * Case-owned Playwright resource routes (WP5 Slice 5-C).
 *
 * One case context owns exactly one handler, installed before navigation and
 * removed by exact handler identity before context closure. The handler:
 *
 *  - fulfills only an exact declared GET origin/path/no-query match with a
 *    deterministic, time-invariant response;
 *  - aborts and logs any undeclared reserved-path request, wrong-method/shape
 *    request, or external non-loopback `http:`/`https:` request;
 *  - leaves owned Next/HMR loopback traffic to the owned server.
 *
 * No fixture server, broad `**\/*` mock, or shared context is introduced.
 */

export interface ResourceRouteOwnership {
  logicalId: string;
  version: number;
  url: string;
  pathname: string;
  handlerIdentity: string;
  registeredAt: string;
}

export interface InstalledResourceRoutes {
  ownership: readonly ResourceRouteOwnership[];
  log: ResourceRequestLog;
  /** Number of declared-route requests observed (preflight + any extra). */
  declaredRequestCount(): number;
  unregister(): Promise<void>;
}

export interface RegisterResourceRoutesInput {
  context: BrowserContext;
  origin: string;
  resources: readonly ResolvedResource[];
  /** Owned run id, recorded for diagnostics only. */
  runId: string;
}

function isExternalHttp(url: URL): boolean {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return !(url.protocol === 'http:' && url.hostname === RESOURCE_LOOPBACK_HOST);
}

/** Deterministic, time-invariant response headers for a declared resource. */
export function resourceResponseHeaders(resource: ResolvedResource): Record<string, string> {
  return {
    'content-type': resource.mimeType,
    'content-length': String(resource.byteLength),
    'cache-control': 'private, max-age=31536000, immutable',
    etag: `"sha256-${resource.sha256}"`,
    'x-content-type-options': 'nosniff',
  };
}

/** Structural Playwright route context surface, so tests can use a fake. */
export interface ResourceRouteContext {
  route(
    matcher: (url: URL) => boolean,
    handler: (route: Route, request: Request) => Promise<void>,
  ): Promise<void> | void;
  unroute(
    matcher: (url: URL) => boolean,
    handler: (route: Route, request: Request) => Promise<void>,
  ): Promise<void> | void;
}

export async function registerResourceRoutes(
  input: RegisterResourceRoutesInput,
): Promise<InstalledResourceRoutes> {
  assertLoopbackOrigin(input.origin);
  const context = input.context as unknown as ResourceRouteContext;
  const log = createResourceRequestLog();
  const byUrl = new Map<string, { resource: ResolvedResource; bytes: Buffer; url: URL }>();
  const ownership: ResourceRouteOwnership[] = [];

  for (const resource of input.resources) {
    // Re-read and re-hash exactly at registration so a modified file blocks
    // before any browser request can be fulfilled.
    const bytes = readFileSync(resource.absoluteFilePath);
    if (bytes.byteLength !== resource.byteLength || sha256Of(bytes) !== resource.sha256) {
      throw new Error(
        `Resolved resource "${resource.logicalId}" bytes changed after resolution; refusing to register its route.`,
      );
    }
    const url = new URL(resource.sameOriginUrl);
    byUrl.set(url.toString(), { resource, bytes, url });
    ownership.push({
      logicalId: resource.logicalId,
      version: resource.version,
      url: url.toString(),
      pathname: url.pathname,
      handlerIdentity: `resource-route:${randomUUID()}`,
      registeredAt: new Date().toISOString(),
    });
  }

  const matcher = (url: URL): boolean =>
    url.pathname.startsWith(RESOURCE_ROUTE_PREFIX) || isExternalHttp(url);

  const handler = async (route: Route, request: Request): Promise<void> => {
    const url = new URL(request.url());
    const startedAtMs = Date.now();
    const declared = byUrl.get(url.toString());
    const reserved = url.pathname.startsWith(RESOURCE_ROUTE_PREFIX);
    const record = beginResourceRequest(log, {
      requestId: randomUUID(),
      logicalId: declared?.resource.logicalId ?? null,
      resourceVersion: declared?.resource.version ?? null,
      expectedSha256: declared?.resource.sha256 ?? null,
      method: request.method(),
      canonicalPath: url.pathname,
      originMatched: url.origin === new URL(input.origin).origin,
      startedAtMs,
    });

    if (declared === undefined) {
      record.matchedAtMs = Date.now();
      record.disposition = 'denied-undeclared';
      record.responseStatus = 403;
      await route.abort('blockedbyclient').catch(() => undefined);
      record.requestFinishedAtMs = Date.now();
      return;
    }

    // Exact shape: GET, owned origin, exact path, no query, no fragment.
    const declaredUrl = declared.url;
    const shapeOk =
      request.method() === 'GET' &&
      url.origin === new URL(input.origin).origin &&
      url.origin === declaredUrl.origin &&
      url.pathname === declaredUrl.pathname &&
      url.search === '' &&
      url.hash === '';

    if (!shapeOk) {
      record.matchedAtMs = Date.now();
      record.disposition = 'denied-shape';
      record.responseStatus = 400;
      await route.abort('blockedbyclient').catch(() => undefined);
      record.requestFinishedAtMs = Date.now();
      return;
    }

    record.matchedAtMs = Date.now();
    try {
      await route.fulfill({
        status: 200,
        headers: resourceResponseHeaders(declared.resource),
        body: declared.bytes,
      });
      record.disposition = 'fulfilled';
      record.responseStatus = 200;
      record.responseByteLength = declared.bytes.byteLength;
      record.fulfilledAtMs = Date.now();
      record.requestFinishedAtMs = Date.now();
      record.consumer = 'resource-preflight';
    } catch {
      record.disposition = 'failed';
      record.responseStatus = null;
      record.requestFinishedAtMs = Date.now();
    }
  };

  await context.route(matcher, handler);

  return {
    ownership,
    log,
    declaredRequestCount: () => log.records.filter((record) => record.logicalId !== null).length,
    unregister: async () => {
      await context.unroute(matcher, handler);
    },
  };
}

/** Blocking finding for an extra undeclared/external request, or `null`. */
export function extraResourceRequestFinding(log: ResourceRequestLog): DiagnosticRecord | null {
  const undeclared = log.records.filter((record) => record.disposition === 'denied-undeclared');
  if (undeclared.length === 0) return null;
  return createDiagnostic(
    'RESOURCE_REQUEST_DENIED',
    `Denied ${undeclared.length} undeclared/external request(s) during the image drive.`,
    { context: { count: String(undeclared.length) } },
  );
}

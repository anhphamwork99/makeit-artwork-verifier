import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  DiagnosticSuiteValidationError,
  deriveDiagnosticSuiteFingerprint,
  isDiagnosticSuiteId,
  parseDiagnosticSuite,
  type DiagnosticSuiteCaseV1,
  type DiagnosticSuiteId,
  type DiagnosticSuiteV1,
} from '../contracts/suite';
import { resolveSkillRoot } from '../runtime/paths';

/**
 * Suite declaration and stable-request loading (ADR 0019 R12).
 *
 * The stable declaration lives under `cases/diagnostic/suites/` and every
 * member request under `cases/diagnostic/requests/`. Nothing in this module
 * reads `tests/**`, and nothing here launches, plans, or allocates: it only
 * loads and validates closed authoring data so the coordinator can fail closed
 * before it starts child 1.
 */

export const SUITE_DECLARATION_FILES: Readonly<Record<DiagnosticSuiteId, string>> = {
  representative: 'cases/diagnostic/suites/representative.v1.json',
};

export interface LoadedDiagnosticSuite {
  suite: DiagnosticSuiteV1;
  fingerprint: string;
  /** Absolute path of the declaration, for reading only; never recorded. */
  declarationPath: string;
  /** Canonical skill-relative declaration path. */
  declarationRelativePath: string;
  /** Absolute skill root the request paths resolve against. */
  skillRoot: string;
}

export interface ResolvedSuiteRequest {
  declaration: DiagnosticSuiteCaseV1;
  /** Canonical skill-relative path from the declaration. */
  relativePath: string;
  /** Absolute read path; used only to read the request bytes. */
  absolutePath: string;
  request: unknown;
}

export interface LoadDiagnosticSuiteOptions {
  /** Skill root override; defaults to the verification toolkit root. */
  rootDir?: string;
}

function invalid(message: string): never {
  throw new DiagnosticSuiteValidationError('DIAGNOSTIC_SUITE_INVALID', message);
}

/** Loads, parses, and fingerprints one suite declaration for `suiteId`. */
export function loadDiagnosticSuite(
  suiteId: string,
  options: LoadDiagnosticSuiteOptions = {},
): LoadedDiagnosticSuite {
  if (!isDiagnosticSuiteId(suiteId)) {
    throw new DiagnosticSuiteValidationError(
      'DIAGNOSTIC_SUITE_UNKNOWN',
      `Unknown Diagnostic suite "${suiteId}".`,
    );
  }
  const skillRoot = options.rootDir ?? resolveSkillRoot();
  const declarationRelativePath = SUITE_DECLARATION_FILES[suiteId];
  const declarationPath = path.join(skillRoot, declarationRelativePath);
  let text: string;
  try {
    text = readFileSync(declarationPath, 'utf8');
  } catch {
    invalid(`Suite declaration is unavailable: ${declarationRelativePath}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    invalid(`Suite declaration is not valid JSON: ${declarationRelativePath}`);
  }
  const suite = parseDiagnosticSuite(raw, suiteId);
  return {
    suite,
    fingerprint: deriveDiagnosticSuiteFingerprint(suite),
    declarationPath,
    declarationRelativePath,
    skillRoot,
  };
}

/**
 * Reads every declared request exactly once, in canonical order. A missing,
 * unreadable, or malformed request is a blocking suite-contract failure, so the
 * whole suite (not just the first child) is validated before launch.
 */
export function resolveSuiteRequests(loaded: LoadedDiagnosticSuite): ResolvedSuiteRequest[] {
  return loaded.suite.cases.map((declaration) => {
    const relativePath = declaration.request;
    const absolutePath = path.join(loaded.skillRoot, relativePath);
    let text: string;
    try {
      text = readFileSync(absolutePath, 'utf8');
    } catch {
      invalid(`Suite member order ${declaration.order} request is unavailable: ${relativePath}`);
    }
    let request: unknown;
    try {
      request = JSON.parse(text) as unknown;
    } catch {
      invalid(`Suite member order ${declaration.order} request is not valid JSON: ${relativePath}`);
    }
    return { declaration, relativePath, absolutePath, request };
  });
}

/**
 * AST branch audit over the production generic engine surface
 * (specification 16 Gate A, specification 6.4).
 *
 * The generic engine must contain no Subject-name, Subject-kind, family, or
 * application-kind branch. This is deliberately not a superficial string
 * search: it parses each engine module with the TypeScript compiler API and
 * only flags Subject tokens when they appear in an actual branching position:
 *
 *   1. a comparison (`===`, `!==`, `==`, `!=`) against a string literal;
 *   2. a `switch`/`case` label;
 *   3. a dynamic element access (`defaults['layer']`);
 *   4. a membership/prefix call (`includes`, `startsWith`, `endsWith`,
 *      `indexOf`, `match`, `test`) with a string literal argument.
 *
 * Subject tokens are derived at run time from the verification catalogues, so a
 * newly added Subject or application kind is covered without editing this
 * audit. Catalogue data is JSON, never engine code, so declarative data cannot
 * false-positive.
 *
 * Run directly: `node scripts/verify-engine-branching.mjs`
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

/**
 * Toolkit root, resolved independently of the environment. Under Node ESM the
 * module URL is a file URL; under a browser-like test environment it is not, so
 * the repository-relative toolkit path is used instead.
 */
function resolveSkillRoot() {
  const moduleUrl = import.meta.url;
  if (typeof moduleUrl === 'string' && moduleUrl.startsWith('file:')) {
    return path.resolve(path.dirname(fileURLToPath(moduleUrl)), '..');
  }
  return path.resolve(process.cwd());
}

const skillRoot = resolveSkillRoot();

/** Generic engine modules the audit covers, relative to the toolkit root. */
export const GENERIC_ENGINE_FILES = [
  'src/contracts/discriminants.ts',
  'src/contracts/diagnostics.ts',
  'src/contracts/schema-versions.ts',
  'src/contracts/coverage.ts',
  'src/contracts/correctness.ts',
  'src/contracts/adapter.ts',
  'src/contracts/observation.ts',
  'src/contracts/fixtures.ts',
  'src/contracts/workflows.ts',
  'src/contracts/restore-observation.ts',
  'src/canonical/canonicalize.ts',
  'src/canonical/identity.ts',
  'src/catalogue/fingerprint.ts',
  'src/catalogue/correctness.ts',
  'src/catalogue/correctness-compatibility.ts',
  'src/catalogue/load.ts',
  'src/catalogue/resolve.ts',
  'src/catalogue/fixtures.ts',
  'src/workflows/steps.ts',
  'src/workflows/execute.ts',
  'src/adapters/registry.ts',
  'src/adapters/generated-specialized.ts',
  'src/readiness/correlated-gate.ts',
  'src/readiness/coherent-capture.ts',
  'src/readiness/profile-registry.ts',
  'src/oracles/evaluate.ts',
  'src/oracles/geometry.ts',
  'src/oracles/warped-text.ts',
  'src/oracles/image.ts',
  'src/oracles/nested-object.ts',
  'src/oracles/profile-registry.ts',
  'src/oracles/crossword.ts',
  'src/oracles/restore.ts',
  'src/planner/execution-support.ts',
  'src/contracts/geometry-v2.ts',
  'src/contracts/geometry-v3.ts',
  'src/contracts/raster.ts',
  'src/contracts/resources.ts',
  'src/catalogue/resources.ts',
  'src/resources/resolve.ts',
  'src/resources/routes.ts',
  'src/resources/request-log.ts',
  'src/adapters/image-specialized.ts',
  'src/adapters/object-specialized.ts',
  'src/evidence/writer.ts',
  'src/evidence/public-dto.ts',
  'src/browser/primitives.ts',
  'src/browser/public-controls.ts',
  'src/coverage/account.ts',
  'src/coverage/load.ts',
  'src/coverage/resolve.ts',
  'src/coverage/select.ts',
  'src/coverage/validate.ts',
  'src/registry/reconcile.ts',
  'src/registry/validate.ts',
  'src/routing/resolve.ts',
  'src/planner/normalize-intent.ts',
  'src/planner/materialize.ts',
  'src/planner/compile-plan.ts',
  'src/planner/preflight.ts',
  'src/planner/plan-case.ts',
  'src/planner/launchability.ts',
  'src/runtime/outcomes.ts',
  'src/runtime/action-cycle.ts',
  'src/runtime/execute-plan.ts',
  'src/runtime/execute-restore-plan.ts',
  'src/runtime/execute-image-plan.ts',
  'src/allocation/reserve.ts',
  'src/allocation/ownership.ts',
];

const COMPARISON_OPERATORS = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

const MEMBERSHIP_METHODS = new Set([
  'includes',
  'startsWith',
  'endsWith',
  'indexOf',
  'match',
  'test',
]);

const SUBJECT_EXPRESSION_NAME =
  /subject|subjectid|kind|family|applicationkind|origin|relationship|binding|declaration|catalogue|defaults/i;

const FAMILY_NAMESPACE_PATTERN = /^(layer|container|selection|artwork)\//;

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(skillRoot, relativePath), 'utf8'));
}

/** Subject ids, family names, application kinds, and Subject-id leaf segments. */
export function subjectTokens() {
  const applicationInventory = readJson('catalogues/subjects/application-inventory.v1.json');
  const subjectCatalogue = readJson('catalogues/subjects/verification-subjects.v1.json');

  const tokens = new Set();
  for (const kind of applicationInventory.kinds) tokens.add(kind);
  for (const family of Object.keys(subjectCatalogue.familyDefaults)) tokens.add(family);
  for (const declaration of subjectCatalogue.declarations) {
    tokens.add(declaration.subjectId);
    const segments = declaration.subjectId.split('/');
    tokens.add(segments[segments.length - 1]);
  }
  return tokens;
}

function isSubjectLiteral(text, tokens) {
  if (tokens.has(text)) return true;
  return FAMILY_NAMESPACE_PATTERN.test(text);
}

function expressionName(node) {
  if (!node) return '';
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) return expressionName(node.expression);
  if (ts.isCallExpression(node)) return expressionName(node.expression);
  return '';
}

/**
 * A literal is only a Subject branch when the expression it is compared or
 * selected against is derived from Subject data. This prevents false positives
 * such as `typeof value === 'object'`, where `object` is a JavaScript type and
 * not an application kind.
 */
function isSubjectish(expression) {
  if (!expression) return false;
  if (ts.isTypeOfExpression(expression)) return false;
  const name = expressionName(expression);
  return name.length > 0 && SUBJECT_EXPRESSION_NAME.test(name);
}

function locationOf(sourceFile, node) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: line + 1, column: character + 1 };
}

function snippetOf(sourceFile, node) {
  return node.getText(sourceFile).replace(/\s+/g, ' ').slice(0, 160);
}

export function scanSource(sourceText, fileName, tokens) {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const violations = [];

  const visit = (node) => {
    const report = (kind) => {
      const { line, column } = locationOf(sourceFile, node);
      violations.push({
        file: fileName,
        line,
        column,
        kind,
        snippet: snippetOf(sourceFile, node),
      });
    };

    if (ts.isBinaryExpression(node) && COMPARISON_OPERATORS.has(node.operatorToken.kind)) {
      for (const [literal, other] of [
        [node.left, node.right],
        [node.right, node.left],
      ]) {
        if (
          ts.isStringLiteral(literal) &&
          isSubjectLiteral(literal.text, tokens) &&
          isSubjectish(other)
        ) {
          report('comparison');
        }
      }
    }

    if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression)) {
      const switchStatement = node.parent?.parent;
      const switchExpression = ts.isSwitchStatement(switchStatement)
        ? switchStatement.expression
        : undefined;
      if (isSubjectLiteral(node.expression.text, tokens) && isSubjectish(switchExpression)) {
        report('switch-case');
      }
    }

    if (ts.isElementAccessExpression(node) && node.argumentExpression) {
      const argument = node.argumentExpression;
      if (
        ts.isStringLiteral(argument) &&
        isSubjectLiteral(argument.text, tokens) &&
        isSubjectish(node.expression)
      ) {
        report('element-access');
      }
    }

    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) && MEMBERSHIP_METHODS.has(callee.name.text)) {
        for (const argument of node.arguments) {
          if (
            ts.isStringLiteral(argument) &&
            isSubjectLiteral(argument.text, tokens) &&
            isSubjectish(callee.expression)
          ) {
            report(`membership:${callee.name.text}`);
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

export function runBranchCheck() {
  const tokens = subjectTokens();
  const violations = [];

  for (const relativeFile of GENERIC_ENGINE_FILES) {
    const sourceText = readFileSync(path.join(skillRoot, relativeFile), 'utf8');
    violations.push(...scanSource(sourceText, relativeFile, tokens));
  }

  return {
    passed: violations.length === 0,
    engineFiles: GENERIC_ENGINE_FILES,
    tokenCount: tokens.size,
    violations,
  };
}

function moduleFilePath() {
  const moduleUrl = import.meta.url;
  return typeof moduleUrl === 'string' && moduleUrl.startsWith('file:')
    ? path.resolve(fileURLToPath(moduleUrl))
    : null;
}

if (process.argv[1] && moduleFilePath() === path.resolve(process.argv[1])) {
  const result = runBranchCheck();
  if (result.passed) {
    console.log(
      `[verify-engine-branching] OK — ${result.engineFiles.length} generic engine files, 0 Subject-name/kind branches.`,
    );
  } else {
    console.error('[verify-engine-branching] FAILED — Subject-specific branching found:');
    for (const violation of result.violations) {
      console.error(
        `  ${violation.file}:${violation.line}:${violation.column} [${violation.kind}] ${violation.snippet}`,
      );
    }
    process.exitCode = 1;
  }
}

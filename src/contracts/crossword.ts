/**
 * Deterministic generated Crossword contract (ADR 0017 R4–R8).
 *
 * The toolkit owns the closed interpretation of one generated Crossword layout:
 * the authoritative default word set, the source-currentness contract that binds
 * the materialization to the accepted product revision, the NFC-normalized,
 * order-preserving, seed-excluding semantic payload, its canonical
 * domain-separated digest, the structural rules that make a digest
 * authoritative, and the approved representative-separation predicate.
 *
 * Nothing here is an expected product result: no layout, digest, or seed of a
 * browser execution is stored. Every function is a pure predicate over facts
 * observed elsewhere.
 */

import { canonicalize } from '../canonical/canonicalize';
import { sha256Hex } from '../canonical/canonicalize';

/** Authoritative ordered default Crossword word set (ADR 0017 R4.3). */
export const CROSSWORD_DEFAULT_WORDS: readonly string[] = Object.freeze([
  'MAKEIT',
  'CROSSWORD',
  'HELLO',
]);

/** Versioned semantic payload schema and digest domain (ADR 0017 R6). */
export const CROSSWORD_SEMANTIC_SCHEMA_VERSION = 1;
export const CROSSWORD_SEMANTIC_DIGEST_DOMAIN = 'makeit:crossword-layout-semantic:v1';

/** Product source that owns the initial seed and the generator boundary (R4). */
export const CROSSWORD_STORE_SOURCE_PATH = 'src/stores/artwork/crosswordLayerSlice.ts';
export const CROSSWORD_GENERATOR_SOURCE_PATH = 'src/lib/artwork/crosswordEngine/layout.ts';

export type CrosswordDirection = 'across' | 'down';
export const CROSSWORD_DIRECTIONS: readonly CrosswordDirection[] = ['across', 'down'];

export interface CrosswordCellV1 {
  row: number;
  col: number;
  letter: string;
}

export interface CrosswordPlacedWordV1 {
  word: string;
  row: number;
  col: number;
  direction: CrosswordDirection;
  intersections: number;
}

/** The generated-layout facts plus the stored word order. */
export interface CrosswordLayoutFactsV1 {
  words: readonly string[];
  cells: readonly CrosswordCellV1[];
  placedWords: readonly CrosswordPlacedWordV1[];
  omittedWords: readonly string[];
  width: number;
  height: number;
  minRow: number;
  minCol: number;
  maxRow: number;
  maxCol: number;
  intersections: number;
}

/** The complete semantic payload a digest is taken over (ADR 0017 R6). */
export interface CrosswordLayoutSemanticV1 {
  schemaVersion: 1;
  words: readonly string[];
  layout: {
    cells: readonly CrosswordCellV1[];
    placedWords: readonly CrosswordPlacedWordV1[];
    omittedWords: readonly string[];
    width: number;
    height: number;
    minRow: number;
    minCol: number;
    maxRow: number;
    maxCol: number;
    intersections: number;
  };
}

export interface CrosswordStructuralFinding {
  code: string;
  detail: string;
}

export interface CrosswordStructuralResult {
  ok: boolean;
  findings: readonly CrosswordStructuralFinding[];
  /** Closed semantic payload when every structural rule holds. */
  payload: CrosswordLayoutSemanticV1 | null;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isDirection(value: unknown): value is CrosswordDirection {
  return value === 'across' || value === 'down';
}

/** Encoding-order comparison used by the canonical cell sort (ADR 0017 R6). */
function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const l = leftPoints[index] as number;
    const r = rightPoints[index] as number;
    if (l !== r) return l < r ? -1 : 1;
  }
  return leftPoints.length - rightPoints.length;
}

function sortedCells(cells: readonly CrosswordCellV1[]): CrosswordCellV1[] {
  return [...cells].sort(
    (left, right) =>
      left.row - right.row || left.col - right.col || compareCodePoints(left.letter, right.letter),
  );
}

/**
 * Structural interpretation before hashing (ADR 0017 R7). A malformed layout is
 * unusable and must never be normalized into passing evidence.
 */
export function validateCrosswordLayoutStructure(
  facts: CrosswordLayoutFactsV1,
  expectedWords: readonly string[] = CROSSWORD_DEFAULT_WORDS,
): CrosswordStructuralResult {
  const findings: CrosswordStructuralFinding[] = [];
  const reject = (code: string, detail: string) => findings.push({ code, detail });

  const { words, cells, placedWords, omittedWords, width, height, minRow, minCol, maxRow, maxCol } =
    facts;

  if (!Array.isArray(words) || words.length === 0 || !words.every(isNonEmptyString)) {
    reject('CROSSWORD_WORDS_INVALID', 'The declared word list is empty or not all strings.');
  } else {
    const normalized = words.map((word) => word.normalize('NFC'));
    if (
      normalized.length !== expectedWords.length ||
      normalized.some((word, index) => word !== expectedWords[index]?.normalize('NFC'))
    ) {
      reject(
        'CROSSWORD_WORDS_INVALID',
        `Declared words ${JSON.stringify(normalized)} are not the exact ordered default set ${JSON.stringify(expectedWords)}.`,
      );
    }
  }

  for (const [label, value] of [
    ['width', width],
    ['height', height],
    ['minRow', minRow],
    ['minCol', minCol],
    ['maxRow', maxRow],
    ['maxCol', maxCol],
    ['intersections', facts.intersections],
  ] as const) {
    if (!isSafeInteger(value)) reject('CROSSWORD_FIELD_INVALID', `${label} is not a safe integer.`);
  }
  if (Number.isSafeInteger(width) && width <= 0) {
    reject('CROSSWORD_DIMENSION_INVALID', 'width must be a positive integer.');
  }
  if (Number.isSafeInteger(height) && height <= 0) {
    reject('CROSSWORD_DIMENSION_INVALID', 'height must be a positive integer.');
  }
  if (
    isSafeInteger(width) &&
    isSafeInteger(maxCol) &&
    isSafeInteger(minCol) &&
    width !== maxCol - minCol + 1
  ) {
    reject('CROSSWORD_BOUNDS_INCONSISTENT', 'width !== maxCol - minCol + 1.');
  }
  if (
    isSafeInteger(height) &&
    isSafeInteger(maxRow) &&
    isSafeInteger(minRow) &&
    height !== maxRow - minRow + 1
  ) {
    reject('CROSSWORD_BOUNDS_INCONSISTENT', 'height !== maxRow - minRow + 1.');
  }

  const cellsByKey = new Map<string, string>();
  if (!Array.isArray(cells) || cells.length === 0) {
    reject('CROSSWORD_CELLS_INVALID', 'The layout declares no cells.');
  } else {
    for (const cell of cells) {
      if (
        cell === null ||
        typeof cell !== 'object' ||
        !isSafeInteger(cell.row) ||
        !isSafeInteger(cell.col) ||
        !isNonEmptyString(cell.letter)
      ) {
        reject('CROSSWORD_CELL_INVALID', 'A cell has a malformed coordinate or letter.');
        continue;
      }
      if (cell.row < 0 || cell.row >= height || cell.col < 0 || cell.col >= width) {
        reject(
          'CROSSWORD_CELL_OUT_OF_BOUNDS',
          `Cell (${cell.row}, ${cell.col}) is outside ${width}x${height}.`,
        );
        continue;
      }
      const key = `${cell.row},${cell.col}`;
      if (cellsByKey.has(key)) {
        reject('CROSSWORD_CELL_DUPLICATE', `Duplicate cell coordinate ${key}.`);
        continue;
      }
      cellsByKey.set(key, cell.letter.normalize('NFC'));
    }
  }

  if (!Array.isArray(placedWords)) {
    reject('CROSSWORD_PLACED_INVALID', 'placedWords is not an array.');
  }
  if (!Array.isArray(omittedWords) || !omittedWords.every(isNonEmptyString)) {
    reject('CROSSWORD_OMITTED_INVALID', 'omittedWords is not an array of strings.');
  }

  const declaredCounts = new Map<string, number>();
  for (const word of (Array.isArray(words) ? words : []).filter(isNonEmptyString)) {
    const normalized = word.normalize('NFC');
    declaredCounts.set(normalized, (declaredCounts.get(normalized) ?? 0) + 1);
  }
  const seenCounts = new Map<string, number>();

  const placedCells: CrosswordPlacedWordV1[] = [];
  if (Array.isArray(placedWords)) {
    for (const placed of placedWords) {
      if (
        placed === null ||
        typeof placed !== 'object' ||
        !isNonEmptyString(placed.word) ||
        !isSafeInteger(placed.row) ||
        !isSafeInteger(placed.col) ||
        !isDirection(placed.direction) ||
        !isSafeInteger(placed.intersections)
      ) {
        reject('CROSSWORD_PLACED_INVALID', 'A placed word has a malformed field.');
        continue;
      }
      const word = placed.word.normalize('NFC');
      const letters = Array.from(word);
      const mapped: string[] = [];
      for (let index = 0; index < letters.length; index += 1) {
        const row = placed.direction === 'across' ? placed.row : placed.row + index;
        const col = placed.direction === 'across' ? placed.col + index : placed.col;
        const key = `${row},${col}`;
        if (!cellsByKey.has(key)) {
          reject(
            'CROSSWORD_PLACED_CELL_MISSING',
            `Placed word "${word}" declares no cell at ${key}.`,
          );
          break;
        }
        const cellLetter = cellsByKey.get(key) as string;
        if (cellLetter !== letters[index]) {
          reject(
            'CROSSWORD_PLACED_LETTER_MISMATCH',
            `Placed word "${word}" disagrees with cell ${key} ("${cellLetter}" vs "${letters[index]}").`,
          );
          break;
        }
        mapped.push(cellLetter);
      }
      if (mapped.join('') !== letters.join('')) continue;
      if (declaredCounts.get(word) === undefined) {
        reject(
          'CROSSWORD_UNDECLARED_WORD',
          `Placed word "${word}" is not in the declared multiset.`,
        );
        continue;
      }
      seenCounts.set(word, (seenCounts.get(word) ?? 0) + 1);
      placedCells.push({ ...placed, word });
    }
  }

  if (Array.isArray(omittedWords)) {
    for (const word of omittedWords) {
      const normalized = word.normalize('NFC');
      if (declaredCounts.get(normalized) === undefined) {
        reject(
          'CROSSWORD_UNDECLARED_WORD',
          `Omitted word "${normalized}" is not in the declared multiset.`,
        );
        continue;
      }
      seenCounts.set(normalized, (seenCounts.get(normalized) ?? 0) + 1);
    }
  }

  for (const [word, declared] of declaredCounts) {
    const seen = seenCounts.get(word) ?? 0;
    if (seen !== declared) {
      reject(
        'CROSSWORD_WORD_COUNT_MISMATCH',
        `Word "${word}" occurs ${seen} time(s) across placed+omitted but is declared ${declared} time(s).`,
      );
    }
  }

  // Union of placed cells must equal the declared cell set (no stray cells).
  const placedKeys = new Set<string>();
  for (const placed of placedCells) {
    const letters = Array.from(placed.word);
    for (let index = 0; index < letters.length; index += 1) {
      const row = placed.direction === 'across' ? placed.row : placed.row + index;
      const col = placed.direction === 'across' ? placed.col + index : placed.col;
      placedKeys.add(`${row},${col}`);
    }
  }
  if (cellsByKey.size > 0 && placedKeys.size !== cellsByKey.size) {
    reject(
      'CROSSWORD_CELL_UNION_MISMATCH',
      'The union of placed-word cells does not equal the declared cell set.',
    );
  }

  // Intersections: aggregate equals the sum, every value is a non-negative
  // integer, and each per-word value equals the number of previously placed
  // distinct words it shares at least one cell with (the product's placement
  // order convention).
  let intersectionSum = 0;
  const priorCells = new Map<string, number>();
  for (let index = 0; index < placedCells.length; index += 1) {
    const placed = placedCells[index] as CrosswordPlacedWordV1;
    if (placed.intersections < 0) {
      reject(
        'CROSSWORD_INTERSECTIONS_INCONSISTENT',
        `Placed word "${placed.word}" has a negative intersection count.`,
      );
    }
    intersectionSum += placed.intersections;
    const letters = Array.from(placed.word);
    const wordKeys = new Set<string>();
    for (let offset = 0; offset < letters.length; offset += 1) {
      const row = placed.direction === 'across' ? placed.row : placed.row + offset;
      const col = placed.direction === 'across' ? placed.col + offset : placed.col;
      wordKeys.add(`${row},${col}`);
    }
    const sharedPrior = new Set<number>();
    for (const key of wordKeys) {
      const owner = priorCells.get(key);
      if (owner !== undefined) sharedPrior.add(owner);
    }
    if (sharedPrior.size !== placed.intersections) {
      reject(
        'CROSSWORD_INTERSECTIONS_INCONSISTENT',
        `Placed word "${placed.word}" reports ${placed.intersections} intersection(s) but shares cells with ${sharedPrior.size} earlier word(s).`,
      );
    }
    for (const key of wordKeys) {
      if (!priorCells.has(key)) priorCells.set(key, index);
    }
  }
  if (intersectionSum !== facts.intersections) {
    reject(
      'CROSSWORD_INTERSECTIONS_INCONSISTENT',
      `Aggregate intersections ${facts.intersections} does not equal the per-word sum ${intersectionSum}.`,
    );
  }

  if (findings.length > 0) {
    return { ok: false, findings, payload: null };
  }

  return {
    ok: true,
    findings: [],
    payload: buildCanonicalPayload(facts),
  };
}

function buildCanonicalPayload(facts: CrosswordLayoutFactsV1): CrosswordLayoutSemanticV1 {
  return {
    schemaVersion: CROSSWORD_SEMANTIC_SCHEMA_VERSION,
    words: facts.words.map((word) => word.normalize('NFC')),
    layout: {
      cells: sortedCells(
        facts.cells.map((cell) => ({ ...cell, letter: cell.letter.normalize('NFC') })),
      ),
      placedWords: facts.placedWords.map((placed) => ({
        ...placed,
        word: placed.word.normalize('NFC'),
      })),
      omittedWords: facts.omittedWords.map((word) => word.normalize('NFC')),
      width: facts.width,
      height: facts.height,
      minRow: facts.minRow,
      minCol: facts.minCol,
      maxRow: facts.maxRow,
      maxCol: facts.maxCol,
      intersections: facts.intersections,
    },
  };
}

/**
 * Domain-separated canonical digest of one structurally valid semantic payload
 * (ADR 0017 R6). The seed, runtime ids, timestamps, selection, z-order, frames,
 * transforms, styles, and version/evidence metadata are excluded by
 * construction: they are not part of the payload.
 */
export function crosswordSemanticDigest(payload: CrosswordLayoutSemanticV1): string {
  return sha256Hex(`${CROSSWORD_SEMANTIC_DIGEST_DOMAIN}\0${canonicalize(payload)}`);
}

/** Semantic payload from a created Crossword layer-like fact (seed/ids ignored). */
export function crosswordSemanticPayloadFromLayerShape(
  fact: {
    words?: unknown;
    layout?: unknown;
  },
  expectedWords: readonly string[] = CROSSWORD_DEFAULT_WORDS,
): CrosswordStructuralResult {
  const layout = fact.layout;
  if (layout === null || typeof layout !== 'object') {
    return {
      ok: false,
      findings: [{ code: 'CROSSWORD_LAYOUT_MISSING', detail: 'No generated layout is present.' }],
      payload: null,
    };
  }
  const record = layout as Record<string, unknown>;
  const facts: CrosswordLayoutFactsV1 = {
    words: (Array.isArray(fact.words) ? fact.words : []) as readonly string[],
    cells: (Array.isArray(record.cells) ? record.cells : []) as readonly CrosswordCellV1[],
    placedWords: (Array.isArray(record.placedWords)
      ? record.placedWords
      : []) as readonly CrosswordPlacedWordV1[],
    omittedWords: (Array.isArray(record.omittedWords)
      ? record.omittedWords
      : []) as readonly string[],
    width: record.width as number,
    height: record.height as number,
    minRow: record.minRow as number,
    minCol: record.minCol as number,
    maxRow: record.maxRow as number,
    maxCol: record.maxCol as number,
    intersections: record.intersections as number,
  };
  return validateCrosswordLayoutStructure(facts, expectedWords);
}

export interface CrosswordRepresentativeComparison {
  wordsEqual: boolean;
  seedDifferent: boolean;
  semanticDigestDifferent: boolean;
  /** The R8 sensitivity predicate: same words, different seed, different digest. */
  sensitive: boolean;
}

/** The approved A/B representative predicate (ADR 0017 R8). No seed search. */
export function compareCrosswordRepresentative(input: {
  wordsA: readonly string[];
  wordsB: readonly string[];
  seedA: number;
  seedB: number;
  semanticDigestA: string;
  semanticDigestB: string;
}): CrosswordRepresentativeComparison {
  const wordsEqual =
    input.wordsA.length === input.wordsB.length &&
    input.wordsA.every((word, index) => word === input.wordsB[index]);
  const seedDifferent = input.seedA !== input.seedB;
  const semanticDigestDifferent = input.semanticDigestA !== input.semanticDigestB;
  return {
    wordsEqual,
    seedDifferent,
    semanticDigestDifferent,
    sensitive: wordsEqual && seedDifferent && semanticDigestDifferent,
  };
}

export type CrosswordChildComparisonRole = 'A1' | 'A2' | 'B';

/** One generated child's observed comparison facts (seed + semantic digest). */
export interface CrosswordChildComparisonFact {
  words: readonly string[];
  seed: number;
  semanticDigest: string;
}

/**
 * The approved three-child comparison (ADR 0017 R8; ADR 0018 CR9). A1 and A2
 * are created under the same clock seed and must be byte-identical in semantic
 * digest; B is created under a different clock seed and the product must
 * produce a different semantic digest. The predicate is pure and
 * equality-only — it never searches seeds and never parses a digest.
 */
export interface CrosswordThreeChildComparison {
  wordsEqualAcrossChildren: boolean;
  sameSeedPair: boolean;
  differentSeedPair: boolean;
  repeatIdentical: boolean;
  seedSensitivity: boolean;
  seeds: Readonly<Record<CrosswordChildComparisonRole, number>>;
  semanticDigests: Readonly<Record<CrosswordChildComparisonRole, string>>;
}

function sameWordOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((word, index) => word === right[index]);
}

export function compareCrosswordExecutions(input: {
  a1: CrosswordChildComparisonFact;
  a2: CrosswordChildComparisonFact;
  b: CrosswordChildComparisonFact;
}): CrosswordThreeChildComparison {
  const { a1, a2, b } = input;
  const wordsEqualAcrossChildren =
    sameWordOrder(a1.words, a2.words) && sameWordOrder(a1.words, b.words);
  const sameSeedPair = a1.seed === a2.seed;
  const differentSeedPair = a1.seed !== b.seed;
  const repeatIdentical = a1.semanticDigest === a2.semanticDigest;
  const seedSensitivity = a1.semanticDigest !== b.semanticDigest;
  return {
    wordsEqualAcrossChildren,
    sameSeedPair,
    differentSeedPair,
    repeatIdentical,
    seedSensitivity,
    seeds: { A1: a1.seed, A2: a2.seed, B: b.seed },
    semanticDigests: {
      A1: a1.semanticDigest,
      A2: a2.semanticDigest,
      B: b.semanticDigest,
    },
  };
}

/**
 * Canonical fingerprint of one ordered Crossword word list (ADR 0017 R10
 * `wordsFingerprint`). NFC-normalizes every word, preserves order, and is
 * domain-separated from the semantic-layout digest.
 */
export function crosswordWordsFingerprint(words: readonly string[]): string {
  return sha256Hex(
    canonicalize({
      domain: 'makeit:crossword-words:v1',
      words: words.map((w) => w.normalize('NFC')),
    }),
  );
}

/** The R4 source-currentness contract, evaluated over observed source text. */
export interface CrosswordSourceContractFacts {
  storeSource: string;
  generatorSource: string;
}

export interface CrosswordSourceContractResult {
  ok: boolean;
  findings: readonly CrosswordStructuralFinding[];
  /** Content fingerprint the materialization binds and re-checks. */
  fingerprint: string;
}

const SEED_READ_PATTERN = /const\s+seed\s*=\s*Date\.now\(\)\s*;/g;
const DEFAULT_WORDS_PATTERN =
  /DEFAULT_CROSSWORD_WORDS\s*=\s*\[\s*'MAKEIT'\s*,\s*'CROSSWORD'\s*,\s*'HELLO'\s*\]/;
const EXPLICIT_SEED_PATTERN = /generateCrosswordLayout\(\s*words\s*,\s*seed\s*\)/;

/**
 * Validate the accepted product source contract (ADR 0017 R4). A changed source
 * is `HARNESS_BLOCKED` pending review; it is never silently re-interpreted under
 * the old expected-seed rule.
 */
export function validateCrosswordSourceContract(
  facts: CrosswordSourceContractFacts,
): CrosswordSourceContractResult {
  const findings: CrosswordStructuralFinding[] = [];
  const seedReads = facts.storeSource.match(SEED_READ_PATTERN) ?? [];
  if (seedReads.length !== 1) {
    findings.push({
      code: 'CROSSWORD_SOURCE_CONTRACT_CHANGED',
      detail: `createDefaultArtworkCrosswordLayer must read Date.now() exactly once as the initial seed; observed ${seedReads.length}.`,
    });
  }
  if (!DEFAULT_WORDS_PATTERN.test(facts.storeSource)) {
    findings.push({
      code: 'CROSSWORD_SOURCE_CONTRACT_CHANGED',
      detail: 'The exact ordered default word set MAKEIT/CROSSWORD/HELLO is no longer declared.',
    });
  }
  if (!EXPLICIT_SEED_PATTERN.test(facts.storeSource)) {
    findings.push({
      code: 'CROSSWORD_SOURCE_CONTRACT_CHANGED',
      detail:
        'The initial seed is no longer passed explicitly to generateCrosswordLayout(words, seed).',
    });
  }
  for (const forbidden of ['Math.random', 'new Worker', 'fetch(', 'await ', 'Promise<']) {
    if (facts.generatorSource.includes(forbidden)) {
      findings.push({
        code: 'CROSSWORD_SOURCE_CONTRACT_CHANGED',
        detail: `Crossword layout generation now depends on "${forbidden}".`,
      });
    }
  }
  return {
    ok: findings.length === 0,
    findings,
    fingerprint: sha256Hex(
      canonicalize({
        contract: 'crossword-source-v1',
        store: facts.storeSource,
        generator: facts.generatorSource,
      }),
    ),
  };
}

import { ORACLE_PROFILE_SCHEMA_VERSION } from '../contracts/schema-versions';
import {
  NESTED_OBJECT_ORACLE_PROFILE_ID,
  NESTED_OBJECT_ORACLE_PROFILE_VERSION,
} from './nested-object';
import { WARPED_TEXT_ORACLE_PROFILE_ID } from './warped-text';
import { CROSSWORD_ORACLE_PROFILE_ID, CROSSWORD_ORACLE_PROFILE_VERSION } from './crossword';
import { HISTORY_ORACLE_PROFILE_ID, HISTORY_ORACLE_PROFILE_VERSION } from './history';
import { RESTORE_ORACLE_PROFILE_ID } from '../contracts/restore-observation';
import { RESTORE_ORACLE_PROFILE_VERSION } from './restore';

/**
 * Data-routed Oracle profile registry (WP5 Slice 5-D, ADR 0013 R11/design §10).
 *
 * The generic engine resolves one Oracle profile id contributed by the selected
 * adapter to a closed evaluator kind. The evaluator implementations live in the
 * profile modules; this registry only routes, so the engine never branches on
 * Subject identity, application kind, scenario, or variant.
 */

export type OracleProfileKind =
  | 'geometry-delta'
  | 'warped-text-envelope'
  | 'nested-object-affine'
  | 'crossword-determinism'
  | 'history-cross-subject'
  | 'frontend-restore'
  | 'image-upload-replace';

export interface OracleProfileRegistration {
  profileId: string;
  version: number;
  schemaVersion: number;
  kind: OracleProfileKind;
}

export const ORACLE_PROFILE_REGISTRY: Readonly<Record<string, OracleProfileRegistration>> =
  Object.freeze({
    'geometry-delta-v1': Object.freeze({
      profileId: 'geometry-delta-v1',
      version: 1,
      schemaVersion: ORACLE_PROFILE_SCHEMA_VERSION,
      kind: 'geometry-delta',
    }),
    [WARPED_TEXT_ORACLE_PROFILE_ID]: Object.freeze({
      profileId: WARPED_TEXT_ORACLE_PROFILE_ID,
      version: 1,
      schemaVersion: ORACLE_PROFILE_SCHEMA_VERSION,
      kind: 'warped-text-envelope',
    }),
    'image-upload-replace-v1': Object.freeze({
      profileId: 'image-upload-replace-v1',
      version: 1,
      schemaVersion: ORACLE_PROFILE_SCHEMA_VERSION,
      kind: 'image-upload-replace',
    }),
    [NESTED_OBJECT_ORACLE_PROFILE_ID]: Object.freeze({
      profileId: NESTED_OBJECT_ORACLE_PROFILE_ID,
      version: NESTED_OBJECT_ORACLE_PROFILE_VERSION,
      schemaVersion: ORACLE_PROFILE_SCHEMA_VERSION,
      kind: 'nested-object-affine',
    }),
    [CROSSWORD_ORACLE_PROFILE_ID]: Object.freeze({
      profileId: CROSSWORD_ORACLE_PROFILE_ID,
      version: CROSSWORD_ORACLE_PROFILE_VERSION,
      schemaVersion: ORACLE_PROFILE_SCHEMA_VERSION,
      kind: 'crossword-determinism',
    }),
    [HISTORY_ORACLE_PROFILE_ID]: Object.freeze({
      profileId: HISTORY_ORACLE_PROFILE_ID,
      version: HISTORY_ORACLE_PROFILE_VERSION,
      schemaVersion: ORACLE_PROFILE_SCHEMA_VERSION,
      kind: 'history-cross-subject',
    }),
    [RESTORE_ORACLE_PROFILE_ID]: Object.freeze({
      profileId: RESTORE_ORACLE_PROFILE_ID,
      version: RESTORE_ORACLE_PROFILE_VERSION,
      schemaVersion: ORACLE_PROFILE_SCHEMA_VERSION,
      kind: 'frontend-restore',
    }),
  });

/** Resolves one Oracle profile registration, or `null` for an unknown id. */
export function resolveOracleProfile(profileId: string): OracleProfileRegistration | null {
  return ORACLE_PROFILE_REGISTRY[profileId] ?? null;
}

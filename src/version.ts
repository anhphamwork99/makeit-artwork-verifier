/**
 * Single toolkit identity shared by the CLI envelope, the bundled agent-neutral
 * skill and the package manifest (WP2 criterion C2: one implementation).
 *
 * The value is kept in lockstep with `package.json#version` and the `version`
 * key in `agents/verify-artwork-editor/SKILL.md`. A portable contract test
 * asserts the parity, so a divergent version fails the no-FE suite.
 */
export const TOOLKIT_NAME = 'makeit-artwork-verifier';
export const TOOLKIT_VERSION = '0.1.0';

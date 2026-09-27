/**
 * Default Vitest configuration (WP2 standalone toolkit).
 *
 * The historical file configured the FE-repository-root suite. In this
 * standalone toolkit the default suite is the no-FE portable contract suite;
 * the FE-hosted suite is opt-in through `vitest.fe-hosted.config.ts` with an
 * explicit application root.
 */
export { default } from './vitest.portable.config';

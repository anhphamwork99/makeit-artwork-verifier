/**
 * Synthetic app root whose provider entry throws while loading (portable test
 * fixture). The loader must report `PROVIDER_LOAD_FAILED` before any
 * allocation rather than propagating the raw error.
 */
throw new Error('synthetic provider load failure');

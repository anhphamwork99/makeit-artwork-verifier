/**
 * Synthetic app root whose provider entry exists but publishes a non-object
 * export (portable test fixture). The loader must refuse `PROVIDER_CONTRACT_INVALID`
 * rather than coercing the value.
 */
export const productMeaningProvider = 'not-a-provider-contract';

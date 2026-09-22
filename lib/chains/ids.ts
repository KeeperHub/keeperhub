/**
 * EVM chain IDs that appear as bare literals in more than one module.
 *
 * lib/safe/protocol-targets.ts, protocol-registry.ts, protocol-default-tokens.ts
 * and condition-templates.ts each carried an identical private alphabet of
 * these four, under two naming conventions, and mainnet alone was additionally
 * re-declared in five other files as ETH, CHAIN_ETH, MAINNET_CHAIN_ID and
 * DEFAULT_REGISTRY_CHAIN_ID while an exported ETHEREUM_MAINNET_CHAIN_ID
 * already existed inside lib/agentic-wallet.
 *
 * Callers that read better with the short forms import these aliased, for
 * example `ETHEREUM_MAINNET_CHAIN_ID as ETH`.
 *
 * This module deliberately has no imports: it is depended on by the payment
 * rails and by client components, so it must stay free to pull into any bundle.
 */

export const ETHEREUM_MAINNET_CHAIN_ID = 1;
export const OPTIMISM_CHAIN_ID = 10;
export const BASE_CHAIN_ID = 8453;
export const ARBITRUM_ONE_CHAIN_ID = 42_161;

// nad.fun Module
// Re-exports for bonding curve trading functionality
// Copyright (c) 2026 s0nderlabs

// Constants
export {
  NADFUN_CONTRACTS,
  LENS_ABI,
  ROUTER_ABI,
  ROUTER_CREATE_ABI,
  NADFUN_BUY_SELECTOR,
  NADFUN_SELL_SELECTOR,
  NADFUN_CREATE_SELECTOR,
  NADFUN_QUOTE_EXPIRY_MS,
  DEFAULT_DEADLINE_SECONDS,
  DEFAULT_SLIPPAGE_BPS,
  MAX_SLIPPAGE_BPS,
  GRADUATION_PROGRESS,
} from "./constants.js";

// Types (RPC/Contract types)
export type {
  TradingVenue,
  NadFunTokenStatus,
  NadFunDirection,
  NadFunQuoteParams,
  NadFunQuote,
  CachedNadFunQuote,
  NadFunExecutionResult,
  NadFunBuyParams,
  NadFunSellParams,
  NadFunBuyDelegationContext,
  NadFunSellDelegationContext,
  NadFunStatusResponse,
  NadFunQuoteResponse,
  NadFunExecuteResponse,
  // Token creation types
  TokenCreationInput,
  CreateQuote,
  CreateResult,
  NadFunCreateDelegationContext,
  NadFunCreateResponse,
} from "./types.js";

// Types (HTTP API types)
export type {
  // Raw API types
  NadFunApiTokenInfo,
  NadFunApiMarketInfo,
  NadFunApiTokenListing,
  NadFunApiListingResponse,
  NadFunApiPosition,
  NadFunApiPositionResponse,
  NadFunApiSwapRecord,
  NadFunApiSwapResponse,
  NadFunApiTokenMetadataResponse,
  NadFunApiTokenMarketResponse,
  // Transformed types
  DiscoveredToken,
  NadFunTokenFullInfo,
  UserPosition,
  // Tool response types
  NadFunDiscoverResponse,
  NadFunTokenInfoResponse,
  NadFunPositionsResponse,
} from "./api-types.js";

// Client (Lens contract reads)
export {
  getTokenStatus,
  getAmountOut,
  getAvailableBuyTokens,
} from "./client.js";

// HTTP API Client (public nad.fun API)
export {
  NADFUN_API_BASE,
  MONAD_EXPLORER_URL,
  fetchNadFunApi,
  postNadFunApi,
  uploadTokenImage,
  uploadTokenMetadata,
  mineTokenSalt,
  formatPriceChange,
  formatPrice,
  formatAmount,
  buildExplorerUrl,
  formatProgress,
  truncateAddress,
} from "./api-client.js";

// Quote caching
export {
  buildNadFunQuote,
  getCachedNadFunQuote,
  getNadFunQuoteExecutionData,
  isNadFunQuoteExpired,
  deleteNadFunQuote,
} from "./quote.js";

// Execution
export {
  executeNadFunBuy,
  executeNadFunSell,
} from "./execution.js";

// Token Creation
export {
  prepareTokenCreation,
  executeTokenCreation,
  getCachedCreateQuote,
  isCreateQuoteExpired,
  deleteCreateQuote,
} from "./create.js";

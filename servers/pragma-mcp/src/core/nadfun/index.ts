// nad.fun Module
// Re-exports for bonding curve trading functionality
// Copyright (c) 2026 s0nderlabs

// Constants
export {
  NADFUN_CONTRACTS,
  LENS_ABI,
  ROUTER_ABI,
  NADFUN_BUY_SELECTOR,
  NADFUN_SELL_SELECTOR,
  NADFUN_QUOTE_EXPIRY_MS,
  DEFAULT_DEADLINE_SECONDS,
  DEFAULT_SLIPPAGE_BPS,
  MAX_SLIPPAGE_BPS,
  GRADUATION_PROGRESS,
} from "./constants.js";

// Types
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
} from "./types.js";

// Client (Lens contract reads)
export {
  getTokenStatus,
  getAmountOut,
  getAvailableBuyTokens,
} from "./client.js";

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

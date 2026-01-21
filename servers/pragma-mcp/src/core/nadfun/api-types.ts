// nad.fun HTTP API Type Definitions
// Types for the public nad.fun HTTP API (https://api.nad.fun/)
// Copyright (c) 2026 s0nderlabs

// ============================================================================
// Raw API Response Types (from nad.fun HTTP API)
// ============================================================================

/**
 * Token info from nad.fun API
 * Note: Creator and socials are structured differently than expected
 */
export interface NadFunApiTokenInfo {
  token_id: string;
  name: string;
  symbol: string;
  description?: string;
  image_uri?: string;
  is_graduated: boolean;
  is_locked?: boolean;
  is_nsfw?: boolean;
  is_cto?: boolean;
  created_at: number | string;
  // Creator can be a string OR an object with account_id/nickname
  creator?:
    | string
    | {
        account_id: string;
        nickname?: string;
        bio?: string;
        image_uri?: string;
      };
  creator_name?: string;
  // Socials are directly on token_info, not nested
  twitter?: string;
  telegram?: string;
  website?: string;
}

/**
 * Market info from nad.fun API
 */
export interface NadFunApiMarketInfo {
  market_type: "DEX" | "CURVE";
  token_id?: string;
  market_id?: string;
  price?: string;
  price_usd?: string;
  price_native?: string;
  token_price?: string;
  native_price?: string;
  total_supply?: string;
  reserve_native?: string;
  reserve_token?: string;
  volume?: string;
  ath_price?: string;
  ath_price_usd?: string;
  ath_price_native?: string;
  holder_count?: number;
  progress?: number; // 0-10000 basis points (for bonding curve tokens)
}

/**
 * Token listing entry (used in /order/* endpoints)
 */
export interface NadFunApiTokenListing {
  token_info: NadFunApiTokenInfo;
  market_info: NadFunApiMarketInfo;
  percent?: string; // Price change percentage
}

/**
 * Response from listing endpoints (/order/market_cap, /order/creation_time, etc.)
 */
export interface NadFunApiListingResponse {
  tokens: NadFunApiTokenListing[];
  total_count: number;
}

/**
 * User position from /account/position/* endpoint
 */
export interface NadFunApiPosition {
  token: {
    address: string;
    symbol: string;
    name?: string;
    image_uri?: string;
  };
  holdings: string;
  avg_buy_price: string;
  current_price: string;
  market_value?: string;
  pnl_usd?: string;
  pnl_percent?: string;
  market_type?: "DEX" | "CURVE";
  first_buy_time?: string;
  last_trade_time?: string;
}

/**
 * Response from /account/position/* endpoint
 */
export interface NadFunApiPositionResponse {
  positions: NadFunApiPosition[];
  total_count?: number;
}

/**
 * Swap/trade record from /token/swap/* endpoint
 */
export interface NadFunApiSwapRecord {
  tx_hash: string;
  timestamp: string;
  type: "buy" | "sell";
  trader: string;
  token_amount: string;
  mon_amount: string;
  price_native?: string;
  price_usd?: string;
}

/**
 * Response from /token/swap/* endpoint
 */
export interface NadFunApiSwapResponse {
  swaps: NadFunApiSwapRecord[];
  total_count: number;
}

/**
 * Response from /token/{token} endpoint (metadata)
 */
export interface NadFunApiTokenMetadataResponse {
  token_info: NadFunApiTokenInfo;
}

/**
 * Response from /token/market/{token} endpoint (market data)
 */
export interface NadFunApiTokenMarketResponse {
  market_info: NadFunApiMarketInfo;
}

/**
 * Balance info from /profile/hold-token endpoint
 */
export interface NadFunApiBalanceInfo {
  balance: string;
  token_price: string;
  native_price: string;
  created_at: number;
}

/**
 * Hold token entry from /profile/hold-token endpoint
 */
export interface NadFunApiHoldToken {
  token_info: NadFunApiTokenInfo;
  balance_info: NadFunApiBalanceInfo;
  market_info: NadFunApiMarketInfo;
}

/**
 * Response from /profile/hold-token/{address} endpoint
 */
export interface NadFunApiHoldTokenResponse {
  tokens: NadFunApiHoldToken[];
  total_count: number;
}

// ============================================================================
// Transformed Types (for MCP tool responses)
// ============================================================================

/**
 * Discovered token (from nadfun_discover)
 */
export interface DiscoveredToken {
  address: string;
  symbol: string;
  name: string;
  imageUri?: string;
  isGraduated: boolean;
  marketType: "DEX" | "CURVE";
  priceUsd: string;
  priceChange: string; // "+5.2%" or "-3.1%"
  holderCount: number;
  volume?: string;
  createdAt: string;
}

/**
 * Full token info (from nadfun_token_info)
 */
export interface NadFunTokenFullInfo {
  // Metadata
  address: string;
  symbol: string;
  name: string;
  description?: string;
  imageUri?: string;
  isGraduated: boolean;
  createdAt: string;
  creator?: { address: string; name?: string };
  socials?: { twitter?: string; telegram?: string; website?: string };

  // Market data
  marketType: "DEX" | "CURVE";
  priceUsd: string;
  priceNative: string;
  totalSupply?: string;
  reserveNative?: string;
  reserveToken?: string;
  volume?: string;
  athPrice?: string;
  holderCount: number;

  // Progress (if not graduated)
  progress?: number; // 0-10000
  progressPercent?: string; // "45.5%"
}

/**
 * User position (from nadfun_positions)
 */
export interface UserPosition {
  token: {
    address: string;
    symbol: string;
    name?: string;
    imageUri?: string;
  };
  holdings: string;
  avgBuyPrice: string;
  currentPrice: string;
  marketValue: string;
  pnl: {
    usd: string;
    percent: string;
    isProfit: boolean;
  };
  marketType: "DEX" | "CURVE";
}

// ============================================================================
// Tool Response Types
// ============================================================================

/**
 * Response from nadfun_discover tool
 */
export interface NadFunDiscoverResponse {
  success: boolean;
  message: string;
  tokens?: DiscoveredToken[];
  totalCount?: number;
  page?: number;
  error?: string;
}

/**
 * Response from nadfun_token_info tool
 */
export interface NadFunTokenInfoResponse {
  success: boolean;
  message: string;
  token?: NadFunTokenFullInfo;
  recommendation?: string;
  error?: string;
}

/**
 * Response from nadfun_positions tool
 */
export interface NadFunPositionsResponse {
  success: boolean;
  message: string;
  address?: string;
  positions?: UserPosition[];
  summary?: {
    totalPositions: number;
    totalValue: string;
    totalPnl: string;
    profitableCount: number;
  };
  error?: string;
}

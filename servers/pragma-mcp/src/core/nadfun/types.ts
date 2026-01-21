// nad.fun Type Definitions
// Interfaces for bonding curve trading operations
// Copyright (c) 2026 s0nderlabs

import type { Address, Hex } from "viem";

// ============================================================================
// Token Status Types
// ============================================================================

/**
 * Trading venue for a token
 * - bonding_curve: Token is still on nad.fun bonding curve
 * - dex: Token has graduated and trades on regular DEX
 */
export type TradingVenue = "bonding_curve" | "dex";

/**
 * Status of a token on nad.fun
 */
export interface NadFunTokenStatus {
  token: Address;
  tokenSymbol?: string; // From on-chain ERC20
  tokenName?: string; // From on-chain ERC20
  isGraduated: boolean;
  isLocked: boolean;
  progress: number; // 0-10000
  progressPercent: string; // "45.5%"
  availableTokens?: string; // Formatted with decimals
  availableTokensWei?: bigint;
  requiredMon?: string; // Formatted
  requiredMonWei?: bigint;
  tradingVenue: TradingVenue;
}

// ============================================================================
// Quote Types
// ============================================================================

/**
 * Direction of a nad.fun trade
 */
export type NadFunDirection = "BUY" | "SELL";

/**
 * Parameters for getting a nad.fun quote
 */
export interface NadFunQuoteParams {
  token: Address;
  amount: bigint;
  isBuy: boolean;
  slippageBps: number;
  chainId: number;
  sender: Address; // Smart account address
  tokenSymbol?: string;
  tokenDecimals?: number;
  exactOutput?: boolean; // If true, amount is the desired output (e.g., "buy 500 tokens")
}

/**
 * Cached nad.fun quote with execution data
 */
export interface NadFunQuote {
  quoteId: string;
  token: Address;
  tokenSymbol: string;
  tokenDecimals: number;
  direction: NadFunDirection;
  amountIn: string; // Formatted
  amountInWei: bigint;
  expectedOutput: string; // Formatted
  expectedOutputWei: bigint;
  minOutput: string; // Formatted (after slippage)
  minOutputWei: bigint;
  slippageBps: number;
  progress: number; // Current graduation progress
  progressPercent: string;
  router: Address;
  expiresAt: number; // Unix timestamp (ms)
  chainId: number;
}

/**
 * Internal cached quote with execution data
 * Extends NadFunQuote with private execution fields
 */
export interface CachedNadFunQuote extends NadFunQuote {
  _calldata: Hex;
  _value: bigint; // MON to send (for buy operations)
}

// ============================================================================
// Execution Types
// ============================================================================

/**
 * Result of a nad.fun execution (buy or sell)
 */
export interface NadFunExecutionResult {
  success: boolean;
  txHash?: Hex;
  explorerUrl?: string;
  tokensTraded?: string; // Amount of tokens bought/sold
  monAmount?: string; // Amount of MON spent/received
  error?: string;
}

/**
 * Parameters for nad.fun buy execution
 */
export interface NadFunBuyParams {
  amountOutMin: bigint;
  token: Address;
  to: Address;
  deadline: bigint;
}

/**
 * Parameters for nad.fun sell execution
 */
export interface NadFunSellParams {
  amountIn: bigint;
  amountOutMin: bigint;
  token: Address;
  to: Address;
  deadline: bigint;
}

// ============================================================================
// Delegation Context Types
// ============================================================================

/**
 * Context for creating a nad.fun buy delegation
 * buy() is payable - sends MON as msg.value
 */
export interface NadFunBuyDelegationContext {
  router: Address;
  delegator: Address;
  sessionKey: Address;
  nonce: bigint;
  chainId: number;
  calldata: Hex;
  value: bigint; // MON to send as msg.value
}

/**
 * Context for creating a nad.fun sell delegation
 * sell() is nonpayable - requires token approval first
 */
export interface NadFunSellDelegationContext {
  router: Address;
  delegator: Address;
  sessionKey: Address;
  nonce: bigint;
  chainId: number;
  calldata: Hex;
}

// ============================================================================
// Tool Response Types
// ============================================================================

/**
 * Response from nadfun_status tool
 */
export interface NadFunStatusResponse {
  success: boolean;
  message: string;
  status?: NadFunTokenStatus;
  recommendation?: string;
  error?: string;
}

/**
 * Response from nadfun_quote tool
 */
export interface NadFunQuoteResponse {
  success: boolean;
  message: string;
  quote?: {
    quoteId: string;
    token: string;
    tokenSymbol: string;
    direction: NadFunDirection;
    amountIn: string;
    expectedOutput: string;
    minOutput: string;
    slippageBps: number;
    progress: string;
    progressPercent: string;
    expiresIn: string;
  };
  warning?: string;
  error?: string;
}

/**
 * Response from nadfun_buy/nadfun_sell tools
 */
export interface NadFunExecuteResponse {
  success: boolean;
  message: string;
  transaction?: {
    hash: string;
    explorerUrl: string;
  };
  trade?: {
    tokenSymbol: string;
    monSpent?: string;
    monReceived?: string;
    tokensReceived?: string;
    tokensSold?: string;
    progress: string;
  };
  error?: string;
}

// ============================================================================
// Token Creation Types
// ============================================================================

/**
 * Input parameters for creating a new token on nad.fun
 */
export interface TokenCreationInput {
  name: string;
  symbol: string;
  imagePath: string;
  description?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  initialBuyMon?: string;
  slippageBps?: number;
}

/**
 * Cached creation quote with all prepared data
 */
export interface CreateQuote {
  quoteId: string;
  name: string;
  symbol: string;
  imageUri: string;
  metadataUri: string;
  salt: Hex;
  predictedTokenAddress: Address;
  initialBuyMon?: string;
  expiresAt: number; // Unix timestamp (ms)
  chainId: number;
  // Internal execution data
  _calldata: Hex;
}

/**
 * Result of token creation execution
 */
export interface CreateResult {
  success: boolean;
  txHash?: Hex;
  explorerUrl?: string;
  tokenAddress?: Address;
  tokenName?: string;
  tokenSymbol?: string;
  message?: string;
  error?: string;
  initialBuyMon?: string; // MON spent on initial buy (if atomic)
}

/**
 * Context for creating a nad.fun token creation delegation
 * create() is payable - requires deploy fee (10 MON on mainnet)
 */
export interface NadFunCreateDelegationContext {
  router: Address;
  delegator: Address;
  sessionKey: Address;
  nonce: bigint;
  chainId: number;
  calldata: Hex;
  value: bigint; // Deploy fee (10 MON on mainnet)
}

/**
 * Response from nadfun_create tool
 */
export interface NadFunCreateResponse {
  success: boolean;
  message: string;
  token?: {
    address: string;
    name: string;
    symbol: string;
    explorerUrl: string; // Link to token on explorer
  };
  transaction?: {
    hash: string;
    explorerUrl: string;
  };
  initialBuy?: {
    monSpent: string;
  };
  error?: string;
}

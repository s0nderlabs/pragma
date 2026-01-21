// nad.fun Quote System
// Quote caching and calldata generation for bonding curve trades
// Copyright (c) 2026 s0nderlabs

import { encodeFunctionData, formatUnits, type Address, type Hex } from "viem";
import { getAmountOut, getAmountIn, getTokenStatus, getNadFunContracts, isNearGraduation } from "./client.js";
import {
  NADFUN_QUOTE_EXPIRY_MS,
  DEFAULT_DEADLINE_SECONDS,
  DEFAULT_SLIPPAGE_BPS,
  MAX_SLIPPAGE_BPS,
  ROUTER_ABI,
} from "./constants.js";
import type {
  NadFunQuote,
  NadFunQuoteParams,
  CachedNadFunQuote,
  NadFunDirection,
} from "./types.js";

// ============================================================================
// Quote Cache
// ============================================================================

const quoteCache = new Map<string, CachedNadFunQuote>();

/**
 * Generate a unique quote ID
 */
function generateQuoteId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `nadfun-${timestamp}-${random}`;
}

/**
 * Clean up expired quotes from cache
 */
function cleanupExpiredQuotes(): void {
  const now = Date.now();
  for (const [id, quote] of quoteCache.entries()) {
    if (quote.expiresAt < now) {
      quoteCache.delete(id);
    }
  }
}

// ============================================================================
// Calldata Builders
// ============================================================================

/**
 * Encode buy calldata for BondingCurveRouter.buy()
 *
 * buy(BuyParams params) where BuyParams = {
 *   amountOutMin: uint256,
 *   token: address,
 *   to: address,
 *   deadline: uint256
 * }
 */
function encodeBuyCalldata(
  amountOutMin: bigint,
  token: Address,
  to: Address,
  deadline: bigint
): Hex {
  return encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: "buy",
    args: [{ amountOutMin, token, to, deadline }],
  });
}

/**
 * Encode sell calldata for BondingCurveRouter.sell()
 *
 * sell(SellParams params) where SellParams = {
 *   amountIn: uint256,
 *   amountOutMin: uint256,
 *   token: address,
 *   to: address,
 *   deadline: uint256
 * }
 */
function encodeSellCalldata(
  amountIn: bigint,
  amountOutMin: bigint,
  token: Address,
  to: Address,
  deadline: bigint
): Hex {
  return encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: "sell",
    args: [{ amountIn, amountOutMin, token, to, deadline }],
  });
}

// ============================================================================
// Quote Builder
// ============================================================================

/**
 * Build a nad.fun quote with cached execution data
 *
 * @param params - Quote parameters
 * @returns Quote with execution data, or throws if token is graduated/locked
 */
export async function buildNadFunQuote(
  params: NadFunQuoteParams
): Promise<{ quote: NadFunQuote; warning?: string }> {
  cleanupExpiredQuotes();

  const {
    token,
    amount,
    isBuy,
    slippageBps = DEFAULT_SLIPPAGE_BPS,
    chainId,
    sender,
    tokenSymbol = "TOKEN",
    tokenDecimals = 18,
    exactOutput = false,
  } = params;

  // Validate slippage
  if (slippageBps < 0 || slippageBps > MAX_SLIPPAGE_BPS) {
    throw new Error(`Slippage must be between 0 and ${MAX_SLIPPAGE_BPS} bps`);
  }

  // Check token status first
  const status = await getTokenStatus(token, chainId);

  if (status.isGraduated) {
    throw new Error(
      `Token has graduated to DEX. Use regular swap tools (get_swap_quote + execute_swap) instead.`
    );
  }

  if (status.isLocked) {
    throw new Error(
      `Token is locked during graduation process. Cannot trade until graduation completes.`
    );
  }

  let router: Address;
  let amountInWei: bigint;
  let expectedOutputWei: bigint;

  if (exactOutput) {
    // Exact output mode: amount is the desired output, calculate required input
    // For BUY: amount = desired tokens, calculate MON needed
    // For SELL: amount = desired MON, calculate tokens needed
    const result = await getAmountIn(token, amount, isBuy, chainId);
    router = result.router;
    amountInWei = result.amountIn;
    expectedOutputWei = amount; // The exact output we want
  } else {
    // Normal mode: amount is the input, calculate expected output
    const result = await getAmountOut(token, amount, isBuy, chainId);
    router = result.router;
    amountInWei = amount;
    expectedOutputWei = result.amountOut;
  }

  // Log if router differs from expected (informational only)
  const contracts = getNadFunContracts(chainId);
  if (router.toLowerCase() !== contracts.router.toLowerCase()) {
    console.log(`[nadfun] Using Lens-returned router: ${router} (expected ${contracts.router})`);
  }

  // Calculate minimum output with slippage (only applies to output)
  const slippageMultiplier = BigInt(10000 - slippageBps);
  const minOutputWei = (expectedOutputWei * slippageMultiplier) / BigInt(10000);

  // For exactOutput mode, we need to add slippage buffer to input (pay more to guarantee output)
  const maxInputWei = exactOutput
    ? (amountInWei * BigInt(10000 + slippageBps)) / BigInt(10000)
    : amountInWei;

  // Calculate deadline
  const deadline = BigInt(Math.floor(Date.now() / 1000) + DEFAULT_DEADLINE_SECONDS);

  // Build calldata
  let calldata: Hex;
  let value: bigint;

  if (isBuy) {
    // Buy: Send MON as msg.value, receive tokens
    // For exactOutput, use minOutputWei (the guaranteed minimum we'll accept)
    calldata = encodeBuyCalldata(minOutputWei, token, sender, deadline);
    value = maxInputWei; // MON to send (with slippage buffer for exactOutput)
  } else {
    // Sell: Send tokens, receive MON
    calldata = encodeSellCalldata(maxInputWei, minOutputWei, token, sender, deadline);
    value = 0n; // No MON sent
  }

  // Build quote
  const direction: NadFunDirection = isBuy ? "BUY" : "SELL";
  const quoteId = generateQuoteId();

  const cachedQuote: CachedNadFunQuote = {
    quoteId,
    token,
    tokenSymbol,
    tokenDecimals,
    direction,
    amountIn: isBuy ? formatUnits(maxInputWei, 18) : formatUnits(maxInputWei, tokenDecimals),
    amountInWei: maxInputWei,
    expectedOutput: isBuy ? formatUnits(expectedOutputWei, tokenDecimals) : formatUnits(expectedOutputWei, 18),
    expectedOutputWei,
    minOutput: isBuy ? formatUnits(minOutputWei, tokenDecimals) : formatUnits(minOutputWei, 18),
    minOutputWei,
    slippageBps,
    progress: status.progress,
    progressPercent: status.progressPercent,
    router,
    expiresAt: Date.now() + NADFUN_QUOTE_EXPIRY_MS,
    chainId,
    _calldata: calldata,
    _value: value,
  };

  // Cache the quote
  quoteCache.set(quoteId, cachedQuote);

  // Strip internal fields for external quote
  const { _calldata, _value, ...quote } = cachedQuote;

  // Check if near graduation for warning
  let warning: string | undefined;
  if (isNearGraduation(status.progress)) {
    warning = `Token is ${status.progressPercent} toward graduation. Large buys may trigger graduation.`;
  }

  return { quote, warning };
}

// ============================================================================
// Quote Retrieval
// ============================================================================

/**
 * Get a cached quote by ID
 */
export function getCachedNadFunQuote(quoteId: string): NadFunQuote | null {
  const quote = quoteCache.get(quoteId);
  if (!quote) return null;

  if (isNadFunQuoteExpired(quote)) {
    quoteCache.delete(quoteId);
    return null;
  }

  // Strip internal fields
  const { _calldata, _value, ...externalQuote } = quote;
  return externalQuote;
}

/**
 * Get execution data for a cached quote
 * Returns internal calldata and value needed for delegation
 */
export function getNadFunQuoteExecutionData(
  quoteId: string
): { calldata: Hex; router: Address; value: bigint; direction: NadFunDirection } | null {
  const quote = quoteCache.get(quoteId);
  if (!quote || !quote._calldata) {
    return null;
  }

  if (isNadFunQuoteExpired(quote)) {
    quoteCache.delete(quoteId);
    return null;
  }

  return {
    calldata: quote._calldata,
    router: quote.router,
    value: quote._value,
    direction: quote.direction,
  };
}

/**
 * Check if a quote has expired
 */
export function isNadFunQuoteExpired(quote: NadFunQuote): boolean {
  return Date.now() >= quote.expiresAt;
}

/**
 * Get time remaining until quote expires (in seconds)
 */
export function getNadFunQuoteTimeRemaining(quote: NadFunQuote): number {
  const remaining = quote.expiresAt - Date.now();
  return Math.max(0, Math.floor(remaining / 1000));
}

/**
 * Delete a quote from cache
 */
export function deleteNadFunQuote(quoteId: string): void {
  quoteCache.delete(quoteId);
}

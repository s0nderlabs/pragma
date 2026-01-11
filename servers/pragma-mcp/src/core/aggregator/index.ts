// Unified DEX Aggregator
// Tries 0x first (primary), falls back to Monorail
// Copyright (c) 2026 s0nderlabs

import type { Address, Hex } from "viem";
import type { SwapQuote, AggregatorName } from "../../types/index.js";
import {
  getZeroXQuote,
  getCachedZeroXQuote,
  getZeroXExecutionData,
  isQuoteExpired as isZeroXQuoteExpired,
} from "../zerox/client.js";
import {
  getQuote as getMonorailQuote,
  getCachedQuote as getCachedMonorailQuote,
  getQuoteExecutionData as getMonorailExecutionData,
  isQuoteExpired as isMonorailQuoteExpired,
  type PathfinderRequest,
} from "../monorail/pathfinder.js";
import { loadConfig } from "../../config/pragma-config.js";

export interface QuoteRequest {
  fromToken: Address;
  toToken: Address;
  amount: bigint;
  sender: Address;
  slippageBps?: number;
  fromDecimals: number;
  toDecimals: number;
  fromSymbol: string;
  toSymbol: string;
}

export interface QuoteResult {
  quote: SwapQuote;
  aggregator: AggregatorName;
  fallbackUsed: boolean;
  fallbackReason?: string;
}

const DEFAULT_SLIPPAGE_BPS = 500;

import { getChainConfig } from "../../config/chains.js";

/**
 * Try Monorail as fallback when 0x fails
 */
async function tryMonorailFallback(
  request: QuoteRequest,
  slippageBps: number,
  chainId: number,
  zeroXError: string
): Promise<QuoteResult> {
  console.log("[aggregator] Trying Monorail API...");

  const monorailRequest: PathfinderRequest = {
    fromToken: request.fromToken,
    toToken: request.toToken,
    amount: request.amount,
    sender: request.sender,
    slippageBps,
    fromDecimals: request.fromDecimals,
    toDecimals: request.toDecimals,
    fromSymbol: request.fromSymbol,
    toSymbol: request.toSymbol,
  };

  const monorailQuote = await getMonorailQuote(monorailRequest);
  const chainConfig = getChainConfig(chainId);

  const enrichedQuote: SwapQuote = {
    ...monorailQuote,
    aggregator: "monorail" as AggregatorName,
    aggregatorAddress: chainConfig.aggregators?.monorail || monorailQuote.aggregatorAddress,
    minOutput: monorailQuote.minOutput || monorailQuote.expectedOutput,
    minOutputWei: monorailQuote.minOutputWei || monorailQuote.expectedOutputWei,
  };

  console.log("[aggregator] Monorail quote successful (fallback)");
  return {
    quote: enrichedQuote,
    aggregator: "monorail",
    fallbackUsed: true,
    fallbackReason: zeroXError,
  };
}

/**
 * Get swap quote from aggregators
 *
 * Strategy: 0x first (primary), Monorail as fallback
 * - 0x is more stable and reliable
 * - Monorail only used if 0x fails (no liquidity, API error, etc.)
 */
export async function getQuote(request: QuoteRequest): Promise<QuoteResult> {
  const config = await loadConfig();
  if (!config?.network) {
    throw new Error("Network not configured. Run setup_wallet first.");
  }

  const chainId = config.network.chainId;
  const slippageBps = request.slippageBps ?? DEFAULT_SLIPPAGE_BPS;

  let zeroXError = "No liquidity available";

  // Try 0x first (primary aggregator)
  try {
    console.log("[aggregator] Trying 0x API...");
    const zeroXQuote = await getZeroXQuote({
      ...request,
      recipient: request.sender,
      slippageBps,
      chainId,
    });

    if (zeroXQuote) {
      console.log("[aggregator] 0x quote successful");
      return {
        quote: zeroXQuote,
        aggregator: "0x",
        fallbackUsed: false,
      };
    }

    console.log("[aggregator] 0x: No liquidity, falling back to Monorail");
  } catch (error) {
    zeroXError = error instanceof Error ? error.message : String(error);
    console.log(`[aggregator] 0x failed: ${zeroXError}, falling back to Monorail`);
  }

  // Try Monorail as fallback
  try {
    return await tryMonorailFallback(request, slippageBps, chainId, `0x: ${zeroXError}`);
  } catch (monorailError) {
    const monorailMessage =
      monorailError instanceof Error ? monorailError.message : String(monorailError);
    throw new Error(
      `Both aggregators failed. 0x: ${zeroXError}. Monorail: ${monorailMessage}`
    );
  }
}

/**
 * Get a cached quote by ID (checks both 0x and Monorail caches)
 */
export async function getCachedQuote(quoteId: string): Promise<SwapQuote | null> {
  // Check if it's a 0x quote
  if (quoteId.startsWith("quote-0x-")) {
    return getCachedZeroXQuote(quoteId);
  }

  // Otherwise check Monorail
  return getCachedMonorailQuote(quoteId);
}

/**
 * Get execution data for a cached quote
 */
export async function getQuoteExecutionData(
  quoteId: string
): Promise<{ calldata: Hex; router: Address; value: bigint } | null> {
  // Check if it's a 0x quote
  if (quoteId.startsWith("quote-0x-")) {
    return getZeroXExecutionData(quoteId);
  }

  // Otherwise check Monorail
  const monorailData = await getMonorailExecutionData(quoteId);
  if (!monorailData) return null;

  return {
    calldata: monorailData.calldata as Hex,
    router: monorailData.router,
    value: BigInt(monorailData.value || "0"),
  };
}

/**
 * Check if a quote has expired
 */
export function isQuoteExpired(quote: SwapQuote): boolean {
  if (quote.aggregator === "0x") {
    return isZeroXQuoteExpired(quote);
  }
  return isMonorailQuoteExpired(quote);
}

/**
 * Get time remaining until quote expires (in seconds)
 */
export function getQuoteTimeRemaining(quote: SwapQuote): number {
  const remaining = quote.expiresAt - Date.now();
  return Math.max(0, Math.floor(remaining / 1000));
}

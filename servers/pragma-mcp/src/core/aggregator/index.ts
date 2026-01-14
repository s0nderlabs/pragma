// Unified DEX Aggregator
// Provider-agnostic quote interface
// Copyright (c) 2026 s0nderlabs

import type { Address, Hex } from "viem";
import type { SwapQuote } from "../../types/index.js";
import {
  fetchQuote,
  getCachedQuote,
  getQuoteExecutionData,
  isQuoteExpired,
  getQuoteTimeRemaining,
} from "../quote/client.js";
import { loadConfig } from "../../config/pragma-config.js";

// Re-export quote utilities directly
export { getCachedQuote, getQuoteExecutionData, isQuoteExpired, getQuoteTimeRemaining };

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
  aggregator: string;
  fallbackUsed: boolean;
  fallbackReason?: string;
}

const DEFAULT_SLIPPAGE_BPS = 500;

/**
 * Get swap quote from aggregator
 */
export async function getQuote(request: QuoteRequest): Promise<QuoteResult> {
  const config = await loadConfig();
  if (!config?.network) {
    throw new Error("Network not configured. Run setup_wallet first.");
  }

  const quote = await fetchQuote({
    ...request,
    recipient: request.sender,
    slippageBps: request.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
    chainId: config.network.chainId,
  });

  if (!quote) {
    throw new Error("No liquidity available for this swap pair");
  }

  return { quote, aggregator: quote.aggregator, fallbackUsed: false };
}

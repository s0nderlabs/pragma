// Batch Quote Orchestrator
// Handles concurrent quote fetching for multiple swaps
// Retry logic is handled at the lower level (fetchQuote) - this module just orchestrates
// Copyright (c) 2026 s0nderlabs

import { getQuote, type QuoteResult } from "../aggregator/index.js";
import type { Address } from "viem";

export interface BatchQuoteRequest {
  fromToken: Address;
  toToken: Address;
  amount: bigint;
  sender: Address;
  slippageBps: number;
  fromDecimals: number;
  toDecimals: number;
  fromSymbol: string;
  toSymbol: string;
}

export interface BatchQuoteResultItem {
  index: number;
  request: {
    fromSymbol: string;
    toSymbol: string;
    amount: string;
  };
  quote: QuoteResult | null;
  error?: string;
}

export interface BatchQuoteResult {
  totalRequested: number;
  totalSucceeded: number;
  totalFailed: number;
  results: BatchQuoteResultItem[];
}

// Maximum concurrent requests to avoid overwhelming APIs
const MAX_CONCURRENT = 5;

/**
 * Fetch a single quote
 * Retry logic is handled at the fetchQuote level
 */
async function fetchSingleQuote(
  req: BatchQuoteRequest
): Promise<{ quote: QuoteResult | null; error?: string }> {
  try {
    const quoteResult = await getQuote(req);
    return { quote: quoteResult };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return { quote: null, error: errorMessage };
  }
}

/**
 * Fetch quotes in parallel with concurrency limit
 * Retry is handled internally by each getQuote call
 */
async function fetchQuotesParallel(
  requests: BatchQuoteRequest[]
): Promise<BatchQuoteResultItem[]> {
  const results: BatchQuoteResultItem[] = new Array(requests.length);

  // Process in chunks of MAX_CONCURRENT
  for (let i = 0; i < requests.length; i += MAX_CONCURRENT) {
    const chunk = requests.slice(i, i + MAX_CONCURRENT);
    const chunkPromises = chunk.map(async (req, idx) => {
      const resultIndex = i + idx;
      const requestSummary = {
        fromSymbol: req.fromSymbol,
        toSymbol: req.toSymbol,
        amount: req.amount.toString(),
      };

      const { quote, error } = await fetchSingleQuote(req);

      return {
        index: resultIndex,
        request: requestSummary,
        quote,
        error,
      };
    });

    const chunkResults = await Promise.all(chunkPromises);
    for (const r of chunkResults) {
      results[r.index] = r;
    }
  }

  return results;
}

/**
 * Fetch multiple quotes in parallel
 *
 * Both modes use parallel execution:
 * - x402: Proxy handles rate limiting, retry at fetchQuote level
 * - BYOK: Adapter engine handles retry per-adapter before fallback
 *
 * @param requests - Array of quote requests
 * @returns BatchQuoteResult with all results
 */
export async function fetchBatchQuotes(
  requests: BatchQuoteRequest[]
): Promise<BatchQuoteResult> {
  if (requests.length === 0) {
    return { totalRequested: 0, totalSucceeded: 0, totalFailed: 0, results: [] };
  }

  const results = await fetchQuotesParallel(requests);
  const succeeded = results.filter((r) => r.quote !== null).length;

  return {
    totalRequested: requests.length,
    totalSucceeded: succeeded,
    totalFailed: requests.length - succeeded,
    results,
  };
}

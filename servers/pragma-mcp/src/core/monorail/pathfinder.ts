// Monorail Pathfinder Client
// Fetches swap quotes from Monorail API
// Adapted from pragma-v2-stable (H2)

import type { Address } from "viem";
import type { SwapQuote } from "../../types/index.js";

// TODO: Implement - copy and adapt from H2
// Key patterns to preserve:
// - Quote caching with expiry
// - Quote ID generation for tracking
// - Rate limiting handling

export interface PathfinderRequest {
  fromToken: Address;
  toToken: Address;
  amount: bigint;
  sender: Address;
  slippageBps?: number;
}

export interface PathfinderResponse {
  routerAddress: Address;
  calldata: string;
  expectedOutput: bigint;
  minimumOutput: bigint;
  gasEstimate: bigint;
  route: string[];
}

export async function getQuote(
  request: PathfinderRequest
): Promise<SwapQuote> {
  throw new Error("Not implemented");
}

export async function getCachedQuote(quoteId: string): Promise<SwapQuote | null> {
  throw new Error("Not implemented");
}

export function isQuoteExpired(quote: SwapQuote): boolean {
  throw new Error("Not implemented");
}

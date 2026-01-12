// 0x Protocol Client
// Primary DEX aggregator for swap execution
// Adapted from pragma-v2-stable (H2)
// Copyright (c) 2026 s0nderlabs

import type { Address, Hex } from "viem";
import { formatUnits, getAddress } from "viem";
import type { SwapQuote, AggregatorName } from "../../types/index.js";
import { getProvider } from "../signer/index.js";
import { getChainConfig } from "../../config/chains.js";
import { loadConfig } from "../../config/pragma-config.js";
import { NATIVE_TOKEN_ADDRESS } from "../../config/constants.js";

const ZERO_X_API_URL = "https://api.0x.org/swap/allowance-holder/quote";

// EIP-7528 native token address used by 0x
const EIP7528_NATIVE_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Address;

// Quote expiry in milliseconds (5 minutes)
const QUOTE_EXPIRY_MS = 5 * 60 * 1000;

export interface ZeroXQuoteRequest {
  fromToken: Address;
  toToken: Address;
  amount: bigint;
  sender: Address;
  recipient: Address;
  slippageBps: number;
  fromDecimals: number;
  toDecimals: number;
  fromSymbol: string;
  toSymbol: string;
  chainId: number;
}

interface ZeroXQuoteResponse {
  liquidityAvailable: boolean;
  sellAmount: string;
  buyAmount: string;
  minBuyAmount: string;
  transaction: {
    to: string;
    data: string;
    gas?: string;
    gasPrice?: string;
    value?: string;
  };
  route?: {
    fills?: Array<{
      source: string;
      proportion: string;
    }>;
  };
  // Error case
  name?: string;
  message?: string;
}

// Extended quote with execution data
interface CachedQuote extends SwapQuote {
  _calldata: Hex;
  _router: Address;
  _value: bigint;
}

const quoteCache = new Map<string, CachedQuote>();

function generateQuoteId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `quote-0x-${timestamp}-${random}`;
}

function cleanupExpiredQuotes(): void {
  const now = Date.now();
  for (const [id, quote] of quoteCache.entries()) {
    if (quote.expiresAt < now) {
      quoteCache.delete(id);
    }
  }
}

/**
 * Convert native token address to EIP-7528 format for 0x API
 * 0x expects 0xEeee... format for native tokens
 */
function toZeroXTokenAddress(address: Address): Address {
  if (address.toLowerCase() === NATIVE_TOKEN_ADDRESS.toLowerCase()) {
    return EIP7528_NATIVE_TOKEN;
  }
  return getAddress(address); // Ensure checksummed
}

/**
 * Fetch quote from 0x API
 *
 * @param request - Quote request parameters
 * @returns SwapQuote or null if no liquidity
 * @throws Error if API fails or API key missing
 */
export async function getZeroXQuote(request: ZeroXQuoteRequest): Promise<SwapQuote | null> {
  // Cleanup old quotes
  cleanupExpiredQuotes();

  // Get 0x API key from keychain or environment
  let apiKey = await getProvider("0x");
  if (!apiKey) {
    // Check environment variables as fallback
    apiKey = process.env.ZERO_X_API_KEY || process.env.OX_API_KEY || null;
  }
  if (!apiKey) {
    throw new Error(
      "0x API key not configured. Set ZERO_X_API_KEY env var or run: pragma store-provider 0x <your-api-key>"
    );
  }

  // Get chain config
  const chainConfig = getChainConfig(request.chainId);
  const routerAddress = chainConfig.aggregators?.zeroX;
  if (!routerAddress) {
    throw new Error(`0x not supported on chain ${request.chainId}`);
  }

  // Build query URL
  const url = new URL(ZERO_X_API_URL);
  url.searchParams.set("chainId", request.chainId.toString());
  url.searchParams.set("sellToken", toZeroXTokenAddress(request.fromToken));
  url.searchParams.set("buyToken", toZeroXTokenAddress(request.toToken));
  url.searchParams.set("sellAmount", request.amount.toString());
  url.searchParams.set("taker", request.sender);

  // 0x v2 API uses slippageBps directly (not slippagePercentage like v1)
  // slippageBps: 100 = 1%, 500 = 5%, 1500 = 15%
  url.searchParams.set("slippageBps", request.slippageBps.toString());

  // Fetch quote
  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "0x-api-key": apiKey,
      "0x-version": "v2",
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`0x API error (${response.status}): ${text}`);
  }

  const data = (await response.json()) as ZeroXQuoteResponse;

  // Check for error response
  if (data.message) {
    throw new Error(`0x API: ${data.message}`);
  }

  // Check liquidity
  if (!data.liquidityAvailable) {
    console.log("[0x] No liquidity available for this swap");
    return null;
  }

  // Validate response
  if (!data.transaction?.to || !data.transaction?.data) {
    throw new Error("Invalid response from 0x API: missing transaction data");
  }

  // Parse amounts
  const amountInWei = BigInt(data.sellAmount);
  const expectedOutputWei = BigInt(data.buyAmount);
  const minOutputWei = BigInt(data.minBuyAmount);

  // Generate quote ID and expiry
  const quoteId = generateQuoteId();
  const expiresAt = Date.now() + QUOTE_EXPIRY_MS;

  // Extract route info
  const routeSymbols: string[] = [request.fromSymbol];
  if (data.route?.fills && data.route.fills.length > 0) {
    // Add intermediate sources if available
    for (const fill of data.route.fills) {
      if (fill.source && !routeSymbols.includes(fill.source)) {
        routeSymbols.push(`[${fill.source}]`);
      }
    }
  }
  routeSymbols.push(request.toSymbol);

  // Build quote object
  const quote: CachedQuote = {
    quoteId,
    fromToken: {
      address: request.fromToken,
      symbol: request.fromSymbol,
      decimals: request.fromDecimals,
    },
    toToken: {
      address: request.toToken,
      symbol: request.toSymbol,
      decimals: request.toDecimals,
    },
    amountIn: formatUnits(amountInWei, request.fromDecimals),
    amountInWei,
    expectedOutput: formatUnits(expectedOutputWei, request.toDecimals),
    expectedOutputWei,
    minOutput: formatUnits(minOutputWei, request.toDecimals),
    minOutputWei,
    priceImpact: 0, // 0x doesn't provide price impact directly
    route: routeSymbols,
    gasEstimate: BigInt(data.transaction.gas || "300000"),
    expiresAt,
    aggregator: "0x" as AggregatorName,
    aggregatorAddress: getAddress(data.transaction.to),
    // Execution data
    _calldata: data.transaction.data as Hex,
    _router: getAddress(data.transaction.to),
    _value: BigInt(data.transaction.value || "0"),
  };

  // Cache the quote
  quoteCache.set(quoteId, quote);

  return quote;
}

/**
 * Get a cached quote by ID
 */
export function getCachedZeroXQuote(quoteId: string): SwapQuote | null {
  const quote = quoteCache.get(quoteId);
  if (!quote) return null;
  if (isQuoteExpired(quote)) {
    quoteCache.delete(quoteId);
    return null;
  }
  return quote;
}

/**
 * Get execution data for a cached 0x quote
 */
export function getZeroXExecutionData(
  quoteId: string
): { calldata: Hex; router: Address; value: bigint } | null {
  const quote = quoteCache.get(quoteId);
  if (!quote || !quote._calldata || !quote._router) {
    return null;
  }
  return {
    calldata: quote._calldata,
    router: quote._router,
    value: quote._value,
  };
}

/**
 * Check if a quote has expired
 */
export function isQuoteExpired(quote: SwapQuote): boolean {
  return Date.now() >= quote.expiresAt;
}

/**
 * Delete a quote from cache
 */
export function deleteQuote(quoteId: string): void {
  quoteCache.delete(quoteId);
}

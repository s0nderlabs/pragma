// Monorail Pathfinder Client
// Fetches swap quotes from Monorail API
// Adapted from pragma-v2-stable (H2)
// Copyright (c) 2026 s0nderlabs

import type { Address } from "viem";
import { formatUnits, getAddress } from "viem";
import type { SwapQuote, AggregatorName } from "../../types/index.js";
import { getProvider } from "../signer/index.js";
import { getChainConfig } from "../../config/chains.js";
import { loadConfig } from "../../config/pragma-config.js";

// MARK: - Types

export interface PathfinderRequest {
  fromToken: Address;
  toToken: Address;
  amount: bigint;
  sender: Address;
  slippageBps?: number; // Basis points (50 = 0.5%)
  fromDecimals: number;
  toDecimals: number;
  fromSymbol: string;
  toSymbol: string;
}

export interface PathfinderResponse {
  routerAddress: Address;
  calldata: string;
  expectedOutput: bigint;
  minimumOutput: bigint;
  gasEstimate: bigint;
  route: string[];
}

/**
 * Monorail API v4 response structure
 * Endpoint: https://pathfinder.monorail.xyz/v4/quote
 */
interface MonorailQuoteResponse {
  // Input/Output amounts
  input: string; // Amount in wei
  input_formatted: string; // Amount in human-readable
  output: string; // Amount out wei
  output_formatted: string; // Amount out human-readable
  min_output: string; // Min output wei (after slippage)
  min_output_formatted: string;
  // Price impact
  compound_impact: string; // Price impact as decimal string
  // Gas
  gas_estimate: number;
  // Route info
  routes?: Array<Array<{
    from: string;
    from_symbol: string;
    to: string;
    to_symbol: string;
    weighted_price_impact: string;
    splits: Array<{
      protocol: string;
      fee: string;
      price_impact: string;
      percentage: string;
    }>;
  }>>;
  // Transaction data
  transaction: {
    to: string; // Router/aggregator address
    data: string; // Calldata
    value: string; // Value in hex
  };
  // Error case
  message?: string;
}

// MARK: - Quote Cache

/**
 * In-memory quote cache
 * Quotes expire after 5 minutes (matches H2)
 */
const quoteCache = new Map<string, SwapQuote>();
const QUOTE_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes (matches H2)

/**
 * Generate a unique quote ID
 */
function generateQuoteId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `quote-${timestamp}-${random}`;
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

// MARK: - Native Token Handling

/**
 * Native token address formats
 */
const NATIVE_TOKEN_ZERO = "0x0000000000000000000000000000000000000000" as Address;

/**
 * Check if address represents native token
 */
function isNativeToken(address: Address): boolean {
  return address.toLowerCase() === NATIVE_TOKEN_ZERO.toLowerCase();
}

// MARK: - API Client

/**
 * Get Monorail Pathfinder API base URL
 * Uses monorailPathfinder from chain config (already includes /v4)
 */
async function getMonorailApiUrl(): Promise<string> {
  // Get chain config for default URL
  const config = await loadConfig();
  if (!config) {
    throw new Error("Config not loaded");
  }

  const chainConfig = getChainConfig(config.network.chainId);
  const baseUrl = chainConfig.protocols?.monorailPathfinder || "https://pathfinder.monorail.xyz/v4";

  return baseUrl;
}

/**
 * Fetch quote from Monorail API v4
 * API docs: https://pathfinder.monorail.xyz/v4/quote
 *
 * Parameters:
 * - from: Token address to sell
 * - to: Token address to buy
 * - amount: Amount in human-readable format (decimal, not wei)
 * - sender: User's wallet address
 * - source: App identifier (optional but recommended)
 * - slippage: Slippage tolerance in percent (e.g., 0.5 for 0.5%)
 */
async function fetchMonorailQuote(
  request: PathfinderRequest
): Promise<MonorailQuoteResponse> {
  const baseUrl = await getMonorailApiUrl();

  // Convert wei amount to decimal string for API
  const amountDecimal = formatUnits(request.amount, request.fromDecimals);

  // Build query parameters - v4 API uses 'from' and 'to'
  // max_slippage is in basis points (50 = 0.5%)
  const params = new URLSearchParams({
    from: request.fromToken,
    to: request.toToken,
    amount: amountDecimal,
    sender: request.sender,
    source: "pragma", // App identifier
    max_slippage: (request.slippageBps || 1500).toString(), // Basis points (1500 = 15% to handle volatility)
  });

  const url = `${baseUrl}/quote?${params.toString()}`;

  // Get API key for auth header if available
  const apiKey = await getProvider("monorail");
  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  if (apiKey) {
    headers["x-api-key"] = apiKey;
  }

  const response = await fetch(url, {
    method: "GET",
    headers,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Monorail API error: ${response.status} - ${text}`);
  }

  return response.json() as Promise<MonorailQuoteResponse>;
}

// MARK: - Public API

/**
 * Get a swap quote from Monorail v4 API
 * Caches the quote and returns a quote ID for execution
 */
export async function getQuote(request: PathfinderRequest): Promise<SwapQuote> {
  // Cleanup old quotes
  cleanupExpiredQuotes();

  // Fetch from Monorail
  const response = await fetchMonorailQuote(request);

  // Check for error response
  if (response.message) {
    throw new Error(`Monorail API: ${response.message}`);
  }

  // Validate response has required fields
  if (!response.output || !response.transaction?.to) {
    throw new Error("Invalid response from Monorail API");
  }

  // Parse amounts (v4 returns amounts in wei as strings)
  const amountInWei = BigInt(response.input);
  const expectedOutputWei = BigInt(response.output);
  const minOutputWei = BigInt(response.min_output || response.output);

  // Generate quote ID and expiry
  const quoteId = generateQuoteId();
  const expiresAt = Date.now() + QUOTE_EXPIRY_MS;

  // Get config for aggregator address
  const config = await loadConfig();
  const chainConfig = getChainConfig(config!.network.chainId);

  // Extract route from routes array
  const routeSymbols: string[] = [];
  if (response.routes && response.routes.length > 0) {
    for (const hop of response.routes[0]) {
      if (hop.from_symbol && !routeSymbols.includes(hop.from_symbol)) {
        routeSymbols.push(hop.from_symbol);
      }
      if (hop.to_symbol && !routeSymbols.includes(hop.to_symbol)) {
        routeSymbols.push(hop.to_symbol);
      }
    }
  }

  // Build quote object
  const quote: SwapQuote = {
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
    priceImpact: parseFloat(response.compound_impact || "0"),
    route: routeSymbols,
    gasEstimate: BigInt(response.gas_estimate || 200000),
    expiresAt,
    aggregator: "monorail" as AggregatorName,
    aggregatorAddress: getAddress(response.transaction.to),
  };

  // Cache the quote with additional data for execution
  quoteCache.set(quoteId, quote);

  // Store calldata and router address for execution (extend the cache)
  // v4 API uses transaction.data for calldata and transaction.to for router
  (quote as SwapQuote & { _calldata?: string; _router?: string; _value?: string })._calldata = response.transaction.data;
  (quote as SwapQuote & { _calldata?: string; _router?: string; _value?: string })._router = response.transaction.to;
  (quote as SwapQuote & { _calldata?: string; _router?: string; _value?: string })._value = response.transaction.value;

  return quote;
}

/**
 * Get a cached quote by ID
 * Returns null if quote doesn't exist or is expired
 */
export async function getCachedQuote(quoteId: string): Promise<SwapQuote | null> {
  const quote = quoteCache.get(quoteId);

  if (!quote) {
    return null;
  }

  if (isQuoteExpired(quote)) {
    quoteCache.delete(quoteId);
    return null;
  }

  return quote;
}

/**
 * Get execution data for a cached quote
 */
export async function getQuoteExecutionData(
  quoteId: string
): Promise<{ calldata: string; router: Address; value: string } | null> {
  const quote = quoteCache.get(quoteId) as SwapQuote & { _calldata?: string; _router?: string; _value?: string } | undefined;

  if (!quote || !quote._calldata || !quote._router) {
    return null;
  }

  return {
    calldata: quote._calldata,
    router: quote._router as Address,
    value: quote._value || "0x0",
  };
}

/**
 * Check if a quote is expired
 */
export function isQuoteExpired(quote: SwapQuote): boolean {
  return Date.now() > quote.expiresAt;
}

/**
 * Get time remaining until quote expires (in seconds)
 */
export function getQuoteTimeRemaining(quote: SwapQuote): number {
  const remaining = quote.expiresAt - Date.now();
  return Math.max(0, Math.floor(remaining / 1000));
}

/**
 * Clear all cached quotes
 */
export function clearQuoteCache(): void {
  quoteCache.clear();
}

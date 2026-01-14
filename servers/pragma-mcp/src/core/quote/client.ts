// Quote Client
// DEX aggregator quote provider (provider-agnostic)
// x402 mode: All requests go through api.pr4gma.xyz
// BYOK mode: Uses adapter system for configured providers
// Copyright (c) 2026 s0nderlabs

import type { Address, Hex } from "viem";
import { formatUnits, getAddress } from "viem";
import type { SwapQuote } from "../../types/index.js";
import { getChainConfig } from "../../config/chains.js";
import { NATIVE_TOKEN_ADDRESS } from "../../config/constants.js";
import { x402Fetch, getApiEndpoint, isX402Mode } from "../x402/client.js";
import { loadConfig } from "../../config/pragma-config.js";

// EIP-7528 native token address format (standard for DEX aggregators)
const EIP7528_NATIVE_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Address;

// Quote expiry in milliseconds (5 minutes)
const QUOTE_EXPIRY_MS = 5 * 60 * 1000;

export interface QuoteRequest {
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

interface QuoteApiResponse {
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
  return `quote-${timestamp}-${random}`;
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
 * Convert native token address to EIP-7528 format
 * DEX aggregators expect 0xEeee... format for native tokens
 */
function toAggregatorTokenAddress(address: Address): Address {
  if (address.toLowerCase() === NATIVE_TOKEN_ADDRESS.toLowerCase()) {
    return EIP7528_NATIVE_TOKEN;
  }
  return getAddress(address);
}

/**
 * Build a CachedQuote from API response data
 */
interface QuoteBuilderParams {
  request: QuoteRequest;
  amountInWei: bigint;
  expectedOutputWei: bigint;
  minOutputWei: bigint;
  route: string[];
  gasEstimate: bigint;
  aggregator: string;
  routerAddress: Address;
  calldata: Hex;
  value: bigint;
}

function buildCachedQuote(params: QuoteBuilderParams): CachedQuote {
  const quoteId = generateQuoteId();

  return {
    quoteId,
    fromToken: {
      address: params.request.fromToken,
      symbol: params.request.fromSymbol,
      decimals: params.request.fromDecimals,
    },
    toToken: {
      address: params.request.toToken,
      symbol: params.request.toSymbol,
      decimals: params.request.toDecimals,
    },
    amountIn: formatUnits(params.amountInWei, params.request.fromDecimals),
    amountInWei: params.amountInWei,
    expectedOutput: formatUnits(params.expectedOutputWei, params.request.toDecimals),
    expectedOutputWei: params.expectedOutputWei,
    minOutput: formatUnits(params.minOutputWei, params.request.toDecimals),
    minOutputWei: params.minOutputWei,
    priceImpact: 0,
    route: params.route,
    gasEstimate: params.gasEstimate,
    expiresAt: Date.now() + QUOTE_EXPIRY_MS,
    aggregator: params.aggregator,
    aggregatorAddress: params.routerAddress,
    _calldata: params.calldata,
    _router: params.routerAddress,
    _value: params.value,
  };
}

/**
 * Extract route symbols from API response
 */
function extractRouteSymbols(
  fromSymbol: string,
  toSymbol: string,
  fills?: Array<{ source: string; proportion: string }>
): string[] {
  const route: string[] = [fromSymbol];
  if (fills && fills.length > 0) {
    for (const fill of fills) {
      if (fill.source && !route.includes(fill.source)) {
        route.push(`[${fill.source}]`);
      }
    }
  }
  route.push(toSymbol);
  return route;
}

/**
 * Fetch swap quote from aggregator
 *
 * x402 mode: All requests go through api.pr4gma.xyz (proxy handles providers)
 * BYOK mode: Uses adapter system for user-configured providers
 *
 * @param request - Quote request parameters
 * @returns SwapQuote or null if no liquidity
 * @throws Error if API fails
 */
export async function fetchQuote(request: QuoteRequest): Promise<SwapQuote | null> {
  cleanupExpiredQuotes();

  const inX402Mode = await isX402Mode();
  if (!inX402Mode) {
    return fetchQuoteByok(request);
  }

  // x402 mode: Use proxy
  const endpoint = await getApiEndpoint("quote", request.chainId);
  const chainConfig = getChainConfig(request.chainId);

  if (!chainConfig.aggregators?.router) {
    throw new Error(`Swap not supported on chain ${request.chainId}`);
  }

  // Build and execute request
  const url = new URL(endpoint.url);
  url.searchParams.set("sellToken", toAggregatorTokenAddress(request.fromToken));
  url.searchParams.set("buyToken", toAggregatorTokenAddress(request.toToken));
  url.searchParams.set("sellAmount", request.amount.toString());
  url.searchParams.set("taker", request.sender);
  url.searchParams.set("slippageBps", request.slippageBps.toString());

  const response = await x402Fetch(url.toString(), { method: "GET" });

  if (!response.ok) {
    throw new Error(`Quote API error (${response.status}): ${await response.text()}`);
  }

  const data = (await response.json()) as QuoteApiResponse;

  if (data.message) {
    throw new Error(`Quote API: ${data.message}`);
  }

  if (!data.liquidityAvailable) {
    console.log("[quote] No liquidity available for this swap");
    return null;
  }

  if (!data.transaction?.to || !data.transaction?.data) {
    throw new Error("Invalid response from quote API: missing transaction data");
  }

  const routerAddress = getAddress(data.transaction.to);
  const quote = buildCachedQuote({
    request,
    amountInWei: BigInt(data.sellAmount),
    expectedOutputWei: BigInt(data.buyAmount),
    minOutputWei: BigInt(data.minBuyAmount),
    route: extractRouteSymbols(request.fromSymbol, request.toSymbol, data.route?.fills),
    gasEstimate: BigInt(data.transaction.gas || "300000"),
    aggregator: "pragma",
    routerAddress,
    calldata: data.transaction.data as Hex,
    value: BigInt(data.transaction.value || "0"),
  });

  quoteCache.set(quote.quoteId, quote);
  return quote;
}

/**
 * Fetch quote using BYOK adapter system
 * @internal
 */
async function fetchQuoteByok(request: QuoteRequest): Promise<SwapQuote | null> {
  const { executeQuoteWithFallback } = await import("../adapters/engine.js");

  const result = await executeQuoteWithFallback({
    sellToken: toAggregatorTokenAddress(request.fromToken),
    buyToken: toAggregatorTokenAddress(request.toToken),
    sellAmount: request.amount.toString(),
    sender: request.sender,
    slippageBps: request.slippageBps,
    chainId: request.chainId,
  });

  if (!result.success || !result.data) {
    throw new Error(result.error || "Quote failed");
  }

  const data = result.data;

  if (!data.liquidityAvailable) {
    console.log("[quote] No liquidity available for this swap");
    return null;
  }

  const quote = buildCachedQuote({
    request,
    amountInWei: request.amount,
    expectedOutputWei: BigInt(data.buyAmount),
    minOutputWei: BigInt(data.minBuyAmount),
    route: [request.fromSymbol, `[${result.provider}]`, request.toSymbol],
    gasEstimate: BigInt(data.gas || "300000"),
    aggregator: result.provider,
    routerAddress: data.router,
    calldata: data.calldata,
    value: BigInt(data.value || "0"),
  });

  quoteCache.set(quote.quoteId, quote);
  return quote;
}

/**
 * Get a cached quote by ID
 */
export function getCachedQuote(quoteId: string): SwapQuote | null {
  const quote = quoteCache.get(quoteId);
  if (!quote) return null;
  if (isQuoteExpired(quote)) {
    quoteCache.delete(quoteId);
    return null;
  }
  return quote;
}

/**
 * Get execution data for a cached quote
 */
export function getQuoteExecutionData(
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
 * Get time remaining until quote expires (in seconds)
 */
export function getQuoteTimeRemaining(quote: SwapQuote): number {
  const remaining = quote.expiresAt - Date.now();
  return Math.max(0, Math.floor(remaining / 1000));
}

/**
 * Delete a quote from cache
 */
export function deleteQuote(quoteId: string): void {
  quoteCache.delete(quoteId);
}

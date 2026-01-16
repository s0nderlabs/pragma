// Get Swap Quote Tool
// Fetches swap quote from aggregator
// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createPublicClient, http, parseUnits, type Address, type PublicClient } from "viem";
import { x402HttpOptions } from "../core/x402/client.js";
import { loadConfig, isWalletConfigured, getRpcUrl } from "../config/pragma-config.js";
import { buildViemChain } from "../config/chains.js";
import { getQuote, type QuoteResult } from "../core/aggregator/index.js";
import { fetchBatchQuotes, type BatchQuoteRequest } from "../core/quote/batch.js";
import { loadVerifiedTokens, type TokenInfo } from "../config/tokens.js";
import { resolveToken as resolveTokenFromData } from "../core/data/client.js";
import { fetchTokenFromChain } from "../core/tokens/onchain.js";
import type { PragmaConfig } from "../types/index.js";

// Slippage constants
const DEFAULT_SLIPPAGE_BPS = 500; // 5% default
const MAX_SLIPPAGE_BPS = 5000; // 50% max allowed
const MAX_BATCH_SIZE = 10; // Max quotes in a single batch

// Schema for individual quote request (used in batch mode)
const SingleQuoteSchema = z.object({
  fromToken: z.string().describe("Token to sell (symbol or address)"),
  toToken: z.string().describe("Token to buy (symbol or address)"),
  amount: z.string().describe("Amount to swap"),
  slippageBps: z.number().optional().describe("Slippage in basis points"),
});

const GetSwapQuoteSchema = z
  .object({
    // Single quote params (backward compatible)
    fromToken: z
      .string()
      .optional()
      .describe("Token to sell (symbol like 'MON' or 'WMON', or address). Use for single quote."),
    toToken: z
      .string()
      .optional()
      .describe("Token to buy (symbol like 'USDC' or address). Use for single quote."),
    amount: z
      .string()
      .optional()
      .describe("Amount to swap in human-readable format (e.g., '1.5' for 1.5 tokens). Use for single quote."),
    slippageBps: z
      .number()
      .optional()
      .describe(
        "Slippage tolerance in basis points (100 = 1%, default 500 = 5%, max 5000 = 50%). Note: Some aggregators bake slippage into the quote at this stage."
      ),
    // Batch params (new)
    quotes: z
      .array(SingleQuoteSchema)
      .max(MAX_BATCH_SIZE)
      .optional()
      .describe(
        `Array of quote requests for batch mode (max ${MAX_BATCH_SIZE}). More efficient for multiple swaps.`
      ),
  })
  .refine(
    (data) => {
      const hasSingle = data.fromToken && data.toToken && data.amount;
      const hasBatch = data.quotes && data.quotes.length > 0;
      return (hasSingle && !hasBatch) || (!hasSingle && hasBatch);
    },
    {
      message:
        "Provide either (fromToken, toToken, amount) for single quote OR quotes array for batch",
    }
  );

// Response interfaces
interface SingleQuoteResponse {
  success: boolean;
  message: string;
  quote?: {
    quoteId: string;
    fromToken: string;
    toToken: string;
    amountIn: string;
    expectedOutput: string;
    minOutput: string;
    slippage: string;
    slippageBps: number;
    priceImpact: string;
    route: string[];
    expiresIn: string;
    gasEstimate: string;
    aggregator: string;
    tokenVerification: {
      fromToken: {
        verified: boolean;
        status: string;
      };
      toToken: {
        verified: boolean;
        status: string;
      };
    };
  };
  warning?: string;
  error?: string;
}

interface BatchQuoteItem {
  success: boolean;
  quoteId?: string;
  fromToken: string;
  toToken: string;
  amountIn?: string;
  expectedOutput?: string;
  minOutput?: string;
  priceImpact?: string;
  error?: string;
  retried?: number; // Number of retries if transient error occurred
}

interface BatchQuoteResponse {
  success: boolean;
  message: string;
  mode: "single" | "batch";
  summary: {
    totalRequested: number;
    totalSucceeded: number;
    totalFailed: number;
  };
  quoteIds: string[];
  quotes: BatchQuoteItem[];
  warning?: string;
}

// MARK: - Helpers

const NATIVE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

/**
 * Resolve token symbol or address to full token info
 */
async function resolveToken(input: string, chainId: number): Promise<TokenInfo | null> {
  const fromData = await resolveTokenFromData(input, chainId);
  if (fromData) return fromData;

  const normalized = input.trim();
  if (normalized.startsWith("0x") && normalized.length === 42) {
    return fetchTokenFromChain(normalized as Address, chainId);
  }

  return null;
}

/**
 * Get token verification warning if unverified
 */
function getVerificationWarning(token: TokenInfo): string | null {
  const verified = token.categories?.includes("verified") ?? false;
  if (verified) return null;

  const shortAddr = `${token.address.slice(0, 6)}...${token.address.slice(-4)}`;
  return `Warning: ${token.symbol} (${shortAddr}) is not a verified token. Please verify the contract address before swapping.`;
}

// Helper type for resolved quote request
interface ResolvedQuoteInput {
  fromToken: TokenInfo;
  toToken: TokenInfo;
  amountWei: bigint;
  slippageBps: number;
  originalAmount: string;
}

export function registerGetSwapQuote(server: McpServer): void {
  // Use innermost schema (without refinement) for MCP tool definition
  // The refinement validation happens in getSwapQuote
  const innerSchema = GetSwapQuoteSchema._def.schema;
  server.tool(
    "get_swap_quote",
    "Get a swap quote from DEX aggregator. Returns expected output, price impact, and route. Quote is valid for ~5 minutes. Always show the quote to the user before executing.",
    innerSchema.shape,
    async (params): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await getSwapQuote(params as z.infer<typeof GetSwapQuoteSchema>);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );
}

/**
 * Resolve and validate a single quote input
 */
async function resolveQuoteInput(
  fromTokenInput: string,
  toTokenInput: string,
  amountInput: string,
  slippageBps: number | undefined,
  chainId: number
): Promise<{ resolved: ResolvedQuoteInput } | { error: string }> {
  const fromToken = await resolveToken(fromTokenInput, chainId);
  if (!fromToken) {
    return { error: `Could not resolve token: ${fromTokenInput}` };
  }

  const toToken = await resolveToken(toTokenInput, chainId);
  if (!toToken) {
    return { error: `Could not resolve token: ${toTokenInput}` };
  }

  let amountWei: bigint;
  try {
    amountWei = parseUnits(amountInput, fromToken.decimals);
  } catch {
    return { error: `Could not parse amount: ${amountInput}` };
  }

  const normalizedSlippage = Math.max(
    0,
    Math.min(slippageBps ?? DEFAULT_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS)
  );

  return {
    resolved: {
      fromToken,
      toToken,
      amountWei,
      slippageBps: normalizedSlippage,
      originalAmount: amountInput,
    },
  };
}

/**
 * Execute a single quote request and format the response
 */
async function executeSingleQuote(
  input: ResolvedQuoteInput,
  walletAddress: Address,
  warnings: string[]
): Promise<SingleQuoteResponse> {
  const { fromToken, toToken, amountWei, slippageBps, originalAmount } = input;

  const quoteResult = await getQuote({
    fromToken: fromToken.address,
    toToken: toToken.address,
    amount: amountWei,
    sender: walletAddress,
    slippageBps,
    fromDecimals: fromToken.decimals,
    toDecimals: toToken.decimals,
    fromSymbol: fromToken.symbol,
    toSymbol: toToken.symbol,
  });

  const quote = quoteResult.quote;
  const fromVerified = fromToken.categories?.includes("verified") ?? false;
  const toVerified = toToken.categories?.includes("verified") ?? false;

  // Add verification warnings
  const fromWarning = getVerificationWarning(fromToken);
  const toWarning = getVerificationWarning(toToken);
  if (fromWarning) warnings.push(fromWarning);
  if (toWarning) warnings.push(toWarning);
  if (quoteResult.fallbackUsed) {
    warnings.push(
      `Note: Using fallback aggregator - ${quoteResult.fallbackReason || "Primary unavailable"}`
    );
  }

  const expiresIn = Math.max(0, Math.floor((quote.expiresAt - Date.now()) / 1000));

  return {
    success: true,
    message: `Quote for ${originalAmount} ${fromToken.symbol} → ${toToken.symbol}`,
    quote: {
      quoteId: quote.quoteId,
      fromToken: `${fromToken.symbol} (${fromToken.address.slice(0, 10)}...)`,
      toToken: `${toToken.symbol} (${toToken.address.slice(0, 10)}...)`,
      amountIn: `${quote.amountIn} ${fromToken.symbol}`,
      expectedOutput: `${quote.expectedOutput} ${toToken.symbol}`,
      minOutput: `${quote.minOutput} ${toToken.symbol}`,
      slippage: `${(slippageBps / 100).toFixed(1)}%`,
      slippageBps,
      priceImpact: `${quote.priceImpact.toFixed(2)}%`,
      route: quote.route,
      expiresIn: `${expiresIn} seconds`,
      gasEstimate: `${quote.gasEstimate.toString()} gas`,
      aggregator: quote.aggregator,
      tokenVerification: {
        fromToken: { verified: fromVerified, status: fromVerified ? "verified" : "unverified" },
        toToken: { verified: toVerified, status: toVerified ? "verified" : "unverified" },
      },
    },
    warning: warnings.length > 0 ? warnings.join(" | ") : undefined,
  };
}

/**
 * Execute batch quote requests
 */
async function executeBatchQuotes(
  quotesInput: Array<z.infer<typeof SingleQuoteSchema>>,
  walletAddress: Address,
  chainId: number,
  baseWarning?: string
): Promise<BatchQuoteResponse> {
  // Resolve all tokens first
  const resolvedInputs: Array<{
    index: number;
    input: ResolvedQuoteInput | null;
    error?: string;
    originalRequest: z.infer<typeof SingleQuoteSchema>;
  }> = [];

  for (let i = 0; i < quotesInput.length; i++) {
    const req = quotesInput[i];
    const result = await resolveQuoteInput(
      req.fromToken,
      req.toToken,
      req.amount,
      req.slippageBps,
      chainId
    );

    if ("error" in result) {
      resolvedInputs.push({
        index: i,
        input: null,
        error: result.error,
        originalRequest: req,
      });
    } else {
      resolvedInputs.push({
        index: i,
        input: result.resolved,
        originalRequest: req,
      });
    }
  }

  // Prepare batch requests for quotes that resolved successfully
  const batchRequests: BatchQuoteRequest[] = [];
  const batchIndexMap: Map<number, number> = new Map(); // maps batch index to original index

  for (const item of resolvedInputs) {
    if (item.input) {
      batchIndexMap.set(batchRequests.length, item.index);
      batchRequests.push({
        fromToken: item.input.fromToken.address,
        toToken: item.input.toToken.address,
        amount: item.input.amountWei,
        sender: walletAddress,
        slippageBps: item.input.slippageBps,
        fromDecimals: item.input.fromToken.decimals,
        toDecimals: item.input.toToken.decimals,
        fromSymbol: item.input.fromToken.symbol,
        toSymbol: item.input.toToken.symbol,
      });
    }
  }

  // Fetch batch quotes
  const batchResult = await fetchBatchQuotes(batchRequests);

  // Build response
  const quoteIds: string[] = [];
  const quotes: BatchQuoteItem[] = new Array(quotesInput.length);

  // First, fill in token resolution failures
  for (const item of resolvedInputs) {
    if (!item.input) {
      quotes[item.index] = {
        success: false,
        fromToken: item.originalRequest.fromToken,
        toToken: item.originalRequest.toToken,
        error: item.error,
      };
    }
  }

  // Then, fill in quote results
  for (let batchIdx = 0; batchIdx < batchResult.results.length; batchIdx++) {
    const result = batchResult.results[batchIdx];
    const originalIdx = batchIndexMap.get(batchIdx)!;
    const resolvedItem = resolvedInputs.find((r) => r.index === originalIdx)!;

    if (result.quote) {
      const quote = result.quote.quote;
      quoteIds.push(quote.quoteId);
      quotes[originalIdx] = {
        success: true,
        quoteId: quote.quoteId,
        fromToken: `${quote.fromToken.symbol} (${quote.fromToken.address.slice(0, 10)}...)`,
        toToken: `${quote.toToken.symbol} (${quote.toToken.address.slice(0, 10)}...)`,
        amountIn: `${quote.amountIn} ${quote.fromToken.symbol}`,
        expectedOutput: `${quote.expectedOutput} ${quote.toToken.symbol}`,
        minOutput: `${quote.minOutput} ${quote.toToken.symbol}`,
        priceImpact: `${quote.priceImpact.toFixed(2)}%`,
      };
    } else {
      quotes[originalIdx] = {
        success: false,
        fromToken: resolvedItem.originalRequest.fromToken,
        toToken: resolvedItem.originalRequest.toToken,
        error: result.error || "Quote failed",
      };
    }
  }

  // Count failures from token resolution
  const resolutionFailures = resolvedInputs.filter((r) => !r.input).length;
  const totalFailed = batchResult.totalFailed + resolutionFailures;
  const totalSucceeded = quotesInput.length - totalFailed;

  return {
    success: totalSucceeded > 0,
    message:
      totalSucceeded === quotesInput.length
        ? `All ${quotesInput.length} quotes fetched successfully`
        : `${totalSucceeded}/${quotesInput.length} quotes succeeded`,
    mode: "batch",
    summary: {
      totalRequested: quotesInput.length,
      totalSucceeded,
      totalFailed,
    },
    quoteIds,
    quotes,
    warning: baseWarning,
  };
}

/**
 * Get swap quote from aggregator (single or batch mode)
 */
async function getSwapQuote(
  params: z.infer<typeof GetSwapQuoteSchema>
): Promise<SingleQuoteResponse | BatchQuoteResponse> {
  try {
    // Validate mutual exclusivity
    const hasSingle = params.fromToken && params.toToken && params.amount;
    const hasBatch = params.quotes && params.quotes.length > 0;

    if ((hasSingle && hasBatch) || (!hasSingle && !hasBatch)) {
      return {
        success: false,
        message: "Invalid parameters",
        error:
          "Provide either (fromToken, toToken, amount) for single quote OR quotes array for batch",
      };
    }

    // Load config and verify wallet
    const config = await loadConfig();
    if (!config || !isWalletConfigured(config)) {
      return {
        success: false,
        message: "Wallet not configured",
        error: "Please run setup_wallet first to create your pragma wallet",
      };
    }

    const walletAddress = config.wallet!.smartAccountAddress as Address;
    const chainId = config.network.chainId;
    const rpcUrl = await getRpcUrl(config);

    // Load verified tokens
    await loadVerifiedTokens(chainId);

    // Route to single or batch mode
    if (hasSingle) {
      // Single quote mode (backward compatible)
      const resolved = await resolveQuoteInput(
        params.fromToken!,
        params.toToken!,
        params.amount!,
        params.slippageBps,
        chainId
      );

      if ("error" in resolved) {
        return {
          success: false,
          message: "Token resolution failed",
          error: resolved.error,
        };
      }

      const warnings: string[] = [];

      // Check native balance if swapping native token
      try {
        const chain = buildViemChain(chainId, rpcUrl);
        const client = createPublicClient({
          chain,
          transport: http(rpcUrl, x402HttpOptions(config)),
        });
        const balance = await client.getBalance({ address: walletAddress });

        if (
          resolved.resolved.fromToken.address === NATIVE_TOKEN_ADDRESS &&
          balance < resolved.resolved.amountWei
        ) {
          warnings.push(
            `Insufficient balance: you have ${(Number(balance) / 1e18).toFixed(4)} ${resolved.resolved.fromToken.symbol} but want to swap ${params.amount} ${resolved.resolved.fromToken.symbol}`
          );
        }
      } catch {
        // Balance check is optional
      }

      return await executeSingleQuote(resolved.resolved, walletAddress, warnings);
    } else {
      // Batch quote mode
      return await executeBatchQuotes(
        params.quotes!,
        walletAddress,
        chainId
      );
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return {
      success: false,
      message: errorMessage.includes("API error") ? "Quote API error" : "Failed to get quote",
      error: errorMessage,
    };
  }
}

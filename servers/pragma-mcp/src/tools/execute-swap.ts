// Execute Swap Tool
// Executes a swap using delegation framework
// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { x402HttpOptions } from "../core/x402/client.js";
import { executeBatchSwap } from "../core/execution/swap.js";
import { getCachedQuote, isQuoteExpired, getQuoteTimeRemaining } from "../core/aggregator/index.js";
import { loadConfig, isWalletConfigured, getRpcUrl } from "../config/pragma-config.js";
import { getChainConfig, buildViemChain } from "../config/chains.js";
import { isX402Mode } from "../core/x402/client.js";
import {
  getUsdcBalance,
  formatUsdcBalance,
  LOW_BALANCE_WARNING,
  isUsdcConfigured,
  getMinRequiredForOperation,
} from "../core/x402/usdc.js";

const DEFAULT_SLIPPAGE_BPS = 500;
const MAX_SLIPPAGE_BPS = 5000;

const ExecuteSwapSchema = z.object({
  quoteIds: z
    .array(z.string())
    .min(1)
    .describe("List of Quote IDs to execute. Pass multiple IDs for parallel batch execution."),
  slippageBps: z
    .number()
    .optional()
    .describe("Max slippage in basis points. NOTE: Slippage is already baked into the quote - set slippage at quote time via get_swap_quote instead."),
});

interface ExecuteSwapResult {
  success: boolean;
  message: string;
  results: Array<{
    quoteId: string;
    success: boolean;
    txHash?: string;
    explorerUrl?: string;
    error?: string;
    swap?: {
      fromToken: string;
      toToken: string;
      amountIn: string;
      amountOut: string;
    };
  }>;
  summary: {
    total: number;
    successful: number;
    failed: number;
  };
  error?: string;
}

export function registerExecuteSwap(server: McpServer): void {
  server.tool(
    "execute_swap",
    "Execute one or more swaps. Requires user confirmation via passkey (Touch ID). Handles approvals automatically. Supports parallel batch execution.",
    ExecuteSwapSchema.shape,
    async (params): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await executeSwapHandler(params as z.infer<typeof ExecuteSwapSchema>);
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
 * Execute swap handler
 */
async function executeSwapHandler(
  params: z.infer<typeof ExecuteSwapSchema>
): Promise<ExecuteSwapResult> {
  try {
    const config = await loadConfig();
    if (!config || !isWalletConfigured(config)) {
      return {
        success: false,
        message: "Wallet not configured",
        results: [],
        summary: { total: 0, successful: 0, failed: 0 },
        error: "Please run setup_wallet first to create your pragma wallet",
      };
    }

    const sessionKeyAddress = config.wallet!.sessionKeyAddress as Address;
    const chainId = config.network.chainId;

    if (config.mode === "x402") {
      if (isUsdcConfigured(chainId)) {
        const rpcUrl = await getRpcUrl(config);
        const chain = buildViemChain(chainId, rpcUrl);
        const client = createPublicClient({ 
          chain, 
          transport: http(rpcUrl, x402HttpOptions(config)) 
        });

        const usdcBalance = await getUsdcBalance(sessionKeyAddress, client as PublicClient, chainId);
        const minRequired = getMinRequiredForOperation("bundler") * BigInt(params.quoteIds.length);

        if (usdcBalance < minRequired) {
          return {
            success: false,
            message: "Insufficient USDC for x402 API calls",
            results: [],
            summary: { total: 0, successful: 0, failed: 0 },
            error:
              `Session key has ${formatUsdcBalance(usdcBalance)} but needs at least ` +
              `${formatUsdcBalance(minRequired)} for this batch operation. ` +
              `Fund your session key with USDC to continue.`,
          };
        }

        if (usdcBalance < LOW_BALANCE_WARNING) {
          console.log(`[x402] USDC balance low: ${formatUsdcBalance(usdcBalance)}`);
        }
      }
    }

    for (const quoteId of params.quoteIds) {
      const quote = await getCachedQuote(quoteId);
      if (!quote) {
        return {
          success: false,
          message: "Quote validation failed",
          results: [],
          summary: { total: 0, successful: 0, failed: 0 },
          error: `Quote ${quoteId} not found or expired. Please get a fresh quote.`,
        };
      }
      if (isQuoteExpired(quote)) {
        return {
          success: false,
          message: "Quote expired",
          results: [],
          summary: { total: 0, successful: 0, failed: 0 },
          error: `Quote ${quoteId} has expired. Please get a fresh quote.`,
        };
      }
    }

    let slippageBps = params.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
    if (slippageBps > MAX_SLIPPAGE_BPS) slippageBps = MAX_SLIPPAGE_BPS;
    if (slippageBps < 0) slippageBps = DEFAULT_SLIPPAGE_BPS;

    const batchResult = await executeBatchSwap(params.quoteIds, slippageBps);

    const chainConfig = getChainConfig(config.network.chainId);
    const explorerBase = chainConfig.blockExplorer || "https://monadvision.com";

    const formattedResults = batchResult.results.map((res) => ({
      quoteId: res.quoteId,
      success: res.success,
      txHash: res.txHash,
      explorerUrl: res.txHash ? `${explorerBase}/tx/${res.txHash}` : undefined,
      error: res.error,
      swap: res.quote ? {
        fromToken: res.quote.fromToken.symbol,
        toToken: res.quote.toToken.symbol,
        amountIn: `${res.quote.amountIn} ${res.quote.fromToken.symbol}`,
        amountOut: `${res.quote.expectedOutput} ${res.quote.toToken.symbol}`,
      } : undefined,
    }));

    const successfulCount = formattedResults.filter((r) => r.success).length;
    const failedCount = formattedResults.filter((r) => !r.success).length;

    return {
      success: successfulCount > 0,
      message: `Executed ${successfulCount}/${params.quoteIds.length} swaps`,
      results: formattedResults,
      summary: {
        total: params.quoteIds.length,
        successful: successfulCount,
        failed: failedCount,
      },
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return {
      success: false,
      message: "Batch execution failed",
      results: [],
      summary: { total: 0, successful: 0, failed: 0 },
      error: errorMessage,
    };
  }
}

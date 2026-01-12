// Execute Swap Tool
// Executes a swap using delegation framework
// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { executeSwap as executeSwapCore } from "../core/execution/swap.js";
import { getCachedQuote, isQuoteExpired, getQuoteTimeRemaining } from "../core/aggregator/index.js";
import { loadConfig, isWalletConfigured } from "../config/pragma-config.js";
import { getChainConfig } from "../config/chains.js";

// Slippage constants (matches H2)
// Monorail API ignores max_slippage param and always returns ~0.5% slippage,
// so we patch the calldata with actual slippage at execution time
const DEFAULT_SLIPPAGE_BPS = 500; // 5% default
const MAX_SLIPPAGE_BPS = 5000; // 50% max allowed

const ExecuteSwapSchema = z.object({
  quoteId: z
    .string()
    .describe("Quote ID from get_swap_quote. Required to execute the exact quoted swap."),
  slippageBps: z
    .number()
    .optional()
    .describe("Max slippage in basis points. NOTE: For 0x quotes (primary), slippage is already baked into the quote - this parameter only affects Monorail fallback quotes. Set slippage at quote time via get_swap_quote instead."),
});

interface ExecuteSwapResult {
  success: boolean;
  message: string;
  transaction?: {
    hash: string;
    explorerUrl: string;
    status: string;
    gasEstimate: string;
    delegationsUsed: number;
  };
  swap?: {
    fromToken: string;
    toToken: string;
    amountIn: string;
    amountOut: string;
    route: string[];
    aggregator: string;
  };
  error?: string;
}

export function registerExecuteSwap(server: McpServer): void {
  server.tool(
    "execute_swap",
    "Execute a previously quoted swap. Requires user confirmation via passkey (Touch ID). Uses ephemeral delegation with exact calldata enforcement for security. The quote must not be expired.",
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
    // Step 1: Verify wallet is configured
    const config = await loadConfig();
    if (!config || !isWalletConfigured(config)) {
      return {
        success: false,
        message: "Wallet not configured",
        error: "Please run setup_wallet first to create your pragma wallet",
      };
    }

    // Step 2: Verify quote exists and is valid
    const quote = await getCachedQuote(params.quoteId);
    if (!quote) {
      return {
        success: false,
        message: "Quote not found",
        error: `Quote ${params.quoteId} not found. It may have expired or never existed. Please get a fresh quote.`,
      };
    }

    if (isQuoteExpired(quote)) {
      return {
        success: false,
        message: "Quote expired",
        error: "The quote has expired. Please get a fresh quote before executing.",
      };
    }

    const timeRemaining = getQuoteTimeRemaining(quote);
    if (timeRemaining < 5) {
      return {
        success: false,
        message: "Quote about to expire",
        error: `Quote expires in ${timeRemaining} seconds. Please get a fresh quote to ensure enough time for execution.`,
      };
    }

    // Step 3: Validate and normalize slippage
    let slippageBps = params.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
    if (slippageBps > MAX_SLIPPAGE_BPS) {
      slippageBps = MAX_SLIPPAGE_BPS;
    }
    if (slippageBps < 0) {
      slippageBps = DEFAULT_SLIPPAGE_BPS;
    }

    // Step 4: Execute the swap
    // This will:
    // - Build approval delegations if needed
    // - Build swap delegation
    // - Prompt for Touch ID to sign
    // - Execute via session key
    const result = await executeSwapCore({ quoteId: params.quoteId, slippageBps });

    // Step 5: Get chain config for explorer URL
    const chainConfig = getChainConfig(config.network.chainId);
    const explorerUrl = chainConfig.blockExplorer
      ? `${chainConfig.blockExplorer}/tx/${result.txHash}`
      : `https://monadvision.com/tx/${result.txHash}`;

    // Step 6: Return success result with full details
    return {
      success: true,
      message: `Swapped ${quote.amountIn} ${quote.fromToken.symbol} → ${quote.expectedOutput} ${quote.toToken.symbol}`,
      transaction: {
        hash: result.txHash,
        explorerUrl,
        status: result.status,
        gasEstimate: quote.gasEstimate ? String(quote.gasEstimate) : "N/A",
        delegationsUsed: result.delegationsUsed,
      },
      swap: {
        fromToken: quote.fromToken.symbol,
        toToken: quote.toToken.symbol,
        amountIn: `${quote.amountIn} ${quote.fromToken.symbol}`,
        amountOut: `${quote.expectedOutput} ${quote.toToken.symbol}`,
        route: quote.route || [],
        aggregator: quote.aggregator || "unknown",
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    // Handle specific error types
    if (errorMessage.includes("Touch ID") || errorMessage.includes("authentication")) {
      return {
        success: false,
        message: "Authentication required",
        error: "Touch ID authentication was cancelled or failed. Please try again.",
      };
    }

    if (errorMessage.includes("insufficient") || errorMessage.includes("balance")) {
      return {
        success: false,
        message: "Insufficient balance",
        error: errorMessage,
      };
    }

    if (errorMessage.includes("nonce")) {
      return {
        success: false,
        message: "Nonce error",
        error: "A delegation was already used. Please get a fresh quote and try again.",
      };
    }

    if (errorMessage.includes("reverted")) {
      return {
        success: false,
        message: "Transaction reverted",
        error: `The swap transaction was reverted by the blockchain: ${errorMessage}`,
      };
    }

    return {
      success: false,
      message: "Swap execution failed",
      error: errorMessage,
    };
  }
}

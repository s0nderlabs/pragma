// nad.fun Sell Tool
// Execute sell operation on nad.fun bonding curve
// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadConfig, isWalletConfigured } from "../config/pragma-config.js";
import { executeNadFunSell } from "../core/nadfun/execution.js";
import { getCachedNadFunQuote } from "../core/nadfun/quote.js";
import { getTokenStatus } from "../core/nadfun/client.js";
import type { NadFunExecuteResponse } from "../core/nadfun/types.js";

const NadFunSellSchema = z.object({
  quoteId: z
    .string()
    .describe(
      "Quote ID from nadfun_quote for a SELL operation. " +
      "The quote must not be expired and must be a SELL direction quote."
    ),
});

export function registerNadFunSell(server: McpServer): void {
  server.tool(
    "nadfun_sell",
    "Execute a sell on nad.fun bonding curve using a quote. " +
    "Requires Touch ID confirmation (may require multiple if approval is needed). " +
    "The quote must be obtained from nadfun_quote with isBuy=false. " +
    "Make sure to check session key balance before executing.",
    NadFunSellSchema.shape,
    async (params): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await nadFunSellHandler(params as z.infer<typeof NadFunSellSchema>);
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
 * nad.fun sell handler
 */
async function nadFunSellHandler(
  params: z.infer<typeof NadFunSellSchema>
): Promise<NadFunExecuteResponse> {
  try {
    // Validate wallet is set up
    const config = await loadConfig();
    if (!config || !isWalletConfigured(config)) {
      return {
        success: false,
        message: "Wallet not configured",
        error: "Please run setup_wallet first to create your pragma wallet",
      };
    }

    const chainId = config.network.chainId;

    // Get quote to include in response
    const quote = getCachedNadFunQuote(params.quoteId);
    if (!quote) {
      return {
        success: false,
        message: "Quote not found",
        error: "Quote not found or expired. Please get a fresh quote with nadfun_quote.",
      };
    }

    // Execute the sell
    const result = await executeNadFunSell(params.quoteId);

    if (!result.success) {
      return {
        success: false,
        message: "Sell failed",
        error: result.error,
      };
    }

    // Get updated token status for progress
    let progressPercent = quote.progressPercent;
    try {
      const status = await getTokenStatus(quote.token, chainId);
      progressPercent = status.progressPercent;
    } catch {
      // Use quote's progress if fresh fetch fails
    }

    return {
      success: true,
      message: `Successfully sold ${result.tokensTraded} ${quote.tokenSymbol} for ${result.monAmount} MON`,
      transaction: {
        hash: result.txHash!,
        explorerUrl: result.explorerUrl!,
      },
      trade: {
        tokenSymbol: quote.tokenSymbol,
        tokensSold: result.tokensTraded,
        monReceived: result.monAmount,
        progress: progressPercent,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    // Handle specific errors
    if (errorMessage.includes("Session key balance")) {
      return {
        success: false,
        message: "Insufficient gas",
        error: errorMessage,
      };
    }

    if (errorMessage.includes("Touch ID") || errorMessage.includes("passkey")) {
      return {
        success: false,
        message: "Authentication failed",
        error: "Touch ID authentication was cancelled or failed. Please try again.",
      };
    }

    return {
      success: false,
      message: "Sell failed",
      error: errorMessage,
    };
  }
}

// nad.fun Quote Tool
// Get price quote for buy/sell on nad.fun bonding curve
// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getAddress, parseUnits, type Address } from "viem";
import { loadConfig, isWalletConfigured } from "../config/pragma-config.js";
import { buildNadFunQuote, getNadFunQuoteTimeRemaining } from "../core/nadfun/quote.js";
import { DEFAULT_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS } from "../core/nadfun/constants.js";
import type { NadFunQuoteResponse } from "../core/nadfun/types.js";

const NadFunQuoteSchema = z.object({
  token: z
    .string()
    .describe(
      "Token address on nad.fun bonding curve. Must be a 0x address."
    ),
  amount: z
    .string()
    .describe(
      "Amount to trade. Normal mode: input amount (MON for buy, tokens for sell). " +
      "Exact output mode: desired output amount (tokens for buy, MON for sell). " +
      "Examples: '1.5' for 1.5 units, '500' for 500 units."
    ),
  isBuy: z
    .boolean()
    .describe(
      "true = buy tokens with MON, false = sell tokens for MON"
    ),
  slippageBps: z
    .number()
    .optional()
    .describe(
      `Slippage tolerance in basis points. Default: ${DEFAULT_SLIPPAGE_BPS} (5%). Max: ${MAX_SLIPPAGE_BPS} (50%).`
    ),
  exactOutput: z
    .boolean()
    .optional()
    .describe(
      "If true, 'amount' is the desired OUTPUT (e.g., 'buy me 500 tokens'). " +
      "Calculates required input. Default: false (amount is the input)."
    ),
});

export function registerNadFunQuote(server: McpServer): void {
  server.tool(
    "nadfun_quote",
    "Get a price quote for buying or selling tokens on nad.fun bonding curve. " +
    "Returns expected output, minimum output (after slippage), and current graduation progress. " +
    "Quote is valid for 5 minutes. Use the quoteId with nadfun_buy or nadfun_sell to execute.",
    NadFunQuoteSchema.shape,
    async (params): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await nadFunQuoteHandler(params as z.infer<typeof NadFunQuoteSchema>);
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
 * nad.fun quote handler
 */
async function nadFunQuoteHandler(
  params: z.infer<typeof NadFunQuoteSchema>
): Promise<NadFunQuoteResponse> {
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

    // Validate token address format
    let tokenAddress: Address;
    try {
      tokenAddress = getAddress(params.token) as Address;
    } catch {
      return {
        success: false,
        message: "Invalid token address",
        error: "Token must be a valid 0x address",
      };
    }

    // Parse amount
    // Decimals depend on what the amount represents:
    // - Normal buy: amount is MON (18 decimals)
    // - Normal sell: amount is tokens (18 decimals)
    // - Exact output buy: amount is tokens (18 decimals)
    // - Exact output sell: amount is MON (18 decimals)
    let amountWei: bigint;
    const exactOutput = params.exactOutput ?? false;
    try {
      // All use 18 decimals (MON and typical tokens)
      amountWei = parseUnits(params.amount, 18);
    } catch {
      return {
        success: false,
        message: "Invalid amount",
        error: "Amount must be a valid number (e.g., '1.5', '1000')",
      };
    }

    if (amountWei <= 0n) {
      return {
        success: false,
        message: "Invalid amount",
        error: "Amount must be greater than 0",
      };
    }

    const chainId = config.network.chainId;
    const sender = config.wallet!.smartAccountAddress as Address;
    const slippageBps = params.slippageBps ?? DEFAULT_SLIPPAGE_BPS;

    // Build quote
    const { quote, warning } = await buildNadFunQuote({
      token: tokenAddress,
      amount: amountWei,
      isBuy: params.isBuy,
      slippageBps,
      chainId,
      sender,
      exactOutput,
    });

    // Calculate time remaining
    const timeRemaining = getNadFunQuoteTimeRemaining(quote);
    const expiresIn = timeRemaining > 60
      ? `${Math.floor(timeRemaining / 60)}m ${timeRemaining % 60}s`
      : `${timeRemaining}s`;

    // Build message
    const direction = params.isBuy ? "Buy" : "Sell";
    const inputDesc = params.isBuy ? `${quote.amountIn} MON` : `${quote.amountIn} tokens`;
    const outputDesc = params.isBuy
      ? `${quote.expectedOutput} tokens`
      : `${quote.expectedOutput} MON`;

    const message = `${direction} quote: ${inputDesc} → ${outputDesc} (min: ${quote.minOutput})`;

    return {
      success: true,
      message,
      quote: {
        quoteId: quote.quoteId,
        token: quote.token,
        tokenSymbol: quote.tokenSymbol,
        direction: quote.direction,
        amountIn: quote.amountIn,
        expectedOutput: quote.expectedOutput,
        minOutput: quote.minOutput,
        slippageBps: quote.slippageBps,
        progress: quote.progress.toString(),
        progressPercent: quote.progressPercent,
        expiresIn,
      },
      warning,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    // Handle specific errors with actionable messages
    if (errorMessage.includes("graduated")) {
      return {
        success: false,
        message: "Token has graduated",
        error: errorMessage,
      };
    }

    if (errorMessage.includes("locked")) {
      return {
        success: false,
        message: "Token is locked",
        error: errorMessage,
      };
    }

    if (errorMessage.includes("not supported on chain")) {
      return {
        success: false,
        message: "nad.fun not available",
        error: errorMessage,
      };
    }

    return {
      success: false,
      message: "Failed to get quote",
      error: errorMessage,
    };
  }
}

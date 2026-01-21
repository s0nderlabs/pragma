// nad.fun Status Tool
// Check graduation status of a token on nad.fun bonding curve
// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getAddress, type Address } from "viem";
import { loadConfig, isWalletConfigured } from "../config/pragma-config.js";
import { getTokenStatus } from "../core/nadfun/client.js";
import type { NadFunStatusResponse } from "../core/nadfun/types.js";

const NadFunStatusSchema = z.object({
  token: z
    .string()
    .describe(
      "Token address to check graduation status. Must be a 0x address. " +
      "Use this to determine whether to use nad.fun tools or regular swap tools."
    ),
});

export function registerNadFunStatus(server: McpServer): void {
  server.tool(
    "nadfun_status",
    "Check if a token has graduated from nad.fun bonding curve. " +
    "Returns graduation status, progress percentage, and trading venue. " +
    "CRITICAL: Always call this before nadfun_buy/nadfun_sell to verify the token is still on the bonding curve. " +
    "If graduated, use regular swap tools instead.",
    NadFunStatusSchema.shape,
    async (params): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await nadFunStatusHandler(params as z.infer<typeof NadFunStatusSchema>);
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
 * nad.fun status handler
 */
async function nadFunStatusHandler(
  params: z.infer<typeof NadFunStatusSchema>
): Promise<NadFunStatusResponse> {
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

    const chainId = config.network.chainId;

    // Get token status from Lens contract
    const status = await getTokenStatus(tokenAddress, chainId);

    // Build recommendation based on status
    let recommendation: string;
    if (status.isGraduated) {
      recommendation = "Token has graduated to DEX. Use regular swap tools (get_swap_quote + execute_swap).";
    } else if (status.isLocked) {
      recommendation = "Token is locked during graduation. Wait for graduation to complete before trading.";
    } else {
      recommendation = "Token is on the bonding curve. Use nad.fun tools (nadfun_quote, nadfun_buy, nadfun_sell).";
    }

    // Build message with token name if available
    const tokenLabel = status.tokenSymbol || "Token";
    let message: string;
    if (status.isGraduated) {
      message = `${tokenLabel} has graduated from nad.fun and now trades on DEX`;
    } else if (status.isLocked) {
      message = `${tokenLabel} is currently locked (graduation in progress)`;
    } else {
      message = `${tokenLabel} is on nad.fun bonding curve at ${status.progressPercent} progress`;
    }

    return {
      success: true,
      message,
      status: {
        token: status.token,
        tokenSymbol: status.tokenSymbol,
        tokenName: status.tokenName,
        isGraduated: status.isGraduated,
        isLocked: status.isLocked,
        progress: status.progress,
        progressPercent: status.progressPercent,
        availableTokens: status.availableTokens,
        requiredMon: status.requiredMon,
        tradingVenue: status.tradingVenue,
      },
      recommendation,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    // Check for common errors
    if (errorMessage.includes("not supported on chain")) {
      return {
        success: false,
        message: "nad.fun not available",
        error: errorMessage,
      };
    }

    return {
      success: false,
      message: "Failed to check token status",
      error: errorMessage,
    };
  }
}

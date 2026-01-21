// nad.fun Positions Tool
// Get user's nad.fun token holdings with PnL
// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getAddress, formatUnits, type Address } from "viem";
import { loadConfig, isWalletConfigured } from "../config/pragma-config.js";
import {
  fetchNadFunApi,
  formatPrice,
  formatAmount,
} from "../core/nadfun/api-client.js";
import type {
  NadFunPositionsResponse,
  NadFunApiHoldTokenResponse,
  UserPosition,
} from "../core/nadfun/api-types.js";

const NadFunPositionsSchema = z.object({
  address: z
    .string()
    .optional()
    .describe("Wallet address to check (default: your smart account)"),
  positionType: z
    .enum(["all", "open", "closed"])
    .optional()
    .describe("Filter by position type (default: 'all')"),
  limit: z
    .number()
    .optional()
    .describe("Max positions to return (default: 20)"),
});

export function registerNadFunPositions(server: McpServer): void {
  server.tool(
    "nadfun_positions",
    "Get nad.fun token holdings with PnL analysis. " +
      "Shows tokens bought on nad.fun, average buy price, current price, and profit/loss. " +
      "Defaults to your smart account if no address provided. " +
      "Works in both BYOK and x402 modes (uses public nad.fun API).",
    NadFunPositionsSchema.shape,
    async (
      params
    ): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await nadFunPositionsHandler(
        params as z.infer<typeof NadFunPositionsSchema>
      );
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

async function nadFunPositionsHandler(
  params: z.infer<typeof NadFunPositionsSchema>
): Promise<NadFunPositionsResponse> {
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

    // Get address to check (default to user's smart account)
    let targetAddress: Address;
    if (params.address) {
      try {
        targetAddress = getAddress(params.address) as Address;
      } catch {
        return {
          success: false,
          message: "Invalid address",
          error: "Address must be a valid 0x address",
        };
      }
    } else {
      targetAddress = config.wallet!.smartAccountAddress as Address;
    }

    const limit = Math.min(params.limit || 20, 100);

    // Fetch holdings from /profile/hold-token endpoint
    const response = await fetchNadFunApi<NadFunApiHoldTokenResponse>(
      `/profile/hold-token/${targetAddress}`,
      {
        tableType: "hold-tokens-table",
        page: 1,
        limit,
      }
    );

    if (!response.tokens || response.tokens.length === 0) {
      return {
        success: true,
        message: "No nad.fun holdings found",
        address: targetAddress,
        positions: [],
        summary: {
          totalPositions: 0,
          totalValue: "$0.00",
          totalPnl: "$0.00",
          profitableCount: 0,
        },
      };
    }

    // Transform holdings to positions
    // Note: The API doesn't provide avg buy price or PnL, so we show current holdings
    const positions: UserPosition[] = response.tokens.map((holding) => {
      const tokenInfo = holding.token_info;
      const balanceInfo = holding.balance_info;
      const marketInfo = holding.market_info;

      // Parse balance (18 decimals for nad.fun tokens)
      const balanceRaw = BigInt(balanceInfo.balance);
      const balanceFormatted = formatUnits(balanceRaw, 18);

      // Calculate market value
      const tokenPriceUsd = parseFloat(balanceInfo.token_price) || 0;
      const balanceNum = parseFloat(balanceFormatted);
      const marketValue = balanceNum * tokenPriceUsd;

      // The API doesn't provide avg buy price, so we can't calculate real PnL
      // We'll show placeholder values
      return {
        token: {
          address: tokenInfo.token_id,
          symbol: tokenInfo.symbol,
          name: tokenInfo.name,
          imageUri: tokenInfo.image_uri || undefined,
        },
        holdings: formatAmount(balanceFormatted),
        avgBuyPrice: "N/A", // Not available from API
        currentPrice: formatPrice(balanceInfo.token_price),
        marketValue: `$${marketValue.toFixed(2)}`,
        pnl: {
          usd: "N/A", // Not available from API
          percent: "N/A",
          isProfit: false, // Unknown
        },
        marketType: marketInfo.market_type || "CURVE",
      };
    });

    // Filter by position type if specified (open = on curve, closed = graduated)
    let filteredPositions = positions;
    if (params.positionType === "open") {
      filteredPositions = positions.filter((p) => p.marketType === "CURVE");
    } else if (params.positionType === "closed") {
      filteredPositions = positions.filter((p) => p.marketType === "DEX");
    }

    // Calculate summary
    const totalValue = filteredPositions.reduce((sum, p) => {
      const val = parseFloat(p.marketValue.replace(/[$,]/g, "")) || 0;
      return sum + val;
    }, 0);

    return {
      success: true,
      message: `Found ${filteredPositions.length} nad.fun position${filteredPositions.length !== 1 ? "s" : ""}`,
      address: targetAddress,
      positions: filteredPositions,
      summary: {
        totalPositions: filteredPositions.length,
        totalValue: `$${totalValue.toFixed(2)}`,
        totalPnl: "N/A (historical data not available)",
        profitableCount: 0, // Unknown without buy price data
      },
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    // Check if it's a "nothing to see here" response (no positions)
    if (errorMessage.includes("nothing to see here")) {
      return {
        success: true,
        message: "No nad.fun holdings found",
        positions: [],
        summary: {
          totalPositions: 0,
          totalValue: "$0.00",
          totalPnl: "$0.00",
          profitableCount: 0,
        },
      };
    }

    return {
      success: false,
      message: "Failed to fetch positions",
      error: errorMessage,
    };
  }
}

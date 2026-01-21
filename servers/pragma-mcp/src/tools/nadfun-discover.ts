// nad.fun Discover Tool
// Find trending/new tokens on nad.fun bonding curve
// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadConfig, isWalletConfigured } from "../config/pragma-config.js";
import {
  fetchNadFunApi,
  formatPriceChange,
  formatPrice,
} from "../core/nadfun/api-client.js";
import type {
  NadFunApiListingResponse,
  NadFunApiTokenListing,
  NadFunDiscoverResponse,
  DiscoveredToken,
} from "../core/nadfun/api-types.js";

const NadFunDiscoverSchema = z.object({
  sortBy: z
    .enum(["market_cap", "new", "active"])
    .optional()
    .describe(
      "How to sort: 'market_cap' (default), 'new' (newest), 'active' (most traded)"
    ),
  limit: z
    .number()
    .optional()
    .describe("Max tokens to return (default: 10, max: 50)"),
  page: z
    .number()
    .optional()
    .describe("Page number for pagination (default: 1)"),
  excludeGraduated: z
    .boolean()
    .optional()
    .describe(
      "If true, only show tokens still on bonding curve (default: false)"
    ),
});

export function registerNadFunDiscover(server: McpServer): void {
  server.tool(
    "nadfun_discover",
    "Find trending/new tokens on nad.fun bonding curve. " +
      "Sort by market cap, newest, or most active. " +
      "Optionally filter to only tokens still on the bonding curve. " +
      "Works in both BYOK and x402 modes (uses public nad.fun API).",
    NadFunDiscoverSchema.shape,
    async (
      params
    ): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await nadFunDiscoverHandler(
        params as z.infer<typeof NadFunDiscoverSchema>
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

const SORT_ENDPOINTS: Record<string, string> = {
  market_cap: "/order/market_cap",
  new: "/order/creation_time",
  active: "/order/latest_trade",
};

function transformTokenListing(listing: NadFunApiTokenListing): DiscoveredToken {
  return {
    address: listing.token_info.token_id,
    symbol: listing.token_info.symbol,
    name: listing.token_info.name,
    imageUri: listing.token_info.image_uri || undefined,
    isGraduated: listing.token_info.is_graduated,
    marketType: listing.market_info.market_type,
    priceUsd: formatPrice(listing.market_info.price_usd),
    priceChange: formatPriceChange(listing.percent),
    holderCount: listing.market_info.holder_count || 0,
    volume: listing.market_info.volume || undefined,
    createdAt: String(listing.token_info.created_at),
  };
}

async function nadFunDiscoverHandler(
  params: z.infer<typeof NadFunDiscoverSchema>
): Promise<NadFunDiscoverResponse> {
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

    // Get endpoint based on sortBy
    const sortBy = params.sortBy || "market_cap";
    const endpoint = SORT_ENDPOINTS[sortBy];

    // Set pagination with bounds
    const page = Math.max(params.page || 1, 1);
    const limit = Math.min(Math.max(params.limit || 10, 1), 50);

    // Fetch from nad.fun API
    const response = await fetchNadFunApi<NadFunApiListingResponse>(endpoint, {
      page,
      limit,
    });

    // Handle empty response
    if (!response.tokens || response.tokens.length === 0) {
      return {
        success: true,
        message: `No tokens found sorted by ${sortBy}`,
        tokens: [],
        totalCount: 0,
        page,
      };
    }

    // Transform tokens
    let tokens = response.tokens.map(transformTokenListing);

    // Apply excludeGraduated filter if requested
    if (params.excludeGraduated) {
      tokens = tokens.filter((t) => !t.isGraduated);
    }

    // Build message
    const sortLabels: Record<string, string> = {
      market_cap: "market cap",
      new: "creation time (newest first)",
      active: "recent activity",
    };

    return {
      success: true,
      message: `Found ${tokens.length} tokens sorted by ${sortLabels[sortBy]}${
        params.excludeGraduated ? " (bonding curve only)" : ""
      }`,
      tokens,
      totalCount: response.total_count,
      page,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    return {
      success: false,
      message: "Failed to discover tokens",
      error: errorMessage,
    };
  }
}

// nad.fun Token Info Tool
// Get detailed information about a specific nad.fun token
// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getAddress, type Address } from "viem";
import { loadConfig, isWalletConfigured } from "../config/pragma-config.js";
import {
  fetchNadFunApi,
  formatProgress,
  formatPrice,
  formatPriceChange,
} from "../core/nadfun/api-client.js";
import { getTokenStatus } from "../core/nadfun/client.js";
import type {
  NadFunApiTokenMetadataResponse,
  NadFunApiListingResponse,
  NadFunTokenInfoResponse,
  NadFunTokenFullInfo,
} from "../core/nadfun/api-types.js";

const NadFunTokenInfoSchema = z.object({
  token: z.string().describe("Token address (0x...) to get info for"),
});

export function registerNadFunTokenInfo(server: McpServer): void {
  server.tool(
    "nadfun_token_info",
    "Get detailed information about a specific nad.fun token. " +
      "Returns metadata (name, description, socials), market data (price, volume, holders), " +
      "and graduation progress if still on bonding curve. " +
      "Works in both BYOK and x402 modes (uses public nad.fun API).",
    NadFunTokenInfoSchema.shape,
    async (
      params
    ): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await nadFunTokenInfoHandler(
        params as z.infer<typeof NadFunTokenInfoSchema>
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

function buildRecommendation(isGraduated: boolean, isLocked: boolean, progress: number): string {
  if (isGraduated) {
    return "Token has graduated to DEX. Use regular swap tools (get_swap_quote + execute_swap).";
  }
  if (isLocked) {
    return "Token is locked during graduation. Wait for graduation to complete before trading.";
  }
  if (progress >= 9000) {
    return "Token is near graduation (>90% progress). Large trades may trigger graduation. Use nadfun_quote and nadfun_buy/nadfun_sell.";
  }
  return "Token is on bonding curve. Use nadfun_quote and nadfun_buy/nadfun_sell for trading.";
}

async function nadFunTokenInfoHandler(
  params: z.infer<typeof NadFunTokenInfoSchema>
): Promise<NadFunTokenInfoResponse> {
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

    // Fetch data from three sources in parallel:
    // 1. /token/{address} - metadata (description, image, socials, creator)
    // 2. getTokenStatus() - graduation status and progress from Lens contract
    // 3. /order/latest_trade - search for market data (price, volume, holders)
    const [metadataResponse, status, marketDataResponse] = await Promise.all([
      fetchNadFunApi<NadFunApiTokenMetadataResponse>(`/token/${tokenAddress}`),
      getTokenStatus(tokenAddress, config.network.chainId),
      // Fetch a large batch and search for our token
      fetchNadFunApi<NadFunApiListingResponse>("/order/latest_trade", {
        limit: 100,
      }).catch(() => null), // Don't fail if market data unavailable
    ]);

    const tokenInfo = metadataResponse.token_info;

    // Check if token was found
    if (!tokenInfo || !tokenInfo.token_id) {
      return {
        success: false,
        message: "Token not found",
        error: `Token ${tokenAddress} not found on nad.fun. It may not be a nad.fun token.`,
      };
    }

    // Search for market data in the listing response
    const marketListing = marketDataResponse?.tokens?.find(
      (t) => t.token_info.token_id.toLowerCase() === tokenAddress.toLowerCase()
    );

    // Extract creator info (API returns nested object or string)
    let creatorAddress: string | undefined;
    let creatorName: string | undefined;

    if (typeof tokenInfo.creator === "object" && tokenInfo.creator !== null) {
      creatorAddress = (tokenInfo.creator as { account_id?: string }).account_id;
      creatorName = (tokenInfo.creator as { nickname?: string }).nickname;
    } else if (typeof tokenInfo.creator === "string") {
      creatorAddress = tokenInfo.creator;
    }

    // Build full token info combining all data sources
    const fullInfo: NadFunTokenFullInfo = {
      // Metadata from /token/{address} API
      address: tokenAddress,
      symbol: tokenInfo.symbol,
      name: tokenInfo.name,
      description: tokenInfo.description || undefined,
      imageUri: tokenInfo.image_uri || undefined,
      isGraduated: status.isGraduated,
      createdAt: String(tokenInfo.created_at),
      creator: creatorAddress
        ? {
            address: creatorAddress,
            name: creatorName !== creatorAddress ? creatorName : undefined,
          }
        : undefined,
      // Socials are directly on token_info (not nested)
      socials:
        tokenInfo.twitter || tokenInfo.telegram || tokenInfo.website
          ? {
              twitter: tokenInfo.twitter || undefined,
              telegram: tokenInfo.telegram || undefined,
              website: tokenInfo.website || undefined,
            }
          : undefined,

      // Market data - prefer listing data if found, otherwise mark as unavailable
      marketType: status.isGraduated ? "DEX" : "CURVE",
      priceUsd: marketListing
        ? formatPrice(marketListing.market_info.price_usd)
        : "N/A",
      priceNative: marketListing
        ? formatPrice(marketListing.market_info.price_native)
        : "N/A",
      totalSupply: marketListing?.market_info.total_supply || undefined,
      reserveNative: marketListing?.market_info.reserve_native || undefined,
      reserveToken: marketListing?.market_info.reserve_token || undefined,
      volume: marketListing?.market_info.volume || undefined,
      athPrice: marketListing?.market_info.ath_price
        ? formatPrice(marketListing.market_info.ath_price)
        : undefined,
      holderCount: marketListing?.market_info.holder_count || 0,

      // Progress from Lens contract (only for non-graduated tokens)
      progress: !status.isGraduated ? status.progress : undefined,
      progressPercent: !status.isGraduated
        ? formatProgress(status.progress)
        : undefined,
    };

    // Add price change if available from market listing
    const priceChange = marketListing?.percent
      ? formatPriceChange(marketListing.percent)
      : undefined;

    // Build recommendation based on status
    const recommendation = buildRecommendation(status.isGraduated, status.isLocked, status.progress);

    // Build message with price info if available
    let message = `${tokenInfo.symbol} - ${tokenInfo.name}`;
    if (!status.isGraduated) {
      message += ` (${fullInfo.progressPercent} to graduation)`;
    } else {
      message += " (graduated)";
    }
    if (priceChange) {
      message += ` | ${priceChange}`;
    }

    return {
      success: true,
      message,
      token: fullInfo,
      recommendation,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    // Check if "nothing to see here" - means token doesn't exist on nad.fun
    if (errorMessage.includes("nothing to see here")) {
      return {
        success: false,
        message: "Token not found on nad.fun",
        error: `Token ${params.token} is not a nad.fun token or doesn't exist.`,
      };
    }

    return {
      success: false,
      message: "Failed to fetch token info",
      error: errorMessage,
    };
  }
}

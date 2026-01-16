// Get Token Info Tool
// Returns detailed information about a token
// Uses 3-tier resolution: static list -> Data API -> on-chain
// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Address } from "viem";
import { loadConfig, isWalletConfigured } from "../config/pragma-config.js";
import { getChainConfig } from "../config/chains.js";
import { resolveToken, getTokenPrice } from "../core/data/client.js";
import { findTokenBySymbol, findTokenByAddress } from "../config/tokens.js";
import { NATIVE_TOKEN_ADDRESS } from "../config/constants.js";

const GetTokenInfoSchema = z.object({
  token: z
    .string()
    .describe(
      "Token symbol (e.g., 'MON', 'USDC', 'WMON') or contract address (e.g., '0x123...'). " +
      "Use this to look up token details before trading or to verify token information."
    ),
});

interface GetTokenInfoResult {
  success: boolean;
  message: string;
  token?: {
    symbol: string;
    name: string;
    address: string;
    decimals: number;
    kind?: "native" | "wrappedNative" | "erc20";
    verified: boolean;
    usdPrice?: string;
    categories?: string[];
    logoURI?: string;
  };
  network?: {
    chainId: number;
    chainName: string;
  };
  error?: string;
}

export function registerGetTokenInfo(server: McpServer): void {
  server.tool(
    "get_token_info",
    "Get detailed information about a token by symbol or address. Returns symbol, name, decimals, contract address, USD price, and verification status. Use to look up token details or verify a token before trading.",
    GetTokenInfoSchema.shape,
    async (params): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await getTokenInfoHandler(params as z.infer<typeof GetTokenInfoSchema>);
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
 * Get token info handler
 */
async function getTokenInfoHandler(
  params: z.infer<typeof GetTokenInfoSchema>
): Promise<GetTokenInfoResult> {
  try {
    const config = await loadConfig();
    if (!config) {
      return {
        success: false,
        message: "Wallet not configured",
        error: "Please run setup_wallet first to configure pragma.",
      };
    }

    const chainId = config.network.chainId;
    const chainConfig = getChainConfig(chainId);

    // Check if token is in verified list (for verified flag)
    const normalized = params.token.trim();
    const isVerified = !!(
      findTokenBySymbol(normalized) ||
      (normalized.startsWith("0x") && findTokenByAddress(normalized))
    );

    // Resolve token using 3-tier system
    const tokenInfo = await resolveToken(params.token, chainId);

    if (!tokenInfo) {
      return {
        success: false,
        message: "Token not found",
        network: {
          chainId,
          chainName: chainConfig.displayName,
        },
        error: `Could not find token '${params.token}'. It may not exist on ${chainConfig.displayName} or the symbol/address is incorrect.`,
      };
    }

    // Try to get USD price (optional, continue without if fails)
    let usdPrice: number | undefined;
    try {
      usdPrice = await getTokenPrice(tokenInfo.address, chainId);
    } catch {
      // Price fetch failed, continue without
    }

    return {
      success: true,
      message: `${tokenInfo.symbol} (${tokenInfo.name})`,
      token: {
        symbol: tokenInfo.symbol,
        name: tokenInfo.name,
        address: tokenInfo.address,
        decimals: tokenInfo.decimals,
        kind: tokenInfo.kind,
        verified: isVerified,
        usdPrice: usdPrice ? `$${usdPrice.toFixed(6)}` : undefined,
        categories: tokenInfo.categories?.length ? tokenInfo.categories : undefined,
        logoURI: tokenInfo.logoURI,
      },
      network: {
        chainId,
        chainName: chainConfig.displayName,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return {
      success: false,
      message: "Failed to fetch token info",
      error: errorMessage,
    };
  }
}

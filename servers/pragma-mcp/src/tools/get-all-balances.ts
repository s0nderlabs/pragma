// Get All Balances Tool
// Fetches complete portfolio with all token balances and USD values
// Uses Monorail API + RPC for native MON
// Adapted from pragma-v2-stable (H2)
// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Address, PublicClient } from "viem";
import { createPublicClient, http, getAddress } from "viem";
import { loadConfig, isWalletConfigured } from "../config/pragma-config.js";
import { getChainConfig, buildViemChain } from "../config/chains.js";
import { getProvider } from "../core/signer/index.js";
import {
  fetchPortfolio,
  type MonorailBalancesConfig,
} from "../core/monorail/balances.js";

const GetAllBalancesSchema = z.object({
  address: z
    .string()
    .optional()
    .describe(
      "Address to fetch portfolio for. If not provided, uses user's smart account. " +
      "Use when user asks about another wallet, e.g., 'show 0x123's portfolio'."
    ),
});

interface BalanceEntry {
  symbol: string;
  balance: string;
  address: string;
  usdValue?: string;
}

interface GetAllBalancesResult {
  success: boolean;
  message: string;
  wallet?: {
    address: string;
    chainId: number;
    chainName: string;
  };
  portfolio?: {
    totalUsdValue: string;
    tokenCount: number;
    balances: BalanceEntry[];
  };
  error?: string;
}

export function registerGetAllBalances(server: McpServer): void {
  server.tool(
    "get_all_balances",
    "Get complete portfolio with all token balances and USD values. Shows total portfolio value. Use for 'show my balances', 'portfolio', 'what do I have'. For single token balance, use get_balance instead.",
    GetAllBalancesSchema.shape,
    async (params): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await getAllBalancesHandler(params as z.infer<typeof GetAllBalancesSchema>);
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
 * Get all token balances handler
 */
async function getAllBalancesHandler(
  params: z.infer<typeof GetAllBalancesSchema>
): Promise<GetAllBalancesResult> {
  try {
    // Step 1: Load config and verify wallet is set up
    const config = await loadConfig();
    if (!config || !isWalletConfigured(config)) {
      return {
        success: false,
        message: "Wallet not configured",
        error: "Please run setup_wallet first to create your pragma wallet",
      };
    }

    // Use provided address or default to user's smart account
    const targetAddress = params.address
      ? getAddress(params.address as Address)
      : (config.wallet!.smartAccountAddress as Address);

    const chainId = config.network.chainId;
    const chainConfig = getChainConfig(chainId);

    // Step 2: Get RPC provider
    const rpcUrl = (await getProvider("rpc")) || config.network.rpc;
    if (!rpcUrl) {
      return {
        success: false,
        message: "RPC not configured",
        error: "Please configure RPC provider",
      };
    }

    // Step 3: Get Monorail Data API URL
    const dataApiUrl = chainConfig.protocols?.monorailDataApi;
    if (!dataApiUrl) {
      return {
        success: false,
        message: "Monorail API not configured",
        error: "Monorail Data API not available for this chain",
      };
    }

    // Step 4: Create public client for RPC calls
    const chain = buildViemChain(chainId, rpcUrl);
    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl),
    }) as PublicClient;

    // Step 5: Fetch portfolio (Monorail API + RPC for native MON)
    const monorailConfig: MonorailBalancesConfig = {
      dataApiUrl,
      chainId,
    };

    const portfolio = await fetchPortfolio(
      targetAddress,
      monorailConfig,
      publicClient
    );

    // Step 6: Format response
    if (portfolio.tokenCount === 0) {
      return {
        success: true,
        message: "No tokens found",
        wallet: {
          address: targetAddress,
          chainId,
          chainName: chainConfig.displayName,
        },
        portfolio: {
          totalUsdValue: "$0.00",
          tokenCount: 0,
          balances: [],
        },
      };
    }

    const balances: BalanceEntry[] = portfolio.balances.map((b) => ({
      symbol: b.symbol,
      balance: b.balance,
      address: b.address,
      usdValue: b.usdValue ? `$${b.usdValue.toFixed(2)}` : undefined,
    }));

    return {
      success: true,
      message: `Fetched ${portfolio.tokenCount} token balance(s)`,
      wallet: {
        address: targetAddress,
        chainId,
        chainName: chainConfig.displayName,
      },
      portfolio: {
        totalUsdValue: `$${portfolio.totalUsdValue.toFixed(2)}`,
        tokenCount: portfolio.tokenCount,
        balances,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return {
      success: false,
      message: "Failed to fetch portfolio",
      error: errorMessage,
    };
  }
}

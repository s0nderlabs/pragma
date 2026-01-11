// Get Balance Tool
// Retrieves token balance for a specific token
// Uses Monorail API + RPC fallback for freshness
// Adapted from pragma-v2-stable (H2)
// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  createPublicClient,
  http,
  formatUnits,
  type Address,
  type PublicClient,
  getAddress,
} from "viem";
import { loadConfig, isWalletConfigured } from "../config/pragma-config.js";
import { getChainConfig, buildViemChain } from "../config/chains.js";
import { getProvider } from "../core/signer/index.js";
import { resolveToken } from "../core/monorail/tokens.js";
import { fetchSingleTokenBalance } from "../core/monorail/balances.js";

// Native token address
const NATIVE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

const GetBalanceSchema = z.object({
  token: z
    .string()
    .describe(
      "Token symbol or address to check balance for. " +
      "Examples: 'MON', 'USDC', 'WMON', or contract address '0x754704Bc...'. " +
      "CRITICAL: Call this FIRST before any swap/stake/wrap/transfer when user says 'all', 'half', 'max', 'quarter', or any percentage amount."
    ),
  address: z
    .string()
    .optional()
    .describe(
      "Address to check balance for. If not provided, uses user's smart account. " +
      "Use when user asks about another wallet, e.g., 'check 0x123's MON balance'."
    ),
});

interface GetBalanceResult {
  success: boolean;
  message: string;
  wallet?: {
    address: string;
    chainId: number;
    chainName: string;
  };
  token?: {
    symbol: string;
    address: string;
    balance: string;
    balanceWei: string;
    decimals: number;
    usdValue?: string;
    usdPrice?: string;
  };
  error?: string;
}

export function registerGetBalance(server: McpServer): void {
  server.tool(
    "get_balance",
    "Get balance for specific token with USD value. CRITICAL: Call this FIRST before any swap/stake/wrap/transfer when user says 'all', 'half', 'max', 'quarter', or any percentage amount. For full portfolio, use get_all_balances instead.",
    GetBalanceSchema.shape,
    async (params): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await getBalanceHandler(params as z.infer<typeof GetBalanceSchema>);
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
 * Get token balance handler
 */
async function getBalanceHandler(
  params: z.infer<typeof GetBalanceSchema>
): Promise<GetBalanceResult> {
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

    // Step 2: Resolve token symbol to address
    const tokenInfo = await resolveToken(params.token, chainId);
    if (!tokenInfo) {
      return {
        success: false,
        message: "Token not found",
        error: `Could not find token '${params.token}'. It may not be a valid token on Monad or the symbol is incorrect.`,
      };
    }

    // Step 3: Get RPC provider
    const rpcUrl = (await getProvider("rpc")) || config.network.rpc;
    if (!rpcUrl) {
      return {
        success: false,
        message: "RPC not configured",
        error: "Please configure RPC provider",
      };
    }

    // Step 4: Create public client
    const chain = buildViemChain(chainId, rpcUrl);
    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl),
    }) as PublicClient;

    // Step 5: Fetch balance
    // For native MON, use RPC directly (Monorail doesn't return native balance)
    const isNative = tokenInfo.address.toLowerCase() === NATIVE_TOKEN_ADDRESS.toLowerCase();

    let balance: string;
    let balanceWei: bigint;

    if (isNative) {
      // Native MON - always use RPC
      const rpcBalance = await publicClient.getBalance({ address: targetAddress });
      balanceWei = rpcBalance;
      balance = formatUnits(rpcBalance, 18);
    } else {
      // ERC20 - use RPC for accuracy
      const result = await fetchSingleTokenBalance(
        targetAddress,
        tokenInfo.address,
        publicClient
      );
      balance = result.balance;
      balanceWei = result.balanceWei;
    }

    // Step 6: Try to get USD price from Monorail
    let usdPrice: number | undefined;
    let usdValue: number | undefined;

    try {
      const dataApiUrl = chainConfig.protocols?.monorailDataApi;
      if (dataApiUrl) {
        const priceUrl = `${dataApiUrl}/token/${tokenInfo.address}`;
        const priceResp = await fetch(priceUrl);
        if (priceResp.ok) {
          const priceData = (await priceResp.json()) as { usd_per_token?: string };
          if (priceData.usd_per_token) {
            usdPrice = parseFloat(priceData.usd_per_token);
            const balanceNum = parseFloat(balance);
            usdValue = balanceNum * usdPrice;
          }
        }
      }
    } catch {
      // Price fetch failed, continue without
    }

    // Step 7: Return result
    const balanceNum = parseFloat(balance);
    if (balanceNum === 0) {
      return {
        success: true,
        message: `You have 0 ${tokenInfo.symbol}`,
        wallet: {
          address: targetAddress,
          chainId,
          chainName: chainConfig.displayName,
        },
        token: {
          symbol: tokenInfo.symbol,
          address: tokenInfo.address,
          balance: "0",
          balanceWei: "0",
          decimals: tokenInfo.decimals,
        },
      };
    }

    return {
      success: true,
      message: usdValue
        ? `You have ${balance} ${tokenInfo.symbol} ($${usdValue.toFixed(2)})`
        : `You have ${balance} ${tokenInfo.symbol}`,
      wallet: {
        address: targetAddress,
        chainId,
        chainName: chainConfig.displayName,
      },
      token: {
        symbol: tokenInfo.symbol,
        address: tokenInfo.address,
        balance,
        balanceWei: balanceWei.toString(),
        decimals: tokenInfo.decimals,
        usdValue: usdValue ? `$${usdValue.toFixed(2)}` : undefined,
        usdPrice: usdPrice ? `$${usdPrice.toFixed(6)}` : undefined,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return {
      success: false,
      message: "Failed to fetch balance",
      error: errorMessage,
    };
  }
}

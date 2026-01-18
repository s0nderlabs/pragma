// Get On-Chain Activity Tool
// Fetches transaction history for any address using HyperSync indexer
// x402 only - requires API infrastructure
// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  loadConfig,
  isWalletConfigured,
} from "../config/pragma-config.js";
import { x402Fetch, getX402BaseUrl, isX402Mode } from "../core/x402/client.js";

// ============================================================================
// Schema
// ============================================================================

const GetOnchainActivitySchema = z.object({
  address: z
    .string()
    .describe(
      "Wallet address to fetch activity for. Can be a smart account or EOA. " +
        "Example: '0x601aD0E29E9D9fCC9c9dBd81e46EEA5D9f399fa0'. " +
        "If not provided, uses the user's smart account address from config."
    )
    .optional(),
  timeRange: z
    .string()
    .optional()
    .describe(
      "Time range for activity history. Examples: '24 hours', '7 days', '30 days'. " +
        "Default: '30 days'. Maximum: depends on HyperSync indexer coverage."
    ),
  limit: z
    .number()
    .optional()
    .describe(
      "Maximum number of activities to return. Default: no limit (returns all). " +
        "Only set this if you want to limit results for a specific reason."
    ),
});

// ============================================================================
// Response Types
// ============================================================================

interface AddressInfo {
  address: string;
  name?: string;
  type?: string;
  protocol?: string;
}

interface TokenInfo {
  address: string;
  symbol: string;
  amount: string;
  amountFormatted: string;
  valueUsd?: string;
  to?: string; // Recipient address for outgoing transfers
}

interface ActivityItem {
  txHash: string;
  blockNumber: number;
  timestamp: string;
  type: string;
  typeDescription: string;

  // Token movements (arrays for multi-token swaps)
  tokensIn: TokenInfo[];
  tokensOut: TokenInfo[];

  value: string;
  valueFormatted: string;

  gasFee: string;
  gasFeeFormatted: string;

  protocol?: string;
  counterparty?: AddressInfo;
  isPragma: boolean;

  executionTarget?: AddressInfo;

  // Added by MCP tool for presentation
  explorerUrl?: string;
}

interface ActivityAddressInfo extends AddressInfo {
  type: "smart_account" | "eoa";
}

interface ActivityResponse {
  address: ActivityAddressInfo;
  activities: ActivityItem[];
  totalCount: number;
  blockRange: {
    from: number;
    to: number;
    timeRange: string;
  };
}

interface ApiResponse {
  success: boolean;
  address?: ActivityAddressInfo;
  activities?: ActivityItem[];
  totalCount?: number;
  blockRange?: {
    from: number;
    to: number;
    timeRange: string;
  };
  error?: string;
}

interface GetOnchainActivityResult {
  success: boolean;
  message: string;
  address?: ActivityAddressInfo;
  activities?: ActivityItem[];
  totalCount?: number;
  displayedCount?: number;
  blockRange?: {
    from: number;
    to: number;
    timeRange: string;
  };
  error?: string;
}

// ============================================================================
// Registration
// ============================================================================

export function registerGetOnchainActivity(server: McpServer): void {
  server.tool(
    "get_onchain_activity",
    `Fetch on-chain transaction history for any address. Returns swaps, transfers, stakes, NFT trades, and more with token movements and USD values. x402 mode only.

PRESENTATION GUIDE: Present activities as a markdown table with these columns:
| Date | Type | Details | Tx Hash | Gas |
- Order: Show most recent transactions FIRST (reverse chronological order)
- Date: Format timestamp as "Jan 16 04:29" (short month + day + time)
- Type: Use typeDescription (e.g., "Token Swap", "MON Transfer"). Add ⚡ prefix for Pragma transactions (isPragma=true)
- Details - ALWAYS format as "X  →  Y" showing what was sent and what was received/where:
  - For swaps: Use tokensIn (sent) and tokensOut (received) arrays
    - Single swap: "1 MON  →  0.5 USDC"
    - Multi-token swap: "0.4 MON  →  0.002 USDC + 0.002 USDT0 + 0.002 AUSD" (join tokensOut with " + ")
  - For MON transfers: Use valueFormatted and executionTarget.address
    - "0.5 MON  →  0xcb9e...c4f8"
  - For ERC20 transfers: Use tokensIn array with the "to" field for recipient
    - "0.062 USDC  →  0x1234...5678" (tokensIn[0].amountFormatted  →  tokensIn[0].to truncated)
  - For approvals: Show tokens being approved
    - "0.022 USDC + 0.022 USDT0 approved"
- Tx Hash: ALWAYS show the FULL 66-character transaction hash (never truncate). User needs to copy it.
- Gas: Use gasFeeFormatted (e.g., "0.04 MON")

The explorerUrl field is available if user wants to view on MonadVision.`,
    GetOnchainActivitySchema.shape,
    async (
      params
    ): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await getOnchainActivityHandler(
        params as z.infer<typeof GetOnchainActivitySchema>
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

// ============================================================================
// Handler
// ============================================================================

async function getOnchainActivityHandler(
  params: z.infer<typeof GetOnchainActivitySchema>
): Promise<GetOnchainActivityResult> {
  try {
    // Step 1: Check config
    const config = await loadConfig();
    if (!config || !isWalletConfigured(config)) {
      return {
        success: false,
        message: "Wallet not configured",
        error: "Please run setup_wallet first to create your pragma wallet",
      };
    }

    // Step 2: Verify x402 mode
    const inX402Mode = await isX402Mode();
    if (!inX402Mode) {
      return {
        success: false,
        message: "x402 mode required",
        error:
          "get_onchain_activity requires x402 mode. Run set_mode with mode='x402' first. " +
          "This tool uses HyperSync indexer infrastructure for fast historical queries.",
      };
    }

    // Step 3: Determine address to query
    const targetAddress = params.address || config.wallet?.smartAccountAddress;
    if (!targetAddress) {
      return {
        success: false,
        message: "No address provided",
        error:
          "Please provide an address to fetch activity for, or set up your wallet first.",
      };
    }

    // Validate address format
    if (!/^0x[a-fA-F0-9]{40}$/.test(targetAddress)) {
      return {
        success: false,
        message: "Invalid address",
        error:
          "Address must be 42 characters (0x + 40 hex chars). Example: 0x601aD0E29E9D9fCC9c9dBd81e46EEA5D9f399fa0",
      };
    }

    // Step 4: Build API request
    const chainId = config.network.chainId;
    const apiUrl = `${getX402BaseUrl()}/${chainId}/activity`;
    const timeRange = params.timeRange || "30 days";

    const requestBody = { address: targetAddress, timeRange };

    // Step 5: Call API with x402 payment
    const response = await x402Fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      if (response.status === 400) {
        const errorData = await response.json().catch(() => ({}));
        return {
          success: false,
          message: "Invalid request",
          error: (errorData as { error?: string }).error || `HTTP ${response.status}`,
        };
      }
      const errorText = await response.text();
      return {
        success: false,
        message: `API error (${response.status})`,
        error: errorText || `HTTP ${response.status}`,
      };
    }

    // Step 6: Parse response
    const apiResponse = (await response.json()) as ApiResponse;

    if (!apiResponse.success) {
      return {
        success: false,
        message: "Failed to fetch activity",
        error: apiResponse.error || "Unknown API error",
      };
    }

    // Step 7: Add explorer URLs and apply limit if specified
    const activities = apiResponse.activities || [];
    const explorerBaseUrl = "https://monadvision.com/tx";

    // Add explorer URL to each activity
    const activitiesWithUrls = activities.map((activity) => ({
      ...activity,
      explorerUrl: `${explorerBaseUrl}/${activity.txHash}`,
    }));

    // Apply limit only if explicitly specified
    const displayedActivities = params.limit
      ? activitiesWithUrls.slice(0, params.limit)
      : activitiesWithUrls;

    // Step 8: Build result with human-readable message
    const totalCount = apiResponse.totalCount || activities.length;
    const addressType = apiResponse.address?.type || "unknown";
    const addressName = apiResponse.address?.name;
    const truncatedAddress = `${targetAddress.slice(0, 6)}...${targetAddress.slice(-4)}`;
    const addressDisplay = addressName || truncatedAddress;
    const rangeDisplay = apiResponse.blockRange?.timeRange || timeRange;

    const txLabel = totalCount === 1 ? "transaction" : "transactions";
    const limitNote = params.limit && totalCount > params.limit
      ? `. Showing first ${params.limit}.`
      : "";
    const message = `Found ${totalCount} ${txLabel} for ${addressDisplay} (${addressType}) in last ${rangeDisplay}${limitNote}`;

    return {
      success: true,
      message,
      address: apiResponse.address,
      activities: displayedActivities,
      totalCount,
      displayedCount: displayedActivities.length,
      blockRange: apiResponse.blockRange,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    // Handle specific x402 payment errors
    if (errorMessage.includes("Payment rejected")) {
      return {
        success: false,
        message: "Payment failed",
        error:
          "x402 payment was rejected. Check your session key USDC balance with check_session_key_balance.",
      };
    }

    return {
      success: false,
      message: "Failed to fetch activity",
      error: errorMessage,
    };
  }
}

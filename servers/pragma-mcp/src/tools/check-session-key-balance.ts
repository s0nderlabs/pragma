// Check Session Key Balance Tool
// Checks session key balance to determine if funding is needed before operations
// Supports both MON (for gas) and USDC (for x402 payments)
// FREE operation (read-only, no transaction)
// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { loadConfig, isWalletConfigured, getRpcUrl } from "../config/pragma-config.js";
import { buildViemChain } from "../config/chains.js";
import { x402HttpOptions } from "../core/x402/client.js";
import {
  checkSessionKeyBalanceForOperation,
  type OperationType,
  formatSessionKeyBalance,
} from "../core/session/manager.js";
import {
  getUsdcBalance,
  formatUsdcBalance,
  isUsdcConfigured,
  MIN_USDC_BALANCE,
  LOW_BALANCE_WARNING,
  RECOMMENDED_USDC_FUNDING,
} from "../core/x402/usdc.js";
import { isX402Mode } from "../core/x402/client.js";

const CheckSessionKeyBalanceSchema = z.object({
  operationType: z
    .enum(["swap", "transfer", "wrap", "unwrap", "stake", "unstake"])
    .optional()
    .describe(
      "Type of operation to check balance for. Each operation has different gas costs: " +
        "swap=0.14 MON, transfer/wrap/unwrap=0.04 MON, stake=0.07 MON, unstake=0.075 MON"
    ),
  estimatedOperations: z
    .number()
    .optional()
    .describe(
      "Number of operations planned. Combined with operationType for accurate calculation. " +
        "Examples: 1 swap = 0.16 MON needed, 3 swaps = 0.44 MON needed"
    ),
  includeUsdc: z
    .boolean()
    .optional()
    .describe(
      "Also check USDC balance for x402 payments. Auto-enabled when x402 mode is detected. " +
        "Set to true to always include USDC info."
    ),
});

interface CheckSessionKeyBalanceResult {
  success: boolean;
  message: string;
  balance?: {
    address: string;
    current: string;
    currentWei: string;
    required: string;
    requiredWei: string;
  };
  funding?: {
    needsFunding: boolean;
    recommendedAmount: string;
    recommendedAmountWei: string;
    fundingMethod: "userOp" | "delegation";
  };
  // USDC balance for x402 payments
  usdc?: {
    balance: string;
    balanceFormatted: string;
    needsFunding: boolean;
    lowBalanceWarning: boolean;
    recommendedAmount: string;
  };
  error?: string;
}

export function registerCheckSessionKeyBalance(server: McpServer): void {
  server.tool(
    "check_session_key_balance",
    "Check if session key has enough MON for gas and USDC for x402 payments. Pass operationType and estimatedOperations for accurate calculation. Returns current balance, required amount, and whether funding is needed. USDC balance is auto-checked in x402 mode.",
    CheckSessionKeyBalanceSchema.shape,
    async (params): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await checkSessionKeyBalanceHandler(
        params as z.infer<typeof CheckSessionKeyBalanceSchema>
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

async function checkSessionKeyBalanceHandler(
  params: z.infer<typeof CheckSessionKeyBalanceSchema>
): Promise<CheckSessionKeyBalanceResult> {
  try {
    // Step 1: Load config and verify wallet
    const config = await loadConfig();
    if (!config || !isWalletConfigured(config)) {
      return {
        success: false,
        message: "Wallet not configured",
        error: "Please run setup_wallet first to create your pragma wallet",
      };
    }

    const sessionKeyAddress = config.wallet?.sessionKeyAddress as Address;
    if (!sessionKeyAddress) {
      return {
        success: false,
        message: "Session key not found",
        error: "Session key address is not configured",
      };
    }

    // Step 2: Get RPC URL (mode-aware: skips Keychain in x402 mode)
    const rpcUrl = await getRpcUrl(config);
    const chain = buildViemChain(config.network.chainId, rpcUrl);

    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl, x402HttpOptions()),
    });

    // Step 3: Check MON balance with operation context
    const balanceCheck = await checkSessionKeyBalanceForOperation(
      sessionKeyAddress,
      publicClient,
      params.operationType as OperationType | undefined,
      params.estimatedOperations
    );

    // Step 4: Check USDC balance if requested or in x402 mode
    let usdcInfo: CheckSessionKeyBalanceResult["usdc"] | undefined;
    const shouldCheckUsdc =
      params.includeUsdc === true ||
      (params.includeUsdc !== false && (await isX402Mode()));

    if (shouldCheckUsdc && isUsdcConfigured(config.network.chainId)) {
      try {
        const usdcBalance = await getUsdcBalance(
          sessionKeyAddress,
          publicClient as PublicClient,
          config.network.chainId
        );

        const needsUsdcFunding = usdcBalance < MIN_USDC_BALANCE;
        const lowBalanceWarning = usdcBalance < LOW_BALANCE_WARNING;

        usdcInfo = {
          balance: usdcBalance.toString(),
          balanceFormatted: formatUsdcBalance(usdcBalance),
          needsFunding: needsUsdcFunding,
          lowBalanceWarning,
          recommendedAmount: needsUsdcFunding
            ? formatUsdcBalance(RECOMMENDED_USDC_FUNDING)
            : "0 USDC",
        };
      } catch (error) {
        // USDC check failed, but don't fail the whole request
        console.warn("Failed to check USDC balance:", error);
      }
    }

    // Step 5: Build response
    const operationInfo =
      params.operationType && params.estimatedOperations
        ? `${params.estimatedOperations} ${params.operationType} operation(s)`
        : params.estimatedOperations
          ? `${params.estimatedOperations} operation(s)`
          : "general operations";

    // Build message including USDC status if applicable
    let message: string;
    if (balanceCheck.needsFunding) {
      message = `Session key needs MON funding for ${operationInfo}`;
    } else {
      message = `Session key has sufficient MON for ${operationInfo}`;
    }

    if (usdcInfo?.needsFunding) {
      message += `. USDC balance low (${usdcInfo.balanceFormatted}) - fund with token="USDC"`;
    } else if (usdcInfo?.lowBalanceWarning) {
      message += `. USDC balance warning: ${usdcInfo.balanceFormatted}`;
    }

    if (balanceCheck.needsFunding) {
      return {
        success: true,
        message,
        balance: {
          address: sessionKeyAddress,
          current: `${balanceCheck.balanceFormatted} MON`,
          currentWei: balanceCheck.balance.toString(),
          required: `${balanceCheck.requiredBalanceFormatted} MON`,
          requiredWei: balanceCheck.requiredBalance.toString(),
        },
        funding: {
          needsFunding: true,
          recommendedAmount: formatSessionKeyBalance(balanceCheck.recommendedFundingAmount),
          recommendedAmountWei: balanceCheck.recommendedFundingAmount.toString(),
          fundingMethod: balanceCheck.fundingMethod,
        },
        usdc: usdcInfo,
      };
    }

    return {
      success: true,
      message,
      balance: {
        address: sessionKeyAddress,
        current: `${balanceCheck.balanceFormatted} MON`,
        currentWei: balanceCheck.balance.toString(),
        required: `${balanceCheck.requiredBalanceFormatted} MON`,
        requiredWei: balanceCheck.requiredBalance.toString(),
      },
      funding: {
        needsFunding: false,
        recommendedAmount: "0 MON",
        recommendedAmountWei: "0",
        fundingMethod: balanceCheck.fundingMethod,
      },
      usdc: usdcInfo,
    };
  } catch (error) {
    return {
      success: false,
      message: "Failed to check session key balance",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

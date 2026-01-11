// Check Session Key Balance Tool
// Checks session key balance to determine if funding is needed before operations
// FREE operation (read-only, no transaction)
// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createPublicClient, http, type Address } from "viem";
import { loadConfig, isWalletConfigured } from "../config/pragma-config.js";
import { buildViemChain } from "../config/chains.js";
import { getProvider } from "../core/signer/index.js";
import {
  checkSessionKeyBalanceForOperation,
  type OperationType,
  formatSessionKeyBalance,
} from "../core/session/manager.js";

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
  error?: string;
}

export function registerCheckSessionKeyBalance(server: McpServer): void {
  server.tool(
    "check_session_key_balance",
    "Check if session key has enough MON for gas. Pass operationType and estimatedOperations for accurate calculation. Returns current balance, required amount, and whether funding is needed. Use before batch operations.",
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

    // Step 2: Get RPC and create client
    const rpcUrl = (await getProvider("rpc")) || config.network.rpc;
    const chain = buildViemChain(config.network.chainId, rpcUrl);

    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl),
    });

    // Step 3: Check balance with operation context
    const balanceCheck = await checkSessionKeyBalanceForOperation(
      sessionKeyAddress,
      publicClient,
      params.operationType as OperationType | undefined,
      params.estimatedOperations
    );

    // Step 4: Build response
    const operationInfo =
      params.operationType && params.estimatedOperations
        ? `${params.estimatedOperations} ${params.operationType} operation(s)`
        : params.estimatedOperations
          ? `${params.estimatedOperations} operation(s)`
          : "general operations";

    if (balanceCheck.needsFunding) {
      return {
        success: true,
        message: `Session key needs funding for ${operationInfo}`,
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
      };
    }

    return {
      success: true,
      message: `Session key has sufficient balance for ${operationInfo}`,
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
    };
  } catch (error) {
    return {
      success: false,
      message: "Failed to check session key balance",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

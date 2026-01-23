// Fund Session Key Tool
// Funds session key with MON (for gas) or USDC (for x402 payments) from smart account
// Supports UserOp (when session key has < 0.02 MON) and Delegation methods
// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  http,
  formatEther,
  createPublicClient,
  type Address,
  parseUnits,
} from "viem";
import {
  loadConfig,
  getBundlerUrl,
  getRpcUrl,
} from "../config/pragma-config.js";
import { buildViemChain } from "../config/chains.js";
import { createHybridDelegatorHandle } from "../core/account/hybridDelegator.js";
import {
  fundSessionKeyViaUserOp,
  fundSessionKeyViaDelegation,
  fundUsdcViaDelegation,
} from "../core/execution/sessionKeyFunding.js";
import {
  checkSessionKeyBalanceForOperation,
  type OperationType,
} from "../core/session/manager.js";
import { x402HttpOptions } from "../core/x402/client.js";

const FundSessionKeySchema = z.object({
  operationType: z
    .enum(["swap", "transfer", "wrap", "unwrap", "stake", "unstake"])
    .optional()
    .describe("Type of operation to fund for. IMPORTANT: Always specify this for accurate gas calculation! " +
        "Each operation has different gas costs: swap=0.14 MON, transfer/wrap/unwrap=0.04 MON, stake=0.07 MON"),
  estimatedOperations: z
    .number()
    .optional()
    .describe("Number of operations planned. Combined with operationType for accurate calculation. " +
        "Examples: 1 swap = 0.16 MON needed, 3 swaps = 0.44 MON needed"),
  token: z
    .enum(["MON", "USDC"])
    .optional()
    .describe("Token to fund session key with. MON for gas (default), USDC for x402 payments. " +
        "USDC funding requires specifying amount."),
  amount: z
    .string()
    .optional()
    .describe("Amount to fund (e.g., '10' for 10 MON or 10 USDC). If not specified for MON, uses intelligent calculation based on operations."),
});

interface ToolResponse {
  success: boolean;
  message: string;
  funding?: {
    token: string;
    method: "userOp" | "delegation";
    fundedAmount: string;
    fundedAmountWei: string;
    newBalance: string;
    newBalanceWei: string;
    txHash: string;
  };
  error?: string;
}

export function registerFundSessionKey(server: McpServer): void {
  server.tool(
    "fund_session_key",
    "Fund session key with MON (for gas) or USDC (for x402 payments) from smart account. " +
      "Supports UserOp (when session key has < 0.02 MON) and Delegation methods. " +
      "Pass operationType for MON, token='USDC' with amount for x402. " +
      "Requires Touch ID confirmation.",
    FundSessionKeySchema.shape,
    async (params): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await fundSessionKeyHandler(
        params as z.infer<typeof FundSessionKeySchema>
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );
}

async function fundSessionKeyHandler(
  params: z.infer<typeof FundSessionKeySchema>
): Promise<ToolResponse> {
  try {
    const config = await loadConfig();
    if (!config?.wallet) {
      return {
        success: false,
        message: "Wallet not configured",
        error: "Please run setup_wallet first to create your pragma wallet",
      };
    }

    const sessionKeyAddress = config.wallet.sessionKeyAddress as Address;
    const chainId = config.network.chainId;

    const rpcUrl = await getRpcUrl(config);
    const chain = buildViemChain(chainId, rpcUrl);
    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl, x402HttpOptions(config)),
    });

    // Handle USDC funding path
    if (params.token === "USDC") {
      if (!params.amount) {
        return {
          success: false,
          message: "Amount required for USDC funding",
          error: "Please specify the amount of USDC to fund (e.g., amount: '1.0')",
        };
      }

      const fundingAmountUnits = parseUnits(params.amount, 6);
      const touchIdMessage = `Fund session key with ${params.amount} USDC (delegation)`;
      const handle = await createHybridDelegatorHandle(config, { touchIdMessage });

      const result = await fundUsdcViaDelegation({
        handle,
        sessionKeyAddress,
        publicClient,
        config,
        fundingAmount: fundingAmountUnits,
      });

      return {
        success: true,
        message: `Session key funded with ${params.amount} USDC via delegation`,
        funding: {
          token: "USDC",
          method: "delegation",
          fundedAmount: `${params.amount} USDC`,
          fundedAmountWei: fundingAmountUnits.toString(),
          newBalance: "unknown",
          newBalanceWei: "0",
          txHash: result.transactionHash || "0x",
        },
      };
    }

    // Default MON funding path
    const balanceCheck = await checkSessionKeyBalanceForOperation(
      sessionKeyAddress,
      publicClient,
      params.operationType as OperationType,
      params.estimatedOperations
    );

    // If user specified a custom amount, use that instead of calculated amount
    // Otherwise, check if funding is needed based on operations
    const hasCustomAmount = params.amount && params.amount.trim() !== "";

    if (!hasCustomAmount && !balanceCheck.needsFunding) {
      return {
        success: true,
        message: "Session key already has sufficient balance",
        funding: {
          token: "MON",
          method: balanceCheck.fundingMethod,
          fundedAmount: "0 MON",
          fundedAmountWei: "0",
          newBalance: balanceCheck.balanceFormatted,
          newBalanceWei: balanceCheck.balance.toString(),
          txHash: "0x",
        },
      };
    }

    // Use custom amount if specified, otherwise use calculated recommendation
    const fundingAmount = hasCustomAmount
      ? parseUnits(params.amount!, 18)
      : balanceCheck.recommendedFundingAmount;
    const fundingMethod = balanceCheck.fundingMethod;
    const touchIdMessage = `Fund session key: ${formatEther(fundingAmount)} MON (${fundingMethod})`;

    const handle = await createHybridDelegatorHandle(config, { touchIdMessage });

    let executionResult;

    if (fundingMethod === "delegation") {
      executionResult = await fundSessionKeyViaDelegation({
        handle,
        sessionKeyAddress,
        publicClient,
        config,
        fundingAmount,
      });
    } else {
      executionResult = await fundSessionKeyViaUserOp({
        handle,
        sessionKeyAddress,
        publicClient,
        config,
        bundlerUrl: await getBundlerUrl(config),
        fundingAmount,
      });
    }

    return {
      success: true,
      message: `Session key funded with ${formatEther(executionResult.fundedAmount)} MON via ${fundingMethod}`,
      funding: {
        token: "MON",
        method: fundingMethod,
        fundedAmount: `${formatEther(executionResult.fundedAmount)} MON`,
        fundedAmountWei: executionResult.fundedAmount.toString(),
        newBalance: `${formatEther(executionResult.newBalance)} MON`,
        newBalanceWei: executionResult.newBalance.toString(),
        txHash: executionResult.transactionHash || executionResult.userOpHash,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return {
      success: false,
      message: "Session key funding failed",
      error: errorMessage,
    };
  }
}

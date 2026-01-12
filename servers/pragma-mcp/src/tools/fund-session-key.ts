// Fund Session Key Tool
// Funds session key with MON from smart account for gas
// Uses UserOp when session key has < 0.02 MON (bundler pays gas)
// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createPublicClient, http, formatEther, type Address, type PublicClient } from "viem";
import { loadConfig, isWalletConfigured, getBundlerUrlAsync } from "../config/pragma-config.js";
import { buildViemChain } from "../config/chains.js";
import { getProvider } from "../core/signer/index.js";
import { createHybridDelegatorHandle } from "../core/account/hybridDelegator.js";
import { fundSessionKeyViaUserOp } from "../core/execution/sessionKeyFunding.js";
import {
  checkSessionKeyBalanceForOperation,
  estimateGasForOperations,
  calculateFundingAmount,
  type OperationType,
  SESSION_KEY_FUNDING_AMOUNT,
  MIN_GAS_FOR_DELEGATION,
} from "../core/session/manager.js";

const FundSessionKeySchema = z.object({
  operationType: z
    .enum(["swap", "transfer", "wrap", "unwrap", "stake", "unstake"])
    .optional()
    .describe(
      "Type of operation to fund for. IMPORTANT: Always specify this for accurate gas calculation! " +
        "Each operation has different gas costs: swap=0.14 MON, transfer/wrap/unwrap=0.04 MON, stake=0.07 MON"
    ),
  estimatedOperations: z
    .number()
    .optional()
    .describe(
      "Number of operations planned. Combined with operationType for accurate calculation. " +
        "Examples: 1 swap = 0.16 MON needed, 3 swaps = 0.44 MON needed"
    ),
});

interface FundSessionKeyResult {
  success: boolean;
  message: string;
  funding?: {
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
    "Fund session key with MON from smart account for gas. Pass operationType and estimatedOperations for accurate calculation. Use when check_session_key_balance shows needsFunding=true.",
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
    }
  );
}

async function fundSessionKeyHandler(
  params: z.infer<typeof FundSessionKeySchema>
): Promise<FundSessionKeyResult> {
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
    const smartAccountAddress = config.wallet?.smartAccountAddress as Address;

    if (!sessionKeyAddress || !smartAccountAddress) {
      return {
        success: false,
        message: "Session key or smart account not found",
        error: "Wallet addresses are not configured",
      };
    }

    // Step 2: Get RPC and bundler URL
    const rpcUrl = (await getProvider("rpc")) || config.network.rpc;
    const chain = buildViemChain(config.network.chainId, rpcUrl);

    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl),
    });

    const bundlerUrl = await getBundlerUrlAsync(config);
    if (!bundlerUrl) {
      return {
        success: false,
        message: "Bundler URL not configured",
        error:
          "Pimlico API key is required for session key funding. " +
          "Please run /providers to configure your Pimlico API key.",
      };
    }

    // Step 3: Check current balance
    const balanceCheck = await checkSessionKeyBalanceForOperation(
      sessionKeyAddress,
      publicClient,
      params.operationType as OperationType | undefined,
      params.estimatedOperations
    );

    // Check if funding is actually needed
    if (!balanceCheck.needsFunding) {
      return {
        success: true,
        message: "Session key already has sufficient balance",
        funding: {
          method: balanceCheck.fundingMethod,
          fundedAmount: "0 MON",
          fundedAmountWei: "0",
          newBalance: `${balanceCheck.balanceFormatted} MON`,
          newBalanceWei: balanceCheck.balance.toString(),
          txHash: "0x",
        },
      };
    }

    // Step 4: Check smart account balance
    const smartAccountBalance = await publicClient.getBalance({
      address: smartAccountAddress,
    });

    // Calculate funding amount
    let fundingAmount: bigint;

    if (params.operationType && params.estimatedOperations && params.estimatedOperations > 0) {
      const operations: OperationType[] = Array(params.estimatedOperations).fill(params.operationType);
      const requiredBalance = estimateGasForOperations(operations);
      fundingAmount = calculateFundingAmount(balanceCheck.balance, requiredBalance);
    } else if (params.estimatedOperations && params.estimatedOperations > 0) {
      // Use default funding amount for estimated operations
      fundingAmount = SESSION_KEY_FUNDING_AMOUNT;
    } else {
      fundingAmount = SESSION_KEY_FUNDING_AMOUNT;
    }

    if (smartAccountBalance < fundingAmount) {
      return {
        success: false,
        message: "Insufficient smart account balance",
        error:
          `Smart account has ${formatEther(smartAccountBalance)} MON but needs ` +
          `${formatEther(fundingAmount)} MON for session key funding. ` +
          `Please add more MON to your smart account.`,
      };
    }

    // Step 5: Determine funding method and execute
    // For now, we only support UserOp-based funding (P-256 passkey signing)
    // Delegation-based funding would require session key to have gas already

    const fundingMethod = balanceCheck.balance < MIN_GAS_FOR_DELEGATION ? "userOp" : "delegation";

    // Create descriptive Touch ID message
    const fundingAmountFormatted = formatEther(fundingAmount);
    const touchIdMessage = `Fund session key: ${fundingAmountFormatted} MON (${fundingMethod})`;

    // Create handle for P-256 signing with custom Touch ID message
    const handle = await createHybridDelegatorHandle(config, { touchIdMessage });

    // Fund session key via UserOp (triggers Touch ID)
    const result = await fundSessionKeyViaUserOp({
      handle,
      sessionKeyAddress,
      publicClient: publicClient as PublicClient,
      bundlerUrl,
      fundingAmount,
    });

    return {
      success: true,
      message: `Session key funded with ${formatEther(result.fundedAmount)} MON via ${fundingMethod}`,
      funding: {
        method: fundingMethod,
        fundedAmount: `${formatEther(result.fundedAmount)} MON`,
        fundedAmountWei: result.fundedAmount.toString(),
        newBalance: `${formatEther(result.newBalance)} MON`,
        newBalanceWei: result.newBalance.toString(),
        txHash: result.transactionHash || result.userOpHash,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    // Handle specific error types
    if (errorMessage.includes("Touch ID") || errorMessage.includes("authentication")) {
      return {
        success: false,
        message: "Authentication required",
        error: "Touch ID authentication was cancelled or failed. Please try again.",
      };
    }

    return {
      success: false,
      message: "Failed to fund session key",
      error: errorMessage,
    };
  }
}

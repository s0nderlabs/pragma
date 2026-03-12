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
  encodeFunctionData,
  type Address,
  parseUnits,
} from "viem";
import {
  loadConfig,
  saveConfig,
  getBundlerUrl,
  getRpcUrl,
} from "../config/pragma-config.js";
import { registerAgentInSetup, type SetupRegistrationResult } from "../core/identity/erc8004.js";
import type { PragmaConfig } from "../types/index.js";
import { buildViemChain, getChainConfig } from "../config/chains.js";
import { createHybridDelegatorHandle } from "../core/account/hybridDelegator.js";
import {
  fundSessionKeyViaUserOp,
  fundSessionKeyViaDelegation,
  fundUsdcViaDelegation,
} from "../core/execution/sessionKeyFunding.js";
import { executeHeadless } from "../core/execution/headless.js";
import { isFileMode } from "../core/signer/index.js";
import {
  checkSessionKeyBalanceForOperation,
  type OperationType,
} from "../core/session/manager.js";
import { x402HttpOptions } from "../core/x402/client.js";
import { USDC_ADDRESS, USDC_DECIMALS } from "../core/x402/usdc.js";

const FundSessionKeySchema = z.object({
  operationType: z
    .enum(["swap", "transfer", "wrap", "unwrap"])
    .optional()
    .describe("Type of operation to fund for. IMPORTANT: Always specify this for accurate gas calculation! " +
        "Each operation has different gas costs: swap=0.14 MON, transfer/wrap/unwrap=0.04 MON"),
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
  identity?: {
    agentId?: string;
    registrationStatus: SetupRegistrationResult["status"];
  };
  error?: string;
}

/**
 * Best-effort ERC-8004 identity registration after MON funding.
 * If agentId already in config, returns immediately (no RPC).
 * Never throws — registration failure doesn't affect funding.
 * Mutates config.wallet.agentId and persists on successful registration.
 */
async function maybeRegisterAgent(
  config: PragmaConfig,
  chainId: number,
): Promise<{ agentId?: string; registrationStatus: SetupRegistrationResult["status"] }> {
  if (config.wallet?.agentId) {
    return { agentId: config.wallet.agentId, registrationStatus: "already_registered" };
  }
  try {
    const result = await registerAgentInSetup(config, chainId);
    if (result.tokenId) {
      const agentId = result.tokenId.toString();
      config.wallet!.agentId = agentId;
      await saveConfig(config);
      return { agentId, registrationStatus: result.status };
    }
    return { registrationStatus: result.status };
  } catch {
    return { registrationStatus: "failed" };
  }
}

export function registerFundSessionKey(server: McpServer): void {
  server.tool(
    "fund_session_key",
    "Fund session key with MON (for gas) or USDC (for x402 payments) from smart account. " +
      "Supports UserOp (when session key has < 0.02 MON) and Delegation methods. " +
      "Pass operationType for MON, token='USDC' with amount for x402. " +
      "On macOS: requires Touch ID. On headless/OpenClaw: uses root delegation automatically.",
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

    // HEADLESS: OpenClaw path — use root delegation, no Touch ID
    if (isFileMode()) {
      return fundSessionKeyHeadless(params, config, sessionKeyAddress, chainId);
    }

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

    // Best-effort identity registration after MON funding
    const identity = await maybeRegisterAgent(config, chainId);

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
      identity,
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

// ============================================================================
// Headless Funding (OpenClaw / Linux)
// ============================================================================

/**
 * Fund session key using root delegation (headless mode).
 * Uses Group 3 (NATIVE_TRANSFER) for MON and Group 2 (ERC20_TRANSFER) for USDC.
 * Requires session key to already have some gas to submit the transaction.
 */
async function fundSessionKeyHeadless(
  params: z.infer<typeof FundSessionKeySchema>,
  config: Awaited<ReturnType<typeof loadConfig>>,
  sessionKeyAddress: Address,
  chainId: number,
): Promise<ToolResponse> {
  try {
    const chainConfig = getChainConfig(chainId);
    const rpcUrl = await getRpcUrl(config!);
    const chain = buildViemChain(chainId, rpcUrl);
    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl, x402HttpOptions(config!)),
    });

    // USDC funding path
    if (params.token === "USDC") {
      if (!params.amount) {
        return {
          success: false,
          message: "Amount required for USDC funding",
          error: "Please specify the amount of USDC to fund (e.g., amount: '1.0')",
        };
      }

      const usdcAddress = USDC_ADDRESS[chainId];
      if (!usdcAddress) {
        return { success: false, message: "USDC not configured", error: `USDC not found for chain ${chainId}` };
      }

      const fundingAmountUnits = parseUnits(params.amount, USDC_DECIMALS);
      const callData = encodeFunctionData({
        abi: [{
          type: "function", name: "transfer", stateMutability: "nonpayable",
          inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
          outputs: [{ name: "", type: "bool" }],
        }],
        functionName: "transfer",
        args: [sessionKeyAddress, fundingAmountUnits],
      });

      const result = await executeHeadless(
        { target: usdcAddress as Address, value: 0n, callData: callData as `0x${string}` },
        config!,
      );

      if (!result.success) {
        return { success: false, message: "USDC funding failed", error: result.error };
      }

      return {
        success: true,
        message: `Session key funded with ${params.amount} USDC via delegation (headless)`,
        funding: {
          token: "USDC",
          method: "delegation",
          fundedAmount: `${params.amount} USDC`,
          fundedAmountWei: fundingAmountUnits.toString(),
          newBalance: "unknown",
          newBalanceWei: "0",
          txHash: result.txHash || "0x",
        },
      };
    }

    // MON funding path
    const balanceCheck = await checkSessionKeyBalanceForOperation(
      sessionKeyAddress,
      publicClient,
      params.operationType as OperationType,
      params.estimatedOperations,
    );

    const hasCustomAmount = params.amount && params.amount.trim() !== "";

    if (!hasCustomAmount && !balanceCheck.needsFunding) {
      return {
        success: true,
        message: "Session key already has sufficient balance",
        funding: {
          token: "MON",
          method: "delegation",
          fundedAmount: "0 MON",
          fundedAmountWei: "0",
          newBalance: balanceCheck.balanceFormatted,
          newBalanceWei: balanceCheck.balance.toString(),
          txHash: "0x",
        },
      };
    }

    const fundingAmount = hasCustomAmount
      ? parseUnits(params.amount!, 18)
      : balanceCheck.recommendedFundingAmount;

    // Native MON transfer: SA → session key via delegation Group 3
    const result = await executeHeadless(
      { target: sessionKeyAddress, value: fundingAmount, callData: "0x" as `0x${string}` },
      config!,
    );

    if (!result.success) {
      return { success: false, message: "MON funding failed", error: result.error };
    }

    // Get updated balance
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const newBalance = await publicClient.getBalance({ address: sessionKeyAddress });

    // Best-effort identity registration after MON funding
    const identity = await maybeRegisterAgent(config!, chainId);

    return {
      success: true,
      message: `Session key funded with ${formatEther(fundingAmount)} MON via delegation (headless)`,
      funding: {
        token: "MON",
        method: "delegation",
        fundedAmount: `${formatEther(fundingAmount)} MON`,
        fundedAmountWei: fundingAmount.toString(),
        newBalance: `${formatEther(newBalance)} MON`,
        newBalanceWei: newBalance.toString(),
        txHash: result.txHash || "0x",
      },
      identity,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return {
      success: false,
      message: "Session key funding failed (headless)",
      error: errorMessage,
    };
  }
}

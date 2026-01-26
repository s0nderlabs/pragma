// Revoke Sub-Agent Tool
// Revokes a sub-agent's delegation, sweeps balance, and returns wallet to pool
// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  formatEther,
  http,
  createPublicClient,
  createWalletClient,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig, getRpcUrl } from "../config/pragma-config.js";
import { buildViemChain } from "../config/chains.js";
import { x402HttpOptions } from "../core/x402/client.js";
import {
  loadAgentState,
  updateAgentState,
  getFullWallet,
  releaseWallet,
} from "../core/subagent/index.js";

const RevokeSubAgentSchema = z.object({
  subAgentId: z.string().describe("The sub-agent ID (UUID) to revoke"),
  sweepBalance: z
    .boolean()
    .default(true)
    .describe(
      "Sweep remaining gas balance back to session key. Default: true"
    ),
});

interface RevokeSubAgentResult {
  success: boolean;
  message: string;
  revocation?: {
    subAgentId: string;
    previousStatus: string;
    balanceSwept: string;
    sweepTxHash?: string;
    walletReturnedToPool: boolean;
  };
  error?: string;
}

export function registerRevokeSubAgent(server: McpServer): void {
  server.tool(
    "revoke_sub_agent",
    "Revoke a sub-agent's delegation, optionally sweep its balance back to session key, " +
      "and return its wallet to the pool for reuse. " +
      "Use this to stop an autonomous agent and reclaim its resources. " +
      "DTK automatically invalidates sub-delegations when parent is revoked.",
    RevokeSubAgentSchema.shape,
    async (
      params
    ): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await revokeSubAgentHandler(
        params as z.infer<typeof RevokeSubAgentSchema>
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}

async function revokeSubAgentHandler(
  params: z.infer<typeof RevokeSubAgentSchema>
): Promise<RevokeSubAgentResult> {
  try {
    const config = await loadConfig();
    if (!config?.wallet) {
      return {
        success: false,
        message: "Wallet not configured",
        error: "Please run setup_wallet first",
      };
    }

    // Load sub-agent state
    const state = await loadAgentState(params.subAgentId);
    if (!state) {
      return {
        success: false,
        message: "Sub-agent not found",
        error: `No sub-agent found with ID: ${params.subAgentId}`,
      };
    }

    const previousStatus = state.status;

    // Check if already revoked
    if (state.status === "revoked") {
      return {
        success: false,
        message: "Sub-agent already revoked",
        error: "This sub-agent has already been revoked",
      };
    }

    // Get sub-agent wallet
    const subAgentWallet = await getFullWallet(state.walletId);
    if (!subAgentWallet) {
      // Wallet not found but state exists - just update status
      await updateAgentState(params.subAgentId, { status: "revoked" });
      return {
        success: true,
        message: "Sub-agent revoked (wallet not found)",
        revocation: {
          subAgentId: params.subAgentId,
          previousStatus,
          balanceSwept: "0 MON",
          walletReturnedToPool: false,
        },
      };
    }

    // Get clients
    const chainId = config.network.chainId;
    const rpcUrl = await getRpcUrl(config);
    const chain = buildViemChain(chainId, rpcUrl);

    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl, x402HttpOptions(config)),
    });

    let balanceSwept = 0n;
    let sweepTxHash: string | undefined;

    // Sweep balance if requested
    if (params.sweepBalance && subAgentWallet.privateKey) {
      const balance = await publicClient.getBalance({
        address: subAgentWallet.address as Address,
      });

      if (balance > 0n) {
        // Get sub-agent account for signing
        const subAgentAccount = privateKeyToAccount(
          subAgentWallet.privateKey as `0x${string}`
        );

        const walletClient = createWalletClient({
          account: subAgentAccount,
          chain,
          transport: http(rpcUrl, x402HttpOptions(config)),
        });

        // Estimate gas for transfer
        const gasPrice = await publicClient.getGasPrice();
        const gasLimit = 21000n; // Standard transfer
        const gasCost = gasPrice * gasLimit;

        // Only sweep if balance exceeds gas cost
        if (balance > gasCost) {
          const sweepAmount = balance - gasCost;

          try {
            sweepTxHash = await walletClient.sendTransaction({
              to: config.wallet.sessionKeyAddress as Address,
              value: sweepAmount,
            });

            // Wait for confirmation
            await publicClient.waitForTransactionReceipt({
              hash: sweepTxHash as `0x${string}`,
            });

            balanceSwept = sweepAmount;
          } catch (sweepError) {
            // Log but don't fail - wallet can still be released
            console.error("Failed to sweep balance:", sweepError);
          }
        }
      }
    }

    // Update agent status to revoked
    await updateAgentState(params.subAgentId, { status: "revoked" });

    // Release wallet back to pool
    await releaseWallet(state.walletId);

    return {
      success: true,
      message: `Revoked sub-agent ${state.agentType}`,
      revocation: {
        subAgentId: params.subAgentId,
        previousStatus,
        balanceSwept: formatEther(balanceSwept) + " MON",
        sweepTxHash,
        walletReturnedToPool: true,
      },
    };
  } catch (error) {
    return {
      success: false,
      message: "Failed to revoke sub-agent",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

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
  deleteAgentState,
  listAgentStates,
  getFullWallet,
  releaseWallet,
} from "../core/subagent/index.js";
import { withRetry } from "../core/utils/retry.js";
import { stopCaffeinate } from "../core/utils/caffeinate.js";

const RevokeSubAgentSchema = z.object({
  subAgentId: z.string().describe("The sub-agent ID (UUID) to revoke"),
  sweepBalance: z
    .boolean()
    .default(false)
    .describe(
      "Sweep remaining gas balance back to session key. " +
        "Default: false (gas stays in wallet for reuse by future agents)"
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
      "For on-chain invalidation, use revoke_root_delegation with revocationMode: 'onchain' " +
      "which cascades to ALL sub-delegations via NonceEnforcer nonce increment.",
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

    const state = await loadAgentState(params.subAgentId);
    if (!state) {
      return {
        success: false,
        message: "Sub-agent not found",
        error: `No sub-agent found with ID: ${params.subAgentId}`,
      };
    }

    const previousStatus = state.status;

    if (state.status === "revoked") {
      return {
        success: false,
        message: "Sub-agent already revoked",
        error: "This sub-agent has already been revoked",
      };
    }

    const subAgentWallet = await getFullWallet(state.walletId);
    if (!subAgentWallet) {
      try {
        await releaseWallet(state.walletId);
      } catch {
        // Ignore: pool entry may not exist
      }
      await deleteAgentState(params.subAgentId);

      return {
        success: true,
        message: "Sub-agent cleaned up (wallet not found in Keychain)",
        revocation: {
          subAgentId: params.subAgentId,
          previousStatus,
          balanceSwept: "0 MON",
          walletReturnedToPool: true,
        },
      };
    }

    const chainId = config.network.chainId;
    const rpcUrl = await getRpcUrl(config);
    const chain = buildViemChain(chainId, rpcUrl);

    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl, x402HttpOptions(config)),
    });

    let balanceSwept = 0n;
    let sweepTxHash: string | undefined;

    if (params.sweepBalance && subAgentWallet.privateKey) {
      const balanceResult = await withRetry(
        async () => publicClient.getBalance({ address: subAgentWallet.address as Address }),
        { operationName: "check-subagent-balance" }
      );
      const balance = balanceResult.success ? (balanceResult.data ?? 0n) : 0n;

      if (balance > 0n) {
        const gasPriceResult = await withRetry(
          async () => publicClient.getGasPrice(),
          { operationName: "get-gas-price" }
        );
        const gasPrice = gasPriceResult.success ? (gasPriceResult.data ?? 0n) : 0n;
        const gasCost = gasPrice * 21000n;

        if (balance > gasCost) {
          const subAgentAccount = privateKeyToAccount(
            subAgentWallet.privateKey as `0x${string}`
          );

          const walletClient = createWalletClient({
            account: subAgentAccount,
            chain,
            transport: http(rpcUrl, x402HttpOptions(config)),
          });

          const sweepAmount = balance - gasCost;

          try {
            sweepTxHash = await walletClient.sendTransaction({
              to: config.wallet.sessionKeyAddress as Address,
              value: sweepAmount,
            });

            await publicClient.waitForTransactionReceipt({
              hash: sweepTxHash as `0x${string}`,
            });

            balanceSwept = sweepAmount;
          } catch (sweepError) {
            console.error("Failed to sweep balance:", sweepError);
          }
        }
      }
    }

    await releaseWallet(state.walletId);
    await deleteAgentState(params.subAgentId);

    try {
      const remaining = await listAgentStates();
      const hasActive = remaining.some(
        (a) => a.status === "running" || a.status === "pending" || a.status === "paused"
      );
      if (!hasActive) {
        stopCaffeinate();
      }
    } catch {
      // Non-critical: caffeinate cleanup is best-effort
    }

    return {
      success: true,
      message: `Revoked and cleaned up sub-agent ${state.agentType}.`,
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

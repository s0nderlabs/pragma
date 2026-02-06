// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getRootDelegationStatus,
  revokeRootDelegation,
} from "../core/delegation/root.js";
import { incrementNonceViaUserOp } from "../core/delegation/revocation.js";
import { createHybridDelegatorHandle } from "../core/account/hybridDelegator.js";
import { loadConfig, isWalletConfigured, getRpcUrl } from "../config/pragma-config.js";
import { buildViemChain } from "../config/chains.js";
import { createPublicClient, http } from "viem";
import { x402HttpOptions } from "../core/x402/client.js";
import { stopCaffeinate } from "../core/utils/caffeinate.js";

const RevokeRootDelegationSchema = z.object({
  confirm: z
    .boolean()
    .describe(
      "Must be true to confirm revocation. " +
        "This is a destructive action that revokes ALL autonomous permissions, " +
        "archives ALL sub-agent states, and releases ALL wallets."
    ),
  revocationMode: z
    .enum(["local", "onchain"])
    .default("local")
    .describe(
      "Revocation mode. 'local' (default): deletes local delegation files only. " +
        "'onchain': increments NonceEnforcer nonce via UserOp (Touch ID required), " +
        "which invalidates ALL delegations on-chain, then performs local cleanup. " +
        "Use 'onchain' if you suspect session key compromise or want immediate on-chain invalidation."
    ),
});

interface RevokeRootDelegationResult {
  success: boolean;
  message: string;
  revocation?: {
    subAgentsCleanedUp: number;
    walletsReleased: number;
  };
  onChainRevocation?: {
    userOpHash: string;
    transactionHash?: string;
    previousNonce: string;
    newNonce: string;
  };
  error?: string;
}

export function registerRevokeRootDelegation(server: McpServer): void {
  server.tool(
    "revoke_root_delegation",
    "Revoke the root delegation entirely, cascading cleanup to ALL sub-agents. " +
      "Archives all sub-agent states, releases all wallets to pool, and deletes root-delegation.json. " +
      "After this, no autonomous trading is possible until a new root delegation is created. " +
      "Requires confirm: true as a safety measure. " +
      "Set revocationMode to 'onchain' to also invalidate all delegations on-chain via NonceEnforcer " +
      "(requires Touch ID, recommended if session key may be compromised).",
    RevokeRootDelegationSchema.shape,
    async (
      params
    ): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await revokeRootDelegationHandler(
        params as z.infer<typeof RevokeRootDelegationSchema>
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}

async function revokeRootDelegationHandler(
  params: z.infer<typeof RevokeRootDelegationSchema>
): Promise<RevokeRootDelegationResult> {
  try {
    if (!params.confirm) {
      return {
        success: false,
        message: "Confirmation required",
        error:
          "Set confirm: true to proceed. This will revoke ALL autonomous permissions " +
          "and archive ALL sub-agent states.",
      };
    }

    const status = getRootDelegationStatus();
    if (!status.exists) {
      return {
        success: false,
        message: "No root delegation found",
        error: "There is no root delegation to revoke.",
      };
    }

    let onChainRevocation: RevokeRootDelegationResult["onChainRevocation"];

    if (params.revocationMode === "onchain") {
      const config = await loadConfig();
      if (!config || !isWalletConfigured(config)) {
        return {
          success: false,
          message: "Wallet not configured",
          error: "Please run setup_wallet first to use on-chain revocation.",
        };
      }

      const handle = await createHybridDelegatorHandle(config, {
        touchIdMessage: "Revoke ALL delegations (nuclear revoke)",
      });

      const rpcUrl = await getRpcUrl(config);
      const chain = buildViemChain(config.network.chainId, rpcUrl);
      const publicClient = createPublicClient({
        chain,
        transport: http(rpcUrl, x402HttpOptions(config)),
      });

      try {
        const result = await incrementNonceViaUserOp(handle, publicClient, config);

        onChainRevocation = {
          userOpHash: result.userOpHash,
          transactionHash: result.transactionHash,
          previousNonce: result.previousNonce.toString(),
          newNonce: result.newNonce.toString(),
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : "Unknown error";

        if (/cancell?ed|user denied/i.test(errorMsg)) {
          return {
            success: false,
            message: "Touch ID cancelled",
            error: "On-chain revocation requires Touch ID confirmation. Please try again.",
          };
        }

        return {
          success: false,
          message: "On-chain revocation failed",
          error: `Failed to increment nonce on-chain: ${errorMsg}. Local delegation files were NOT removed.`,
        };
      }
    }

    const revocation = await revokeRootDelegation();
    stopCaffeinate();

    const modeLabel = params.revocationMode === "onchain" ? "on-chain + local" : "local";
    const nonceMsg = onChainRevocation
      ? ` Nonce incremented from ${onChainRevocation.previousNonce} to ${onChainRevocation.newNonce} (all old delegations invalidated on-chain).`
      : "";

    return {
      success: true,
      message:
        `Root delegation revoked (${modeLabel}). ` +
        `${revocation.subAgentsCleanedUp} sub-agent(s) archived, ` +
        `${revocation.walletsReleased} wallet(s) released.` +
        nonceMsg,
      revocation: {
        subAgentsCleanedUp: revocation.subAgentsCleanedUp,
        walletsReleased: revocation.walletsReleased,
      },
      onChainRevocation,
    };
  } catch (error) {
    return {
      success: false,
      message: "Failed to revoke root delegation",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

// Revoke Root Delegation Tool
// Revokes root delegation and cascades cleanup to all sub-agents
// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getRootDelegationStatus,
  revokeRootDelegation,
} from "../core/delegation/root.js";
import { stopCaffeinate } from "../core/utils/caffeinate.js";

const RevokeRootDelegationSchema = z.object({
  confirm: z
    .boolean()
    .describe(
      "Must be true to confirm revocation. " +
        "This is a destructive action that revokes ALL autonomous permissions, " +
        "archives ALL sub-agent states, and releases ALL wallets."
    ),
});

interface RevokeRootDelegationResult {
  success: boolean;
  message: string;
  revocation?: {
    subAgentsCleanedUp: number;
    walletsReleased: number;
  };
  error?: string;
}

export function registerRevokeRootDelegation(server: McpServer): void {
  server.tool(
    "revoke_root_delegation",
    "Revoke the root delegation entirely, cascading cleanup to ALL sub-agents. " +
      "Archives all sub-agent states, releases all wallets to pool, and deletes root-delegation.json. " +
      "After this, no autonomous trading is possible until a new root delegation is created. " +
      "Requires confirm: true as a safety measure.",
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
    // Safety check: require explicit confirmation
    if (!params.confirm) {
      return {
        success: false,
        message: "Confirmation required",
        error:
          "Set confirm: true to proceed. This will revoke ALL autonomous permissions " +
          "and archive ALL sub-agent states.",
      };
    }

    // Check if root delegation exists
    const status = getRootDelegationStatus();
    if (!status.exists) {
      return {
        success: false,
        message: "No root delegation found",
        error: "There is no root delegation to revoke.",
      };
    }

    // Execute revocation (cascades to all sub-agents)
    const revocation = await revokeRootDelegation();

    // Stop caffeinate — no agents running after full revocation
    stopCaffeinate();

    return {
      success: true,
      message:
        `Root delegation revoked. ` +
        `${revocation.subAgentsCleanedUp} sub-agent(s) archived, ` +
        `${revocation.walletsReleased} wallet(s) released.`,
      revocation: {
        subAgentsCleanedUp: revocation.subAgentsCleanedUp,
        walletsReleased: revocation.walletsReleased,
      },
    };
  } catch (error) {
    return {
      success: false,
      message: "Failed to revoke root delegation",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

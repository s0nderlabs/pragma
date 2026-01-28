// Check Delegation Status Tool
// Checks validity of root delegation or sub-agent delegation
// Includes on-chain call count verification
// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { loadConfig, getRpcUrl } from "../config/pragma-config.js";
import { buildViemChain } from "../config/chains.js";
import { x402HttpOptions } from "../core/x402/client.js";
import {
  getRootDelegationStatus,
  loadRootDelegation,
} from "../core/delegation/root.js";
import { loadAgentState, loadDelegation } from "../core/subagent/index.js";
import { formatTimeRemaining } from "../core/utils/index.js";
import { withRetry } from "../core/utils/retry.js";
import { getDTKEnvironment } from "../config/constants.js";

// ============================================================================
// Types & ABIs
// ============================================================================

// ABI for on-chain call count checking
const LIMITED_CALLS_ABI = [
  {
    type: "function",
    name: "callCounts",
    stateMutability: "view",
    inputs: [
      { name: "delegationManager", type: "address" },
      { name: "delegationHash", type: "bytes32" },
    ],
    outputs: [{ name: "count", type: "uint256" }],
  },
] as const;

const CheckDelegationStatusSchema = z.object({
  agentId: z
    .string()
    .optional()
    .describe(
      "Optional sub-agent ID to check. If omitted, checks root delegation status."
    ),
});

interface CallCount {
  used: number;
  limit: number;
  remaining: number;
  exhausted: boolean;
}

interface DelegationStatus {
  type: "root" | "sub-agent";
  exists: boolean;
  valid: boolean;
  expired: boolean;
  expiresAt?: string;
  expiresIn?: string;
  // Call count (on-chain)
  callCount?: CallCount;
  // Root delegation specific
  maxCalls?: number;
  approximateBudget?: string;
  // Sub-agent specific
  agentId?: string;
  agentType?: string;
  agentStatus?: string;
  tradesExecuted?: number;
  tradesMax?: number;
}

interface CheckDelegationStatusResult {
  success: boolean;
  message: string;
  delegation?: DelegationStatus;
  error?: string;
}

export function registerCheckDelegationStatus(server: McpServer): void {
  server.tool(
    "check_delegation_status",
    "Check the validity of root delegation or a sub-agent's delegation. " +
      "Includes on-chain call count verification. " +
      "Use without agentId to check root delegation status. " +
      "Use with agentId to check a specific sub-agent's delegation. " +
      "Returns expiry info, validity, and remaining calls (on-chain).",
    CheckDelegationStatusSchema.shape,
    async (
      params
    ): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await checkDelegationStatusHandler(
        params as z.infer<typeof CheckDelegationStatusSchema>
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}

async function checkDelegationStatusHandler(
  params: z.infer<typeof CheckDelegationStatusSchema>
): Promise<CheckDelegationStatusResult> {
  try {
    const config = await loadConfig();
    if (!config?.wallet) {
      return {
        success: false,
        message: "Wallet not configured",
        error: "Please run setup_wallet first",
      };
    }

    // Check sub-agent delegation if agentId provided
    if (params.agentId) {
      return checkSubAgentDelegation(params.agentId, config);
    }

    // Otherwise check root delegation
    return checkRootDelegation(config);
  } catch (error) {
    return {
      success: false,
      message: "Failed to check delegation status",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Fetch on-chain call count for a delegation using stored hash
 *
 * Uses the pre-computed delegation hash (from hashDelegation at creation time)
 * instead of calling getDelegationHash on-chain, which avoids ABI encoding issues.
 */
async function fetchOnChainCallCount(
  config: Awaited<ReturnType<typeof loadConfig>>,
  delegationHash: Hex,
  maxCalls: number
): Promise<CallCount | null> {
  if (!config) return null;

  try {
    const chainId = config.network.chainId;
    const rpcUrl = await getRpcUrl(config);
    const chain = buildViemChain(chainId, rpcUrl);
    const dtkEnv = getDTKEnvironment();

    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl, x402HttpOptions(config)),
    });

    // Get used calls from LimitedCallsEnforcer (with retry)
    // Note: DTK uses PascalCase keys (LimitedCallsEnforcer), not camelCase
    const countResult = await withRetry(
      async () =>
        publicClient.readContract({
          address: dtkEnv.caveatEnforcers.LimitedCallsEnforcer as Address,
          abi: LIMITED_CALLS_ABI,
          functionName: "callCounts",
          args: [dtkEnv.DelegationManager as Address, delegationHash],
        }),
      { operationName: "callCounts" }
    );

    if (!countResult.success || countResult.data === undefined) {
      return null;
    }
    const usedCalls = countResult.data;

    const used = Number(usedCalls);
    const remaining = Math.max(0, maxCalls - used);

    return {
      used,
      limit: maxCalls,
      remaining,
      exhausted: remaining === 0,
    };
  } catch (error) {
    // Return null on error - don't fail the whole check
    console.error("Failed to fetch on-chain call count:", error);
    return null;
  }
}

async function checkRootDelegation(
  config: Awaited<ReturnType<typeof loadConfig>>
): Promise<CheckDelegationStatusResult> {
  const status = getRootDelegationStatus();

  if (!status.exists) {
    return {
      success: true,
      message: "No root delegation found",
      delegation: {
        type: "root",
        exists: false,
        valid: false,
        expired: false,
      },
    };
  }

  const expired = !status.valid;

  // Load full root delegation for on-chain check
  const rootDelegation = loadRootDelegation();
  let callCount: CallCount | null = null;

  if (rootDelegation && status.maxCalls) {
    // Use the pre-computed delegation hash stored at creation time
    callCount = await fetchOnChainCallCount(config, rootDelegation.delegationHash, status.maxCalls);
  }

  // Check if calls exhausted
  const callsExhausted = callCount?.exhausted ?? false;
  const isValid = status.valid && !callsExhausted;

  let message: string;
  if (expired) {
    message = "Root delegation has expired";
  } else if (callsExhausted) {
    message = "Root delegation call limit exhausted";
  } else if (callCount) {
    message = `Root delegation valid: ${callCount.remaining}/${callCount.limit} calls remaining, expires in ${status.expiresIn}`;
  } else {
    message = `Root delegation valid for ${status.expiresIn}`;
  }

  return {
    success: true,
    message,
    delegation: {
      type: "root",
      exists: true,
      valid: isValid,
      expired,
      expiresAt: status.expiresAt
        ? new Date(status.expiresAt).toISOString()
        : undefined,
      expiresIn: status.expiresIn,
      callCount: callCount ?? undefined,
      maxCalls: status.maxCalls,
      approximateBudget: status.approximateBudget,
    },
  };
}

async function checkSubAgentDelegation(
  agentId: string,
  config: Awaited<ReturnType<typeof loadConfig>>
): Promise<CheckDelegationStatusResult> {
  // Load agent state
  const state = await loadAgentState(agentId);
  if (!state) {
    return {
      success: false,
      message: "Sub-agent not found",
      error: `No sub-agent found with ID: ${agentId}`,
    };
  }

  // Load delegation
  const storedDelegation = await loadDelegation(agentId);
  if (!storedDelegation) {
    return {
      success: true,
      message: "Sub-agent exists but delegation not found",
      delegation: {
        type: "sub-agent",
        exists: false,
        valid: false,
        expired: false,
        agentId,
        agentType: state.agentType,
        agentStatus: state.status,
      },
    };
  }

  const now = Date.now();
  const expired = now > storedDelegation.expiresAt;

  // Fetch on-chain call count using stored delegation hash
  let callCount: CallCount | null = null;
  const maxCalls = state.trades.maxAllowed;

  if (storedDelegation.delegationHash) {
    // Use the pre-computed delegation hash stored at creation time
    callCount = await fetchOnChainCallCount(config, storedDelegation.delegationHash, maxCalls);
  }

  // Check if calls exhausted
  const callsExhausted = callCount?.exhausted ?? false;
  const valid =
    !expired &&
    !callsExhausted &&
    state.status !== "revoked" &&
    state.status !== "failed";

  let message: string;
  if (expired) {
    message = "Sub-agent delegation has expired";
  } else if (callsExhausted) {
    message = "Sub-agent call limit exhausted";
  } else if (callCount) {
    message = `Sub-agent delegation valid: ${callCount.remaining}/${callCount.limit} calls remaining, expires in ${formatTimeRemaining(storedDelegation.expiresAt)}`;
  } else {
    message = `Sub-agent delegation valid for ${formatTimeRemaining(storedDelegation.expiresAt)}`;
  }

  return {
    success: true,
    message,
    delegation: {
      type: "sub-agent",
      exists: true,
      valid,
      expired,
      expiresAt: new Date(storedDelegation.expiresAt).toISOString(),
      expiresIn: expired ? "expired" : formatTimeRemaining(storedDelegation.expiresAt),
      callCount: callCount ?? undefined,
      agentId,
      agentType: state.agentType,
      agentStatus: state.status,
      tradesExecuted: state.trades.executed,
      tradesMax: state.trades.maxAllowed,
    },
  };
}

// Create Root Delegation Tool
// Creates a persistent root delegation for autonomous mode (requires Touch ID once)
// After this, sub-agents can be created without Touch ID
// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parseEther, formatEther, type Address } from "viem";
import { loadConfig } from "../config/pragma-config.js";
import { getSessionKey } from "../core/session/keys.js";
import {
  signAndStoreRootDelegation,
  getRootDelegationStatus,
  validateRootDelegationParams,
} from "../core/delegation/root.js";
import { formatTimeRemaining } from "../core/utils/index.js";

const CreateRootDelegationSchema = z.object({
  expiryDays: z
    .number()
    .min(1)
    .max(30)
    .default(7)
    .describe("How many days until delegation expires. Default: 7"),
  budgetMon: z
    .number()
    .min(1)
    .max(1000)
    .default(50)
    .describe(
      "Total MON budget cap (approximate). This is valueLte × maxTrades. Default: 50 MON"
    ),
  maxTrades: z
    .number()
    .min(10)
    .max(500)
    .default(100)
    .describe("Maximum number of trades allowed. Default: 100"),
  force: z
    .boolean()
    .default(false)
    .describe("Force creation even if a valid root delegation exists"),
});

interface CreateRootDelegationResult {
  success: boolean;
  message: string;
  rootDelegation?: {
    delegationHash: string;
    sessionKey: string;
    delegator: string;
    budget: {
      approximate: string;
      perTransaction: string;
    };
    maxTrades: number;
    expiresAt: string;
    expiresIn: string;
    allowedTargets: string[];
  };
  existingDelegation?: {
    expiresAt: string;
    expiresIn: string;
    approximateBudget: string;
  };
  error?: string;
}

export function registerCreateRootDelegation(server: McpServer): void {
  server.tool(
    "create_root_delegation",
    "Create a persistent root delegation for autonomous trading mode. " +
      "This requires Touch ID ONCE to authorize the Main Agent (Claude's session key) " +
      "to execute trades on your behalf. After this, sub-agents can be created without " +
      "requiring additional Touch ID. The delegation is time-bound and trade-count limited. " +
      "Use this before creating sub-agents with create_sub_agent.",
    CreateRootDelegationSchema.shape,
    async (
      params
    ): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await createRootDelegationHandler(
        params as z.infer<typeof CreateRootDelegationSchema>
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}

async function createRootDelegationHandler(
  params: z.infer<typeof CreateRootDelegationSchema>
): Promise<CreateRootDelegationResult> {
  try {
    const config = await loadConfig();
    if (!config?.wallet) {
      return {
        success: false,
        message: "Wallet not configured",
        error: "Please run setup_wallet first",
      };
    }

    // Load session key
    const sessionKey = await getSessionKey();
    if (!sessionKey) {
      return {
        success: false,
        message: "Session key not found",
        error: "Please run setup_wallet to create a session key",
      };
    }

    // Check for existing valid root delegation
    if (!params.force) {
      const status = getRootDelegationStatus();
      if (status.exists && status.valid) {
        return {
          success: false,
          message: "A valid root delegation already exists",
          existingDelegation: {
            expiresAt: status.expiresAt
              ? new Date(status.expiresAt).toISOString()
              : "unknown",
            expiresIn: status.expiresIn || "unknown",
            approximateBudget: status.approximateBudget || "unknown",
          },
          error:
            "Use force: true to replace the existing delegation, " +
            "or wait for it to expire",
        };
      }
    }

    const chainId = config.network.chainId;

    // Calculate valueLtePerTx from budget
    // budgetMon = valueLtePerTx × maxTrades
    // So: valueLtePerTx = budgetMon / maxTrades
    const totalBudgetWei = parseEther(params.budgetMon.toString());
    const valueLtePerTx = totalBudgetWei / BigInt(params.maxTrades);

    // Validate parameters
    const validationResult = validateRootDelegationParams({
      expiryDays: params.expiryDays,
      valueLtePerTx,
      maxCalls: params.maxTrades,
    });

    if (!validationResult.valid) {
      return {
        success: false,
        message: "Invalid delegation parameters",
        error: validationResult.errors.join(", "),
      };
    }

    // Create, sign, and store the root delegation
    // This will prompt for Touch ID
    const storedDelegation = await signAndStoreRootDelegation({
      delegator: config.wallet.smartAccountAddress as Address,
      sessionKey: sessionKey.address as Address,
      expiryDays: params.expiryDays,
      valueLtePerTx,
      maxCalls: params.maxTrades,
      chainId,
      keyId: config.wallet.keyId,
      touchIdMessage: `Enable autonomous trading: ${params.budgetMon} MON budget, ${params.maxTrades} trades, ${params.expiryDays} days`,
    });

    // Calculate human-readable expiry
    const expiresAt = new Date(storedDelegation.expiresAt);
    const expiresIn = formatTimeRemaining(storedDelegation.expiresAt);

    return {
      success: true,
      message: `Root delegation created successfully. You can now create sub-agents without Touch ID.`,
      rootDelegation: {
        delegationHash: storedDelegation.delegationHash,
        sessionKey: storedDelegation.sessionKey,
        delegator: storedDelegation.delegator,
        budget: {
          approximate: formatEther(BigInt(storedDelegation.approximateBudget)) + " MON",
          perTransaction: formatEther(BigInt(storedDelegation.valueLtePerTx)) + " MON/tx",
        },
        maxTrades: storedDelegation.maxCalls,
        expiresAt: expiresAt.toISOString(),
        expiresIn,
        allowedTargets: storedDelegation.allowedTargets,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    // Check for Touch ID cancellation
    const isCancelled = /cancell?ed|user denied/i.test(errorMessage);
    if (isCancelled) {
      return {
        success: false,
        message: "Touch ID cancelled",
        error: "User cancelled Touch ID authentication",
      };
    }

    return {
      success: false,
      message: "Failed to create root delegation",
      error: errorMessage,
    };
  }
}

// Create Sub-Agent Tool
// Creates a new sub-agent with wallet, delegation, and state
// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  formatEther,
  parseEther,
  http,
  createPublicClient,
  createWalletClient,
  type Address,
  type Hex,
} from "viem";
import { randomUUID } from "node:crypto";
import { loadConfig, getRpcUrl } from "../config/pragma-config.js";
import { buildViemChain, SUPPORTED_CHAINS } from "../config/chains.js";
import { getSessionKey, getSessionAccount } from "../core/session/keys.js";
import { x402HttpOptions } from "../core/x402/client.js";
import {
  assignWallet,
  releaseWallet,
  createAgentState,
  storeDelegation,
  USDC_ADDRESS,
  type StoredDelegation,
} from "../core/subagent/index.js";
import {
  createSubDelegation,
  validateSubDelegationParams,
  getSelectorsForAgentType,
} from "../core/delegation/subagent.js";
import { loadRootDelegation } from "../core/delegation/root.js";
import { hashDelegation } from "../core/delegation/typedData.js";
import { formatTimeRemaining } from "../core/utils/index.js";

// Contract addresses for agent scopes
import { LEVERUP_DIAMOND, WMON_ADDRESS } from "../core/leverup/constants.js";
import { NADFUN_CONTRACTS } from "../core/nadfun/constants.js";

const CreateSubAgentSchema = z.object({
  agentType: z
    .enum(["kairos", "thymos", "pragma"])
    .describe(
      "Type of sub-agent to create. " +
        "kairos: Strategic/macro trader for perps (patient, calculated). " +
        "thymos: Momentum trader for memecoins (fast, conviction-based). " +
        "pragma: General-purpose agent for any task."
    ),
  budgetMon: z
    .number()
    .min(0.1)
    .max(100)
    .describe(
      "MON budget for this sub-agent. Used for valueLte calculation. " +
        "The total budget is valueLtePerTx × maxTrades."
    ),
  budgetUsdc: z
    .number()
    .min(0)
    .optional()
    .describe("USDC budget (soft limit, agent self-tracks). Default: 0"),
  expiryDays: z
    .number()
    .min(1)
    .max(30)
    .default(7)
    .describe("How many days until delegation expires. Default: 7"),
  maxTrades: z
    .number()
    .min(1)
    .max(100)
    .default(20)
    .describe("Maximum number of trades allowed. Default: 20"),
  fundAmount: z
    .number()
    .min(0)
    .max(1)
    .default(0.1)
    .describe(
      "Initial gas funding in MON. Set to 0 to skip funding. Default: 0.1 MON"
    ),
  taskId: z
    .string()
    .optional()
    .describe("Optional Claude Code Task ID for tracking"),
});

interface CreateSubAgentResult {
  success: boolean;
  message: string;
  subAgent?: {
    id: string;
    walletAddress: string;
    agentType: string;
    budget: {
      mon: string;
      usdc: string;
      perTransaction: string;
    };
    maxTrades: number;
    expiresAt: string;
    expiresIn: string;
    fundingTx?: string;
  };
  error?: string;
}

/**
 * Build allowed targets based on agent type
 */
function buildAllowedTargets(
  agentType: "kairos" | "thymos" | "pragma",
  dexAggregator: Address | undefined,
  nadfunRouter: Address | undefined
): Address[] {
  switch (agentType) {
    case "kairos":
      // kairos: perps only
      return [LEVERUP_DIAMOND];

    case "thymos": {
      // thymos: memecoins (nadfun + WMON + dex)
      const targets: Address[] = [];
      if (nadfunRouter) targets.push(nadfunRouter);
      targets.push(WMON_ADDRESS);
      if (dexAggregator) targets.push(dexAggregator);
      return targets;
    }

    case "pragma": {
      // pragma: all trading contracts
      const targets: Address[] = [LEVERUP_DIAMOND, WMON_ADDRESS];
      if (dexAggregator) targets.push(dexAggregator);
      if (nadfunRouter) targets.push(nadfunRouter);
      return targets;
    }
  }
}

export function registerCreateSubAgent(server: McpServer): void {
  server.tool(
    "create_sub_agent",
    "Create a new autonomous sub-agent with its own wallet and delegation. " +
      "Sub-agents can execute trades within their budget constraints without requiring Touch ID. " +
      "The delegation is signed by the session key and inherits from the user's root delegation. " +
      "Use this for autonomous trading or monitoring tasks.",
    CreateSubAgentSchema.shape,
    async (
      params
    ): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await createSubAgentHandler(
        params as z.infer<typeof CreateSubAgentSchema>
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}

async function createSubAgentHandler(
  params: z.infer<typeof CreateSubAgentSchema>
): Promise<CreateSubAgentResult> {
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

    const chainId = config.network.chainId;

    // Load and validate root delegation
    const rootDelegation = loadRootDelegation();
    if (!rootDelegation) {
      return {
        success: false,
        message: "No root delegation found",
        error: "Please run create_root_delegation first to enable autonomous mode",
      };
    }

    // Check root delegation expiry
    if (Date.now() > rootDelegation.expiresAt) {
      return {
        success: false,
        message: "Root delegation has expired",
        error: "Please run create_root_delegation to create a new root delegation",
      };
    }

    // Verify session key matches
    if (rootDelegation.sessionKey.toLowerCase() !== sessionKey.address.toLowerCase()) {
      return {
        success: false,
        message: "Session key mismatch",
        error: "Root delegation was created with a different session key. Please run create_root_delegation again.",
      };
    }

    // Generate agent ID and task ID first
    const agentId = randomUUID();
    const taskId = params.taskId || `subagent-${agentId}`;

    // Get or create wallet from pool and assign to task
    const poolWallet = await assignWallet(taskId);

    // Wrap all operations in try-catch to release wallet on failure
    try {
      // Calculate valueLtePerTx
      // Total budget = valueLtePerTx × maxTrades
      // So valueLtePerTx = totalBudget / maxTrades
      const totalBudgetWei = parseEther(params.budgetMon.toString());
      const valueLtePerTx = totalBudgetWei / BigInt(params.maxTrades);

      // Build allowed targets based on agent type
      const chainConfig = SUPPORTED_CHAINS[chainId];
      const dexAggregator = chainConfig?.aggregators?.router;
      const nadfunRouter = chainId === 143 ? NADFUN_CONTRACTS[143].router : undefined;
      const allowedTargets = buildAllowedTargets(params.agentType, dexAggregator, nadfunRouter);

      // Get selectors for this agent type
      const allowedSelectors = getSelectorsForAgentType(params.agentType);

      // Validate delegation params
      const validationResult = validateSubDelegationParams({
        subAgentAddress: poolWallet.address as Address,
        mainAgentAddress: sessionKey.address,
        allowedTargets,
        allowedSelectors,
        expiryDays: params.expiryDays,
        valueLtePerTx,
        maxCalls: params.maxTrades,
        chainId,
      });

      if (!validationResult.valid) {
        // Release wallet before returning error
        await releaseWallet(poolWallet.id);
        return {
          success: false,
          message: "Invalid delegation parameters",
          error: validationResult.errors.join(", "),
        };
      }

      // Create sub-delegation
      const delegationResult = createSubDelegation({
        subAgentAddress: poolWallet.address as Address,
        mainAgentAddress: sessionKey.address,
        allowedTargets,
        allowedSelectors,
        expiryDays: params.expiryDays,
        valueLtePerTx,
        maxCalls: params.maxTrades,
        chainId,
      });

      // Sign delegation with session key
      const sessionAccount = getSessionAccount(sessionKey);
      const signature = await sessionAccount.signTypedData({
        domain: delegationResult.typedData.domain,
        types: delegationResult.typedData.types,
        primaryType: "Delegation",
        message: delegationResult.typedData.message,
      });

      // Create agent state with optional USDC limit
      const tokenLimits: Record<string, bigint> | undefined =
        params.budgetUsdc && params.budgetUsdc > 0
          ? { [USDC_ADDRESS.toLowerCase()]: BigInt(Math.floor(params.budgetUsdc * 1e6)) }
          : undefined;

      await createAgentState({
        id: agentId,
        walletId: poolWallet.id,
        walletAddress: poolWallet.address as Address,
        agentType: params.agentType,
        taskId,
        budget: {
          monAllocated: totalBudgetWei,
          tokenLimits,
        },
        maxTrades: params.maxTrades,
        expiresAt: delegationResult.expiresAt * 1000, // Convert to milliseconds
      });

      // Create signed delegation object for storage
      const signedDelegation = {
        ...delegationResult.delegation,
        signature,
      };

      // Compute delegation hash
      const delegationHash = hashDelegation(delegationResult.delegation, chainId);

      // Store delegation with root delegation reference for chain assembly
      const storedDelegation: StoredDelegation = {
        delegationHash,
        signedDelegation,
        parentDelegationHash: rootDelegation.delegationHash, // Reference to root delegation
        rootDelegation: rootDelegation.delegation, // Full root delegation for chain assembly at execution
        createdAt: Date.now(),
        expiresAt: delegationResult.expiresAt * 1000,
      };
      await storeDelegation(agentId, storedDelegation);

      // Fund sub-agent if requested
      let fundingTxHash: string | undefined;
      if (params.fundAmount > 0) {
        const rpcUrl = await getRpcUrl(config);
        const chain = buildViemChain(chainId, rpcUrl);

        const publicClient = createPublicClient({
          chain,
          transport: http(rpcUrl, x402HttpOptions(config)),
        });

        const walletClient = createWalletClient({
          account: sessionAccount,
          chain,
          transport: http(rpcUrl, x402HttpOptions(config)),
        });

        // Check session key balance
        const sessionKeyBalance = await publicClient.getBalance({
          address: sessionKey.address,
        });

        const fundAmountWei = parseEther(params.fundAmount.toString());

        if (sessionKeyBalance >= fundAmountWei) {
          fundingTxHash = await walletClient.sendTransaction({
            to: poolWallet.address as Address,
            value: fundAmountWei,
          });

          // Wait for confirmation
          await publicClient.waitForTransactionReceipt({ hash: fundingTxHash as `0x${string}` });
        }
      }

      // Calculate human-readable expiry
      const expiresAtMs = delegationResult.expiresAt * 1000;
      const expiresAt = new Date(expiresAtMs);
      const expiresIn = formatTimeRemaining(expiresAtMs);

      return {
        success: true,
        message: `Created ${params.agentType} sub-agent with ${params.budgetMon} MON budget`,
        subAgent: {
          id: agentId,
          walletAddress: poolWallet.address,
          agentType: params.agentType,
          budget: {
            mon: params.budgetMon + " MON",
            usdc: (params.budgetUsdc || 0) + " USDC",
            perTransaction: formatEther(valueLtePerTx) + " MON/tx",
          },
          maxTrades: params.maxTrades,
          expiresAt: expiresAt.toISOString(),
          expiresIn,
          fundingTx: fundingTxHash,
        },
      };
    } catch (innerError) {
      // Release wallet back to pool on any failure
      try {
        await releaseWallet(poolWallet.id);
      } catch {
        // Ignore release errors
      }
      throw innerError; // Re-throw to be caught by outer catch
    }
  } catch (error) {
    return {
      success: false,
      message: "Failed to create sub-agent",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

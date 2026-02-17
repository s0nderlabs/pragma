// Get Sub-Agent State Tool
// Returns detailed state for a specific sub-agent
// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatEther, formatUnits, createPublicClient, http, type Address } from "viem";
import { loadConfig, getRpcUrl } from "../config/pragma-config.js";
import { buildViemChain } from "../config/chains.js";
import { x402HttpOptions } from "../core/x402/client.js";
import {
  loadAgentState,
  updateAgentState,
  loadTrades,
  loadLoopConfig,
  getAllTokenSpending,
  getAllTokenFlows,
  getGroupNetOutflow,
  getTrackedPositions,
  NATIVE_TOKEN_ADDRESS,
  USDC_ADDRESS,
  TOKEN_GROUPS,
} from "../core/subagent/index.js";
import { formatTimeRemaining, formatLocalTimestamp } from "../core/utils/index.js";
import { withRetry } from "../core/utils/retry.js";

const GetSubAgentStateSchema = z.object({
  subAgentId: z
    .string()
    .describe("The sub-agent ID (UUID) to get state for"),
  taskAgentId: z
    .string()
    .optional()
    .describe(
      "Optional: Claude Code Task agent ID to store for resume capability. " +
        "Pass this after spawning a Task to enable resume after gas top-up."
    ),
  teammateName: z
    .string()
    .optional()
    .describe(
      "Optional: Teammate name for leader wake lookup. " +
        "Pass the 'name' parameter from Task spawn (e.g., 'kairos-abc123')."
    ),
  includeTrades: z
    .boolean()
    .optional()
    .describe("Include recent trade history. Default: true"),
  tradeLimit: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .describe("Max number of trades to include. Default: 10"),
});

interface GetSubAgentStateResult {
  success: boolean;
  message: string;
  updated?: boolean; // True if state was updated
  state?: {
    id: string;
    agentType: string;
    status: string;
    walletAddress: string;
    walletBalance: string; // Actual MON balance for gas
    taskId: string;
    taskAgentId?: string; // Claude Code Task agent ID for resume
    budget: {
      // Native MON (on-chain enforced via valueLte)
      monAllocated: string;
      monSpent: string;
      monRemaining: string;
      // All token spending (off-chain tracked)
      tokenSpending: Array<{
        address: string;
        symbol: string;
        spent: string;
        limit: string | null;
        remaining: string | null;
      }>;
      // Ledger-based token flows (in + out per token)
      tokenFlows?: Array<{
        address: string;
        symbol: string;
        out: string;
        in: string;
        net: string; // positive = profit, negative = cost
        group: string | null;
      }>;
      // Group-level budget enforcement (static max drawdown model)
      groupBudgets?: Array<{
        group: string;
        budget: string;
        budgetConsumed: string;
        remaining: string;
        pnl: string; // positive = profit, negative = loss
        trackedPositions: number;
        utilization: string; // percentage
      }>;
    };
    trades: {
      executed: number;
      maxAllowed: number;
      remaining: number;
    };
    timing: {
      createdAt: string;
      lastActivityAt: string;
      expiresAt: string;
      expiresIn: string;
      isExpired: boolean;
    };
    errors: Array<{
      timestamp: string;
      message: string;
      recoverable: boolean;
    }>;
    loop?: {
      type: string;
      active: boolean;
      mission: string;
      condition?: string;
      intervalMinutes?: number;
    };
    recentTrades?: Array<{
      timestamp: string;
      action: string;
      protocol: string;
      txHash: string;
      success: boolean;
    }>;
  };
  error?: string;
}

export function registerGetSubAgentState(server: McpServer): void {
  server.tool(
    "get_sub_agent_state",
    "Get detailed state for a specific sub-agent including budget, trades, errors, and loop config. " +
      "Can store taskAgentId for resume and teammateName for leader wake lookup. " +
      "Use report_agent_status to update agent status.",
    GetSubAgentStateSchema.shape,
    async (params): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await getSubAgentStateHandler(
        params as z.infer<typeof GetSubAgentStateSchema>
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}

async function getSubAgentStateHandler(
  params: z.infer<typeof GetSubAgentStateSchema>
): Promise<GetSubAgentStateResult> {
  try {
    const config = await loadConfig();
    if (!config?.wallet) {
      return {
        success: false,
        message: "Wallet not configured",
        error: "Please run setup_wallet first",
      };
    }

    // Load agent state
    let state = await loadAgentState(params.subAgentId);
    if (!state) {
      return {
        success: false,
        message: "Sub-agent not found",
        error: `No sub-agent found with ID: ${params.subAgentId}`,
      };
    }

    // Store taskAgentId / teammateName if provided (for hook lookup and resume)
    let updated = false;
    if (params.taskAgentId || params.teammateName) {
      await updateAgentState(params.subAgentId, {
        ...(params.taskAgentId && { taskAgentId: params.taskAgentId }),
        ...(params.teammateName && { teammateName: params.teammateName }),
      });
      updated = true;

      // Reload state to get updated values
      state = await loadAgentState(params.subAgentId);
      if (!state) {
        return {
          success: false,
          message: "Failed to reload state after update",
          error: "State was updated but could not be reloaded",
        };
      }
    }

    // Fetch actual wallet balance (gas)
    const rpcUrl = await getRpcUrl(config);
    const chain = buildViemChain(config.network.chainId, rpcUrl);
    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl, x402HttpOptions(config)),
    });

    // Get wallet balance with retry (graceful degradation if fails)
    const balanceResult = await withRetry(
      async () => publicClient.getBalance({ address: state.walletAddress as Address }),
      { operationName: "check-wallet-balance" }
    );
    const walletBalance = balanceResult.success ? balanceResult.data ?? 0n : 0n;

    // Calculate budget values
    const monAllocated = BigInt(state.budget.monAllocated);
    const monSpent = BigInt(state.budget.monSpent);

    // Get all token spending
    const tokenSpendingMap = await getAllTokenSpending(params.subAgentId);

    // Known token metadata (extend as needed)
    const TOKEN_INFO: Record<string, { symbol: string; decimals: number }> = {
      [NATIVE_TOKEN_ADDRESS.toLowerCase()]: { symbol: "MON", decimals: 18 },
      [USDC_ADDRESS.toLowerCase()]: { symbol: "USDC", decimals: 6 },
      "0x754704bc059f8c67012fed69bc8a327a5aafb603": { symbol: "USDC", decimals: 6 }, // Actual Monad mainnet USDC
      "0x0f0bdebf0f83cd1ee3974779bcb7315f9808c714": { symbol: "USDT", decimals: 6 },
      "0xe0590015a873bf326bd645c3e1266d4db41c4e6b": { symbol: "WMON", decimals: 18 },
      "0x3bd359c1119da7da1d913d1c4d2b7c461115433a": { symbol: "WMON", decimals: 18 },
      "0xfd44b35139ae53fff7d8f2a9869c503d987f00d1": { symbol: "LVUSD", decimals: 18 },
      "0x91b81bfbe3a747230f0529aa28d8b2bc898e6d56": { symbol: "LVMON", decimals: 18 },
    };

    function getTokenMeta(addr: string): { symbol: string; decimals: number } {
      return TOKEN_INFO[addr] || { symbol: addr.slice(0, 10), decimals: 18 };
    }

    // Format token spending for output
    const tokenSpending = tokenSpendingMap
      ? Object.entries(tokenSpendingMap).map(([addr, { spent, limit }]) => {
          const { symbol, decimals } = getTokenMeta(addr);
          const formatAmount = (value: bigint): string => `${formatUnits(value, decimals)} ${symbol}`;

          return {
            address: addr,
            symbol,
            spent: formatAmount(spent),
            limit: limit !== null ? formatAmount(limit) : null,
            remaining: limit !== null ? formatAmount(limit - spent) : null,
          };
        })
      : [];

    // Format token flows for output (ledger-based tracking)
    const tokenFlowsMap = await getAllTokenFlows(params.subAgentId);
    const tokenFlowsList = tokenFlowsMap
      ? Object.entries(tokenFlowsMap)
          .filter(([, flow]) => flow.out > 0n || flow.in > 0n) // Only show tokens with activity
          .map(([addr, flow]) => {
            const { symbol, decimals } = getTokenMeta(addr);
            const fmt = (v: bigint): string => `${formatUnits(v < 0n ? -v : v, decimals)} ${symbol}`;
            return {
              address: addr,
              symbol,
              out: fmt(flow.out),
              in: fmt(flow.in),
              net: `${flow.net >= 0n ? "+" : "-"}${fmt(flow.net >= 0n ? flow.net : -flow.net)}`,
              group: flow.group,
            };
          })
      : undefined;

    // Load tracked positions count
    let trackedPositionCount = 0;
    try {
      trackedPositionCount = getTrackedPositions(params.subAgentId).length;
    } catch { /* non-critical */ }

    // Compute group budget status (static max drawdown model)
    // budgetConsumed = max(0, netOutflow) -- only count net losses
    // remaining = budget - budgetConsumed -- capped at original budget
    // pnl = -netOutflow -- positive means profit
    // Capture state for closure (TypeScript can't narrow `let` in nested functions)
    const currentState = state;

    function formatGroupBudget(
      groupName: string,
      budget: bigint,
      decimals: number,
      unit: string,
    ): typeof groupBudgetsList[number] {
      const netOutflow = getGroupNetOutflow(currentState, groupName);
      const consumed = netOutflow > 0n ? netOutflow : 0n;
      const remaining = budget - consumed;
      const pnl = -netOutflow;
      const utilPct = budget > 0n
        ? Number((consumed * 10000n) / budget) / 100
        : 0;
      const fmt = (v: bigint): string => `${formatUnits(v, decimals)} ${unit}`;
      const fmtSigned = (v: bigint): string =>
        `${v >= 0n ? "+" : "-"}${fmt(v >= 0n ? v : -v)}`;

      return {
        group: groupName,
        budget: fmt(budget),
        budgetConsumed: fmt(consumed),
        remaining: fmt(remaining),
        pnl: fmtSigned(pnl),
        trackedPositions: trackedPositionCount,
        utilization: `${utilPct.toFixed(1)}%`,
      };
    }

    const groupBudgetsList: Array<{
      group: string;
      budget: string;
      budgetConsumed: string;
      remaining: string;
      pnl: string;
      trackedPositions: number;
      utilization: string;
    }> = [];

    // Always include MON group
    const monGroupBudget = state.budget.groupBudgets?.MON
      ? BigInt(state.budget.groupBudgets.MON)
      : monAllocated;
    groupBudgetsList.push(formatGroupBudget("MON", monGroupBudget, 18, "MON"));

    // Include USD group if budget is set
    if (state.budget.groupBudgets?.USD) {
      const usdBudget = BigInt(state.budget.groupBudgets.USD);
      groupBudgetsList.push(formatGroupBudget("USD", usdBudget, 6, "USD"));
    }

    // Load loop config
    const loopConfig = loadLoopConfig(params.subAgentId);

    // Load trades if requested
    let recentTrades: Array<{
      timestamp: string;
      action: string;
      protocol: string;
      txHash: string;
      success: boolean;
    }> | undefined;

    if (params.includeTrades !== false) {
      const trades = await loadTrades(params.subAgentId);
      const limit = params.tradeLimit || 10;
      recentTrades = trades.slice(-limit).reverse().map((trade) => ({
        timestamp: formatLocalTimestamp(new Date(trade.timestamp)),
        action: trade.action,
        protocol: trade.protocol,
        txHash: trade.txHash,
        success: trade.success,
      }));
    }

    const now = Date.now();
    const isExpired = state.expiresAt < now;

    return {
      success: true,
      message: updated
        ? `Sub-agent ${state.agentType} updated and retrieved`
        : `Sub-agent ${state.agentType} (${state.status})`,
      updated,
      state: {
        id: state.id,
        agentType: state.agentType,
        status: state.status,
        walletAddress: state.walletAddress,
        walletBalance: formatEther(walletBalance) + " MON",
        taskId: state.taskId,
        taskAgentId: state.taskAgentId,
        budget: {
          monAllocated: formatEther(monAllocated) + " MON",
          monSpent: formatEther(monSpent) + " MON",
          monRemaining: formatEther(monAllocated - monSpent) + " MON",
          tokenSpending,
          tokenFlows: tokenFlowsList,
          groupBudgets: groupBudgetsList.length > 0 ? groupBudgetsList : undefined,
        },
        trades: {
          executed: state.trades.executed,
          maxAllowed: state.trades.maxAllowed,
          remaining: state.trades.maxAllowed - state.trades.executed,
        },
        timing: {
          createdAt: formatLocalTimestamp(new Date(state.createdAt)),
          lastActivityAt: formatLocalTimestamp(new Date(state.lastActivityAt)),
          expiresAt: formatLocalTimestamp(new Date(state.expiresAt)),
          expiresIn: formatTimeRemaining(state.expiresAt),
          isExpired,
        },
        errors: state.errors.slice(-10).map((e) => ({
          timestamp: formatLocalTimestamp(new Date(e.timestamp)),
          message: e.message,
          recoverable: e.recoverable,
        })),
        loop: loopConfig
          ? {
              type: loopConfig.type,
              active: loopConfig.active,
              mission: loopConfig.mission,
              condition: loopConfig.condition,
              intervalMinutes: loopConfig.intervalMinutes,
            }
          : undefined,
        recentTrades,
      },
    };
  } catch (error) {
    return {
      success: false,
      message: "Failed to get sub-agent state",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

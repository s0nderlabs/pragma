// Get Sub-Agent State Tool
// Returns detailed state for a specific sub-agent
// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatEther, formatUnits, type Address } from "viem";
import { loadConfig } from "../config/pragma-config.js";
import {
  loadAgentState,
  loadTrades,
  loadLoopConfig,
  getAllTokenSpending,
  NATIVE_TOKEN_ADDRESS,
  USDC_ADDRESS,
} from "../core/subagent/index.js";
import { formatTimeRemaining } from "../core/utils/index.js";

const GetSubAgentStateSchema = z.object({
  subAgentId: z
    .string()
    .describe("The sub-agent ID (UUID) to get state for"),
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
  state?: {
    id: string;
    agentType: string;
    status: string;
    walletAddress: string;
    taskId: string;
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
      description: string;
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
      "Use to monitor a single agent's performance and status.",
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
    const state = await loadAgentState(params.subAgentId);
    if (!state) {
      return {
        success: false,
        message: "Sub-agent not found",
        error: `No sub-agent found with ID: ${params.subAgentId}`,
      };
    }

    // Calculate budget values
    const monAllocated = BigInt(state.budget.monAllocated);
    const monSpent = BigInt(state.budget.monSpent);

    // Get all token spending
    const tokenSpendingMap = await getAllTokenSpending(params.subAgentId);

    // Known token metadata (extend as needed)
    const TOKEN_INFO: Record<string, { symbol: string; decimals: number }> = {
      [NATIVE_TOKEN_ADDRESS.toLowerCase()]: { symbol: "MON", decimals: 18 },
      [USDC_ADDRESS.toLowerCase()]: { symbol: "USDC", decimals: 6 },
      "0x0f0bdebf0f83cd1ee3974779bcb7315f9808c714": { symbol: "USDT", decimals: 6 },
      "0xe0590015a873bf326bd645c3e1266d4db41c4e6b": { symbol: "WMON", decimals: 18 },
    };

    // Format token spending for output
    const tokenSpending = tokenSpendingMap
      ? Object.entries(tokenSpendingMap).map(([addr, { spent, limit }]) => {
          const { symbol, decimals } = TOKEN_INFO[addr] || { symbol: addr.slice(0, 10), decimals: 18 };
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

    // Load loop config
    const loopConfig = await loadLoopConfig(params.subAgentId);

    // Load trades if requested
    let recentTrades: Array<{
      timestamp: string;
      action: string;
      protocol: string;
      txHash: string;
      success: boolean;
    }> | undefined = undefined;

    if (params.includeTrades !== false) {
      const trades = await loadTrades(params.subAgentId);
      const limit = params.tradeLimit || 10;
      recentTrades = trades.slice(-limit).reverse().map((trade) => ({
        timestamp: new Date(trade.timestamp).toISOString(),
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
      message: `Sub-agent ${state.agentType} (${state.status})`,
      state: {
        id: state.id,
        agentType: state.agentType,
        status: state.status,
        walletAddress: state.walletAddress,
        taskId: state.taskId,
        budget: {
          monAllocated: formatEther(monAllocated) + " MON",
          monSpent: formatEther(monSpent) + " MON",
          monRemaining: formatEther(monAllocated - monSpent) + " MON",
          tokenSpending,
        },
        trades: {
          executed: state.trades.executed,
          maxAllowed: state.trades.maxAllowed,
          remaining: state.trades.maxAllowed - state.trades.executed,
        },
        timing: {
          createdAt: new Date(state.createdAt).toISOString(),
          lastActivityAt: new Date(state.lastActivityAt).toISOString(),
          expiresAt: new Date(state.expiresAt).toISOString(),
          expiresIn: formatTimeRemaining(state.expiresAt),
          isExpired,
        },
        errors: state.errors.slice(-10).map((e) => ({
          timestamp: new Date(e.timestamp).toISOString(),
          message: e.message,
          recoverable: e.recoverable,
        })),
        loop: loopConfig
          ? {
              type: loopConfig.type,
              active: loopConfig.active,
              description: loopConfig.description,
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

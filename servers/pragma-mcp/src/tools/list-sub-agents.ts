// List Sub-Agents Tool
// Lists all sub-agents with their status, budget, and trades
// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatEther } from "viem";
import { loadConfig } from "../config/pragma-config.js";
import { listAgentStates, type SubAgentState } from "../core/subagent/index.js";
import { formatTimeRemaining } from "../core/utils/index.js";

const ListSubAgentsSchema = z.object({
  status: z
    .enum(["all", "running", "completed", "failed", "revoked"])
    .optional()
    .describe(
      "Filter by status. Default: 'all'. " +
        "Options: all, running, completed, failed, revoked"
    ),
});

interface SubAgentSummary {
  id: string;
  agentType: string;
  status: string;
  walletAddress: string;
  budget: {
    monRemaining: string;
    tokensTracked: number; // Number of different tokens with spending tracked
  };
  trades: {
    executed: number;
    max: number;
  };
  expiresIn: string;
  createdAt: string;
}

interface ListSubAgentsResult {
  success: boolean;
  message: string;
  subAgents: SubAgentSummary[];
  summary: {
    total: number;
    running: number;
    completed: number;
    failed: number;
    revoked: number;
  };
  error?: string;
}

export function registerListSubAgents(server: McpServer): void {
  server.tool(
    "list_sub_agents",
    "List all sub-agents with their status, budget remaining, and trade counts. " +
      "Use to monitor autonomous trading agents. " +
      "Filter by status to see only running, completed, or failed agents.",
    ListSubAgentsSchema.shape,
    async (params): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await listSubAgentsHandler(
        params as z.infer<typeof ListSubAgentsSchema>
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}

/**
 * Format state to summary
 */
function formatSubAgentSummary(state: SubAgentState): SubAgentSummary {
  const monAllocated = BigInt(state.budget.monAllocated);
  const monSpent = BigInt(state.budget.monSpent);

  // Count unique tokens with spending tracked
  const tokensTracked = state.budget.tokenSpent
    ? Object.keys(state.budget.tokenSpent).length
    : 0;

  return {
    id: state.id,
    agentType: state.agentType,
    status: state.status,
    walletAddress: state.walletAddress,
    budget: {
      monRemaining: formatEther(monAllocated - monSpent) + " MON",
      tokensTracked,
    },
    trades: {
      executed: state.trades.executed,
      max: state.trades.maxAllowed,
    },
    expiresIn: formatTimeRemaining(state.expiresAt),
    createdAt: new Date(state.createdAt).toISOString(),
  };
}

async function listSubAgentsHandler(
  params: z.infer<typeof ListSubAgentsSchema>
): Promise<ListSubAgentsResult> {
  try {
    const config = await loadConfig();
    if (!config?.wallet) {
      return {
        success: false,
        message: "Wallet not configured",
        subAgents: [],
        summary: { total: 0, running: 0, completed: 0, failed: 0, revoked: 0 },
        error: "Please run setup_wallet first",
      };
    }

    // Load all agent states
    const allStates = await listAgentStates();

    // Filter by status if specified
    let filteredStates = allStates;
    if (params.status && params.status !== "all") {
      filteredStates = allStates.filter((s) => s.status === params.status);
    }

    // Format summaries
    const subAgents = filteredStates.map(formatSubAgentSummary);

    // Build summary counts
    const summary = {
      total: allStates.length,
      running: allStates.filter((s) => s.status === "running").length,
      completed: allStates.filter((s) => s.status === "completed").length,
      failed: allStates.filter((s) => s.status === "failed").length,
      revoked: allStates.filter((s) => s.status === "revoked").length,
    };

    // Build message
    let message: string;
    if (allStates.length === 0) {
      message = "No sub-agents found";
    } else if (params.status && params.status !== "all") {
      message = `Found ${filteredStates.length} ${params.status} sub-agent(s)`;
    } else {
      message = `Found ${allStates.length} sub-agent(s): ${summary.running} running, ${summary.completed} completed`;
    }

    return {
      success: true,
      message,
      subAgents,
      summary,
    };
  } catch (error) {
    return {
      success: false,
      message: "Failed to list sub-agents",
      subAgents: [],
      summary: { total: 0, running: 0, completed: 0, failed: 0, revoked: 0 },
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

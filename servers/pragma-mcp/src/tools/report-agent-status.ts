// Report Agent Status Tool
// Allows sub-agents to report their status (running, paused, completed, failed)
// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadConfig } from "../config/pragma-config.js";
import { loadAgentState, updateAgentState } from "../core/subagent/index.js";

const ReportAgentStatusSchema = z.object({
  agentId: z.string().describe("The sub-agent ID (UUID) reporting its status"),
  status: z
    .enum(["running", "paused", "completed", "failed"])
    .describe(
      "The new status: " +
        "'running' = actively working, " +
        "'paused' = temporarily stopped (e.g., low gas), can resume, " +
        "'completed' = user's goal was achieved, " +
        "'failed' = user's goal was NOT achieved (expired, error, budget depleted, etc.)"
    ),
  reason: z
    .string()
    .optional()
    .describe(
      "Optional reason for the status. Examples: " +
        "'Task achieved - opened BTC long at $95,200', " +
        "'Low gas - 0.05 MON remaining', " +
        "'Delegation expired - target not reached', " +
        "'Max trades reached (10/10) - target not achieved'"
    ),
});

interface ReportAgentStatusResult {
  success: boolean;
  message: string;
  previousStatus?: string;
  newStatus?: string;
  reason?: string;
  error?: string;
}

export function registerReportAgentStatus(server: McpServer): void {
  server.tool(
    "report_agent_status",
    "Report sub-agent status. Sub-agents MUST call this to report their status: " +
      "when task is completed/failed, when pausing (low gas), or when resuming. " +
      "This is the unified method for all status updates.",
    ReportAgentStatusSchema.shape,
    async (
      params
    ): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await reportAgentStatusHandler(
        params as z.infer<typeof ReportAgentStatusSchema>
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}

async function reportAgentStatusHandler(
  params: z.infer<typeof ReportAgentStatusSchema>
): Promise<ReportAgentStatusResult> {
  try {
    const config = await loadConfig();
    if (!config?.wallet) {
      return {
        success: false,
        message: "Wallet not configured",
        error: "Please run setup_wallet first",
      };
    }

    // Load current agent state
    const state = await loadAgentState(params.agentId);
    if (!state) {
      return {
        success: false,
        message: "Sub-agent not found",
        error: `No sub-agent found with ID: ${params.agentId}`,
      };
    }

    const previousStatus = state.status;

    // Don't allow updating revoked agents
    if (state.status === "revoked") {
      return {
        success: false,
        message: "Cannot update revoked agent",
        error: "This sub-agent has been revoked and cannot be updated",
      };
    }

    // Update the status
    await updateAgentState(params.agentId, { status: params.status });

    return {
      success: true,
      message: `Status updated: ${previousStatus} → ${params.status}`,
      previousStatus,
      newStatus: params.status,
      reason: params.reason,
    };
  } catch (error) {
    return {
      success: false,
      message: "Failed to report status",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

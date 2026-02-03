// Write Agent Memo Tool
// Allows sub-agents to persist structured state to their journal
// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadAgentState, appendJournal } from "../core/subagent/index.js";

const WriteAgentMemoSchema = z.object({
  agentId: z
    .string()
    .describe("The sub-agent ID (UUID) writing the memo"),
  text: z
    .string()
    .describe(
      "The memo content. Use structured format for readability. " +
        "Examples: macro baselines, watchlists with trigger levels, " +
        "kill switch results, bear case arguments, position health snapshots."
    ),
  tag: z
    .string()
    .optional()
    .describe(
      "Category tag for retrieval via get_agent_log(tag: ...). " +
        "Recommended tags: 'baseline' (Phase 1 macro snapshot), " +
        "'watchlist' (Phase 2 pair watchlist with trigger levels), " +
        "'trade_plan' (Phase 3 kill switch + bear case + trade params), " +
        "'position_health' (Phase 5 monitoring snapshot), " +
        "'scan_result' (Phase 5 opportunity scan output), " +
        "'post_trade' (Phase 6/7 session summary)."
    ),
});

interface WriteAgentMemoResult {
  success: boolean;
  message: string;
  tag?: string;
  error?: string;
}

export function registerWriteAgentMemo(server: McpServer): void {
  server.tool(
    "write_agent_memo",
    "Write a memo to the agent's journal. Use this to persist structured state " +
      "(macro baselines, watchlists, trade reasoning, position health checks) that survives " +
      "context compaction. Read back with get_agent_log(tag: '...'). " +
      "Zero cost — no delegation calls consumed.",
    WriteAgentMemoSchema.shape,
    async (params): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await writeAgentMemoHandler(
        params as z.infer<typeof WriteAgentMemoSchema>
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}

async function writeAgentMemoHandler(
  params: z.infer<typeof WriteAgentMemoSchema>
): Promise<WriteAgentMemoResult> {
  try {
    const state = await loadAgentState(params.agentId);
    if (!state) {
      return {
        success: false,
        message: "Sub-agent not found",
        error: `No sub-agent found with ID: ${params.agentId}`,
      };
    }

    if (state.status === "revoked") {
      return {
        success: false,
        message: "Cannot write memo to revoked agent",
        error: "This sub-agent has been revoked and cannot accept new memos",
      };
    }

    appendJournal(params.agentId, {
      ts: Date.now(),
      type: "memo",
      text: params.text,
      tag: params.tag,
    });

    return {
      success: true,
      message: params.tag
        ? `Memo saved with tag: ${params.tag}`
        : "Memo saved",
      tag: params.tag,
    };
  } catch (error) {
    return {
      success: false,
      message: "Failed to write memo",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

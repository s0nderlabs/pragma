// Get Agent Log Tool
// Returns paginated journal entries for a sub-agent
// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadJournal, agentExists } from "../core/subagent/index.js";

const GetAgentLogSchema = z.object({
  agentId: z
    .string()
    .describe("The sub-agent ID (UUID) to get journal entries for"),
  offset: z
    .number()
    .min(0)
    .optional()
    .describe("Number of entries to skip from the start. Default: 0 (most recent first)"),
  limit: z
    .number()
    .min(1)
    .max(200)
    .optional()
    .describe("Max number of entries to return. Default: 50, max: 200"),
  tag: z
    .string()
    .optional()
    .describe(
      "Filter entries by tag. Only returns entries with matching tag. " +
        "Common tags: baseline, watchlist, trade_plan, position_health, scan_result, post_trade"
    ),
});

interface GetAgentLogResult {
  success: boolean;
  message: string;
  data?: {
    entries: Array<{
      timestamp: string;
      type: string;
      summary: string;
    }>;
    metadata: {
      total: number;
      showing: number;
      offset: number;
    };
  };
  error?: string;
}

export function registerGetAgentLog(server: McpServer): void {
  server.tool(
    "get_agent_log",
    "Get paginated journal log for a sub-agent. Shows trade events, reasoning, status changes, and errors. " +
      "Use offset/limit for pagination. Entries are ordered newest first.",
    GetAgentLogSchema.shape,
    async (params): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await getAgentLogHandler(params as z.infer<typeof GetAgentLogSchema>);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}

async function getAgentLogHandler(
  params: z.infer<typeof GetAgentLogSchema>
): Promise<GetAgentLogResult> {
  try {
    if (!agentExists(params.agentId)) {
      return {
        success: false,
        message: "Sub-agent not found",
        error: `No sub-agent found with ID: ${params.agentId}`,
      };
    }

    const offset = params.offset ?? 0;
    const limit = params.limit ?? 50;
    const filter = params.tag ? { tag: params.tag } : undefined;

    const { entries, total } = loadJournal(params.agentId, offset, limit, filter);

    if (entries.length === 0 && total === 0) {
      return {
        success: true,
        message: "No journal entries found for this agent.",
        data: {
          entries: [],
          metadata: { total: 0, showing: 0, offset },
        },
      };
    }

    // Format entries as readable one-liners (newest first)
    const formatted = entries.reverse().map(entry => {
      const ts = new Date(entry.ts).toLocaleString();
      const parts: string[] = [];

      if (entry.pair) parts.push(entry.pair);
      if (entry.side) parts.push(entry.side);
      if (entry.margin) parts.push(`margin:${entry.margin}`);
      if (entry.leverage) parts.push(`${entry.leverage}x`);
      if (entry.pnl) parts.push(`pnl:${entry.pnl}`);
      if (entry.txHash) parts.push(`tx:${entry.txHash.slice(0, 10)}...`);

      const summary = entry.text || parts.join(" | ") || entry.type;

      return {
        timestamp: ts,
        type: entry.type,
        summary,
      };
    });

    return {
      success: true,
      message: `Showing ${entries.length} of ${total} journal entries`,
      data: {
        entries: formatted,
        metadata: {
          total,
          showing: entries.length,
          offset,
        },
      },
    };
  } catch (error) {
    return {
      success: false,
      message: "Failed to load agent journal",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

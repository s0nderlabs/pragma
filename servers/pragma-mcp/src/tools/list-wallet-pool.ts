// List Wallet Pool Tool
// Lists all wallets in the sub-agent wallet pool
// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listPoolWallets } from "../core/subagent/index.js";

const ListWalletPoolSchema = z.object({
  filter: z
    .enum(["all", "idle", "active"])
    .default("all")
    .describe(
      "Filter wallets by status. " +
        "idle = available for new agents, " +
        "active = currently assigned to an agent, " +
        "all = show everything. Default: all"
    ),
});

interface WalletPoolEntry {
  id: string;
  address: string;
  status: string;
  assignedTo: string | null;
  lastUsedAt: string;
}

interface ListWalletPoolResult {
  success: boolean;
  message: string;
  data?: {
    wallets: WalletPoolEntry[];
    summary: {
      total: number;
      idle: number;
      active: number;
    };
  };
  error?: string;
}

export function registerListWalletPool(server: McpServer): void {
  server.tool(
    "list_wallet_pool",
    "List all wallets in the sub-agent wallet pool. " +
      "Shows wallet addresses, status (idle/active), and which agent they are assigned to.",
    ListWalletPoolSchema.shape,
    async (
      params
    ): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = listWalletPoolHandler(
        params as z.infer<typeof ListWalletPoolSchema>
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}

function listWalletPoolHandler(
  params: z.infer<typeof ListWalletPoolSchema>
): ListWalletPoolResult {
  try {
    const filterArg = params.filter === "all" ? undefined : params.filter;
    const wallets = listPoolWallets(filterArg);

    // Always compute summary from full pool
    const allWallets = params.filter === "all" ? wallets : listPoolWallets();
    const idle = allWallets.filter((w) => w.status === "idle").length;
    const active = allWallets.filter((w) => w.status === "active").length;

    const formatted: WalletPoolEntry[] = wallets.map((w) => ({
      id: w.id,
      address: w.address,
      status: w.status,
      assignedTo: w.assignedTo,
      lastUsedAt: new Date(w.lastUsedAt).toISOString(),
    }));

    if (wallets.length === 0) {
      return {
        success: true,
        message:
          params.filter === "all"
            ? "Wallet pool is empty. A wallet will be created when you create a sub-agent."
            : `No ${params.filter} wallets in pool.`,
        data: {
          wallets: [],
          summary: { total: allWallets.length, idle, active },
        },
      };
    }

    return {
      success: true,
      message: `${wallets.length} wallet${wallets.length > 1 ? "s" : ""} in pool (${idle} idle, ${active} active)`,
      data: {
        wallets: formatted,
        summary: { total: allWallets.length, idle, active },
      },
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return {
      success: false,
      message: "Failed to list wallet pool",
      error: errorMessage,
    };
  }
}

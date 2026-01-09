// Get Balance Tool
// Retrieves token balances for the smart account

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const GetBalanceSchema = z.object({
  tokens: z
    .array(z.string())
    .optional()
    .describe(
      "Optional list of token symbols or addresses to check. If not provided, returns MON, WMON, and common tokens."
    ),
});

export function registerGetBalance(server: McpServer): void {
  server.tool(
    "get_balance",
    "Get token balances for the pragma wallet. Returns native MON and ERC20 token balances. Use this before swaps or transfers to check available funds.",
    GetBalanceSchema.shape,
    async (params) => {
      // TODO: Implement
      // 1. Load config to get smart account address
      // 2. Query RPC for native balance
      // 3. Query ERC20 balances for requested tokens
      // 4. Format and return balances
      throw new Error("Not implemented");
    }
  );
}

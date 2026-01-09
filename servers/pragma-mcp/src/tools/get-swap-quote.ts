// Get Swap Quote Tool
// Fetches swap quote from Monorail API

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const GetSwapQuoteSchema = z.object({
  fromToken: z
    .string()
    .describe("Token to sell (symbol like 'MON' or 'WMON', or address)"),
  toToken: z
    .string()
    .describe("Token to buy (symbol like 'USDC' or address)"),
  amount: z
    .string()
    .describe("Amount to swap in human-readable format (e.g., '1.5' for 1.5 tokens)"),
});

export function registerGetSwapQuote(server: McpServer): void {
  server.tool(
    "get_swap_quote",
    "Get a swap quote from Monorail DEX aggregator. Returns expected output, price impact, and route. Quote is valid for ~30 seconds. Always show the quote to the user before executing.",
    GetSwapQuoteSchema.shape,
    async (params) => {
      // TODO: Implement
      // 1. Resolve token symbols to addresses
      // 2. Convert amount to wei
      // 3. Call Monorail pathfinder API
      // 4. Parse response and calculate price impact
      // 5. Return quote with expiry
      throw new Error("Not implemented");
    }
  );
}

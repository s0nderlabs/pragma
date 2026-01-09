// Transfer Tool
// Transfers tokens to another address

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const TransferSchema = z.object({
  token: z
    .string()
    .describe("Token to transfer (symbol like 'MON' or 'WMON', or address)"),
  to: z
    .string()
    .describe("Recipient address (0x...)"),
  amount: z
    .string()
    .describe("Amount to transfer in human-readable format (e.g., '1.5' for 1.5 tokens)"),
});

export function registerTransfer(server: McpServer): void {
  server.tool(
    "transfer",
    "Transfer tokens to another address. Requires user confirmation via passkey (Touch ID). Always verify the recipient address with the user before executing.",
    TransferSchema.shape,
    async (params) => {
      // TODO: Implement
      // 1. Resolve token symbol to address
      // 2. Validate recipient address
      // 3. Convert amount to wei
      // 4. Build transfer calldata
      // 5. Create delegation with exact calldata enforcer
      // 6. Request passkey signature (Touch ID)
      // 7. Execute via session key
      // 8. Return transaction result
      throw new Error("Not implemented");
    }
  );
}

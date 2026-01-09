// Stake Tool
// Stakes MON to aPriori for aprMON

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const StakeSchema = z.object({
  amount: z
    .string()
    .describe("Amount of MON to stake in human-readable format (e.g., '10' for 10 MON)"),
});

export function registerStake(server: McpServer): void {
  server.tool(
    "stake",
    "Stake MON to aPriori protocol to receive aprMON (liquid staking token). Requires user confirmation via passkey (Touch ID). Check balance first to ensure sufficient MON.",
    StakeSchema.shape,
    async (params) => {
      // TODO: Implement
      // 1. Validate amount
      // 2. Check MON balance is sufficient
      // 3. Build stake calldata for aPriori
      // 4. Create delegation with exact calldata enforcer
      // 5. Request passkey signature (Touch ID)
      // 6. Execute via session key
      // 7. Return transaction result with aprMON received
      throw new Error("Not implemented");
    }
  );
}

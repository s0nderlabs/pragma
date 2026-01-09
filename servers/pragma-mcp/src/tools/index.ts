// pragma Tool Registration
// Registers all MCP tools with the server

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSetupWallet } from "./setup-wallet.js";
import { registerGetBalance } from "./get-balance.js";
import { registerGetSwapQuote } from "./get-swap-quote.js";
import { registerExecuteSwap } from "./execute-swap.js";
import { registerTransfer } from "./transfer.js";
import { registerStake } from "./stake.js";

export function registerTools(server: McpServer): void {
  // Wallet setup
  registerSetupWallet(server);

  // Balance checking
  registerGetBalance(server);

  // Swap operations
  registerGetSwapQuote(server);
  registerExecuteSwap(server);

  // Transfer operations
  registerTransfer(server);

  // Staking operations
  registerStake(server);
}

// pragma Tool Registration
// Registers all MCP tools with the server

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerHasWallet } from "./has-wallet.js";
import { registerHasProviders } from "./has-providers.js";
import { registerSetupWallet } from "./setup-wallet.js";
import { registerGetBalance } from "./get-balance.js";
import { registerGetAllBalances } from "./get-all-balances.js";
import { registerGetSwapQuote } from "./get-swap-quote.js";
import { registerExecuteSwap } from "./execute-swap.js";
import { registerTransfer } from "./transfer.js";
import { registerWrap, registerUnwrap } from "./wrap.js";
import { registerStake } from "./stake.js";
import { registerCheckSessionKeyBalance } from "./check-session-key-balance.js";
import { registerFundSessionKey } from "./fund-session-key.js";
import { registerListVerifiedTokens } from "./list-verified-tokens.js";
import { registerSetMode } from "./set-mode.js";
import { registerGetAccountInfo } from "./get-account-info.js";
import { registerGetTokenInfo } from "./get-token-info.js";
import { registerWithdrawSessionKey } from "./withdraw-session-key.js";

export function registerTools(server: McpServer): void {
  // Wallet checks (safe, read-only)
  registerHasWallet(server);
  registerHasProviders(server);

  // Wallet setup
  registerSetupWallet(server);

  // Mode switching (BYOK vs x402)
  registerSetMode(server);

  // Balance checking
  registerGetBalance(server);
  registerGetAllBalances(server);

  // Token discovery
  registerListVerifiedTokens(server);
  registerGetTokenInfo(server);

  // Account info
  registerGetAccountInfo(server);

  // Session key management
  registerCheckSessionKeyBalance(server);
  registerFundSessionKey(server);
  registerWithdrawSessionKey(server);

  // Swap operations
  registerGetSwapQuote(server);
  registerExecuteSwap(server);

  // Transfer operations
  registerTransfer(server);

  // Wrap/unwrap operations
  registerWrap(server);
  registerUnwrap(server);

  // Staking operations
  registerStake(server);
}

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
import { registerGetBlock } from "./get-block.js";
import { registerGetGasPrice } from "./get-gas-price.js";
import { registerExplainTransaction } from "./explain-transaction.js";
import { registerGetOnchainActivity } from "./get-onchain-activity.js";
import { registerExplainContract } from "./explain-contract.js";
import { registerNadFunStatus } from "./nadfun-status.js";
import { registerNadFunQuote } from "./nadfun-quote.js";
import { registerNadFunBuy } from "./nadfun-buy.js";
import { registerNadFunSell } from "./nadfun-sell.js";
import { registerNadFunDiscover } from "./nadfun-discover.js";
import { registerNadFunTokenInfo } from "./nadfun-token-info.js";
import { registerNadFunPositions } from "./nadfun-positions.js";
import { registerNadFunCreate } from "./nadfun-create.js";

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

  // Direct RPC tools (work in both BYOK and x402 modes)
  registerGetBlock(server);
  registerGetGasPrice(server);

  // On-chain activity tools (x402 mode only - require API infrastructure)
  registerExplainTransaction(server);
  registerGetOnchainActivity(server);
  registerExplainContract(server);

  // nad.fun bonding curve tools (work in both BYOK and x402 modes)
  registerNadFunStatus(server);
  registerNadFunQuote(server);
  registerNadFunBuy(server);
  registerNadFunSell(server);

  // nad.fun discovery tools (HTTP API - work in both BYOK and x402 modes)
  registerNadFunDiscover(server);
  registerNadFunTokenInfo(server);
  registerNadFunPositions(server);

  // nad.fun token creation (HTTP API + on-chain - works in both BYOK and x402 modes)
  registerNadFunCreate(server);
}

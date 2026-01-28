// Autonomous Execution Module
// Enables sub-agents to execute trades using pre-signed delegation chains
// Copyright (c) 2026 s0nderlabs

import {
  createPublicClient,
  createWalletClient,
  parseUnits,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  type Address,
  type Hex,
} from "viem";
import {
  redeemDelegations,
  createExecution,
  ExecutionMode,
} from "@metamask/smart-accounts-kit";
import type { SignedDelegation } from "../delegation/types.js";
import {
  loadAgentState,
  loadDelegation,
  appendTrade,
  updateTokenSpent,
  updateAgentState,
  addError,
  NATIVE_TOKEN_ADDRESS,
  type TradeRecord,
} from "../subagent/state.js";
import { getFullWallet, getSubAgentAccount } from "../subagent/index.js";
import { loadConfig, getRpcUrl } from "../../config/pragma-config.js";
import { buildViemChain, getChainConfig } from "../../config/chains.js";
import { createSyncHttpTransport } from "../x402/client.js";
import { waitForReceiptSync } from "../rpc/index.js";
import { DELEGATION_FRAMEWORK, WHITELISTED_SPENDERS, ERC20_APPROVE_SELECTOR, DELEGATION_GROUPS } from "../../config/constants.js";
import { setLogicalOrArgs } from "../delegation/logical-or.js";
import {
  getCachedNadFunQuote,
  getNadFunQuoteExecutionData,
  isNadFunQuoteExpired,
  deleteNadFunQuote,
} from "../nadfun/quote.js";
import type { NadFunExecuteResponse } from "../nadfun/types.js";
import {
  executeCloseTrade,
  executeOpenTrade,
  executeOpenLimitOrder,
  executeUpdateTpSl,
  executeAddMargin,
  executeCancelLimitOrder,
  executeBatchCancelLimitOrders,
  type CollateralToken,
} from "../leverup/execution.js";
import {
  getLeverUpQuote,
  getLimitOrderQuote,
  isDegenModeLeverage,
  getMaxTpPercent,
  getCollateralDecimals,
} from "../leverup/client.js";
import {
  SUPPORTED_PAIRS,
  DEGEN_MODE_LEVERAGE_OPTIONS,
  WMON_ADDRESS,
  USDC_ADDRESS,
  LVUSD_ADDRESS,
  LVMON_ADDRESS,
} from "../leverup/constants.js";
import {
  getCachedQuote,
  getQuoteExecutionData,
  isQuoteExpired,
} from "../aggregator/index.js";
import { resolveToken } from "../data/client.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Execution parameters for autonomous trade
 */
export interface AutonomousExecution {
  target: Address;
  value: bigint;
  callData: Hex;
}

/**
 * Result of autonomous execution
 */
export interface AutonomousExecutionResult {
  success: boolean;
  txHash?: Hex;
  explorerUrl?: string;
  error?: string;
}

/**
 * Trade information for logging
 */
export interface TradeInfo {
  action: TradeRecord["action"];
  protocol: TradeRecord["protocol"];
  details: TradeRecord["details"];
}

// ============================================================================
// Core Execution Function
// ============================================================================

/**
 * Options for delegation chain execution
 */
export interface ExecutionOptions {
  /** Skip budget tracking for this execution (e.g., for approvals) */
  skipBudgetTracking?: boolean;
  /** Skip trade logging for this execution (e.g., for approvals) */
  skipTradeLogging?: boolean;
}

/**
 * Execute a trade using the sub-agent's delegation chain
 *
 * Key differences from assistant mode:
 * - Uses stored delegation chain (no Touch ID)
 * - Sub-agent wallet broadcasts (not session key)
 * - permissionContext contains [rootDelegation, subDelegation]
 *
 * @param agentId - Sub-agent ID
 * @param execution - Transaction to execute
 * @param tradeInfo - Trade metadata for logging
 * @param options - Execution options (skipBudgetTracking, skipTradeLogging)
 */
export async function executeWithDelegationChain(
  agentId: string,
  execution: AutonomousExecution,
  tradeInfo: TradeInfo,
  options?: ExecutionOptions
): Promise<AutonomousExecutionResult> {
  const config = await loadConfig();
  if (!config?.wallet) {
    return { success: false, error: "Wallet not configured" };
  }

  // 1. Load and validate agent state
  const state = await loadAgentState(agentId);
  if (!state) {
    return { success: false, error: `Agent not found: ${agentId}` };
  }

  if (state.status !== "running") {
    return { success: false, error: `Agent not running (status: ${state.status})` };
  }

  if (Date.now() > state.expiresAt) {
    await updateAgentState(agentId, { status: "failed" });
    return { success: false, error: "Delegation expired" };
  }

  if (state.trades.executed >= state.trades.maxAllowed) {
    await updateAgentState(agentId, { status: "completed" });
    return { success: false, error: "Max trades reached" };
  }

  // 2. Load delegation chain
  const storedDelegation = await loadDelegation(agentId);
  if (!storedDelegation?.rootDelegation || !storedDelegation?.signedDelegation) {
    return { success: false, error: "Missing delegation chain in storage" };
  }

  // 3. Validate budget for native MON (skip for approvals)
  if (execution.value > 0n && !options?.skipBudgetTracking) {
    const monAllocated = BigInt(state.budget.monAllocated);
    const monSpent = BigInt(state.budget.monSpent);
    if (monSpent + execution.value > monAllocated) {
      return {
        success: false,
        error: `Insufficient MON budget. Allocated: ${monAllocated}, Spent: ${monSpent}, Required: ${execution.value}`,
      };
    }
  }

  // 4. Load sub-agent wallet from Keychain
  const subAgentWallet = await getFullWallet(state.walletId);
  if (!subAgentWallet) {
    return { success: false, error: "Sub-agent wallet not found in Keychain" };
  }

  // 5. Build clients
  const chainId = config.network.chainId;
  const rpcUrl = await getRpcUrl(config);
  const chain = buildViemChain(chainId, rpcUrl);
  const chainConfig = getChainConfig(chainId);

  const publicClient = createPublicClient({
    chain,
    transport: createSyncHttpTransport(rpcUrl, config),
  });

  // Check sub-agent gas balance
  const subAgentBalance = await publicClient.getBalance({
    address: subAgentWallet.address,
  });
  if (subAgentBalance < 10000000000000000n) {
    // 0.01 MON minimum for gas
    return {
      success: false,
      error: `Sub-agent wallet needs gas. Balance: ${subAgentBalance} wei. Fund with fund_sub_agent tool.`,
    };
  }

  const subAgentAccount = getSubAgentAccount(subAgentWallet);
  const subAgentWalletClient = createWalletClient({
    account: subAgentAccount,
    chain,
    transport: createSyncHttpTransport(rpcUrl, config),
  });

  // 6. Build delegation chain with LogicalOrWrapperEnforcer group selection
  // Order matters: INNERMOST first (caller's delegation), then parent delegations
  // delegations_[0].delegate must equal msg.sender (sub-agent wallet)
  //
  // CRITICAL: We must clone delegations and set the LogicalOr args to select
  // the correct group (APPROVE or TRADING) based on the calldata.
  // The args field is NOT signed, so this doesn't invalidate signatures.

  // Clone delegations to avoid mutating stored state
  const rootDelegation = structuredClone(storedDelegation.rootDelegation);
  const subDelegation = structuredClone(storedDelegation.signedDelegation);

  // Determine which group to use based on the function being called
  // Group 0 (APPROVE): For ERC20 approve() calls on arbitrary tokens
  // Group 1 (TRADING): For trading calls to whitelisted protocols
  const isApproveCall = execution.callData.toLowerCase().startsWith(ERC20_APPROVE_SELECTOR.toLowerCase());
  const groupIndex = isApproveCall ? DELEGATION_GROUPS.APPROVE : DELEGATION_GROUPS.TRADING;

  // Set LogicalOrWrapperEnforcer args on BOTH delegations in the chain
  // Both delegations have the LogicalOr caveat and need the same group selected
  setLogicalOrArgs(rootDelegation, groupIndex);
  setLogicalOrArgs(subDelegation, groupIndex);

  const delegationChain = [
    subDelegation, // Main Agent → Sub-Agent (delegate = sub-agent = msg.sender)
    rootDelegation, // User → Main Agent (parent delegation)
  ] as SignedDelegation[];

  // 7. Execute via redeemDelegations
  try {
    const txHash = await redeemDelegations(
      subAgentWalletClient,
      publicClient,
      DELEGATION_FRAMEWORK.delegationManager,
      [
        {
          permissionContext: delegationChain,
          executions: [
            createExecution({
              target: execution.target,
              value: execution.value,
              callData: execution.callData,
            }),
          ],
          mode: ExecutionMode.SingleDefault,
        },
      ]
    );

    const receipt = await waitForReceiptSync(publicClient, txHash);

    if (receipt.status === "reverted") {
      await addError(agentId, "Transaction reverted on-chain", true);
      return { success: false, txHash, error: "Transaction reverted on-chain" };
    }

    // 8. Update state on success (skip for approvals)
    if (!options?.skipTradeLogging) {
      await appendTrade(agentId, {
        timestamp: Date.now(),
        action: tradeInfo.action,
        protocol: tradeInfo.protocol,
        details: tradeInfo.details,
        txHash,
        success: true,
      });
    }

    // Track native MON spent (skip for approvals)
    if (execution.value > 0n && !options?.skipBudgetTracking) {
      await updateTokenSpent(agentId, NATIVE_TOKEN_ADDRESS, execution.value);
    }

    return {
      success: true,
      txHash,
      explorerUrl: `${chainConfig.blockExplorer}/tx/${txHash}`,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    await addError(agentId, msg, true);
    return { success: false, error: msg };
  }
}

// ============================================================================
// ERC20 Approval Functions
// ============================================================================

/**
 * Check if a spender address is whitelisted for autonomous approvals
 *
 * Security: Only these addresses can receive ERC20 approvals via delegation:
 * - DEX Router
 * - LeverUp Diamond
 * - nad.fun Router
 *
 * @param spender - Address to check
 */
export function isSpenderWhitelisted(spender: Address): boolean {
  const lowerSpender = spender.toLowerCase();
  return Object.values(WHITELISTED_SPENDERS).some(
    addr => addr.toLowerCase() === lowerSpender
  );
}

/**
 * Check current ERC20 allowance
 *
 * @param publicClient - Viem public client
 * @param token - ERC20 token address
 * @param owner - Token owner (user's smart account)
 * @param spender - Spender to check allowance for
 * @param required - Required amount (returns true if allowance >= required)
 */
export async function checkApproval(
  publicClient: ReturnType<typeof createPublicClient>,
  token: Address,
  owner: Address,
  spender: Address,
  required: bigint
): Promise<{ hasApproval: boolean; currentAllowance: bigint }> {
  try {
    const allowance = await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [owner, spender],
    });

    return {
      hasApproval: allowance >= required,
      currentAllowance: allowance,
    };
  } catch {
    // If we can't read allowance, assume no approval
    return { hasApproval: false, currentAllowance: 0n };
  }
}

/**
 * Execute ERC20 approve using autonomous mode
 *
 * Uses MaxUint256 for efficiency (single approval enables all future trades).
 * Security is maintained via:
 * 1. Whitelist validation in code
 * 2. AllowedTargetsEnforcer on-chain
 *
 * @param agentId - Sub-agent ID
 * @param token - ERC20 token address to approve
 * @param spender - Spender address (must be whitelisted)
 */
export async function executeAutonomousApproval(
  agentId: string,
  token: Address,
  spender: Address
): Promise<AutonomousExecutionResult> {
  // Security: Validate spender is whitelisted
  if (!isSpenderWhitelisted(spender)) {
    return {
      success: false,
      error: `Spender ${spender} is not whitelisted for autonomous approvals. ` +
        `Whitelisted: ${Object.entries(WHITELISTED_SPENDERS).map(([k, v]) => `${k}: ${v}`).join(", ")}`,
    };
  }

  // Use MaxUint256 for unlimited approval
  const maxApproval = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");

  const approveCalldata = encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [spender, maxApproval],
  });

  // Execute with skipBudgetTracking and skipTradeLogging (approvals are overhead, not trades)
  return await executeWithDelegationChain(
    agentId,
    {
      target: token,
      value: 0n,
      callData: approveCalldata,
    },
    {
      action: "other",
      protocol: "other",
      details: {
        operation: "approve",
        token: token,
        spender: spender,
      },
    },
    {
      skipBudgetTracking: true,
      skipTradeLogging: true,
    }
  );
}

/**
 * Execute a trade with automatic approval if needed
 *
 * This is the main entry point for trades that may require ERC20 approval.
 * It checks if approval exists, executes approval if needed, then executes the trade.
 *
 * @param agentId - Sub-agent ID
 * @param token - ERC20 token address that needs approval
 * @param spender - Spender that needs approval (must be whitelisted)
 * @param requiredAmount - Minimum amount that needs to be approved
 * @param tradeExecution - The actual trade execution data
 * @param tradeInfo - Trade metadata for logging
 */
export async function executeWithApprovalIfNeeded(
  agentId: string,
  token: Address,
  spender: Address,
  requiredAmount: bigint,
  tradeExecution: AutonomousExecution,
  tradeInfo: TradeInfo
): Promise<AutonomousExecutionResult> {
  const config = await loadConfig();
  if (!config?.wallet) {
    return { success: false, error: "Wallet not configured" };
  }

  // Skip approval check for native MON (NATIVE_TOKEN_ADDRESS)
  if (token.toLowerCase() === NATIVE_TOKEN_ADDRESS.toLowerCase()) {
    return await executeWithDelegationChain(agentId, tradeExecution, tradeInfo);
  }

  // Validate spender is whitelisted
  if (!isSpenderWhitelisted(spender)) {
    return {
      success: false,
      error: `Spender ${spender} is not whitelisted for autonomous approvals.`,
    };
  }

  // Build client to check allowance
  const chainId = config.network.chainId;
  const rpcUrl = await getRpcUrl(config);
  const chain = buildViemChain(chainId, rpcUrl);

  const publicClient = createPublicClient({
    chain,
    transport: createSyncHttpTransport(rpcUrl, config),
  });

  // Get user's smart account address (owner of tokens)
  const owner = config.wallet.smartAccountAddress as Address;

  // Check current allowance
  const { hasApproval } = await checkApproval(
    publicClient,
    token,
    owner,
    spender,
    requiredAmount
  );

  // Execute approval if needed
  if (!hasApproval) {
    const approvalResult = await executeAutonomousApproval(agentId, token, spender);
    if (!approvalResult.success) {
      return {
        success: false,
        error: `Approval failed: ${approvalResult.error}`,
      };
    }
    // Small delay to ensure approval is indexed
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // Execute the actual trade
  return await executeWithDelegationChain(agentId, tradeExecution, tradeInfo);
}

// ============================================================================
// Protocol-Specific Wrappers: nad.fun
// ============================================================================

/**
 * Execute nad.fun buy using autonomous mode
 *
 * @param agentId - Sub-agent ID
 * @param quoteId - Quote ID from nadfun_quote
 */
export async function executeAutonomousNadFunBuy(
  agentId: string,
  quoteId: string
): Promise<NadFunExecuteResponse> {
  // Get quote and execution data
  const quote = getCachedNadFunQuote(quoteId);
  if (!quote) {
    return {
      success: false,
      message: "Quote not found",
      error: "Quote not found or expired. Please get a fresh quote with nadfun_quote.",
    };
  }

  if (isNadFunQuoteExpired(quote)) {
    deleteNadFunQuote(quoteId);
    return {
      success: false,
      message: "Quote expired",
      error: "Quote has expired. Please get a fresh quote with nadfun_quote.",
    };
  }

  if (quote.direction !== "BUY") {
    return {
      success: false,
      message: "Wrong quote type",
      error: "This quote is for selling, not buying. Use nadfun_sell instead.",
    };
  }

  const executionData = getNadFunQuoteExecutionData(quoteId);
  if (!executionData) {
    return {
      success: false,
      message: "Execution data missing",
      error: "Execution data missing. Please get a fresh quote.",
    };
  }

  // Execute using delegation chain
  const result = await executeWithDelegationChain(
    agentId,
    {
      target: executionData.router,
      value: executionData.value,
      callData: executionData.calldata,
    },
    {
      action: "buy",
      protocol: "nadfun",
      details: {
        token: quote.tokenSymbol,
        tokenOutAddress: quote.token as Address,
        amountIn: quote.amountIn,
        amountOut: quote.expectedOutput,
      },
    }
  );

  if (!result.success) {
    return {
      success: false,
      message: "Autonomous buy failed",
      error: result.error,
    };
  }

  // Clean up quote on success
  deleteNadFunQuote(quoteId);

  return {
    success: true,
    message: `Successfully bought ${quote.expectedOutput} ${quote.tokenSymbol} for ${quote.amountIn} MON (autonomous)`,
    transaction: {
      hash: result.txHash!,
      explorerUrl: result.explorerUrl!,
    },
    trade: {
      tokenSymbol: quote.tokenSymbol,
      monSpent: quote.amountIn,
      tokensReceived: quote.expectedOutput,
      progress: quote.progressPercent,
    },
  };
}

/**
 * Execute nad.fun sell using autonomous mode
 *
 * Automatically handles ERC20 approval if needed.
 * Uses executeWithApprovalIfNeeded for seamless approval + sell.
 *
 * @param agentId - Sub-agent ID
 * @param quoteId - Quote ID from nadfun_quote
 */
export async function executeAutonomousNadFunSell(
  agentId: string,
  quoteId: string
): Promise<NadFunExecuteResponse> {
  // Get quote and execution data
  const quote = getCachedNadFunQuote(quoteId);
  if (!quote) {
    return {
      success: false,
      message: "Quote not found",
      error: "Quote not found or expired. Please get a fresh quote with nadfun_quote.",
    };
  }

  if (isNadFunQuoteExpired(quote)) {
    deleteNadFunQuote(quoteId);
    return {
      success: false,
      message: "Quote expired",
      error: "Quote has expired. Please get a fresh quote with nadfun_quote.",
    };
  }

  if (quote.direction !== "SELL") {
    return {
      success: false,
      message: "Wrong quote type",
      error: "This quote is for buying, not selling. Use nadfun_buy instead.",
    };
  }

  const executionData = getNadFunQuoteExecutionData(quoteId);
  if (!executionData) {
    return {
      success: false,
      message: "Execution data missing",
      error: "Execution data missing. Please get a fresh quote.",
    };
  }

  // Parse amount for approval check
  const amountInWei = parseUnits(quote.amountIn, 18); // nad.fun tokens are 18 decimals

  // Use executeWithApprovalIfNeeded for automatic approval handling
  const result = await executeWithApprovalIfNeeded(
    agentId,
    quote.token as Address, // Token to approve
    executionData.router,   // Spender (nad.fun router)
    amountInWei,            // Amount to approve
    {
      target: executionData.router,
      value: 0n, // Sell is not payable
      callData: executionData.calldata,
    },
    {
      action: "sell",
      protocol: "nadfun",
      details: {
        token: quote.tokenSymbol,
        tokenInAddress: quote.token as Address,
        amountIn: quote.amountIn,
        amountOut: quote.expectedOutput,
      },
    }
  );

  if (!result.success) {
    return {
      success: false,
      message: "Autonomous sell failed",
      error: result.error,
    };
  }

  // Clean up quote on success
  deleteNadFunQuote(quoteId);

  return {
    success: true,
    message: `Successfully sold ${quote.amountIn} ${quote.tokenSymbol} for ${quote.expectedOutput} MON (autonomous)`,
    transaction: {
      hash: result.txHash!,
      explorerUrl: result.explorerUrl!,
    },
    trade: {
      tokenSymbol: quote.tokenSymbol,
      tokensSold: quote.amountIn,
      monReceived: quote.expectedOutput,
      progress: quote.progressPercent,
    },
  };
}

// ============================================================================
// Protocol-Specific Wrappers: LeverUp
// ============================================================================

/**
 * LeverUp autonomous execution result
 */
export interface LeverUpAutonomousResult {
  success: boolean;
  message: string;
  txHash?: string;
  explorerUrl?: string;
  error?: string;
}

/**
 * Execute LeverUp close trade using autonomous mode
 *
 * Close operations are simple - no approval needed.
 *
 * @param agentId - Sub-agent ID
 * @param tradeHash - Position hash to close
 */
export async function executeAutonomousLeverUpClose(
  agentId: string,
  tradeHash: Hex
): Promise<LeverUpAutonomousResult> {
  // Get execution data for close
  const execution = await executeCloseTrade(tradeHash);

  // Execute using delegation chain
  const result = await executeWithDelegationChain(
    agentId,
    {
      target: execution.to,
      value: execution.value,
      callData: execution.data as Hex,
    },
    {
      action: "close",
      protocol: "leverup",
      details: {
        positionId: tradeHash,
      },
    }
  );

  if (!result.success) {
    return {
      success: false,
      message: "Autonomous close failed",
      error: result.error,
    };
  }

  return {
    success: true,
    message: `Successfully closed position ${tradeHash.slice(0, 10)}... (autonomous)`,
    txHash: result.txHash,
    explorerUrl: result.explorerUrl,
  };
}

/**
 * Execute LeverUp update TP/SL using autonomous mode
 *
 * @param agentId - Sub-agent ID
 * @param tradeHash - Position hash
 * @param takeProfit - New TP price (optional, "0" to disable)
 * @param stopLoss - New SL price (optional, "0" to disable)
 */
export async function executeAutonomousLeverUpUpdateTpSl(
  agentId: string,
  tradeHash: Hex,
  takeProfit?: string,
  stopLoss?: string
): Promise<LeverUpAutonomousResult> {
  // At least one must be provided
  if (takeProfit === undefined && stopLoss === undefined) {
    return {
      success: false,
      message: "Invalid parameters",
      error: "At least one of takeProfit or stopLoss must be provided.",
    };
  }

  // Parse prices (18 decimals)
  const tpWei = takeProfit ? parseUnits(takeProfit, 18) : 0n;
  const slWei = stopLoss ? parseUnits(stopLoss, 18) : 0n;

  const execution = executeUpdateTpSl(tradeHash, tpWei, slWei);

  const result = await executeWithDelegationChain(
    agentId,
    {
      target: execution.to,
      value: execution.value,
      callData: execution.data as Hex,
    },
    {
      action: "other",
      protocol: "leverup",
      details: {
        operation: "updateTpSl",
        positionId: tradeHash,
        takeProfit: takeProfit || "unchanged",
        stopLoss: stopLoss || "unchanged",
      },
    }
  );

  if (!result.success) {
    return {
      success: false,
      message: "Autonomous TP/SL update failed",
      error: result.error,
    };
  }

  const updates: string[] = [];
  if (takeProfit) updates.push(takeProfit === "0" ? "TP disabled" : `TP=$${takeProfit}`);
  if (stopLoss) updates.push(stopLoss === "0" ? "SL disabled" : `SL=$${stopLoss}`);

  return {
    success: true,
    message: `Successfully updated ${updates.join(", ")} (autonomous)`,
    txHash: result.txHash,
    explorerUrl: result.explorerUrl,
  };
}

/**
 * Execute LeverUp cancel limit order(s) using autonomous mode
 *
 * @param agentId - Sub-agent ID
 * @param orderHashes - Array of order hashes to cancel
 */
export async function executeAutonomousLeverUpCancelLimitOrder(
  agentId: string,
  orderHashes: Hex[]
): Promise<LeverUpAutonomousResult> {
  if (orderHashes.length === 0) {
    return {
      success: false,
      message: "No orders to cancel",
      error: "Please provide at least one order hash.",
    };
  }

  // Use single or batch cancel based on count
  const execution = orderHashes.length === 1
    ? executeCancelLimitOrder(orderHashes[0])
    : executeBatchCancelLimitOrders(orderHashes);

  const result = await executeWithDelegationChain(
    agentId,
    {
      target: execution.to,
      value: execution.value,
      callData: execution.data as Hex,
    },
    {
      action: "other",
      protocol: "leverup",
      details: {
        operation: "cancelLimitOrder",
        orderCount: String(orderHashes.length),
      },
    }
  );

  if (!result.success) {
    return {
      success: false,
      message: "Autonomous cancel failed",
      error: result.error,
    };
  }

  return {
    success: true,
    message: orderHashes.length === 1
      ? `Successfully cancelled limit order (autonomous)`
      : `Successfully cancelled ${orderHashes.length} limit orders (autonomous)`,
    txHash: result.txHash,
    explorerUrl: result.explorerUrl,
  };
}

/**
 * Execute LeverUp add margin using autonomous mode
 *
 * @param agentId - Sub-agent ID
 * @param tradeHash - Position hash
 * @param amount - Amount to add
 * @param collateralToken - Collateral type (MON, USDC, LVUSD, LVMON)
 */
export async function executeAutonomousLeverUpUpdateMargin(
  agentId: string,
  tradeHash: Hex,
  amount: string,
  collateralToken: CollateralToken = "MON"
): Promise<LeverUpAutonomousResult> {
  const isNativeMon = collateralToken === "MON";
  const decimals = getCollateralDecimals(collateralToken);
  const amountWei = parseUnits(amount, decimals);

  // Get token address based on collateral type
  function getTokenAddress(token: CollateralToken): Address {
    switch (token) {
      case "MON":
        return WMON_ADDRESS;
      case "USDC":
        return USDC_ADDRESS;
      case "LVUSD":
        return LVUSD_ADDRESS;
      case "LVMON":
        return LVMON_ADDRESS;
    }
  }
  const tokenAddress = getTokenAddress(collateralToken);

  const execution = executeAddMargin(tradeHash, tokenAddress, amountWei, isNativeMon);

  let result: AutonomousExecutionResult;

  if (isNativeMon) {
    // Native MON - no approval needed
    result = await executeWithDelegationChain(
      agentId,
      {
        target: execution.to,
        value: execution.value,
        callData: execution.data as Hex,
      },
      {
        action: "other",
        protocol: "leverup",
        details: {
          operation: "addMargin",
          positionId: tradeHash,
          amount: amount,
          collateral: collateralToken,
        },
      }
    );
  } else {
    // ERC20 collateral - use executeWithApprovalIfNeeded for automatic approval
    result = await executeWithApprovalIfNeeded(
      agentId,
      tokenAddress,             // Token to approve
      execution.to,             // Spender (LeverUp diamond)
      amountWei,                // Amount to approve
      {
        target: execution.to,
        value: execution.value,
        callData: execution.data as Hex,
      },
      {
        action: "other",
        protocol: "leverup",
        details: {
          operation: "addMargin",
          positionId: tradeHash,
          amount: amount,
          collateral: collateralToken,
        },
      }
    );
  }

  if (!result.success) {
    return {
      success: false,
      message: "Autonomous add margin failed",
      error: result.error,
    };
  }

  return {
    success: true,
    message: `Successfully added ${amount} ${collateralToken} margin (autonomous)`,
    txHash: result.txHash,
    explorerUrl: result.explorerUrl,
  };
}

// ============================================================================
// Protocol-Specific Wrappers: Transfer
// ============================================================================

/**
 * Transfer result for autonomous mode
 */
export interface TransferAutonomousResult {
  success: boolean;
  message: string;
  txHash?: string;
  explorerUrl?: string;
  transfer?: {
    token: string;
    recipient: string;
    amount: string;
    isNative: boolean;
  };
  error?: string;
}

/**
 * Execute token transfer using autonomous mode
 *
 * @param agentId - Sub-agent ID
 * @param token - Token symbol or address ("MON" for native)
 * @param to - Recipient address
 * @param amount - Amount in human-readable format
 */
export async function executeAutonomousTransfer(
  agentId: string,
  token: string,
  to: Address,
  amount: string
): Promise<TransferAutonomousResult> {
  const config = await loadConfig();
  if (!config?.wallet) {
    return { success: false, message: "Wallet not configured", error: "Wallet not configured" };
  }

  const chainId = config.network.chainId;
  const isNativeTransfer = token.toUpperCase() === "MON" ||
    token.toLowerCase() === NATIVE_TOKEN_ADDRESS.toLowerCase();

  let tokenSymbol: string;
  let tokenDecimals: number;
  let tokenAddress: Address;

  if (isNativeTransfer) {
    tokenSymbol = "MON";
    tokenDecimals = 18;
    tokenAddress = NATIVE_TOKEN_ADDRESS;
  } else {
    const tokenInfo = await resolveToken(token, chainId);
    if (!tokenInfo) {
      return {
        success: false,
        message: "Token not found",
        error: `Token not found: ${token}. Please provide a valid symbol or address.`,
      };
    }
    tokenSymbol = tokenInfo.symbol;
    tokenDecimals = tokenInfo.decimals;
    tokenAddress = tokenInfo.address;
  }

  const amountWei = parseUnits(amount, tokenDecimals);

  let executionTarget: Address;
  let executionValue: bigint;
  let executionCallData: Hex;

  if (isNativeTransfer) {
    // Native MON: target=recipient, value=amount, callData="0x"
    executionTarget = to;
    executionValue = amountWei;
    executionCallData = "0x" as Hex;
  } else {
    // ERC20: target=token, value=0, callData=transfer(to, amount)
    executionTarget = tokenAddress;
    executionValue = 0n;
    executionCallData = encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [to, amountWei],
    });
  }

  const result = await executeWithDelegationChain(
    agentId,
    {
      target: executionTarget,
      value: executionValue,
      callData: executionCallData,
    },
    {
      action: "other",
      protocol: "other",
      details: {
        operation: "transfer",
        token: tokenSymbol,
        recipient: to,
        amount: amount,
      },
    }
  );

  if (!result.success) {
    // Check for approval issue on ERC20
    if (!isNativeTransfer && (result.error?.includes("allowance") || result.error?.includes("approve"))) {
      return {
        success: false,
        message: "Token approval needed",
        error: `${tokenSymbol} approval required. Use assistant mode first.`,
      };
    }
    return {
      success: false,
      message: "Autonomous transfer failed",
      error: result.error,
    };
  }

  return {
    success: true,
    message: `Successfully transferred ${amount} ${tokenSymbol} (autonomous)`,
    txHash: result.txHash,
    explorerUrl: result.explorerUrl,
    transfer: {
      token: tokenSymbol,
      recipient: to,
      amount: amount,
      isNative: isNativeTransfer,
    },
  };
}

// ============================================================================
// Protocol-Specific Wrappers: Wrap/Unwrap
// ============================================================================

// WMON ABI for deposit/withdraw
const WMON_ABI = [
  {
    type: "function",
    name: "deposit",
    inputs: [],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "withdraw",
    inputs: [{ name: "wad", type: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

/**
 * Wrap result for autonomous mode
 */
export interface WrapAutonomousResult {
  success: boolean;
  message: string;
  txHash?: string;
  explorerUrl?: string;
  wrap?: {
    direction: "wrap" | "unwrap";
    amount: string;
  };
  error?: string;
}

/**
 * Execute MON → WMON wrap using autonomous mode
 *
 * @param agentId - Sub-agent ID
 * @param amount - Amount in human-readable format
 */
export async function executeAutonomousWrap(
  agentId: string,
  amount: string
): Promise<WrapAutonomousResult> {
  const config = await loadConfig();
  if (!config?.wallet) {
    return { success: false, message: "Wallet not configured", error: "Wallet not configured" };
  }

  const chainConfig = getChainConfig(config.network.chainId);
  const wmonAddress = chainConfig.tokens.wmon;
  if (!wmonAddress) {
    return { success: false, message: "WMON not configured", error: "WMON address not configured for this chain" };
  }

  const amountWei = parseUnits(amount, 18);

  const depositCalldata = encodeFunctionData({
    abi: WMON_ABI,
    functionName: "deposit",
  });

  const result = await executeWithDelegationChain(
    agentId,
    {
      target: wmonAddress,
      value: amountWei,
      callData: depositCalldata,
    },
    {
      action: "other",
      protocol: "other",
      details: {
        operation: "wrap",
        amount: amount,
      },
    }
  );

  if (!result.success) {
    return {
      success: false,
      message: "Autonomous wrap failed",
      error: result.error,
    };
  }

  return {
    success: true,
    message: `Successfully wrapped ${amount} MON → WMON (autonomous)`,
    txHash: result.txHash,
    explorerUrl: result.explorerUrl,
    wrap: {
      direction: "wrap",
      amount: amount,
    },
  };
}

/**
 * Execute WMON → MON unwrap using autonomous mode
 *
 * @param agentId - Sub-agent ID
 * @param amount - Amount in human-readable format
 */
export async function executeAutonomousUnwrap(
  agentId: string,
  amount: string
): Promise<WrapAutonomousResult> {
  const config = await loadConfig();
  if (!config?.wallet) {
    return { success: false, message: "Wallet not configured", error: "Wallet not configured" };
  }

  const chainConfig = getChainConfig(config.network.chainId);
  const wmonAddress = chainConfig.tokens.wmon;
  if (!wmonAddress) {
    return { success: false, message: "WMON not configured", error: "WMON address not configured for this chain" };
  }

  const amountWei = parseUnits(amount, 18);

  const withdrawCalldata = encodeFunctionData({
    abi: WMON_ABI,
    functionName: "withdraw",
    args: [amountWei],
  });

  const result = await executeWithDelegationChain(
    agentId,
    {
      target: wmonAddress,
      value: 0n,
      callData: withdrawCalldata,
    },
    {
      action: "other",
      protocol: "other",
      details: {
        operation: "unwrap",
        amount: amount,
      },
    }
  );

  if (!result.success) {
    return {
      success: false,
      message: "Autonomous unwrap failed",
      error: result.error,
    };
  }

  return {
    success: true,
    message: `Successfully unwrapped ${amount} WMON → MON (autonomous)`,
    txHash: result.txHash,
    explorerUrl: result.explorerUrl,
    wrap: {
      direction: "unwrap",
      amount: amount,
    },
  };
}

// ============================================================================
// Protocol-Specific Wrappers: DEX Swap
// ============================================================================

/**
 * Swap result for autonomous mode
 */
export interface SwapAutonomousResult {
  success: boolean;
  message: string;
  results: Array<{
    quoteId: string;
    success: boolean;
    txHash?: string;
    explorerUrl?: string;
    error?: string;
    swap?: {
      fromToken: string;
      toToken: string;
      amountIn: string;
      amountOut: string;
    };
  }>;
  summary: {
    total: number;
    successful: number;
    failed: number;
  };
  error?: string;
}

/**
 * Execute DEX swap using autonomous mode
 *
 * @param agentId - Sub-agent ID
 * @param quoteIds - Array of quote IDs from get_swap_quote
 * @param slippageBps - Slippage in basis points (default 500 = 5%)
 */
export async function executeAutonomousSwap(
  agentId: string,
  quoteIds: string[],
  slippageBps: number = 500
): Promise<SwapAutonomousResult> {
  const config = await loadConfig();
  if (!config?.wallet) {
    return {
      success: false,
      message: "Wallet not configured",
      results: [],
      summary: { total: 0, successful: 0, failed: 0 },
      error: "Wallet not configured",
    };
  }

  const chainConfig = getChainConfig(config.network.chainId);
  const results: SwapAutonomousResult["results"] = [];

  for (const quoteId of quoteIds) {
    const quote = await getCachedQuote(quoteId);
    if (!quote) {
      results.push({
        quoteId,
        success: false,
        error: "Quote not found or expired. Please get a fresh quote.",
      });
      continue;
    }

    if (isQuoteExpired(quote)) {
      results.push({
        quoteId,
        success: false,
        error: "Quote has expired. Please get a fresh quote.",
      });
      continue;
    }

    const executionData = await getQuoteExecutionData(quoteId);
    if (!executionData) {
      results.push({
        quoteId,
        success: false,
        error: "Execution data missing. Please get a fresh quote.",
      });
      continue;
    }

    const isNativeSwap = quote.fromToken.address.toLowerCase() === NATIVE_TOKEN_ADDRESS.toLowerCase();
    const swapValue = isNativeSwap ? (executionData.value || quote.amountInWei) : 0n;

    let result: AutonomousExecutionResult;

    if (isNativeSwap) {
      // Native MON swap - no approval needed
      result = await executeWithDelegationChain(
        agentId,
        {
          target: executionData.router,
          value: swapValue,
          callData: executionData.calldata,
        },
        {
          action: "buy",
          protocol: "dex",
          details: {
            fromToken: quote.fromToken.symbol,
            toToken: quote.toToken.symbol,
            amountIn: quote.amountIn,
            amountOut: quote.expectedOutput,
          },
        }
      );
    } else {
      // ERC20 swap - use executeWithApprovalIfNeeded for automatic approval
      result = await executeWithApprovalIfNeeded(
        agentId,
        quote.fromToken.address as Address, // Token to approve
        executionData.router,               // Spender (DEX router)
        quote.amountInWei,                  // Amount to approve
        {
          target: executionData.router,
          value: 0n,
          callData: executionData.calldata,
        },
        {
          action: "buy",
          protocol: "dex",
          details: {
            fromToken: quote.fromToken.symbol,
            toToken: quote.toToken.symbol,
            amountIn: quote.amountIn,
            amountOut: quote.expectedOutput,
          },
        }
      );
    }

    if (!result.success) {
      results.push({
        quoteId,
        success: false,
        error: result.error,
      });
      continue;
    }

    results.push({
      quoteId,
      success: true,
      txHash: result.txHash,
      explorerUrl: result.explorerUrl,
      swap: {
        fromToken: quote.fromToken.symbol,
        toToken: quote.toToken.symbol,
        amountIn: `${quote.amountIn} ${quote.fromToken.symbol}`,
        amountOut: `${quote.expectedOutput} ${quote.toToken.symbol}`,
      },
    });
  }

  const successCount = results.filter(r => r.success).length;
  const failCount = results.filter(r => !r.success).length;

  return {
    success: successCount > 0,
    message: `Executed ${successCount}/${quoteIds.length} swaps (autonomous)`,
    results,
    summary: {
      total: quoteIds.length,
      successful: successCount,
      failed: failCount,
    },
  };
}

// ============================================================================
// Protocol-Specific Wrappers: LeverUp Open Position
// ============================================================================

/**
 * Parameters for autonomous LeverUp open
 */
export interface LeverUpOpenParams {
  symbol: string;
  isLong: boolean;
  marginAmount: string;
  leverage: number;
  collateralToken?: CollateralToken;
  slippageBps?: number;
  stopLoss?: string;
  takeProfit?: string;
}

/**
 * Execute LeverUp open market trade using autonomous mode
 *
 * Note: For ERC20 collateral (USDC, LVUSD, LVMON), approval must be set
 * via assistant mode first.
 *
 * @param agentId - Sub-agent ID
 * @param params - Trade parameters
 */
export async function executeAutonomousLeverUpOpen(
  agentId: string,
  params: LeverUpOpenParams
): Promise<LeverUpAutonomousResult> {
  const config = await loadConfig();
  if (!config?.wallet) {
    return { success: false, message: "Wallet not configured", error: "Wallet not configured" };
  }

  const collateral = params.collateralToken || "MON";

  // Validate pair exists
  const pairMetadata = SUPPORTED_PAIRS.find(
    p => p.pair === `${params.symbol}/USD` || p.pair === params.symbol
  );
  if (!pairMetadata) {
    return {
      success: false,
      message: "Unsupported pair",
      error: `Pair not supported: ${params.symbol}. Check leverup_list_pairs for available pairs.`,
    };
  }

  // Validate leverage for high-leverage pairs
  if (pairMetadata.isHighLeverage && !isDegenModeLeverage(params.leverage)) {
    return {
      success: false,
      message: "Invalid leverage for Zero-Fee pair",
      error: `${pairMetadata.pair} ONLY supports ${DEGEN_MODE_LEVERAGE_OPTIONS.join(', ')}x leverage. Requested: ${params.leverage}x.`,
    };
  }

  // Get quote for validation and position size calculation
  let quote;
  try {
    quote = await getLeverUpQuote(
      params.symbol,
      params.isLong,
      params.marginAmount,
      params.leverage,
      collateral
    );
  } catch (error) {
    return {
      success: false,
      message: "Quote failed",
      error: error instanceof Error ? error.message : "Failed to get quote",
    };
  }

  const entryPrice = parseFloat(quote.entryPrice);

  // Validate TP
  if (params.takeProfit) {
    const tpPrice = parseFloat(params.takeProfit);
    const maxTpPercent = getMaxTpPercent(params.leverage);
    const tpPercent = params.isLong
      ? ((tpPrice - entryPrice) / entryPrice) * 100
      : ((entryPrice - tpPrice) / entryPrice) * 100;

    if (tpPercent <= 0) {
      const direction = params.isLong ? 'above' : 'below';
      return {
        success: false,
        message: "Invalid TP",
        error: `For ${params.isLong ? 'Long' : 'Short'}, TP must be ${direction} entry price ($${entryPrice}).`,
      };
    }

    if (tpPercent > maxTpPercent) {
      return {
        success: false,
        message: "TP exceeds max",
        error: `Max TP for ${params.leverage}x is ${maxTpPercent}%. Requested: ${tpPercent.toFixed(1)}%.`,
      };
    }
  }

  // Validate SL
  if (params.stopLoss) {
    const slPrice = parseFloat(params.stopLoss);
    const isInvalidSl = params.isLong ? slPrice >= entryPrice : slPrice <= entryPrice;
    if (isInvalidSl) {
      const direction = params.isLong ? 'below' : 'above';
      return {
        success: false,
        message: "Invalid SL",
        error: `For ${params.isLong ? 'Long' : 'Short'}, SL must be ${direction} entry price ($${entryPrice}).`,
      };
    }
  }

  // Build execution data
  const slippage = BigInt(params.slippageBps ?? 100);
  const entryPriceWei = parseUnits(quote.entryPrice, 18);
  const slippagePrice = params.isLong
    ? (entryPriceWei * (10000n + slippage)) / 10000n
    : (entryPriceWei * (10000n - slippage)) / 10000n;

  const marginWei = parseUnits(params.marginAmount, getCollateralDecimals(collateral));
  const qtyWei = parseUnits(quote.positionSize, 10);

  let execution;
  try {
    execution = await executeOpenTrade({
      symbol: params.symbol,
      isLong: params.isLong,
      amountIn: marginWei,
      leverage: params.leverage,
      qty: qtyWei,
      price: slippagePrice,
      collateralToken: collateral,
      stopLoss: params.stopLoss ? parseUnits(params.stopLoss, 18) : 0n,
      takeProfit: params.takeProfit ? parseUnits(params.takeProfit, 18) : 0n,
    }, config);
  } catch (error) {
    return {
      success: false,
      message: "Execution build failed",
      error: error instanceof Error ? error.message : "Failed to build execution",
    };
  }

  let result: AutonomousExecutionResult;

  if (collateral === "MON") {
    // Native MON collateral - no approval needed
    result = await executeWithDelegationChain(
      agentId,
      {
        target: execution.to,
        value: execution.value,
        callData: execution.data as Hex,
      },
      {
        action: "open",
        protocol: "leverup",
        details: {
          symbol: params.symbol,
          side: params.isLong ? "LONG" : "SHORT",
          leverage: String(params.leverage),
          margin: params.marginAmount,
          collateral: collateral,
        },
      }
    );
  } else {
    // ERC20 collateral - use executeWithApprovalIfNeeded for automatic approval
    // Get token address based on collateral type
    const collateralAddresses: Record<CollateralToken, Address> = {
      MON: WMON_ADDRESS,
      USDC: USDC_ADDRESS,
      LVUSD: LVUSD_ADDRESS,
      LVMON: LVMON_ADDRESS,
    };
    const tokenAddress = collateralAddresses[collateral];

    result = await executeWithApprovalIfNeeded(
      agentId,
      tokenAddress,               // Token to approve
      execution.to,               // Spender (LeverUp diamond)
      marginWei,                  // Amount to approve
      {
        target: execution.to,
        value: execution.value,
        callData: execution.data as Hex,
      },
      {
        action: "open",
        protocol: "leverup",
        details: {
          symbol: params.symbol,
          side: params.isLong ? "LONG" : "SHORT",
          leverage: String(params.leverage),
          margin: params.marginAmount,
          collateral: collateral,
        },
      }
    );
  }

  if (!result.success) {
    return {
      success: false,
      message: "Autonomous open failed",
      error: result.error,
    };
  }

  return {
    success: true,
    message: `Successfully opened ${params.leverage}x ${params.isLong ? 'Long' : 'Short'} ${params.symbol} (autonomous)`,
    txHash: result.txHash,
    explorerUrl: result.explorerUrl,
  };
}

/**
 * Parameters for autonomous LeverUp limit order
 */
export interface LeverUpLimitOrderParams {
  symbol: string;
  isLong: boolean;
  marginAmount: string;
  leverage: number;
  triggerPrice: string;
  collateralToken?: CollateralToken;
  stopLoss?: string;
  takeProfit?: string;
}

/**
 * Execute LeverUp open limit order using autonomous mode
 *
 * @param agentId - Sub-agent ID
 * @param params - Limit order parameters
 */
export async function executeAutonomousLeverUpLimitOrder(
  agentId: string,
  params: LeverUpLimitOrderParams
): Promise<LeverUpAutonomousResult> {
  const config = await loadConfig();
  if (!config?.wallet) {
    return { success: false, message: "Wallet not configured", error: "Wallet not configured" };
  }

  const collateral = params.collateralToken || "MON";

  // Validate pair exists
  const pairMetadata = SUPPORTED_PAIRS.find(
    p => p.pair === `${params.symbol}/USD` || p.pair === params.symbol
  );
  if (!pairMetadata) {
    return {
      success: false,
      message: "Unsupported pair",
      error: `Pair not supported: ${params.symbol}`,
    };
  }

  // Validate leverage for high-leverage pairs
  if (pairMetadata.isHighLeverage && !isDegenModeLeverage(params.leverage)) {
    return {
      success: false,
      message: "Invalid leverage for Zero-Fee pair",
      error: `${pairMetadata.pair} ONLY supports ${DEGEN_MODE_LEVERAGE_OPTIONS.join(', ')}x leverage.`,
    };
  }

  // Get quote for validation
  let quote;
  try {
    quote = await getLimitOrderQuote(
      params.symbol,
      params.isLong,
      params.marginAmount,
      params.leverage,
      params.triggerPrice,
      collateral
    );
  } catch (error) {
    return {
      success: false,
      message: "Quote failed",
      error: error instanceof Error ? error.message : "Failed to get quote",
    };
  }

  if (!quote.isTriggerValid) {
    return {
      success: false,
      message: "Invalid trigger price",
      error: quote.triggerValidationMessage,
    };
  }

  if (!quote.meetsMinimums) {
    return {
      success: false,
      message: "Position too small",
      error: quote.warnings.join(" "),
    };
  }

  const triggerPrice = parseFloat(params.triggerPrice);

  // Validate TP relative to trigger price
  if (params.takeProfit) {
    const tpPrice = parseFloat(params.takeProfit);
    const maxTpPercent = getMaxTpPercent(params.leverage);
    const tpPercent = params.isLong
      ? ((tpPrice - triggerPrice) / triggerPrice) * 100
      : ((triggerPrice - tpPrice) / triggerPrice) * 100;

    if (tpPercent <= 0) {
      const direction = params.isLong ? 'above' : 'below';
      return {
        success: false,
        message: "Invalid TP",
        error: `For ${params.isLong ? 'Long' : 'Short'} limit, TP must be ${direction} trigger price ($${triggerPrice}).`,
      };
    }

    if (tpPercent > maxTpPercent) {
      return {
        success: false,
        message: "TP exceeds max",
        error: `Max TP for ${params.leverage}x is ${maxTpPercent}%.`,
      };
    }
  }

  // Validate SL relative to trigger price
  if (params.stopLoss) {
    const slPrice = parseFloat(params.stopLoss);
    const isInvalidSl = params.isLong ? slPrice >= triggerPrice : slPrice <= triggerPrice;
    if (isInvalidSl) {
      const direction = params.isLong ? 'below' : 'above';
      return {
        success: false,
        message: "Invalid SL",
        error: `For ${params.isLong ? 'Long' : 'Short'} limit, SL must be ${direction} trigger price ($${triggerPrice}).`,
      };
    }
  }

  // Build execution data
  const triggerPriceWei = parseUnits(params.triggerPrice, 18);
  const marginWei = parseUnits(params.marginAmount, getCollateralDecimals(collateral));
  const qtyWei = parseUnits(quote.positionSize, 10);

  let execution;
  try {
    execution = await executeOpenLimitOrder({
      symbol: params.symbol,
      isLong: params.isLong,
      amountIn: marginWei,
      leverage: params.leverage,
      qty: qtyWei,
      triggerPrice: triggerPriceWei,
      collateralToken: collateral,
      stopLoss: params.stopLoss ? parseUnits(params.stopLoss, 18) : 0n,
      takeProfit: params.takeProfit ? parseUnits(params.takeProfit, 18) : 0n,
    }, config);
  } catch (error) {
    return {
      success: false,
      message: "Execution build failed",
      error: error instanceof Error ? error.message : "Failed to build execution",
    };
  }

  let result: AutonomousExecutionResult;

  if (collateral === "MON") {
    // Native MON collateral - no approval needed
    result = await executeWithDelegationChain(
      agentId,
      {
        target: execution.to,
        value: execution.value,
        callData: execution.data as Hex,
      },
      {
        action: "open",
        protocol: "leverup",
        details: {
          operation: "limitOrder",
          symbol: params.symbol,
          side: params.isLong ? "LONG" : "SHORT",
          leverage: String(params.leverage),
          triggerPrice: params.triggerPrice,
          margin: params.marginAmount,
          collateral: collateral,
        },
      }
    );
  } else {
    // ERC20 collateral - use executeWithApprovalIfNeeded for automatic approval
    const collateralAddresses: Record<CollateralToken, Address> = {
      MON: WMON_ADDRESS,
      USDC: USDC_ADDRESS,
      LVUSD: LVUSD_ADDRESS,
      LVMON: LVMON_ADDRESS,
    };
    const tokenAddress = collateralAddresses[collateral];

    result = await executeWithApprovalIfNeeded(
      agentId,
      tokenAddress,               // Token to approve
      execution.to,               // Spender (LeverUp diamond)
      marginWei,                  // Amount to approve
      {
        target: execution.to,
        value: execution.value,
        callData: execution.data as Hex,
      },
      {
        action: "open",
        protocol: "leverup",
        details: {
          operation: "limitOrder",
          symbol: params.symbol,
          side: params.isLong ? "LONG" : "SHORT",
          leverage: String(params.leverage),
          triggerPrice: params.triggerPrice,
          margin: params.marginAmount,
          collateral: collateral,
        },
      }
    );
  }

  if (!result.success) {
    return {
      success: false,
      message: "Autonomous limit order failed",
      error: result.error,
    };
  }

  return {
    success: true,
    message: `Successfully placed ${params.leverage}x ${params.isLong ? 'Long' : 'Short'} limit order on ${params.symbol} @ $${params.triggerPrice} (autonomous)`,
    txHash: result.txHash,
    explorerUrl: result.explorerUrl,
  };
}

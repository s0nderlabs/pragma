// nad.fun Execution
// Executes buy/sell on bonding curve via delegation framework
// Copyright (c) 2026 s0nderlabs

import type { Address, Hex, PublicClient, WalletClient } from "viem";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
} from "viem";
import {
  redeemDelegations,
  createExecution,
  ExecutionMode,
} from "@metamask/smart-accounts-kit";
import type { SignedDelegation, DelegationBundle, Execution } from "../delegation/types.js";
import {
  createNadFunBuyDelegation,
  createNadFunSellDelegation,
  createApproveDelegation,
} from "../delegation/hybrid.js";
import { getCurrentNonce } from "../delegation/nonce.js";
import { getSessionKey, getSessionAccount } from "../session/keys.js";
import { signDelegationWithP256 } from "../signer/p256SignerConfig.js";
import { loadConfig, getRpcUrl } from "../../config/pragma-config.js";
import { buildViemChain, getChainConfig } from "../../config/chains.js";
import { createSyncHttpTransport } from "../x402/client.js";
import { waitForReceiptSync } from "../rpc/index.js";
import {
  getCachedNadFunQuote,
  getNadFunQuoteExecutionData,
  isNadFunQuoteExpired,
  deleteNadFunQuote,
} from "./quote.js";
import { DELEGATION_FRAMEWORK } from "../../config/constants.js";
import {
  getMinBalanceForOperation,
  formatSessionKeyBalance,
} from "../session/manager.js";
import type { NadFunExecutionResult, NadFunQuote } from "./types.js";

// ============================================================================
// Buy Execution
// ============================================================================

/**
 * Execute a nad.fun buy operation
 *
 * Flow:
 * 1. Validate quote not expired
 * 2. Check session key balance
 * 3. Create buy delegation (payable, sends MON)
 * 4. Sign with Touch ID
 * 5. Execute via redeemDelegations()
 */
export async function executeNadFunBuy(quoteId: string): Promise<NadFunExecutionResult> {
  const config = await loadConfig();
  if (!config?.wallet) {
    return {
      success: false,
      error: "Wallet not configured. Please run setup_wallet first.",
    };
  }

  // Get quote and execution data
  const quote = getCachedNadFunQuote(quoteId);
  if (!quote) {
    return {
      success: false,
      error: "Quote not found. Please get a fresh quote with nadfun_quote.",
    };
  }

  if (isNadFunQuoteExpired(quote)) {
    deleteNadFunQuote(quoteId);
    return {
      success: false,
      error: "Quote has expired. Please get a fresh quote with nadfun_quote.",
    };
  }

  if (quote.direction !== "BUY") {
    return {
      success: false,
      error: "This quote is for selling, not buying. Use nadfun_sell instead.",
    };
  }

  const executionData = getNadFunQuoteExecutionData(quoteId);
  if (!executionData) {
    return {
      success: false,
      error: "Execution data missing. Please get a fresh quote.",
    };
  }

  const userAddress = config.wallet.smartAccountAddress as Address;
  const sessionKeyAddress = config.wallet.sessionKeyAddress as Address;
  const chainId = config.network.chainId;
  const chainConfig = getChainConfig(chainId);

  const rpcUrl = await getRpcUrl(config);
  const chain = buildViemChain(chainId, rpcUrl);
  const publicClient = createPublicClient({
    chain,
    transport: createSyncHttpTransport(rpcUrl, config),
  });

  // Check session key balance
  const sessionKey = await getSessionKey();
  if (!sessionKey) {
    return {
      success: false,
      error: "Session key not found. Please run setup_wallet first.",
    };
  }

  const sessionKeyBalance = await publicClient.getBalance({ address: sessionKeyAddress });
  const minRequired = getMinBalanceForOperation("swap"); // Same gas as swap

  if (sessionKeyBalance < minRequired) {
    return {
      success: false,
      error:
        `Session key balance too low. ` +
        `Have: ${formatSessionKeyBalance(sessionKeyBalance)}, Need ~${formatSessionKeyBalance(minRequired)}. ` +
        `Please fund session key first.`,
    };
  }

  // Get nonce for delegation
  const nonce = await getCurrentNonce(publicClient, userAddress);

  // Create buy delegation
  const buyDelegation = createNadFunBuyDelegation({
    router: executionData.router,
    delegator: userAddress,
    sessionKey: sessionKeyAddress,
    nonce,
    chainId,
    calldata: executionData.calldata,
    value: executionData.value,
  });

  // Sign with Touch ID
  const actionLabel = `Buy ${quote.expectedOutput} tokens with ${quote.amountIn} MON on nad.fun`;
  const signature = await signDelegationWithP256(
    buyDelegation.delegation,
    chainId,
    config.wallet.keyId,
    actionLabel
  );
  buyDelegation.delegation.signature = signature;

  // Create session wallet
  const sessionAccount = getSessionAccount(sessionKey);
  const sessionWallet = createWalletClient({
    account: sessionAccount,
    chain,
    transport: createSyncHttpTransport(rpcUrl, config),
  });

  // Execute via redeemDelegations
  try {
    const txHash = await redeemDelegations(
      sessionWallet,
      publicClient,
      DELEGATION_FRAMEWORK.delegationManager,
      [
        {
          permissionContext: [buyDelegation.delegation as SignedDelegation],
          executions: [
            createExecution({
              target: executionData.router,
              value: executionData.value,
              callData: executionData.calldata,
            }),
          ],
          mode: ExecutionMode.SingleDefault,
        },
      ]
    );

    // Wait for confirmation
    const receipt = await waitForReceiptSync(publicClient, txHash);

    if (receipt.status === "reverted") {
      return {
        success: false,
        txHash,
        error: "Transaction reverted on-chain",
      };
    }

    // Clean up quote
    deleteNadFunQuote(quoteId);

    return {
      success: true,
      txHash,
      explorerUrl: `${chainConfig.blockExplorer}/tx/${txHash}`,
      tokensTraded: quote.expectedOutput,
      monAmount: quote.amountIn,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return {
      success: false,
      error: `Transaction failed: ${errorMessage}`,
    };
  }
}

// ============================================================================
// Sell Execution
// ============================================================================

/**
 * Execute a nad.fun sell operation
 *
 * Flow:
 * 1. Validate quote not expired
 * 2. Check session key balance
 * 3. Check/handle token approval (virtual allowance tracking)
 * 4. Create approve delegation(s) if needed
 * 5. Create sell delegation
 * 6. Burst sign all delegations
 * 7. Execute via redeemDelegations()
 */
export async function executeNadFunSell(quoteId: string): Promise<NadFunExecutionResult> {
  const config = await loadConfig();
  if (!config?.wallet) {
    return {
      success: false,
      error: "Wallet not configured. Please run setup_wallet first.",
    };
  }

  // Get quote and execution data
  const quote = getCachedNadFunQuote(quoteId);
  if (!quote) {
    return {
      success: false,
      error: "Quote not found. Please get a fresh quote with nadfun_quote.",
    };
  }

  if (isNadFunQuoteExpired(quote)) {
    deleteNadFunQuote(quoteId);
    return {
      success: false,
      error: "Quote has expired. Please get a fresh quote with nadfun_quote.",
    };
  }

  if (quote.direction !== "SELL") {
    return {
      success: false,
      error: "This quote is for buying, not selling. Use nadfun_buy instead.",
    };
  }

  const executionData = getNadFunQuoteExecutionData(quoteId);
  if (!executionData) {
    return {
      success: false,
      error: "Execution data missing. Please get a fresh quote.",
    };
  }

  const userAddress = config.wallet.smartAccountAddress as Address;
  const sessionKeyAddress = config.wallet.sessionKeyAddress as Address;
  const chainId = config.network.chainId;
  const chainConfig = getChainConfig(chainId);

  const rpcUrl = await getRpcUrl(config);
  const chain = buildViemChain(chainId, rpcUrl);
  const publicClient = createPublicClient({
    chain,
    transport: createSyncHttpTransport(rpcUrl, config),
  });

  // Check session key balance
  const sessionKey = await getSessionKey();
  if (!sessionKey) {
    return {
      success: false,
      error: "Session key not found. Please run setup_wallet first.",
    };
  }

  const sessionKeyBalance = await publicClient.getBalance({ address: sessionKeyAddress });
  const minRequired = getMinBalanceForOperation("swap"); // Same gas as swap

  if (sessionKeyBalance < minRequired) {
    return {
      success: false,
      error:
        `Session key balance too low. ` +
        `Have: ${formatSessionKeyBalance(sessionKeyBalance)}, Need ~${formatSessionKeyBalance(minRequired)}. ` +
        `Please fund session key first.`,
    };
  }

  // Get nonce for delegation
  const nonce = await getCurrentNonce(publicClient, userAddress);

  // Build delegation bundles
  const delegations: DelegationBundle[] = [];

  // Check current allowance
  const currentAllowance = await publicClient.readContract({
    address: quote.token as Address,
    abi: erc20Abi,
    functionName: "allowance",
    args: [userAddress, executionData.router],
  });

  // If allowance insufficient, add approve delegations
  if (currentAllowance < quote.amountInWei) {
    // If there's existing non-zero allowance, reset to 0 first (some tokens require this)
    if (currentAllowance > 0n) {
      const resetApproval = createApproveDelegation({
        tokenAddress: quote.token,
        spender: executionData.router,
        amount: 0n,
        delegator: userAddress,
        sessionKey: sessionKeyAddress,
        nonce,
        chainId,
      });

      delegations.push({
        delegation: resetApproval.delegation as SignedDelegation,
        execution: {
          target: quote.token,
          value: 0n,
          callData: encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [executionData.router, 0n],
          }),
        },
        kind: "approve",
      });
    }

    // Approve the exact amount needed
    const newApproval = createApproveDelegation({
      tokenAddress: quote.token,
      spender: executionData.router,
      amount: quote.amountInWei,
      delegator: userAddress,
      sessionKey: sessionKeyAddress,
      nonce,
      chainId,
    });

    delegations.push({
      delegation: newApproval.delegation as SignedDelegation,
      execution: {
        target: quote.token,
        value: 0n,
        callData: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [executionData.router, quote.amountInWei],
        }),
      },
      kind: "approve",
    });
  }

  // Create sell delegation
  const sellDelegation = createNadFunSellDelegation({
    router: executionData.router,
    delegator: userAddress,
    sessionKey: sessionKeyAddress,
    nonce,
    chainId,
    calldata: executionData.calldata,
  });

  delegations.push({
    delegation: sellDelegation.delegation as SignedDelegation,
    execution: {
      target: executionData.router,
      value: 0n, // sell is nonpayable
      callData: executionData.calldata,
    },
    kind: "nadfun_sell",
  });

  // Burst sign all delegations
  for (const bundle of delegations) {
    const actionLabel =
      bundle.kind === "approve"
        ? `Approve ${quote.amountIn} tokens for nad.fun`
        : `Sell ${quote.amountIn} tokens for ${quote.expectedOutput} MON on nad.fun`;

    const signature = await signDelegationWithP256(
      bundle.delegation,
      chainId,
      config.wallet.keyId,
      actionLabel
    );
    bundle.delegation.signature = signature;
  }

  // Create session wallet
  const sessionAccount = getSessionAccount(sessionKey);
  const sessionWallet = createWalletClient({
    account: sessionAccount,
    chain,
    transport: createSyncHttpTransport(rpcUrl, config),
  });

  // Build redemptions
  const redemptions = delegations.map((bundle) => ({
    permissionContext: [bundle.delegation],
    executions: [
      createExecution({
        target: bundle.execution.target,
        value: bundle.execution.value,
        callData: bundle.execution.callData,
      }),
    ],
    mode: ExecutionMode.SingleDefault,
  }));

  // Execute via redeemDelegations
  try {
    const txHash = await redeemDelegations(
      sessionWallet,
      publicClient,
      DELEGATION_FRAMEWORK.delegationManager,
      redemptions
    );

    // Wait for confirmation
    const receipt = await waitForReceiptSync(publicClient, txHash);

    if (receipt.status === "reverted") {
      return {
        success: false,
        txHash,
        error: "Transaction reverted on-chain",
      };
    }

    // Clean up quote
    deleteNadFunQuote(quoteId);

    return {
      success: true,
      txHash,
      explorerUrl: `${chainConfig.blockExplorer}/tx/${txHash}`,
      tokensTraded: quote.amountIn,
      monAmount: quote.expectedOutput,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return {
      success: false,
      error: `Transaction failed: ${errorMessage}`,
    };
  }
}

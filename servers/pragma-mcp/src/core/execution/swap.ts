// Swap Execution
// Executes swaps via delegation framework
// Supports 0x (primary) and Monorail (fallback) aggregators
// Adapted from pragma-v2-stable (H2)
// Copyright (c) 2026 s0nderlabs

import type { Address, Hex, PublicClient, WalletClient } from "viem";
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  erc20Abi,
  getAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  redeemDelegations,
  createExecution,
  ExecutionMode,
} from "@metamask/delegation-toolkit";
import type { ExecutionResult, SwapQuote } from "../../types/index.js";
import type { SignedDelegation, DelegationBundle, Execution } from "../delegation/types.js";
import {
  createSwapDelegation,
  createApproveDelegation,
} from "../delegation/hybrid.js";
import { getCurrentNonce } from "../delegation/nonce.js";
import { getSessionKey, getSessionAccount } from "../session/keys.js";
import { signDelegationWithP256 } from "../signer/p256SignerConfig.js";
import { loadConfig } from "../../config/pragma-config.js";
import { buildViemChain } from "../../config/chains.js";
import { getProvider } from "../signer/index.js";
import {
  getCachedQuote,
  getQuoteExecutionData,
  isQuoteExpired,
} from "../aggregator/index.js";
import { patchMonorailMinOutput } from "../monorail/calldataPatcher.js";
import { DELEGATION_FRAMEWORK, NATIVE_TOKEN_ADDRESS } from "../../config/constants.js";

import {
  getMinBalanceForOperation,
  formatSessionKeyBalance,
} from "../session/manager.js";

// Default slippage in basis points (500 = 5%)
// User can override via slippageBps parameter (max 5000 = 50%)
const DEFAULT_SLIPPAGE_BPS = 500;

// MARK: - Types

export interface SwapExecutionParams {
  quoteId: string;
  slippageBps?: number; // Optional, defaults to 500 (5%)
}

export interface SwapExecutionResult extends ExecutionResult {
  quote: SwapQuote;
  delegationsUsed: number;
  balanceBefore?: string;
  balanceAfter?: string;
}

// MARK: - Execution

/**
 * Execute a swap using a previously quoted swap
 *
 * Flow:
 * 1. Retrieve cached quote (validate not expired)
 * 2. Get execution data (calldata, router)
 * 3. Fetch current nonce
 * 4. Build delegations (approve if needed + swap)
 * 5. Sign delegations with passkey (Touch ID)
 * 6. Execute via session key
 * 7. Return transaction hash
 */
export async function executeSwap(
  params: SwapExecutionParams
): Promise<SwapExecutionResult> {
  // Step 1: Load config and verify wallet
  const config = await loadConfig();
  if (!config?.wallet) {
    throw new Error("Wallet not configured. Please run setup_wallet first.");
  }

  const userAddress = config.wallet.smartAccountAddress as Address;
  const sessionKeyAddress = config.wallet.sessionKeyAddress as Address;
  const chainId = config.network.chainId;

  // Step 2: Retrieve cached quote
  const quote = await getCachedQuote(params.quoteId);
  if (!quote) {
    throw new Error(
      `Quote not found or expired: ${params.quoteId}. Please get a fresh quote.`
    );
  }

  if (isQuoteExpired(quote)) {
    throw new Error(
      "Quote has expired. Please get a fresh quote before executing."
    );
  }

  // Step 3: Get execution data (calldata, router address)
  const executionData = await getQuoteExecutionData(params.quoteId);
  if (!executionData) {
    throw new Error(
      "Execution data not found for quote. Quote may have been corrupted."
    );
  }

  // Step 4: Get RPC and create clients
  const rpcUrl = (await getProvider("rpc")) || config.network.rpc;
  const chain = buildViemChain(chainId, rpcUrl);

  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl),
  });

  // Step 5: Get session key
  const sessionKey = await getSessionKey();
  if (!sessionKey) {
    throw new Error("Session key not found. Please run setup_wallet first.");
  }

  // Step 5.1: Check session key balance (throw error if insufficient - Claude will fund via fund_session_key tool)
  const sessionKeyBalance = await publicClient.getBalance({ address: sessionKeyAddress });

  const minSwapBalance = getMinBalanceForOperation("swap");
  if (sessionKeyBalance < minSwapBalance) {
    throw new Error(
      `Session key balance too low: ${formatSessionKeyBalance(sessionKeyBalance)} ` +
        `(minimum for swap: ${formatSessionKeyBalance(minSwapBalance)}). ` +
        `Please call fund_session_key first with operationType: "swap".`
    );
  }

  // Step 6: Fetch current nonce
  const nonce = await getCurrentNonce(publicClient as PublicClient, userAddress);

  // Step 7: Build delegation bundles
  const delegationBundles: DelegationBundle[] = [];
  const isNativeSwap = quote.fromToken.address.toLowerCase() === NATIVE_TOKEN_ADDRESS.toLowerCase();

  // Check if we need to approve (for ERC20 tokens only)
  if (!isNativeSwap) {
    // Check current allowance
    const currentAllowance = await publicClient.readContract({
      address: quote.fromToken.address,
      abi: erc20Abi,
      functionName: "allowance",
      args: [userAddress, executionData.router],
    });

    if (currentAllowance < quote.amountInWei) {
      // Need to approve - for safety, reset to 0 first if there's existing allowance
      if (currentAllowance > 0n) {
        // Create reset approval delegation
        const resetDelegation = createApproveDelegation({
          tokenAddress: quote.fromToken.address,
          spender: executionData.router,
          amount: 0n,
          delegator: userAddress,
          sessionKey: sessionKeyAddress,
          nonce,
          chainId,
        });

        const resetCalldata = encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [executionData.router, 0n],
        });

        delegationBundles.push({
          delegation: resetDelegation.delegation as SignedDelegation,
          execution: {
            target: quote.fromToken.address,
            value: 0n,
            callData: resetCalldata,
          },
          kind: "approve",
        });
      }

      // Create approval delegation
      const approveDelegation = createApproveDelegation({
        tokenAddress: quote.fromToken.address,
        spender: executionData.router,
        amount: quote.amountInWei,
        delegator: userAddress,
        sessionKey: sessionKeyAddress,
        nonce,
        chainId,
      });

      const approveCalldata = encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [executionData.router, quote.amountInWei],
      });

      delegationBundles.push({
        delegation: approveDelegation.delegation as SignedDelegation,
        execution: {
          target: quote.fromToken.address,
          value: 0n,
          callData: approveCalldata,
        },
        kind: "approve",
      });
    }
  }

  // Use provided slippage or default
  const slippageBps = params.slippageBps ?? DEFAULT_SLIPPAGE_BPS;

  // Determine final calldata based on aggregator
  // - 0x: Calldata already has slippage applied (use as-is)
  // - Monorail: Need to patch calldata with slippage
  let finalCalldata: Hex;

  if (quote.aggregator === "0x") {
    // 0x calldata is ready to use - slippage already baked in at quote time
    console.log(`[swap] Using 0x aggregator - calldata ready (slippage pre-applied)`);
    console.log(`[swap] MinOutput from quote: ${quote.minOutputWei}`);
    finalCalldata = executionData.calldata;
  } else {
    // Monorail requires calldata patching
    console.log(`[swap] Using Monorail aggregator - patching calldata`);
    const patchResult = patchMonorailMinOutput(
      executionData.calldata,
      quote.expectedOutputWei,
      slippageBps
    );

    console.log(`[swap] Patcher result: tradesPatched=${patchResult.tradesPatched}, slippage=${slippageBps}bps`);
    console.log(`[swap] Original minOutput: ${patchResult.originalMinOutput}`);
    console.log(`[swap] Patched minOutput: ${patchResult.patchedMinOutput}`);
    console.log(`[swap] Calldata changed: ${patchResult.originalCalldata !== patchResult.patchedCalldata}`);

    finalCalldata = patchResult.patchedCalldata;
  }

  // Create swap delegation
  const swapDelegation = createSwapDelegation({
    aggregator: executionData.router,
    aggregatorName: quote.aggregator, // For calldata enforcement selection (0x vs monorail)
    destination: userAddress, // Output goes to user's smart account
    delegator: userAddress,
    sessionKey: sessionKeyAddress,
    nonce,
    chainId,
    transactionData: finalCalldata, // For selector extraction
  });

  // For native token swaps, include value
  // Use executionData.value if available (from 0x), otherwise calculate from quote
  const swapValue = isNativeSwap ? (executionData.value || quote.amountInWei) : 0n;

  delegationBundles.push({
    delegation: swapDelegation.delegation as SignedDelegation,
    execution: {
      target: executionData.router,
      value: swapValue,
      callData: finalCalldata,
    },
    kind: "swap",
  });

  // Step 8: Sign all delegations with passkey (Touch ID)
  // Uses WebAuthn-wrapped P-256 signatures compatible with HybridDeleGator
  const keyId = config.wallet.keyId;
  if (!keyId) {
    throw new Error("Key ID not found in config. Please run setup_wallet first.");
  }

  for (const bundle of delegationBundles) {
    // Build Touch ID prompt message with full details
    const actionLabel =
      bundle.kind === "approve"
        ? `Approve ${quote.amountIn} ${quote.fromToken.symbol}`
        : `Swap ${quote.amountIn} ${quote.fromToken.symbol} → ${quote.expectedOutput} ${quote.toToken.symbol}`;

    // Sign with P-256 passkey using WebAuthn wrapper (triggers Touch ID)
    // This returns an ABI-encoded signature compatible with HybridDeleGator
    const signature = await signDelegationWithP256(
      bundle.delegation,
      chainId,
      keyId,
      actionLabel
    );

    // Attach signature to delegation
    bundle.delegation.signature = signature;
  }

  // Step 9: Create session wallet client
  const sessionAccount = getSessionAccount(sessionKey);
  const sessionWallet = createWalletClient({
    account: sessionAccount,
    chain,
    transport: http(rpcUrl),
  });

  // Step 10: Execute all delegations sequentially
  let lastTxHash: Hex = "0x" as Hex;

  for (const bundle of delegationBundles) {
    const execution = createExecution({
      target: bundle.execution.target,
      value: bundle.execution.value,
      callData: bundle.execution.callData,
    });

    lastTxHash = await redeemDelegations(
      sessionWallet as WalletClient,
      publicClient as PublicClient,
      DELEGATION_FRAMEWORK.delegationManager,
      [
        {
          permissionContext: [bundle.delegation],
          executions: [execution],
          mode: ExecutionMode.SingleDefault,
        },
      ]
    );

    // Wait for confirmation before next delegation
    await publicClient.waitForTransactionReceipt({
      hash: lastTxHash,
      timeout: 60_000,
    });
  }

  // Step 11: Return result
  return {
    txHash: lastTxHash,
    status: "success",
    quote,
    delegationsUsed: delegationBundles.length,
  };
}

// MARK: - Validation

/**
 * Validate a quote before execution
 */
export async function validateQuote(quote: SwapQuote): Promise<boolean> {
  return !isQuoteExpired(quote);
}

/**
 * Build swap calldata (delegates to Monorail)
 * The actual calldata comes from the Monorail API quote response
 */
export function buildSwapCalldata(_quote: SwapQuote): Hex {
  throw new Error(
    "Swap calldata is obtained from Monorail quote, not built locally"
  );
}

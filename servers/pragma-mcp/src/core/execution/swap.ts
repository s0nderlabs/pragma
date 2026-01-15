// Swap Execution
// Executes swaps via delegation framework
// All quotes from api.pr4gma.xyz
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
} from "@metamask/smart-accounts-kit";
import type { ExecutionResult, SwapQuote } from "../../types/index.js";
import type { SignedDelegation, DelegationBundle, Execution } from "../delegation/types.js";
import {
  createSwapDelegation,
  createApproveDelegation,
} from "../delegation/hybrid.js";
import { getCurrentNonce } from "../delegation/nonce.js";
import { getSessionKey, getSessionAccount } from "../session/keys.js";
import { signDelegationWithP256 } from "../signer/p256SignerConfig.js";
import { loadConfig, getRpcUrl } from "../../config/pragma-config.js";
import { buildViemChain } from "../../config/chains.js";
import { x402HttpOptions } from "../x402/client.js";
import {
  getCachedQuote,
  getQuoteExecutionData,
  isQuoteExpired,
} from "../aggregator/index.js";
import { DELEGATION_FRAMEWORK, NATIVE_TOKEN_ADDRESS } from "../../config/constants.js";

import {
  getMinBalanceForOperation,
  formatSessionKeyBalance,
} from "../session/manager.js";

const DEFAULT_SLIPPAGE_BPS = 500;

export interface SwapExecutionParams {
  quoteId: string;
  slippageBps?: number;
}

export interface SwapExecutionResult extends ExecutionResult {
  quote: SwapQuote;
  delegationsUsed: number;
  balanceBefore?: string;
  balanceAfter?: string;
}

export interface BatchSwapResult {
  results: {
    quoteId: string;
    success: boolean;
    txHash?: string;
    error?: string;
    quote?: SwapQuote;
  }[];
  totalDelegations: number;
}

interface SwapBundle {
  quote: SwapQuote;
  delegations: DelegationBundle[];
  executionData: any;
}

/**
 * Execute a batch of swaps in parallel.
 *
 * Pipeline:
 * 1. Prepare: Build all delegations state-aware (virtual allowance tracking).
 * 2. Sign: Prompt Touch ID sequentially for all bundles (Burst Signing).
 * 3. Execute: Broadcast all txs sequentially (nonce ordering) but wait for receipts in parallel.
 */
export async function executeBatchSwap(
  quoteIds: string[],
  slippageBps: number = DEFAULT_SLIPPAGE_BPS
): Promise<BatchSwapResult> {
  const config = await loadConfig();
  if (!config?.wallet) {
    throw new Error("Wallet not configured. Please run setup_wallet first.");
  }

  const userAddress = config.wallet.smartAccountAddress as Address;
  const sessionKeyAddress = config.wallet.sessionKeyAddress as Address;
  const chainId = config.network.chainId;

  const rpcUrl = await getRpcUrl(config);
  const chain = buildViemChain(chainId, rpcUrl);
  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl, x402HttpOptions(config)),
  });

  const sessionKey = await getSessionKey();
  if (!sessionKey) throw new Error("Session key not found.");

  const sessionKeyBalance = await publicClient.getBalance({ address: sessionKeyAddress });
  const minRequired = getMinBalanceForOperation("swap") * BigInt(quoteIds.length); 

  if (sessionKeyBalance < minRequired) {
    throw new Error(
      `Session key balance too low for ${quoteIds.length} swaps. ` +
        `Have: ${formatSessionKeyBalance(sessionKeyBalance)}, Need ~${formatSessionKeyBalance(minRequired)}. ` +
        `Please fund session key first.`
    );
  }

  const bundles = await prepareSwapBundles(
    quoteIds,
    slippageBps,
    userAddress,
    sessionKeyAddress,
    chainId,
    publicClient
  );

  const signedBundles = await signSwapBundles(bundles, chainId, config.wallet.keyId);

  const sessionAccount = getSessionAccount(sessionKey);
  const sessionWallet = createWalletClient({
    account: sessionAccount,
    chain,
    transport: http(rpcUrl, x402HttpOptions(config)),
  });

  const broadcastResults = await broadcastAndExecute(
    signedBundles,
    sessionWallet,
    publicClient
  );

  return {
    results: broadcastResults,
    totalDelegations: signedBundles.reduce((acc, b) => acc + b.delegations.length, 0),
  };
}

async function prepareSwapBundles(
  quoteIds: string[],
  slippageBps: number,
  userAddress: Address,
  sessionKeyAddress: Address,
  chainId: number,
  publicClient: PublicClient
): Promise<SwapBundle[]> {
  const bundles: SwapBundle[] = [];
  const allowanceCache = new Map<string, bigint>(); 

  const nonce = await getCurrentNonce(publicClient, userAddress);

  for (const quoteId of quoteIds) {
    const quote = await getCachedQuote(quoteId);
    if (!quote || isQuoteExpired(quote)) {
      throw new Error(`Quote ${quoteId} invalid or expired.`);
    }

    const executionData = await getQuoteExecutionData(quoteId);
    if (!executionData) {
      throw new Error(`Execution data missing for ${quoteId}`);
    }

    const delegations: DelegationBundle[] = [];
    const isNativeSwap = quote.fromToken.address.toLowerCase() === NATIVE_TOKEN_ADDRESS.toLowerCase();

    if (!isNativeSwap) {
      const cacheKey = `${quote.fromToken.address}-${executionData.router}`;
      let currentAllowance = allowanceCache.get(cacheKey);

      if (currentAllowance === undefined) {
        currentAllowance = await publicClient.readContract({
          address: quote.fromToken.address as Address,
          abi: erc20Abi,
          functionName: "allowance",
          args: [userAddress, executionData.router as Address],
        });
        allowanceCache.set(cacheKey, currentAllowance);
      }

      if (currentAllowance < quote.amountInWei) {
        if (currentAllowance > 0n) {
          delegations.push({
            delegation: createApproveDelegation({
              tokenAddress: quote.fromToken.address,
              spender: executionData.router,
              amount: 0n,
              delegator: userAddress,
              sessionKey: sessionKeyAddress,
              nonce,
              chainId,
            }).delegation as SignedDelegation,
            execution: {
              target: quote.fromToken.address,
              value: 0n,
              callData: encodeFunctionData({
                abi: erc20Abi,
                functionName: "approve",
                args: [executionData.router as Address, 0n],
              }),
            },
            kind: "approve",
          });
        }

        delegations.push({
          delegation: createApproveDelegation({
            tokenAddress: quote.fromToken.address,
            spender: executionData.router,
            amount: quote.amountInWei,
            delegator: userAddress,
            sessionKey: sessionKeyAddress,
            nonce,
            chainId,
          }).delegation as SignedDelegation,
          execution: {
            target: quote.fromToken.address,
            value: 0n,
            callData: encodeFunctionData({
              abi: erc20Abi,
              functionName: "approve",
              args: [executionData.router as Address, quote.amountInWei],
            }),
          },
          kind: "approve",
        });

        allowanceCache.set(cacheKey, 0n);
      } else {
        allowanceCache.set(cacheKey, currentAllowance - quote.amountInWei);
      }
    }

    const swapValue = isNativeSwap ? (executionData.value || quote.amountInWei) : 0n;
    const swapDelegation = createSwapDelegation({
      aggregator: executionData.router,
      destination: userAddress,
      delegator: userAddress,
      sessionKey: sessionKeyAddress,
      nonce,
      chainId,
      transactionData: executionData.calldata,
      nativeValueAmount: swapValue,
    });

    delegations.push({
      delegation: swapDelegation.delegation as SignedDelegation,
      execution: {
        target: executionData.router,
        value: swapValue,
        callData: executionData.calldata,
      },
      kind: "swap",
    });

    bundles.push({ quote, delegations, executionData });
  }

  return bundles;
}

async function signSwapBundles(
  bundles: SwapBundle[],
  chainId: number,
  keyId: string
): Promise<SwapBundle[]> {
  for (const bundle of bundles) {
    for (const delegationBundle of bundle.delegations) {
      const actionLabel =
        delegationBundle.kind === "approve"
          ? `Approve ${bundle.quote.amountIn} ${bundle.quote.fromToken.symbol}`
          : `Swap ${bundle.quote.amountIn} ${bundle.quote.fromToken.symbol} → ${bundle.quote.expectedOutput} ${bundle.quote.toToken.symbol}`;

      const signature = await signDelegationWithP256(
        delegationBundle.delegation,
        chainId,
        keyId,
        actionLabel
      );
      delegationBundle.delegation.signature = signature;
    }
  }
  return bundles;
}

async function broadcastAndExecute(
  bundles: SwapBundle[],
  sessionWallet: WalletClient,
  publicClient: PublicClient
): Promise<BatchSwapResult["results"]> {
  const redemptions: {
    permissionContext: SignedDelegation[];
    executions: Execution[];
    mode: ExecutionMode;
  }[] = [];
  const results: BatchSwapResult["results"] = [];

  // Flatten all delegations from all bundles into redemptions
  for (const bundle of bundles) {
    for (const delBundle of bundle.delegations) {
      redemptions.push({
        permissionContext: [delBundle.delegation],
        executions: [
          createExecution({
            target: delBundle.execution.target,
            value: delBundle.execution.value,
            callData: delBundle.execution.callData,
          }),
        ],
        mode: ExecutionMode.SingleDefault,
      });
    }
  }

  if (redemptions.length === 0) {
    return [];
  }

  try {
    // ONE single transaction for the entire batch
    const txHash = await redeemDelegations(
      sessionWallet,
      publicClient,
      DELEGATION_FRAMEWORK.delegationManager,
      redemptions
    );

    // Wait for confirmation
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: 60_000,
    });

    // Map the single txHash to all successful swap results
    for (const bundle of bundles) {
      if (receipt.status === "reverted") {
        results.push({
          quoteId: bundle.quote.quoteId,
          success: false,
          error: "Batch transaction reverted on-chain",
          txHash,
          quote: bundle.quote,
        });
      } else {
        results.push({
          quoteId: bundle.quote.quoteId,
          success: true,
          txHash,
          quote: bundle.quote,
        });
      }
    }
  } catch (e: any) {
    // If the entire batch fails to broadcast
    for (const bundle of bundles) {
      results.push({
        quoteId: bundle.quote.quoteId,
        success: false,
        error: e.message || "Batch broadcast failed",
        quote: bundle.quote,
      });
    }
  }

  return results;
}

export async function executeSwap(
  params: SwapExecutionParams
): Promise<SwapExecutionResult> {
  const batchResult = await executeBatchSwap([params.quoteId], params.slippageBps);
  const result = batchResult.results[0];

  if (!result.success) {
    throw new Error(result.error || "Swap failed");
  }

  return {
    txHash: result.txHash as Hex,
    status: "success",
    quote: result.quote!,
    delegationsUsed: 1, 
  };
}

export async function validateQuote(quote: SwapQuote): Promise<boolean> {
  return !isQuoteExpired(quote);
}

export function buildSwapCalldata(_quote: SwapQuote): Hex {
  throw new Error(
    "Swap calldata is obtained from quote API, not built locally"
  );
}

// Transfer Execution
// Executes token transfers (ERC20 and native MON) via delegation framework
// Adapted from pragma-v2-stable (H2)
// Copyright (c) 2026 s0nderlabs

import type { Address, Hex, PublicClient, WalletClient } from "viem";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  parseUnits,
  formatUnits,
  formatEther,
} from "viem";
import {
  redeemDelegations,
  createExecution,
  ExecutionMode,
} from "@metamask/smart-accounts-kit";
import type { ExecutionResult } from "../../types/index.js";
import type { SignedDelegation, DelegationBundle } from "../delegation/types.js";
import {
  createERC20TransferDelegation,
  createNativeTransferDelegation,
} from "../delegation/hybrid.js";
import { getCurrentNonce } from "../delegation/nonce.js";
import { getSessionKey, getSessionAccount } from "../session/keys.js";
import { signDelegationWithP256 } from "../signer/p256SignerConfig.js";
import { loadConfig, getRpcUrl } from "../../config/pragma-config.js";
import { buildViemChain } from "../../config/chains.js";
import { createSyncHttpTransport } from "../x402/client.js";
import { waitForReceiptSync } from "../rpc/index.js";
import { resolveToken } from "../data/client.js";
import { DELEGATION_FRAMEWORK, NATIVE_TOKEN_ADDRESS } from "../../config/constants.js";
import {
  getMinBalanceForOperation,
  formatSessionKeyBalance,
} from "../session/manager.js";

// MARK: - Types

export interface TransferParams {
  token: string; // Symbol or address
  to: Address;
  amount: string; // Human-readable amount
}

export interface TransferResult extends ExecutionResult {
  token: {
    symbol: string;
    address: Address;
    isNative: boolean;
  };
  recipient: Address;
  amount: string;
  amountWei: bigint;
}

// MARK: - Helpers

/**
 * Check if token is native MON
 */
function isNativeMON(symbolOrAddress: string): boolean {
  const upper = symbolOrAddress.toUpperCase().trim();
  if (upper === "MON") return true;
  if (symbolOrAddress.toLowerCase() === NATIVE_TOKEN_ADDRESS.toLowerCase()) return true;
  return false;
}

// MARK: - Execution

/**
 * Execute a token transfer (ERC20 or native MON)
 *
 * Flow:
 * 1. Resolve token (symbol → address)
 * 2. Validate recipient address
 * 3. Convert amount to wei
 * 4. Fetch current nonce
 * 5. Create transfer delegation (native or ERC20)
 * 6. Sign delegation with passkey (Touch ID)
 * 7. Execute via session key
 * 8. Return transaction hash
 *
 * Native MON transfers use nativeTokenTransferAmount scope (H2 pattern)
 * with amount-only enforcement. Recipient NOT enforced (documented trade-off).
 */
export async function executeTransfer(
  params: TransferParams
): Promise<TransferResult> {
  // Step 1: Load config and verify wallet
  const config = await loadConfig();
  if (!config?.wallet) {
    throw new Error("Wallet not configured. Please run setup_wallet first.");
  }

  const userAddress = config.wallet.smartAccountAddress as Address;
  const sessionKeyAddress = config.wallet.sessionKeyAddress as Address;
  const chainId = config.network.chainId;

  // Step 2: Check if native MON transfer
  const isNativeTransfer = isNativeMON(params.token);

  // Step 3: Resolve token (skip for native)
  let tokenSymbol: string;
  let tokenDecimals: number;
  let tokenAddress: Address;

  if (isNativeTransfer) {
    tokenSymbol = "MON";
    tokenDecimals = 18;
    tokenAddress = NATIVE_TOKEN_ADDRESS;
  } else {
    const tokenInfo = await resolveToken(params.token, chainId);
    if (!tokenInfo) {
      throw new Error(
        `Token not found: ${params.token}. Please provide a valid symbol or address.`
      );
    }

    // Double-check it's not actually native
    if (tokenInfo.kind === "native") {
      // Handle as native transfer
      tokenSymbol = "MON";
      tokenDecimals = 18;
      tokenAddress = NATIVE_TOKEN_ADDRESS;
    } else {
      tokenSymbol = tokenInfo.symbol;
      tokenDecimals = tokenInfo.decimals;
      tokenAddress = tokenInfo.address;
    }
  }

  // Step 4: Parse amount to wei
  const amountWei = parseUnits(params.amount, tokenDecimals);
  if (amountWei <= 0n) {
    throw new Error("Amount must be greater than 0");
  }

  // Step 5: Get RPC URL (mode-aware: skips Keychain in x402 mode)
  const rpcUrl = await getRpcUrl(config);
  const chain = buildViemChain(chainId, rpcUrl);

  const publicClient = createPublicClient({
    chain,
    transport: createSyncHttpTransport(rpcUrl, config),
  });

  // Step 6: Verify user has sufficient balance
  if (isNativeTransfer || tokenAddress === NATIVE_TOKEN_ADDRESS) {
    // Check native MON balance
    const monBalance = await publicClient.getBalance({ address: userAddress });
    if (monBalance < amountWei) {
      const balanceFormatted = formatEther(monBalance);
      throw new Error(
        `Insufficient MON balance. Have: ${balanceFormatted} MON, Need: ${params.amount} MON`
      );
    }
  } else {
    // Check ERC20 balance
    const balance = await publicClient.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [userAddress],
    });

    if (balance < amountWei) {
      const balanceFormatted = formatUnits(balance, tokenDecimals);
      throw new Error(
        `Insufficient ${tokenSymbol} balance. ` +
          `Have: ${balanceFormatted}, Need: ${params.amount}`
      );
    }
  }

  // Step 7: Get session key
  const sessionKey = await getSessionKey();
  if (!sessionKey) {
    throw new Error("Session key not found. Please run setup_wallet first.");
  }

  // Step 7.1: Check session key balance
  const sessionKeyBalance = await publicClient.getBalance({ address: sessionKeyAddress });
  const minTransferBalance = getMinBalanceForOperation("transfer");

  if (sessionKeyBalance < minTransferBalance) {
    throw new Error(
      `Session key balance too low: ${formatSessionKeyBalance(sessionKeyBalance)} ` +
        `(minimum for transfer: ${formatSessionKeyBalance(minTransferBalance)}). ` +
        `Please call fund_session_key first with operationType: "transfer".`
    );
  }

  // Step 8: Fetch current nonce
  const nonce = await getCurrentNonce(publicClient as PublicClient, userAddress);

  // Step 9: Create transfer delegation and execution based on type
  let delegationBundle: DelegationBundle;

  if (isNativeTransfer || tokenAddress === NATIVE_TOKEN_ADDRESS) {
    // Native MON transfer - use nativeTokenTransferAmount scope (H2 pattern)
    const nativeDelegation = createNativeTransferDelegation({
      recipient: params.to,
      amount: amountWei,
      delegator: userAddress,
      sessionKey: sessionKeyAddress,
      nonce,
      chainId,
    });

    // Native transfer execution: target = recipient, value = amount, callData = "0x"
    delegationBundle = {
      delegation: nativeDelegation.delegation as SignedDelegation,
      execution: {
        target: params.to, // Recipient address
        value: amountWei, // Transfer amount as msg.value
        callData: "0x" as Hex, // Empty calldata for native transfer
      },
      kind: "transfer",
    };
  } else {
    // ERC20 transfer - use functionCall scope with recipient + amount enforcement
    const erc20Delegation = createERC20TransferDelegation({
      tokenAddress,
      recipient: params.to,
      amount: amountWei,
      delegator: userAddress,
      sessionKey: sessionKeyAddress,
      nonce,
      chainId,
    });

    // ERC20 transfer execution: target = token, value = 0, callData = transfer()
    const transferCalldata = encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [params.to, amountWei],
    });

    delegationBundle = {
      delegation: erc20Delegation.delegation as SignedDelegation,
      execution: {
        target: tokenAddress,
        value: 0n,
        callData: transferCalldata,
      },
      kind: "transfer",
    };
  }

  // Step 10: Sign delegation with passkey (Touch ID)
  const keyId = config.wallet.keyId;
  if (!keyId) {
    throw new Error("Key ID not found in config. Please run setup_wallet first.");
  }

  // Format Touch ID prompt
  const shortRecipient = `${params.to.slice(0, 8)}...${params.to.slice(-6)}`;
  const actionLabel = `Transfer ${params.amount} ${tokenSymbol} to ${shortRecipient}`;

  const signature = await signDelegationWithP256(
    delegationBundle.delegation,
    chainId,
    keyId,
    actionLabel
  );

  delegationBundle.delegation.signature = signature;

  // Step 11: Create session wallet client (EIP-7966 support)
  const sessionAccount = getSessionAccount(sessionKey);
  const sessionWallet = createWalletClient({
    account: sessionAccount,
    chain,
    transport: createSyncHttpTransport(rpcUrl, config),
  });

  // Step 12: Execute delegation
  const execution = createExecution({
    target: delegationBundle.execution.target,
    value: delegationBundle.execution.value,
    callData: delegationBundle.execution.callData,
  });

  const txHash = await redeemDelegations(
    sessionWallet as WalletClient,
    publicClient as PublicClient,
    DELEGATION_FRAMEWORK.delegationManager,
    [
      {
        permissionContext: [delegationBundle.delegation],
        executions: [execution],
        mode: ExecutionMode.SingleDefault,
      },
    ]
  );

  // Wait for confirmation (EIP-7966 cache-first)
  await waitForReceiptSync(publicClient as PublicClient, txHash);

  return {
    txHash,
    status: "success",
    token: {
      symbol: tokenSymbol,
      address: tokenAddress,
      isNative: isNativeTransfer || tokenAddress === NATIVE_TOKEN_ADDRESS,
    },
    recipient: params.to,
    amount: params.amount,
    amountWei,
  };
}

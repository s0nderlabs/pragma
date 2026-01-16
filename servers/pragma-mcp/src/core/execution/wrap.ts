// Wrap/Unwrap Execution
// Executes MON ↔ WMON wrapping/unwrapping via delegation framework
// Adapted from pragma-v2-stable (H2)
// Copyright (c) 2026 s0nderlabs

import type { Address, Hex, PublicClient, WalletClient } from "viem";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  parseUnits,
  formatUnits,
  erc20Abi,
} from "viem";
import {
  redeemDelegations,
  createExecution,
  ExecutionMode,
} from "@metamask/smart-accounts-kit";
import type { ExecutionResult } from "../../types/index.js";
import type { SignedDelegation, DelegationBundle } from "../delegation/types.js";
import { createWrapDelegation, createUnwrapDelegation } from "../delegation/hybrid.js";
import { getCurrentNonce } from "../delegation/nonce.js";
import { getSessionKey, getSessionAccount } from "../session/keys.js";
import { signDelegationWithP256 } from "../signer/p256SignerConfig.js";
import { loadConfig, getRpcUrl } from "../../config/pragma-config.js";
import { buildViemChain, getChainConfig } from "../../config/chains.js";
import { createSyncHttpTransport } from "../x402/client.js";
import { waitForReceiptSync } from "../rpc/index.js";
import { DELEGATION_FRAMEWORK } from "../../config/constants.js";
import {
  getMinBalanceForOperation,
  formatSessionKeyBalance,
} from "../session/manager.js";

// MARK: - WMON ABI (deposit/withdraw)

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

// MARK: - Types

export interface WrapParams {
  amount: string; // Human-readable MON amount
}

export interface UnwrapParams {
  amount: string; // Human-readable WMON amount
}

export interface WrapResult extends ExecutionResult {
  amount: string;
  amountWei: bigint;
  direction: "wrap" | "unwrap";
}

// MARK: - Wrap Execution (MON → WMON)

/**
 * Execute MON → WMON wrap
 *
 * Flow:
 * 1. Parse amount to wei
 * 2. Check MON balance
 * 3. Fetch current nonce
 * 4. Create wrap delegation
 * 5. Sign delegation with passkey (Touch ID)
 * 6. Execute via session key
 * 7. Return transaction hash
 */
export async function executeWrap(params: WrapParams): Promise<WrapResult> {
  // Step 1: Load config and verify wallet
  const config = await loadConfig();
  if (!config?.wallet) {
    throw new Error("Wallet not configured. Please run setup_wallet first.");
  }

  const userAddress = config.wallet.smartAccountAddress as Address;
  const sessionKeyAddress = config.wallet.sessionKeyAddress as Address;
  const chainId = config.network.chainId;

  // Step 2: Get chain config for WMON address
  const chainConfig = getChainConfig(chainId);
  const wmonAddress = chainConfig.tokens.wmon;
  if (!wmonAddress) {
    throw new Error(`WMON address not configured for chain ${chainId}`);
  }

  // Step 3: Parse amount to wei
  const amountWei = parseUnits(params.amount, 18);
  if (amountWei <= 0n) {
    throw new Error("Amount must be greater than 0");
  }

  // Step 4: Get RPC and create clients
  const rpcUrl = await getRpcUrl(config);
  const chain = buildViemChain(chainId, rpcUrl);

  const publicClient = createPublicClient({
    chain,
    transport: createSyncHttpTransport(rpcUrl, config),
  });

  // Step 5: Check MON balance
  const monBalance = await publicClient.getBalance({ address: userAddress });
  if (monBalance < amountWei) {
    const balanceFormatted = formatUnits(monBalance, 18);
    throw new Error(
      `Insufficient MON balance. Have: ${balanceFormatted} MON, Need: ${params.amount} MON`
    );
  }

  // Step 6: Get session key
  const sessionKey = await getSessionKey();
  if (!sessionKey) {
    throw new Error("Session key not found. Please run setup_wallet first.");
  }

  // Step 6.1: Check session key balance
  const sessionKeyBalance = await publicClient.getBalance({ address: sessionKeyAddress });
  const minWrapBalance = getMinBalanceForOperation("wrap");

  if (sessionKeyBalance < minWrapBalance) {
    throw new Error(
      `Session key balance too low: ${formatSessionKeyBalance(sessionKeyBalance)} ` +
        `(minimum for wrap: ${formatSessionKeyBalance(minWrapBalance)}). ` +
        `Please call fund_session_key first with operationType: "wrap".`
    );
  }

  // Step 7: Fetch current nonce
  const nonce = await getCurrentNonce(publicClient as PublicClient, userAddress);

  // Step 8: Create wrap delegation
  const wrapDelegation = createWrapDelegation({
    wmonAddress,
    amount: amountWei, // For valueLte enforcement
    delegator: userAddress,
    sessionKey: sessionKeyAddress,
    nonce,
    chainId,
  });

  // Build deposit() calldata (no parameters)
  const depositCalldata = encodeFunctionData({
    abi: WMON_ABI,
    functionName: "deposit",
  });

  const delegationBundle: DelegationBundle = {
    delegation: wrapDelegation.delegation as SignedDelegation,
    execution: {
      target: wmonAddress,
      value: amountWei, // MON amount sent as msg.value
      callData: depositCalldata,
    },
    kind: "wrap",
  };

  // Step 9: Sign delegation with passkey (Touch ID)
  const keyId = config.wallet.keyId;
  if (!keyId) {
    throw new Error("Key ID not found in config. Please run setup_wallet first.");
  }

  const actionLabel = `Wrap ${params.amount} MON → WMON`;

  const signature = await signDelegationWithP256(
    delegationBundle.delegation,
    chainId,
    keyId,
    actionLabel
  );

  delegationBundle.delegation.signature = signature;

  // Step 10: Create session wallet client
  const sessionAccount = getSessionAccount(sessionKey);
  const sessionWallet = createWalletClient({
    account: sessionAccount,
    chain,
    transport: createSyncHttpTransport(rpcUrl, config),
  });

  // Step 11: Execute delegation
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
    amount: params.amount,
    amountWei,
    direction: "wrap",
  };
}

// MARK: - Unwrap Execution (WMON → MON)

/**
 * Execute WMON → MON unwrap
 *
 * Flow:
 * 1. Parse amount to wei
 * 2. Check WMON balance
 * 3. Fetch current nonce
 * 4. Create unwrap delegation
 * 5. Sign delegation with passkey (Touch ID)
 * 6. Execute via session key
 * 7. Return transaction hash
 */
export async function executeUnwrap(params: UnwrapParams): Promise<WrapResult> {
  // Step 1: Load config and verify wallet
  const config = await loadConfig();
  if (!config?.wallet) {
    throw new Error("Wallet not configured. Please run setup_wallet first.");
  }

  const userAddress = config.wallet.smartAccountAddress as Address;
  const sessionKeyAddress = config.wallet.sessionKeyAddress as Address;
  const chainId = config.network.chainId;

  // Step 2: Get chain config for WMON address
  const chainConfig = getChainConfig(chainId);
  const wmonAddress = chainConfig.tokens.wmon;
  if (!wmonAddress) {
    throw new Error(`WMON address not configured for chain ${chainId}`);
  }

  // Step 3: Parse amount to wei
  const amountWei = parseUnits(params.amount, 18);
  if (amountWei <= 0n) {
    throw new Error("Amount must be greater than 0");
  }

  // Step 4: Get RPC and create clients
  const rpcUrl = await getRpcUrl(config);
  const chain = buildViemChain(chainId, rpcUrl);

  const publicClient = createPublicClient({
    chain,
    transport: createSyncHttpTransport(rpcUrl, config),
  });

  // Step 5: Check WMON balance
  const wmonBalance = await publicClient.readContract({
    address: wmonAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [userAddress],
  });

  if (wmonBalance < amountWei) {
    const balanceFormatted = formatUnits(wmonBalance, 18);
    throw new Error(
      `Insufficient WMON balance. Have: ${balanceFormatted} WMON, Need: ${params.amount} WMON`
    );
  }

  // Step 6: Get session key
  const sessionKey = await getSessionKey();
  if (!sessionKey) {
    throw new Error("Session key not found. Please run setup_wallet first.");
  }

  // Step 6.1: Check session key balance
  const sessionKeyBalance = await publicClient.getBalance({ address: sessionKeyAddress });
  const minUnwrapBalance = getMinBalanceForOperation("unwrap");

  if (sessionKeyBalance < minUnwrapBalance) {
    throw new Error(
      `Session key balance too low: ${formatSessionKeyBalance(sessionKeyBalance)} ` +
        `(minimum for unwrap: ${formatSessionKeyBalance(minUnwrapBalance)}). ` +
        `Please call fund_session_key first with operationType: "unwrap".`
    );
  }

  // Step 7: Fetch current nonce
  const nonce = await getCurrentNonce(publicClient as PublicClient, userAddress);

  // Step 8: Create unwrap delegation
  const unwrapDelegation = createUnwrapDelegation({
    wmonAddress,
    delegator: userAddress,
    sessionKey: sessionKeyAddress,
    nonce,
    chainId,
  });

  // Build withdraw(amount) calldata
  const withdrawCalldata = encodeFunctionData({
    abi: WMON_ABI,
    functionName: "withdraw",
    args: [amountWei],
  });

  const delegationBundle: DelegationBundle = {
    delegation: unwrapDelegation.delegation as SignedDelegation,
    execution: {
      target: wmonAddress,
      value: 0n, // No MON sent
      callData: withdrawCalldata,
    },
    kind: "unwrap",
  };

  // Step 9: Sign delegation with passkey (Touch ID)
  const keyId = config.wallet.keyId;
  if (!keyId) {
    throw new Error("Key ID not found in config. Please run setup_wallet first.");
  }

  const actionLabel = `Unwrap ${params.amount} WMON → MON`;

  const signature = await signDelegationWithP256(
    delegationBundle.delegation,
    chainId,
    keyId,
    actionLabel
  );

  delegationBundle.delegation.signature = signature;

  // Step 10: Create session wallet client
  const sessionAccount = getSessionAccount(sessionKey);
  const sessionWallet = createWalletClient({
    account: sessionAccount,
    chain,
    transport: createSyncHttpTransport(rpcUrl, config),
  });

  // Step 11: Execute delegation
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
    amount: params.amount,
    amountWei,
    direction: "unwrap",
  };
}

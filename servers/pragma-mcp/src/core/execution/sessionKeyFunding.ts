// Session Key Funding
// Funds session key from smart account using UserOp and delegation paths
// Copyright (c) 2026 s0nderlabs

import {
  type Address,
  type Hex,
  type PublicClient,
  encodeFunctionData,
  formatEther,
  formatUnits,
  createWalletClient,
  createPublicClient,
  http,
  type WalletClient,
  erc20Abi
} from "viem";
import { formatUserOperationRequest, type UserOperationRequest } from "viem/account-abstraction";
import type { HybridDelegatorHandle } from "../account/hybridDelegator.js";
import {
  MIN_SESSION_KEY_BALANCE,
  SESSION_KEY_FUNDING_AMOUNT,
  DELEGATION_FRAMEWORK,
} from "../../config/constants.js";
import { x402Fetch, x402HttpOptions } from "../x402/client.js";
import { withRetryOrThrow } from "../utils/retry.js";
import type { SignedDelegation } from "../delegation/types.js";
import { createNativeTransferDelegation, createERC20TransferDelegation } from "../delegation/hybrid.js";
import { getCurrentNonce } from "../delegation/nonce.js";
import { getSessionKey, getSessionAccount } from "../session/keys.js";
import { ExecutionMode, redeemDelegations, createExecution } from "@metamask/smart-accounts-kit";
import { getRpcUrl } from "../../config/pragma-config.js";
import { signDelegationWithP256 } from "../signer/p256SignerConfig.js";
import { USDC_ADDRESS, USDC_DECIMALS } from "../x402/usdc.js";
import type { PragmaConfig } from "../../types/index.js";

// Re-export constants for convenience
export { MIN_SESSION_KEY_BALANCE, SESSION_KEY_FUNDING_AMOUNT };

// MARK: - Types

interface SignableUserOp {
  sender: Address;
  nonce: bigint;
  factory?: Address;
  factoryData?: Hex;
  callData: Hex;
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  signature: Hex;
  paymaster?: Address;
  paymasterData?: Hex;
  paymasterVerificationGasLimit?: bigint;
  paymasterPostOpGasLimit?: bigint;
}

/**
 * Custom execution for UserOp
 * When provided, overrides default native MON transfer
 */
export interface CustomExecution {
  target: Address;
  value: bigint;
  callData: Hex;
}

export interface FundSessionKeyParams {
  handle: HybridDelegatorHandle;
  sessionKeyAddress: Address;
  publicClient: PublicClient;
  config: PragmaConfig;
  bundlerUrl?: string;
  fundingAmount?: bigint;
  customExecution?: CustomExecution;
}

export interface FundSessionKeyResult {
  userOpHash: Hex;
  transactionHash?: Hex;
  newBalance: bigint;
  fundedAmount: bigint;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * HybridDelegator's execute() function ABI
 * Used to call smart account to transfer MON
 */
const HYBRID_DELEGATOR_EXECUTE_ABI = [
  {
    type: "function",
    name: "execute",
    inputs: [
      {
        name: "_execution",
        type: "tuple",
        components: [
          { name: "target", type: "address" },
          { name: "value", type: "uint256" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    outputs: [],
    stateMutability: "payable",
  },
] as const;

/**
 * Gas configuration
 * P-256 WebAuthn verification requires higher gas limits
 * preVerificationGas especially high for WebAuthn signature validation
 */
const MIN_VERIFICATION_GAS_LIMIT = 500_000n;
const MIN_PRE_VERIFICATION_GAS = 400_000n; // Higher for P-256 WebAuthn
const MIN_CALL_GAS_LIMIT = 100_000n;

// ============================================================================
// Bundler Helpers
// ============================================================================

/**
 * Get gas price recommendations from bundler
 * Includes retry for transient errors (idempotent read operation)
 */
async function getGasPrice(bundlerUrl: string): Promise<{
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}> {
  return withRetryOrThrow(
    async () => {
      const response = await x402Fetch(bundlerUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "pimlico_getUserOperationGasPrice",
          params: [],
          id: 1,
        }),
      });

      if (!response.ok) {
        throw new Error(`Gas price request failed: ${response.status}`);
      }

      const data = (await response.json()) as {
        result?: {
          fast?: { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex };
          standard?: { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex };
        };
        error?: { message: string };
      };

      if (data.error) {
        throw new Error(`Gas price error: ${data.error.message}`);
      }

      const prices = data.result?.fast ?? data.result?.standard;
      if (!prices) {
        throw new Error("No gas price data returned");
      }

      return {
        maxFeePerGas: BigInt(prices.maxFeePerGas),
        maxPriorityFeePerGas: BigInt(prices.maxPriorityFeePerGas),
      };
    },
    { operationName: "bundler-gas-price" }
  );
}

/**
 * Parse optional gas value from hex string
 */
function parseGasValue(value?: string | null): bigint | undefined {
  if (!value || value === "0x") return undefined;
  try {
    const parsed = BigInt(value);
    return parsed > 0n ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Estimate gas via bundler
 * Includes retry for transient errors (idempotent read operation)
 */
async function estimateUserOpGas(
  bundlerUrl: string,
  userOp: Record<string, unknown>,
  entryPoint: Address
): Promise<{
  callGasLimit?: bigint;
  verificationGasLimit?: bigint;
  preVerificationGas?: bigint;
}> {
  return withRetryOrThrow(
    async () => {
      const response = await x402Fetch(bundlerUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_estimateUserOperationGas",
          params: [userOp, entryPoint],
          id: 1,
        }),
      });

      if (!response.ok) {
        throw new Error(`Gas estimation failed: ${response.status}`);
      }

      const data = (await response.json()) as {
        result?: {
          callGasLimit?: string;
          verificationGasLimit?: string;
          verificationGas?: string;
          preVerificationGas?: string;
        };
        error?: { message: string };
      };

      if (data.error) {
        throw new Error(`Gas estimation error: ${data.error.message}`);
      }

      const result = data.result ?? {};
      return {
        callGasLimit: parseGasValue(result.callGasLimit),
        verificationGasLimit: parseGasValue(result.verificationGasLimit),
        preVerificationGas: parseGasValue(result.preVerificationGas),
      };
    },
    { operationName: "bundler-estimate-gas" }
  );
}

/**
 * Apply gas estimates to userOp with minimum floors
 */
function applyGasEstimates(
  userOp: SignableUserOp,
  estimates: {
    callGasLimit?: bigint;
    verificationGasLimit?: bigint;
    preVerificationGas?: bigint;
  }
): void {
  userOp.callGasLimit = estimates.callGasLimit && estimates.callGasLimit > MIN_CALL_GAS_LIMIT
    ? estimates.callGasLimit
    : MIN_CALL_GAS_LIMIT;

  userOp.verificationGasLimit = estimates.verificationGasLimit && estimates.verificationGasLimit > MIN_VERIFICATION_GAS_LIMIT
    ? estimates.verificationGasLimit
    : MIN_VERIFICATION_GAS_LIMIT;

  userOp.preVerificationGas = estimates.preVerificationGas && estimates.preVerificationGas > MIN_PRE_VERIFICATION_GAS
    ? estimates.preVerificationGas
    : MIN_PRE_VERIFICATION_GAS;
}

/**
 * Send user operation to bundler
 */
async function sendUserOperation(
  bundlerUrl: string,
  userOp: Record<string, unknown>,
  entryPoint: Address
): Promise<Hex> {
  const response = await x402Fetch(bundlerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "eth_sendUserOperation",
      params: [userOp, entryPoint],
      id: 1,
    }),
  });

  if (!response.ok) {
    throw new Error(`Send UserOp failed: ${response.status}`);
  }

  const data = (await response.json()) as {
    result?: Hex;
    error?: { message: string };
  };

  if (data.error) {
    throw new Error(`UserOp error: ${data.error.message}`);
  }

  if (!data.result) {
    throw new Error("No userOpHash returned");
  }

  return data.result;
}

/**
 * Wait for user operation receipt
 */
async function waitForUserOperationReceipt(
  bundlerUrl: string,
  userOpHash: Hex,
  timeoutMs: number = 60000
): Promise<{ transactionHash?: Hex }> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const response = await x402Fetch(bundlerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_getUserOperationReceipt",
        params: [userOpHash],
        id: 1,
      }),
    });

    if (response.ok) {
      const data = (await response.json()) as {
        result?: {
          receipt?: { transactionHash?: Hex };
        };
        error?: { message: string };
      };

      if (data.error) {
        continue;
      }

      if (data.result?.receipt?.transactionHash) {
        return { transactionHash: data.result.receipt.transactionHash };
      }
    }

    // Wait before retrying
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error(`Timeout waiting for UserOp ${userOpHash}`);
}

// ============================================================================
// MARK: - Native Funding via Delegation
// ============================================================================

/**
 * Fund session key from smart account using delegation
 * Session key pays its own gas (no bundler needed)
 *
 * @param params - Funding parameters
 * @returns UserOp hash (as 0x), transaction hash, and new balance
 */
export async function fundSessionKeyViaDelegation(
  params: FundSessionKeyParams
): Promise<FundSessionKeyResult> {
  const {
    handle,
    sessionKeyAddress,
    publicClient,
    config,
    fundingAmount = SESSION_KEY_FUNDING_AMOUNT,
  } = params;

  // Get balance before funding
  const balanceBefore = await publicClient.getBalance({ address: sessionKeyAddress });

  // Get chain ID from handle
  const chainId = handle.chain.id;

  // CRITICAL: Get nonce from NonceEnforcer, NOT from smart account entrypoint
  const nonce = await getCurrentNonce(publicClient, handle.address);

  // Step 1: Create native MON transfer delegation (SA → session key)
  const delegationResult = createNativeTransferDelegation({
    recipient: sessionKeyAddress,
    amount: fundingAmount,
    delegator: handle.address,
    sessionKey: sessionKeyAddress,
    nonce,
    chainId,
  });

  // Step 2: Sign delegation with passkey (Touch ID)
  const touchIdMessage = `Fund session key: ${formatEther(fundingAmount)} MON (delegation)`;
  const signature = await signDelegationWithP256(
    delegationResult.delegation,
    chainId,
    handle.keyId,
    touchIdMessage
  );
  delegationResult.delegation.signature = signature;

  // Step 3: Build native transfer execution
  const execution = createExecution({
    target: sessionKeyAddress,
    value: fundingAmount,
    callData: "0x" as Hex,
  });

  // Step 4: Get session key and create wallet
  const sessionKey = await getSessionKey();
  if (!sessionKey) throw new Error("Session key not found");

  const sessionAccount = getSessionAccount(sessionKey);

  // Get RPC URL - Respect config.mode
  const rpcUrl = await getRpcUrl(config);

  const sessionWallet = createWalletClient({
    account: sessionAccount,
    chain: handle.chain,
    transport: http(rpcUrl, x402HttpOptions(config)),
  });

  // Step 5: Execute via delegation
  const txHash = await redeemDelegations(
    sessionWallet as WalletClient,
    publicClient,
    DELEGATION_FRAMEWORK.delegationManager,
    [
      {
        permissionContext: [delegationResult.delegation as SignedDelegation],
        executions: [execution],
        mode: ExecutionMode.SingleDefault,
      },
    ]
  );

  // Step 6: Wait for confirmation
  await publicClient.waitForTransactionReceipt({
    hash: txHash,
    timeout: 60_000,
  });

  // Step 7: Get new balance
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const newBalance = await publicClient.getBalance({ address: sessionKeyAddress });

  return {
    userOpHash: "0x" as Hex,
    transactionHash: txHash,
    newBalance,
    fundedAmount: newBalance - balanceBefore,
  };
}

// ============================================================================
// MARK: - USDC Funding via Delegation
// ============================================================================

/**
 * Fund session key with USDC using delegation
 *
 * @param params - Funding parameters
 * @returns Transaction hash and results
 */
export async function fundUsdcViaDelegation(
  params: FundSessionKeyParams
): Promise<FundSessionKeyResult> {
  const {
    handle,
    sessionKeyAddress,
    publicClient,
    config,
    fundingAmount = 0n, // USDC amount in base units
  } = params;

  const chainId = handle.chain.id;
  const usdcAddress = USDC_ADDRESS[chainId];
  if (!usdcAddress) throw new Error(`USDC not configured for chain ${chainId}`);

  // 1. Get nonce from NonceEnforcer
  const nonce = await getCurrentNonce(publicClient, handle.address);

  // 2. Create USDC transfer delegation
  const delegationResult = createERC20TransferDelegation({
    tokenAddress: usdcAddress,
    recipient: sessionKeyAddress,
    amount: fundingAmount,
    delegator: handle.address,
    sessionKey: sessionKeyAddress,
    nonce,
    chainId,
  });

  // 3. Sign delegation with passkey
  const touchIdMessage = `Fund session key: ${formatUnits(fundingAmount, USDC_DECIMALS)} USDC (delegation)`;
  const signature = await signDelegationWithP256(
    delegationResult.delegation,
    chainId,
    handle.keyId,
    touchIdMessage
  );
  delegationResult.delegation.signature = signature;

  // 4. Build transfer execution
  const execution = createExecution({
    target: usdcAddress,
    value: 0n,
    callData: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [sessionKeyAddress, fundingAmount],
    }),
  });

  // 5. Create session wallet
  const sessionKey = await getSessionKey();
  if (!sessionKey) throw new Error("Session key not found");
  const sessionAccount = getSessionAccount(sessionKey);
  
  // Respect config.mode
  const rpcUrl = await getRpcUrl(config);

  const sessionWallet = createWalletClient({
    account: sessionAccount,
    chain: handle.chain,
    transport: http(rpcUrl, x402HttpOptions(config)),
  });

  // 6. Execute via delegation
  const txHash = await redeemDelegations(
    sessionWallet as WalletClient,
    publicClient,
    DELEGATION_FRAMEWORK.delegationManager,
    [
      {
        permissionContext: [delegationResult.delegation as SignedDelegation],
        executions: [execution],
        mode: ExecutionMode.SingleDefault,
      },
    ]
  );

  // 7. Wait for receipt
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  return {
    userOpHash: "0x" as Hex,
    transactionHash: txHash,
    newBalance: 0n, // Balance check handled by caller
    fundedAmount: fundingAmount,
  };
}

// ============================================================================
// MARK: - Native Funding via UserOp
// ============================================================================

/**
 * Fund session key from smart account using UserOp
 * Bundler pays gas
 *
 * @param params - Funding parameters
 * @returns UserOp hash, transaction hash, and new balance
 */
export async function fundSessionKeyViaUserOp(
  params: FundSessionKeyParams
): Promise<FundSessionKeyResult> {
  const {
    handle,
    sessionKeyAddress,
    publicClient,
    bundlerUrl,
    fundingAmount = SESSION_KEY_FUNDING_AMOUNT,
    customExecution,
  } = params;

  if (!bundlerUrl) {
    throw new Error("Bundler URL required for UserOp path");
  }

  // Get balance before funding
  const balanceBefore = await publicClient.getBalance({ address: sessionKeyAddress });

  // Step 1: Build execute() calldata
  const execution = customExecution ?? {
    target: sessionKeyAddress,
    value: fundingAmount,
    callData: "0x" as Hex,
  };

  const callData = encodeFunctionData({
    abi: HYBRID_DELEGATOR_EXECUTE_ABI,
    functionName: "execute",
    args: [execution],
  });

  // Step 2: Get nonce from smart account
  const nonce = (await handle.smartAccount.getNonce?.()) ?? 0n;

  // Step 3: Get gas prices from bundler
  const gasPrices = await getGasPrice(bundlerUrl);

  // Step 4: Build base UserOp
  const userOp: SignableUserOp = {
    sender: handle.address,
    nonce,
    callData,
    callGasLimit: MIN_CALL_GAS_LIMIT,
    verificationGasLimit: MIN_VERIFICATION_GAS_LIMIT,
    preVerificationGas: MIN_PRE_VERIFICATION_GAS,
    maxFeePerGas: gasPrices.maxFeePerGas,
    maxPriorityFeePerGas: gasPrices.maxPriorityFeePerGas,
    signature: "0x" as Hex,
  };

  // Step 5: Estimate gas
  const entryPoint = handle.smartAccount.entryPoint.address;

  try {
    const estimationRequest = formatUserOperationRequest({
      ...userOp,
      signature: "0x" as Hex,
    } as unknown as UserOperationRequest);

    const gasEstimates = await estimateUserOpGas(bundlerUrl, estimationRequest, entryPoint);
    applyGasEstimates(userOp, gasEstimates);
  } catch (error) {
    console.warn("Failed to estimate gas, using defaults:", error);
  }

  // Step 6: Sign UserOp
  const signature = await handle.smartAccount.signUserOperation(userOp);
  userOp.signature = signature;

  // Step 7: Format and send
  const rpcUserOperation = formatUserOperationRequest({
    ...userOp,
    signature,
  } as unknown as UserOperationRequest);

  const userOpHash = await sendUserOperation(bundlerUrl, rpcUserOperation, entryPoint);

  // Step 8: Wait for receipt
  const receipt = await waitForUserOperationReceipt(bundlerUrl, userOpHash);

  // Step 9: Get new balance
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const newBalance = await publicClient.getBalance({ address: sessionKeyAddress });

  return {
    userOpHash,
    transactionHash: receipt.transactionHash,
    newBalance,
    fundedAmount: newBalance - balanceBefore,
  };
}

/**
 * Check if session key needs funding
 */
export function needsFunding(balance: bigint): boolean {
  return balance < MIN_SESSION_KEY_BALANCE;
}

/**
 * Format balance for display
 */
export function formatBalance(balance: bigint): string {
  return `${formatEther(balance)} MON`;
}

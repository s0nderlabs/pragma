// Session Key Funding
// Funds session key from smart account using UserOp
// Adapted from pragma-v2-stable (H2)
// Copyright (c) 2026 s0nderlabs

import {
  type Address,
  type Hex,
  type PublicClient,
  encodeFunctionData,
  formatEther,
} from "viem";
import { formatUserOperationRequest, type UserOperationRequest } from "viem/account-abstraction";
import type { HybridDelegatorHandle } from "../account/hybridDelegator.js";
import {
  MIN_SESSION_KEY_BALANCE,
  SESSION_KEY_FUNDING_AMOUNT,
} from "../../config/constants.js";

// Re-export constants for convenience
export { MIN_SESSION_KEY_BALANCE, SESSION_KEY_FUNDING_AMOUNT };

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

export interface FundSessionKeyParams {
  handle: HybridDelegatorHandle;
  sessionKeyAddress: Address;
  publicClient: PublicClient;
  bundlerUrl: string;
  fundingAmount?: bigint;
}

export interface FundSessionKeyResult {
  userOpHash: Hex;
  transactionHash?: Hex;
  newBalance: bigint;
  fundedAmount: bigint;
}

// MARK: - Bundler Helpers

/**
 * Get gas price recommendations from bundler
 */
async function getGasPrice(bundlerUrl: string): Promise<{
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}> {
  const response = await fetch(bundlerUrl, {
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
  const response = await fetch(bundlerUrl, {
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
    verificationGasLimit: parseGasValue(result.verificationGasLimit ?? result.verificationGas),
    preVerificationGas: parseGasValue(result.preVerificationGas),
  };
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
  // Apply estimates with minimum floors
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
  const response = await fetch(bundlerUrl, {
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
    const response = await fetch(bundlerUrl, {
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
          transactionHash?: Hex;
        };
        error?: { message: string };
      };

      if (data.result) {
        return {
          transactionHash:
            data.result.receipt?.transactionHash ?? data.result.transactionHash,
        };
      }
    }

    // Wait before polling again
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error(`Timeout waiting for UserOp ${userOpHash}`);
}

// MARK: - Main Funding Function

/**
 * Fund session key from smart account using UserOp
 *
 * This function creates a UserOp that calls the smart account's execute()
 * function to transfer MON to the session key. The smart account pays gas.
 *
 * Flow:
 * 1. Build execute() calldata for native MON transfer
 * 2. Create UserOp with that calldata
 * 3. Estimate gas via bundler
 * 4. Sign UserOp with P-256 passkey (via SDK)
 * 5. Submit to bundler
 * 6. Wait for confirmation
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
  } = params;

  // Get balance before funding
  const balanceBefore = await publicClient.getBalance({ address: sessionKeyAddress });

  // Step 1: Build execute() calldata for native transfer to session key
  const callData = encodeFunctionData({
    abi: HYBRID_DELEGATOR_EXECUTE_ABI,
    functionName: "execute",
    args: [
      {
        target: sessionKeyAddress,
        value: fundingAmount,
        callData: "0x" as Hex, // Native transfer (no contract call)
      },
    ],
  });

  // Step 2: Get nonce from smart account
  const nonce = (await handle.smartAccount.getNonce?.()) ?? 0n;

  // Step 3: Get gas prices from bundler
  const gasPrices = await getGasPrice(bundlerUrl);

  // Step 4: Build base UserOp (self-paid, no paymaster)
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
    // Continue with default gas values
  }

  // Step 6: Sign UserOp with P-256 passkey via SDK (triggers Touch ID)
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
  // Wait a bit for RPC to update
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

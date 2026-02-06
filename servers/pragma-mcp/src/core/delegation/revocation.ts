// On-Chain Delegation Revocation
// Copyright (c) 2026 s0nderlabs

import {
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  encodeFunctionData,
  getAddress,
  createWalletClient,
} from "viem";
import {
  formatUserOperationRequest,
  type UserOperationRequest,
} from "viem/account-abstraction";
import type { HybridDelegatorHandle } from "../account/hybridDelegator.js";
import { DELEGATION_FRAMEWORK } from "../../config/constants.js";
import { x402Fetch, createSyncHttpTransport } from "../x402/client.js";
import { withRetryOrThrow } from "../utils/retry.js";
import { getCurrentNonce } from "./nonce.js";
import { getSessionKey, getSessionAccount } from "../session/keys.js";
import { getRpcUrl, getBundlerUrl } from "../../config/pragma-config.js";
import type { PragmaConfig } from "../../types/index.js";
import type { SignedDelegation } from "./types.js";

// MARK: - ABIs

const NONCE_ENFORCER_ABI = [
  {
    type: "function",
    name: "incrementNonce",
    stateMutability: "nonpayable",
    inputs: [{ name: "delegationManager", type: "address" }],
    outputs: [],
  },
] as const;

const DELEGATION_MANAGER_DISABLE_ABI = [
  {
    type: "function",
    name: "disableDelegation",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "delegation",
        type: "tuple",
        components: [
          { name: "delegate", type: "address" },
          { name: "delegator", type: "address" },
          { name: "authority", type: "bytes32" },
          {
            name: "caveats",
            type: "tuple[]",
            components: [
              { name: "enforcer", type: "address" },
              { name: "terms", type: "bytes" },
              { name: "args", type: "bytes" },
            ],
          },
          { name: "salt", type: "uint256" },
          { name: "signature", type: "bytes" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

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

export interface IncrementNonceResult {
  userOpHash: Hex;
  transactionHash?: Hex;
  previousNonce: bigint;
  newNonce: bigint;
}

export interface DisableSubDelegationResult {
  txHash: Hex;
}

// MARK: - Gas Constants

const MIN_VERIFICATION_GAS_LIMIT = 500_000n;
const MIN_PRE_VERIFICATION_GAS = 400_000n;
const MIN_CALL_GAS_LIMIT = 100_000n;

// MARK: - Bundler Helpers

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
    { operationName: "revocation-gas-price" }
  );
}

function parseGasValue(value?: string | null): bigint | undefined {
  if (!value || value === "0x") return undefined;
  const parsed = BigInt(value);
  return parsed > 0n ? parsed : undefined;
}

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
    { operationName: "revocation-estimate-gas" }
  );
}

function clampMin(value: bigint | undefined, min: bigint): bigint {
  return value !== undefined && value > min ? value : min;
}

function applyGasEstimates(
  userOp: SignableUserOp,
  estimates: {
    callGasLimit?: bigint;
    verificationGasLimit?: bigint;
    preVerificationGas?: bigint;
  }
): void {
  userOp.callGasLimit = clampMin(estimates.callGasLimit, MIN_CALL_GAS_LIMIT);
  userOp.verificationGasLimit = clampMin(estimates.verificationGasLimit, MIN_VERIFICATION_GAS_LIMIT);
  userOp.preVerificationGas = clampMin(estimates.preVerificationGas, MIN_PRE_VERIFICATION_GAS);
}

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

  const data = (await response.json()) as {
    result?: Hex;
    error?: { code?: number; message: string };
  };

  if (!response.ok) {
    const errorMsg = data.error?.message || `HTTP ${response.status}`;
    throw new Error(`Send UserOp failed: ${errorMsg}`);
  }

  if (data.error) {
    throw new Error(`UserOp error: ${data.error.message}`);
  }

  if (!data.result) {
    throw new Error("No userOpHash returned");
  }

  return data.result;
}

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
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }

      if (data.result?.receipt?.transactionHash) {
        return { transactionHash: data.result.receipt.transactionHash };
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error(`Timeout waiting for UserOp ${userOpHash}`);
}

// MARK: - incrementNonceViaUserOp

/**
 * Increment the NonceEnforcer nonce via a UserOp signed with Touch ID.
 * Invalidates ALL delegations signed with the old nonce.
 */
export async function incrementNonceViaUserOp(
  handle: HybridDelegatorHandle,
  publicClient: PublicClient,
  config: PragmaConfig
): Promise<IncrementNonceResult> {
  const previousNonce = await getCurrentNonce(publicClient, handle.address);

  const incrementData = encodeFunctionData({
    abi: NONCE_ENFORCER_ABI,
    functionName: "incrementNonce",
    args: [getAddress(DELEGATION_FRAMEWORK.delegationManager)],
  });

  const callData = encodeFunctionData({
    abi: HYBRID_DELEGATOR_EXECUTE_ABI,
    functionName: "execute",
    args: [
      {
        target: DELEGATION_FRAMEWORK.enforcers.nonce,
        value: 0n,
        callData: incrementData,
      },
    ],
  });

  const bundlerUrl = await getBundlerUrl(config);
  const accountNonce = (await handle.smartAccount.getNonce?.()) ?? 0n;
  const gasPrices = await getGasPrice(bundlerUrl);

  const userOp: SignableUserOp = {
    sender: handle.address,
    nonce: accountNonce,
    callData,
    callGasLimit: MIN_CALL_GAS_LIMIT,
    verificationGasLimit: MIN_VERIFICATION_GAS_LIMIT,
    preVerificationGas: MIN_PRE_VERIFICATION_GAS,
    maxFeePerGas: gasPrices.maxFeePerGas,
    maxPriorityFeePerGas: gasPrices.maxPriorityFeePerGas,
    signature: "0x" as Hex,
  };

  const entryPoint = handle.smartAccount.entryPoint.address;

  try {
    const estimationRequest = formatUserOperationRequest({
      ...userOp,
      signature: "0x" as Hex,
    } as unknown as UserOperationRequest);

    const gasEstimates = await estimateUserOpGas(
      bundlerUrl,
      estimationRequest,
      entryPoint
    );
    applyGasEstimates(userOp, gasEstimates);
  } catch (error) {
    console.warn("Failed to estimate gas for nonce increment, using defaults:", error);
  }

  const signature = await handle.smartAccount.signUserOperation(userOp);
  userOp.signature = signature;

  const rpcUserOperation = formatUserOperationRequest({
    ...userOp,
    signature,
  } as unknown as UserOperationRequest);

  const userOpHash = await sendUserOperation(
    bundlerUrl,
    rpcUserOperation,
    entryPoint
  );

  const receipt = await waitForUserOperationReceipt(bundlerUrl, userOpHash);

  // Allow chain state to settle before verifying nonce
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const newNonce = await getCurrentNonce(publicClient, handle.address);

  return {
    userOpHash,
    transactionHash: receipt.transactionHash,
    previousNonce,
    newNonce,
  };
}

// MARK: - disableSubDelegationViaSessionKey

/**
 * Disable a specific sub-delegation on-chain via DelegationManager.disableDelegation().
 * The session key is the delegator for sub-delegations, so no Touch ID is required.
 */
export async function disableSubDelegationViaSessionKey(
  delegation: SignedDelegation,
  config: PragmaConfig,
  chain: Chain
): Promise<DisableSubDelegationResult> {
  const sessionKey = await getSessionKey();
  if (!sessionKey) {
    throw new Error("Session key not found. Please run setup_wallet first.");
  }

  const sessionAccount = getSessionAccount(sessionKey);
  const rpcUrl = await getRpcUrl(config);

  const walletClient = createWalletClient({
    account: sessionAccount,
    chain,
    transport: createSyncHttpTransport(rpcUrl, config),
  });

  const delegationStruct = {
    ...delegation,
    salt: typeof delegation.salt === "bigint"
      ? delegation.salt
      : BigInt(delegation.salt),
  };

  const disableData = encodeFunctionData({
    abi: DELEGATION_MANAGER_DISABLE_ABI,
    functionName: "disableDelegation",
    args: [delegationStruct],
  });

  const txHash = await walletClient.sendTransaction({
    to: getAddress(DELEGATION_FRAMEWORK.delegationManager),
    data: disableData,
  });

  return { txHash };
}

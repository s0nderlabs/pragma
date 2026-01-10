// Smart Account Deployment
// Handles deploying HybridDelegator via bundler/paymaster
// Adapted from pragma-v2-stable (H2) for pragma-mcp
// Copyright (c) 2026 s0nderlabs

import type { Address, Hex } from "viem";
import { formatUserOperationRequest, type UserOperationRequest } from "viem/account-abstraction";
import type { HybridDelegatorHandle } from "./hybridDelegator.js";
import {
  isSmartAccountDeployed,
  getFactoryArgs,
  getAccountNonce,
  getEntryPointAddress,
} from "./hybridDelegator.js";
import { getBundlerUrl } from "../../config/pragma-config.js";
import type { PragmaConfig } from "../../types/index.js";

/**
 * Result of deployment operation
 */
export interface DeploymentResult {
  success: boolean;
  userOpHash?: Hex;
  transactionHash?: Hex;
  error?: string;
  alreadyDeployed?: boolean;
}

/**
 * Gas configuration
 * P-256 WebAuthn verification requires higher gas limits than standard EOA
 */
const MIN_VERIFICATION_GAS_LIMIT = 500_000n;
const MIN_PRE_VERIFICATION_GAS = 200_000n;
const GAS_BUFFER_MULTIPLIER = 150n; // 1.5x buffer

/**
 * Apply 1.5x buffer to gas estimate and ensure minimum floor
 */
function applyGasFloor(current: bigint, minimum: bigint): bigint {
  const buffered = current > 0n ? (current * GAS_BUFFER_MULTIPLIER) / 100n : 0n;
  return buffered > minimum ? buffered : minimum;
}

/**
 * Signable UserOp type
 */
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
 * Sponsorship response from Pimlico
 */
interface PimlicoSponsorship {
  paymasterAndData: Hex;
  paymaster?: Address;
  paymasterData?: Hex;
  preVerificationGas?: bigint;
  verificationGasLimit?: bigint;
  callGasLimit?: bigint;
  paymasterPostOpGasLimit?: bigint;
  paymasterVerificationGasLimit?: bigint;
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
 * Build sponsorship request (clear paymaster fields)
 */
function buildSponsorRequest(op: SignableUserOp): Record<string, unknown> {
  return formatUserOperationRequest({
    ...op,
    paymaster: undefined,
    paymasterData: undefined,
    signature: "0x" as Hex,
  } as unknown as UserOperationRequest);
}

/**
 * Apply sponsorship to userOp (from H2 paymasterUtils.ts)
 */
function applySponsorshipToUserOp(target: SignableUserOp, update: PimlicoSponsorship): void {
  // Update gas limits if provided
  if (update.callGasLimit && update.callGasLimit > 0n) {
    target.callGasLimit = update.callGasLimit;
  }
  if (update.verificationGasLimit && update.verificationGasLimit > 0n) {
    target.verificationGasLimit = update.verificationGasLimit;
  }
  if (update.preVerificationGas && update.preVerificationGas > 0n) {
    target.preVerificationGas = update.preVerificationGas;
  }

  // Add paymaster gas limits
  if (update.paymasterPostOpGasLimit) {
    target.paymasterPostOpGasLimit = update.paymasterPostOpGasLimit;
  }
  if (update.paymasterVerificationGasLimit) {
    target.paymasterVerificationGasLimit = update.paymasterVerificationGasLimit;
  }

  // Apply paymaster fields (modern or legacy format)
  if (update.paymaster) {
    target.paymaster = update.paymaster;
    target.paymasterData = update.paymasterData ?? ("0x" as Hex);
  } else {
    // Legacy format: paymasterAndData (first 20 bytes = paymaster, rest = data)
    target.paymaster = `0x${update.paymasterAndData.slice(2, 42)}` as Address;
    target.paymasterData = `0x${update.paymasterAndData.slice(42)}` as Hex;
  }
}

/**
 * Sponsor a user operation via Pimlico paymaster
 */
async function sponsorUserOperation(
  bundlerUrl: string,
  userOp: Record<string, unknown>,
  entryPoint: Address
): Promise<PimlicoSponsorship> {
  const response = await fetch(bundlerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "pm_sponsorUserOperation",
      params: [userOp, entryPoint],
      id: 1,
    }),
  });

  if (!response.ok) {
    throw new Error(`Paymaster request failed: ${response.status}`);
  }

  const data = (await response.json()) as {
    result?: Record<string, string | null | undefined>;
    error?: { message: string };
  };

  if (data.error) {
    throw new Error(`Paymaster error: ${data.error.message}`);
  }

  const result = data.result;
  if (!result) {
    throw new Error("Pimlico paymaster did not return a result");
  }

  // Build paymasterAndData from separate fields if needed
  let paymasterAndData = result.paymasterAndData as string | undefined;
  if ((!paymasterAndData || paymasterAndData === "0x") && result.paymaster && result.paymasterData) {
    paymasterAndData = `${result.paymaster}${(result.paymasterData as string).slice(2)}`;
  }

  if (!paymasterAndData || paymasterAndData === "0x") {
    throw new Error(`Pimlico paymaster response missing paymasterAndData`);
  }

  return {
    paymasterAndData: paymasterAndData as Hex,
    paymaster: result.paymaster as Address | undefined,
    paymasterData: result.paymasterData as Hex | undefined,
    preVerificationGas: parseGasValue(result.preVerificationGas),
    verificationGasLimit: parseGasValue(result.verificationGasLimit),
    callGasLimit: parseGasValue(result.callGasLimit),
    paymasterPostOpGasLimit: parseGasValue(result.paymasterPostOpGasLimit),
    paymasterVerificationGasLimit: parseGasValue(result.paymasterVerificationGasLimit),
  };
}

/**
 * Get gas price recommendations from Pimlico
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
 * Estimate gas via bundler (with paymaster context)
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

/**
 * Deploy the smart account via bundler
 * Uses paymaster for gasless deployment
 * Follows H2's deployment flow exactly
 */
export async function deploySmartAccount(
  handle: HybridDelegatorHandle,
  config: PragmaConfig
): Promise<DeploymentResult> {
  // Check if already deployed
  if (await isSmartAccountDeployed(handle)) {
    return {
      success: true,
      alreadyDeployed: true,
    };
  }

  // Get bundler URL
  const bundlerUrl = getBundlerUrl(config);
  if (!bundlerUrl) {
    return {
      success: false,
      error: "No bundler URL configured. Set PIMLICO_API_KEY or configure bundler in config.",
    };
  }

  // Get factory args
  const factoryArgs = await getFactoryArgs(handle);
  if (!factoryArgs) {
    return {
      success: false,
      error: "Failed to get factory args for deployment",
    };
  }

  // Get entry point and nonce
  const entryPoint = getEntryPointAddress(handle);
  const nonce = await getAccountNonce(handle);

  // Get gas price from bundler
  const gasPrices = await getGasPrice(bundlerUrl);

  // Step 1: Build baseUserOp with 0n gas values (let paymaster estimate)
  const baseUserOp: SignableUserOp = {
    sender: handle.address,
    nonce,
    factory: factoryArgs.factory,
    factoryData: factoryArgs.factoryData,
    callData: "0x" as Hex,
    callGasLimit: 0n,
    verificationGasLimit: 0n,
    preVerificationGas: 0n,
    maxFeePerGas: gasPrices.maxFeePerGas,
    maxPriorityFeePerGas: gasPrices.maxPriorityFeePerGas,
    signature: "0x" as Hex,
  };

  // Working copy of userOp
  const userOp: SignableUserOp = { ...baseUserOp };

  // Step 2: First sponsorship - paymaster returns gas estimates
  let sponsorship = await sponsorUserOperation(
    bundlerUrl,
    buildSponsorRequest(baseUserOp),
    entryPoint
  );
  applySponsorshipToUserOp(userOp, sponsorship);

  // Step 3: If gas values are still 0n, estimate via bundler
  let gasAdjusted = false;
  const setGasValue = (
    field: "callGasLimit" | "verificationGasLimit" | "preVerificationGas",
    value?: bigint
  ) => {
    if (!value || value <= 0n) return;
    if (userOp[field] === value) return;
    userOp[field] = value;
    gasAdjusted = true;
  };

  if (!userOp.callGasLimit || userOp.callGasLimit === 0n ||
      !userOp.verificationGasLimit || userOp.verificationGasLimit === 0n) {
    try {
      const estimationRequest = formatUserOperationRequest({
        ...userOp,
        signature: "0x" as Hex,
      } as unknown as UserOperationRequest);

      const estimation = await estimateUserOpGas(
        bundlerUrl,
        estimationRequest,
        entryPoint
      );

      setGasValue("callGasLimit", estimation.callGasLimit);
      setGasValue("verificationGasLimit", estimation.verificationGasLimit);
      setGasValue("preVerificationGas", estimation.preVerificationGas);
    } catch (error) {
      console.warn("Failed to estimate HybridDelegator gas via bundler", error);
    }
  }

  // Step 4: Apply minimum floors with buffer (P-256 WebAuthn needs substantial gas)
  const adjustedVerificationGas = applyGasFloor(userOp.verificationGasLimit, MIN_VERIFICATION_GAS_LIMIT);
  if (userOp.verificationGasLimit < adjustedVerificationGas) {
    setGasValue("verificationGasLimit", adjustedVerificationGas);
  }

  const adjustedPreVerificationGas = applyGasFloor(userOp.preVerificationGas, MIN_PRE_VERIFICATION_GAS);
  if (userOp.preVerificationGas < adjustedPreVerificationGas) {
    setGasValue("preVerificationGas", adjustedPreVerificationGas);
  }

  // Step 5: Re-sponsor if gas was adjusted (paymaster needs to sign new values)
  // CRITICAL: DO NOT modify ANY fields after this sponsorship - it will invalidate the signature
  if (gasAdjusted) {
    sponsorship = await sponsorUserOperation(
      bundlerUrl,
      buildSponsorRequest(userOp),
      entryPoint
    );
    applySponsorshipToUserOp(userOp, sponsorship);

    // DO NOT modify userOp after this point - paymaster has signed over these exact values
    // Per Pimlico docs: "make sure you do not modify any fields after the paymaster signs over it (except signature)"
  }

  // Step 6: Sign the user operation
  const signature = await handle.smartAccount.signUserOperation(userOp);

  // Step 7: Format and send
  const rpcUserOperation = formatUserOperationRequest({
    ...userOp,
    signature,
  } as unknown as UserOperationRequest);

  const userOpHash = await sendUserOperation(bundlerUrl, rpcUserOperation, entryPoint);

  // Step 8: Wait for receipt
  try {
    const receipt = await waitForUserOperationReceipt(bundlerUrl, userOpHash);
    return {
      success: true,
      userOpHash,
      transactionHash: receipt.transactionHash,
    };
  } catch (error) {
    // Check if deployed despite timeout
    if (await isSmartAccountDeployed(handle)) {
      return {
        success: true,
        userOpHash,
      };
    }

    return {
      success: false,
      userOpHash,
      error: error instanceof Error ? error.message : "Deployment failed",
    };
  }
}

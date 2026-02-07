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
import { withRetryOrThrow } from "../utils/retry.js";

export interface DeploymentResult {
  success: boolean;
  userOpHash?: Hex;
  transactionHash?: Hex;
  error?: string;
  alreadyDeployed?: boolean;
}

export interface DeployOptions {
  /** Skip deployment and nonce checks for fresh passkeys (avoids unnecessary RPC calls) */
  skipInitialChecks?: boolean;
}

// P-256 WebAuthn verification requires higher gas limits than standard EOA
const MIN_VERIFICATION_GAS_LIMIT = 500_000n;
const MIN_PRE_VERIFICATION_GAS = 200_000n;
const GAS_BUFFER_MULTIPLIER = 150n; // 1.5x buffer

/** Apply 1.5x buffer to gas estimate and ensure minimum floor. */
function applyGasFloor(current: bigint, minimum: bigint): bigint {
  const buffered = current > 0n ? (current * GAS_BUFFER_MULTIPLIER) / 100n : 0n;
  return buffered > minimum ? buffered : minimum;
}

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

function parseGasValue(value?: string | null): bigint | undefined {
  if (!value || value === "0x") return undefined;
  try {
    const parsed = BigInt(value);
    return parsed > 0n ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Build sponsorship request with paymaster fields cleared. */
function buildSponsorRequest(op: SignableUserOp): Record<string, unknown> {
  return formatUserOperationRequest({
    ...op,
    paymaster: undefined,
    paymasterData: undefined,
    signature: "0x" as Hex,
  } as unknown as UserOperationRequest);
}

/** Apply sponsorship fields to userOp (gas limits + paymaster data). */
function applySponsorshipToUserOp(target: SignableUserOp, update: PimlicoSponsorship): void {
  if (update.callGasLimit && update.callGasLimit > 0n) {
    target.callGasLimit = update.callGasLimit;
  }
  if (update.verificationGasLimit && update.verificationGasLimit > 0n) {
    target.verificationGasLimit = update.verificationGasLimit;
  }
  if (update.preVerificationGas && update.preVerificationGas > 0n) {
    target.preVerificationGas = update.preVerificationGas;
  }

  if (update.paymasterPostOpGasLimit) {
    target.paymasterPostOpGasLimit = update.paymasterPostOpGasLimit;
  }
  if (update.paymasterVerificationGasLimit) {
    target.paymasterVerificationGasLimit = update.paymasterVerificationGasLimit;
  }

  // Modern format has separate paymaster/paymasterData fields;
  // legacy format packs both into paymasterAndData (first 20 bytes = address)
  if (update.paymaster) {
    target.paymaster = update.paymaster;
    target.paymasterData = update.paymasterData ?? ("0x" as Hex);
  } else {
    target.paymaster = `0x${update.paymasterAndData.slice(2, 42)}` as Address;
    target.paymasterData = `0x${update.paymasterAndData.slice(42)}` as Hex;
  }
}

/** Sponsor a user operation via Pimlico paymaster (idempotent, retries transient errors). */
async function sponsorUserOperation(
  bundlerUrl: string,
  userOp: Record<string, unknown>,
  entryPoint: Address,
  sessionKeyAddress?: Address
): Promise<PimlicoSponsorship> {
  return withRetryOrThrow(
    async () => {
      const response = await fetch(bundlerUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(sessionKeyAddress && { "X-SESSION-KEY": sessionKeyAddress }),
        },
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
    },
    { operationName: "paymaster-sponsor" }
  );
}

/** Get gas price recommendations from Pimlico (idempotent, retries transient errors). */
async function getGasPrice(
  bundlerUrl: string,
  sessionKeyAddress?: Address
): Promise<{
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}> {
  return withRetryOrThrow(
    async () => {
      const response = await fetch(bundlerUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(sessionKeyAddress && { "X-SESSION-KEY": sessionKeyAddress }),
        },
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

/** Estimate gas via bundler with paymaster context (idempotent, retries transient errors). */
async function estimateUserOpGas(
  bundlerUrl: string,
  userOp: Record<string, unknown>,
  entryPoint: Address,
  sessionKeyAddress?: Address
): Promise<{
  callGasLimit?: bigint;
  verificationGasLimit?: bigint;
  preVerificationGas?: bigint;
}> {
  return withRetryOrThrow(
    async () => {
      const response = await fetch(bundlerUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(sessionKeyAddress && { "X-SESSION-KEY": sessionKeyAddress }),
        },
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
    },
    { operationName: "bundler-estimate-gas" }
  );
}

/** Send user operation to bundler (NOT idempotent -- do not retry). */
async function sendUserOperation(
  bundlerUrl: string,
  userOp: Record<string, unknown>,
  entryPoint: Address,
  sessionKeyAddress?: Address
): Promise<Hex> {
  const response = await fetch(bundlerUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(sessionKeyAddress && { "X-SESSION-KEY": sessionKeyAddress }),
    },
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

/** Poll for user operation receipt until timeout. */
async function waitForUserOperationReceipt(
  bundlerUrl: string,
  userOpHash: Hex,
  timeoutMs: number = 60000,
  sessionKeyAddress?: Address
): Promise<{ transactionHash?: Hex }> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const response = await fetch(bundlerUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(sessionKeyAddress && { "X-SESSION-KEY": sessionKeyAddress }),
      },
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

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error(`Timeout waiting for UserOp ${userOpHash}`);
}

/**
 * Deploy the smart account via bundler with paymaster-sponsored gas.
 * Follows H2's deployment flow: sponsor -> estimate -> re-sponsor -> sign -> submit.
 */
export async function deploySmartAccount(
  handle: HybridDelegatorHandle,
  config: PragmaConfig,
  sessionKeyAddress?: Address,
  options?: DeployOptions
): Promise<DeploymentResult> {
  // Skip deployment check for fresh passkeys — we know it's not deployed
  if (!options?.skipInitialChecks && await isSmartAccountDeployed(handle)) {
    return {
      success: true,
      alreadyDeployed: true,
    };
  }

  let bundlerUrl: string;
  try {
    bundlerUrl = await getBundlerUrl(config);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to get bundler URL",
    };
  }

  const factoryArgs = await getFactoryArgs(handle);
  if (!factoryArgs) {
    return {
      success: false,
      error: "Failed to get factory args for deployment",
    };
  }

  const entryPoint = getEntryPointAddress(handle);
  // Fresh setup nonce is always 0; skip RPC call
  const nonce = options?.skipInitialChecks ? 0n : await getAccountNonce(handle);
  const gasPrices = await getGasPrice(bundlerUrl, sessionKeyAddress);

  // Build base UserOp with 0n gas values — paymaster will estimate
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

  const userOp: SignableUserOp = { ...baseUserOp };

  // First sponsorship — paymaster returns gas estimates
  let sponsorship = await sponsorUserOperation(
    bundlerUrl,
    buildSponsorRequest(baseUserOp),
    entryPoint,
    sessionKeyAddress
  );
  applySponsorshipToUserOp(userOp, sponsorship);

  // If gas values are still 0n after sponsorship, estimate via bundler
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
        entryPoint,
        sessionKeyAddress
      );

      setGasValue("callGasLimit", estimation.callGasLimit);
      setGasValue("verificationGasLimit", estimation.verificationGasLimit);
      setGasValue("preVerificationGas", estimation.preVerificationGas);
    } catch (error) {
      console.warn("Failed to estimate HybridDelegator gas via bundler", error);
    }
  }

  // Apply minimum floors with buffer (P-256 WebAuthn needs substantial gas)
  const adjustedVerificationGas = applyGasFloor(userOp.verificationGasLimit, MIN_VERIFICATION_GAS_LIMIT);
  if (userOp.verificationGasLimit < adjustedVerificationGas) {
    setGasValue("verificationGasLimit", adjustedVerificationGas);
  }

  const adjustedPreVerificationGas = applyGasFloor(userOp.preVerificationGas, MIN_PRE_VERIFICATION_GAS);
  if (userOp.preVerificationGas < adjustedPreVerificationGas) {
    setGasValue("preVerificationGas", adjustedPreVerificationGas);
  }

  // CRITICAL: Re-sponsor if gas was adjusted — paymaster signature covers gas values.
  // DO NOT modify userOp after this sponsorship (except signature field).
  if (gasAdjusted) {
    sponsorship = await sponsorUserOperation(
      bundlerUrl,
      buildSponsorRequest(userOp),
      entryPoint,
      sessionKeyAddress
    );
    applySponsorshipToUserOp(userOp, sponsorship);
  }

  const signature = await handle.smartAccount.signUserOperation(userOp);

  const rpcUserOperation = formatUserOperationRequest({
    ...userOp,
    signature,
  } as unknown as UserOperationRequest);

  const userOpHash = await sendUserOperation(bundlerUrl, rpcUserOperation, entryPoint, sessionKeyAddress);

  try {
    const receipt = await waitForUserOperationReceipt(bundlerUrl, userOpHash, 60000, sessionKeyAddress);
    return {
      success: true,
      userOpHash,
      transactionHash: receipt.transactionHash,
    };
  } catch (error) {
    // Receipt timed out — verify on-chain before reporting failure
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

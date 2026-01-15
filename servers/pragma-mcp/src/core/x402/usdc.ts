// x402 USDC Helpers
// USDC balance checking and transfer utilities for x402 payments
// Copyright (c) 2026 s0nderlabs

import {
  type Address,
  type PublicClient,
  erc20Abi,
  formatUnits,
  parseUnits,
  encodeFunctionData,
} from "viem";
import type { X402OperationType, UsdcBalanceCheck } from "./types.js";

// MARK: - Constants

/**
 * USDC addresses by chain
 */
export const USDC_ADDRESS: Record<number, Address> = {
  143: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" as Address, // Monad mainnet (checksummed)
};

/**
 * USDC decimals (always 6)
 */
export const USDC_DECIMALS = 6;

// MARK: - Thresholds (in USDC base units, 6 decimals)

/**
 * Minimum USDC balance to proceed with x402 operations
 */
export const MIN_USDC_BALANCE = 10_000n; // 0.01 USDC

/**
 * Low balance warning threshold
 * When below this, warn user to fund session key
 */
export const LOW_BALANCE_WARNING = 100_000n; // 0.1 USDC

/**
 * Default recommended funding amount
 */
export const RECOMMENDED_USDC_FUNDING = 1_000_000n; // 1 USDC

// MARK: - Cost Estimates

/**
 * Estimated USDC cost per x402 operation type
 * Based on pragma-api-x402 pricing
 */
export const USDC_COST_PER_OPERATION: Record<X402OperationType, bigint> = {
  rpc: 1000n, // 0.001 USDC
  bundler: 1000n, // 0.001 USDC
  quote: 1000n, // 0.001 USDC
  data: 1000n, // 0.001 USDC
};

/**
 * Safety buffer to add to cost estimates
 */
export const COST_BUFFER = 20_000n; // 0.02 USDC

/**
 * Get minimum required USDC for a single operation
 * This is the actual blocking threshold (much lower than warning threshold)
 *
 * @param opType - Operation type
 * @returns Minimum USDC required (with buffer)
 */
export function getMinRequiredForOperation(opType: X402OperationType): bigint {
  return USDC_COST_PER_OPERATION[opType] + COST_BUFFER;
}

// MARK: - Balance Functions

/**
 * Get USDC balance for an address
 *
 * @param address - Address to check
 * @param publicClient - Viem public client
 * @param chainId - Chain ID for USDC address lookup
 * @returns USDC balance in base units (6 decimals)
 */
export async function getUsdcBalance(
  address: Address,
  publicClient: PublicClient,
  chainId: number
): Promise<bigint> {
  const usdcAddress = USDC_ADDRESS[chainId];
  if (!usdcAddress) {
    throw new Error(`USDC not configured for chain ${chainId}`);
  }

  return publicClient.readContract({
    address: usdcAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  });
}

/**
 * Check if session key has sufficient USDC for operations
 *
 * @param balance - Current USDC balance
 * @param operations - Operations to estimate cost for
 * @returns Balance check result
 */
export function checkUsdcBalanceForOperations(
  balance: bigint,
  operations: { type: X402OperationType; count: number }[]
): UsdcBalanceCheck {
  // Calculate total required
  let required = 0n;
  for (const op of operations) {
    required += USDC_COST_PER_OPERATION[op.type] * BigInt(op.count);
  }

  // Add buffer for safety
  const requiredWithBuffer = required + COST_BUFFER;

  return {
    hasEnough: balance >= requiredWithBuffer,
    required: requiredWithBuffer,
    deficit: balance < requiredWithBuffer ? requiredWithBuffer - balance : 0n,
    lowBalanceWarning: balance < LOW_BALANCE_WARNING,
  };
}

/**
 * Estimate USDC cost for a typical swap operation
 * Swap typically requires: 1 quote + 1 bundler call
 *
 * @returns Estimated cost in USDC base units
 */
export function estimateSwapCost(): bigint {
  return USDC_COST_PER_OPERATION.quote + USDC_COST_PER_OPERATION.bundler;
}

/**
 * Calculate recommended funding amount based on current balance
 *
 * @param currentBalance - Current USDC balance
 * @param minRequired - Minimum required for planned operations
 * @returns Recommended funding amount
 */
export function calculateUsdcFundingAmount(
  currentBalance: bigint,
  minRequired: bigint = MIN_USDC_BALANCE
): bigint {
  // If balance is sufficient, no funding needed
  if (currentBalance >= minRequired) {
    return 0n;
  }

  // Calculate deficit
  const deficit = minRequired - currentBalance;

  // Recommend at least 1 USDC for convenience
  // This covers ~1000 API calls
  if (deficit < RECOMMENDED_USDC_FUNDING) {
    return RECOMMENDED_USDC_FUNDING;
  }

  // Round up to nearest 0.5 USDC
  const halfUsdc = 500_000n;
  return ((deficit + halfUsdc - 1n) / halfUsdc) * halfUsdc;
}

// MARK: - Transfer Helpers

/**
 * Build ERC-20 transfer calldata for USDC
 *
 * @param to - Recipient address
 * @param amount - Amount in base units (6 decimals)
 * @returns Encoded transfer calldata
 */
export function buildUsdcTransferCalldata(
  to: Address,
  amount: bigint
): `0x${string}` {
  return encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [to, amount],
  });
}

// MARK: - Formatting

/**
 * Format USDC balance for display
 *
 * @param balance - Balance in base units (6 decimals)
 * @returns Formatted string (e.g., "1.5 USDC")
 */
export function formatUsdcBalance(balance: bigint): string {
  return `${formatUnits(balance, USDC_DECIMALS)} USDC`;
}

/**
 * Parse USDC amount from string
 *
 * @param amount - Amount string (e.g., "1.5")
 * @returns Amount in base units (6 decimals)
 */
export function parseUsdcAmount(amount: string): bigint {
  return parseUnits(amount, USDC_DECIMALS);
}

/**
 * Check if USDC is configured for a chain
 *
 * @param chainId - Chain ID to check
 * @returns True if USDC address is configured
 */
export function isUsdcConfigured(chainId: number): boolean {
  return chainId in USDC_ADDRESS;
}

/**
 * Get USDC address for a chain
 *
 * @param chainId - Chain ID
 * @returns USDC address or undefined
 */
export function getUsdcAddress(chainId: number): Address | undefined {
  return USDC_ADDRESS[chainId];
}

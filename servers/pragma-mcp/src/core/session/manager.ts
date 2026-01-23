// Session Key Manager
// Manages session key balance checking and funding
// Adapted from pragma-v2-stable (H2)
// Copyright (c) 2026 s0nderlabs

import type { Address, Hex, PublicClient } from "viem";
import { formatEther, getAddress } from "viem";
import {
  GAS_PER_OPERATION,
  MIN_SESSION_KEY_BALANCE,
  SESSION_KEY_FUNDING_AMOUNT,
  MIN_GAS_FOR_DELEGATION,
} from "../../config/constants.js";

// MARK: - Types

/** Operation types for gas estimation */
export type OperationType = keyof typeof GAS_PER_OPERATION;

/** Session key balance status */
export interface SessionKeyBalance {
  /** Current balance in wei */
  balance: bigint;
  /** Whether funding is needed */
  needsFunding: boolean;
  /** Recommended funding amount */
  recommendedFundingAmount: bigint;
}

/** Session key balance check result with operation context */
export interface SessionKeyBalanceCheck extends SessionKeyBalance {
  /** Session key address */
  address: Address;
  /** Balance formatted for display */
  balanceFormatted: string;
  /** Required balance for planned operations */
  requiredBalance: bigint;
  /** Required balance formatted for display */
  requiredBalanceFormatted: string;
  /** Funding method that would be used */
  fundingMethod: "userOp" | "delegation";
}

/** Session key funding config */
export interface SessionKeyFundingConfig {
  smartAccountAddress: Address;
  sessionKeyAddress: Address;
  sessionKeyPrivateKey?: Hex;
  ownerAddress?: Address;
  chainId: number;
}

/** Session key funding result */
export interface SessionKeyFundingResult {
  txHash: Hex;
  newBalance: bigint;
  fundedAmount: bigint;
}

/** Session key funding error */
export class SessionKeyFundingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionKeyFundingError";
  }
}

// MARK: - Gas Constants

export {
  GAS_PER_OPERATION,
  MIN_SESSION_KEY_BALANCE,
  SESSION_KEY_FUNDING_AMOUNT,
  MIN_GAS_FOR_DELEGATION,
};

/** Average gas cost per operation (for batch estimation fallback) */
export const AVG_GAS_PER_OPERATION = 80_000_000_000_000_000n; // 0.08 MON

/** Safety buffer for batch operations */
export const BATCH_SAFETY_BUFFER = 20_000_000_000_000_000n; // 0.02 MON

/** Margin added to funding calculation */
export const FUNDING_SAFETY_MARGIN = 100_000_000_000_000_000n; // 0.1 MON

/** Maximum funding in a single operation (for auto-calculation only) */
export const MAX_FUNDING_AMOUNT = 10_000_000_000_000_000_000n; // 10.0 MON

// MARK: - Operation-Specific Gas Functions

/**
 * Get minimum balance required for a specific operation
 *
 * @param operation - The operation type (swap, transfer, etc.)
 * @returns Minimum balance needed (in wei)
 */
export function getMinBalanceForOperation(operation: OperationType): bigint {
  return GAS_PER_OPERATION[operation];
}

/**
 * Estimate gas for a batch of specific operations
 * More accurate than estimateGasForBatch() because it considers
 * the actual cost of each operation type.
 *
 * @param operations - Array of operation types
 * @returns Total estimated gas needed (in wei)
 */
export function estimateGasForOperations(operations: OperationType[]): bigint {
  if (operations.length === 0) return MIN_SESSION_KEY_BALANCE;

  let total = 0n;
  for (const op of operations) {
    total += GAS_PER_OPERATION[op];
  }
  return total + BATCH_SAFETY_BUFFER;
}

/**
 * Check if session key should be funded for specific operations
 *
 * @param currentBalance - Current session key balance (in wei)
 * @param operations - Array of operation types planned
 * @returns Whether funding is needed
 */
export function shouldFundForOperations(
  currentBalance: bigint,
  operations: OperationType[]
): boolean {
  if (operations.length === 0) return currentBalance < MIN_SESSION_KEY_BALANCE;

  const required = estimateGasForOperations(operations);
  return currentBalance < required;
}

// MARK: - Batch Gas Estimation

/**
 * Estimate gas required for batch operations (using average)
 *
 * @param operationCount - Number of operations planned
 * @returns Estimated gas needed (in wei)
 */
export function estimateGasForBatch(operationCount: number): bigint {
  if (operationCount <= 0) return 0n;

  const totalGas = AVG_GAS_PER_OPERATION * BigInt(operationCount);
  return totalGas + BATCH_SAFETY_BUFFER;
}

/**
 * Check if session key should be funded for batch operations
 *
 * @param currentBalance - Current session key balance (in wei)
 * @param estimatedOperations - Number of operations planned
 * @returns Whether funding is needed before batch execution
 */
export function shouldFundForBatch(
  currentBalance: bigint,
  estimatedOperations: number
): boolean {
  if (estimatedOperations <= 0) return currentBalance < MIN_SESSION_KEY_BALANCE;

  const requiredBalance = estimateGasForBatch(estimatedOperations);
  return currentBalance < requiredBalance;
}

// MARK: - Dynamic Funding Calculation

/**
 * Calculate optimal funding amount based on current balance and required balance
 *
 * @param currentBalance - Current session key balance (in wei)
 * @param requiredBalance - Required balance for planned operations (in wei)
 * @returns Optimal funding amount with safety margin (in wei)
 */
export function calculateFundingAmount(
  currentBalance: bigint,
  requiredBalance: bigint
): bigint {
  // Calculate gap between required and current
  const gap = requiredBalance - currentBalance;

  const fundingAmount = gap + FUNDING_SAFETY_MARGIN;

  // Apply bounds to prevent dust funding and excessive single transfers
  const minFunding = SESSION_KEY_FUNDING_AMOUNT; // 0.5 MON min
  const maxFunding = MAX_FUNDING_AMOUNT; // 3.0 MON max

  // Return bounded amount
  if (fundingAmount < minFunding) return minFunding;
  if (fundingAmount > maxFunding) return maxFunding;
  return fundingAmount;
}

// MARK: - Balance Checking

/**
 * Check session key balance and determine if funding is needed
 *
 * @param sessionKeyAddress - Session key public address
 * @param publicClient - Viem public client
 * @returns Balance information and funding recommendation
 */
export async function checkSessionKeyBalance(
  sessionKeyAddress: Address,
  publicClient: PublicClient
): Promise<SessionKeyBalance> {
  const balance = await publicClient.getBalance({
    address: getAddress(sessionKeyAddress),
  });

  return {
    balance,
    needsFunding: balance < MIN_SESSION_KEY_BALANCE,
    recommendedFundingAmount: SESSION_KEY_FUNDING_AMOUNT,
  };
}

/**
 * Check session key balance with operation context
 *
 * @param sessionKeyAddress - Session key public address
 * @param publicClient - Viem public client
 * @param operationType - Optional specific operation type
 * @param estimatedOperations - Optional number of operations
 * @returns Detailed balance check result
 */
export async function checkSessionKeyBalanceForOperation(
  sessionKeyAddress: Address,
  publicClient: PublicClient,
  operationType?: OperationType,
  estimatedOperations?: number
): Promise<SessionKeyBalanceCheck> {
  const balance = await publicClient.getBalance({
    address: getAddress(sessionKeyAddress),
  });

  // Calculate required balance based on operations
  let requiredBalance: bigint;
  let actualFundingAmount: bigint;

  if (operationType && estimatedOperations && estimatedOperations > 0) {
    // Use operation-specific costs
    const operations: OperationType[] = Array(estimatedOperations).fill(operationType);
    requiredBalance = estimateGasForOperations(operations);
    actualFundingAmount = calculateFundingAmount(balance, requiredBalance);
  } else if (estimatedOperations && estimatedOperations > 0) {
    // Use average-based calculation
    requiredBalance = estimateGasForBatch(estimatedOperations);
    actualFundingAmount = calculateFundingAmount(balance, requiredBalance);
  } else {
    // Fixed: Use traditional threshold
    requiredBalance = MIN_SESSION_KEY_BALANCE;
    actualFundingAmount = SESSION_KEY_FUNDING_AMOUNT;
  }

  const needsFunding = balance < requiredBalance;
  const fundingMethod = balance < MIN_GAS_FOR_DELEGATION ? "userOp" : "delegation";

  return {
    address: sessionKeyAddress,
    balance,
    balanceFormatted: formatEther(balance),
    needsFunding,
    requiredBalance,
    requiredBalanceFormatted: formatEther(requiredBalance),
    recommendedFundingAmount: actualFundingAmount,
    fundingMethod,
  };
}

// MARK: - Formatting Helpers

/**
 * Format session key balance for display
 */
export function formatSessionKeyBalance(balance: bigint): string {
  return `${formatEther(balance)} MON`;
}

/**
 * Get conversational message about session key funding
 */
export function getSessionKeyFundingMessage(balance: bigint): string {
  return (
    `Your session key balance is low (${formatSessionKeyBalance(balance)}). ` +
    `Please call fund_session_key to add ${formatEther(SESSION_KEY_FUNDING_AMOUNT)} MON from your smart account.`
  );
}

/**
 * Check if session key needs funding based on balance
 */
export function needsFunding(balance: bigint): boolean {
  return balance < MIN_SESSION_KEY_BALANCE;
}

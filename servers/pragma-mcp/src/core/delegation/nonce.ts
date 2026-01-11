// Nonce Manager
// Tracks and fetches nonces for NonceEnforcer
// Adapted from pragma-v2-stable (H2)
// Copyright (c) 2026 s0nderlabs

import type { Address, PublicClient } from "viem";
import { DELEGATION_FRAMEWORK } from "../../config/constants.js";

// MARK: - NonceEnforcer ABI

/**
 * Partial ABI for NonceEnforcer contract
 * Only includes the functions we need
 */
const NONCE_ENFORCER_ABI = [
  {
    inputs: [
      { name: "delegationManager", type: "address" },
      { name: "delegator", type: "address" },
    ],
    name: "currentNonce",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// MARK: - Public API

/**
 * Fetch the current nonce for a delegator from the NonceEnforcer contract
 *
 * The nonce is incremented after each delegation redemption that uses NonceEnforcer.
 * All delegations in a batch should use the SAME nonce (the current one at creation time).
 *
 * @param publicClient - Viem public client
 * @param delegator - The delegator (smart account) address
 * @returns Current nonce value
 */
export async function getNonceFromChain(
  publicClient: PublicClient,
  delegator: Address
): Promise<bigint> {
  const nonce = await publicClient.readContract({
    address: DELEGATION_FRAMEWORK.enforcers.nonce,
    abi: NONCE_ENFORCER_ABI,
    functionName: "currentNonce",
    args: [DELEGATION_FRAMEWORK.delegationManager, delegator],
  });

  return nonce;
}

/**
 * Get a fresh nonce for creating delegations
 * This is the main entry point for the delegation builder
 *
 * Pattern from h2:
 * - Always fetch from chain (not cached)
 * - All delegations in a batch use the same nonce
 * - After execution, chain nonce increments automatically
 *
 * @param publicClient - Viem public client
 * @param delegator - The delegator (smart account) address
 * @returns Fresh nonce from chain
 */
export async function getCurrentNonce(
  publicClient: PublicClient,
  delegator: Address
): Promise<bigint> {
  // Always fetch fresh from chain
  // Caching could cause issues if another client incremented the nonce
  return getNonceFromChain(publicClient, delegator);
}

/**
 * Increment nonce is NOT used locally
 * The NonceEnforcer contract handles incrementing automatically on-chain
 * when a delegation is redeemed
 *
 * This function is kept for documentation purposes
 */
export async function incrementNonce(_delegator: Address): Promise<bigint> {
  // Nonce incrementing happens on-chain automatically
  // This function should NOT be used - nonces are managed by NonceEnforcer
  throw new Error(
    "Nonces are managed on-chain by NonceEnforcer. Do not call incrementNonce."
  );
}

// MARK: - Nonce Validation

/**
 * Check if a delegation's nonce is still valid
 *
 * A delegation's nonce is valid if it matches the current on-chain nonce.
 * If the chain nonce has advanced past the delegation's nonce, the delegation
 * has been consumed or invalidated.
 *
 * @param publicClient - Viem public client
 * @param delegator - The delegator address
 * @param delegationNonce - The nonce in the delegation
 * @returns True if the nonce is still valid
 */
export async function isNonceValid(
  publicClient: PublicClient,
  delegator: Address,
  delegationNonce: bigint
): Promise<boolean> {
  const currentNonce = await getNonceFromChain(publicClient, delegator);
  return currentNonce === delegationNonce;
}

/**
 * Wait for a nonce to be consumed
 * Useful for waiting for delegation execution to complete
 *
 * @param publicClient - Viem public client
 * @param delegator - The delegator address
 * @param nonce - The nonce to wait for consumption
 * @param timeoutMs - Timeout in milliseconds (default 30s)
 * @returns True if nonce was consumed, false if timeout
 */
export async function waitForNonceConsumption(
  publicClient: PublicClient,
  delegator: Address,
  nonce: bigint,
  timeoutMs: number = 30000
): Promise<boolean> {
  const startTime = Date.now();
  const pollInterval = 1000; // 1 second

  while (Date.now() - startTime < timeoutMs) {
    const currentNonce = await getNonceFromChain(publicClient, delegator);

    if (currentNonce > nonce) {
      // Nonce has been consumed
      return true;
    }

    // Wait before polling again
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  // Timeout reached
  return false;
}

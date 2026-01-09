// Nonce Manager
// Tracks and increments nonces for NonceEnforcer
// Adapted from pragma-v2-stable (H2)

import type { Address } from "viem";

// TODO: Implement - copy and adapt from H2
// Key patterns to preserve:
// - Per-delegator nonce tracking
// - Atomic increment on use
// - Persistence across sessions

export async function getCurrentNonce(delegator: Address): Promise<bigint> {
  throw new Error("Not implemented");
}

export async function incrementNonce(delegator: Address): Promise<bigint> {
  throw new Error("Not implemented");
}

export async function getNonceFromChain(delegator: Address): Promise<bigint> {
  throw new Error("Not implemented");
}

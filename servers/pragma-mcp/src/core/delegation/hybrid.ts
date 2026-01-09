// Hybrid Delegation Builder
// Creates ephemeral delegations with exact calldata enforcement
// Adapted from pragma-v2-stable (H2)

import type { Address, Hex } from "viem";
import type { CreateDelegationParams, Delegation, Caveat } from "./types.js";

// TODO: Implement - copy and adapt from H2
// Key patterns to preserve:
// - 5 minute expiry default
// - Exact calldata enforcement via AllowedCalldataEnforcer
// - Nonce management via NonceEnforcer
// - Single-use via LimitedCallsEnforcer

export async function createEphemeralDelegation(
  params: CreateDelegationParams
): Promise<Delegation> {
  throw new Error("Not implemented");
}

export function buildSwapCaveats(
  calldata: Hex,
  expiryTimestamp: bigint
): Caveat[] {
  throw new Error("Not implemented");
}

export function buildTransferCaveats(
  calldata: Hex,
  expiryTimestamp: bigint
): Caveat[] {
  throw new Error("Not implemented");
}

export function buildStakeCaveats(
  calldata: Hex,
  expiryTimestamp: bigint
): Caveat[] {
  throw new Error("Not implemented");
}

// EIP-712 Typed Data for Delegations
// Adapted from pragma-v2-stable (H2)

import type { Delegation } from "./types.js";

// TODO: Implement - copy and adapt from H2
// Key patterns to preserve:
// - Correct domain separator for Monad
// - Delegation struct hash matching DelegationManager

export const DELEGATION_TYPEHASH = "0x..."; // TODO: Get from H2

export interface DelegationTypedData {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  };
  types: {
    Delegation: Array<{ name: string; type: string }>;
    Caveat: Array<{ name: string; type: string }>;
  };
  primaryType: "Delegation";
  message: Delegation;
}

export function buildDelegationTypedData(
  delegation: Delegation
): DelegationTypedData {
  throw new Error("Not implemented");
}

export function hashDelegation(delegation: Delegation): string {
  throw new Error("Not implemented");
}

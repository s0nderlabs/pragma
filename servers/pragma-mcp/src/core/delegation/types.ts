// Delegation Types
// Adapted from pragma-v2-stable (H2)

import type { Address, Hex } from "viem";

// Caveat structure for delegation constraints
export interface Caveat {
  enforcer: Address;
  terms: Hex;
}

// Full delegation structure
export interface Delegation {
  delegate: Address;
  delegator: Address;
  authority: Hex;
  caveats: Caveat[];
  salt: bigint;
  signature: Hex;
}

// Delegation creation params
export interface CreateDelegationParams {
  delegator: Address;
  delegate: Address;
  caveats: Caveat[];
  expirySeconds?: number;
}

// Signed delegation ready for execution
export interface SignedDelegation extends Delegation {
  signature: Hex;
}

// Enforcer-specific term builders
export interface NonceEnforcerTerms {
  nonce: bigint;
}

export interface TimestampEnforcerTerms {
  afterTimestamp: bigint;
  beforeTimestamp: bigint;
}

export interface LimitedCallsEnforcerTerms {
  count: bigint;
}

export interface AllowedCalldataEnforcerTerms {
  expectedCalldata: Hex;
}

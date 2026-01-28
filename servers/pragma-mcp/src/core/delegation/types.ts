// Delegation Types
// Adapted from pragma-v2-stable (H2)
// Copyright (c) 2026 s0nderlabs

import type { Address, Hex } from "viem";
import type { Delegation } from "@metamask/smart-accounts-kit";

// Re-export DTK's Delegation type for convenience
export type { Delegation };

// MARK: - Core Types
// Note: Caveat type is defined in hybrid.ts to avoid duplicate exports

/**
 * Signed delegation ready for execution
 * Uses DTK's Delegation type which includes signature field
 */
export type SignedDelegation = Delegation;

// MARK: - Caveat Builder Types
// Note: AllowedCalldataConfig is now defined in hybrid.ts where it's used

// MARK: - Delegation Creation
// Note: DelegationResult, SwapDelegationContext, and ApproveDelegationContext
// are now defined in hybrid.ts which handles the actual delegation creation

// MARK: - Execution

/**
 * Execution struct for redeemDelegations
 */
export interface Execution {
  target: Address;
  value: bigint;
  callData: Hex;
}

/**
 * Full delegation bundle for execution
 */
export interface DelegationBundle {
  delegation: SignedDelegation;
  execution: Execution;
  kind: "approve" | "swap" | "transfer" | "wrap" | "unwrap" | "nadfun_buy" | "nadfun_sell" | "nadfun_create" | "leverup_open" | "leverup_close" | "leverup_update_margin" | "leverup_limit_order" | "leverup_cancel_limit_order";
}

// MARK: - EIP-712 Types
// Note: DelegationTypedData is defined in typedData.ts

// MARK: - Constants
// Note: ZERO_SALT and ROOT_AUTHORITY are now exported from constants.ts and hybrid.ts

// Function selectors (first 4 bytes of keccak256 of function signature)
export const FUNCTION_SELECTORS = {
  // ERC20
  approve: "0x095ea7b3" as Hex, // approve(address,uint256)
  transfer: "0xa9059cbb" as Hex, // transfer(address,uint256)
  // DEX aggregator (0x Exchange Proxy)
  execute: "0x1fff991f" as Hex, // execute((address,address,uint256),bytes[],bytes32)
  // Wrapped native
  deposit: "0xd0e30db0" as Hex, // deposit()
  withdraw: "0x2e1a7d4d" as Hex, // withdraw(uint256)
} as const;

// Byte offsets for calldata enforcement
export const CALLDATA_OFFSETS = {
  // approve(address spender, uint256 amount)
  approve: {
    spender: 4, // After selector
    amount: 36, // 4 + 32
  },
  // 0x execute((address,address,uint256),bytes[],bytes32) - first param is tuple
  // Not used for calldata enforcement - 0x handles routing internally
  execute: {},
  // transfer(address to, uint256 amount)
  transfer: {
    to: 4,
    amount: 36,
  },
} as const;

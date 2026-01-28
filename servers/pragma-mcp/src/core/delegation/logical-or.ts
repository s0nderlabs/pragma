// LogicalOrWrapperEnforcer Builder
// Encodes CaveatGroup[] terms and SelectedGroup args for dynamic group selection
// Copyright (c) 2026 s0nderlabs

import { encodeAbiParameters, type Address, type Hex, concat } from "viem";
import {
  LOGICAL_OR_WRAPPER_ENFORCER,
  ALLOWED_METHODS_ENFORCER,
  ALLOWED_TARGETS_ENFORCER,
  ERC20_APPROVE_SELECTOR,
} from "../../config/constants.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Caveat structure matching DTK's Caveat type
 */
export interface Caveat {
  enforcer: Address;
  terms: Hex;
  args: Hex;
}

/**
 * CaveatGroup for LogicalOrWrapperEnforcer
 * All caveats in a group are ANDed together
 */
export interface CaveatGroup {
  caveats: Caveat[];
}

/**
 * SelectedGroup for execution-time group selection
 * Specifies which group to validate and args for each caveat in that group
 */
export interface SelectedGroup {
  groupIndex: bigint;
  caveatArgs: Hex[];
}

// ============================================================================
// Term Encoders for Inner Enforcers
// ============================================================================

/**
 * Encode terms for AllowedMethodsEnforcer
 *
 * Format: packed array of 4-byte selectors (no length prefix)
 * Example: [0x095ea7b3, 0x12345678] → 0x095ea7b312345678
 *
 * @param selectors - Array of 4-byte function selectors
 */
export function encodeAllowedMethodsTerms(selectors: Hex[]): Hex {
  if (selectors.length === 0) {
    return "0x" as Hex;
  }
  return concat(selectors) as Hex;
}

/**
 * Encode terms for AllowedTargetsEnforcer
 *
 * Format: packed array of 20-byte addresses (no length prefix)
 * Example: [0x1234...5678, 0xabcd...ef01] → 0x1234...5678abcd...ef01
 *
 * @param targets - Array of contract addresses
 */
export function encodeAllowedTargetsTerms(targets: Address[]): Hex {
  if (targets.length === 0) {
    return "0x" as Hex;
  }
  // Addresses are already 20 bytes, just need to concat without 0x prefix issues
  const packed = targets.map((addr) => addr.slice(2).toLowerCase()).join("");
  return `0x${packed}` as Hex;
}

// ============================================================================
// CaveatGroup Builders
// ============================================================================

/**
 * Build the APPROVE group (Group 0)
 *
 * This group allows:
 * - approve() function calls (validated by AllowedMethodsEnforcer)
 * - On ANY token address (no AllowedTargetsEnforcer)
 *
 * Security: Spender validation happens in application code (isSpenderWhitelisted)
 * The on-chain enforcement only validates the method selector is approve().
 */
export function buildApproveGroup(): CaveatGroup {
  return {
    caveats: [
      {
        enforcer: ALLOWED_METHODS_ENFORCER,
        terms: encodeAllowedMethodsTerms([ERC20_APPROVE_SELECTOR]),
        args: "0x" as Hex,
      },
      // NOTE: No AllowedTargetsEnforcer - this is intentional!
      // We need to approve arbitrary tokens (nad.fun tokens, etc.)
      // Spender validation happens in application code for MVP
    ],
  };
}

/**
 * Build the TRADING group (Group 1)
 *
 * This group allows:
 * - Trading function calls (validated by AllowedMethodsEnforcer)
 * - Only to whitelisted protocol addresses (validated by AllowedTargetsEnforcer)
 *
 * @param targets - Array of whitelisted protocol addresses
 * @param selectors - Array of allowed trading function selectors
 */
export function buildTradingGroup(targets: Address[], selectors: Hex[]): CaveatGroup {
  return {
    caveats: [
      {
        enforcer: ALLOWED_TARGETS_ENFORCER,
        terms: encodeAllowedTargetsTerms(targets),
        args: "0x" as Hex,
      },
      {
        enforcer: ALLOWED_METHODS_ENFORCER,
        terms: encodeAllowedMethodsTerms(selectors),
        args: "0x" as Hex,
      },
    ],
  };
}

// ============================================================================
// LogicalOrWrapperEnforcer Encoding
// ============================================================================

/**
 * Encode CaveatGroup[] as terms for LogicalOrWrapperEnforcer
 *
 * The terms encode all possible groups. At execution time, the redeemer
 * specifies which group to validate via the args field.
 *
 * ABI encoding:
 * - CaveatGroup[] = tuple[]
 * - Each CaveatGroup = { caveats: Caveat[] }
 * - Each Caveat = { enforcer: address, terms: bytes, args: bytes }
 *
 * @param groups - Array of caveat groups (ORed together)
 */
export function encodeLogicalOrTerms(groups: CaveatGroup[]): Hex {
  return encodeAbiParameters(
    [
      {
        type: "tuple[]",
        components: [
          {
            name: "caveats",
            type: "tuple[]",
            components: [
              { name: "enforcer", type: "address" },
              { name: "terms", type: "bytes" },
              { name: "args", type: "bytes" },
            ],
          },
        ],
      },
    ],
    [
      groups.map((g) => ({
        caveats: g.caveats.map((c) => ({
          enforcer: c.enforcer,
          terms: c.terms,
          args: c.args,
        })),
      })),
    ]
  );
}

/**
 * Encode SelectedGroup as args for execution
 *
 * The args specify which group to validate and provide args for each caveat
 * in that group. This is passed at EXECUTION time, not creation time.
 *
 * IMPORTANT: args is NOT signed! It can be modified after delegation signing.
 * This allows dynamic group selection without re-signing.
 *
 * @param groupIndex - Index of the group to validate (0 = approve, 1 = trading)
 * @param caveatArgs - Args for each caveat in the selected group
 */
export function encodeSelectedGroupArgs(groupIndex: number, caveatArgs: Hex[] = []): Hex {
  return encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "groupIndex", type: "uint256" },
          { name: "caveatArgs", type: "bytes[]" },
        ],
      },
    ],
    [{ groupIndex: BigInt(groupIndex), caveatArgs }]
  );
}

/**
 * Build complete LogicalOrWrapperEnforcer caveat for root/sub delegations
 *
 * Creates a caveat with:
 * - Group 0: approve() on any token (for ERC20 approvals)
 * - Group 1: trading calls to whitelisted protocols
 *
 * The args field is set to "0x" at creation time and will be modified
 * at execution time to select the appropriate group.
 *
 * @param targets - Trading targets for Group 1 (whitelisted protocol addresses)
 * @param tradingSelectors - Trading selectors for Group 1 (allowed function signatures)
 */
export function buildLogicalOrCaveat(
  targets: Address[],
  tradingSelectors: Hex[]
): { enforcer: Address; terms: Hex; args: Hex } {
  const groups: CaveatGroup[] = [
    buildApproveGroup(), // Group 0: approve
    buildTradingGroup(targets, tradingSelectors), // Group 1: trading
  ];

  return {
    enforcer: LOGICAL_OR_WRAPPER_ENFORCER,
    terms: encodeLogicalOrTerms(groups),
    args: "0x" as Hex, // Will be set at execution time
  };
}

/**
 * Set LogicalOrWrapperEnforcer args on a delegation for the specified group
 *
 * IMPORTANT: This mutates the delegation object in place!
 * Clone before calling if you need to preserve the original.
 *
 * The args field is NOT signed, so modifying it doesn't invalidate the signature.
 * This enables dynamic group selection at execution time.
 *
 * @param delegation - Delegation object with caveats array
 * @param groupIndex - Group to select (0 = approve, 1 = trading)
 */
export function setLogicalOrArgs(
  delegation: { caveats: Array<{ enforcer: Address | string; terms: Hex; args: Hex }> },
  groupIndex: number
): void {
  const logicalOrCaveat = delegation.caveats.find(
    (c) => c.enforcer.toLowerCase() === LOGICAL_OR_WRAPPER_ENFORCER.toLowerCase()
  );

  if (logicalOrCaveat) {
    // Build caveat args for the selected group
    // Group 0 (approve): 1 caveat (AllowedMethods) → ["0x"]
    // Group 1 (trading): 2 caveats (AllowedTargets, AllowedMethods) → ["0x", "0x"]
    const caveatArgs: Hex[] =
      groupIndex === 0 ? (["0x"] as Hex[]) : (["0x", "0x"] as Hex[]);
    logicalOrCaveat.args = encodeSelectedGroupArgs(groupIndex, caveatArgs);
  }
}

/**
 * Get the number of caveats in each group
 * Used to build correct caveatArgs array
 */
export const GROUP_CAVEAT_COUNTS = {
  APPROVE: 1, // AllowedMethods only
  TRADING: 2, // AllowedTargets + AllowedMethods
} as const;

// Sub-Agent Delegation Builder
// Creates persistent sub-delegations for autonomous mode
// Uses DTK redelegation (parentDelegation parameter)
// Copyright (c) 2026 s0nderlabs

import type { Address, Hex } from "viem";
import { toHex } from "viem";
import {
  createDelegation,
  type Delegation,
  type Caveats,
} from "@metamask/smart-accounts-kit";
import { hashDelegation } from "@metamask/delegation-core";

import { buildDelegationTypedData } from "./typedData.js";
import { getDTKEnvironment, ALLOWED_TARGETS_ENFORCER, ALLOWED_METHODS_ENFORCER, VALUE_LTE_ENFORCER } from "../../config/constants.js";
import { USDC_ADDRESS, LVUSD_ADDRESS, LVMON_ADDRESS } from "../leverup/constants.js";
import type { SignedDelegation } from "./types.js";
import { buildLogicalOrCaveat } from "./logical-or.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Parameters for creating a sub-delegation
 */
export interface SubDelegationParams {
  /** Sub-agent wallet address (will be the new delegate) */
  subAgentAddress: Address;
  /** Main Agent's session key address (delegator for sub-delegation) */
  mainAgentAddress: Address;
  /** Parent delegation (root delegation) for authority chain - required for redelegation */
  parentDelegation: Delegation;
  /** Allowed contract addresses */
  allowedTargets: Address[];
  /** Allowed function selectors (optional - if empty, all methods allowed) */
  allowedSelectors?: Hex[];
  /** Delegation expiry in days */
  expiryDays: number;
  /** Max MON value per transaction (for valueLte caveat) */
  valueLtePerTx: bigint;
  /** Max number of trades allowed (for limitedCalls caveat) */
  maxCalls: number;
  /** Chain ID */
  chainId: number;
  /** Current nonce from NonceEnforcer (optional - for revocation support) */
  nonce?: bigint;
}

/**
 * Result of creating a sub-delegation
 */
export interface SubDelegationResult {
  delegation: Delegation;
  typedData: ReturnType<typeof buildDelegationTypedData>;
  expiresAt: number;
  approximateBudget: bigint; // valueLtePerTx * maxCalls
}

/**
 * Agent type to scope mapping
 * Defines which contracts/methods each agent type can access
 */
export interface AgentScope {
  targets: Address[];
  selectors: Hex[];
}

// ============================================================================
// Constants
// ============================================================================

/** Zero salt for sub-delegations (deterministic) */
const ZERO_SALT = "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;

/** Seconds per day */
const SECONDS_PER_DAY = 24 * 60 * 60;

// ============================================================================
// Function Selectors by Agent Type
// ============================================================================

/**
 * LeverUp function selectors (for Kairos agent)
 * Computed from actual function signatures in LeverUp diamond
 * Verified by calculating keccak256 of function signatures
 */
export const LEVERUP_SELECTORS = {
  // openMarketTradeWithPyth((address,bool,address,address,uint96,uint128,uint128,uint128,uint128,uint24),bytes[])
  openMarketTrade: "0xca004414" as Hex,
  // closeTrade(bytes32)
  closeTrade: "0x5177fd3b" as Hex,
  // addMargin(bytes32,address,uint96)
  addMargin: "0xe1379570" as Hex,
  // updateTradeTpAndSl(bytes32,uint128,uint128)
  updateTpSl: "0x2f745df6" as Hex,
  // openLimitOrderWithPyth((address,bool,address,address,uint96,uint128,uint128,uint128,uint128,uint24),bytes[])
  openLimitOrder: "0xf37afc20" as Hex,
  // cancelLimitOrder(bytes32)
  cancelLimitOrder: "0x4584eff6" as Hex,
  // batchCancelLimitOrders(bytes32[])
  batchCancelLimitOrders: "0x54688625" as Hex,
} as const;

/**
 * nad.fun function selectors (for Thymos agent)
 */
export const NADFUN_SELECTORS = {
  // buy((uint256,address,address,uint256))
  buy: "0x6df9e92b" as Hex,
  // sell((uint256,uint256,address,address,uint256))
  sell: "0x5de3085d" as Hex,
  // create((string,string,string,uint256,bytes32,uint8))
  create: "0xba12cd8d" as Hex,
} as const;

/**
 * WMON function selectors
 */
export const WMON_SELECTORS = {
  // deposit()
  deposit: "0xd0e30db0" as Hex,
  // withdraw(uint256)
  withdraw: "0x2e1a7d4d" as Hex,
} as const;

/**
 * DEX Aggregator selectors (0x Exchange Proxy)
 */
export const DEX_SELECTORS = {
  // execute((address,address,uint256),bytes[],bytes32) - 0x Exchange Proxy batch execution
  execute: "0x1fff991f" as Hex,
  // exec(address,address,uint256,address,bytes) - 0x Exchange Proxy single execution wrapper
  exec: "0x2213bc0b" as Hex,
} as const;

/**
 * Get all selectors for a given agent type (Group 1 - TRADING)
 *
 * Note: ERC20 approve() is NOT included here - it's handled by
 * Group 0 (APPROVE) in LogicalOrWrapperEnforcer, which allows
 * approve() on ANY token address without target restrictions.
 */
export function getSelectorsForAgentType(agentType: "kairos" | "thymos" | "pragma"): Hex[] {
  switch (agentType) {
    case "kairos":
      return [...Object.values(LEVERUP_SELECTORS)];
    case "thymos":
      return [
        ...Object.values(NADFUN_SELECTORS),
        ...Object.values(WMON_SELECTORS),
        ...Object.values(DEX_SELECTORS),
      ];
    case "pragma":
      return [
        ...Object.values(LEVERUP_SELECTORS),
        ...Object.values(NADFUN_SELECTORS),
        ...Object.values(WMON_SELECTORS),
        ...Object.values(DEX_SELECTORS),
      ];
  }
}

// ============================================================================
// Caveat Builders
// ============================================================================

/**
 * Build base caveats for persistent sub-delegation (DTK format)
 *
 * These caveats are ADDED to the delegation after scope-based caveats are removed.
 * LogicalOrWrapperEnforcer is added separately after filtering.
 *
 * Caveats:
 * - timestamp: Expiry in days
 * - limitedCalls: Max number of operations
 * - nonce: Optional, for revocation support
 */
function buildPersistentCaveats(
  expiryDays: number,
  maxCalls: number,
  nonce?: bigint
): Caveats {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + expiryDays * SECONDS_PER_DAY;

  const caveats: unknown[] = [
    // Timestamp: Delegation expiry
    {
      type: "timestamp" as const,
      afterThreshold: 0,
      beforeThreshold: expiresAt,
    },
    // LimitedCalls: Max operations
    {
      type: "limitedCalls" as const,
      limit: maxCalls,
    },
  ];

  // Add nonce caveat if provided (for revocation support)
  if (nonce !== undefined) {
    caveats.push({
      type: "nonce" as const,
      nonce: toHex(nonce),
    });
  }

  return caveats as Caveats;
}

// ============================================================================
// Sub-Delegation Builders
// ============================================================================

/**
 * Create a persistent sub-delegation for an autonomous sub-agent
 *
 * Key differences from ephemeral delegations:
 * - Uses parentDelegation for redelegation chain
 * - Longer expiry (days, not 5 minutes)
 * - Higher limitedCalls (configurable, not 1)
 * - Signed by Main Agent's session key (no Touch ID)
 *
 * Uses LogicalOrWrapperEnforcer for OR logic between groups:
 * - Group 0 (APPROVE): approve() on any token address
 * - Group 1 (TRADING): Trading calls to whitelisted protocols
 *
 * Implementation note: DTK requires scope, which generates AllowedTargets and
 * AllowedMethods caveats. We create with scope, then replace those caveats
 * with our LogicalOrWrapperEnforcer for flexible permissions.
 *
 * Security properties:
 * - Time-bound (timestamp enforcer)
 * - Trade count limited (limitedCalls enforcer)
 * - Method validation (AllowedMethodsEnforcer via LogicalOr)
 * - Target validation for trades (AllowedTargetsEnforcer via LogicalOr Group 1)
 * - Revocation via nonce increment (when nonce provided)
 */
export function createSubDelegation(params: SubDelegationParams): SubDelegationResult {
  const {
    parentDelegation,
    subAgentAddress,
    mainAgentAddress,
    allowedTargets,
    allowedSelectors,
    expiryDays,
    valueLtePerTx,
    maxCalls,
    chainId,
    nonce,
  } = params;

  const environment = getDTKEnvironment();
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + expiryDays * SECONDS_PER_DAY;

  // Build base caveats (timestamp + limitedCalls + optional nonce)
  const baseCaveats = buildPersistentCaveats(expiryDays, maxCalls, nonce);

  // Build scope with targets/selectors (required by DTK)
  const selectorsToUse = allowedSelectors && allowedSelectors.length > 0 ? allowedSelectors : [];
  const scope = {
    type: "functionCall" as const,
    targets: allowedTargets,
    selectors: selectorsToUse,
  };

  // Create delegation using DTK WITHOUT parentDelegation
  // We'll set the authority manually to avoid hash computation mismatch
  const delegation = createDelegation({
    environment,
    scope,
    from: mainAgentAddress,
    to: subAgentAddress,
    caveats: baseCaveats,
    salt: ZERO_SALT,
    // Don't pass parentDelegation - DTK's hash computation may have salt type issues
  });

  // CRITICAL: Compute authority hash correctly with bigint salt
  // hashDelegation from delegation-core expects salt as bigint.
  // When parentDelegation is loaded from JSON storage, salt is Hex string.
  // DTK's internal hash computation might not convert correctly, causing InvalidDelegate().
  // We compute the hash ourselves to ensure correctness.
  const parentForHash = {
    ...parentDelegation,
    salt: typeof parentDelegation.salt === "bigint"
      ? parentDelegation.salt
      : BigInt(parentDelegation.salt),
  };
  delegation.authority = hashDelegation(parentForHash);

  // CRITICAL: Replace scope-based enforcers with LogicalOrWrapperEnforcer
  // DTK generates AllowedTargets + AllowedMethods from scope, but we need
  // OR logic instead of AND logic for approve() on arbitrary tokens.
  // Also filter out ValueLteEnforcer (DTK adds with 0 value which can cause issues)
  const scopeEnforcers = [
    ALLOWED_TARGETS_ENFORCER.toLowerCase(),
    ALLOWED_METHODS_ENFORCER.toLowerCase(),
    VALUE_LTE_ENFORCER.toLowerCase(),
  ];

  delegation.caveats = delegation.caveats.filter(
    (caveat) => !scopeEnforcers.includes(caveat.enforcer.toLowerCase())
  );

  // Add LogicalOrWrapperEnforcer caveat at the beginning
  const logicalOrCaveat = buildLogicalOrCaveat(allowedTargets, selectorsToUse);
  delegation.caveats.unshift(logicalOrCaveat);

  // Build typed data for signing (with modified caveats)
  const typedData = buildDelegationTypedData(delegation, chainId);

  return {
    delegation,
    typedData,
    expiresAt,
    approximateBudget: valueLtePerTx * BigInt(maxCalls),
  };
}

/**
 * Create a Kairos (strategic/perps) sub-delegation
 *
 * Access:
 * - LeverUp diamond (all perpetual trading methods)
 * - Higher per-tx limit (perps can be larger positions)
 */
export function createKairosSubDelegation(
  leverUpDiamond: Address,
  subAgentAddress: Address,
  mainAgentAddress: Address,
  parentDelegation: Delegation,
  expiryDays: number,
  valueLtePerTx: bigint,
  maxCalls: number,
  chainId: number,
  nonce?: bigint
): SubDelegationResult {
  return createSubDelegation({
    subAgentAddress,
    mainAgentAddress,
    parentDelegation,
    // Include LeverUp Diamond + ERC20 tokens (for approve() calls)
    allowedTargets: [leverUpDiamond, USDC_ADDRESS, LVUSD_ADDRESS, LVMON_ADDRESS],
    // No selector restriction - allow all LeverUp methods + approve
    expiryDays,
    valueLtePerTx,
    maxCalls,
    chainId,
    nonce,
  });
}

/**
 * Create a Thymos (momentum/memecoin) sub-delegation
 *
 * Access:
 * - nad.fun router (memecoin trading)
 * - DEX aggregator (swaps)
 * - WMON (wrap/unwrap)
 * - Lower per-tx limit (smaller, faster trades)
 */
export function createThymosSubDelegation(
  nadfunRouter: Address,
  dexAggregator: Address,
  wmonAddress: Address,
  subAgentAddress: Address,
  mainAgentAddress: Address,
  parentDelegation: Delegation,
  expiryDays: number,
  valueLtePerTx: bigint,
  maxCalls: number,
  chainId: number,
  nonce?: bigint
): SubDelegationResult {
  return createSubDelegation({
    subAgentAddress,
    mainAgentAddress,
    parentDelegation,
    allowedTargets: [nadfunRouter, dexAggregator, wmonAddress],
    // No selector restriction - allow all trading methods
    expiryDays,
    valueLtePerTx,
    maxCalls,
    chainId,
    nonce,
  });
}

/**
 * Create a Pragma (general-purpose) sub-delegation
 *
 * Access:
 * - All specified targets
 * - Flexible for custom tasks and new features
 */
export function createPragmaSubDelegation(
  allowedTargets: Address[],
  subAgentAddress: Address,
  mainAgentAddress: Address,
  parentDelegation: Delegation,
  expiryDays: number,
  valueLtePerTx: bigint,
  maxCalls: number,
  chainId: number,
  nonce?: bigint
): SubDelegationResult {
  return createSubDelegation({
    subAgentAddress,
    mainAgentAddress,
    parentDelegation,
    allowedTargets,
    // No selector restriction for general agent
    expiryDays,
    valueLtePerTx,
    maxCalls,
    chainId,
    nonce,
  });
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Calculate approximate budget from delegation parameters
 */
export function calculateApproximateBudget(
  valueLtePerTx: bigint,
  maxCalls: number
): bigint {
  return valueLtePerTx * BigInt(maxCalls);
}

/**
 * Validate sub-delegation parameters
 * Note: parentDelegation is not validated here as it's only needed for creation
 */
export function validateSubDelegationParams(params: Omit<SubDelegationParams, 'parentDelegation'>): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (params.expiryDays < 1 || params.expiryDays > 30) {
    errors.push("expiryDays must be between 1 and 30");
  }

  if (params.maxCalls < 1 || params.maxCalls > 1000) {
    errors.push("maxCalls must be between 1 and 1000");
  }

  if (params.valueLtePerTx <= 0n) {
    errors.push("valueLtePerTx must be positive");
  }

  if (params.allowedTargets.length === 0) {
    errors.push("allowedTargets must have at least one address");
  }

  // Note: empty allowedSelectors means all methods are allowed (permissive)
  // This is intentional for flexibility in agent scopes

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Get expiry timestamp from days
 */
export function getExpiryTimestamp(expiryDays: number): number {
  const now = Math.floor(Date.now() / 1000);
  return now + expiryDays * SECONDS_PER_DAY;
}

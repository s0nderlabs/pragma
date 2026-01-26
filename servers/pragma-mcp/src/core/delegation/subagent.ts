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

import { buildDelegationTypedData } from "./typedData.js";
import { getDTKEnvironment } from "../../config/constants.js";
import type { SignedDelegation } from "./types.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Parameters for creating a sub-delegation
 */
export interface SubDelegationParams {
  /** User's signed root delegation (Main Agent is delegate) */
  parentDelegation?: SignedDelegation;
  /** Sub-agent wallet address (will be the new delegate) */
  subAgentAddress: Address;
  /** Main Agent's session key address (delegator for sub-delegation) */
  mainAgentAddress: Address;
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
 * Computed from function signatures using keccak256
 */
export const LEVERUP_SELECTORS = {
  // openMarketTradeWithPyth((address,bool,address,address,uint96,uint128,uint128,uint128,uint128,uint24),bytes[])
  openMarketTrade: "0x8739e924" as Hex,
  // closeTrade(bytes32)
  closeTrade: "0x6e25e216" as Hex,
  // addMargin(bytes32,address,uint96)
  addMargin: "0xe1379570" as Hex,
  // updateTradeTpAndSl(bytes32,uint128,uint128)
  updateTpSl: "0x2f745df6" as Hex,
  // openLimitOrderWithPyth((address,bool,address,address,uint96,uint128,uint128,uint128,uint128,uint24),bytes[])
  openLimitOrder: "0xf22b4898" as Hex,
  // cancelLimitOrder(bytes32)
  cancelLimitOrder: "0x56189236" as Hex,
} as const;

/**
 * nad.fun function selectors (for Thymos agent)
 */
export const NADFUN_SELECTORS = {
  // buy((uint256,address,address,uint256))
  buy: "0x0f5b0d09" as Hex,
  // sell((uint256,uint256,address,address,uint256))
  sell: "0xd4e19b4b" as Hex,
  // create((string,string,string,uint256,bytes32,uint8))
  create: "0x8b159e6e" as Hex,
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
 * DEX Aggregator selectors
 */
export const DEX_SELECTORS = {
  // aggregate(address,address,uint256,uint256,address,bytes)
  aggregate: "0x087c2af4" as Hex,
} as const;

/**
 * Get all selectors for a given agent type
 */
export function getSelectorsForAgentType(agentType: "kairos" | "thymos" | "pragma"): Hex[] {
  switch (agentType) {
    case "kairos":
      return Object.values(LEVERUP_SELECTORS);
    case "thymos":
      return [
        ...Object.values(NADFUN_SELECTORS),
        ...Object.values(WMON_SELECTORS),
        DEX_SELECTORS.aggregate,
      ];
    case "pragma":
      return [
        ...Object.values(LEVERUP_SELECTORS),
        ...Object.values(NADFUN_SELECTORS),
        ...Object.values(WMON_SELECTORS),
        DEX_SELECTORS.aggregate,
      ];
  }
}

// ============================================================================
// Caveat Builders
// ============================================================================

/**
 * Build caveats for persistent sub-delegation (DTK format)
 *
 * Unlike ephemeral delegations:
 * - Longer expiry (days, not minutes)
 * - Higher call limit (configurable)
 *
 * Note: valueLte is added in scope, not caveats, per DTK convention
 */
function buildPersistentCaveats(
  expiryDays: number,
  maxCalls: number,
  nonce?: bigint
): Caveats {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + expiryDays * SECONDS_PER_DAY;

  const caveats: unknown[] = [
    {
      type: "timestamp" as const,
      afterThreshold: 0,
      beforeThreshold: expiresAt,
    },
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
 * Security properties:
 * - Time-bound (timestamp enforcer)
 * - Trade count limited (limitedCalls enforcer)
 * - Per-tx MON cap (valueLte when applicable)
 * - Contract whitelist (allowedTargets in scope)
 * - Optional method whitelist (allowedMethods in scope)
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

  // Build scope based on targets and selectors
  // valueLte goes in scope (not caveats) per DTK convention
  const scope: {
    type: "functionCall";
    targets: Address[];
    selectors: Hex[];
    valueLte?: { maxValue: bigint };
  } = {
    type: "functionCall" as const,
    targets: allowedTargets,
    selectors: allowedSelectors && allowedSelectors.length > 0 ? allowedSelectors : [],
  };

  // Add valueLte to scope if specified
  if (valueLtePerTx !== undefined && valueLtePerTx > 0n) {
    scope.valueLte = { maxValue: valueLtePerTx };
  }

  // Build caveats (without valueLte - that's in scope)
  const caveats = buildPersistentCaveats(expiryDays, maxCalls, nonce);

  // Create delegation using DTK
  // If parentDelegation is provided, this creates a redelegation
  const delegation = createDelegation({
    environment,
    scope,
    from: mainAgentAddress,
    to: subAgentAddress,
    caveats,
    salt: ZERO_SALT,
    // Note: parentDelegation is used when redeeming, not when creating
    // The delegation chain is assembled at execution time
  });

  // Build typed data for signing
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
  expiryDays: number,
  valueLtePerTx: bigint,
  maxCalls: number,
  chainId: number,
  nonce?: bigint
): SubDelegationResult {
  return createSubDelegation({
    subAgentAddress,
    mainAgentAddress,
    allowedTargets: [leverUpDiamond],
    // No selector restriction - allow all LeverUp methods
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
  expiryDays: number,
  valueLtePerTx: bigint,
  maxCalls: number,
  chainId: number,
  nonce?: bigint
): SubDelegationResult {
  return createSubDelegation({
    subAgentAddress,
    mainAgentAddress,
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
  expiryDays: number,
  valueLtePerTx: bigint,
  maxCalls: number,
  chainId: number,
  nonce?: bigint
): SubDelegationResult {
  return createSubDelegation({
    subAgentAddress,
    mainAgentAddress,
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
 */
export function validateSubDelegationParams(params: SubDelegationParams): {
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

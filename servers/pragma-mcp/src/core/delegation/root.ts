// Root Delegation Builder
// Creates persistent root delegations for autonomous mode (User → Main Agent)
// Requires Touch ID once, then enables sub-agent creation without Touch ID
// Copyright (c) 2026 s0nderlabs

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type { Address, Hex } from "viem";
import { parseEther, formatEther } from "viem";
import {
  createDelegation,
  type Delegation,
  type Caveats,
} from "@metamask/smart-accounts-kit";

import { buildDelegationTypedData } from "./typedData.js";
import { hashDelegation } from "@metamask/delegation-core";
import { signDelegationWithP256 } from "../signer/p256SignerConfig.js";
import { getDTKEnvironment, ALLOWED_TARGETS_ENFORCER, ALLOWED_METHODS_ENFORCER, VALUE_LTE_ENFORCER } from "../../config/constants.js";
import { SUPPORTED_CHAINS } from "../../config/chains.js";
import { LEVERUP_DIAMOND, WMON_ADDRESS, USDC_ADDRESS, LVUSD_ADDRESS, LVMON_ADDRESS } from "../leverup/constants.js";
import { NADFUN_CONTRACTS } from "../nadfun/constants.js";
import { formatTimeRemaining } from "../utils/index.js";
import type { SignedDelegation } from "./types.js";
import {
  LEVERUP_SELECTORS,
  NADFUN_SELECTORS,
  WMON_SELECTORS,
  DEX_SELECTORS,
} from "./subagent.js";
import { buildLogicalOrCaveat } from "./logical-or.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Parameters for creating a root delegation
 */
export interface RootDelegationParams {
  /** User's smart account address (delegator) */
  delegator: Address;
  /** Main Agent's session key address (delegate) */
  sessionKey: Address;
  /** Delegation expiry in days (1-30) */
  expiryDays: number;
  /** Max MON value per transaction (wei) */
  valueLtePerTx: bigint;
  /** Max number of calls allowed */
  maxCalls: number;
  /** Chain ID */
  chainId: number;
  /** Passkey key ID for Touch ID signing */
  keyId: string;
  /** Custom Touch ID prompt message */
  touchIdMessage?: string;
}

/**
 * Result of creating a root delegation (before signing)
 */
export interface RootDelegationResult {
  delegation: Delegation;
  typedData: ReturnType<typeof buildDelegationTypedData>;
  expiresAt: number;
  approximateBudget: bigint;
  allowedTargets: Address[];
}

/**
 * Stored root delegation with metadata
 */
export interface StoredRootDelegation {
  /** EIP-712 hash of the delegation */
  delegationHash: Hex;
  /** Full signed delegation object */
  delegation: SignedDelegation;
  /** Allowed contract addresses */
  allowedTargets: Address[];
  /** Session key address (delegate) */
  sessionKey: Address;
  /** User's smart account (delegator) */
  delegator: Address;
  /** Chain ID */
  chainId: number;
  /** Creation timestamp (ms) */
  createdAt: number;
  /** Expiry timestamp (ms) */
  expiresAt: number;
  /** Max MON value per transaction (wei as string) */
  valueLtePerTx: string;
  /** Max calls allowed */
  maxCalls: number;
  /** Approximate total budget (wei as string) */
  approximateBudget: string;
}

// ============================================================================
// Constants
// ============================================================================

/** Zero salt for root delegations (deterministic) */
const ZERO_SALT = "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;

/** Seconds per day */
const SECONDS_PER_DAY = 24 * 60 * 60;

/** Root delegation storage file */
const ROOT_DELEGATION_FILENAME = "root-delegation.json";

// ============================================================================
// Storage Helpers
// ============================================================================

/**
 * Get the pragma config directory
 */
function getPragmaDir(): string {
  const pragmaDir = path.join(homedir(), ".pragma");
  if (!existsSync(pragmaDir)) {
    mkdirSync(pragmaDir, { recursive: true });
  }
  return pragmaDir;
}

/**
 * Get root delegation file path
 */
function getRootDelegationPath(): string {
  return path.join(getPragmaDir(), ROOT_DELEGATION_FILENAME);
}

// ============================================================================
// Scope Builders
// ============================================================================

/**
 * Get all trading contract addresses for a chain
 *
 * For LogicalOrWrapperEnforcer Group 1 (TRADING), we whitelist:
 * - Protocol addresses (for trade execution)
 * - ERC20 tokens that protocols need direct access to (USDC, LVUSD, LVMON)
 *
 * Note: approve() on arbitrary tokens is handled by Group 0 (APPROVE)
 * which has no AllowedTargetsEnforcer, allowing any token address.
 */
export function getAllTradingTargets(chainId: number): Address[] {
  const targets: Address[] = [];
  const chainConfig = SUPPORTED_CHAINS[chainId];

  // ============================================================
  // Protocol Addresses (trade execution targets)
  // ============================================================

  // Always include WMON (wrap/unwrap)
  targets.push(WMON_ADDRESS);

  // LeverUp diamond
  targets.push(LEVERUP_DIAMOND);

  // DEX aggregator (chain-specific)
  if (chainConfig?.aggregators?.router) {
    targets.push(chainConfig.aggregators.router);
  }

  // nad.fun router (mainnet only)
  if (chainId === 143) {
    targets.push(NADFUN_CONTRACTS[143].router);
  }

  // ============================================================
  // ERC20 Tokens used as collateral/input for trading
  // These need to be in trading targets for transfer() calls
  // ============================================================

  // USDC - used as collateral for LeverUp, swap input
  targets.push(USDC_ADDRESS);

  // LVUSD - LeverUp vault USD token
  targets.push(LVUSD_ADDRESS);

  // LVMON - LeverUp vault MON token
  targets.push(LVMON_ADDRESS);

  return targets;
}

/**
 * Get all trading function selectors for Group 1 (TRADING)
 *
 * These are the allowed method selectors for trading operations.
 * Note: ERC20 approve() is NOT included here - it's handled by
 * Group 0 (APPROVE) which allows approve() on ANY token address.
 */
export function getAllTradingSelectors(): Hex[] {
  return [
    // LeverUp perps
    ...Object.values(LEVERUP_SELECTORS),
    // nad.fun memecoins
    ...Object.values(NADFUN_SELECTORS),
    // WMON wrap/unwrap
    ...Object.values(WMON_SELECTORS),
    // DEX aggregator (0x Exchange Proxy)
    ...Object.values(DEX_SELECTORS),
  ];
}

// ============================================================================
// Caveat Builders
// ============================================================================

/**
 * Build additional caveats for root delegation (persistent, days expiry)
 *
 * These caveats are ADDED to the delegation after scope-based caveats are removed.
 * We can't skip scope in DTK, so we create with scope then modify the caveats.
 *
 * Caveats include:
 * - LogicalOrWrapperEnforcer: Flexible approve + trading permissions
 * - timestamp: Expiry in days
 * - limitedCalls: Max number of calls
 */
function buildRootCaveats(
  expiryDays: number,
  maxCalls: number
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

  return caveats as Caveats;
}

// ============================================================================
// Root Delegation Creation
// ============================================================================

/**
 * Create a root delegation (unsigned)
 *
 * This delegation grants the session key (Main Agent) permission to:
 * - Execute approve() on ANY ERC20 token (Group 0)
 * - Execute trades on LeverUp, nad.fun, DEX aggregator (Group 1)
 * - Wrap/unwrap MON
 * - Within the specified time and call limits
 *
 * Uses LogicalOrWrapperEnforcer for OR logic between groups:
 * - Group 0 (APPROVE): approve() on any token address
 * - Group 1 (TRADING): Trading calls to whitelisted protocols
 *
 * Implementation note: DTK requires scope, which generates AllowedTargets and
 * AllowedMethods caveats. We create with scope, then replace those caveats
 * with our LogicalOrWrapperEnforcer for flexible permissions.
 *
 * The delegation must be signed with Touch ID before use.
 */
export function createRootDelegation(
  params: Omit<RootDelegationParams, "keyId" | "touchIdMessage">
): RootDelegationResult {
  const {
    delegator,
    sessionKey,
    expiryDays,
    valueLtePerTx,
    maxCalls,
    chainId,
  } = params;

  const environment = getDTKEnvironment();
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + expiryDays * SECONDS_PER_DAY;

  // Get all trading targets for Group 1 (TRADING)
  const allowedTargets = getAllTradingTargets(chainId);

  // Get all trading selectors for Group 1 (TRADING)
  const allowedSelectors = getAllTradingSelectors();

  // Build base caveats (timestamp + limitedCalls)
  const baseCaveats = buildRootCaveats(expiryDays, maxCalls);

  // Build scope with targets/selectors (required by DTK)
  // DTK will generate AllowedTargets and AllowedMethods caveats from this
  const scope = {
    type: "functionCall" as const,
    targets: allowedTargets,
    selectors: allowedSelectors,
  };

  // Create delegation using DTK (generates scope-based caveats)
  const delegation = createDelegation({
    environment,
    scope,
    from: delegator,
    to: sessionKey,
    caveats: baseCaveats,
    salt: ZERO_SALT,
  });

  // CRITICAL: Replace scope-based enforcers with LogicalOrWrapperEnforcer
  // DTK generates AllowedTargets + AllowedMethods from scope, but we need
  // OR logic instead of AND logic for approve() on arbitrary tokens.
  //
  // Filter out:
  // - AllowedTargetsEnforcer (blocks arbitrary token addresses)
  // - AllowedMethodsEnforcer (redundant, LogicalOr handles this)
  // - ValueLteEnforcer (DTK adds with 0 value which can cause issues)
  const scopeEnforcers = [
    ALLOWED_TARGETS_ENFORCER.toLowerCase(),
    ALLOWED_METHODS_ENFORCER.toLowerCase(),
    VALUE_LTE_ENFORCER.toLowerCase(),
  ];

  delegation.caveats = delegation.caveats.filter(
    (caveat) => !scopeEnforcers.includes(caveat.enforcer.toLowerCase())
  );

  // Add LogicalOrWrapperEnforcer caveat at the beginning
  const logicalOrCaveat = buildLogicalOrCaveat(allowedTargets, allowedSelectors);
  delegation.caveats.unshift(logicalOrCaveat);

  // Build typed data for signing (with modified caveats)
  const typedData = buildDelegationTypedData(delegation, chainId);

  return {
    delegation,
    typedData,
    expiresAt,
    approximateBudget: valueLtePerTx * BigInt(maxCalls),
    allowedTargets,
  };
}

/**
 * Create, sign, and store a root delegation
 *
 * This is the main entry point for creating a root delegation.
 * It will prompt for Touch ID and store the signed delegation.
 *
 * @returns The stored root delegation
 */
export async function signAndStoreRootDelegation(
  params: RootDelegationParams
): Promise<StoredRootDelegation> {
  const {
    delegator,
    sessionKey,
    expiryDays,
    valueLtePerTx,
    maxCalls,
    chainId,
    keyId,
    touchIdMessage,
  } = params;

  // Create unsigned delegation
  const result = createRootDelegation({
    delegator,
    sessionKey,
    expiryDays,
    valueLtePerTx,
    maxCalls,
    chainId,
  });

  // Sign with Touch ID
  const signature = await signDelegationWithP256(
    result.delegation,
    chainId,
    keyId,
    touchIdMessage ?? "Enable autonomous trading mode"
  );

  // Create signed delegation
  const signedDelegation: SignedDelegation = {
    ...result.delegation,
    signature,
  };

  // Compute delegation hash using DTK's hash function (struct hash, not EIP-712)
  // DTK expects salt as bigint, our delegation has it as Hex
  const delegationForHash = {
    ...result.delegation,
    salt: BigInt(result.delegation.salt),
  };
  const delegationHash = hashDelegation(delegationForHash);

  // Create stored delegation
  const storedDelegation: StoredRootDelegation = {
    delegationHash,
    delegation: signedDelegation,
    allowedTargets: result.allowedTargets,
    sessionKey,
    delegator,
    chainId,
    createdAt: Date.now(),
    expiresAt: result.expiresAt * 1000, // Convert to milliseconds
    valueLtePerTx: valueLtePerTx.toString(),
    maxCalls,
    approximateBudget: result.approximateBudget.toString(),
  };

  // Store to file
  const filePath = getRootDelegationPath();
  writeFileSync(filePath, JSON.stringify(storedDelegation, null, 2));

  return storedDelegation;
}

// ============================================================================
// Root Delegation Loading & Validation
// ============================================================================

/**
 * Load root delegation from storage
 *
 * @returns The stored root delegation, or null if not found
 */
export function loadRootDelegation(): StoredRootDelegation | null {
  const filePath = getRootDelegationPath();

  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const content = readFileSync(filePath, "utf-8");
    return JSON.parse(content) as StoredRootDelegation;
  } catch {
    return null;
  }
}

/**
 * Check if a valid (non-expired) root delegation exists
 */
export function hasValidRootDelegation(): boolean {
  const delegation = loadRootDelegation();
  return delegation !== null && Date.now() <= delegation.expiresAt;
}

/**
 * Get root delegation status
 */
export function getRootDelegationStatus(): {
  exists: boolean;
  valid: boolean;
  expiresAt?: number;
  expiresIn?: string;
  approximateBudget?: string;
  maxCalls?: number;
  sessionKey?: Address;
  delegator?: Address;
} {
  const delegation = loadRootDelegation();

  if (!delegation) {
    return { exists: false, valid: false };
  }

  const valid = Date.now() < delegation.expiresAt;
  const expiresIn = valid ? formatTimeRemaining(delegation.expiresAt) : "expired";

  return {
    exists: true,
    valid,
    expiresAt: delegation.expiresAt,
    expiresIn,
    approximateBudget: formatEther(BigInt(delegation.approximateBudget)) + " MON",
    maxCalls: delegation.maxCalls,
    sessionKey: delegation.sessionKey,
    delegator: delegation.delegator,
  };
}

// ============================================================================
// Root Delegation Revocation
// ============================================================================

/**
 * Revoke (delete) the stored root delegation
 *
 * Note: This only removes the local storage.
 * On-chain revocation happens automatically when:
 * - The delegation expires (timestamp caveat)
 * - The call limit is reached (limitedCalls caveat)
 */
export function revokeRootDelegation(): void {
  const filePath = getRootDelegationPath();

  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate root delegation parameters
 */
export function validateRootDelegationParams(params: {
  expiryDays: number;
  valueLtePerTx: bigint;
  maxCalls: number;
}): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (params.expiryDays < 1 || params.expiryDays > 30) {
    errors.push("expiryDays must be between 1 and 30");
  }

  if (params.maxCalls < 10 || params.maxCalls > 500) {
    errors.push("maxCalls must be between 10 and 500");
  }

  if (params.valueLtePerTx <= 0n) {
    errors.push("valueLtePerTx must be positive");
  }

  // Check reasonable budget limits (safety)
  const approximateBudget = params.valueLtePerTx * BigInt(params.maxCalls);
  const maxBudget = parseEther("1000"); // 1000 MON max
  if (approximateBudget > maxBudget) {
    errors.push("Approximate budget exceeds 1000 MON safety limit");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

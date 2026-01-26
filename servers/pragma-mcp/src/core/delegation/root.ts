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

import { buildDelegationTypedData, hashDelegation } from "./typedData.js";
import { signDelegationWithP256 } from "../signer/p256SignerConfig.js";
import { getDTKEnvironment } from "../../config/constants.js";
import { SUPPORTED_CHAINS } from "../../config/chains.js";
import { LEVERUP_DIAMOND, WMON_ADDRESS } from "../leverup/constants.js";
import { NADFUN_CONTRACTS } from "../nadfun/constants.js";
import { formatTimeRemaining } from "../utils/index.js";
import type { SignedDelegation } from "./types.js";

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
 * Root delegation scope includes ALL trading contracts
 */
export function getAllTradingTargets(chainId: number): Address[] {
  const targets: Address[] = [];
  const chainConfig = SUPPORTED_CHAINS[chainId];

  // Always include WMON
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

  return targets;
}

// ============================================================================
// Caveat Builders
// ============================================================================

/**
 * Build caveats for root delegation (persistent, days expiry)
 *
 * Caveats include:
 * - timestamp: Expiry in days
 * - limitedCalls: Max number of calls
 *
 * Note: valueLte is added in scope, not caveats, per DTK convention
 */
function buildRootCaveats(
  expiryDays: number,
  maxCalls: number
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

  return caveats as Caveats;
}

// ============================================================================
// Root Delegation Creation
// ============================================================================

/**
 * Create a root delegation (unsigned)
 *
 * This delegation grants the session key (Main Agent) permission to:
 * - Execute trades on LeverUp, nad.fun, DEX aggregator
 * - Wrap/unwrap MON
 * - Within the specified budget and time limits
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

  // Get all trading targets for scope
  const allowedTargets = getAllTradingTargets(chainId);

  // Build scope with valueLte
  // DTK's functionCall scope with valueLte provides per-tx MON cap
  const scope: {
    type: "functionCall";
    targets: Address[];
    selectors: Hex[];
    valueLte?: { maxValue: bigint };
  } = {
    type: "functionCall" as const,
    targets: allowedTargets,
    selectors: [], // Empty = all methods allowed
  };

  // Add valueLte to scope if specified
  if (valueLtePerTx !== undefined && valueLtePerTx > 0n) {
    scope.valueLte = { maxValue: valueLtePerTx };
  }

  // Build caveats (timestamp + limitedCalls)
  const caveats = buildRootCaveats(expiryDays, maxCalls);

  // Create delegation using DTK
  // Root delegations don't pass authority - DTK uses ROOT_AUTHORITY by default
  const delegation = createDelegation({
    environment,
    scope,
    from: delegator,
    to: sessionKey,
    caveats,
    salt: ZERO_SALT,
  });

  // Build typed data for signing
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

  // Compute delegation hash
  const delegationHash = hashDelegation(result.delegation, chainId);

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

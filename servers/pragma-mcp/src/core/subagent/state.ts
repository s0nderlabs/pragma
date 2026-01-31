// Sub-Agent State Management
// File-based state management for autonomous mode sub-agents
// Copyright (c) 2026 s0nderlabs

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
  rmSync,
  renameSync,
} from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type { Address, Hex } from "viem";
import type { SignedDelegation } from "../delegation/types.js";

/**
 * Special address constant for native MON tracking
 * Using zero address as convention for native token
 */
export const NATIVE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

/** USDC address on Monad mainnet (6 decimals) */
export const USDC_ADDRESS = "0xf817257fed379853cDe0fa4F97AB987181B1E5Ea" as Address;

/**
 * Token flow entry tracking both outflows and inflows per token address.
 * All amounts stored as bigint strings for JSON serialization.
 */
export interface TokenFlowEntry {
  out: string; // Total sent out (bigint as string)
  in: string; // Total received (bigint as string)
}

/**
 * Token flow update for a single trade execution.
 * Passed from autonomous functions to the execution engine.
 */
export interface TokenFlowUpdate {
  outflows: Array<{ token: Address; amount: bigint }>;
  inflows: Array<{ token: Address; amount: bigint }>;
}

/**
 * Token decimal metadata for normalization within groups.
 * Key is lowercase token address, value is native decimals.
 */
export const TOKEN_DECIMALS: Record<string, number> = {
  [NATIVE_TOKEN_ADDRESS.toLowerCase()]: 18, // MON
  "0x3bd359c1119da7da1d913d1c4d2b7c461115433a": 18, // WMON
  "0x91b81bfbe3a747230f0529aa28d8b2bc898e6d56": 18, // LVMON
  "0x754704bc059f8c67012fed69bc8a327a5aafb603": 6, // USDC
  "0xfd44b35139ae53fff7d8f2a9869c503d987f00d1": 18, // LVUSD
};

/**
 * Token groups for budget enforcement.
 * Tokens within the same group share a budget (net outflow across the group).
 * Tokens NOT in any group are tracked but have no budget limit.
 *
 * canonicalDecimals: the decimal base used for budget storage and comparison.
 * All token amounts are normalized to this base before summing/comparing.
 *
 * Uses literal addresses to avoid circular deps with leverup module.
 */
export const TOKEN_GROUPS: Record<string, { tokens: Address[]; canonicalDecimals: number }> = {
  MON: {
    tokens: [
      NATIVE_TOKEN_ADDRESS,
      "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A" as Address, // WMON
      "0x91b81bfbe3A747230F0529Aa28d8b2Bc898E6D56" as Address, // LVMON
    ],
    canonicalDecimals: 18,
  },
  USD: {
    tokens: [
      "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" as Address, // USDC
      "0xFD44B35139Ae53FFF7d8F2A9869c503D987f00d1" as Address, // LVUSD
    ],
    canonicalDecimals: 6,
  },
};

/**
 * Sub-agent state stored in ~/.pragma/agents/<id>/state.json
 */
export interface SubAgentState {
  id: string;
  walletId: string;
  walletAddress: Address;
  agentType: "kairos" | "thymos" | "pragma";
  taskId: string; // Claude Code Task ID (for tracking)
  taskAgentId?: string; // Claude Code Task agent ID (for resume after gas top-up)
  status: "pending" | "running" | "paused" | "completed" | "failed" | "revoked";

  // Budget tracking (soft limits - stored as string for JSON serialization)
  budget: {
    // Native MON allocation (from valueLte caveat - on-chain enforced approx)
    monAllocated: string; // bigint as string
    monSpent: string;

    // ERC-20 token spending tracking (off-chain only)
    // Key is lowercase token address, value is amount spent as string
    // Native MON can also be tracked here using NATIVE_TOKEN_ADDRESS
    tokenSpent: Record<string, string>;

    // Optional per-token soft limits (user-defined)
    // Key is lowercase token address, value is max amount as string
    tokenLimits?: Record<string, string>;

    // Ledger-based token flow tracking (in + out per token address)
    // Key is lowercase token address, value is cumulative in/out
    tokenFlows?: Record<string, TokenFlowEntry>;

    // Group-level budget limits (e.g. { USD: "10000000" })
    // Budget is enforced on net outflow across all tokens in the group
    groupBudgets?: Record<string, string>;

    // @deprecated - kept for backwards compatibility, use tokenSpent instead
    usdcAllocated?: string;
    usdcSpent?: string;
  };

  // Trade tracking
  trades: {
    executed: number;
    maxAllowed: number; // From limitedCalls caveat
  };

  // Timestamps
  createdAt: number;
  lastActivityAt: number;
  expiresAt: number; // From delegation timestamp caveat

  // Error tracking
  errors: Array<{
    timestamp: number;
    message: string;
    recoverable: boolean;
  }>;
}

/**
 * Trade record stored in ~/.pragma/agents/<id>/trades.jsonl
 */
export interface TradeRecord {
  timestamp: number;
  action: "buy" | "sell" | "open" | "close" | "add_margin" | "other";
  protocol: "nadfun" | "leverup" | "dex" | "other";
  details: {
    token?: string; // Token symbol for display
    tokenInAddress?: Address; // Input token address (for budget tracking)
    tokenOutAddress?: Address; // Output token address (for budget tracking)
    pair?: string;
    amountIn?: string; // Input amount as string (for budget tracking)
    amountOut?: string;
    positionId?: string;
    // Extended fields for detailed trade logging
    [key: string]: string | Address | undefined;
  };
  txHash: Hex;
  success: boolean;
  error?: string;
}

/**
 * Signed delegation stored in ~/.pragma/agents/<id>/delegation.json
 * Includes root delegation reference for delegation chain assembly
 */
export interface StoredDelegation {
  delegationHash: Hex;
  signedDelegation: SignedDelegation; // Full signed delegation object (Main Agent → Sub-Agent)
  parentDelegationHash?: Hex; // Hash of root delegation
  rootDelegation?: SignedDelegation; // Full signed root delegation (User → Main Agent) for chain assembly
  createdAt: number;
  expiresAt: number;
}

/**
 * Parameters for creating a new agent state
 */
export interface CreateAgentStateParams {
  id: string;
  walletId: string;
  walletAddress: Address;
  agentType: "kairos" | "thymos" | "pragma";
  taskId: string;
  budget: {
    monAllocated: bigint;
    // Optional per-token soft limits (off-chain enforced)
    // Key is lowercase token address, value is max amount
    tokenLimits?: Record<string, bigint>;
    // Optional group-level budgets (e.g. { USD: 10000000n } for 10 USDC)
    // Budget is enforced on net outflow across all tokens in the group
    groupBudgets?: Record<string, bigint>;
  };
  maxTrades: number;
  expiresAt: number;
}

/**
 * Get the agents directory path
 */
function getAgentsDir(): string {
  const pragmaDir = path.join(homedir(), ".pragma");
  const agentsDir = path.join(pragmaDir, "agents");
  if (!existsSync(agentsDir)) {
    mkdirSync(agentsDir, { recursive: true });
  }
  return agentsDir;
}

/**
 * Get the directory path for a specific agent
 */
function getAgentDir(agentId: string): string {
  return path.join(getAgentsDir(), agentId);
}

/**
 * Create a new agent state
 */
export async function createAgentState(params: CreateAgentStateParams): Promise<void> {
  const agentDir = getAgentDir(params.id);

  if (existsSync(agentDir)) {
    throw new Error(`Agent directory already exists: ${params.id}`);
  }

  mkdirSync(agentDir, { recursive: true });

  const now = Date.now();

  // Convert token limits from bigint to string
  const tokenLimits: Record<string, string> | undefined = params.budget.tokenLimits
    ? Object.fromEntries(
        Object.entries(params.budget.tokenLimits).map(([addr, amount]) => [
          addr.toLowerCase(),
          amount.toString(),
        ])
      )
    : undefined;

  const state: SubAgentState = {
    id: params.id,
    walletId: params.walletId,
    walletAddress: params.walletAddress,
    agentType: params.agentType,
    taskId: params.taskId,
    status: "pending",
    budget: {
      monAllocated: params.budget.monAllocated.toString(),
      monSpent: "0",
      tokenSpent: {}, // Start with no spending
      tokenLimits,
      tokenFlows: {}, // Ledger: start with no flows
      groupBudgets: params.budget.groupBudgets
        ? Object.fromEntries(
            Object.entries(params.budget.groupBudgets).map(([k, v]) => [k, v.toString()])
          )
        : undefined,
    },
    trades: {
      executed: 0,
      maxAllowed: params.maxTrades,
    },
    createdAt: now,
    lastActivityAt: now,
    expiresAt: params.expiresAt,
    errors: [],
  };

  const statePath = path.join(agentDir, "state.json");
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

/**
 * Load agent state from disk
 * Handles migration from old format (usdcAllocated/usdcSpent) to new format (tokenSpent)
 * Performs lazy expiry check - auto-updates status to "failed" if delegation has expired
 */
export async function loadAgentState(agentId: string): Promise<SubAgentState | null> {
  const statePath = path.join(getAgentDir(agentId), "state.json");

  if (!existsSync(statePath)) {
    return null;
  }

  try {
    const content = readFileSync(statePath, "utf-8");
    const state = JSON.parse(content) as SubAgentState;

    // Migrate old format to new format if needed
    if (!state.budget.tokenSpent) {
      state.budget.tokenSpent = {};

      // Migrate legacy USDC tracking if present
      if (state.budget.usdcSpent && state.budget.usdcSpent !== "0") {
        state.budget.tokenSpent[USDC_ADDRESS.toLowerCase()] = state.budget.usdcSpent;
      }
    }

    // Migrate old agents without tokenFlows: construct from tokenSpent
    if (!state.budget.tokenFlows && state.budget.tokenSpent) {
      state.budget.tokenFlows = {};
      for (const [addr, spentStr] of Object.entries(state.budget.tokenSpent)) {
        state.budget.tokenFlows[addr] = { out: spentStr, in: "0" };
      }
    }

    // Lazy expiry check: if delegation expired and status is still active, mark as failed
    const isExpired = Date.now() > state.expiresAt;
    const isActiveStatus = state.status === "pending" || state.status === "running" || state.status === "paused";

    if (isExpired && isActiveStatus) {
      state.status = "failed";
      state.lastActivityAt = Date.now();
      // Write updated state back to disk
      writeFileSync(statePath, JSON.stringify(state, null, 2));
    }

    return state;
  } catch {
    return null;
  }
}

/**
 * Update agent state
 */
export async function updateAgentState(
  agentId: string,
  updates: Partial<SubAgentState>
): Promise<void> {
  const state = await loadAgentState(agentId);
  if (!state) {
    throw new Error(`Agent state not found: ${agentId}`);
  }

  // Merge updates (shallow for top-level, deep for known nested objects)
  const updatedState: SubAgentState = {
    ...state,
    ...updates,
    budget: updates.budget
      ? {
          ...state.budget,
          ...updates.budget,
          // Deep merge tokenSpent
          tokenSpent: {
            ...state.budget.tokenSpent,
            ...(updates.budget.tokenSpent || {}),
          },
          // Deep merge tokenLimits
          tokenLimits: updates.budget.tokenLimits
            ? {
                ...state.budget.tokenLimits,
                ...updates.budget.tokenLimits,
              }
            : state.budget.tokenLimits,
          // Deep merge tokenFlows
          tokenFlows: updates.budget.tokenFlows
            ? {
                ...state.budget.tokenFlows,
                ...updates.budget.tokenFlows,
              }
            : state.budget.tokenFlows,
          // Deep merge groupBudgets
          groupBudgets: updates.budget.groupBudgets
            ? {
                ...state.budget.groupBudgets,
                ...updates.budget.groupBudgets,
              }
            : state.budget.groupBudgets,
        }
      : state.budget,
    trades: updates.trades ? { ...state.trades, ...updates.trades } : state.trades,
    lastActivityAt: Date.now(),
  };

  const statePath = path.join(getAgentDir(agentId), "state.json");
  writeFileSync(statePath, JSON.stringify(updatedState, null, 2));
}

/**
 * Append a trade record to the agent's trade log
 */
export async function appendTrade(agentId: string, trade: TradeRecord): Promise<void> {
  const agentDir = getAgentDir(agentId);
  const tradesPath = path.join(agentDir, "trades.jsonl");

  // Append as JSONL (one JSON object per line)
  appendFileSync(tradesPath, JSON.stringify(trade) + "\n");

  // Update trade count in state directly to avoid double file read
  const statePath = path.join(agentDir, "state.json");
  if (existsSync(statePath)) {
    const state = JSON.parse(readFileSync(statePath, "utf-8")) as SubAgentState;
    state.trades.executed += 1;
    state.lastActivityAt = Date.now();
    writeFileSync(statePath, JSON.stringify(state, null, 2));
  }
}

/**
 * Load all trades for an agent
 */
export async function loadTrades(agentId: string): Promise<TradeRecord[]> {
  const tradesPath = path.join(getAgentDir(agentId), "trades.jsonl");

  if (!existsSync(tradesPath)) {
    return [];
  }

  try {
    const content = readFileSync(tradesPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    return lines.map((line) => JSON.parse(line) as TradeRecord);
  } catch {
    return [];
  }
}

/**
 * Store signed delegation for an agent
 */
export async function storeDelegation(
  agentId: string,
  delegation: StoredDelegation
): Promise<void> {
  const delegationPath = path.join(getAgentDir(agentId), "delegation.json");
  writeFileSync(delegationPath, JSON.stringify(delegation, null, 2));
}

/**
 * Load stored delegation for an agent
 */
export async function loadDelegation(agentId: string): Promise<StoredDelegation | null> {
  const delegationPath = path.join(getAgentDir(agentId), "delegation.json");

  if (!existsSync(delegationPath)) {
    return null;
  }

  try {
    const content = readFileSync(delegationPath, "utf-8");
    return JSON.parse(content) as StoredDelegation;
  } catch {
    return null;
  }
}

/**
 * Add an error to the agent's error log
 */
export async function addError(
  agentId: string,
  message: string,
  recoverable: boolean
): Promise<void> {
  const state = await loadAgentState(agentId);
  if (!state) {
    throw new Error(`Agent state not found: ${agentId}`);
  }

  state.errors.push({
    timestamp: Date.now(),
    message,
    recoverable,
  });

  // Keep only last 100 errors
  if (state.errors.length > 100) {
    state.errors = state.errors.slice(-100);
  }

  const statePath = path.join(getAgentDir(agentId), "state.json");
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

/**
 * Update budget spent for a specific token
 * Use NATIVE_TOKEN_ADDRESS for native MON
 *
 * @param agentId - Agent ID
 * @param tokenAddress - Token contract address (use NATIVE_TOKEN_ADDRESS for MON)
 * @param amountSpent - Amount spent in token's smallest unit
 */
export async function updateTokenSpent(
  agentId: string,
  tokenAddress: Address,
  amountSpent: bigint
): Promise<void> {
  const state = await loadAgentState(agentId);
  if (!state) {
    throw new Error(`Agent state not found: ${agentId}`);
  }

  const normalizedAddress = tokenAddress.toLowerCase();
  const currentSpent = BigInt(state.budget.tokenSpent[normalizedAddress] || "0");
  const newSpent = (currentSpent + amountSpent).toString();

  // Also update monSpent if this is native token (for backwards compat + on-chain tracking)
  const isNative = normalizedAddress === NATIVE_TOKEN_ADDRESS.toLowerCase();

  await updateAgentState(agentId, {
    budget: {
      ...state.budget,
      monSpent: isNative
        ? (BigInt(state.budget.monSpent) + amountSpent).toString()
        : state.budget.monSpent,
      tokenSpent: {
        ...state.budget.tokenSpent,
        [normalizedAddress]: newSpent,
      },
    },
  });
}

/**
 * Update budget spent amounts (legacy function for backwards compatibility)
 * @deprecated Use updateTokenSpent instead
 */
export async function updateBudgetSpent(
  agentId: string,
  monSpent: bigint,
  usdcSpent: bigint
): Promise<void> {
  // For native MON
  if (monSpent > 0n) {
    await updateTokenSpent(agentId, NATIVE_TOKEN_ADDRESS, monSpent);
  }

  // For USDC
  if (usdcSpent > 0n) {
    await updateTokenSpent(agentId, USDC_ADDRESS, usdcSpent);
  }
}

/**
 * Get remaining budget for a specific token
 * Returns null if no limit is set for that token (unlimited)
 *
 * @param agentId - Agent ID
 * @param tokenAddress - Token contract address (use NATIVE_TOKEN_ADDRESS for MON)
 */
export async function getTokenBudgetRemaining(
  agentId: string,
  tokenAddress: Address
): Promise<{ limit: bigint | null; spent: bigint; remaining: bigint | null } | null> {
  const state = await loadAgentState(agentId);
  if (!state) {
    return null;
  }

  const normalizedAddress = tokenAddress.toLowerCase();
  const spent = BigInt(state.budget.tokenSpent[normalizedAddress] || "0");

  // Check if there's a limit for this token
  const limitStr = state.budget.tokenLimits?.[normalizedAddress];
  const limit = limitStr ? BigInt(limitStr) : null;

  // For native MON, also consider monAllocated as the limit
  const isNative = normalizedAddress === NATIVE_TOKEN_ADDRESS.toLowerCase();
  const effectiveLimit = isNative ? BigInt(state.budget.monAllocated) : limit;

  return {
    limit: effectiveLimit,
    spent,
    remaining: effectiveLimit !== null ? effectiveLimit - spent : null,
  };
}

/**
 * Get all token spending for an agent
 */
export async function getAllTokenSpending(
  agentId: string
): Promise<Record<string, { spent: bigint; limit: bigint | null }> | null> {
  const state = await loadAgentState(agentId);
  if (!state) {
    return null;
  }

  const result: Record<string, { spent: bigint; limit: bigint | null }> = {};
  const nativeAddr = NATIVE_TOKEN_ADDRESS.toLowerCase();

  // Add all tokens that have spending
  for (const [addr, spentStr] of Object.entries(state.budget.tokenSpent)) {
    const limitStr = state.budget.tokenLimits?.[addr];
    result[addr] = {
      spent: BigInt(spentStr),
      limit: limitStr ? BigInt(limitStr) : null,
    };
  }

  // Always ensure native MON is present with its allocation as limit
  const existingNative = result[nativeAddr];
  result[nativeAddr] = {
    spent: existingNative?.spent ?? BigInt(state.budget.monSpent),
    limit: BigInt(state.budget.monAllocated),
  };

  return result;
}

/**
 * Get budget remaining for an agent (legacy function for backwards compatibility)
 * @deprecated Use getTokenBudgetRemaining for specific tokens
 */
export async function getBudgetRemaining(
  agentId: string
): Promise<{ mon: bigint; usdc: bigint } | null> {
  const state = await loadAgentState(agentId);
  if (!state) {
    return null;
  }

  const monAllocated = BigInt(state.budget.monAllocated);
  const monSpent = BigInt(state.budget.monSpent);

  // Get USDC from tokenSpent or legacy field
  const usdcAddressLower = USDC_ADDRESS.toLowerCase();
  const usdcSpent = BigInt(
    state.budget.tokenSpent[usdcAddressLower] || state.budget.usdcSpent || "0"
  );
  const usdcAllocated = BigInt(
    state.budget.tokenLimits?.[usdcAddressLower] || state.budget.usdcAllocated || "0"
  );

  return {
    mon: monAllocated - monSpent,
    usdc: usdcAllocated - usdcSpent,
  };
}

/**
 * List all agent states
 */
export async function listAgentStates(): Promise<SubAgentState[]> {
  const agentsDir = getAgentsDir();

  if (!existsSync(agentsDir)) {
    return [];
  }

  const entries = readdirSync(agentsDir, { withFileTypes: true });
  const states: SubAgentState[] = [];

  for (const entry of entries) {
    if (entry.isDirectory() && entry.name !== "archive") {
      const state = await loadAgentState(entry.name);
      if (state) {
        states.push(state);
      }
    }
  }

  return states;
}

/**
 * Archive agent state directory.
 * Moves ~/.pragma/agents/<id>/ to ~/.pragma/agents/archive/<id>/
 * so trade history and lifecycle data are preserved for review.
 *
 * Named `deleteAgentState` for backwards compatibility with callers.
 */
export async function deleteAgentState(agentId: string): Promise<void> {
  const agentDir = getAgentDir(agentId);

  if (!existsSync(agentDir)) return;

  const archiveDir = path.join(getAgentsDir(), "archive");
  if (!existsSync(archiveDir)) {
    mkdirSync(archiveDir, { recursive: true });
  }

  const archiveDest = path.join(archiveDir, agentId);

  // If archive already exists for this ID (re-revoke), remove old archive first
  if (existsSync(archiveDest)) {
    rmSync(archiveDest, { recursive: true, force: true });
  }

  try {
    renameSync(agentDir, archiveDest);
  } catch {
    // If rename fails (cross-device etc), fall back to delete
    rmSync(agentDir, { recursive: true, force: true });
  }
}

/**
 * Check if agent exists
 */
export function agentExists(agentId: string): boolean {
  const statePath = path.join(getAgentDir(agentId), "state.json");
  return existsSync(statePath);
}

// ============================================================================
// Ledger-based Token Flow Tracking
// ============================================================================

/**
 * Update token flows for a trade execution (ledger recording).
 * Records both outflows (tokens sent) and inflows (tokens received).
 * Also updates legacy tokenSpent and monSpent for backwards compatibility.
 */
export async function updateTokenFlows(
  agentId: string,
  flows: TokenFlowUpdate
): Promise<void> {
  const state = await loadAgentState(agentId);
  if (!state) {
    throw new Error(`Agent state not found: ${agentId}`);
  }

  const tokenFlows = state.budget.tokenFlows ? { ...state.budget.tokenFlows } : {};
  let monSpentDelta = 0n;

  // Record outflows
  for (const { token, amount } of flows.outflows) {
    const addr = token.toLowerCase();
    const existing = tokenFlows[addr] || { out: "0", in: "0" };
    tokenFlows[addr] = {
      out: (BigInt(existing.out) + amount).toString(),
      in: existing.in,
    };

    // Legacy: also update tokenSpent (outflows only)
    const currentSpent = BigInt(state.budget.tokenSpent[addr] || "0");
    state.budget.tokenSpent[addr] = (currentSpent + amount).toString();

    // Track MON delta for monSpent backwards compat
    if (addr === NATIVE_TOKEN_ADDRESS.toLowerCase()) {
      monSpentDelta += amount;
    }
  }

  // Record inflows
  for (const { token, amount } of flows.inflows) {
    const addr = token.toLowerCase();
    const existing = tokenFlows[addr] || { out: "0", in: "0" };
    tokenFlows[addr] = {
      out: existing.out,
      in: (BigInt(existing.in) + amount).toString(),
    };
  }

  // Single state update
  await updateAgentState(agentId, {
    budget: {
      ...state.budget,
      monSpent: (BigInt(state.budget.monSpent) + monSpentDelta).toString(),
      tokenSpent: state.budget.tokenSpent,
      tokenFlows,
    },
  });
}

/**
 * Normalize a token amount to a group's canonical decimal base.
 * E.g., 4.5 LVUSD (18 dec) → 4,500,000 (6 dec canonical for USD group).
 *
 * If token decimals are unknown, assumes canonical (no scaling).
 */
export function normalizeToCanonical(
  amount: bigint,
  tokenAddress: string,
  canonicalDecimals: number
): bigint {
  const tokenDecimals = TOKEN_DECIMALS[tokenAddress.toLowerCase()];
  if (tokenDecimals === undefined || tokenDecimals === canonicalDecimals) {
    return amount; // Unknown or same decimals — no scaling
  }
  if (tokenDecimals > canonicalDecimals) {
    // Scale down: e.g., 18 dec → 6 dec = divide by 10^12
    return amount / 10n ** BigInt(tokenDecimals - canonicalDecimals);
  }
  // Scale up: e.g., 6 dec → 18 dec = multiply by 10^12
  return amount * 10n ** BigInt(canonicalDecimals - tokenDecimals);
}

/**
 * Get net outflow for a token group, normalized to canonical decimals.
 * Returns sum(out - in) across all tokens in the group.
 * Positive = net cost, negative = net profit.
 * All amounts are normalized to the group's canonical decimal base.
 */
export function getGroupNetOutflow(
  state: SubAgentState,
  groupName: string
): bigint {
  const group = TOKEN_GROUPS[groupName];
  if (!group) return 0n;

  const { tokens: groupTokens, canonicalDecimals } = group;

  const flows = state.budget.tokenFlows;
  if (!flows) {
    // Fallback to tokenSpent (outflow-only, no inflow data)
    let total = 0n;
    for (const token of groupTokens) {
      const addr = token.toLowerCase();
      const raw = BigInt(state.budget.tokenSpent[addr] || "0");
      total += normalizeToCanonical(raw, addr, canonicalDecimals);
    }
    return total;
  }

  let netOutflow = 0n;
  for (const token of groupTokens) {
    const addr = token.toLowerCase();
    const entry = flows[addr];
    if (entry) {
      const rawOut = BigInt(entry.out);
      const rawIn = BigInt(entry.in);
      const normalizedOut = normalizeToCanonical(rawOut, addr, canonicalDecimals);
      const normalizedIn = normalizeToCanonical(rawIn, addr, canonicalDecimals);
      netOutflow += normalizedOut - normalizedIn;
    }
  }

  return netOutflow;
}

/**
 * Pre-trade budget validation using token groups.
 * Checks if spending `amount` of `tokenAddress` would exceed the group budget.
 *
 * Returns { allowed: true } if within budget, or { allowed: false, reason } if not.
 * Tokens not in any group are always allowed (no budget limit).
 */
export function checkGroupBudget(
  state: SubAgentState,
  tokenAddress: Address,
  amount: bigint
): { allowed: boolean; reason?: string } {
  const normalizedAddr = tokenAddress.toLowerCase();

  // Find which group this token belongs to
  let groupName: string | null = null;
  for (const [name, group] of Object.entries(TOKEN_GROUPS)) {
    if (group.tokens.some((t) => t.toLowerCase() === normalizedAddr)) {
      groupName = name;
      break;
    }
  }

  // Token not in any group → always allowed
  if (!groupName) {
    return { allowed: true };
  }

  const { canonicalDecimals } = TOKEN_GROUPS[groupName];

  // Get group budget (already in canonical decimals)
  let budget: bigint | null = null;

  if (state.budget.groupBudgets?.[groupName]) {
    budget = BigInt(state.budget.groupBudgets[groupName]);
  } else if (groupName === "MON") {
    // Fallback: MON group uses monAllocated (18 dec = canonical)
    budget = BigInt(state.budget.monAllocated);
  } else if (groupName === "USD") {
    // Fallback: USD group uses tokenLimits for USDC if set (6 dec = canonical)
    const usdcAddr = TOKEN_GROUPS.USD.tokens[0].toLowerCase(); // USDC is first in group
    const usdcLimit = state.budget.tokenLimits?.[usdcAddr];
    if (usdcLimit) {
      budget = BigInt(usdcLimit);
    }
  }

  // No budget set for this group → allowed
  if (budget === null) {
    return { allowed: true };
  }

  // Normalize the incoming amount to canonical decimals
  const normalizedAmount = normalizeToCanonical(amount, normalizedAddr, canonicalDecimals);

  // Check: currentNetOutflow + normalizedAmount <= budget
  // getGroupNetOutflow already returns normalized values
  const currentNet = getGroupNetOutflow(state, groupName);
  const projectedNet = currentNet + normalizedAmount;

  if (projectedNet > budget) {
    return {
      allowed: false,
      reason: `${groupName} group budget exceeded: net outflow would be ${projectedNet} (budget: ${budget}) [canonical ${canonicalDecimals} decimals]`,
    };
  }

  return { allowed: true };
}

/**
 * Get all token flows for display.
 * Returns per-token { out, in, net } and the group each token belongs to.
 */
export async function getAllTokenFlows(
  agentId: string
): Promise<
  Record<
    string,
    { out: bigint; in: bigint; net: bigint; group: string | null }
  > | null
> {
  const state = await loadAgentState(agentId);
  if (!state) return null;

  const flows = state.budget.tokenFlows;
  if (!flows) return null;

  const result: Record<
    string,
    { out: bigint; in: bigint; net: bigint; group: string | null }
  > = {};

  for (const [addr, entry] of Object.entries(flows)) {
    const outVal = BigInt(entry.out);
    const inVal = BigInt(entry.in);

    // Find group for this token
    let group: string | null = null;
    for (const [name, groupDef] of Object.entries(TOKEN_GROUPS)) {
      if (groupDef.tokens.some((t) => t.toLowerCase() === addr.toLowerCase())) {
        group = name;
        break;
      }
    }

    result[addr] = {
      out: outVal,
      in: inVal,
      net: inVal - outVal, // positive = net gain, negative = net cost
      group,
    };
  }

  return result;
}

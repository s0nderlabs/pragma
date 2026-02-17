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
 * Tracked LeverUp position for budget reconciliation.
 * Stored in ~/.pragma/agents/<id>/tracked-positions.json
 *
 * When a position is opened, it's added here. When leverup_list_positions
 * is called with agentId, positions missing from the API response are detected
 * as keeper-triggered closes (TP/SL/liquidation) and their inflows are reconciled.
 */
export interface TrackedPosition {
  tradeHash?: string; // null until reconciled from getUserPositions
  pair: string;
  side: "LONG" | "SHORT";
  margin: string; // bigint as string (raw token amount)
  collateralToken: string; // token address
  leverage: number;
  entryPrice: string;
  stopLoss: string;
  takeProfit: string;
  openedAt: number;
  status: "open" | "pending_fill" | "pending_settlement";
  detectedGoneAt?: number; // block number when first detected missing
}

/**
 * Journal entry for agent activity logging.
 * Stored in ~/.pragma/agents/<id>/journal.jsonl
 *
 * Two sources: auto-generated on trade events (code) and
 * agent-initiated via report_agent_status reason field.
 */
export interface JournalEntry {
  ts: number;
  type:
    | "trade_open"
    | "trade_close"
    | "trade_buy"
    | "trade_sell"
    | "swap"
    | "reasoning"
    | "status"
    | "error"
    | "limit_order"
    | "cancel_order"
    | "memo";
  pair?: string;
  side?: string;
  margin?: string;
  leverage?: string;
  pnl?: string;
  text?: string;
  txHash?: string;
  tradeHash?: string;
  protocol?: string;
  tag?: string;
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
 * Known token symbols for allowedTokens resolution.
 * Maps symbol (uppercase) → Address for all core trading tokens.
 * Used to validate and resolve user-friendly symbols to addresses.
 * Includes LVUSD/LVMON which are NOT in the verified-tokens registry.
 */
export const KNOWN_TOKEN_SYMBOLS: Record<string, Address> = {
  MON: NATIVE_TOKEN_ADDRESS,
  WMON: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A" as Address,
  LVMON: "0x91b81bfbe3A747230F0529Aa28d8b2Bc898E6D56" as Address,
  USDC: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" as Address,
  LVUSD: "0xFD44B35139Ae53FFF7d8F2A9869c503D987f00d1" as Address,
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
  teammateName?: string; // Teammate name for leader wake lookup (e.g., "kairos-abc123")
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

    // Token group allowlist (e.g. ["MON", "USD"])
    // Restricts which token groups the agent can spend from user's holdings
    // Tokens acquired during trading (prior inflows) are always sellable
    // Omit or empty array for unrestricted access (backward compatible)
    allowedGroups?: string[];

    // Per-token allowlist (resolved addresses, e.g. ["0xFD44...", "0x91b8..."])
    // More specific than allowedGroups — when set, takes priority
    // Tokens acquired during trading (prior inflows) are always sellable
    allowedTokens?: string[];

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
    // Optional token group allowlist (e.g. ["MON", "USD"])
    // Restricts which token groups the agent can spend
    allowedGroups?: string[];
    // Optional per-token allowlist (resolved addresses)
    // More specific than allowedGroups — when set, takes priority
    allowedTokens?: Address[];
  };
  maxCalls: number;
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
 * Validate agentId format (UUID only) to prevent path traversal
 */
const AGENT_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/**
 * Get the directory path for a specific agent
 * @throws if agentId contains path traversal or invalid characters
 */
function getAgentDir(agentId: string): string {
  if (!AGENT_ID_PATTERN.test(agentId)) {
    throw new Error(`Invalid agent ID format: must be a UUID`);
  }
  const agentsDir = getAgentsDir();
  const resolved = path.resolve(agentsDir, agentId);
  if (!resolved.startsWith(agentsDir)) {
    throw new Error(`Invalid agent ID: path traversal detected`);
  }
  return resolved;
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
      allowedGroups: params.budget.allowedGroups,
      allowedTokens: params.budget.allowedTokens,
    },
    trades: {
      executed: 0,
      maxAllowed: params.maxCalls,
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
 * Sum monAllocated across all active (running/pending/paused) agent states.
 * Used to validate sub-agent creation against root delegation budget.
 */
export async function sumActiveMonAllocations(): Promise<bigint> {
  const states = await listAgentStates();
  let total = 0n;
  for (const state of states) {
    if (state.status === "running" || state.status === "pending" || state.status === "paused") {
      total += BigInt(state.budget.monAllocated);
    }
  }
  return total;
}

/**
 * Sum USD group budgets across all active (running/pending/paused) agent states.
 * Used to validate sub-agent creation against root delegation budget.
 */
export async function sumActiveUsdAllocations(): Promise<bigint> {
  const states = await listAgentStates();
  let total = 0n;
  for (const state of states) {
    if (state.status === "running" || state.status === "pending" || state.status === "paused") {
      if (state.budget.groupBudgets?.USD) {
        total += BigInt(state.budget.groupBudgets.USD);
      }
    }
  }
  return total;
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
 * Find which token group a token address belongs to.
 * Returns the group name (e.g. "MON", "USD") or null if not in any group.
 */
export function findGroupForToken(tokenAddress: Address): string | null {
  const normalized = tokenAddress.toLowerCase();
  for (const [name, group] of Object.entries(TOKEN_GROUPS)) {
    if (group.tokens.some((t) => t.toLowerCase() === normalized)) return name;
  }
  return null;
}

/**
 * Resolve a token address to its known symbol, if any.
 * Returns the symbol (e.g. "USDC") or null if not found in KNOWN_TOKEN_SYMBOLS.
 */
function resolveSymbol(address: string): string | null {
  const lower = address.toLowerCase();
  for (const [symbol, addr] of Object.entries(KNOWN_TOKEN_SYMBOLS)) {
    if (addr.toLowerCase() === lower) return symbol;
  }
  return null;
}

/**
 * Format token addresses for display, resolving known symbols where possible.
 * e.g. ["0xFD44..."] → "LVUSD (0xFD44...)"
 */
function formatTokenList(addresses: string[]): string {
  return addresses
    .map((addr) => {
      const symbol = resolveSymbol(addr);
      return symbol ? `${symbol} (${addr})` : addr;
    })
    .join(", ");
}

/**
 * Check if a token is allowed by the agent's token restrictions.
 *
 * Priority: allowedTokens (per-token) > allowedGroups (per-group) > unrestricted
 *
 * Rules:
 * 1. No allowedTokens AND no allowedGroups → unrestricted (backward compatible)
 * 2. Native MON with MON budget → always allowed (oracle fees, gas)
 * 3. Token has prior inflows (agent acquired it during trading) → always sellable
 * 4. If allowedTokens set → check token against per-token list
 * 5. If allowedGroups set → check token against group list
 * 6. Otherwise → blocked
 */
export function isTokenAllowed(
  state: SubAgentState,
  tokenAddress: Address
): { allowed: boolean; reason?: string } {
  const hasAllowedTokens = state.budget.allowedTokens && state.budget.allowedTokens.length > 0;
  const hasAllowedGroups = state.budget.allowedGroups && state.budget.allowedGroups.length > 0;

  if (!hasAllowedTokens && !hasAllowedGroups) {
    return { allowed: true };
  }

  const normalized = tokenAddress.toLowerCase();

  // Native MON is always allowed when agent has MON budget (for oracle fees, gas)
  if (normalized === NATIVE_TOKEN_ADDRESS.toLowerCase() && BigInt(state.budget.monAllocated) > 0n) {
    return { allowed: true };
  }

  // Self-acquired tokens (prior inflows) are always sellable regardless of restrictions
  const flows = state.budget.tokenFlows?.[normalized];
  if (flows && BigInt(flows.in) > 0n) {
    return { allowed: true };
  }

  // Per-token allowlist takes priority over group allowlist
  if (hasAllowedTokens) {
    if (state.budget.allowedTokens!.some((a) => a.toLowerCase() === normalized)) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: `Token ${tokenAddress} not in allowedTokens [${formatTokenList(state.budget.allowedTokens!)}] and has no prior inflows`,
    };
  }

  // Fall back to group allowlist
  const groupName = findGroupForToken(tokenAddress);
  if (groupName && state.budget.allowedGroups!.includes(groupName)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `Token not in allowed groups [${state.budget.allowedGroups!.join(", ")}] and has no prior inflows`,
  };
}

/**
 * Resolve the budget for a token group.
 * Returns the budget in canonical decimals, or null if no budget is set.
 */
function resolveGroupBudget(state: SubAgentState, groupName: string): bigint | null {
  // Explicit group budget takes priority
  if (state.budget.groupBudgets?.[groupName]) {
    return BigInt(state.budget.groupBudgets[groupName]);
  }

  // Fallback: MON group uses monAllocated (18 dec = canonical)
  if (groupName === "MON") {
    return BigInt(state.budget.monAllocated);
  }

  // Fallback: USD group uses tokenLimits for USDC if set (6 dec = canonical)
  if (groupName === "USD") {
    const usdcAddr = TOKEN_GROUPS.USD.tokens[0].toLowerCase();
    const usdcLimit = state.budget.tokenLimits?.[usdcAddr];
    if (usdcLimit) return BigInt(usdcLimit);
  }

  return null;
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
  const groupName = findGroupForToken(tokenAddress);

  // Token not in any group → always allowed
  if (!groupName) {
    return { allowed: true };
  }

  const { canonicalDecimals } = TOKEN_GROUPS[groupName];

  // Resolve group budget (already in canonical decimals)
  const budget = resolveGroupBudget(state, groupName);
  if (budget === null) return { allowed: true };

  // Normalize the incoming amount to canonical decimals
  const normalizedAmount = normalizeToCanonical(amount, tokenAddress, canonicalDecimals);

  // Static max drawdown model:
  // - Only count losses (positive net outflow) as budget consumed
  // - Profits (negative net outflow) don't increase budget beyond original
  // - Budget = max the agent can lose from initial allocation
  const currentNet = getGroupNetOutflow(state, groupName);
  const budgetConsumed = currentNet > 0n ? currentNet : 0n;
  const remaining = budget - budgetConsumed;

  if (normalizedAmount > remaining) {
    return {
      allowed: false,
      reason: `${groupName} group budget exceeded: need ${normalizedAmount} but only ${remaining} remaining (consumed: ${budgetConsumed}, budget: ${budget}) [canonical ${canonicalDecimals} decimals]`,
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

    result[addr] = {
      out: outVal,
      in: inVal,
      net: inVal - outVal, // positive = net gain, negative = net cost
      group: findGroupForToken(addr as Address),
    };
  }

  return result;
}

// ============================================================================
// Tracked Position Management
// ============================================================================

function getTrackedPositionsPath(agentId: string): string {
  return path.join(getAgentDir(agentId), "tracked-positions.json");
}

/**
 * Load tracked positions for an agent.
 * Returns empty array if file doesn't exist.
 */
export function getTrackedPositions(agentId: string): TrackedPosition[] {
  const filePath = getTrackedPositionsPath(agentId);
  if (!existsSync(filePath)) return [];
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as TrackedPosition[];
  } catch {
    return [];
  }
}

/**
 * Save tracked positions (full overwrite).
 */
export function saveTrackedPositions(agentId: string, positions: TrackedPosition[]): void {
  const filePath = getTrackedPositionsPath(agentId);
  const agentDir = getAgentDir(agentId);
  if (!existsSync(agentDir)) {
    mkdirSync(agentDir, { recursive: true });
  }
  writeFileSync(filePath, JSON.stringify(positions, null, 2));
}

/**
 * Add a tracked position.
 */
export function addTrackedPosition(agentId: string, position: TrackedPosition): void {
  const positions = getTrackedPositions(agentId);
  positions.push(position);
  saveTrackedPositions(agentId, positions);
}

/**
 * Remove a tracked position by tradeHash.
 */
export function removeTrackedPosition(agentId: string, tradeHash: string): void {
  const positions = getTrackedPositions(agentId);
  const filtered = positions.filter((p) => p.tradeHash !== tradeHash);
  saveTrackedPositions(agentId, filtered);
}

/**
 * Update a tracked position's status and optional detectedGoneAt.
 */
export function updateTrackedPositionStatus(
  agentId: string,
  tradeHash: string,
  status: TrackedPosition["status"],
  detectedGoneAt?: number
): void {
  const positions = getTrackedPositions(agentId);
  const pos = positions.find((p) => p.tradeHash === tradeHash);
  if (pos) {
    pos.status = status;
    if (detectedGoneAt !== undefined) {
      pos.detectedGoneAt = detectedGoneAt;
    }
    saveTrackedPositions(agentId, positions);
  }
}

/**
 * Link an unresolved tracked position (no tradeHash) to a discovered tradeHash.
 */
export function linkTrackedPosition(agentId: string, index: number, tradeHash: string): void {
  const positions = getTrackedPositions(agentId);
  if (index >= 0 && index < positions.length) {
    positions[index].tradeHash = tradeHash;
    saveTrackedPositions(agentId, positions);
  }
}

// ============================================================================
// Journal (Persistent Agent Activity Log)
// ============================================================================

function getJournalPath(agentId: string): string {
  return path.join(getAgentDir(agentId), "journal.jsonl");
}

/**
 * Append an entry to the agent's journal.
 * Uses JSONL format (one JSON object per line).
 */
export function appendJournal(agentId: string, entry: JournalEntry): void {
  const journalPath = getJournalPath(agentId);
  const agentDir = getAgentDir(agentId);
  if (!existsSync(agentDir)) {
    mkdirSync(agentDir, { recursive: true });
  }
  appendFileSync(journalPath, JSON.stringify(entry) + "\n");
}

/**
 * Load journal entries with optional pagination and filtering.
 * Returns { entries, total } where total is the count of matching entries.
 */
export function loadJournal(
  agentId: string,
  offset = 0,
  limit = 50,
  filter?: { tag?: string }
): { entries: JournalEntry[]; total: number } {
  const journalPath = getJournalPath(agentId);
  if (!existsSync(journalPath)) return { entries: [], total: 0 };

  try {
    const lines = readFileSync(journalPath, "utf-8").trim().split("\n").filter(Boolean);
    let allEntries = lines.map((line) => JSON.parse(line) as JournalEntry);

    if (filter?.tag) {
      allEntries = allEntries.filter((e) => e.tag === filter.tag);
    }

    allEntries.reverse();
    const entries = allEntries.slice(offset, offset + limit);
    return { entries, total: allEntries.length };
  } catch {
    return { entries: [], total: 0 };
  }
}

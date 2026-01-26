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
 * Sub-agent state stored in ~/.pragma/agents/<id>/state.json
 */
export interface SubAgentState {
  id: string;
  walletId: string;
  walletAddress: Address;
  agentType: "kairos" | "thymos" | "pragma";
  taskId: string; // Claude Code Task ID
  status: "running" | "paused" | "completed" | "failed" | "revoked";

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
    status: "running",
    budget: {
      monAllocated: params.budget.monAllocated.toString(),
      monSpent: "0",
      tokenSpent: {}, // Start with no spending
      tokenLimits,
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
    if (entry.isDirectory()) {
      const state = await loadAgentState(entry.name);
      if (state) {
        states.push(state);
      }
    }
  }

  return states;
}

/**
 * Delete agent state directory
 */
export async function deleteAgentState(agentId: string): Promise<void> {
  const agentDir = getAgentDir(agentId);

  if (existsSync(agentDir)) {
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

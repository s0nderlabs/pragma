// Wallet Pool Management
// Manages reusable sub-agent wallets for autonomous mode
// Copyright (c) 2026 s0nderlabs

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  unlinkSync,
  statSync,
  constants,
} from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type { Address } from "viem";
import {
  createAndStoreSubAgentWallet,
  getSubAgentWallet,
  deleteSubAgentWallet,
  listSubAgentWalletIds,
  type SubAgentWallet,
} from "./keys.js";
import { agentExists } from "./state.js";

/**
 * Pool wallet entry
 */
export interface PoolWallet {
  id: string; // UUID (Keychain key)
  address: Address;
  status: "idle" | "active";
  assignedTo: string | null; // Agent/Task ID when active
  createdAt: number;
  lastUsedAt: number;
}

/**
 * Wallet pool state
 */
export interface WalletPool {
  wallets: PoolWallet[];
  version: number;
}

/**
 * Get the path to the wallet pool file
 */
function getPoolFilePath(): string {
  const pragmaDir = path.join(homedir(), ".pragma");
  if (!existsSync(pragmaDir)) {
    mkdirSync(pragmaDir, { recursive: true });
  }
  return path.join(pragmaDir, "wallet-pool.json");
}

/**
 * Get the path to the lock file
 */
function getLockFilePath(): string {
  return getPoolFilePath() + ".lock";
}

/** Maximum age of a lock file before it's considered stale (30 seconds) */
const STALE_LOCK_AGE_MS = 30_000;

/**
 * Check if a process with given PID exists
 */
function processExists(pid: number): boolean {
  try {
    // Sending signal 0 doesn't kill the process, just checks if it exists
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if lock file is stale (process dead or file too old)
 */
function isLockStale(lockPath: string): boolean {
  try {
    const content = readFileSync(lockPath, "utf-8");
    const lockPid = parseInt(content, 10);

    // Invalid PID = stale
    if (Number.isNaN(lockPid)) {
      return true;
    }

    // Process doesn't exist = stale
    if (!processExists(lockPid)) {
      return true;
    }

    // Check file age as fallback
    const stat = statSync(lockPath);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > STALE_LOCK_AGE_MS) {
      return true;
    }

    return false;
  } catch {
    // Can't read lock file = treat as stale
    return true;
  }
}

/**
 * Acquire exclusive lock on wallet pool file
 * Uses atomic file creation with O_CREAT | O_EXCL flags
 * @param maxWaitMs - Maximum time to wait for lock (default: 5000ms)
 * @param retryIntervalMs - Interval between retries (default: 50ms)
 */
async function acquireLock(maxWaitMs = 5000, retryIntervalMs = 50): Promise<void> {
  const lockPath = getLockFilePath();
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    try {
      // O_CREAT | O_EXCL = fail if file exists (atomic check-and-create)
      const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      // Write PID for stale lock detection
      writeFileSync(fd, process.pid.toString());
      closeSync(fd);
      return; // Lock acquired
    } catch (err) {
      // EEXIST = lock file exists, someone else has the lock
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        // Check for stale lock
        if (isLockStale(lockPath)) {
          try {
            unlinkSync(lockPath);
          } catch {
            // Another process might have cleaned it up
          }
          continue;
        }
        // Wait and retry
        await new Promise((resolve) => setTimeout(resolve, retryIntervalMs));
        continue;
      }
      throw err; // Unexpected error
    }
  }

  throw new Error(`Failed to acquire wallet pool lock after ${maxWaitMs}ms`);
}

/**
 * Release the lock on wallet pool file
 */
function releaseLock(): void {
  const lockPath = getLockFilePath();
  try {
    unlinkSync(lockPath);
  } catch {
    // Lock file might already be gone, that's fine
  }
}

/**
 * Execute a function while holding the wallet pool lock
 * Ensures lock is always released, even on error
 */
async function withLock<T>(fn: () => T | Promise<T>): Promise<T> {
  await acquireLock();
  try {
    return await fn();
  } finally {
    releaseLock();
  }
}

/**
 * Load wallet pool from disk
 */
export function loadWalletPool(): WalletPool {
  const poolPath = getPoolFilePath();

  if (!existsSync(poolPath)) {
    return { wallets: [], version: 1 };
  }

  try {
    const content = readFileSync(poolPath, "utf-8");
    return JSON.parse(content) as WalletPool;
  } catch {
    // If file is corrupted, start fresh
    return { wallets: [], version: 1 };
  }
}

/**
 * Save wallet pool to disk
 */
function saveWalletPool(pool: WalletPool): void {
  const poolPath = getPoolFilePath();
  writeFileSync(poolPath, JSON.stringify(pool, null, 2));
}

/**
 * Get an idle wallet from the pool, or create a new one
 * Does NOT assign it - call assignWallet separately
 * @returns Pool wallet (idle)
 */
export async function getOrCreateWallet(): Promise<PoolWallet> {
  return withLock(async () => {
    const pool = loadWalletPool();

    // Look for an idle wallet
    const idleWallet = pool.wallets.find((w) => w.status === "idle");
    if (idleWallet) {
      return idleWallet;
    }

    // No idle wallets - create a new one
    const wallet = await createAndStoreSubAgentWallet();
    const now = Date.now();

    const poolWallet: PoolWallet = {
      id: wallet.id,
      address: wallet.address,
      status: "idle",
      assignedTo: null,
      createdAt: now,
      lastUsedAt: now,
    };

    pool.wallets.push(poolWallet);
    pool.version++;
    saveWalletPool(pool);

    return poolWallet;
  });
}

/**
 * Validate pool consistency and auto-heal issues:
 * - Fix wallets with status="active" but assignedTo=null
 * - Release wallets assigned to non-existent agents
 *
 * Called automatically by assignWallet() to ensure pool health.
 */
export async function validateAndHealPool(): Promise<{
  inconsistenciesFixed: number;
  orphansFixed: number;
}> {
  return withLock(async () => {
    const pool = loadWalletPool();
    let inconsistenciesFixed = 0;
    let orphansFixed = 0;
    let modified = false;

    for (const wallet of pool.wallets) {
      if (wallet.status !== "active") continue;

      // Fix inconsistent state (active but no assignedTo)
      if (!wallet.assignedTo) {
        wallet.status = "idle";
        wallet.lastUsedAt = Date.now();
        inconsistenciesFixed++;
        modified = true;
      } else {
        // Fix orphaned wallets (assigned to non-existent agent)
        const agentId = wallet.assignedTo.replace("subagent-", "");
        if (!agentExists(agentId)) {
          wallet.status = "idle";
          wallet.assignedTo = null;
          wallet.lastUsedAt = Date.now();
          orphansFixed++;
          modified = true;
        }
      }
    }

    if (modified) {
      pool.version++;
      saveWalletPool(pool);
    }

    return { inconsistenciesFixed, orphansFixed };
  });
}

/**
 * Assign an idle wallet to a task/agent
 * @param assignTo - Task or agent ID to assign to
 * @returns The assigned pool wallet
 */
export async function assignWallet(assignTo: string): Promise<PoolWallet> {
  // Heal pool before assignment (catches orphans and inconsistencies)
  await validateAndHealPool();

  return withLock(async () => {
    const pool = loadWalletPool();

    // Find an idle wallet
    let wallet = pool.wallets.find((w) => w.status === "idle");

    if (!wallet) {
      // Create a new one
      const newWallet = await createAndStoreSubAgentWallet();
      const now = Date.now();

      wallet = {
        id: newWallet.id,
        address: newWallet.address,
        status: "idle",
        assignedTo: null,
        createdAt: now,
        lastUsedAt: now,
      };
      pool.wallets.push(wallet);
    }

    // Assign it
    wallet.status = "active";
    wallet.assignedTo = assignTo;
    wallet.lastUsedAt = Date.now();

    pool.version++;
    saveWalletPool(pool);

    return wallet;
  });
}

/**
 * Release a wallet back to the pool (make it idle)
 * @param walletId - UUID of the wallet to release
 */
export async function releaseWallet(walletId: string): Promise<void> {
  return withLock(async () => {
    const pool = loadWalletPool();

    const wallet = pool.wallets.find((w) => w.id === walletId);
    if (!wallet) {
      throw new Error(`Wallet not found in pool: ${walletId}`);
    }

    wallet.status = "idle";
    wallet.assignedTo = null;
    wallet.lastUsedAt = Date.now();

    pool.version++;
    saveWalletPool(pool);
  });
}

/**
 * Get a specific wallet from the pool
 * @param walletId - UUID of the wallet
 */
export function getPoolWallet(walletId: string): PoolWallet | null {
  const pool = loadWalletPool();
  return pool.wallets.find((w) => w.id === walletId) || null;
}

/**
 * List all wallets in the pool
 * @param filter - Optional status filter
 */
export function listPoolWallets(filter?: "idle" | "active"): PoolWallet[] {
  const pool = loadWalletPool();

  if (filter) {
    return pool.wallets.filter((w) => w.status === filter);
  }

  return pool.wallets;
}

/**
 * Remove a wallet from the pool and Keychain
 * Use when permanently cleaning up (e.g., user requests wallet deletion)
 * @param walletId - UUID of the wallet to remove
 */
export async function removeWallet(walletId: string): Promise<void> {
  return withLock(async () => {
    const pool = loadWalletPool();

    const index = pool.wallets.findIndex((w) => w.id === walletId);
    if (index === -1) {
      throw new Error(`Wallet not found in pool: ${walletId}`);
    }

    // Remove from Keychain
    await deleteSubAgentWallet(walletId);

    // Remove from pool
    pool.wallets.splice(index, 1);
    pool.version++;
    saveWalletPool(pool);
  });
}

/**
 * Cleanup idle wallets that haven't been used recently
 * @param maxAgeDays - Max age in days before cleanup (default: 30)
 * @returns Number of wallets cleaned up
 */
export async function cleanupIdleWallets(maxAgeDays = 30): Promise<number> {
  return withLock(async () => {
    const pool = loadWalletPool();
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - maxAgeMs;

    const toRemove = pool.wallets.filter(
      (w) => w.status === "idle" && w.lastUsedAt < cutoff
    );

    for (const wallet of toRemove) {
      await deleteSubAgentWallet(wallet.id);
      const index = pool.wallets.findIndex((w) => w.id === wallet.id);
      if (index !== -1) {
        pool.wallets.splice(index, 1);
      }
    }

    if (toRemove.length > 0) {
      pool.version++;
      saveWalletPool(pool);
    }

    return toRemove.length;
  });
}

/**
 * Sync wallet pool with Keychain
 * Removes pool entries for wallets that no longer exist in Keychain
 * Adds pool entries for wallets in Keychain not in pool
 */
export async function syncPoolWithKeychain(): Promise<{
  added: number;
  removed: number;
}> {
  return withLock(async () => {
    const pool = loadWalletPool();
    const keychainIds = await listSubAgentWalletIds();
    const poolIds = new Set(pool.wallets.map((w) => w.id));
    const keychainIdSet = new Set(keychainIds);

    let added = 0;
    let removed = 0;

    // Remove pool entries for wallets not in Keychain
    pool.wallets = pool.wallets.filter((w) => {
      if (!keychainIdSet.has(w.id)) {
        removed++;
        return false;
      }
      return true;
    });

    // Add pool entries for wallets in Keychain not in pool
    for (const id of keychainIds) {
      if (!poolIds.has(id)) {
        const wallet = await getSubAgentWallet(id);
        if (wallet) {
          pool.wallets.push({
            id: wallet.id,
            address: wallet.address,
            status: "idle",
            assignedTo: null,
            createdAt: Date.now(),
            lastUsedAt: Date.now(),
          });
          added++;
        }
      }
    }

    if (added > 0 || removed > 0) {
      pool.version++;
      saveWalletPool(pool);
    }

    return { added, removed };
  });
}

/**
 * Get full wallet info (including private key) for a pool wallet
 * Use when you need to sign transactions
 * @param walletId - UUID of the wallet
 */
export async function getFullWallet(walletId: string): Promise<SubAgentWallet | null> {
  return getSubAgentWallet(walletId);
}

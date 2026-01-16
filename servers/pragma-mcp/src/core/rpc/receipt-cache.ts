/**
 * Receipt Cache for EIP-7966 Optimization
 *
 * Caches transaction receipts obtained from eth_sendRawTransactionSync
 * so subsequent calls to waitForReceiptSync can return immediately.
 *
 * Lifecycle:
 * 1. syncTransport caches receipt when EIP-7966 returns it
 * 2. waitForReceiptSync checks cache before making RPC call
 * 3. Receipt is removed from cache after retrieval (one-time use)
 * 4. TTL cleanup prevents memory leaks for unused entries
 *
 * Ported from pragma-v2-stable (H2)
 * @see https://eips.ethereum.org/EIPS/eip-7966
 * Copyright (c) 2026 s0nderlabs
 */

import type { TransactionReceipt } from "viem";

// Cache entry with timestamp for TTL
interface CacheEntry {
  receipt: TransactionReceipt;
  timestamp: number;
}

// Module-level cache (survives across function calls)
const cache = new Map<string, CacheEntry>();

// TTL: 5 minutes (receipts shouldn't sit in cache long)
const CACHE_TTL_MS = 5 * 60 * 1000;

// Cleanup interval: every 60 seconds
const CLEANUP_INTERVAL_MS = 60 * 1000;

// Track cleanup timer
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the cleanup timer if not already running
 */
function ensureCleanupTimer(): void {
  if (cleanupTimer === null && typeof setInterval !== "undefined") {
    cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [hash, entry] of cache.entries()) {
        if (now - entry.timestamp > CACHE_TTL_MS) {
          cache.delete(hash);
        }
      }
    }, CLEANUP_INTERVAL_MS);

    // Don't block Node.js exit
    if (cleanupTimer.unref) {
      cleanupTimer.unref();
    }
  }
}

/**
 * Cache a receipt for later retrieval
 *
 * @param hash - Transaction hash (will be normalized to lowercase)
 * @param receipt - The full transaction receipt from EIP-7966
 */
export function cacheReceipt(hash: string, receipt: TransactionReceipt): void {
  ensureCleanupTimer();
  cache.set(hash.toLowerCase(), {
    receipt,
    timestamp: Date.now(),
  });
}

/**
 * Get a cached receipt (keeps it in cache until TTL expires)
 *
 * @param hash - Transaction hash to look up
 * @returns The cached receipt, or undefined if not found
 */
export function getReceipt(hash: string): TransactionReceipt | undefined {
  const entry = cache.get(hash.toLowerCase());
  return entry?.receipt;
}

/**
 * Check if a receipt is cached (without removing it)
 *
 * @param hash - Transaction hash to check
 * @returns true if receipt is in cache
 */
export function hasReceipt(hash: string): boolean {
  return cache.has(hash.toLowerCase());
}

/**
 * Get cache statistics (for debugging)
 */
export function getCacheStats(): { size: number; hashes: string[] } {
  return {
    size: cache.size,
    hashes: Array.from(cache.keys()),
  };
}

/**
 * Clear all cached receipts (for testing)
 */
export function clearCache(): void {
  cache.clear();
}

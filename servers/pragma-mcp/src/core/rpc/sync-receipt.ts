/**
 * EIP-7966 Sync Receipt Utilities
 *
 * Helper functions for waiting on transaction receipts with EIP-7966 support.
 * These complement the syncTransport wrapper for explicit receipt handling.
 *
 * Ported from pragma-v2-stable (H2)
 * @see https://eips.ethereum.org/EIPS/eip-7966
 * Copyright (c) 2026 s0nderlabs
 */

import type { Hex, PublicClient, TransactionReceipt } from "viem";
import { getReceipt } from "./receipt-cache.js";

/**
 * Waits for a transaction receipt with EIP-7966 cache support.
 *
 * If the transaction was sent via createSyncTransport and EIP-7966 was used,
 * the receipt will be available immediately from the cache.
 * Otherwise, falls back to standard polling.
 *
 * @param client - The viem PublicClient
 * @param hash - Transaction hash to wait for
 * @param options - Configuration options
 * @returns The transaction receipt
 */
export async function waitForReceiptSync(
  client: PublicClient,
  hash: Hex,
  options?: {
    /** Timeout in milliseconds (default: 60000ms) */
    timeout?: number;
  }
): Promise<TransactionReceipt> {
  // Check cache first (populated by syncTransport from EIP-7966)
  const cached = getReceipt(hash);
  if (cached) {
    return cached;
  }

  const timeout = options?.timeout ?? 60_000;

  return await client.waitForTransactionReceipt({
    hash,
    timeout,
  });
}

/**
 * Type guard to check if a value is a transaction receipt
 */
export function isTransactionReceipt(
  value: unknown
): value is TransactionReceipt {
  return (
    typeof value === "object" &&
    value !== null &&
    "transactionHash" in value &&
    "blockNumber" in value &&
    "status" in value
  );
}

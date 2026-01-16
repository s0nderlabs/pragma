/**
 * EIP-7966 Sync Transport Wrapper
 *
 * Wraps a viem transport to use eth_sendRawTransactionSync when available.
 * This provides ~50% latency reduction by eliminating the polling loop.
 *
 * Ported from pragma-v2-stable (H2)
 * @see https://eips.ethereum.org/EIPS/eip-7966
 * Copyright (c) 2026 s0nderlabs
 */

import { custom, type Transport, type TransactionReceipt } from "viem";
import { cacheReceipt } from "./receipt-cache.js";

/**
 * Normalize raw EIP-7966 receipt to viem format
 *
 * EIP-7966 returns raw RPC format (hex strings, numeric status),
 * but viem expects normalized format (bigints, "success"/"reverted").
 */
function normalizeReceipt(raw: Record<string, unknown>): TransactionReceipt {
  // Normalize status: "0x1" or 1 → "success", "0x0" or 0 → "reverted"
  const rawStatus = raw.status;
  let status: "success" | "reverted";
  if (
    rawStatus === "0x1" ||
    rawStatus === 1 ||
    rawStatus === 1n ||
    rawStatus === "success"
  ) {
    status = "success";
  } else {
    status = "reverted";
  }

  // Helper to convert hex string to bigint
  const toBigInt = (val: unknown): bigint => {
    if (typeof val === "bigint") return val;
    if (typeof val === "number") return BigInt(val);
    if (typeof val === "string") return BigInt(val);
    return 0n;
  };

  // Helper to convert hex string to number
  const toNumber = (val: unknown): number => {
    if (typeof val === "number") return val;
    if (typeof val === "bigint") return Number(val);
    if (typeof val === "string") return parseInt(val, 16);
    return 0;
  };

  return {
    blockHash: raw.blockHash as `0x${string}`,
    blockNumber: toBigInt(raw.blockNumber),
    contractAddress: raw.contractAddress as `0x${string}` | null,
    cumulativeGasUsed: toBigInt(raw.cumulativeGasUsed),
    effectiveGasPrice: toBigInt(raw.effectiveGasPrice),
    from: raw.from as `0x${string}`,
    gasUsed: toBigInt(raw.gasUsed),
    logs: (raw.logs as unknown[]) || [],
    logsBloom: raw.logsBloom as `0x${string}`,
    status,
    to: raw.to as `0x${string}` | null,
    transactionHash: raw.transactionHash as `0x${string}`,
    transactionIndex: toNumber(raw.transactionIndex),
    type: raw.type as "legacy" | "eip2930" | "eip1559" | "eip4844" | "eip7702",
  } as TransactionReceipt;
}

/**
 * Creates a transport wrapper that intercepts eth_sendRawTransaction calls
 * and attempts to use EIP-7966 eth_sendRawTransactionSync instead.
 *
 * Benefits:
 * - ~50% latency reduction (no polling loop)
 * - Simpler error handling (timeout, nonce issues returned directly)
 * - Works transparently with MetaMask Delegation Toolkit (DTK)
 *
 * @param baseTransport - The underlying transport to wrap (e.g., http())
 * @param options - Configuration options
 * @returns A wrapped transport that uses sync transactions when available
 */
export function createSyncTransport(
  baseTransport: Transport,
  options?: {
    /** Timeout in milliseconds for sync transaction (default: 5000ms) */
    timeout?: number;
  }
): Transport {
  // Default 5000ms - enough for complex delegation txs on Monad (~1s blocks)
  const timeout = options?.timeout ?? 5000;

  return custom({
    async request({ method, params }) {
      // Get the base transport instance
      const transport = baseTransport({ chain: undefined, retryCount: 0 });

      // Intercept eth_sendRawTransaction and try sync version
      if (method === "eth_sendRawTransaction") {
        try {
          // Try EIP-7966 sync method first
          const result = await transport.request({
            method: "eth_sendRawTransactionSync",
            params: [...(params as unknown[]), timeout],
          });

          // EIP-7966 returns the full receipt, but callers expect just the hash
          // Extract transactionHash if we got a receipt object
          if (
            typeof result === "object" &&
            result !== null &&
            "transactionHash" in result
          ) {
            // Normalize raw RPC receipt to viem format before caching
            const rawReceipt = result as Record<string, unknown>;
            const normalizedReceipt = normalizeReceipt(rawReceipt);
            cacheReceipt(normalizedReceipt.transactionHash, normalizedReceipt);
            return normalizedReceipt.transactionHash;
          }

          return result;
        } catch (e: unknown) {
          // Fallback: method not supported or RPC doesn't implement EIP-7966
          const error = e as { code?: number; message?: string };

          // -32601 = Method not found (standard JSON-RPC error)
          // Also check for common error messages
          const isUnsupportedMethod =
            error?.code === -32601 ||
            error?.message?.includes("not found") ||
            error?.message?.includes("not supported") ||
            error?.message?.includes("unknown method");

          // Detect timeout errors - EIP-7966 may timeout but tx was likely submitted
          const isTimeout =
            error?.message?.includes("timeout") ||
            error?.message?.includes("not available within");

          if (isUnsupportedMethod || isTimeout) {
            // Fallback to standard eth_sendRawTransaction
            return transport.request({ method, params });
          }

          // For other errors (nonce issues, etc.), propagate them
          throw e;
        }
      }

      // Pass through all other RPC methods unchanged
      return transport.request({ method, params });
    },
  });
}

/**
 * Check if the RPC endpoint supports EIP-7966
 *
 * @param transport - The transport to check
 * @returns Promise<boolean> - true if eth_sendRawTransactionSync is supported
 */
export async function checkSyncTransactionSupport(
  transport: Transport
): Promise<boolean> {
  try {
    const t = transport({ chain: undefined, retryCount: 0 });

    // Try calling with invalid params to check if method exists
    // This will fail with "invalid params" if supported, or "method not found" if not
    await t.request({
      method: "eth_sendRawTransactionSync",
      params: ["0x"], // Invalid but triggers method check
    });

    // If we get here without error, something unexpected happened
    return true;
  } catch (e: unknown) {
    const error = e as { code?: number; message?: string };

    // -32601 = Method not found
    if (error?.code === -32601 || error?.message?.includes("not found")) {
      return false;
    }

    // Any other error (like invalid params) means the method exists
    return true;
  }
}

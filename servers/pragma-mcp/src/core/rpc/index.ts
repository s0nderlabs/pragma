/**
 * RPC Utilities - EIP-7966 Sync Transaction Support
 *
 * Provides optimized transaction handling with ~50% latency reduction
 * when the RPC supports eth_sendRawTransactionSync (EIP-7966).
 *
 * @see https://eips.ethereum.org/EIPS/eip-7966
 * Copyright (c) 2026 s0nderlabs
 */

// Sync transport - wraps viem transport with EIP-7966 support
export {
  createSyncTransport,
  checkSyncTransactionSupport,
} from "./sync-transport.js";

// Sync receipt - cache-aware receipt waiting
export { waitForReceiptSync, isTransactionReceipt } from "./sync-receipt.js";

// Receipt cache - for debugging/testing
export {
  cacheReceipt,
  getReceipt,
  hasReceipt,
  getCacheStats,
  clearCache,
} from "./receipt-cache.js";

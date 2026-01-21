// nad.fun HTTP API Client
// HTTP client for the public nad.fun API (https://api.nad.fun/)
// Works in both BYOK and x402 modes (no auth required)
// Copyright (c) 2026 s0nderlabs

import { withRetry } from "../utils/retry.js";

// ============================================================================
// Constants
// ============================================================================

export const NADFUN_API_BASE = "https://api.nad.fun";

/**
 * Monad explorer URL for transaction links
 */
export const MONAD_EXPLORER_URL = "https://explorer.monad.xyz";

// ============================================================================
// API Client
// ============================================================================

/**
 * Fetch from nad.fun public HTTP API with retry logic
 *
 * The nad.fun API is public (no authentication required) so this works
 * in both BYOK and x402 modes.
 *
 * @param path - API endpoint path (e.g., "/order/market_cap")
 * @param params - Optional query parameters
 * @returns Parsed JSON response
 * @throws Error if request fails after retries
 *
 * @example
 * ```typescript
 * const data = await fetchNadFunApi<NadFunApiListingResponse>("/order/market_cap", {
 *   page: 1,
 *   limit: 10,
 * });
 * ```
 */
export async function fetchNadFunApi<T>(
  path: string,
  params?: Record<string, string | number | boolean | undefined>
): Promise<T> {
  const url = new URL(path, NADFUN_API_BASE);

  // Add query parameters (skip undefined values)
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    });
  }

  const result = await withRetry(
    async () => {
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        // Include status in error for retry logic to detect transient errors
        throw new Error(`nad.fun API error (${response.status}): ${response.statusText}`);
      }

      return response.json() as Promise<T>;
    },
    {
      operationName: `nadfun-api-${path}`,
      maxRetries: 2,
      baseDelayMs: 500,
    }
  );

  if (!result.success) {
    throw new Error(result.error?.message || "nad.fun API request failed");
  }

  return result.data!;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Format price change percentage with sign
 *
 * @param percent - Raw percent string from API
 * @returns Formatted string like "+5.20%" or "-3.10%"
 */
export function formatPriceChange(percent: string | undefined): string {
  if (!percent) return "0.00%";

  const num = parseFloat(percent);
  if (isNaN(num)) return "0.00%";

  if (num >= 0) {
    return `+${num.toFixed(2)}%`;
  }
  return `${num.toFixed(2)}%`;
}

/**
 * Format USD price with appropriate precision
 *
 * @param price - Raw price string from API
 * @returns Formatted price string
 */
export function formatPrice(price: string | undefined): string {
  if (!price) return "0.00";

  const num = parseFloat(price);
  if (isNaN(num)) return "0.00";

  // Use more decimal places for very small prices
  if (num < 0.0001) {
    return num.toExponential(2);
  }
  if (num < 0.01) {
    return num.toFixed(6);
  }
  if (num < 1) {
    return num.toFixed(4);
  }
  return num.toFixed(2);
}

/**
 * Format token amount with appropriate precision
 *
 * @param amount - Raw amount string
 * @returns Formatted amount
 */
export function formatAmount(amount: string | undefined): string {
  if (!amount) return "0";

  const num = parseFloat(amount);
  if (isNaN(num)) return "0";

  if (num >= 1_000_000) {
    return `${(num / 1_000_000).toFixed(2)}M`;
  }
  if (num >= 1_000) {
    return `${(num / 1_000).toFixed(2)}K`;
  }
  if (num < 0.0001) {
    return num.toExponential(2);
  }
  if (num < 1) {
    return num.toFixed(6);
  }
  return num.toFixed(2);
}

/**
 * Build explorer URL for a transaction hash
 *
 * @param txHash - Transaction hash
 * @returns Full explorer URL
 */
export function buildExplorerUrl(txHash: string): string {
  return `${MONAD_EXPLORER_URL}/tx/${txHash}`;
}

/**
 * Calculate progress percentage from basis points
 *
 * @param progress - Progress in basis points (0-10000)
 * @returns Formatted percentage string
 */
export function formatProgress(progress: number | undefined): string {
  if (progress === undefined) return "0.00%";
  return `${(progress / 100).toFixed(2)}%`;
}

/**
 * Truncate address for display
 *
 * @param address - Full address
 * @param prefixLen - Characters to show at start (default 6)
 * @param suffixLen - Characters to show at end (default 4)
 * @returns Truncated address like "0x1234...abcd"
 */
export function truncateAddress(
  address: string,
  prefixLen: number = 6,
  suffixLen: number = 4
): string {
  if (address.length <= prefixLen + suffixLen) return address;
  return `${address.slice(0, prefixLen)}...${address.slice(-suffixLen)}`;
}

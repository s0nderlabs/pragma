// x402 Client
// Fetch wrapper that handles x402 micropayments transparently
// Copyright (c) 2026 s0nderlabs

import { http, type Transport } from "viem";
import { signPaymentAuthorization, createPaymentHeader } from "./payment.js";
import { X402_API_PATTERNS, type X402PaymentRequired } from "./types.js";
import { getUsdcAddress } from "./usdc.js";
import { loadConfig, getRpcUrl } from "../../config/pragma-config.js";
import type { PragmaConfig } from "../../types/index.js";
import { isTransientError, sleep } from "../utils/retry.js";
import { createSyncTransport } from "../rpc/index.js";

// MARK: - Constants

const X_PAYMENT_HEADER = "x-payment";
const X_PAYMENT_RESPONSE_HEADER = "x-payment-response";

// Retry defaults for transient errors
const MAX_RETRIES = 2;
const BASE_DELAY_MS = 500;

/**
 * Fetch with retry for transient errors
 *
 * Retries on network errors, timeouts, and 502/503/504 responses.
 * Does NOT retry on 402 (expected x402 payment required response).
 *
 * @param input - URL or Request
 * @param init - Request options
 * @param operationName - For logging
 * @returns Response
 */
async function fetchWithRetry(
  input: string | Request | URL,
  init?: RequestInit,
  operationName = "fetch"
): Promise<Response> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(input, init);

      // Don't retry 402 - it's expected x402 response, not an error
      if (response.status === 402) {
        return response;
      }

      // Retry on server errors (502, 503, 504)
      if (response.status >= 502 && response.status <= 504) {
        const errorMsg = `Server error ${response.status}`;
        if (attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt);
          console.log(`[x402] ${operationName}: ${errorMsg}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
          await sleep(delay);
          continue;
        }
        // Final attempt failed, return the response anyway
        console.log(`[x402] ${operationName}: ${errorMsg} after ${MAX_RETRIES} retries`);
        return response;
      }

      // Success or client error (4xx except 402) - return as-is
      return response;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if transient error
      if (isTransientError(lastError) && attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        console.log(`[x402] ${operationName}: ${lastError.message}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await sleep(delay);
        continue;
      }

      // Non-transient error or max retries reached
      throw lastError;
    }
  }

  // Should not reach here, but TypeScript needs this
  throw lastError ?? new Error("Fetch failed after retries");
}

// MARK: - Detection

/**
 * Check if URL should use x402 payment
 * Detection based on URL patterns (pragma-api URLs)
 *
 * For local dev, set X402_API_URL env var - the host will be detected automatically
 *
 * @param url - URL to check
 * @returns True if URL matches x402 patterns
 */
export function isX402Endpoint(url: string): boolean {
  // Start with production patterns
  const patterns: string[] = [...X402_API_PATTERNS];

  // Add local dev URL host if set via env var
  if (process.env.X402_API_URL) {
    try {
      const devHost = new URL(process.env.X402_API_URL).host;
      if (!patterns.includes(devHost)) {
        patterns.push(devHost);
      }
    } catch {
      // Invalid URL, ignore
    }
  }

  return patterns.some((pattern) => url.includes(pattern));
}

/**
 * Check if request headers already contain a payment header
 */
function hasPaymentHeader(headers: RequestInit["headers"]): boolean {
  if (!headers) return false;

  if (headers instanceof Headers) {
    return headers.has(X_PAYMENT_HEADER);
  }

  const headerObj = headers as Record<string, string>;
  return X_PAYMENT_HEADER in headerObj || "X-PAYMENT" in headerObj;
}

// MARK: - x402 Fetch Wrapper

/**
 * x402-aware fetch wrapper
 *
 * Handles the x402 payment flow transparently:
 * 1. Makes initial request
 * 2. If 402 returned, signs EIP-3009 payment with session key
 * 3. Retries with X-Payment header
 * 4. Returns response (or throws on error)
 *
 * This wrapper auto-pays silently - no user prompt per API call.
 * For BYOK mode (non-x402 URLs), passes through to regular fetch.
 *
 * @param input - URL or Request object
 * @param init - Request init options
 * @returns Response from server
 */
export async function x402Fetch(
  input: string | Request | URL,
  init?: RequestInit
): Promise<Response> {
  const url = input.toString();

  // BYOK mode - pass through with retry for transient errors
  if (!isX402Endpoint(url)) {
    return fetchWithRetry(input, init, "byok");
  }

  // Check if payment already attempted (prevent infinite loops)
  if (hasPaymentHeader(init?.headers)) {
    return fetchWithRetry(input, init, "x402-paid");
  }

  // Load config to get wallet/session for bootstrap quota
  const config = await loadConfig();
  const walletAddress = config?.wallet?.smartAccountAddress;
  const sessionAddress = config?.wallet?.sessionKeyAddress;

  // Build headers with bootstrap identification (for free quota)
  const originalHeaders = init?.headers instanceof Headers
    ? Object.fromEntries(init.headers.entries())
    : (init?.headers as Record<string, string>) || {};

  const bootstrapHeaders: Record<string, string> = {
    ...originalHeaders,
    ...(walletAddress && { "X-PRAGMA-WALLET": walletAddress }),
    ...(sessionAddress && { "X-PRAGMA-SESSION": sessionAddress }),
  };

  const initWithBootstrap: RequestInit = {
    ...init,
    headers: bootstrapHeaders,
  };

  // Step 1: Make initial request with bootstrap headers (with retry for transient errors)
  const initialResponse = await fetchWithRetry(input, initWithBootstrap, "x402-initial");

  // If not 402, return as-is (success or other error)
  if (initialResponse.status !== 402) {
    return initialResponse;
  }

  // Step 2: Parse 402 response
  let paymentRequired: X402PaymentRequired;
  try {
    paymentRequired = (await initialResponse.json()) as X402PaymentRequired;
  } catch {
    throw new Error("Invalid 402 response: could not parse payment requirements");
  }

  if (!paymentRequired.accepts || paymentRequired.accepts.length === 0) {
    throw new Error("No payment options available in 402 response");
  }

  // Use first accepted payment method
  const requirements = paymentRequired.accepts[0];

  // Step 3: Verify config for payment (reuse from earlier, but require it now)
  if (!config) {
    throw new Error("Config not loaded. Run setup_wallet first.");
  }

  const chainId = config.network.chainId;
  const rpcUrl = await getRpcUrl(config);
  const usdcAddress = getUsdcAddress(chainId);

  if (!usdcAddress) {
    throw new Error(`USDC not configured for chain ${chainId}`);
  }

  // Step 4: Sign payment authorization with session key
  const { authorization, signature } = await signPaymentAuthorization(
    requirements,
    usdcAddress,
    chainId,
    rpcUrl
  );

  // Step 5: Create payment header
  const paymentHeader = createPaymentHeader(
    authorization,
    signature,
    requirements,
    paymentRequired.resource
  );

  // Step 6: Retry with payment header (include bootstrap headers for consistency)
  const paidInit: RequestInit = {
    ...init,
    headers: {
      ...bootstrapHeaders,
      [X_PAYMENT_HEADER]: paymentHeader,
    },
  };

  const paidResponse = await fetchWithRetry(input, paidInit, "x402-paid");

  // Check for payment rejection
  if (paidResponse.status === 402) {
    let errorMessage = "Payment rejected";
    try {
      const errorBody = await paidResponse.json();
      errorMessage = `Payment rejected: ${
        (errorBody as { reason?: string; message?: string }).reason ||
        (errorBody as { reason?: string; message?: string }).message ||
        "Unknown reason"
      }`;
    } catch {
      // Use default error message
    }
    throw new Error(errorMessage);
  }

  return paidResponse;
}

/**
 * Check if x402 mode is active based on current configuration
 *
 * @returns True if config.mode === "x402"
 */
export async function isX402Mode(): Promise<boolean> {
  const config = await loadConfig();
  return config?.mode === "x402";
}

/**
 * Create x402 fetch with custom error handling
 *
 * Use this when you need custom error handling for x402 failures.
 *
 * @param onPaymentError - Callback for payment errors
 * @returns Wrapped fetch function
 */
export function createX402Fetch(
  onPaymentError?: (error: Error, url: string) => void
): typeof x402Fetch {
  return async (input, init) => {
    try {
      return await x402Fetch(input, init);
    } catch (error) {
      if (error instanceof Error && onPaymentError) {
        onPaymentError(error, input.toString());
      }
      throw error;
    }
  };
}

/**
 * Create an x402-aware viem HTTP transport options
 *
 * Use this instead of viem's default `http()` options when creating clients
 * that need to make RPC calls through the x402 proxy.
 *
 * NOTE: This uses viem's `onFetchRequest` and `onFetchResponse` hooks to
 * intercept and handle 402 responses with automatic payment signing.
 *
 * @param config - Current configuration (respects config.mode)
 * @returns HTTP transport options for x402, or empty options if in BYOK mode
 *
 * @example
 * ```typescript
 * import { createPublicClient, http } from "viem";
 * import { x402HttpOptions } from "./x402/client.js";
 *
 * const client = createPublicClient({
 *   chain,
 *   transport: http(rpcUrl, x402HttpOptions(config)),
 * });
 * ```
 */
export function x402HttpOptions(config: PragmaConfig) {
  // If not in x402 mode, return empty options (default fetch)
  if (config.mode !== "x402") {
    return {};
  }

  return {
    // Use custom fetch function that handles x402 payment flow
    fetchFn: x402Fetch as typeof fetch,
    // Retry configuration for transient failures
    retryCount: 0, // We handle retries ourselves in x402Fetch
  };
}

/**
 * Create an EIP-7966 enabled viem HTTP transport
 *
 * Combines x402 payment handling with EIP-7966 sync transaction support
 * for ~50% latency reduction on transaction submissions.
 *
 * @param rpcUrl - RPC endpoint URL
 * @param config - Current configuration (respects config.mode)
 * @returns Transport with EIP-7966 + x402 support
 *
 * @example
 * ```typescript
 * const transport = createSyncHttpTransport(rpcUrl, config);
 * const client = createPublicClient({ chain, transport });
 * ```
 */
export function createSyncHttpTransport(
  rpcUrl: string,
  config: PragmaConfig
): Transport {
  const baseTransport = http(rpcUrl, x402HttpOptions(config));
  return createSyncTransport(baseTransport);
}

// MARK: - API URL Resolution

/**
 * x402 API service types
 * These map to endpoints on the x402 proxy
 */
export type X402ServiceType = "rpc" | "bundler" | "quote" | "data";

/**
 * x402 API base URL (production)
 * For local development, set X402_API_URL env var
 */
const X402_BASE_URL = "https://api.pr4gma.xyz";

/**
 * Get the x402 API base URL
 *
 * Order of precedence:
 * 1. X402_API_URL env var (for local dev)
 * 2. Production URL (api.pr4gma.xyz)
 *
 * Local dev: export X402_API_URL=http://localhost:8787
 */
export function getX402BaseUrl(): string {
  return process.env.X402_API_URL || X402_BASE_URL;
}

/**
 * API endpoint configuration for x402 mode
 * Maps service types to their x402 proxy endpoints
 */
interface ApiEndpointConfig {
  /** Full URL for the service */
  url: string;
  /** Whether user API key/auth is needed (false in x402 mode) */
  needsAuth: boolean;
  /** Whether this goes through x402 proxy */
  isX402: boolean;
}

/**
 * Get API endpoint configuration for a service
 *
 * IMPORTANT: This function ONLY works for x402 mode.
 * For BYOK mode, use the adapter system (src/core/adapters/).
 *
 * @param service - Service type (rpc, bundler, quote, data)
 * @param chainId - Chain ID for endpoint path
 * @returns Endpoint configuration
 * @throws Error if in BYOK mode (use adapter system instead)
 *
 * @example
 * ```typescript
 * // x402 mode only
 * const endpoint = await getApiEndpoint("quote", 143);
 * const response = await x402Fetch(endpoint.url, { method: "GET" });
 * ```
 */
export async function getApiEndpoint(
  service: X402ServiceType,
  chainId: number
): Promise<ApiEndpointConfig> {
  const inX402Mode = await isX402Mode();

  if (inX402Mode) {
    // x402 mode: Construct URLs from hardcoded constant (ONLY hardcoded URL)
    const baseUrl = getX402BaseUrl();
    return {
      url: `${baseUrl}/${chainId}/${service}`,
      needsAuth: false, // Proxy has the API keys
      isX402: true,
    };
  }

  // BYOK mode: Must use adapter system
  throw new Error(
    `BYOK mode requires adapter configuration. Run /pragma:providers to set up your ${service} provider.`
  );
}

/**
 * Check if a specific service needs user authentication
 * In x402 mode, proxy handles auth. In BYOK mode, user provides adapters.
 *
 * @param service - Service type
 * @returns True if user needs to provide API key (BYOK mode)
 */
export async function serviceNeedsAuth(_service: X402ServiceType): Promise<boolean> {
  const inX402Mode = await isX402Mode();
  return !inX402Mode;
}

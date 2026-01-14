// x402 Client
// Fetch wrapper that handles x402 micropayments transparently
// Copyright (c) 2026 s0nderlabs

import type { Address } from "viem";
import { signPaymentAuthorization, createPaymentHeader } from "./payment.js";
import { X402_API_PATTERNS, type X402PaymentRequired } from "./types.js";
import { getUsdcAddress } from "./usdc.js";
import { loadConfig, getRpcUrl } from "../../config/pragma-config.js";

// MARK: - Constants

const X_PAYMENT_HEADER = "x-payment";
const X_PAYMENT_RESPONSE_HEADER = "x-payment-response";

// Bootstrap headers for free calls
const X_PRAGMA_WALLET_HEADER = "x-pragma-wallet";
const X_PRAGMA_SESSION_HEADER = "x-pragma-session";

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
 * Extract route type from pragma-api URL for logging
 *
 * @param url - URL to parse
 * @returns Route type (e.g., "rpc", "bundler", "quote")
 */
function getRouteType(url: string): string {
  const match = url.match(/\/\d+\/(\w+)/);
  return match?.[1] || "unknown";
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

  // BYOK mode - pass through to regular fetch
  if (!isX402Endpoint(url)) {
    return fetch(input, init);
  }

  // Check if payment already attempted (prevent infinite loops)
  const existingHeaders = init?.headers;
  if (existingHeaders) {
    const headerObj = existingHeaders instanceof Headers
      ? Object.fromEntries(existingHeaders.entries())
      : existingHeaders as Record<string, string>;
    if (headerObj[X_PAYMENT_HEADER] || headerObj["X-PAYMENT"] || headerObj["PAYMENT-SIGNATURE"]) {
      // Payment header already present, don't try to pay again
      return fetch(input, init);
    }
  }

  console.log("[x402] Making request to:", url);

  // Step 1: Make initial request
  const initialResponse = await fetch(input, init);

  console.log("[x402] Initial response status:", initialResponse.status);

  // If not 402, return as-is (success or other error)
  if (initialResponse.status !== 402) {
    return initialResponse;
  }

  console.log("[x402] Got 402, processing payment...");

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

  // Step 3: Load config for chain info
  const config = await loadConfig();
  if (!config) {
    throw new Error("Config not loaded. Run setup_wallet first.");
  }

  const chainId = config.network.chainId;
  const rpcUrl = await getRpcUrl(config);
  const usdcAddress = getUsdcAddress(chainId);

  if (!usdcAddress) {
    throw new Error(`USDC not configured for chain ${chainId}`);
  }

  console.log("[x402] Payment requirements:", JSON.stringify(requirements, null, 2));

  // Step 4: Sign payment authorization with session key
  // This uses the session key EOA - no Touch ID required
  console.log("[x402] Signing payment authorization...");
  const { authorization, signature } = await signPaymentAuthorization(
    requirements,
    usdcAddress,
    chainId,
    rpcUrl
  );

  console.log("[x402] Payment signed, authorization:", JSON.stringify(authorization, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2));

  // Step 5: Create payment header
  const paymentHeader = createPaymentHeader(
    authorization,
    signature,
    requirements,
    paymentRequired.resource
  );

  console.log("[x402] Payment header created, length:", paymentHeader.length);

  // Step 6: Retry with payment header
  // Preserve original headers and add payment header
  const originalHeaders = init?.headers instanceof Headers
    ? Object.fromEntries(init.headers.entries())
    : (init?.headers as Record<string, string>) || {};

  const paidInit: RequestInit = {
    ...init,
    headers: {
      ...originalHeaders,
      [X_PAYMENT_HEADER]: paymentHeader,
    },
  };

  console.log("[x402] Retrying with payment...");
  console.log("[x402] Payment header (first 100 chars):", paymentHeader.substring(0, 100));
  const paidResponse = await fetch(input, paidInit);
  console.log("[x402] Paid response status:", paidResponse.status);

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

  // Log successful payment (for debugging)
  const paymentResponse = paidResponse.headers.get(X_PAYMENT_RESPONSE_HEADER);
  if (paymentResponse) {
    console.log(
      `[x402] Paid for ${getRouteType(url)}: ${requirements.amount} USDC base units`
    );
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
 * @returns HTTP transport options for x402
 *
 * @example
 * ```typescript
 * import { createPublicClient, http } from "viem";
 * import { x402HttpOptions } from "./x402/client.js";
 *
 * const client = createPublicClient({
 *   chain,
 *   transport: http(rpcUrl, x402HttpOptions()),
 * });
 * ```
 */
export function x402HttpOptions() {
  return {
    // Use custom fetch function that handles x402 payment flow
    fetchFn: x402Fetch as typeof fetch,
    // Retry configuration for transient failures
    retryCount: 0, // We handle retries ourselves in x402Fetch
  };
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

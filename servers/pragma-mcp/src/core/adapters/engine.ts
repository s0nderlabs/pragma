// Adapter Engine
// Generic adapter execution - NO provider-specific logic
// All configuration comes from adapter JSON files
// Copyright (c) 2026 s0nderlabs

import type { Address, Hex } from "viem";
import { getAddress } from "viem";
import type {
  AdapterDefinition,
  AdapterResult,
  ServiceType,
  UnifiedQuoteRequest,
  UnifiedQuoteResponse,
  UnifiedDataRequest,
} from "./types.js";
import { getConfiguredAdapters, loadAdapter } from "./loader.js";
import { loadConfig } from "../../config/pragma-config.js";
import type { PragmaConfig } from "../../types/index.js";
import { withRetry } from "../utils/retry.js";

// MARK: - Helpers

/**
 * Get adapters for a service type with proper error handling
 */
async function getAdaptersForService(
  serviceType: ServiceType
): Promise<{ adapters: AdapterDefinition[]; config: PragmaConfig } | { error: AdapterResult<never> }> {
  const config = await loadConfig();
  if (!config) {
    return {
      error: {
        success: false,
        error: "Config not loaded. Run setup_wallet first.",
        provider: "none",
        latencyMs: 0,
      },
    };
  }

  const adapters = getConfiguredAdapters(serviceType, config.providers);
  if (adapters.length === 0) {
    return {
      error: {
        success: false,
        error: `No ${serviceType} adapters configured. Run /pragma:providers to set up.`,
        provider: "none",
        latencyMs: 0,
      },
    };
  }

  return { adapters, config };
}

/**
 * Create a failure result with timing
 */
function failResult<T>(
  error: string,
  provider: string,
  startTime: number
): AdapterResult<T> {
  return {
    success: false,
    error,
    provider,
    latencyMs: Date.now() - startTime,
  };
}

// MARK: - JSONPath Extraction

/**
 * Extract a value from an object using a JSONPath-like string
 *
 * Supports:
 * - Simple paths: "$.field.nested"
 * - Array access: "$.items[0]"
 * - Bracket notation: "$['field-name']"
 *
 * @param obj - Object to extract from
 * @param path - JSONPath-like path
 * @returns Extracted value or undefined
 */
export function extractValue(obj: unknown, path: string): unknown {
  if (!path.startsWith("$")) {
    // Not a path, return as literal
    return path;
  }

  // Remove leading "$" and optional "."
  let normalizedPath = path.slice(1);
  if (normalizedPath.startsWith(".")) {
    normalizedPath = normalizedPath.slice(1);
  }

  if (!normalizedPath) {
    return obj;
  }

  // Split path into segments
  const segments: string[] = [];
  let current = "";
  let inBracket = false;

  for (const char of normalizedPath) {
    if (char === "[" && !inBracket) {
      if (current) {
        segments.push(current);
        current = "";
      }
      inBracket = true;
    } else if (char === "]" && inBracket) {
      segments.push(current.replace(/^['"]|['"]$/g, "")); // Remove quotes
      current = "";
      inBracket = false;
    } else if (char === "." && !inBracket) {
      if (current) {
        segments.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current) {
    segments.push(current);
  }

  // Navigate through object
  let result: unknown = obj;
  for (const segment of segments) {
    if (result === null || result === undefined) {
      return undefined;
    }

    // Handle array index
    const arrayIndex = parseInt(segment, 10);
    if (!isNaN(arrayIndex) && Array.isArray(result)) {
      result = result[arrayIndex];
    } else if (typeof result === "object") {
      result = (result as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }

  return result;
}

// MARK: - Request/Response Mapping

/**
 * Map a unified request to provider-specific parameters
 *
 * @param request - Unified request object
 * @param mapping - Request mapping from adapter definition
 * @returns Provider-specific parameters
 */
export function mapRequest(
  request: Record<string, unknown>,
  mapping: Record<string, string>
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [providerParam, template] of Object.entries(mapping)) {
    // Template can be "{fieldName}" or a literal value
    const match = template.match(/^\{(\w+)\}$/);
    if (match) {
      const fieldName = match[1];
      const value = request[fieldName];
      if (value !== undefined && value !== null) {
        result[providerParam] = String(value);
      }
    } else {
      // Literal value
      result[providerParam] = template;
    }
  }

  return result;
}

/**
 * Map a provider response to unified response format
 *
 * @param response - Raw provider response
 * @param mapping - Response mapping from adapter definition
 * @returns Mapped response object
 */
export function mapResponse<T>(
  response: unknown,
  mapping: Record<string, string>
): Partial<T> {
  const result: Record<string, unknown> = {};

  for (const [unifiedField, jsonPath] of Object.entries(mapping)) {
    const value = extractValue(response, jsonPath);
    if (value !== undefined) {
      result[unifiedField] = value;
    }
  }

  return result as Partial<T>;
}

// MARK: - Header Building

/**
 * Build request headers including authentication
 *
 * @param adapter - Adapter definition
 * @returns Headers object
 */
export async function buildHeaders(
  adapter: AdapterDefinition
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...adapter.headers,
  };

  // Add authentication header if needed
  if (adapter.auth.type === "header" || adapter.auth.type === "bearer") {
    const { getProvider } = await import("../signer/index.js");
    const apiKey = await getProvider(adapter.auth.keyName);

    if (!apiKey) {
      throw new Error(
        `API key not found for adapter "${adapter.name}". ` +
          `Store it with: pragma-signer store-provider ${adapter.auth.keyName} "YOUR_KEY"`
      );
    }

    if (adapter.auth.type === "bearer") {
      headers["Authorization"] = `Bearer ${apiKey}`;
    } else if (adapter.auth.header) {
      headers[adapter.auth.header] = apiKey;
    }
  }

  return headers;
}

// MARK: - URL Building

/**
 * Build request URL with query parameters
 *
 * @param endpoint - Base endpoint URL
 * @param params - Query parameters
 * @param adapter - Adapter definition (for query auth)
 * @param apiKey - API key (for query auth)
 * @returns Full URL string
 */
export async function buildUrl(
  endpoint: string,
  params: Record<string, string>,
  adapter: AdapterDefinition
): Promise<string> {
  const url = new URL(endpoint);

  // Add query parameters
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  // Add API key as query param if using query auth
  if (adapter.auth.type === "query" && adapter.auth.queryParam) {
    const { getProvider } = await import("../signer/index.js");
    const apiKey = await getProvider(adapter.auth.keyName);

    if (!apiKey) {
      throw new Error(
        `API key not found for adapter "${adapter.name}". ` +
          `Store it with: pragma-signer store-provider ${adapter.auth.keyName} "YOUR_KEY"`
      );
    }

    url.searchParams.set(adapter.auth.queryParam, apiKey);
  }

  return url.toString();
}

// MARK: - Quote Execution

/**
 * Execute a quote request using a single adapter
 *
 * @param request - Unified quote request
 * @param adapter - Adapter definition
 * @returns Adapter result with quote response
 */
export async function executeQuoteRequest(
  request: UnifiedQuoteRequest,
  adapter: AdapterDefinition
): Promise<AdapterResult<UnifiedQuoteResponse>> {
  const startTime = Date.now();

  try {
    // Validate chain support
    if (!adapter.chainIds.includes(request.chainId)) {
      return {
        success: false,
        error: `Adapter "${adapter.name}" does not support chain ${request.chainId}`,
        provider: adapter.name,
        latencyMs: Date.now() - startTime,
      };
    }

    // Map request to provider parameters
    const providerParams = mapRequest(
      {
        sellToken: request.sellToken,
        buyToken: request.buyToken,
        sellAmount: request.sellAmount,
        sender: request.sender,
        slippageBps: request.slippageBps,
        chainId: request.chainId,
      },
      adapter.request
    );

    // Build URL and headers
    const url = await buildUrl(adapter.endpoint, providerParams, adapter);
    const headers = await buildHeaders(adapter);

    console.log(`[adapters] Fetching quote from ${adapter.name}: ${url}`);

    // Make request with retry for transient errors
    const fetchResult = await withRetry(
      async () => {
        const response = await fetch(url, {
          method: "GET",
          headers,
        });

        if (!response.ok) {
          const text = await response.text();
          throw new Error(`${adapter.name} API error (${response.status}): ${text}`);
        }

        return response.json();
      },
      { operationName: `quote-${adapter.name}` }
    );

    if (!fetchResult.success) {
      return {
        success: false,
        error: fetchResult.error?.message ?? "Unknown error",
        provider: adapter.name,
        latencyMs: Date.now() - startTime,
      };
    }

    const rawResponse = fetchResult.data;

    // Map response to unified format
    const mapped = mapResponse<UnifiedQuoteResponse>(rawResponse, adapter.response);

    // Validate required fields
    if (!mapped.buyAmount || !mapped.calldata || !mapped.router) {
      return {
        success: false,
        error: `Invalid response from ${adapter.name}: missing required fields`,
        provider: adapter.name,
        latencyMs: Date.now() - startTime,
      };
    }

    // Build final response
    const quoteResponse: UnifiedQuoteResponse = {
      buyAmount: String(mapped.buyAmount),
      minBuyAmount: String(mapped.minBuyAmount || mapped.buyAmount),
      router: getAddress(String(mapped.router)) as Address,
      calldata: String(mapped.calldata) as Hex,
      value: String(mapped.value || "0"),
      gas: String(mapped.gas || "300000"),
      liquidityAvailable: mapped.liquidityAvailable !== false,
    };

    return {
      success: true,
      data: quoteResponse,
      provider: adapter.name,
      latencyMs: Date.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      provider: adapter.name,
      latencyMs: Date.now() - startTime,
    };
  }
}

/**
 * Execute quote request with fallback through configured adapters
 *
 * Tries each configured adapter in order until one succeeds.
 */
export async function executeQuoteWithFallback(
  request: UnifiedQuoteRequest
): Promise<AdapterResult<UnifiedQuoteResponse>> {
  const adapterResult = await getAdaptersForService("quote");
  if ("error" in adapterResult) {
    return adapterResult.error;
  }

  const errors: string[] = [];

  for (const adapter of adapterResult.adapters) {
    console.log(`[adapters] Trying quote adapter: ${adapter.name}`);
    const result = await executeQuoteRequest(request, adapter);

    if (result.success) {
      return result;
    }

    errors.push(`${adapter.name}: ${result.error}`);
    console.log(`[adapters] Adapter ${adapter.name} failed: ${result.error}`);
  }

  return failResult(`All quote adapters failed: ${errors.join("; ")}`, "none", Date.now());
}

// MARK: - Data Execution

/**
 * Apply path mappings from adapter definition
 */
function applyPathMappings(path: string, adapter: AdapterDefinition): string {
  if (!adapter.pathMappings) return path;

  for (const [pattern, replacement] of Object.entries(adapter.pathMappings)) {
    const patternRegex = pattern
      .replace(/\{(\w+)\}/g, "([^/]+)")
      .replace(/\//g, "\\/");
    const regex = new RegExp(`^${patternRegex}`);

    const match = path.match(regex);
    if (match) {
      let newPath = replacement;
      for (let i = 1; i < match.length; i++) {
        newPath = newPath.replace(`{${i}}`, match[i]);
      }
      return newPath;
    }
  }

  return path;
}

/**
 * Execute a data request using configured data adapter
 */
export async function executeDataRequest<T>(
  request: UnifiedDataRequest
): Promise<AdapterResult<T>> {
  const startTime = Date.now();

  const adapterResult = await getAdaptersForService("data");
  if ("error" in adapterResult) {
    return adapterResult.error;
  }

  const errors: string[] = [];

  for (const adapter of adapterResult.adapters) {
    try {
      if (!adapter.chainIds.includes(request.chainId)) {
        errors.push(`${adapter.name}: does not support chain ${request.chainId}`);
        continue;
      }

      let path = applyPathMappings(request.path, adapter);

      if (request.params) {
        for (const [key, value] of Object.entries(request.params)) {
          path = path.replace(`{${key}}`, value);
        }
      }

      const url = `${adapter.endpoint}${path}`;
      const headers = await buildHeaders(adapter);

      console.log(`[adapters] Fetching data from ${adapter.name}: ${url}`);

      // Fetch with retry for transient errors
      const fetchResult = await withRetry(
        async () => {
          const response = await fetch(url, { method: "GET", headers });

          if (!response.ok) {
            throw new Error(`${adapter.name}: API error (${response.status}): ${await response.text()}`);
          }

          return response.json();
        },
        { operationName: `data-${adapter.name}` }
      );

      if (!fetchResult.success) {
        errors.push(fetchResult.error?.message ?? "Unknown error");
        continue;
      }

      const rawResponse = fetchResult.data;
      const mapped = Object.keys(adapter.response).length > 0
        ? mapResponse<T>(rawResponse, adapter.response)
        : rawResponse as T;

      return {
        success: true,
        data: mapped as T,
        provider: adapter.name,
        latencyMs: Date.now() - startTime,
      };
    } catch (error) {
      errors.push(`${adapter.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return failResult(`All data adapters failed: ${errors.join("; ")}`, "none", startTime);
}

// MARK: - Single Adapter Execution

/**
 * Execute a request using a specific adapter by name
 *
 * @param type - Service type
 * @param name - Adapter name
 * @param request - Request to execute
 * @returns Adapter result
 */
export async function executeWithAdapter<T>(
  type: ServiceType,
  name: string,
  request: UnifiedQuoteRequest | UnifiedDataRequest
): Promise<AdapterResult<T>> {
  const adapter = loadAdapter(type, name);

  if (!adapter) {
    return {
      success: false,
      error: `Adapter not found: ${type}/${name}`,
      provider: name,
      latencyMs: 0,
    };
  }

  if (type === "quote") {
    return executeQuoteRequest(request as UnifiedQuoteRequest, adapter) as Promise<AdapterResult<T>>;
  }

  return executeDataRequest<T>(request as UnifiedDataRequest);
}

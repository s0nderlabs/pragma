// Adapter Types
// Generic adapter system for flexible provider configuration
// No provider-specific code - all config from JSON files
// Copyright (c) 2026 s0nderlabs

import type { Address, Hex } from "viem";

// MARK: - Service Types

/**
 * Service types supported by the adapter system
 * These are generic categories, not specific providers
 */
export type ServiceType = "quote" | "bundler" | "data" | "rpc";

// MARK: - Adapter Definition

/**
 * Authentication configuration for an adapter
 */
export interface AdapterAuth {
  /** Authentication type */
  type: "header" | "query" | "bearer" | "none";
  /** Header name for 'header' type (e.g., "X-API-Key", "0x-api-key") */
  header?: string;
  /** Query parameter name for 'query' type */
  queryParam?: string;
  /** Keychain key name for the API key (user-defined) */
  keyName: string;
}

/**
 * Generic adapter definition
 * All provider configuration comes from these JSON files
 */
export interface AdapterDefinition {
  /** User-defined adapter name (e.g., "my-quote-provider") */
  name: string;
  /** Service type this adapter provides */
  type: ServiceType;
  /** Adapter version for compatibility checking */
  version?: string;
  /** Chain IDs this adapter supports */
  chainIds: number[];
  /** Base endpoint URL */
  endpoint: string;
  /** Authentication configuration */
  auth: AdapterAuth;
  /** Additional static headers */
  headers?: Record<string, string>;
  /** Request parameter mapping: unified param -> provider param */
  request: Record<string, string>;
  /** Response field mapping: unified field -> JSONPath to extract */
  response: Record<string, string>;
  /** Path mappings: standard path pattern -> provider path pattern (for data adapters) */
  pathMappings?: Record<string, string>;
}

// MARK: - Unified Request/Response Types

/**
 * Unified quote request - same format for all quote providers
 */
export interface UnifiedQuoteRequest {
  /** Token address to sell */
  sellToken: Address;
  /** Token address to buy */
  buyToken: Address;
  /** Amount to sell in wei (string for precision) */
  sellAmount: string;
  /** Sender/taker address */
  sender: Address;
  /** Slippage tolerance in basis points */
  slippageBps: number;
  /** Chain ID */
  chainId: number;
}

/**
 * Unified quote response - normalized from any provider
 */
export interface UnifiedQuoteResponse {
  /** Expected output amount in wei */
  buyAmount: string;
  /** Minimum output after slippage */
  minBuyAmount: string;
  /** Router/aggregator contract address */
  router: Address;
  /** Encoded transaction calldata */
  calldata: Hex;
  /** Native token value to send */
  value: string;
  /** Gas estimate */
  gas: string;
  /** Whether liquidity is available */
  liquidityAvailable: boolean;
}

/**
 * Unified data request for token/portfolio data
 */
export interface UnifiedDataRequest {
  /** Request path (e.g., "/token/{address}", "/portfolio/{address}") */
  path: string;
  /** Path parameters to substitute */
  params?: Record<string, string>;
  /** Chain ID */
  chainId: number;
}

// MARK: - Adapter Result

/**
 * Result from an adapter execution
 */
export interface AdapterResult<T> {
  /** Whether the request succeeded */
  success: boolean;
  /** Response data (if successful) */
  data?: T;
  /** Error message (if failed) */
  error?: string;
  /** Which provider was used (adapter name) */
  provider: string;
  /** Request latency in milliseconds */
  latencyMs: number;
}

// MARK: - Config Integration

/**
 * Provider configuration in pragma config
 * Maps service types to ordered arrays of adapter names
 */
export interface ProvidersConfig {
  /** Quote providers (tried in order) */
  quote?: string[];
  /** Bundler providers */
  bundler?: string[];
  /** Data providers */
  data?: string[];
  /** RPC providers (special case - URL stored directly in Keychain) */
  rpc?: string[];
}

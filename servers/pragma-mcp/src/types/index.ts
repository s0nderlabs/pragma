// pragma MCP Types
// TODO: Implement types from H2

import type { Hex, Address } from "viem";

// Config types
// URLs are resolved at runtime based on mode:
// - x402: Constructed from hardcoded constant (getX402BaseUrl())
// - byok: Uses adapter system with user-configured providers
export interface PragmaConfig {
  mode: "byok" | "x402";
  network: {
    chainId: number;
    name: string; // e.g., "monad", "base"
  };
  wallet?: {
    smartAccountAddress: Address;
    sessionKeyAddress: Address;
    keyId: string; // P-256 key ID for HybridDelegator
  };
  // BYOK mode only: maps service types to adapter names
  // Arrays support fallback (try first, fall back to second on failure)
  providers?: {
    quote?: string[];   // Quote provider adapters
    bundler?: string[]; // Bundler provider adapters
    data?: string[];    // Data provider adapters
  };
}

// Wallet types
export interface WalletStatus {
  initialized: boolean;
  smartAccountAddress?: Address;
  sessionKeyAddress?: Address;
  hasPasskey: boolean;
}

// Balance types
export interface TokenBalance {
  token: string;
  symbol: string;
  balance: string;
  balanceWei: bigint;
  decimals: number;
}

// Aggregator types (provider-agnostic)
export type AggregatorName = "pragma" | string;

// Quote types
export interface SwapQuote {
  quoteId: string;
  fromToken: {
    address: Address;
    symbol: string;
    decimals: number;
  };
  toToken: {
    address: Address;
    symbol: string;
    decimals: number;
  };
  amountIn: string;
  amountInWei: bigint;
  expectedOutput: string;
  expectedOutputWei: bigint;
  minOutput: string;           // Min output after slippage (human readable)
  minOutputWei: bigint;        // Min output after slippage (wei)
  priceImpact: number;
  route: string[];
  gasEstimate: bigint;
  expiresAt: number;
  // Aggregator info
  aggregator: AggregatorName;
  aggregatorAddress: Address;  // Router address
}

// Execution types
export interface ExecutionResult {
  txHash: Hex;
  status: "success" | "reverted" | "failed";
  blockNumber?: number;
  gasUsed?: bigint;
}

// Delegation types (stub - will be filled from H2)
export interface DelegationInfo {
  delegator: Address;
  delegate: Address;
  nonce: bigint;
  expiresAt: number;
}

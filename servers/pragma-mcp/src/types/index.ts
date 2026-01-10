// pragma MCP Types
// TODO: Implement types from H2

import type { Hex, Address } from "viem";

// Config types
export interface PragmaConfig {
  mode: "diy" | "convenient";
  network: {
    chainId: number;
    rpc: string;
    name?: string; // e.g., "monad", "base"
  };
  wallet?: {
    smartAccountAddress: Address;
    sessionKeyAddress: Address;
    passkeyPublicKey: Hex; // Uncompressed P-256 public key (0x04...)
    keyId?: string; // P-256 key ID for HybridDelegator
  };
  bundler?: {
    url: string;
    paymasterUrl?: string;
  };
  apis?: {
    monorail?: string;
    hypersync?: string;
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
  priceImpact: number;
  route: string[];
  gasEstimate: bigint;
  expiresAt: number;
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

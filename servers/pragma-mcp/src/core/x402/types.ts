// x402 Types
// Type definitions for x402 micropayment protocol
// Copyright (c) 2026 s0nderlabs

import type { Address, Hex } from "viem";

// MARK: - x402 Protocol Types

/**
 * x402 Payment Requirements (from 402 response)
 * Returned when client needs to pay for API access
 */
export interface X402PaymentRequired {
  x402Version: number;
  resource: {
    url: string;
    description: string;
    mimeType: string;
  };
  accepts: X402PaymentRequirements[];
  error: string;
}

/**
 * Payment requirements for a specific scheme
 * Currently only "exact" scheme is supported (EIP-3009)
 */
export interface X402PaymentRequirements {
  scheme: "exact";
  network: string; // e.g., "eip155:143" for Monad
  amount: string; // USDC base units (6 decimals)
  payTo: Address; // Revenue wallet address
  asset: Address; // USDC contract address
  maxTimeoutSeconds: number;
  extra?: {
    name: string; // Token name for EIP-712 domain (e.g., "USDC")
    version: string; // Token version for EIP-712 domain (e.g., "2")
  };
}

/**
 * EIP-3009 TransferWithAuthorization parameters
 * Used for gasless USDC transfers
 */
export interface EIP3009Authorization {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex; // bytes32
}

/**
 * x402 Payment payload (sent in X-Payment header)
 * Base64 encoded JSON
 */
export interface X402PaymentPayload {
  x402Version: number;
  resource: {
    url: string;
    description: string;
    mimeType: string;
  };
  accepted: X402PaymentRequirements;
  payload: {
    authorization: {
      from: string;
      to: string;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: string;
    };
    signature: Hex;
  };
}

/**
 * x402 Payment response (from X-Payment-Response header)
 */
export interface X402PaymentResponse {
  success: boolean;
  txHash?: Hex;
  error?: string;
}

// MARK: - USDC Balance Types

/**
 * USDC balance check result
 */
export interface SessionKeyUsdcBalance {
  address: Address;
  balance: bigint;
  balanceFormatted: string;
  needsFunding: boolean;
  lowBalanceWarning: boolean; // true if < 0.1 USDC
  recommendedFundingAmount: string; // "1 USDC"
}

/**
 * x402 operation types for cost estimation
 */
export type X402OperationType = "rpc" | "bundler" | "quote" | "data";

/**
 * USDC balance check for operations
 */
export interface UsdcBalanceCheck {
  hasEnough: boolean;
  required: bigint;
  deficit: bigint;
  lowBalanceWarning: boolean;
}

// MARK: - x402 Configuration

/**
 * x402 mode configuration
 */
export interface X402Config {
  apiUrl: string; // e.g., "https://api.pr4gma.xyz"
  enabled: boolean;
  chainId: number; // 143 for Monad
}

/**
 * x402 API URL patterns for auto-detection
 * Includes both production and localhost for development
 */
export const X402_API_PATTERNS = [
  "api.pr4gma.xyz", // Production
  "localhost:8787", // Local development (default wrangler dev port)
] as const;

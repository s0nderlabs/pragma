// pragma Constants
// Chain-agnostic configuration
// Contract addresses resolved dynamically from chains.ts
// Copyright (c) 2026 s0nderlabs

import type { Address } from "viem";
import { getSmartAccountsEnvironment, ROOT_AUTHORITY } from "@metamask/smart-accounts-kit";

// Re-export ROOT_AUTHORITY for delegation building
export { ROOT_AUTHORITY };

// ============================================================================
// DTK Environment
// ============================================================================

/**
 * Chain ID used for DTK environment lookup
 *
 * DTK doesn't have Monad mainnet (143) in its registry yet.
 * We use testnet chain ID (10143) to get the environment because:
 * 1. All DTK contracts are deployed at the SAME CREATE2 addresses on both networks
 * 2. The environment object only contains contract addresses, not chain-specific logic
 */
export const DTK_CHAIN_ID_FOR_ADDRESSES = 10143;

/**
 * Get DTK environment using the workaround chain ID
 * Use this instead of calling getSmartAccountsEnvironment(chainId) directly
 */
export const getDTKEnvironment = () => getSmartAccountsEnvironment(DTK_CHAIN_ID_FOR_ADDRESSES);

// Gas Thresholds (in wei - same across all chains)
export const MIN_SESSION_KEY_BALANCE = BigInt("40000000000000000"); // 0.04 native
export const SESSION_KEY_FUNDING_AMOUNT = BigInt("500000000000000000"); // 0.5 native
export const MIN_GAS_FOR_DELEGATION = BigInt("50000000000000000"); // 0.05 native (delegation tx needs more gas)

// Gas per operation (in wei - estimates, may vary by chain)
export const GAS_PER_OPERATION = {
  swap: BigInt("140000000000000000"), // 0.14 native
  transfer: BigInt("40000000000000000"), // 0.04 native
  wrap: BigInt("40000000000000000"), // 0.04 native
  unwrap: BigInt("40000000000000000"), // 0.04 native
  stake: BigInt("70000000000000000"), // 0.07 native
  unstake: BigInt("75000000000000000"), // 0.075 native
};

// Delegation defaults
export const DEFAULT_DELEGATION_EXPIRY_SECONDS = 300; // 5 minutes

// Native token address (same on all EVM chains)
export const NATIVE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

// Delegation Framework Addresses (CREATE2 - same on all supported chains)
// These are from @metamask/smart-accounts-kit deployment
export const DELEGATION_FRAMEWORK = {
  delegationManager: "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3" as Address,
  enforcers: {
    nonce: "0xDE4f2FAC4B3D87A1d9953Ca5FC09FCa7F366254f" as Address,
    timestamp: "0x1046bb45C8d673d4ea75321280DB34899413c069" as Address,
    limitedCalls: "0x04658B29F6b82ed55274221a06Fc97D318E25416" as Address,
    allowedCalldata: "0xc2b0d624c1c4319760C96503BA27C347F3260f55" as Address,
  },
} as const;

// Binary paths
export const PRAGMA_SIGNER_BINARY = "pragma-signer";

// ============================================================================
// x402 / USDC Configuration
// ============================================================================

/**
 * USDC addresses by chain ID
 * Used for x402 micropayments
 */
export const USDC_ADDRESS: Record<number, Address> = {
  143: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" as Address, // Monad mainnet (checksummed)
};

/**
 * USDC decimals (always 6)
 */
export const USDC_DECIMALS = 6;

/**
 * x402 API URL patterns for auto-detection
 * When a URL matches one of these patterns, x402 payment flow is used
 * For local dev, set X402_API_URL env var - it will be added to detection automatically
 */
export const X402_API_PATTERNS = ["api.pr4gma.xyz"] as const;

/**
 * Minimum USDC balance for x402 operations (in base units)
 */
export const MIN_USDC_BALANCE = 50_000n; // 0.05 USDC

/**
 * Low USDC balance warning threshold (in base units)
 */
export const LOW_USDC_BALANCE_WARNING = 50_000n; // 0.05 USDC

/**
 * Recommended USDC funding amount (in base units)
 */
export const RECOMMENDED_USDC_FUNDING = 1_000_000n; // 1 USDC

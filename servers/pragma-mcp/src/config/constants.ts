// pragma Constants
// Addresses and configuration from H2

import type { Address } from "viem";

// Network
export const MONAD_CHAIN_ID = 10143;
export const MONAD_RPC = "https://rpc.monad.xyz";

// Token Addresses
export const MON_ADDRESS = "0x0000000000000000000000000000000000000000" as Address; // Native
export const WMON_ADDRESS = "0x760AfE86e5de5fa0Ee542fc7B7B713e1c5425701" as Address;

// Protocol Addresses (from H2 - TODO: verify on mainnet)
export const DELEGATION_MANAGER_ADDRESS = "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3" as Address;
export const APRIORI_ADDRESS = "0x0c65a0bc65a5d819235b71f554d210d3f80e0852" as Address;

// Enforcer Addresses (from H2 - TODO: verify on mainnet)
export const NONCE_ENFORCER = "0xDE4f2FAC4B3D87A1d9953Ca5FC09FCa7F366254f" as Address;
export const TIMESTAMP_ENFORCER = "0x1046bb45C8d673d4ea75321280DB34899413c069" as Address;
export const LIMITED_CALLS_ENFORCER = "0x04658B29F6b82ed55274221a06Fc97D318E25416" as Address;
export const ALLOWED_CALLDATA_ENFORCER = "0xc2b0d624c1c4319760C96503BA27C347F3260f55" as Address;

// Gas Thresholds (from H2)
export const MIN_SESSION_KEY_BALANCE = BigInt("40000000000000000"); // 0.04 MON
export const SESSION_KEY_FUNDING_AMOUNT = BigInt("500000000000000000"); // 0.5 MON
export const MIN_GAS_FOR_DELEGATION = BigInt("20000000000000000"); // 0.02 MON

// Gas per operation (in wei)
export const GAS_PER_OPERATION = {
  swap: BigInt("140000000000000000"), // 0.14 MON
  transfer: BigInt("40000000000000000"), // 0.04 MON
  wrap: BigInt("40000000000000000"), // 0.04 MON
  unwrap: BigInt("40000000000000000"), // 0.04 MON
  stake: BigInt("70000000000000000"), // 0.07 MON
  unstake: BigInt("75000000000000000"), // 0.075 MON
};

// Delegation defaults
export const DEFAULT_DELEGATION_EXPIRY_SECONDS = 300; // 5 minutes

// Monorail
export const MONORAIL_API_BASE = "https://api.monorail.xyz";

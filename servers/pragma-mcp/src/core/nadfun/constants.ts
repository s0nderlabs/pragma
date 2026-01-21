// nad.fun Constants
// Contract addresses, ABIs, and configuration for bonding curve trading
// Copyright (c) 2026 s0nderlabs

import type { Address, Hex } from "viem";

// ============================================================================
// Contract Addresses
// ============================================================================

export const NADFUN_CONTRACTS = {
  // Monad Mainnet (Chain 143)
  143: {
    lens: "0x7e78A8DE94f21804F7a17F4E8BF9EC2c872187ea" as Address,
    router: "0x6F6B8F1a20703309951a5127c45B49b1CD981A22" as Address,
  },
} as const;

// ============================================================================
// ABIs (Minimal - only what we need)
// ============================================================================

/**
 * Lens contract ABI for read operations
 * - getAmountOut: Get quote for buy/sell (input → output)
 * - getAmountIn: Reverse quote (output → input)
 * - getProgress: Get graduation progress (0-10000)
 * - isGraduated: Check if token has graduated to DEX
 * - isLocked: Check if token is locked during graduation
 * - availableBuyTokens: Get remaining tokens + required MON to graduate
 */
export const LENS_ABI = [
  {
    name: "getAmountOut",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "token", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "isBuy", type: "bool" },
    ],
    outputs: [
      { name: "router", type: "address" },
      { name: "amountOut", type: "uint256" },
    ],
  },
  {
    name: "getAmountIn",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "token", type: "address" },
      { name: "amountOut", type: "uint256" },
      { name: "isBuy", type: "bool" },
    ],
    outputs: [
      { name: "router", type: "address" },
      { name: "amountIn", type: "uint256" },
    ],
  },
  {
    name: "getProgress",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "isGraduated",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "isLocked",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "availableBuyTokens",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      { name: "", type: "uint256" }, // availableTokens
      { name: "", type: "uint256" }, // requiredMon
    ],
  },
] as const;

/**
 * BondingCurveRouter ABI for buy/sell execution
 *
 * buy() - Payable function, sends MON as msg.value
 * sell() - Non-payable, requires token approval first
 */
export const ROUTER_ABI = [
  {
    name: "buy",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "amountOutMin", type: "uint256" },
          { name: "token", type: "address" },
          { name: "to", type: "address" },
          { name: "deadline", type: "uint256" },
        ],
      },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "sell",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMin", type: "uint256" },
          { name: "token", type: "address" },
          { name: "to", type: "address" },
          { name: "deadline", type: "uint256" },
        ],
      },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// ============================================================================
// Function Selectors
// ============================================================================

/** buy(BuyParams) function selector */
export const NADFUN_BUY_SELECTOR = "0x0f5b0d09" as Hex;

/** sell(SellParams) function selector */
export const NADFUN_SELL_SELECTOR = "0xd4e19b4b" as Hex;

// ============================================================================
// Configuration
// ============================================================================

/** Quote expiry in milliseconds (5 minutes) */
export const NADFUN_QUOTE_EXPIRY_MS = 5 * 60 * 1000;

/** Default transaction deadline in seconds (5 minutes) */
export const DEFAULT_DEADLINE_SECONDS = 300;

/** Default slippage in basis points (5%) */
export const DEFAULT_SLIPPAGE_BPS = 500;

/** Maximum slippage in basis points (50%) */
export const MAX_SLIPPAGE_BPS = 5000;

/** Progress value that indicates full graduation (100%) */
export const GRADUATION_PROGRESS = 10000;

// Monorail Calldata Patcher
// Patches minAmountOut to ensure correct slippage tolerance
// Adapted from pragma-v2-stable (H2)
// Copyright (c) 2026 s0nderlabs

import { decodeFunctionData, encodeFunctionData, type Hex, type Abi } from "viem";

/**
 * Monorail Aggregator ABI (aggregate function only)
 * The actual function being called might be different, so we need to handle both
 */
const MONORAIL_AGGREGATE_ABI = [
  {
    type: "function",
    name: "aggregate",
    inputs: [
      { name: "tokenIn", type: "address", internalType: "address" },
      { name: "tokenOut", type: "address", internalType: "address" },
      { name: "amountIn", type: "uint256", internalType: "uint256" },
      { name: "minAmountOut", type: "uint256", internalType: "uint256" },
      { name: "destination", type: "address", internalType: "address" },
      { name: "deadline", type: "uint256", internalType: "uint256" },
      { name: "referrer", type: "uint64", internalType: "uint64" },
      { name: "quote", type: "uint64", internalType: "uint64" },
      {
        name: "trades",
        type: "tuple[]",
        internalType: "struct MonorailAggregator.Trade[]",
        components: [
          { name: "minAmountOut", type: "uint256", internalType: "uint256" },
          { name: "weight", type: "uint32", internalType: "uint32" },
          { name: "routerType", type: "uint8", internalType: "enum MonorailAggregator.RouterType" },
          { name: "router", type: "address", internalType: "address" },
          { name: "tokenIn", type: "address", internalType: "address" },
          { name: "tokenOut", type: "address", internalType: "address" },
          { name: "params", type: "bytes", internalType: "bytes" },
        ],
      },
    ],
    outputs: [],
    stateMutability: "payable",
  },
] as const satisfies Abi;

export interface PatchResult {
  originalCalldata: Hex;
  patchedCalldata: Hex;
  originalMinOutput: bigint;
  patchedMinOutput: bigint;
  tradesPatched: number;
}

/**
 * Patches Monorail aggregate() calldata to apply correct slippage.
 *
 * The Monorail API returns calldata with a minAmountOut, but we need to
 * recalculate it based on the user's actual slippage tolerance to prevent
 * SlippageExceeded errors.
 *
 * @param originalCalldata - The transaction calldata from Monorail API
 * @param expectedOutput - The expected output amount from quote
 * @param slippageBps - User's desired slippage in basis points (e.g., 500 = 5%)
 * @returns Patch result with patched calldata
 */
export function patchMonorailMinOutput(
  originalCalldata: Hex,
  expectedOutput: bigint,
  slippageBps: number
): PatchResult {
  // Calculate correct minAmountOut based on user's slippage tolerance
  // Formula: minOutput = expectedOutput * (10000 - slippageBps) / 10000
  const correctMinOutput =
    expectedOutput > 0n ? (expectedOutput * BigInt(10_000 - slippageBps)) / 10_000n : 0n;

  let decoded;
  try {
    // Try to decode as aggregate() call
    decoded = decodeFunctionData({
      abi: MONORAIL_AGGREGATE_ABI,
      data: originalCalldata,
    });
  } catch (error) {
    // If decoding fails, the calldata might use a different function
    // Return original calldata unchanged - let the swap proceed and fail naturally
    // if slippage is an issue
    console.warn("[calldataPatcher] Failed to decode Monorail calldata, returning unchanged");
    return {
      originalCalldata,
      patchedCalldata: originalCalldata,
      originalMinOutput: 0n,
      patchedMinOutput: correctMinOutput,
      tradesPatched: 0,
    };
  }

  // Verify this is an aggregate() call
  if (decoded.functionName !== "aggregate") {
    console.warn(`[calldataPatcher] Expected aggregate() call, got ${decoded.functionName}`);
    return {
      originalCalldata,
      patchedCalldata: originalCalldata,
      originalMinOutput: 0n,
      patchedMinOutput: correctMinOutput,
      tradesPatched: 0,
    };
  }

  // Extract arguments (make mutable copy for patching)
  const args = [...decoded.args] as any[];
  const originalMinOutput = args[3] as bigint; // Parameter #4 (index 3)
  const trades = [...(args[8] as any[])] as any[]; // Parameter #9 (index 8)

  // Patch global minAmountOut (parameter #4, index 3)
  args[3] = correctMinOutput;

  // Patch each Trade's minAmountOut (first field in Trade struct)
  const patchedTrades = trades.map((trade) => ({
    ...trade,
    minAmountOut: correctMinOutput,
  }));

  // Update args with patched trades
  args[8] = patchedTrades;

  // Re-encode the calldata with patched values
  const patchedCalldata = encodeFunctionData({
    abi: MONORAIL_AGGREGATE_ABI,
    functionName: "aggregate",
    args: args as any,
  });

  return {
    originalCalldata,
    patchedCalldata,
    originalMinOutput,
    patchedMinOutput: correctMinOutput,
    tradesPatched: trades.length,
  };
}

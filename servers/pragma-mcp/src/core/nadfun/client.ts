// nad.fun Lens Client
// Read operations for bonding curve status and quotes
// Copyright (c) 2026 s0nderlabs

import { createPublicClient, http, getContract, formatUnits, erc20Abi, type Address, type PublicClient } from "viem";
import { buildViemChain } from "../../config/chains.js";
import { loadConfig, getRpcUrl } from "../../config/pragma-config.js";
import { x402HttpOptions } from "../x402/client.js";
import { withRetryOrThrow } from "../utils/retry.js";
import {
  NADFUN_CONTRACTS,
  LENS_ABI,
  GRADUATION_PROGRESS,
} from "./constants.js";
import type { NadFunTokenStatus, TradingVenue } from "./types.js";

// ============================================================================
// Client Factory
// ============================================================================

/**
 * Create a viem public client for nad.fun operations
 * Handles both BYOK and x402 modes transparently
 */
export async function createNadFunClient(): Promise<PublicClient> {
  const config = await loadConfig();
  if (!config) {
    throw new Error("Config not loaded. Run setup_wallet first.");
  }

  const rpcUrl = await getRpcUrl(config);
  const chain = buildViemChain(config.network.chainId, rpcUrl);

  return createPublicClient({
    chain,
    transport: http(rpcUrl, x402HttpOptions(config)),
  });
}

/**
 * Get nad.fun contract addresses for a chain
 */
export function getNadFunContracts(chainId: number) {
  const contracts = NADFUN_CONTRACTS[chainId as keyof typeof NADFUN_CONTRACTS];
  if (!contracts) {
    throw new Error(`nad.fun not supported on chain ${chainId}`);
  }
  return contracts;
}

// ============================================================================
// Status Operations
// ============================================================================

/**
 * Get token status on nad.fun (graduation state, progress, availability)
 *
 * @param token - Token address to check
 * @param chainId - Chain ID (default: 143 for Monad)
 * @returns Token status including graduation state and progress
 */
export async function getTokenStatus(
  token: Address,
  chainId = 143
): Promise<NadFunTokenStatus> {
  const client = await createNadFunClient();
  const contracts = getNadFunContracts(chainId);

  // Create Lens contract instance
  const lens = getContract({
    address: contracts.lens,
    abi: LENS_ABI,
    client,
  });

  // Create ERC20 contract instance for token metadata
  const erc20 = getContract({
    address: token,
    abi: erc20Abi,
    client,
  });

  // Parallel fetch for efficiency (Lens status + ERC20 metadata)
  const [isGraduated, isLocked, progress, tokenSymbol, tokenName] = await withRetryOrThrow(
    async () => Promise.all([
      lens.read.isGraduated([token]),
      lens.read.isLocked([token]),
      lens.read.getProgress([token]),
      erc20.read.symbol().catch(() => undefined),
      erc20.read.name().catch(() => undefined),
    ]),
    { operationName: "nadfun-status" }
  );

  // Determine trading venue
  const tradingVenue: TradingVenue = isGraduated ? "dex" : "bonding_curve";

  // Calculate progress percentage (progress is 0-10000)
  const progressNum = Number(progress);
  const progressPercent = `${(progressNum / 100).toFixed(1)}%`;

  const status: NadFunTokenStatus = {
    token,
    tokenSymbol,
    tokenName,
    isGraduated,
    isLocked,
    progress: progressNum,
    progressPercent,
    tradingVenue,
  };

  // If not graduated, fetch available tokens info
  if (!isGraduated && !isLocked) {
    try {
      const [availableTokensWei, requiredMonWei] = await withRetryOrThrow(
        async () => lens.read.availableBuyTokens([token]),
        { operationName: "nadfun-available" }
      );

      status.availableTokensWei = availableTokensWei;
      status.requiredMonWei = requiredMonWei;
      // Format with 18 decimals (standard ERC20)
      status.availableTokens = formatUnits(availableTokensWei, 18);
      status.requiredMon = formatUnits(requiredMonWei, 18);
    } catch (error) {
      // Non-critical, continue without availability info
      console.log("[nadfun] Could not fetch availability:", error);
    }
  }

  return status;
}

// ============================================================================
// Quote Operations
// ============================================================================

/**
 * Get expected output amount for a buy or sell operation
 *
 * @param token - Token address
 * @param amountIn - Amount to swap (MON for buy, tokens for sell)
 * @param isBuy - true for buying tokens with MON, false for selling tokens
 * @param chainId - Chain ID (default: 143)
 * @returns Router address and expected output amount
 */
export async function getAmountOut(
  token: Address,
  amountIn: bigint,
  isBuy: boolean,
  chainId = 143
): Promise<{ router: Address; amountOut: bigint }> {
  const client = await createNadFunClient();
  const contracts = getNadFunContracts(chainId);

  const lens = getContract({
    address: contracts.lens,
    abi: LENS_ABI,
    client,
  });

  const [router, amountOut] = await withRetryOrThrow(
    async () => lens.read.getAmountOut([token, amountIn, isBuy]),
    { operationName: "nadfun-quote" }
  );

  return { router: router as Address, amountOut };
}

/**
 * Get required input amount to receive a specific output amount (reverse quote)
 *
 * @param token - Token address
 * @param amountOut - Desired output amount (tokens for buy, MON for sell)
 * @param isBuy - true for buying tokens with MON, false for selling tokens
 * @param chainId - Chain ID (default: 143)
 * @returns Router address and required input amount
 */
export async function getAmountIn(
  token: Address,
  amountOut: bigint,
  isBuy: boolean,
  chainId = 143
): Promise<{ router: Address; amountIn: bigint }> {
  const client = await createNadFunClient();
  const contracts = getNadFunContracts(chainId);

  const lens = getContract({
    address: contracts.lens,
    abi: LENS_ABI,
    client,
  });

  const [router, amountIn] = await withRetryOrThrow(
    async () => lens.read.getAmountIn([token, amountOut, isBuy]),
    { operationName: "nadfun-quote-reverse" }
  );

  return { router: router as Address, amountIn };
}

/**
 * Get available tokens for purchase and required MON to graduate
 *
 * @param token - Token address
 * @param chainId - Chain ID (default: 143)
 * @returns Available tokens and required MON amounts
 */
export async function getAvailableBuyTokens(
  token: Address,
  chainId = 143
): Promise<{ availableTokens: bigint; requiredMon: bigint }> {
  const client = await createNadFunClient();
  const contracts = getNadFunContracts(chainId);

  const lens = getContract({
    address: contracts.lens,
    abi: LENS_ABI,
    client,
  });

  const [availableTokens, requiredMon] = await withRetryOrThrow(
    async () => lens.read.availableBuyTokens([token]),
    { operationName: "nadfun-available" }
  );

  return { availableTokens, requiredMon };
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if a token has graduated from nad.fun
 * Convenience function for quick graduation checks
 */
export async function isTokenGraduated(
  token: Address,
  chainId = 143
): Promise<boolean> {
  const status = await getTokenStatus(token, chainId);
  return status.isGraduated;
}

/**
 * Check if a token is near graduation threshold
 * Returns true if progress >= 90%
 */
export function isNearGraduation(progress: number): boolean {
  return progress >= (GRADUATION_PROGRESS * 0.9);
}

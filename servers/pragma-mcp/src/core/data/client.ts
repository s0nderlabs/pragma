// Data Client
// Provider-agnostic data operations (tokens, balances)
// x402 mode: All requests go through api.pr4gma.xyz
// BYOK mode: Uses adapter system for configured providers
// Copyright (c) 2026 s0nderlabs

import type { Address, PublicClient } from "viem";
import { formatUnits, getAddress, formatEther, erc20Abi } from "viem";
import type { TokenInfo } from "../../config/tokens.js";
import { findTokenBySymbol, findTokenByAddress } from "../../config/tokens.js";
import { getApiEndpoint, x402Fetch, isX402Mode } from "../x402/client.js";
import { NATIVE_TOKEN_ADDRESS } from "../../config/constants.js";
import { getChainConfig } from "../../config/chains.js";
import { withRetry } from "../utils/retry.js";

// MARK: - Types

interface TokenApiResponse {
  address?: string;
  symbol?: string;
  name?: string;
  decimals?: string | number;
  categories?: string[];
  logoURI?: string;
  logoUrl?: string;
  logo_uri?: string;
  image_uri?: string;
  usd_per_token?: string;
}

interface PortfolioApiResponse {
  data?: {
    wallet_address?: string;
    current_portfolio_usd_value?: number;
    current_portfolio?: {
      address?: string;
      symbol?: string;
      usd_value?: number;
      quantity?: string;
      decimals?: number;
    }[];
  };
}

// Monorail-style flat array response (common in BYOK mode)
interface MonorailBalanceEntry {
  address?: string;
  symbol?: string;
  balance?: string;
  decimals?: number;
  usd_per_token?: string;
}

export interface BalanceEntry {
  symbol: string;
  address: string;
  balance: string;
  balanceWei: bigint;
  decimals: number;
  usdValue?: number;
  usdPrice?: number;
}

export interface PortfolioResult {
  address: string;
  totalUsdValue: number;
  tokenCount: number;
  balances: BalanceEntry[];
}

// MARK: - Token Resolution

/**
 * Parse decimals from various API response formats
 */
function parseDecimals(value: string | number | undefined): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 77) {
      return parsed;
    }
  }
  return null;
}

/**
 * Determine token kind based on address and symbol
 */
function getTokenKind(address: Address, symbol: string): "native" | "wrappedNative" | "erc20" {
  if (address === NATIVE_TOKEN_ADDRESS) return "native";
  if (symbol.toUpperCase() === "WMON") return "wrappedNative";
  return "erc20";
}

/**
 * Parse token response from data API
 */
function parseTokenResponse(raw: TokenApiResponse): TokenInfo | null {
  if (!raw.address) return null;

  try {
    const address = getAddress(raw.address as Address);
    const decimals = parseDecimals(raw.decimals) ?? 18;
    const symbol = raw.symbol?.trim();
    const name = raw.name?.trim();

    if (!symbol) return null;

    const logoURI = raw.logoURI ?? raw.logoUrl ?? raw.logo_uri ?? raw.image_uri;

    return {
      address,
      symbol,
      name: name || symbol,
      decimals,
      kind: getTokenKind(address, symbol),
      categories: raw.categories || [],
      logoURI: logoURI?.trim(),
    };
  } catch {
    return null;
  }
}

// MARK: - Data Fetching Helpers

/**
 * Fetch data from API (handles both x402 and BYOK modes)
 * Includes retry logic for transient errors
 */
async function fetchData<T>(
  path: string,
  chainId: number
): Promise<T | null> {
  const inX402Mode = await isX402Mode();

  if (!inX402Mode) {
    // BYOK mode: adapter engine handles retry at adapter level
    const { executeDataRequest } = await import("../adapters/engine.js");
    const result = await executeDataRequest<T>({ path, chainId });
    return result.success ? (result.data ?? null) : null;
  }

  // x402 mode: use retry wrapper
  const endpoint = await getApiEndpoint("data", chainId);
  if (!endpoint.url) return null;

  const result = await withRetry(
    async () => {
      const response = await x402Fetch(`${endpoint.url}${path}`, {
        method: "GET",
        headers: { Accept: "application/json" },
      });

      if (!response.ok) {
        throw new Error(`Data API error (${response.status})`);
      }

      return (await response.json()) as T;
    },
    { operationName: `data-${path}` }
  );

  return result.success ? (result.data ?? null) : null;
}

/**
 * Fetch token info from Data API by address
 */
export async function fetchTokenFromData(
  address: Address,
  chainId: number
): Promise<TokenInfo | null> {
  try {
    const data = await fetchData<TokenApiResponse>(`/token/${address}`, chainId);
    return data ? parseTokenResponse(data) : null;
  } catch (error) {
    console.warn(
      "[data] Token fetch error:",
      error instanceof Error ? error.message : "Unknown error"
    );
    return null;
  }
}

/**
 * Find best matching token from search results
 */
function findBestMatch(tokens: TokenApiResponse[], symbol: string): TokenInfo | null {
  if (!tokens || tokens.length === 0) return null;

  const upperSymbol = symbol.toUpperCase();
  const exactMatch = tokens.find((t) => t.symbol?.toUpperCase() === upperSymbol);

  return parseTokenResponse(exactMatch ?? tokens[0]);
}

/**
 * Search for token by symbol via Data API
 */
export async function searchTokenBySymbol(
  symbol: string,
  chainId: number
): Promise<TokenInfo | null> {
  try {
    const tokens = await fetchData<TokenApiResponse[]>(
      `/tokens?find=${encodeURIComponent(symbol)}`,
      chainId
    );
    return findBestMatch(tokens ?? [], symbol);
  } catch {
    return null;
  }
}

/**
 * Resolve token symbol or address to full token info
 *
 * Resolution order (multi-tier fallback):
 * 1. Static verified list by symbol
 * 2. Static verified list by address
 * 3. Data API search by symbol (for symbols not in list)
 * 4. Data API lookup by address
 * 5. On-chain ERC20 lookup (handled externally)
 *
 * @param input - Token symbol (MON, USDC) or address
 * @param chainId - Chain ID
 * @returns TokenInfo or null if not found
 */
export async function resolveToken(
  input: string,
  chainId: number
): Promise<TokenInfo | null> {
  const normalized = input.trim();

  // Tier 1: Check static verified list by symbol (fast, no network)
  const bySymbol = findTokenBySymbol(normalized);
  if (bySymbol) {
    return bySymbol;
  }

  // If input is an address
  if (normalized.startsWith("0x") && normalized.length === 42) {
    // Tier 2: Check static verified list by address
    const byAddress = findTokenByAddress(normalized);
    if (byAddress) {
      return byAddress;
    }

    // Tier 3: Data API lookup by address
    const fromData = await fetchTokenFromData(normalized as Address, chainId);
    if (fromData) {
      return fromData;
    }

    // Return null - caller can try on-chain lookup
    return null;
  }

  // It's a symbol not in verified list
  // Tier 3: Data API search for unverified tokens
  const fromSearch = await searchTokenBySymbol(normalized, chainId);
  if (fromSearch) {
    return fromSearch;
  }

  return null;
}

// MARK: - Balance Fetching

/**
 * Fetch single token balance using RPC
 *
 * @param walletAddress - Address to check
 * @param tokenAddress - Token contract address
 * @param publicClient - Viem public client
 * @returns Balance info
 */
export async function fetchSingleTokenBalance(
  walletAddress: Address,
  tokenAddress: Address,
  publicClient: PublicClient
): Promise<{ balance: string; balanceWei: bigint }> {
  const balance = await publicClient.readContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [walletAddress],
  });

  // Get decimals
  const decimals = await publicClient.readContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: "decimals",
  });

  return {
    balance: formatUnits(balance, decimals),
    balanceWei: balance,
  };
}

/**
 * Create a balance entry with optional USD pricing
 */
async function createBalanceEntry(
  symbol: string,
  address: Address,
  balanceWei: bigint,
  decimals: number,
  chainId: number
): Promise<{ entry: BalanceEntry; usdValue: number }> {
  const balance = formatUnits(balanceWei, decimals);
  let usdPrice: number | undefined;

  try {
    usdPrice = await getTokenPrice(address, chainId);
  } catch {
    // Price fetch failed, continue without
  }

  const balanceNum = parseFloat(balance);
  const usdValue = usdPrice ? balanceNum * usdPrice : undefined;

  return {
    entry: { symbol, address, balance, balanceWei, decimals, usdValue, usdPrice },
    usdValue: usdValue ?? 0,
  };
}

/**
 * Normalize portfolio API response to array format
 */
function normalizePortfolioResponse(
  data: PortfolioApiResponse | MonorailBalanceEntry[] | null
): MonorailBalanceEntry[] {
  if (!data) return [];
  if (Array.isArray(data)) return data;

  const portfolio = data.data?.current_portfolio;
  if (!portfolio) return [];

  return portfolio.map((t) => {
    const quantity = parseFloat(t.quantity ?? "1");
    const usdValue = t.usd_value;
    return {
      address: t.address,
      symbol: t.symbol,
      balance: t.quantity,
      decimals: t.decimals,
      usd_per_token: usdValue && quantity > 0 ? String(usdValue / quantity) : undefined,
    };
  });
}

/**
 * Fetch complete portfolio from Data API + RPC for native MON
 *
 * @param walletAddress - Address to fetch portfolio for
 * @param chainId - Chain ID
 * @param publicClient - Viem public client for native MON balance
 * @returns Portfolio with all token balances
 */
export async function fetchPortfolio(
  walletAddress: Address,
  chainId: number,
  publicClient: PublicClient
): Promise<PortfolioResult> {
  const balances: BalanceEntry[] = [];
  let totalUsdValue = 0;

  // Fetch native MON balance via RPC (more accurate)
  try {
    const nativeBalance = await publicClient.getBalance({ address: walletAddress });
    if (nativeBalance > 0n) {
      const { entry, usdValue } = await createBalanceEntry(
        "MON", NATIVE_TOKEN_ADDRESS, nativeBalance, 18, chainId
      );
      balances.push(entry);
      totalUsdValue += usdValue;
    }
  } catch (error) {
    console.warn("[data] Native balance fetch error:", error instanceof Error ? error.message : "Unknown error");
  }

  // Fetch WMON balance via RPC
  const chainConfig = getChainConfig(chainId);
  const wmonAddress = chainConfig.tokens.wmon;

  if (wmonAddress) {
    try {
      const wmonBalance = await publicClient.readContract({
        address: wmonAddress,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [walletAddress],
      });

      if (wmonBalance > 0n) {
        const { entry, usdValue } = await createBalanceEntry(
          "WMON", wmonAddress, wmonBalance, 18, chainId
        );
        balances.push(entry);
        totalUsdValue += usdValue;
      }
    } catch (error) {
      console.warn("[data] WMON balance fetch error:", error instanceof Error ? error.message : "Unknown error");
    }
  }

  // Fetch ERC20 balances from Data API
  try {
    const portfolioData = await fetchData<PortfolioApiResponse | MonorailBalanceEntry[]>(
      `/portfolio/${walletAddress}`,
      chainId
    );

    const tokens = normalizePortfolioResponse(portfolioData);
    const skipAddresses = new Set([
      NATIVE_TOKEN_ADDRESS.toLowerCase(),
      wmonAddress?.toLowerCase(),
    ].filter(Boolean));

    for (const token of tokens) {
      if (!token.address || !token.symbol || skipAddresses.has(token.address.toLowerCase())) {
        continue;
      }

      const balanceStr = token.balance;
      if (!balanceStr) continue;

      const decimals = token.decimals ?? 18;
      const balanceNum = parseFloat(balanceStr);
      const balanceWei = BigInt(Math.floor(balanceNum * 10 ** decimals));

      // Calculate USD value from usd_per_token (normalized format)
      const usdValue = token.usd_per_token
        ? balanceNum * parseFloat(token.usd_per_token)
        : undefined;

      balances.push({
        symbol: token.symbol,
        address: token.address,
        balance: balanceStr,
        balanceWei,
        decimals,
        usdValue,
      });

      if (usdValue) {
        totalUsdValue += usdValue;
      }
    }
  } catch (error) {
    console.warn(
      "[data] Portfolio fetch error:",
      error instanceof Error ? error.message : "Unknown error"
    );
  }

  return {
    address: walletAddress,
    totalUsdValue,
    tokenCount: balances.length,
    balances,
  };
}

/**
 * Get token price from Data API
 *
 * @param tokenAddress - Token contract address
 * @param chainId - Chain ID
 * @returns USD price or undefined
 */
export async function getTokenPrice(
  tokenAddress: Address,
  chainId: number
): Promise<number | undefined> {
  try {
    const data = await fetchData<{ usd_per_token?: string }>(
      `/token/${tokenAddress}`,
      chainId
    );
    return data?.usd_per_token ? parseFloat(data.usd_per_token) : undefined;
  } catch {
    return undefined;
  }
}

// Monorail Token Lookup
// Fetches token metadata from Monorail Data API
// Symbol resolution and verified token list
// Adapted from pragma-v2-stable (H2)
// Copyright (c) 2026 s0nderlabs

import { type Address, getAddress } from "viem";
import type { TokenInfo } from "../../config/tokens.js";
import { getChainConfig } from "../../config/chains.js";

interface TokenCacheEntry {
  fetchedAt: number;
  tokens: TokenInfo[];
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let tokenCache: TokenCacheEntry | null = null;

interface RawMonorailToken {
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
  mon_per_token?: string;
}

/**
 * Parse raw Monorail API response to TokenInfo
 * Handles various field name formats from different API versions
 */
function parseMonorailToken(raw: RawMonorailToken): TokenInfo | null {
  if (!raw.address) return null;

  try {
    const address = getAddress(raw.address as Address);

    // Parse decimals - handle string or number
    let decimals: number;
    if (typeof raw.decimals === "string") {
      decimals = parseInt(raw.decimals, 10);
    } else if (typeof raw.decimals === "number") {
      decimals = raw.decimals;
    } else {
      // If no decimals provided, return null - don't assume
      return null;
    }

    // Validate decimals is a reasonable value
    if (!Number.isFinite(decimals) || decimals < 0 || decimals > 77) {
      return null;
    }

    const symbol = raw.symbol?.trim() || undefined;
    const name = raw.name?.trim() || undefined;

    // Symbol is required for a valid token
    if (!symbol) {
      return null;
    }

    return {
      address,
      symbol,
      name: name || symbol,
      decimals,
      kind: "erc20",
    };
  } catch {
    return null;
  }
}

/**
 * Fetch single token metadata from Monorail Data API
 * Endpoint: GET {dataApiUrl}/token/{address}
 *
 * @param address - Token contract address
 * @param chainId - Chain ID to get correct API endpoint
 * @returns TokenInfo if found, null otherwise
 */
export async function fetchTokenFromMonorail(
  address: Address,
  chainId: number
): Promise<TokenInfo | null> {
  try {
    const chainConfig = getChainConfig(chainId);
    const dataApiUrl = chainConfig.protocols?.monorailDataApi;

    if (!dataApiUrl) {
      return null;
    }

    const url = `${dataApiUrl}/token/${address}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      // 404 means token not found - this is expected for unknown tokens
      if (response.status === 404) {
        return null;
      }
      // Other errors - log but don't throw
      console.warn(
        `[Monorail] Token lookup failed for ${address}: ${response.status}`
      );
      return null;
    }

    const raw = (await response.json()) as RawMonorailToken;
    return parseMonorailToken(raw);
  } catch (error) {
    // Network or parsing error - don't throw, just return null
    console.warn(
      `[Monorail] Token lookup error for ${address}:`,
      error instanceof Error ? error.message : "Unknown error"
    );
    return null;
  }
}

/**
 * Fetch verified token list from Monorail
 * Endpoint: GET {dataApiUrl}/tokens/category/verified
 */
export async function fetchVerifiedTokens(chainId: number): Promise<TokenInfo[]> {
  // Check cache first
  const now = Date.now();
  if (tokenCache && now - tokenCache.fetchedAt < CACHE_TTL_MS) {
    return tokenCache.tokens;
  }

  try {
    const chainConfig = getChainConfig(chainId);
    const dataApiUrl = chainConfig.protocols?.monorailDataApi;

    if (!dataApiUrl) {
      return [];
    }

    const url = `${dataApiUrl}/tokens/category/verified`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      console.warn(`[Monorail] Token list fetch failed: ${response.status}`);
      return tokenCache?.tokens ?? [];
    }

    const rawTokens = (await response.json()) as RawMonorailToken[];
    const tokens: TokenInfo[] = [];

    for (const raw of rawTokens) {
      const parsed = parseMonorailToken(raw);
      if (parsed) {
        tokens.push(parsed);
      }
    }

    // Update cache
    tokenCache = { fetchedAt: now, tokens };

    return tokens;
  } catch (error) {
    console.warn(
      `[Monorail] Token list error:`,
      error instanceof Error ? error.message : "Unknown error"
    );
    return tokenCache?.tokens ?? [];
  }
}

/**
 * Resolve token symbol to address
 * Checks verified token list first, then falls back to Monorail API search
 *
 * @param symbolOrAddress - Token symbol (e.g., "USDC") or address
 * @param chainId - Chain ID
 * @returns TokenInfo if found, null otherwise
 */
export async function resolveToken(
  symbolOrAddress: string,
  chainId: number
): Promise<TokenInfo | null> {
  const input = symbolOrAddress.trim();
  if (!input) return null;

  // Special case: MON is native token
  if (input.toUpperCase() === "MON") {
    return {
      address: "0x0000000000000000000000000000000000000000" as Address,
      symbol: "MON",
      name: "Monad",
      decimals: 18,
      kind: "native",
    };
  }

  // Special case: WMON is wrapped native
  if (input.toUpperCase() === "WMON") {
    return {
      address: "0x3bd359c1119da7da1d913d1c4d2b7c461115433a" as Address,
      symbol: "WMON",
      name: "Wrapped Monad",
      decimals: 18,
      kind: "wrappedNative",
    };
  }

  // Check if it's an address
  if (input.startsWith("0x") && input.length === 42) {
    try {
      const address = getAddress(input as Address);

      // First check cache
      const cached = tokenCache?.tokens.find(
        (t) => t.address.toLowerCase() === address.toLowerCase()
      );
      if (cached) return cached;

      // Fetch from Monorail
      return await fetchTokenFromMonorail(address, chainId);
    } catch {
      return null;
    }
  }

  // It's a symbol - search in verified tokens
  const tokens = await fetchVerifiedTokens(chainId);
  const symbolUpper = input.toUpperCase();

  const found = tokens.find((t) => t.symbol?.toUpperCase() === symbolUpper);
  return found ?? null;
}

/**
 * Clear token cache
 */
export function clearTokenCache(): void {
  tokenCache = null;
}

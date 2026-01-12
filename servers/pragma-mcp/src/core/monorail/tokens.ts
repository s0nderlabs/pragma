// Monorail Token Lookup
// Fetches token metadata from Monorail Data API
// Symbol resolution and verified token list
// Adapted from pragma-v2-stable (H2)
// Copyright (c) 2026 s0nderlabs

import { type Address, getAddress } from "viem";
import type { TokenInfo } from "../../config/tokens.js";
import { getChainConfig } from "../../config/chains.js";
import {
  getVerifiedTokenBySymbol,
  getVerifiedTokenByAddress,
} from "../../config/verified-tokens.js";

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
 * Search tokens by symbol/name using Monorail /tokens?find= endpoint
 * Used for Tier 3 resolution when token not in verified list
 *
 * @param query - Search query (symbol or partial name, min 2 chars)
 * @param chainId - Chain ID
 * @returns First matching token or null
 */
export async function searchTokenBySymbol(
  query: string,
  chainId: number
): Promise<TokenInfo | null> {
  if (query.length < 2) return null;

  try {
    const chainConfig = getChainConfig(chainId);
    const dataApiUrl = chainConfig.protocols?.monorailDataApi;

    if (!dataApiUrl) {
      return null;
    }

    const url = `${dataApiUrl}/tokens?find=${encodeURIComponent(query)}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      console.warn(`[Monorail] Token search failed: ${response.status}`);
      return null;
    }

    const rawTokens = (await response.json()) as RawMonorailToken[];

    // Return first exact symbol match, or first result if no exact match
    const queryUpper = query.toUpperCase();
    for (const raw of rawTokens) {
      const parsed = parseMonorailToken(raw);
      if (parsed && parsed.symbol?.toUpperCase() === queryUpper) {
        return parsed;
      }
    }

    // No exact match, return first valid result
    for (const raw of rawTokens) {
      const parsed = parseMonorailToken(raw);
      if (parsed) return parsed;
    }

    return null;
  } catch (error) {
    console.warn(
      `[Monorail] Token search error:`,
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
 * Resolution order:
 * 1. Static verified list (22 tokens, fast, no network)
 * 2. Monorail verified tokens cache
 * 3. Monorail /tokens?find= search (for unverified tokens)
 * 4. Monorail /token/{address} fetch (for addresses)
 *
 * @param symbolOrAddress - Token symbol (e.g., "USDC", "LV") or address
 * @param chainId - Chain ID
 * @returns TokenInfo if found, null otherwise
 */
export async function resolveToken(
  symbolOrAddress: string,
  chainId: number
): Promise<TokenInfo | null> {
  const input = symbolOrAddress.trim();
  if (!input) return null;

  // Check if it's an address
  if (input.startsWith("0x") && input.length === 42) {
    try {
      const address = getAddress(input as Address);

      // 1. Check static verified list first
      const fromStatic = getVerifiedTokenByAddress(address);
      if (fromStatic) return fromStatic;

      // 2. Check Monorail cache
      const cached = tokenCache?.tokens.find(
        (t) => t.address.toLowerCase() === address.toLowerCase()
      );
      if (cached) return cached;

      // 3. Fetch from Monorail API
      return await fetchTokenFromMonorail(address, chainId);
    } catch {
      return null;
    }
  }

  // It's a symbol
  // 1. Check static verified list first (fast, no network)
  const fromStatic = getVerifiedTokenBySymbol(input);
  if (fromStatic) return fromStatic;

  // 2. Search in Monorail verified tokens (API with cache)
  const tokens = await fetchVerifiedTokens(chainId);
  const symbolUpper = input.toUpperCase();

  const found = tokens.find((t) => t.symbol?.toUpperCase() === symbolUpper);
  if (found) return found;

  // 3. Fallback: Search Monorail /tokens?find= for unverified tokens
  return await searchTokenBySymbol(input, chainId);
}

/**
 * Clear token cache
 */
export function clearTokenCache(): void {
  tokenCache = null;
}

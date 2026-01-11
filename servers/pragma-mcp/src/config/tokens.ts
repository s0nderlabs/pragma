// Token Registry
// Loads verified tokens from Monorail Data API with minimal fallback
// Based on pragma-v2-stable/packages/core/src/monorail/tokens.ts (H2 pattern)
// Copyright (c) 2026 s0nderlabs

import { type Address, getAddress } from "viem";
import { getChainConfig } from "./chains.js";

// MARK: - Types

export type TokenKind = "native" | "wrappedNative" | "erc20";

export interface TokenInfo {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  kind?: TokenKind;
  categories?: string[];
  logoURI?: string;
}

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
}

interface TokenCacheEntry {
  fetchedAt: number;
  tokens: TokenInfo[];
}

// MARK: - Constants

// Cache TTL: 5 minutes for memory cache
const CACHE_TTL_MS = 5 * 60 * 1000;

// Minimal fallback tokens (only used if Monorail API fails)
// These addresses MUST match the actual Monad mainnet contracts
const FALLBACK_TOKENS: TokenInfo[] = [
  {
    address: "0x0000000000000000000000000000000000000000" as Address,
    symbol: "MON",
    name: "Monad",
    decimals: 18,
    kind: "native",
    categories: ["native", "verified"],
  },
  {
    // WMON address from Monorail verified tokens API
    address: "0x3bd359c1119da7da1d913d1c4d2b7c461115433a" as Address,
    symbol: "WMON",
    name: "Wrapped MON",
    decimals: 18,
    kind: "wrappedNative",
    categories: ["wrapper", "official", "verified"],
  },
];

// MARK: - Cache

let tokenCache: TokenCacheEntry | undefined;

// Maps for fast lookup
let tokensBySymbol: Map<string, TokenInfo> = new Map();
let tokensByAddress: Map<string, TokenInfo> = new Map();

// Initialize with fallback tokens
function initializeFallback(): void {
  tokensBySymbol.clear();
  tokensByAddress.clear();
  for (const token of FALLBACK_TOKENS) {
    tokensBySymbol.set(token.symbol.toLowerCase(), token);
    tokensByAddress.set(token.address.toLowerCase(), token);
  }
}

// Initialize on module load
initializeFallback();

// MARK: - Parsing

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
      decimals = 18; // Default for Monorail verified tokens
    }

    // Validate decimals
    if (!Number.isFinite(decimals) || decimals < 0 || decimals > 77) {
      return null;
    }

    const symbol = raw.symbol?.trim();
    const name = raw.name?.trim();

    if (!symbol) return null;

    const logoURI =
      raw.logoURI ?? raw.logoUrl ?? raw.logo_uri ?? raw.image_uri ?? undefined;

    // Determine token kind
    let kind: TokenKind = "erc20";
    if (address === "0x0000000000000000000000000000000000000000") {
      kind = "native";
    } else if (symbol.toUpperCase() === "WMON") {
      kind = "wrappedNative";
    }

    return {
      address,
      symbol,
      name: name || symbol,
      decimals,
      kind,
      categories: raw.categories || [],
      logoURI: logoURI?.trim(),
    };
  } catch {
    return null;
  }
}

// MARK: - API Loading

/**
 * Load verified tokens from Monorail Data API
 * Endpoint: GET {dataApiUrl}/tokens/category/verified
 */
export async function loadVerifiedTokens(chainId: number): Promise<TokenInfo[]> {
  const now = Date.now();

  // Check memory cache
  if (tokenCache && now - tokenCache.fetchedAt < CACHE_TTL_MS) {
    return tokenCache.tokens;
  }

  try {
    const chainConfig = getChainConfig(chainId);
    const dataApiUrl = chainConfig.protocols?.monorailDataApi;

    if (!dataApiUrl) {
      console.warn("[tokens] No Monorail Data API URL configured");
      return FALLBACK_TOKENS;
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
      console.warn(`[tokens] Monorail API error: ${response.status}`);
      return FALLBACK_TOKENS;
    }

    const rawTokens = (await response.json()) as RawMonorailToken[];
    const tokens: TokenInfo[] = [];

    // Always include native MON
    tokens.push(FALLBACK_TOKENS[0]);

    for (const raw of rawTokens) {
      const parsed = parseMonorailToken(raw);
      if (parsed && parsed.address !== "0x0000000000000000000000000000000000000000") {
        tokens.push(parsed);
      }
    }

    // Update cache
    tokenCache = { fetchedAt: now, tokens };

    // Update lookup maps
    tokensBySymbol.clear();
    tokensByAddress.clear();
    for (const token of tokens) {
      tokensBySymbol.set(token.symbol.toLowerCase(), token);
      tokensByAddress.set(token.address.toLowerCase(), token);
    }

    console.log(`[tokens] Loaded ${tokens.length} verified tokens from Monorail`);
    return tokens;
  } catch (error) {
    console.warn(
      "[tokens] Failed to load from Monorail:",
      error instanceof Error ? error.message : "Unknown error"
    );
    return FALLBACK_TOKENS;
  }
}

// MARK: - Lookup Functions

/**
 * Find token by symbol (case-insensitive)
 * Uses cached tokens from last loadVerifiedTokens() call
 */
export function findTokenBySymbol(symbol: string): TokenInfo | undefined {
  return tokensBySymbol.get(symbol.toLowerCase());
}

/**
 * Find token by address
 * Uses cached tokens from last loadVerifiedTokens() call
 */
export function findTokenByAddress(address: string): TokenInfo | undefined {
  return tokensByAddress.get(address.toLowerCase());
}

/**
 * Get all cached tokens
 */
export function getAllTokens(): TokenInfo[] {
  return tokenCache?.tokens || FALLBACK_TOKENS;
}

/**
 * Check if tokens are loaded
 */
export function isTokenCacheLoaded(): boolean {
  return tokenCache !== undefined;
}

/**
 * Force refresh token cache
 */
export async function refreshTokenCache(chainId: number): Promise<void> {
  tokenCache = undefined;
  await loadVerifiedTokens(chainId);
}

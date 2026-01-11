// Monorail Balances API Client
// Fetches token balances and portfolio data from Monorail Data API
// Adapted from pragma-v2-stable (H2)
// Copyright (c) 2026 s0nderlabs

import {
  type Address,
  type PublicClient,
  getAddress,
  formatUnits,
  erc20Abi,
  createPublicClient,
  http,
} from "viem";
import { buildViemChain } from "../../config/chains.js";

/**
 * Raw token balance from Monorail API
 */
export interface RawTokenBalance {
  address: string;
  symbol?: string;
  name?: string;
  decimals: number;
  balance: string; // Wei string
  mon_value?: string;
  usd_per_token?: string;
  usd_value?: string;
  categories?: string[];
  pconf?: string; // Price confidence
  image_uri?: string; // Token logo
}

/**
 * Normalized token balance
 */
export interface TokenBalance {
  address: Address;
  symbol: string;
  name?: string;
  decimals: number;
  balance: string; // Formatted human-readable
  balanceWei: string; // Raw wei string
  usdPrice?: number;
  usdValue?: number;
  monValue?: string;
  categories?: string[];
  priceConfidence?: string;
  logoURI?: string;
}

/**
 * Portfolio summary
 */
export interface PortfolioSummary {
  totalUsdValue: number;
  tokenCount: number;
  balances: TokenBalance[];
}

/**
 * Monorail API configuration
 */
export interface MonorailBalancesConfig {
  dataApiUrl: string;
  chainId: number;
}

const NATIVE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
const WMON_ADDRESS = "0x3bd359c1119da7da1d913d1c4d2b7c461115433a" as Address;

const HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "Accept": "application/json",
};

/**
 * Fetch all token balances from Monorail Data API
 */
export async function fetchWalletBalances(
  address: Address,
  config: MonorailBalancesConfig
): Promise<RawTokenBalance[]> {
  const checksummedAddress = getAddress(address);
  const url = `${config.dataApiUrl}/wallet/${checksummedAddress}/balances`;

  const response = await fetch(url, { headers: HEADERS });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(`Monorail balance API failed (${response.status}): ${errorText}`);
  }

  return (await response.json()) as RawTokenBalance[];
}

/**
 * Normalize raw token balance from API
 */
export function normalizeTokenBalance(raw: RawTokenBalance): TokenBalance {
  const address = getAddress(raw.address as Address);
  const decimals = raw.decimals ?? 18;

  // Parse balance (handle both wei string and formatted)
  let balanceWei = raw.balance ?? "0";
  let balance: string;

  try {
    // Try as BigInt (wei string)
    const balanceBigInt = BigInt(balanceWei);
    balance = formatUnits(balanceBigInt, decimals);
  } catch {
    // Already formatted, use as-is
    balance = balanceWei;
    balanceWei = "0"; // Can't convert back
  }

  // Calculate USD value
  const usdPrice = raw.usd_per_token ? parseFloat(raw.usd_per_token) : undefined;
  const balanceNum = parseFloat(balance);
  const usdValue = usdPrice && balanceNum > 0 ? balanceNum * usdPrice : undefined;

  return {
    address,
    symbol: raw.symbol ?? "UNKNOWN",
    name: raw.name,
    decimals,
    balance,
    balanceWei,
    usdPrice,
    usdValue,
    monValue: raw.mon_value,
    categories: raw.categories ?? [],
    priceConfidence: raw.pconf,
    logoURI: raw.image_uri,
  };
}

/**
 * Normalize array of balances
 */
export function normalizeBalances(raw: RawTokenBalance[]): TokenBalance[] {
  return raw.map(normalizeTokenBalance);
}

/**
 * Fetch portfolio with RPC for native token
 *
 * IMPORTANT: Monorail API does NOT return native MON balance!
 * Native MON must ALWAYS be fetched via RPC (publicClient.getBalance)
 *
 * Flow:
 * 1. Fetch ERC20 balances from Monorail API (with USD prices)
 * 2. Fetch native MON via RPC (required - not in Monorail)
 * 3. Fetch WMON via RPC if missing from Monorail
 */
export async function fetchPortfolio(
  address: Address,
  config: MonorailBalancesConfig,
  publicClient?: PublicClient
): Promise<PortfolioSummary> {
  // Step 1: Fetch ERC20 balances from Monorail API
  // Note: This does NOT include native MON!
  const rawBalances = await fetchWalletBalances(address, config);
  const balances = normalizeBalances(rawBalances);

  // Step 2: Fetch native MON via RPC (REQUIRED - Monorail doesn't return native balance)
  if (publicClient) {
    try {
      const rpcMonBalance = await publicClient.getBalance({ address });

      // Remove any existing MON entry from Monorail (shouldn't exist but be safe)
      const monIndex = balances.findIndex(
        (b) => b.symbol === "MON" || b.address.toLowerCase() === NATIVE_TOKEN_ADDRESS.toLowerCase()
      );

      if (monIndex !== -1) {
        balances.splice(monIndex, 1);
      }

      // Always add fresh MON balance from RPC
      if (rpcMonBalance > 0n) {
        // Try to get MON price from Monorail for USD calculation
        let monUsdPrice: number | undefined;
        try {
          const priceUrl = `${config.dataApiUrl}/token/${NATIVE_TOKEN_ADDRESS}`;
          const priceResp = await fetch(priceUrl);
          if (priceResp.ok) {
            const priceData = (await priceResp.json()) as { usd_per_token?: string };
            monUsdPrice = priceData.usd_per_token ? parseFloat(priceData.usd_per_token) : undefined;
          }
        } catch {
          // Price fetch failed, continue without
        }

        const monBalance = formatUnits(rpcMonBalance, 18);
        const monBalanceNum = parseFloat(monBalance);

        balances.unshift({
          address: NATIVE_TOKEN_ADDRESS,
          symbol: "MON",
          name: "Monad",
          decimals: 18,
          balance: monBalance,
          balanceWei: rpcMonBalance.toString(),
          usdPrice: monUsdPrice,
          usdValue: monUsdPrice ? monBalanceNum * monUsdPrice : undefined,
          categories: ["native", "verified"],
        });
      }
    } catch {
      // RPC failed, continue with Monorail data
    }

    // Step 3: Always use RPC for WMON (Monorail data is stale)
    try {
      const rpcWmonBalance = await publicClient.readContract({
        address: WMON_ADDRESS,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [address],
      });

      // Remove any existing WMON entry from Monorail (stale data)
      const wmonIndex = balances.findIndex(
        (b) => b.symbol === "WMON" || b.address.toLowerCase() === WMON_ADDRESS.toLowerCase()
      );

      if (wmonIndex !== -1) {
        balances.splice(wmonIndex, 1);
      }

      // Add fresh WMON balance from RPC
      if (rpcWmonBalance > 0n) {
        balances.push({
          address: WMON_ADDRESS,
          symbol: "WMON",
          name: "Wrapped Monad",
          decimals: 18,
          balance: formatUnits(rpcWmonBalance, 18),
          balanceWei: rpcWmonBalance.toString(),
          categories: ["wrapped", "verified"],
        });
      }
    } catch {
      // WMON fetch failed, keep Monorail data if any
    }
  }

  // Step 4: Filter zero balances and calculate totals
  const nonZeroBalances = balances.filter((b) => {
    const balance = parseFloat(b.balance);
    return balance > 0.000001; // Filter dust
  });

  const totalUsdValue = nonZeroBalances.reduce((sum, b) => sum + (b.usdValue ?? 0), 0);

  // Sort by USD value (highest first), then by balance
  nonZeroBalances.sort((a, b) => {
    if (a.usdValue && b.usdValue) return b.usdValue - a.usdValue;
    if (a.usdValue) return -1;
    if (b.usdValue) return 1;
    return parseFloat(b.balance) - parseFloat(a.balance);
  });

  return {
    totalUsdValue,
    tokenCount: nonZeroBalances.length,
    balances: nonZeroBalances,
  };
}

/**
 * Fetch balance for single token using RPC
 * Used for accurate balance when Monorail data is stale
 */
export async function fetchSingleTokenBalance(
  address: Address,
  tokenAddress: Address,
  publicClient: PublicClient
): Promise<{ balance: string; balanceWei: bigint }> {
  const isNative = tokenAddress.toLowerCase() === NATIVE_TOKEN_ADDRESS.toLowerCase();

  if (isNative) {
    const balance = await publicClient.getBalance({ address });
    return {
      balance: formatUnits(balance, 18),
      balanceWei: balance,
    };
  }

  const balance = await publicClient.readContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  });

  // Get decimals
  let decimals = 18;
  try {
    decimals = await publicClient.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: "decimals",
    });
  } catch {
    // Use default 18
  }

  return {
    balance: formatUnits(balance, decimals),
    balanceWei: balance,
  };
}

/**
 * Create public client for RPC calls
 */
export function createBalancePublicClient(
  chainId: number,
  rpcUrl: string
): PublicClient {
  const chain = buildViemChain(chainId, rpcUrl);
  return createPublicClient({
    chain,
    transport: http(rpcUrl),
  }) as PublicClient;
}

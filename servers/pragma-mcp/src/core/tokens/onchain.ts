// On-chain Token Lookup
// Fetches ERC20 token info from blockchain
// Copyright (c) 2026 s0nderlabs

import { createPublicClient, http, type Address, erc20Abi } from "viem";
import type { TokenInfo } from "../../config/tokens.js";
import { loadConfig, getRpcUrl } from "../../config/pragma-config.js";
import { buildViemChain } from "../../config/chains.js";
import { x402HttpOptions } from "../x402/client.js";

/**
 * Fetch token info from blockchain for unknown addresses
 * Used as fallback when token is not in hardcoded list
 */
export async function fetchTokenFromChain(
  address: Address,
  chainId: number
): Promise<TokenInfo | null> {
  try {
    // Get RPC URL (mode-aware: skips Keychain in x402 mode)
    const config = await loadConfig();
    if (!config) {
      return null;
    }
    const rpcUrl = await getRpcUrl(config);

    // Create viem client
    const chain = buildViemChain(chainId, rpcUrl);
    const client = createPublicClient({ chain, transport: http(rpcUrl, x402HttpOptions(config)) });

    // Fetch name, symbol, decimals in parallel
    const [name, symbol, decimals] = await Promise.all([
      client.readContract({
        address,
        abi: erc20Abi,
        functionName: "name",
      }),
      client.readContract({
        address,
        abi: erc20Abi,
        functionName: "symbol",
      }),
      client.readContract({
        address,
        abi: erc20Abi,
        functionName: "decimals",
      }),
    ]);

    return {
      address,
      name: name as string,
      symbol: symbol as string,
      decimals: decimals as number,
      kind: "erc20",
    };
  } catch {
    // Not a valid ERC20 or RPC error
    return null;
  }
}

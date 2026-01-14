// Chain Registry
// Chain agnostic configuration - no hardcoded chain IDs in business logic
// Copyright (c) 2026 s0nderlabs

import { type Chain, defineChain } from "viem";
import type { Address } from "viem";

/**
 * Chain configuration interface
 * Extensible for multi-chain support
 */
export interface ChainConfig {
  chainId: number;
  name: string;
  displayName: string;
  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: number;
  };
  blockExplorer?: string;
  // Token addresses (chain-specific)
  tokens: {
    wmon?: Address; // Wrapped native token
    weth?: Address; // Wrapped ETH (bridged)
  };
  // DEX aggregator addresses (populated by api.pr4gma.xyz responses)
  aggregators?: {
    router?: Address; // Swap router address
  };
}

/**
 * Supported chains registry
 * Add new chains here to support them
 */
export const SUPPORTED_CHAINS: Record<number, ChainConfig> = {
  // Monad Testnet
  10143: {
    chainId: 10143,
    name: "monad-testnet",
    displayName: "Monad Testnet",
    nativeCurrency: {
      name: "Monad",
      symbol: "MON",
      decimals: 18,
    },
    blockExplorer: "https://testnet.monadexplorer.com",
    tokens: {
      wmon: "0x3bd359c1119da7da1d913d1c4d2b7c461115433a" as Address,
      weth: "0xee8c0e9f1bffb4eb878d8f15f368a02a35481242" as Address,
    },
    aggregators: {
      router: "0x0000000000001fF3684f28c67538d4D072C22734" as Address,
    },
  },
  // Monad Mainnet
  143: {
    chainId: 143,
    name: "monad",
    displayName: "Monad",
    nativeCurrency: {
      name: "Monad",
      symbol: "MON",
      decimals: 18,
    },
    blockExplorer: "https://monadvision.com",
    tokens: {
      wmon: "0x3bd359c1119da7da1d913d1c4d2b7c461115433a" as Address,
      weth: "0xee8c0e9f1bffb4eb878d8f15f368a02a35481242" as Address,
    },
    aggregators: {
      router: "0x0000000000001fF3684f28c67538d4D072C22734" as Address,
    },
  },
  // Future chains can be added here:
  // 8453: { chainId: 8453, name: "base", ... },
  // 42161: { chainId: 42161, name: "arbitrum", ... },
};

/**
 * Get chain configuration by chain ID
 * @throws Error if chain is not supported
 */
export function getChainConfig(chainId: number): ChainConfig {
  const config = SUPPORTED_CHAINS[chainId];
  if (!config) {
    const supportedIds = Object.keys(SUPPORTED_CHAINS).join(", ");
    throw new Error(
      `Chain ${chainId} not supported. Supported chains: ${supportedIds}`
    );
  }
  return config;
}

/**
 * Check if a chain is supported
 */
export function isChainSupported(chainId: number): boolean {
  return chainId in SUPPORTED_CHAINS;
}

/**
 * Get all supported chain IDs
 */
export function getSupportedChainIds(): number[] {
  return Object.keys(SUPPORTED_CHAINS).map(Number);
}

/**
 * Build a viem Chain object from chain ID and RPC URL
 * Used for dynamic chain configuration
 */
export function buildViemChain(chainId: number, rpcUrl: string): Chain {
  const config = getChainConfig(chainId);

  return defineChain({
    id: chainId,
    name: config.displayName,
    nativeCurrency: config.nativeCurrency,
    rpcUrls: {
      default: {
        http: [rpcUrl],
      },
    },
    blockExplorers: config.blockExplorer
      ? {
          default: {
            name: "Explorer",
            url: config.blockExplorer,
          },
        }
      : undefined,
  });
}

/**
 * Get wrapped native token address for a chain
 */
export function getWrappedNativeToken(chainId: number): Address | undefined {
  const config = getChainConfig(chainId);
  return config.tokens.weth;
}

/**
 * Get native currency symbol for a chain
 */
export function getNativeCurrencySymbol(chainId: number): string {
  const config = getChainConfig(chainId);
  return config.nativeCurrency.symbol;
}

/**
 * Validate RPC endpoint for a chain
 * @param rpcUrl - RPC endpoint URL
 * @param expectedChainId - Expected chain ID (0 to skip validation and just detect)
 * @returns Validation result with actual chain ID
 */
export async function validateRpcEndpoint(
  rpcUrl: string,
  expectedChainId: number
): Promise<{ valid: boolean; actualChainId?: number; error?: string }> {
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_chainId",
        params: [],
        id: 1,
      }),
    });

    if (!response.ok) {
      return { valid: false, error: `HTTP ${response.status}` };
    }

    const data = (await response.json()) as {
      result?: string;
      error?: { message: string };
    };

    if (data.error) {
      return { valid: false, error: data.error.message };
    }

    const actualChainId = parseInt(data.result || "0", 16);

    // If expectedChainId is 0, skip validation (just detect chain)
    if (expectedChainId !== 0 && actualChainId !== expectedChainId) {
      return {
        valid: false,
        actualChainId,
        error: `Chain ID mismatch: expected ${expectedChainId}, got ${actualChainId}`,
      };
    }

    return { valid: true, actualChainId };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return { valid: false, error: `Connection failed: ${message}` };
  }
}

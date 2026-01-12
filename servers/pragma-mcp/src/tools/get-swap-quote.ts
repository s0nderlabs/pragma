// Get Swap Quote Tool
// Fetches swap quote from 0x (primary) with Monorail fallback
// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createPublicClient, http, parseUnits, type Address } from "viem";
import { loadConfig, isWalletConfigured } from "../config/pragma-config.js";
import { getChainConfig, buildViemChain } from "../config/chains.js";
import { getProvider } from "../core/signer/index.js";
import { getQuote } from "../core/aggregator/index.js";
import {
  findTokenBySymbol,
  findTokenByAddress,
  loadVerifiedTokens,
  type TokenInfo,
} from "../config/tokens.js";
import { fetchTokenFromMonorail, searchTokenBySymbol } from "../core/monorail/tokens.js";
import { fetchTokenFromChain } from "../core/tokens/onchain.js";

// Slippage constants
const DEFAULT_SLIPPAGE_BPS = 500; // 5% default
const MAX_SLIPPAGE_BPS = 5000; // 50% max allowed

const GetSwapQuoteSchema = z.object({
  fromToken: z
    .string()
    .describe("Token to sell (symbol like 'MON' or 'WMON', or address)"),
  toToken: z
    .string()
    .describe("Token to buy (symbol like 'USDC' or address)"),
  amount: z
    .string()
    .describe("Amount to swap in human-readable format (e.g., '1.5' for 1.5 tokens)"),
  slippageBps: z
    .number()
    .optional()
    .describe("Slippage tolerance in basis points (100 = 1%, default 500 = 5%, max 5000 = 50%). IMPORTANT: For 0x aggregator, slippage is baked into the quote at this stage."),
});

interface QuoteResult {
  success: boolean;
  message: string;
  quote?: {
    quoteId: string;
    fromToken: string;
    toToken: string;
    amountIn: string;
    expectedOutput: string;
    minOutput: string;
    slippage: string;
    slippageBps: number;
    priceImpact: string;
    route: string[];
    expiresIn: string;
    gasEstimate: string;
    aggregator: string;
    tokenVerification: {
      fromToken: {
        verified: boolean;
        status: string;
      };
      toToken: {
        verified: boolean;
        status: string;
      };
    };
  };
  warning?: string;
  error?: string;
}

// MARK: - Token Resolution

const NATIVE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

/**
 * Resolve token symbol or address to full token info
 * Uses multi-tier fallback (matching H2 pattern):
 * 1. Check static verified list by symbol
 * 2. Check static verified list by address
 * 3. Monorail /tokens?find= search (for symbols not in list)
 * 4. Monorail Data API /token/{address}
 * 5. On-chain ERC20 lookup for unknown addresses
 *
 * NO hardcoded decimals fallback - if we can't resolve decimals, we fail
 */
async function resolveToken(
  input: string,
  chainId: number
): Promise<TokenInfo | null> {
  const normalized = input.trim();

  // Tier 1: Check static verified list by symbol (case-insensitive)
  const bySymbol = findTokenBySymbol(normalized);
  if (bySymbol) {
    return bySymbol;
  }

  // If input is an address, try address-based lookups
  if (normalized.startsWith("0x") && normalized.length === 42) {
    // Tier 2: Check static verified list by address
    const byAddress = findTokenByAddress(normalized);
    if (byAddress) {
      return byAddress;
    }

    // Tier 3: Monorail Data API lookup by address
    const fromMonorail = await fetchTokenFromMonorail(normalized as Address, chainId);
    if (fromMonorail) {
      return fromMonorail;
    }

    // Tier 4: On-chain ERC20 lookup
    const fromChain = await fetchTokenFromChain(normalized as Address, chainId);
    if (fromChain) {
      return fromChain;
    }

    // No fallback with hardcoded decimals - we need accurate decimals for swaps
    return null;
  }

  // It's a symbol not in verified list - search Monorail
  // Tier 3: Monorail /tokens?find= search for unverified tokens
  const fromSearch = await searchTokenBySymbol(normalized, chainId);
  if (fromSearch) {
    return fromSearch;
  }

  // Token not found
  return null;
}

export function registerGetSwapQuote(server: McpServer): void {
  server.tool(
    "get_swap_quote",
    "Get a swap quote from DEX aggregator (0x primary, Monorail fallback). Returns expected output, price impact, and route. Quote is valid for ~5 minutes. Always show the quote to the user before executing.",
    GetSwapQuoteSchema.shape,
    async (params): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await getSwapQuote(params as z.infer<typeof GetSwapQuoteSchema>);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );
}

/**
 * Get swap quote from aggregator (0x primary, Monorail fallback)
 */
async function getSwapQuote(params: z.infer<typeof GetSwapQuoteSchema>): Promise<QuoteResult> {
  try {
    // Step 1: Load config and verify wallet is set up
    const config = await loadConfig();
    if (!config || !isWalletConfigured(config)) {
      return {
        success: false,
        message: "Wallet not configured",
        error: "Please run setup_wallet first to create your pragma wallet",
      };
    }

    const walletAddress = config.wallet!.smartAccountAddress as Address;
    const chainId = config.network.chainId;

    // Step 2: Load verified tokens from Monorail (populates cache)
    await loadVerifiedTokens(chainId);

    // Step 3: Resolve tokens
    const fromToken = await resolveToken(params.fromToken, chainId);
    if (!fromToken) {
      return {
        success: false,
        message: "Unknown from token",
        error: `Could not resolve token: ${params.fromToken}. Use symbol (MON, WMON) or address.`,
      };
    }

    const toToken = await resolveToken(params.toToken, chainId);
    if (!toToken) {
      return {
        success: false,
        message: "Unknown to token",
        error: `Could not resolve token: ${params.toToken}. Use symbol (MON, WMON) or address.`,
      };
    }

    // Step 3: Parse amount
    let amountWei: bigint;
    try {
      amountWei = parseUnits(params.amount, fromToken.decimals);
    } catch {
      return {
        success: false,
        message: "Invalid amount",
        error: `Could not parse amount: ${params.amount}. Use format like "1.5" or "100".`,
      };
    }

    // Step 4: Validate and normalize slippage
    let slippageBps = params.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
    if (slippageBps > MAX_SLIPPAGE_BPS) {
      slippageBps = MAX_SLIPPAGE_BPS;
    }
    if (slippageBps < 0) {
      slippageBps = DEFAULT_SLIPPAGE_BPS;
    }

    // Step 5: Check balance (optional but helpful)
    let warning: string | undefined;
    try {
      const rpcUrl = (await getProvider("rpc")) || config.network.rpc;
      const chain = buildViemChain(chainId, rpcUrl);
      const client = createPublicClient({ chain, transport: http(rpcUrl) });

      const balance = await client.getBalance({ address: walletAddress });

      if (fromToken.address === NATIVE_TOKEN_ADDRESS && balance < amountWei) {
        warning = `Insufficient balance: you have ${(Number(balance) / 1e18).toFixed(4)} ${fromToken.symbol} but want to swap ${params.amount} ${fromToken.symbol}`;
      }
    } catch {
      // Balance check is optional, continue
    }

    // Step 6: Get quote from aggregator (0x primary, Monorail fallback)
    // IMPORTANT: For 0x, slippage is baked into the quote calldata here
    const quoteResult = await getQuote({
      fromToken: fromToken.address,
      toToken: toToken.address,
      amount: amountWei,
      sender: walletAddress,
      slippageBps, // User-specified or default 5%
      fromDecimals: fromToken.decimals,
      toDecimals: toToken.decimals,
      fromSymbol: fromToken.symbol,
      toSymbol: toToken.symbol,
    });

    const quote = quoteResult.quote;

    // Step 7: Check token verification status (based on categories from Monorail)
    const fromTokenVerified = fromToken.categories?.includes("verified") ?? false;
    const toTokenVerified = toToken.categories?.includes("verified") ?? false;

    // Add warnings for unverified tokens
    const warnings: string[] = [];
    if (warning) {
      warnings.push(warning);
    }

    if (!fromTokenVerified) {
      warnings.push(
        `Warning: ${fromToken.symbol} (${fromToken.address.slice(0, 6)}...${fromToken.address.slice(-4)}) ` +
        `is not a verified token. Please verify the contract address before swapping.`
      );
    }
    if (!toTokenVerified) {
      warnings.push(
        `Warning: ${toToken.symbol} (${toToken.address.slice(0, 6)}...${toToken.address.slice(-4)}) ` +
        `is not a verified token. Please verify the contract address before swapping.`
      );
    }

    // Add fallback warning if used
    if (quoteResult.fallbackUsed) {
      warnings.push(
        `Note: Using Monorail (fallback) - ${quoteResult.fallbackReason || "0x unavailable"}`
      );
    }

    // Step 8: Format response
    const expiresIn = Math.max(0, Math.floor((quote.expiresAt - Date.now()) / 1000));

    return {
      success: true,
      message: `Quote for ${params.amount} ${fromToken.symbol} → ${toToken.symbol}`,
      quote: {
        quoteId: quote.quoteId,
        fromToken: `${fromToken.symbol} (${fromToken.address.slice(0, 10)}...)`,
        toToken: `${toToken.symbol} (${toToken.address.slice(0, 10)}...)`,
        amountIn: `${quote.amountIn} ${fromToken.symbol}`,
        expectedOutput: `${quote.expectedOutput} ${toToken.symbol}`,
        minOutput: `${quote.minOutput} ${toToken.symbol}`,
        slippage: `${(slippageBps / 100).toFixed(1)}%`,
        slippageBps,
        priceImpact: `${quote.priceImpact.toFixed(2)}%`,
        route: quote.route,
        expiresIn: `${expiresIn} seconds`,
        gasEstimate: `${quote.gasEstimate.toString()} gas`,
        aggregator: quote.aggregator,
        tokenVerification: {
          fromToken: {
            verified: fromTokenVerified,
            status: fromTokenVerified ? "verified" : "unverified",
          },
          toToken: {
            verified: toTokenVerified,
            status: toTokenVerified ? "verified" : "unverified",
          },
        },
      },
      warning: warnings.length > 0 ? warnings.join(" | ") : undefined,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    // Handle specific Monorail errors
    if (errorMessage.includes("Monorail API error")) {
      return {
        success: false,
        message: "Monorail API error",
        error: errorMessage,
      };
    }

    return {
      success: false,
      message: "Failed to get quote",
      error: errorMessage,
    };
  }
}

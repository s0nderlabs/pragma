// Get Swap Quote Tool
// Fetches swap quote from aggregator
// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createPublicClient, http, parseUnits, type Address, type PublicClient } from "viem";
import { x402HttpOptions, isX402Mode } from "../core/x402/client.js";
import { loadConfig, isWalletConfigured, getRpcUrl } from "../config/pragma-config.js";
import { buildViemChain } from "../config/chains.js";
import { getQuote } from "../core/aggregator/index.js";
import { loadVerifiedTokens, type TokenInfo } from "../config/tokens.js";
import { resolveToken as resolveTokenFromData } from "../core/data/client.js";
import { fetchTokenFromChain } from "../core/tokens/onchain.js";
import {
  getUsdcBalance,
  formatUsdcBalance,
  LOW_BALANCE_WARNING,
  isUsdcConfigured,
  getMinRequiredForOperation,
} from "../core/x402/usdc.js";
import type { PragmaConfig } from "../types/index.js";

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
    .describe("Slippage tolerance in basis points (100 = 1%, default 500 = 5%, max 5000 = 50%). Note: Some aggregators bake slippage into the quote at this stage."),
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

// MARK: - Helpers

const NATIVE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

/**
 * Resolve token symbol or address to full token info
 */
async function resolveToken(input: string, chainId: number): Promise<TokenInfo | null> {
  const fromData = await resolveTokenFromData(input, chainId);
  if (fromData) return fromData;

  const normalized = input.trim();
  if (normalized.startsWith("0x") && normalized.length === 42) {
    return fetchTokenFromChain(normalized as Address, chainId);
  }

  return null;
}

/**
 * Check x402 USDC balance and return any warning
 */
async function checkX402UsdcBalance(
  sessionKeyAddress: Address,
  config: PragmaConfig,
  rpcUrl: string
): Promise<{ error?: QuoteResult; warning?: string }> {
  // If not in x402 mode, skip checks
  if (config.mode !== "x402") {
    return {};
  }

  const chainId = config.network.chainId;
  if (!isUsdcConfigured(chainId)) {
    return {};
  }

  const chain = buildViemChain(chainId, rpcUrl);
  const client = createPublicClient({ 
    chain, 
    transport: http(rpcUrl, x402HttpOptions(config)) 
  });
  const usdcBalance = await getUsdcBalance(sessionKeyAddress, client as PublicClient, chainId);
  const minRequired = getMinRequiredForOperation("quote");

  if (usdcBalance < minRequired) {
    return {
      error: {
        success: false,
        message: "Insufficient USDC for x402 API calls",
        error:
          `Session key has ${formatUsdcBalance(usdcBalance)} but needs at least ` +
          `${formatUsdcBalance(minRequired)}. Fund your session key with USDC to continue.`,
      },
    };
  }

  if (usdcBalance < LOW_BALANCE_WARNING) {
    return {
      warning: `x402 USDC balance low (${formatUsdcBalance(usdcBalance)}). Consider funding your session key with USDC.`,
    };
  }

  return {};
}

/**
 * Get token verification warning if unverified
 */
function getVerificationWarning(token: TokenInfo): string | null {
  const verified = token.categories?.includes("verified") ?? false;
  if (verified) return null;

  const shortAddr = `${token.address.slice(0, 6)}...${token.address.slice(-4)}`;
  return `Warning: ${token.symbol} (${shortAddr}) is not a verified token. Please verify the contract address before swapping.`;
}

export function registerGetSwapQuote(server: McpServer): void {
  server.tool(
    "get_swap_quote",
    "Get a swap quote from DEX aggregator. Returns expected output, price impact, and route. Quote is valid for ~5 minutes. Always show the quote to the user before executing.",
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
 * Get swap quote from aggregator
 */
async function getSwapQuote(params: z.infer<typeof GetSwapQuoteSchema>): Promise<QuoteResult> {
  try {
    // Load config and verify wallet
    const config = await loadConfig();
    if (!config || !isWalletConfigured(config)) {
      return {
        success: false,
        message: "Wallet not configured",
        error: "Please run setup_wallet first to create your pragma wallet",
      };
    }

    const walletAddress = config.wallet!.smartAccountAddress as Address;
    const sessionKeyAddress = config.wallet!.sessionKeyAddress as Address;
    const chainId = config.network.chainId;
    const rpcUrl = await getRpcUrl(config);

    // Check x402 USDC balance
    const x402Check = await checkX402UsdcBalance(sessionKeyAddress, config, rpcUrl);
    if (x402Check.error) return x402Check.error;

    // Load verified tokens and resolve input tokens
    await loadVerifiedTokens(chainId);

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

    // Parse amount
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

    // Normalize slippage
    const slippageBps = Math.max(0, Math.min(params.slippageBps ?? DEFAULT_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS));

    // Check native balance if swapping native token
    const warnings: string[] = [];
    if (x402Check.warning) warnings.push(x402Check.warning);

    try {
      const chain = buildViemChain(chainId, rpcUrl);
      const client = createPublicClient({ 
        chain, 
        transport: http(rpcUrl, x402HttpOptions(config)) 
      });
      const balance = await client.getBalance({ address: walletAddress });

      if (fromToken.address === NATIVE_TOKEN_ADDRESS && balance < amountWei) {
        warnings.push(
          `Insufficient balance: you have ${(Number(balance) / 1e18).toFixed(4)} ${fromToken.symbol} but want to swap ${params.amount} ${fromToken.symbol}`
        );
      }
    } catch {
      // Balance check is optional
    }

    // Get quote from aggregator
    const quoteResult = await getQuote({
      fromToken: fromToken.address,
      toToken: toToken.address,
      amount: amountWei,
      sender: walletAddress,
      slippageBps,
      fromDecimals: fromToken.decimals,
      toDecimals: toToken.decimals,
      fromSymbol: fromToken.symbol,
      toSymbol: toToken.symbol,
    });

    const quote = quoteResult.quote;
    const fromVerified = fromToken.categories?.includes("verified") ?? false;
    const toVerified = toToken.categories?.includes("verified") ?? false;

    // Add verification warnings
    const fromWarning = getVerificationWarning(fromToken);
    const toWarning = getVerificationWarning(toToken);
    if (fromWarning) warnings.push(fromWarning);
    if (toWarning) warnings.push(toWarning);
    if (quoteResult.fallbackUsed) {
      warnings.push(`Note: Using fallback aggregator - ${quoteResult.fallbackReason || "Primary unavailable"}`);
    }

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
          fromToken: { verified: fromVerified, status: fromVerified ? "verified" : "unverified" },
          toToken: { verified: toVerified, status: toVerified ? "verified" : "unverified" },
        },
      },
      warning: warnings.length > 0 ? warnings.join(" | ") : undefined,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return {
      success: false,
      message: errorMessage.includes("API error") ? "Quote API error" : "Failed to get quote",
      error: errorMessage,
    };
  }
}

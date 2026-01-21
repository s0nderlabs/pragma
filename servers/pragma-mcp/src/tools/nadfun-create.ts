// nad.fun Token Creation Tool
// Create new tokens on nad.fun bonding curve
// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Address } from "viem";
import { z } from "zod";
import { stat } from "fs/promises";
import { loadConfig, isWalletConfigured } from "../config/pragma-config.js";
import { getChainConfig } from "../config/chains.js";
import {
  DEFAULT_SLIPPAGE_BPS,
  MAX_SLIPPAGE_BPS,
} from "../core/nadfun/constants.js";
import {
  prepareTokenCreation,
  executeTokenCreation,
} from "../core/nadfun/create.js";
import type { NadFunCreateResponse } from "../core/nadfun/types.js";

// ============================================================================
// Schema
// ============================================================================

const NadFunCreateSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(32)
    .describe(
      "Token name (1-32 chars). Example: 'Moon Cat'. " +
      "This is the full display name shown to users."
    ),

  symbol: z
    .string()
    .min(1)
    .max(10)
    .regex(/^[A-Za-z0-9]+$/)
    .describe(
      "Token symbol/ticker (1-10 alphanumeric). Example: 'MCAT'. " +
      "Typically 3-5 uppercase letters."
    ),

  imagePath: z
    .string()
    .describe(
      "Path to token image file (PNG, JPEG, WebP). Max 5MB. " +
      "Example: './logo.png' or '/path/to/image.jpg'. " +
      "CRITICAL: File must exist and be readable."
    ),

  description: z
    .string()
    .max(500)
    .optional()
    .describe(
      "Token description (max 500 chars). Optional. " +
      "Shown on nad.fun token page."
    ),

  twitter: z
    .string()
    .optional()
    .describe(
      "Twitter/X URL. Must contain 'x.com'. Optional. " +
      "Example: 'https://x.com/mytoken'"
    ),

  telegram: z
    .string()
    .optional()
    .describe(
      "Telegram URL. Must contain 't.me'. Optional. " +
      "Example: 'https://t.me/mytokengroup'"
    ),

  website: z
    .string()
    .optional()
    .describe(
      "Website URL. Must be https. Optional. " +
      "Example: 'https://mytoken.xyz'"
    ),

  initialBuyMon: z
    .string()
    .optional()
    .describe(
      "MON amount to buy tokens with after creation. Optional. " +
      "Creator becomes first token holder. Example: '1' for 1 MON. " +
      "If provided, a separate nadfun_buy will be executed after creation."
    ),

  slippageBps: z
    .number()
    .min(0)
    .max(MAX_SLIPPAGE_BPS)
    .optional()
    .describe(
      `Slippage tolerance in basis points for the initial buy. Default: ${DEFAULT_SLIPPAGE_BPS} (5%). Max: ${MAX_SLIPPAGE_BPS} (50%).`
    ),
});

// ============================================================================
// Tool Registration
// ============================================================================

export function registerNadFunCreate(server: McpServer): void {
  server.tool(
    "nadfun_create",
    "Create a new token on nad.fun bonding curve. " +
    "Uploads image/metadata, mines vanity address (7777 suffix), and deploys token. " +
    "Requires Touch ID confirmation. " +
    "Check session key balance first to ensure sufficient gas (~0.05 MON).",
    NadFunCreateSchema.shape,
    async (params): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await nadFunCreateHandler(params as z.infer<typeof NadFunCreateSchema>);
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

// ============================================================================
// Handler
// ============================================================================

/**
 * Check if a file exists
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get file size in bytes
 */
async function getFileSize(filePath: string): Promise<number> {
  const fileStat = await stat(filePath);
  return fileStat.size;
}

/**
 * nad.fun create handler
 */
async function nadFunCreateHandler(
  params: z.infer<typeof NadFunCreateSchema>
): Promise<NadFunCreateResponse> {
  try {
    // Check 1: Wallet configured
    const config = await loadConfig();
    if (!config || !isWalletConfigured(config)) {
      return {
        success: false,
        message: "Wallet not configured",
        error: "Please run setup_wallet first to create your pragma wallet",
      };
    }

    // Check 2: Image file exists
    const imageExists = await fileExists(params.imagePath);
    if (!imageExists) {
      return {
        success: false,
        message: "Image file not found",
        error: `File not found: ${params.imagePath}`,
      };
    }

    // Check 3: Image size (before upload)
    const imageSize = await getFileSize(params.imagePath);
    const maxSize = 5 * 1024 * 1024; // 5MB
    if (imageSize > maxSize) {
      return {
        success: false,
        message: "Image too large",
        error: `Image exceeds 5MB limit (current: ${(imageSize / 1024 / 1024).toFixed(2)}MB)`,
      };
    }

    // Check 4: Validate optional URL fields
    if (params.twitter && !params.twitter.includes("x.com")) {
      return {
        success: false,
        message: "Invalid Twitter URL",
        error: "Twitter URL must contain 'x.com'. Example: 'https://x.com/mytoken'",
      };
    }

    if (params.telegram && !params.telegram.includes("t.me")) {
      return {
        success: false,
        message: "Invalid Telegram URL",
        error: "Telegram URL must contain 't.me'. Example: 'https://t.me/mytokengroup'",
      };
    }

    if (params.website && !params.website.startsWith("https://")) {
      return {
        success: false,
        message: "Invalid website URL",
        error: "Website URL must start with 'https://'. Example: 'https://mytoken.xyz'",
      };
    }

    // All checks passed - proceed
    const userAddress = config.wallet!.smartAccountAddress as Address;
    const chainConfig = getChainConfig(config.network.chainId);

    // Step 1: Prepare (uploads image, metadata, mines salt)
    const quote = await prepareTokenCreation(
      {
        name: params.name,
        symbol: params.symbol,
        imagePath: params.imagePath,
        description: params.description,
        twitter: params.twitter,
        telegram: params.telegram,
        website: params.website,
        initialBuyMon: params.initialBuyMon,
        slippageBps: params.slippageBps,
      },
      userAddress
    );

    // Step 2: Execute (creates delegation, signs, executes)
    const result = await executeTokenCreation(quote.quoteId);

    if (!result.success) {
      return {
        success: false,
        message: "Token creation failed",
        error: result.error || "Unknown error during token creation",
      };
    }

    // Build response
    const response: NadFunCreateResponse = {
      success: true,
      message: result.message || `Successfully created token ${params.symbol}`,
      token: {
        address: result.tokenAddress!,
        name: params.name,
        symbol: params.symbol,
        explorerUrl: `${chainConfig.blockExplorer}/token/${result.tokenAddress}`,
      },
      transaction: {
        hash: result.txHash!,
        explorerUrl: result.explorerUrl!,
      },
    };

    // Add initial buy info if present
    if (result.initialBuyMon) {
      response.initialBuy = {
        monSpent: result.initialBuyMon,
      };
    }

    return response;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    // Handle specific errors
    if (errorMessage.includes("Smart Account balance")) {
      return {
        success: false,
        message: "Insufficient funds",
        error: errorMessage,
      };
    }

    if (errorMessage.includes("Session key needs gas")) {
      return {
        success: false,
        message: "Session key needs gas",
        error: errorMessage,
      };
    }

    if (errorMessage.includes("Touch ID") || errorMessage.includes("passkey")) {
      return {
        success: false,
        message: "Authentication failed",
        error: "Touch ID authentication was cancelled or failed. Please try again.",
      };
    }

    if (errorMessage.includes("NSFW")) {
      return {
        success: false,
        message: "Image rejected",
        error: errorMessage,
      };
    }

    if (errorMessage.includes("nad.fun API")) {
      return {
        success: false,
        message: "nad.fun API error",
        error: errorMessage,
      };
    }

    return {
      success: false,
      message: "Token creation failed",
      error: errorMessage,
    };
  }
}

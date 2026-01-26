// Wrap/Unwrap Tools
// Wraps MON → WMON and unwraps WMON → MON via delegation
// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { executeWrap, executeUnwrap } from "../core/execution/wrap.js";
import { executeAutonomousWrap, executeAutonomousUnwrap } from "../core/execution/autonomous.js";
import { loadConfig, isWalletConfigured } from "../config/pragma-config.js";
import { getChainConfig } from "../config/chains.js";

const WrapSchema = z.object({
  amount: z
    .string()
    .describe("Amount of MON to wrap in human-readable format (e.g., '10' for 10 MON)"),
  agentId: z
    .string()
    .optional()
    .describe(
      "Sub-agent ID for autonomous execution (no Touch ID). " +
      "If omitted, uses assistant mode with Touch ID confirmation."
    ),
});

const UnwrapSchema = z.object({
  amount: z
    .string()
    .describe("Amount of WMON to unwrap in human-readable format (e.g., '10' for 10 WMON)"),
  agentId: z
    .string()
    .optional()
    .describe(
      "Sub-agent ID for autonomous execution (no Touch ID). " +
      "If omitted, uses assistant mode with Touch ID confirmation."
    ),
});

interface WrapResult {
  success: boolean;
  message: string;
  transaction?: {
    hash: string;
    explorerUrl: string;
    status: string;
  };
  wrap?: {
    direction: "wrap" | "unwrap";
    amount: string;
    from: string;
    to: string;
  };
  error?: string;
}

export function registerWrap(server: McpServer): void {
  server.tool(
    "wrap",
    "Wrap MON to WMON. " +
    "If agentId provided: uses autonomous mode (no Touch ID). " +
    "If no agentId: uses assistant mode (requires Touch ID). " +
    "WMON is useful for DeFi operations that require ERC20 tokens.",
    WrapSchema.shape,
    async (params): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await wrapHandler(params as z.infer<typeof WrapSchema>);
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

export function registerUnwrap(server: McpServer): void {
  server.tool(
    "unwrap",
    "Unwrap WMON back to MON. " +
    "If agentId provided: uses autonomous mode (no Touch ID). " +
    "If no agentId: uses assistant mode (requires Touch ID). " +
    "Converts wrapped MON back to native MON.",
    UnwrapSchema.shape,
    async (params): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await unwrapHandler(params as z.infer<typeof UnwrapSchema>);
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
 * Wrap MON -> WMON handler
 */
async function wrapHandler(params: z.infer<typeof WrapSchema>): Promise<WrapResult> {
  try {
    // Step 1: Verify wallet is configured
    const config = await loadConfig();
    if (!config || !isWalletConfigured(config)) {
      return {
        success: false,
        message: "Wallet not configured",
        error: "Please run setup_wallet first to create your pragma wallet",
      };
    }

    // DUAL-MODE: Check if autonomous execution requested
    if (params.agentId) {
      // Autonomous path: use pre-signed delegation chain, no Touch ID
      const result = await executeAutonomousWrap(params.agentId, params.amount);
      const chainConfig = getChainConfig(config.network.chainId);
      return {
        success: result.success,
        message: result.message,
        transaction: result.txHash ? {
          hash: result.txHash,
          explorerUrl: result.explorerUrl || `${chainConfig.blockExplorer}/tx/${result.txHash}`,
          status: "success",
        } : undefined,
        wrap: result.wrap ? {
          direction: result.wrap.direction,
          amount: result.wrap.amount,
          from: "MON",
          to: "WMON",
        } : undefined,
        error: result.error,
      };
    }

    // Assistant path: existing implementation with Touch ID
    // Step 2: Validate amount
    const amount = parseFloat(params.amount);
    if (isNaN(amount) || amount <= 0) {
      return {
        success: false,
        message: "Invalid amount",
        error: "Please provide a valid amount greater than 0",
      };
    }

    // Step 3: Execute the wrap
    const result = await executeWrap({ amount: params.amount });

    // Step 4: Get chain config for explorer URL
    const chainConfig = getChainConfig(config.network.chainId);
    const explorerUrl = chainConfig.blockExplorer
      ? `${chainConfig.blockExplorer}/tx/${result.txHash}`
      : `https://monadvision.com/tx/${result.txHash}`;

    // Step 5: Return success result
    return {
      success: true,
      message: `Wrapped ${params.amount} MON → WMON`,
      transaction: {
        hash: result.txHash,
        explorerUrl,
        status: result.status,
      },
      wrap: {
        direction: "wrap",
        amount: params.amount,
        from: "MON",
        to: "WMON",
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    // Handle specific error types
    if (errorMessage.includes("Touch ID") || errorMessage.includes("authentication")) {
      return {
        success: false,
        message: "Authentication required",
        error: "Touch ID authentication was cancelled or failed. Please try again.",
      };
    }

    if (errorMessage.includes("insufficient") || errorMessage.includes("balance")) {
      return {
        success: false,
        message: "Insufficient balance",
        error: errorMessage,
      };
    }

    if (errorMessage.includes("nonce")) {
      return {
        success: false,
        message: "Nonce error",
        error: "A delegation was already used. Please try again.",
      };
    }

    if (errorMessage.includes("reverted")) {
      return {
        success: false,
        message: "Transaction reverted",
        error: `The wrap transaction was reverted: ${errorMessage}`,
      };
    }

    return {
      success: false,
      message: "Wrap failed",
      error: errorMessage,
    };
  }
}

/**
 * Unwrap WMON → MON handler
 */
async function unwrapHandler(params: z.infer<typeof UnwrapSchema>): Promise<WrapResult> {
  try {
    // Step 1: Verify wallet is configured
    const config = await loadConfig();
    if (!config || !isWalletConfigured(config)) {
      return {
        success: false,
        message: "Wallet not configured",
        error: "Please run setup_wallet first to create your pragma wallet",
      };
    }

    // DUAL-MODE: Check if autonomous execution requested
    if (params.agentId) {
      // Autonomous path: use pre-signed delegation chain, no Touch ID
      const result = await executeAutonomousUnwrap(params.agentId, params.amount);
      const chainConfig = getChainConfig(config.network.chainId);
      return {
        success: result.success,
        message: result.message,
        transaction: result.txHash ? {
          hash: result.txHash,
          explorerUrl: result.explorerUrl || `${chainConfig.blockExplorer}/tx/${result.txHash}`,
          status: "success",
        } : undefined,
        wrap: result.wrap ? {
          direction: result.wrap.direction,
          amount: result.wrap.amount,
          from: "WMON",
          to: "MON",
        } : undefined,
        error: result.error,
      };
    }

    // Assistant path: existing implementation with Touch ID
    // Step 2: Validate amount
    const amount = parseFloat(params.amount);
    if (isNaN(amount) || amount <= 0) {
      return {
        success: false,
        message: "Invalid amount",
        error: "Please provide a valid amount greater than 0",
      };
    }

    // Step 3: Execute the unwrap
    const result = await executeUnwrap({ amount: params.amount });

    // Step 4: Get chain config for explorer URL
    const chainConfig = getChainConfig(config.network.chainId);
    const explorerUrl = chainConfig.blockExplorer
      ? `${chainConfig.blockExplorer}/tx/${result.txHash}`
      : `https://monadvision.com/tx/${result.txHash}`;

    // Step 5: Return success result
    return {
      success: true,
      message: `Unwrapped ${params.amount} WMON → MON`,
      transaction: {
        hash: result.txHash,
        explorerUrl,
        status: result.status,
      },
      wrap: {
        direction: "unwrap",
        amount: params.amount,
        from: "WMON",
        to: "MON",
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    // Handle specific error types
    if (errorMessage.includes("Touch ID") || errorMessage.includes("authentication")) {
      return {
        success: false,
        message: "Authentication required",
        error: "Touch ID authentication was cancelled or failed. Please try again.",
      };
    }

    if (errorMessage.includes("insufficient") || errorMessage.includes("balance")) {
      return {
        success: false,
        message: "Insufficient balance",
        error: errorMessage,
      };
    }

    if (errorMessage.includes("nonce")) {
      return {
        success: false,
        message: "Nonce error",
        error: "A delegation was already used. Please try again.",
      };
    }

    if (errorMessage.includes("reverted")) {
      return {
        success: false,
        message: "Transaction reverted",
        error: `The unwrap transaction was reverted: ${errorMessage}`,
      };
    }

    return {
      success: false,
      message: "Unwrap failed",
      error: errorMessage,
    };
  }
}

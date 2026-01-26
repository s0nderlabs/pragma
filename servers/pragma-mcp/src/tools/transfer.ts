// Transfer Tool
// Transfers tokens (ERC20 or native MON) to another address via delegation
// Supports both ERC20 and native MON transfers (H2 pattern)
// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Address } from "viem";
import { getAddress, isAddress } from "viem";
import { executeTransfer } from "../core/execution/transfer.js";
import { executeAutonomousTransfer } from "../core/execution/autonomous.js";
import { loadConfig, isWalletConfigured } from "../config/pragma-config.js";
import { getChainConfig } from "../config/chains.js";

const TransferSchema = z.object({
  token: z
    .string()
    .describe("Token to transfer: 'MON' for native, or symbol like 'USDC', 'WMON', or contract address (0x...)"),
  to: z
    .string()
    .describe("Recipient address (0x...)"),
  amount: z
    .string()
    .describe("Amount to transfer in human-readable format (e.g., '1.5' for 1.5 tokens)"),
  agentId: z
    .string()
    .optional()
    .describe(
      "Sub-agent ID for autonomous execution (no Touch ID). " +
      "If omitted, uses assistant mode with Touch ID confirmation."
    ),
});

interface TransferResult {
  success: boolean;
  message: string;
  transaction?: {
    hash: string;
    explorerUrl: string;
    status: string;
  };
  transfer?: {
    token: string;
    tokenAddress: string;
    isNative: boolean;
    recipient: string;
    amount: string;
  };
  error?: string;
}

export function registerTransfer(server: McpServer): void {
  server.tool(
    "transfer",
    "Transfer tokens to another address. Supports both native MON and ERC20 tokens. " +
    "If agentId provided: uses autonomous mode (no Touch ID). " +
    "If no agentId: uses assistant mode (requires Touch ID). " +
    "Always verify the recipient address with the user before executing.",
    TransferSchema.shape,
    async (params): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await transferHandler(params as z.infer<typeof TransferSchema>);
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
 * Transfer handler
 */
async function transferHandler(
  params: z.infer<typeof TransferSchema>
): Promise<TransferResult> {
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
      // Validate recipient address first
      if (!params.to || !isAddress(params.to)) {
        return {
          success: false,
          message: "Invalid recipient address",
          error: "Please provide a valid recipient address (0x...)",
        };
      }
      // Autonomous path: use pre-signed delegation chain, no Touch ID
      const result = await executeAutonomousTransfer(
        params.agentId,
        params.token,
        getAddress(params.to) as Address,
        params.amount
      );
      return {
        success: result.success,
        message: result.message,
        transaction: result.txHash ? {
          hash: result.txHash,
          explorerUrl: result.explorerUrl!,
          status: "success",
        } : undefined,
        transfer: result.transfer ? {
          token: result.transfer.token,
          tokenAddress: result.transfer.isNative ? "native" : result.transfer.token,
          isNative: result.transfer.isNative,
          recipient: result.transfer.recipient,
          amount: result.transfer.amount,
        } : undefined,
        error: result.error,
      };
    }

    // Assistant path: existing implementation with Touch ID
    // Step 2: Validate recipient address
    if (!params.to || !isAddress(params.to)) {
      return {
        success: false,
        message: "Invalid recipient address",
        error: "Please provide a valid recipient address (0x...)",
      };
    }

    const recipientAddress = getAddress(params.to) as Address;

    // Step 3: Validate amount
    const amount = parseFloat(params.amount);
    if (isNaN(amount) || amount <= 0) {
      return {
        success: false,
        message: "Invalid amount",
        error: "Please provide a valid amount greater than 0",
      };
    }

    // Step 4: Execute the transfer
    const result = await executeTransfer({
      token: params.token,
      to: recipientAddress,
      amount: params.amount,
    });

    // Step 5: Get chain config for explorer URL
    const chainConfig = getChainConfig(config.network.chainId);
    const explorerUrl = chainConfig.blockExplorer
      ? `${chainConfig.blockExplorer}/tx/${result.txHash}`
      : `https://monadvision.com/tx/${result.txHash}`;

    // Step 6: Return success result
    const tokenTypeLabel = result.token.isNative ? "native MON" : result.token.symbol;
    return {
      success: true,
      message: `Transferred ${params.amount} ${tokenTypeLabel} to ${recipientAddress}`,
      transaction: {
        hash: result.txHash,
        explorerUrl,
        status: result.status,
      },
      transfer: {
        token: result.token.symbol,
        tokenAddress: result.token.address,
        isNative: result.token.isNative,
        recipient: recipientAddress,
        amount: params.amount,
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
        error: `The transfer transaction was reverted: ${errorMessage}`,
      };
    }

    return {
      success: false,
      message: "Transfer failed",
      error: errorMessage,
    };
  }
}

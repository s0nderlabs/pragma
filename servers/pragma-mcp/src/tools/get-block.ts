// Get Block Tool
// Retrieves block information by number, hash, or latest
// Works in both BYOK and x402 modes (direct RPC)
// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createPublicClient, http, type Hex } from "viem";
import { loadConfig, isWalletConfigured, getRpcUrl } from "../config/pragma-config.js";
import { buildViemChain } from "../config/chains.js";
import { x402HttpOptions } from "../core/x402/client.js";

const GetBlockSchema = z.object({
  blockIdentifier: z
    .union([z.string(), z.number()])
    .optional()
    .describe(
      "Block number (e.g., 12345), block hash (e.g., '0x...'), or 'latest'/'pending'. " +
        "If not provided, returns the latest block."
    ),
  includeTransactions: z
    .boolean()
    .optional()
    .describe("Include full transaction objects. Default: false (only hashes)."),
});

interface GetBlockResult {
  success: boolean;
  message: string;
  block?: {
    number: string;
    hash: string;
    timestamp: string;
    timestampFormatted: string;
    timezone: string;
    parentHash: string;
    gasUsed: string;
    gasLimit: string;
    baseFeePerGas?: string;
    transactionCount: number;
    transactions: string[]; // Transaction hashes (always included)
    miner: string;
    nonce?: string;
    difficulty?: string;
    extraData?: string;
  };
  network?: {
    chainId: number;
    chainName: string;
  };
  error?: string;
}

export function registerGetBlock(server: McpServer): void {
  server.tool(
    "get_block",
    "Get block information by number, hash, or latest. Returns block details including timestamp, gas usage, and transaction count. Works in both BYOK and x402 modes.",
    GetBlockSchema.shape,
    async (params): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await getBlockHandler(params as z.infer<typeof GetBlockSchema>);
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

function formatTimestamp(timestamp: bigint): { formatted: string; timezone: string } {
  const date = new Date(Number(timestamp) * 1000);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Format in user's local timezone
  const formatted = date.toLocaleString("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  return { formatted, timezone };
}

function isBlockHash(value: string): boolean {
  // Block hash is 66 characters (0x + 64 hex chars)
  return value.startsWith("0x") && value.length === 66;
}

async function getBlockHandler(
  params: z.infer<typeof GetBlockSchema>
): Promise<GetBlockResult> {
  try {
    // Step 1: Load config and verify wallet
    const config = await loadConfig();
    if (!config || !isWalletConfigured(config)) {
      return {
        success: false,
        message: "Wallet not configured",
        error: "Please run setup_wallet first to create your pragma wallet",
      };
    }

    // Step 2: Get RPC URL (mode-aware)
    const rpcUrl = await getRpcUrl(config);
    const chainId = config.network.chainId;
    const chainName = config.network.name || "Monad";
    const chain = buildViemChain(chainId, rpcUrl);

    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl, x402HttpOptions(config)),
    });

    // Step 3: Parse block identifier and fetch block
    const includeTransactions = params.includeTransactions ?? false;
    let block;

    const identifier = params.blockIdentifier;

    if (identifier === undefined || identifier === "latest") {
      // Latest block
      block = await publicClient.getBlock({
        includeTransactions,
      });
    } else if (identifier === "pending") {
      // Pending block
      block = await publicClient.getBlock({
        blockTag: "pending",
        includeTransactions,
      });
    } else if (typeof identifier === "number") {
      // Block number as number
      block = await publicClient.getBlock({
        blockNumber: BigInt(identifier),
        includeTransactions,
      });
    } else if (typeof identifier === "string") {
      if (isBlockHash(identifier)) {
        // Block hash
        block = await publicClient.getBlock({
          blockHash: identifier as Hex,
          includeTransactions,
        });
      } else {
        // Try to parse as block number string
        const blockNumber = parseInt(identifier, 10);
        if (isNaN(blockNumber)) {
          return {
            success: false,
            message: "Invalid block identifier",
            error: `Could not parse '${identifier}' as block number or hash. Use a number, '0x...' hash, 'latest', or 'pending'.`,
          };
        }
        block = await publicClient.getBlock({
          blockNumber: BigInt(blockNumber),
          includeTransactions,
        });
      }
    }

    if (!block) {
      return {
        success: false,
        message: "Block not found",
        error: `Could not find block with identifier: ${identifier ?? "latest"}`,
      };
    }

    // Step 4: Format response
    const { formatted: timestampFormatted, timezone } = formatTimestamp(block.timestamp);
    const transactionCount = block.transactions.length;
    const blockNumber = block.number?.toString() ?? "pending";
    const blockHash = block.hash ?? "pending";

    // Extract transaction hashes (works for both hash array and full tx objects)
    const transactions = block.transactions.map((tx) =>
      typeof tx === "string" ? tx : tx.hash
    );

    return {
      success: true,
      message: `Block #${blockNumber} (${transactionCount} txs) at ${timestampFormatted}`,
      block: {
        number: blockNumber,
        hash: blockHash,
        timestamp: block.timestamp.toString(),
        timestampFormatted,
        timezone,
        parentHash: block.parentHash,
        gasUsed: block.gasUsed.toString(),
        gasLimit: block.gasLimit.toString(),
        baseFeePerGas: block.baseFeePerGas?.toString(),
        transactionCount,
        transactions,
        miner: block.miner,
        nonce: block.nonce ?? undefined,
        difficulty: block.difficulty?.toString(),
        extraData: block.extraData,
      },
      network: {
        chainId,
        chainName,
      },
    };
  } catch (error) {
    return {
      success: false,
      message: "Failed to get block",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

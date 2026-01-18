// Get Gas Price Tool
// Retrieves current gas price with unit conversions
// Works in both BYOK and x402 modes (direct RPC)
// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createPublicClient, http, formatUnits, formatGwei } from "viem";
import { loadConfig, isWalletConfigured, getRpcUrl } from "../config/pragma-config.js";
import { buildViemChain } from "../config/chains.js";
import { x402HttpOptions } from "../core/x402/client.js";

const GetGasPriceSchema = z.object({});

interface GetGasPriceResult {
  success: boolean;
  message: string;
  gas?: {
    gasPrice: string;
    gasPriceGwei: string;
    gasPriceMon: string;
    estimatedCosts: {
      simpleTransfer: string;
      swap: string;
      stake: string;
    };
  };
  network?: {
    chainId: number;
    chainName: string;
  };
  error?: string;
}

// Gas estimates from pragma patterns (in gas units)
const GAS_ESTIMATES = {
  simpleTransfer: 21000n, // Basic ETH/MON transfer
  swap: 250000n, // Typical swap operation
  stake: 150000n, // Typical stake operation
};

export function registerGetGasPrice(server: McpServer): void {
  server.tool(
    "get_gas_price",
    "Get current gas price in wei, Gwei, and MON with estimated costs for common operations. Works in both BYOK and x402 modes.",
    GetGasPriceSchema.shape,
    async (): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await getGasPriceHandler();
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

function formatMon(wei: bigint, decimals: number = 6): string {
  const mon = formatUnits(wei, 18);
  return `${parseFloat(mon).toFixed(decimals)} MON`;
}

async function getGasPriceHandler(): Promise<GetGasPriceResult> {
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

    // Step 3: Get current gas price
    const gasPrice = await publicClient.getGasPrice();

    // Step 4: Calculate estimated costs
    const simpleTransferCost = gasPrice * GAS_ESTIMATES.simpleTransfer;
    const swapCost = gasPrice * GAS_ESTIMATES.swap;
    const stakeCost = gasPrice * GAS_ESTIMATES.stake;

    // Step 5: Format response
    const gasPriceGwei = formatGwei(gasPrice);

    return {
      success: true,
      message: `Current gas price: ${gasPriceGwei} Gwei (~${formatMon(swapCost)} per swap)`,
      gas: {
        gasPrice: gasPrice.toString(),
        gasPriceGwei: `${gasPriceGwei} Gwei`,
        gasPriceMon: formatMon(gasPrice, 12),
        estimatedCosts: {
          simpleTransfer: formatMon(simpleTransferCost),
          swap: formatMon(swapCost),
          stake: formatMon(stakeCost),
        },
      },
      network: {
        chainId,
        chainName,
      },
    };
  } catch (error) {
    return {
      success: false,
      message: "Failed to get gas price",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

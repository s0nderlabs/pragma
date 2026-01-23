import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SUPPORTED_PAIRS } from "../core/leverup/constants.js";

const LeverUpListPairsSchema = z.object({});

interface LeverUpListPairsResult {
  success: boolean;
  message: string;
  data?: {
    pairs: Array<{
      symbol: string;
      category: string;
      isHighLeverage: boolean;
      pairBase: string;
    }>;
  };
}

export function registerLeverUpListPairs(server: McpServer): void {
  server.tool(
    "leverup_list_pairs",
    "List all supported trading pairs on LeverUp including Stocks and Forex.",
    LeverUpListPairsSchema.shape,
    async (): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = leverupListPairsHandler();
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

function leverupListPairsHandler(): LeverUpListPairsResult {
  const pairs = SUPPORTED_PAIRS.map(p => ({
    symbol: p.pair,
    category: p.category,
    isHighLeverage: !!p.isHighLeverage,
    pairBase: p.pairBase
  }));

  return {
    success: true,
    message: `Found ${pairs.length} supported trading pairs.`,
    data: { pairs }
  };
}

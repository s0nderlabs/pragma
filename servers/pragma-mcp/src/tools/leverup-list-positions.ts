import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadConfig, isWalletConfigured } from "../config/pragma-config.js";
import { getUserPositions } from "../core/leverup/client.js";
import { formatUnits, type Address } from "viem";

const LeverUpListPositionsSchema = z.object({
  address: z
    .string()
    .optional()
    .describe("Optional address to check positions for. Defaults to your smart account."),
});

interface LeverUpListPositionsResult {
  success: boolean;
  message: string;
  data?: {
    positions: Array<{
      tradeHash: string;
      pair: string;
      side: string;
      size: string;
      margin: string;
      entryPrice: string;
      unrealizedPnL: string;
      pnlPercentage: string;
      liqPrice: string;
      healthFactor: number;
      distanceToLiq: string;
    }>;
  };
}

export function registerLeverUpListPositions(server: McpServer): void {
  server.tool(
    "leverup_list_positions",
    "List all your active LeverUp perpetual positions with PnL and liquidation analysis.",
    LeverUpListPositionsSchema.shape,
    async (params): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await leverupListPositionsHandler(params as z.infer<typeof LeverUpListPositionsSchema>);
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

async function leverupListPositionsHandler(
  params: z.infer<typeof LeverUpListPositionsSchema>
): Promise<LeverUpListPositionsResult> {
  try {
    const config = await loadConfig();
    if (!config || !isWalletConfigured(config)) {
      return {
        success: false,
        message: "Wallet not configured. Run setup_wallet first.",
      };
    }

    const userAddress = (params.address || config.wallet?.smartAccountAddress) as Address;
    const positions = await getUserPositions(userAddress);

    if (positions.length === 0) {
      return {
        success: true,
        message: "No active LeverUp positions found.",
        data: { positions: [] }
      };
    }

    const formattedPositions = positions.map(p => ({
      tradeHash: p.position.positionHash,
      pair: p.position.pair,
      side: p.position.isLong ? "LONG" : "SHORT",
      size: formatUnits(p.position.qty, 10),
      margin: formatUnits(p.position.margin, 18),
      entryPrice: `$${formatUnits(p.position.entryPrice, 18)}`,
      unrealizedPnL: p.analysis.unrealizedPnL,
      pnlPercentage: p.analysis.pnlPercentage,
      liqPrice: `$${p.analysis.liqPrice}`,
      healthFactor: p.analysis.healthFactor,
      distanceToLiq: p.analysis.distanceToLiq
    }));

    const summary = formattedPositions
      .map(p => `${p.pair} ${p.side}: ${p.unrealizedPnL} (${p.pnlPercentage})`)
      .join(", ");

    return {
      success: true,
      message: `You have ${positions.length} active positions. Summary: ${summary}`,
      data: { positions: formattedPositions }
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return {
      success: false,
      message: `Failed to fetch LeverUp positions: ${errorMessage}`,
    };
  }
}

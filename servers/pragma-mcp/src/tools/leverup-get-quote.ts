import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getLeverUpQuote } from "../core/leverup/client.js";

const LeverUpGetQuoteSchema = z.object({
  symbol: z
    .string()
    .describe(
      "The asset symbol to trade (e.g. BTC, ETH, MON, AAPL, EUR). " +
      "NOTE: 500BTC and 500ETH are Zero-Fee pairs that ONLY support 500x, 750x, or 1001x leverage."
    ),
  isLong: z
    .boolean()
    .describe("True for Long, False for Short."),
  marginAmount: z
    .string()
    .describe(
      "The amount of collateral to use (e.g. '10' for 10 MON). Recommended minimum: $10 USD."
    ),
  leverage: z
    .number()
    .min(1)
    .max(1001)
    .describe(
      "Leverage multiplier. Normal pairs: 1-100x with 0.045% fees. Zero-Fee pairs (500BTC/500ETH): ONLY 500, 750, or 1001 " +
      "(no fees if PnL < 0, profit sharing if profitable). HARD LIMIT: Position size (margin × leverage) must be at least $200 USD."
    ),
  collateralToken: z
    .enum(["MON", "USDC", "LVUSD", "LVMON"])
    .default("MON")
    .optional()
    .describe(
      "Collateral token: MON (native), USDC, LVUSD (vault USD), or LVMON (vault MON). Default: MON."
    ),
});

interface LeverUpGetQuoteResult {
  success: boolean;
  message: string;
  data?: any;
  error?: string;
}

export function registerLeverUpGetQuote(server: McpServer): void {
  server.tool(
    "leverup_get_quote",
    "Calculate position size, liquidation price, and fees for a potential LeverUp trade.",
    LeverUpGetQuoteSchema.shape,
    async (params): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await leverupGetQuoteHandler(params as z.infer<typeof LeverUpGetQuoteSchema>);
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

async function leverupGetQuoteHandler(
  params: z.infer<typeof LeverUpGetQuoteSchema>
): Promise<LeverUpGetQuoteResult> {
  try {
    const quote = await getLeverUpQuote(
      params.symbol,
      params.isLong,
      params.marginAmount,
      params.leverage,
      params.collateralToken
    );

    const side = params.isLong ? "Long" : "Short";
    const displaySize = Number(quote.positionSize).toFixed(6);

    let message = `Quote for ${params.leverage}x ${side} on ${params.symbol}: Size ${displaySize} units, Liq Price $${quote.liqPrice}. Distance to Liquidation: ${quote.distanceToLiq}.`;

    // Add info about Zero-Fee pairs
    if (quote.isHighLeveragePair) {
      message += ` [Zero-Fee Pair: No fees if PnL < 0]`;
    }

    // Add margin update capability info
    if (!quote.canAddMargin) {
      message += ` [Cannot add/remove margin at this leverage]`;
    }

    // Add TP limit info
    message += ` Max TP: ${quote.maxTpPercent}% profit.`;

    if (!quote.meetsMinimums) {
      message += "\n\n⚠️ WARNING: " + quote.warnings.join(". ");
    }
    
    return {
      success: true,
      message,
      data: quote
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return {
      success: false,
      message: `Failed to get LeverUp quote: ${errorMessage}`,
    };
  }
}

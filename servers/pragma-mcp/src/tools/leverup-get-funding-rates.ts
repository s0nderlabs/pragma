import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getFundingRates } from "../core/leverup/client.js";

const LeverUpGetFundingRatesSchema = z.object({
  symbol: z
    .string()
    .optional()
    .describe(
      "Asset symbol to get funding rates for (e.g., 'BTC', 'ETH', 'MON'). " +
        "If omitted, returns funding rates for all supported LeverUp pairs. " +
        "High-leverage pairs (500BTC, 500ETH) are excluded as they use zero-fee model."
    ),
});

interface FundingRateEntry {
  symbol: string;
  category: string;
  holdingFeeRate8h: { long: string; short: string };
  holdingFeeRate1h: { long: string; short: string };
  fundingDirection: string;
  pairBase: string;
}

interface LeverUpGetFundingRatesResult {
  success: boolean;
  message: string;
  data?: {
    fundingRates: FundingRateEntry[];
    model: string;
    note: string;
  };
  error?: string;
}

export function registerLeverUpGetFundingRates(server: McpServer): void {
  server.tool(
    "leverup_get_funding_rates",
    "Get current holding fee rates (funding rates) for LeverUp perpetual pairs. " +
      "LeverUp uses a holding fee model instead of traditional funding rates: " +
      "positions are charged a per-second fee based on direction (long/short). " +
      "Rates shown as 8-hour and 1-hour percentages. " +
      "Use this to assess carry costs before opening positions.",
    LeverUpGetFundingRatesSchema.shape,
    async (params): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await leverUpGetFundingRatesHandler(
        params as z.infer<typeof LeverUpGetFundingRatesSchema>
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}

async function leverUpGetFundingRatesHandler(
  params: z.infer<typeof LeverUpGetFundingRatesSchema>
): Promise<LeverUpGetFundingRatesResult> {
  try {
    const fundingData = await getFundingRates(params.symbol);

    if (fundingData.length === 0) {
      return {
        success: false,
        message: params.symbol
          ? `No funding data found for '${params.symbol}'`
          : "No funding data available",
        error: params.symbol
          ? `Symbol '${params.symbol}' is not supported on LeverUp. Use leverup_list_pairs to see available markets.`
          : "Could not fetch funding data from any pair.",
      };
    }

    const fundingRates: FundingRateEntry[] = fundingData.map(
      ({ symbol, category, holdingFeeRate8h, holdingFeeRate1h, fundingDirection, pairBase }) => ({
        symbol, category, holdingFeeRate8h, holdingFeeRate1h, fundingDirection, pairBase,
      })
    );

    return {
      success: true,
      message: `Funding rates for ${fundingRates.length} LeverUp pair${fundingRates.length > 1 ? "s" : ""}`,
      data: {
        fundingRates,
        model:
          "LeverUp uses a holding fee model. Positions are charged a per-second fee " +
          "that varies by asset and direction (long vs short). Rates shown are annualized " +
          "equivalents for 8h and 1h periods. The fundingDirection indicates which side " +
          "currently pays more based on accumulated funding.",
        note:
          "High-leverage pairs (500BTC/500ETH) use zero-fee model and are excluded. " +
          "Rates are read directly from on-chain contract state.",
      },
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return {
      success: false,
      message: "Failed to fetch funding rates",
      error: errorMessage,
    };
  }
}

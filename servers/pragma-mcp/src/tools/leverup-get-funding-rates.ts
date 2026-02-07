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
  openInterest?: {
    longQty: string;
    shortQty: string;
    oiRatio: string;
    dominantSide: string;
  };
  realTimeFundingRate?: {
    rate8h: string;
    rate1h: string;
    direction: string;
  };
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
    "Get funding rates, holding fees, and open interest for LeverUp perpetual pairs. " +
      "Returns: (1) Holding fee rates — flat per-second carry cost by direction. " +
      "(2) Real-time funding rate — directional fee based on OI imbalance (dominant side pays). " +
      "(3) Open interest — long/short quantities and OI ratio for squeeze detection. " +
      "Use this to assess carry costs, directional crowding, and squeeze risk before opening positions.",
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
      ({ symbol, category, holdingFeeRate8h, holdingFeeRate1h, fundingDirection, pairBase, marketInfo }) => {
        const entry: FundingRateEntry = {
          symbol, category, holdingFeeRate8h, holdingFeeRate1h, fundingDirection, pairBase,
        };
        if (marketInfo) {
          entry.openInterest = {
            longQty: marketInfo.longQty,
            shortQty: marketInfo.shortQty,
            oiRatio: marketInfo.oiRatio,
            dominantSide: marketInfo.dominantSide,
          };
          entry.realTimeFundingRate = {
            rate8h: marketInfo.currentFundingRate8h,
            rate1h: marketInfo.currentFundingRate1h,
            direction: marketInfo.fundingRateDirection,
          };
        }
        return entry;
      }
    );

    return {
      success: true,
      message: `Funding rates and open interest for ${fundingRates.length} LeverUp pair${fundingRates.length > 1 ? "s" : ""}`,
      data: {
        fundingRates,
        model:
          "LeverUp charges TWO separate fees: (1) Holding fee — flat per-second cost, varies by asset " +
          "and direction. (2) Funding fee — directional, scales with OI imbalance (dominant side pays minority). " +
          "The realTimeFundingRate shows the current per-second funding rate. Negative = shorts pay longs. " +
          "openInterest shows long/short quantities (in asset units) and OI ratio for squeeze detection.",
        note:
          "High-leverage pairs (500BTC/500ETH) use zero-fee model and are excluded. " +
          "All data read directly from on-chain Diamond Proxy contract.",
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

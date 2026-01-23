import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatUnits } from "viem";
import { SUPPORTED_PAIRS } from "../core/leverup/constants.js";
import { fetchPythPriceData } from "../core/leverup/pyth-client.js";
import { formatUsdPrice } from "../core/market/index.js";

const LeverUpGetMarketStatsSchema = z.object({
  symbol: z
    .string()
    .optional()
    .describe(
      "Asset symbol to get market stats for (e.g., 'BTC', 'ETH', 'MON', 'AAPL'). " +
        "If omitted, returns stats for all supported LeverUp pairs. " +
        "Use this to check current prices before opening positions."
    ),
});

interface MarketStats {
  symbol: string;
  category: string;
  currentPrice: string;
  priceConfidence: string;
  publishTime: string;
  isHighLeveragePair: boolean;
  pairBase: string;
}

interface LeverUpGetMarketStatsResult {
  success: boolean;
  message: string;
  data?: {
    markets: MarketStats[];
    supportedCategories: string[];
    note: string;
  };
  error?: string;
}

export function registerLeverUpGetMarketStats(server: McpServer): void {
  server.tool(
    "leverup_get_market_stats",
    "Get current market prices and stats for LeverUp trading pairs. " +
      "Returns real-time Pyth oracle prices for all supported markets (crypto, stocks, forex, commodities). " +
      "NOTE: Global Open Interest and Funding Rates are not yet available via public LeverUp API.",
    LeverUpGetMarketStatsSchema.shape,
    async (params): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await leverUpGetMarketStatsHandler(
        params as z.infer<typeof LeverUpGetMarketStatsSchema>
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}

async function leverUpGetMarketStatsHandler(
  params: z.infer<typeof LeverUpGetMarketStatsSchema>
): Promise<LeverUpGetMarketStatsResult> {
  try {
    // Filter pairs if symbol specified
    let pairs = SUPPORTED_PAIRS;
    if (params.symbol) {
      const normalized = params.symbol.toUpperCase().trim();
      pairs = SUPPORTED_PAIRS.filter(
        (p) =>
          p.pair.toUpperCase().startsWith(normalized) ||
          p.pair.toUpperCase() === `${normalized}/USD` ||
          p.pair.toUpperCase().includes(normalized)
      );

      if (pairs.length === 0) {
        return {
          success: false,
          message: `No LeverUp market found for '${params.symbol}'`,
          error: `Symbol '${params.symbol}' is not supported on LeverUp. ` +
            `Use leverup_list_pairs to see all available markets.`,
        };
      }
    }

    // Fetch prices from Pyth
    const priceIds = pairs.map((p) => p.pythId);
    const pythData = await fetchPythPriceData(priceIds as `0x${string}`[]);

    // Build market stats
    const markets: MarketStats[] = pairs.map((pair) => {
      const priceData = pythData.parsed?.find(
        (p) => `0x${p.id}` === pair.pythId
      );

      let currentPrice = "N/A";
      let confidence = "N/A";
      let publishTime = "N/A";

      if (priceData) {
        // Calculate price with proper decimals (expo is negative)
        const price =
          BigInt(priceData.price.price) *
          10n ** BigInt(18 + priceData.price.expo);
        const priceNum = Number(formatUnits(price, 18));
        currentPrice = formatUsdPrice(priceNum, true);

        // Confidence interval
        const conf =
          BigInt(priceData.price.conf) *
          10n ** BigInt(18 + priceData.price.expo);
        const confNum = Number(formatUnits(conf, 18));
        confidence = `\u00B1$${confNum < 1 ? confNum.toFixed(4) : confNum.toFixed(2)}`;

        // Publish time
        publishTime = new Date(
          priceData.price.publish_time * 1000
        ).toISOString();
      }

      return {
        symbol: pair.pair,
        category: pair.category,
        currentPrice,
        priceConfidence: confidence,
        publishTime,
        isHighLeveragePair: pair.isHighLeverage ?? false,
        pairBase: pair.pairBase,
      };
    });

    // Get unique categories
    const supportedCategories = [...new Set(markets.map((m) => m.category))];

    return {
      success: true,
      message: `Market stats for ${markets.length} LeverUp pair${markets.length > 1 ? "s" : ""}`,
      data: {
        markets,
        supportedCategories,
        note:
          "Global Open Interest and Funding Rates are not yet available via public LeverUp API. " +
          "These metrics will be added when LeverUp exposes them publicly.",
      },
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return {
      success: false,
      message: "Failed to fetch market stats",
      error: errorMessage,
    };
  }
}

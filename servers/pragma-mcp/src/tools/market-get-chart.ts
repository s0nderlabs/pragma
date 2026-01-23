import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fetchChartData, formatUsdPrice, type Resolution } from "../core/market/index.js";

const MarketGetChartSchema = z.object({
  symbol: z
    .string()
    .describe(
      "Asset symbol to get chart data for. " +
        "Examples: 'BTC', 'ETH', 'MON', 'SOL', 'AAPL', 'NVDA', 'TSLA', 'GOLD', 'EUR'. " +
        "Also accepts pair format like 'BTC/USD'. " +
        "CRITICAL: Use this to analyze price trends BEFORE making trading decisions."
    ),
  resolution: z
    .enum(["1", "5", "15", "30", "60", "240", "D", "1W", "1M"])
    .optional()
    .describe(
      "Candlestick timeframe: '1' (1min), '5', '15', '30', '60' (1hr), " +
        "'240' (4hr), 'D' (daily), '1W' (weekly), '1M' (monthly). Default: '60' (1 hour)."
    ),
  bars: z
    .number()
    .min(1)
    .max(500)
    .optional()
    .describe(
      "Number of candles to return (1-500). Default: 100. " +
        "More bars = longer history but larger response."
    ),
});

interface MarketGetChartResult {
  success: boolean;
  message: string;
  data?: {
    symbol: string;
    pythSymbol: string;
    resolution: string;
    resolutionLabel: string;
    latestPrice: number;
    priceChange: string;
    periodHigh: number;
    periodLow: number;
    candleCount: number;
    candles: Array<{
      timestamp: number;
      datetime: string;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    }>;
  };
  error?: string;
}

export function registerMarketGetChart(server: McpServer): void {
  server.tool(
    "market_get_chart",
    "Get OHLCV candlestick chart data for any asset (crypto, stocks, forex, commodities). " +
      "Returns price history with open/high/low/close/volume for technical analysis. " +
      "Data from Pyth Network - same oracle source used for LeverUp price feeds.",
    MarketGetChartSchema.shape,
    async (params): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await marketGetChartHandler(
        params as z.infer<typeof MarketGetChartSchema>
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}

async function marketGetChartHandler(
  params: z.infer<typeof MarketGetChartSchema>
): Promise<MarketGetChartResult> {
  try {
    const resolution = (params.resolution || "60") as Resolution;
    const bars = params.bars || 100;

    const chartData = await fetchChartData(params.symbol, resolution, bars);
    const priceStr = formatUsdPrice(chartData.latestPrice);

    return {
      success: true,
      message:
        `${chartData.symbol} ${chartData.resolutionLabel} chart: ` +
        `$${priceStr} (${chartData.priceChangePercent})`,
      data: {
        symbol: chartData.symbol,
        pythSymbol: chartData.pythSymbol,
        resolution: chartData.resolution,
        resolutionLabel: chartData.resolutionLabel,
        latestPrice: chartData.latestPrice,
        priceChange: chartData.priceChangePercent,
        periodHigh: chartData.periodHigh,
        periodLow: chartData.periodLow,
        candleCount: chartData.candles.length,
        candles: chartData.candles,
      },
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return {
      success: false,
      message: `Failed to get chart data for ${params.symbol}`,
      error: errorMessage,
    };
  }
}

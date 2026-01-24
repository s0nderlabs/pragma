import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { x402Fetch, getX402BaseUrl, isX402Mode } from "../core/x402/client.js";
import { loadConfig } from "../config/pragma-config.js";

const MarketGetCurrencyStrengthSchema = z.object({});

interface CurrencyStrength {
  currency: string;
  name: string;
  strength: number;
  sevenDayChange: number;
  momentum: "Strong Buy" | "Buy" | "Neutral" | "Sell" | "Strong Sell";
  trend: "bullish" | "bearish";
}

interface MarketGetCurrencyStrengthResult {
  success: boolean;
  message: string;
  data?: {
    currencies: CurrencyStrength[];
    strongest: string;
    weakest: string;
    calculatedAt: string;
  };
  error?: string;
}

export function registerMarketGetCurrencyStrength(server: McpServer): void {
  server.tool(
    "market_get_currency_strength",
    "Get currency strength matrix for major currencies (USD, EUR, GBP, JPY, etc.). " +
      "Returns strength scores (0-100), 7-day momentum, and trend signals. " +
      "Use to identify strong/weak currencies for FX trading decisions.",
    MarketGetCurrencyStrengthSchema.shape,
    async (): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await marketGetCurrencyStrengthHandler();
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}

async function marketGetCurrencyStrengthHandler(): Promise<MarketGetCurrencyStrengthResult> {
  const inX402Mode = await isX402Mode();
  if (!inX402Mode) {
    return {
      success: false,
      message: "Market intelligence requires x402 mode",
      error: "Please run set_mode with mode 'x402' first",
    };
  }

  try {
    const config = await loadConfig();
    const chainId = config?.network?.chainId || 143;

    const apiUrl = `${getX402BaseUrl()}/${chainId}/market/strength`;
    const response = await x402Fetch(apiUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(`API error (${response.status}): ${response.statusText}`);
    }

    const data = (await response.json()) as {
      success: boolean;
      data?: {
        currencies: CurrencyStrength[];
        strongest: string;
        weakest: string;
        calculatedAt: string;
      };
      error?: string;
    };

    if (!data.success) {
      throw new Error(data.error || "API returned unsuccessful response");
    }

    const currencyCount = data.data?.currencies?.length || 0;
    return {
      success: true,
      message: `Currency strength (${currencyCount} currencies): Strongest=${data.data?.strongest}, Weakest=${data.data?.weakest}`,
      data: data.data,
    };
  } catch (error) {
    return {
      success: false,
      message: "Failed to get currency strength",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

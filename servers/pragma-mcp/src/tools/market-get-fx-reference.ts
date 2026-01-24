import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { x402Fetch, getX402BaseUrl, isX402Mode } from "../core/x402/client.js";
import { loadConfig } from "../config/pragma-config.js";

const MarketGetFxReferenceSchema = z.object({
  base: z
    .string()
    .optional()
    .describe(
      "Base currency code for exchange rates. Default: 'USD'. " +
        "Examples: 'USD', 'EUR', 'GBP', 'JPY'. " +
        "Rates show how much of each currency equals 1 unit of base."
    ),
});

interface MarketGetFxReferenceResult {
  success: boolean;
  message: string;
  data?: {
    base: string;
    date: string;
    timestamp: string;
    rates: Record<string, number>;
    source: string;
  };
  error?: string;
}

export function registerMarketGetFxReference(server: McpServer): void {
  server.tool(
    "market_get_fx_reference",
    "Get current ECB exchange rates for major currencies. " +
      "Use to understand FX market conditions and currency valuations. " +
      "Returns rates relative to base currency (default USD).",
    MarketGetFxReferenceSchema.shape,
    async (params): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await marketGetFxReferenceHandler(
        params as z.infer<typeof MarketGetFxReferenceSchema>
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}

async function marketGetFxReferenceHandler(
  params: z.infer<typeof MarketGetFxReferenceSchema>
): Promise<MarketGetFxReferenceResult> {
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
    const base = params.base?.toUpperCase() || "USD";

    const apiUrl = `${getX402BaseUrl()}/${chainId}/market/fx-ref?base=${base}`;
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
        base: string;
        date: string;
        timestamp: string;
        rates: Record<string, number>;
        source: string;
      };
      error?: string;
    };

    if (!data.success) {
      throw new Error(data.error || "API returned unsuccessful response");
    }

    const rateCount = Object.keys(data.data?.rates || {}).length;
    return {
      success: true,
      message: `${base} exchange rates (${rateCount} currencies) as of ${data.data?.date}`,
      data: data.data,
    };
  } catch (error) {
    return {
      success: false,
      message: "Failed to get exchange rates",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

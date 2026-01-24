import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { x402Fetch, getX402BaseUrl, isX402Mode } from "../core/x402/client.js";
import { loadConfig } from "../config/pragma-config.js";

const MarketGetEconomicEventsSchema = z.object({});

interface EconomicEvent {
  id: string;
  title: string;
  country: string;
  impact: string;
  date: string;
  source: string;
}

interface MarketGetEconomicEventsResult {
  success: boolean;
  message: string;
  data?: {
    events: EconomicEvent[];
    count: number;
  };
  error?: string;
}

export function registerMarketGetEconomicEvents(server: McpServer): void {
  server.tool(
    "market_get_economic_events",
    "Get upcoming high-impact economic events (FOMC, NFP, CPI, GDP, etc.). " +
      "Returns events from Forex Factory with impact ratings. " +
      "Use to prepare for market-moving announcements.",
    MarketGetEconomicEventsSchema.shape,
    async (): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await marketGetEconomicEventsHandler();
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}

async function marketGetEconomicEventsHandler(): Promise<MarketGetEconomicEventsResult> {
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

    const apiUrl = `${getX402BaseUrl()}/${chainId}/market/events`;
    const response = await x402Fetch(apiUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(`API error (${response.status}): ${response.statusText}`);
    }

    const data = (await response.json()) as {
      success: boolean;
      events?: EconomicEvent[];
      error?: string;
    };

    if (!data.success) {
      throw new Error(data.error || "API returned unsuccessful response");
    }

    const events = data.events || [];
    return {
      success: true,
      message: `${events.length} upcoming high-impact economic events`,
      data: {
        events,
        count: events.length,
      },
    };
  } catch (error) {
    return {
      success: false,
      message: "Failed to get economic events",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

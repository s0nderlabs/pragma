import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { x402Fetch, getX402BaseUrl, isX402Mode } from "../core/x402/client.js";
import { loadConfig } from "../config/pragma-config.js";

const MarketGetWeeklyCalendarSchema = z.object({});

interface EconomicEvent {
  id: string;
  title: string;
  country: string;
  impact: string;
  date: string;
  source: string;
}

interface CalendarDay {
  date: string;
  dayOfWeek: string;
  events: EconomicEvent[];
}

interface MarketGetWeeklyCalendarResult {
  success: boolean;
  message: string;
  data?: {
    weekStart: string;
    weekEnd: string;
    days: CalendarDay[];
    totalEvents: number;
  };
  error?: string;
}

export function registerMarketGetWeeklyCalendar(server: McpServer): void {
  server.tool(
    "market_get_weekly_calendar",
    "Get this week's economic calendar grouped by day. " +
      "Returns high-impact events organized Monday-Friday. " +
      "Use to plan trading around scheduled releases.",
    MarketGetWeeklyCalendarSchema.shape,
    async (): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await marketGetWeeklyCalendarHandler();
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}

async function marketGetWeeklyCalendarHandler(): Promise<MarketGetWeeklyCalendarResult> {
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

    const apiUrl = `${getX402BaseUrl()}/${chainId}/market/calendar`;
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
        weekStart: string;
        weekEnd: string;
        days: CalendarDay[];
        totalEvents: number;
      };
      error?: string;
    };

    if (!data.success) {
      throw new Error(data.error || "API returned unsuccessful response");
    }

    return {
      success: true,
      message: `Weekly calendar (${data.data?.weekStart} to ${data.data?.weekEnd}): ${data.data?.totalEvents} events`,
      data: data.data,
    };
  } catch (error) {
    return {
      success: false,
      message: "Failed to get weekly calendar",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

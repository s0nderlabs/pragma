import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { x402Fetch, getX402BaseUrl, isX402Mode } from "../core/x402/client.js";
import { loadConfig } from "../config/pragma-config.js";

const MarketGetCriticalNewsSchema = z.object({
  limit: z
    .number()
    .min(1)
    .max(50)
    .optional()
    .describe("Maximum number of news items to return (1-50). Default: 50."),
});

interface NewsItem {
  id: number;
  headline: string;
  timestamp: string | null;
  economicData: Record<string, unknown> | null;
  tags: string[];
  isCritical: boolean;
  isHighImpact: boolean;
  sentiment: string | null;
  firstSeenAt: number;
  source: string;
}

interface MarketGetCriticalNewsResult {
  success: boolean;
  message: string;
  data?: {
    events: NewsItem[];
    count: number;
  };
  error?: string;
}

export function registerMarketGetCriticalNews(server: McpServer): void {
  server.tool(
    "market_get_critical_news",
    "Get critical and high-impact market news from the last 7 days. " +
      "Uses 5-layer red detection for critical news identification. " +
      "Includes central bank decisions, inflation data, and major market events.",
    MarketGetCriticalNewsSchema.shape,
    async (params): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await marketGetCriticalNewsHandler(
        params as z.infer<typeof MarketGetCriticalNewsSchema>
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}

async function marketGetCriticalNewsHandler(
  params: z.infer<typeof MarketGetCriticalNewsSchema>
): Promise<MarketGetCriticalNewsResult> {
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
    const limit = params.limit || 50;

    const apiUrl = `${getX402BaseUrl()}/${chainId}/market/news?limit=${limit}`;
    const response = await x402Fetch(apiUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(`API error (${response.status}): ${response.statusText}`);
    }

    const data = (await response.json()) as {
      success: boolean;
      events?: NewsItem[];
      error?: string;
    };

    if (!data.success) {
      throw new Error(data.error || "API returned unsuccessful response");
    }

    const events = data.events || [];
    const criticalCount = events.filter((e) => e.isCritical).length;
    const highImpactCount = events.filter((e) => e.isHighImpact).length;

    return {
      success: true,
      message: `${events.length} news items (${criticalCount} critical, ${highImpactCount} high-impact)`,
      data: {
        events,
        count: events.length,
      },
    };
  } catch (error) {
    return {
      success: false,
      message: "Failed to get critical news",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

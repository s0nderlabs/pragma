import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { x402Fetch, getX402BaseUrl, isX402Mode } from "../core/x402/client.js";
import { loadConfig } from "../config/pragma-config.js";

const MarketSearchNewsSchema = z.object({
  query: z.string().describe("Search keyword to find in news headlines. Examples: 'fed', 'inflation', 'bitcoin', 'trump'."),
  days: z
    .number()
    .min(1)
    .max(7)
    .optional()
    .describe("Time window for search (1-7 days). Default: 7."),
  limit: z
    .number()
    .min(1)
    .max(50)
    .optional()
    .describe("Maximum number of results (1-50). Default: 20."),
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

interface MarketSearchNewsResult {
  success: boolean;
  message: string;
  data?: {
    query: string;
    days: number;
    events: NewsItem[];
    count: number;
  };
  error?: string;
}

export function registerMarketSearchNews(server: McpServer): void {
  server.tool(
    "market_search_news",
    "Search news headlines by keyword over the last 7 days. " +
      "Use to find specific topics like 'fed', 'inflation', 'bitcoin', etc. " +
      "Returns matching news items sorted by recency.",
    MarketSearchNewsSchema.shape,
    async (params): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await marketSearchNewsHandler(
        params as z.infer<typeof MarketSearchNewsSchema>
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}

async function marketSearchNewsHandler(
  params: z.infer<typeof MarketSearchNewsSchema>
): Promise<MarketSearchNewsResult> {
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
    const { query } = params;
    const days = params.days || 7;
    const limit = params.limit || 20;

    const apiUrl = `${getX402BaseUrl()}/${chainId}/market/search?q=${encodeURIComponent(query)}&days=${days}&limit=${limit}`;
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
    return {
      success: true,
      message: `Found ${events.length} news items matching "${query}" (last ${days} days)`,
      data: {
        query,
        days,
        events,
        count: events.length,
      },
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to search news for "${params.query}"`,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

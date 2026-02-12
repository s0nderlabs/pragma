import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { x402Fetch, getX402BaseUrl, isX402Mode } from "../core/x402/client.js";
import { loadConfig } from "../config/pragma-config.js";

const XSearchSchema = z.object({
  query: z.string().describe(
    "Search query for recent tweets. Supports X search operators: " +
    "'lang:en', '-is:retweet', 'has:links', etc. " +
    "Examples: 'monad', 'monad lang:en -is:retweet', '@pragma_xyz'."
  ),
  max_results: z
    .number()
    .min(10)
    .max(100)
    .optional()
    .describe("Number of tweets to return (10-100). Default: 10. Cost scales linearly at $0.007/tweet."),
  sort_order: z
    .enum(["recency", "relevancy"])
    .optional()
    .describe("Sort order: 'recency' (default, newest first) or 'relevancy' (most relevant first)."),
});

interface Tweet {
  id: string;
  text: string;
  createdAt: string | null;
  author: { id: string; username: string; name: string } | null;
  metrics: {
    retweets: number;
    replies: number;
    likes: number;
    quotes: number;
    bookmarks: number;
    impressions: number;
  } | null;
}

interface XSearchResult {
  success: boolean;
  message: string;
  data?: {
    query: string;
    count: number;
    tweets: Tweet[];
    meta: { newestId: string; oldestId: string; resultCount: number } | null;
  };
  error?: string;
}

export function registerXSearch(server: McpServer): void {
  server.tool(
    "x_search",
    "Search recent tweets on X/Twitter. Returns tweets with author info and engagement metrics. " +
      "Supports X search operators. Cost: $0.007 per tweet returned (variable pricing).",
    XSearchSchema.shape,
    async (params): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await xSearchHandler(
        params as z.infer<typeof XSearchSchema>
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}

async function xSearchHandler(
  params: z.infer<typeof XSearchSchema>
): Promise<XSearchResult> {
  const inX402Mode = await isX402Mode();
  if (!inX402Mode) {
    return {
      success: false,
      message: "Social intelligence requires x402 mode",
      error: "Please run set_mode with mode 'x402' first",
    };
  }

  try {
    const config = await loadConfig();
    const chainId = config?.network?.chainId || 143;
    const { query } = params;
    const maxResults = params.max_results || 10;
    const sortOrder = params.sort_order || "recency";

    const apiUrl = `${getX402BaseUrl()}/${chainId}/x/search?q=${encodeURIComponent(query)}&max_results=${maxResults}&sort_order=${sortOrder}`;
    const response = await x402Fetch(apiUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(`API error (${response.status}): ${response.statusText}`);
    }

    const data = (await response.json()) as {
      success: boolean;
      query?: string;
      count?: number;
      tweets?: Tweet[];
      meta?: { newestId: string; oldestId: string; resultCount: number };
      error?: string;
    };

    if (!data.success) {
      throw new Error(data.error || "API returned unsuccessful response");
    }

    const tweets = data.tweets || [];
    return {
      success: true,
      message: `Found ${tweets.length} tweets matching "${query}"`,
      data: {
        query: data.query || query,
        count: data.count || tweets.length,
        tweets,
        meta: data.meta || null,
      },
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to search tweets for "${params.query}"`,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

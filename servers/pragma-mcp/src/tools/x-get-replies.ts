import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { x402Fetch, getX402BaseUrl, isX402Mode } from "../core/x402/client.js";
import { loadConfig } from "../config/pragma-config.js";

const XGetRepliesSchema = z.object({
  tweet_id: z.string().describe(
    "The numeric tweet ID to get replies for. " +
    "Example: '1893024529028493352'. Found in tweet URLs: x.com/user/status/{tweet_id}."
  ),
  max_results: z
    .number()
    .min(10)
    .max(100)
    .optional()
    .describe("Number of replies to return (10-100). Default: 10. Cost scales linearly at $0.007/reply."),
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
  conversationId?: string;
  referencedTweets?: Array<{ type: string; id: string; text?: string; author?: string }>;
}

interface XGetRepliesResult {
  success: boolean;
  message: string;
  data?: {
    tweetId: string;
    count: number;
    replies: Tweet[];
    meta: { newestId: string; oldestId: string; resultCount: number } | null;
  };
  error?: string;
}

export function registerXGetReplies(server: McpServer): void {
  server.tool(
    "x_get_replies",
    "Get replies to a specific tweet. Returns conversation participants sorted by recency " +
      "with author info and engagement metrics. Cost: $0.007 per reply returned (variable pricing).",
    XGetRepliesSchema.shape,
    async (params): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await xGetRepliesHandler(
        params as z.infer<typeof XGetRepliesSchema>
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}

async function xGetRepliesHandler(
  params: z.infer<typeof XGetRepliesSchema>
): Promise<XGetRepliesResult> {
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
    const maxResults = params.max_results || 10;

    const apiUrl = `${getX402BaseUrl()}/${chainId}/x/tweet/${params.tweet_id}/replies?max_results=${maxResults}`;
    const response = await x402Fetch(apiUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(`API error (${response.status}): ${response.statusText}`);
    }

    const data = (await response.json()) as {
      success: boolean;
      count?: number;
      replies?: Tweet[];
      meta?: { newestId: string; oldestId: string; resultCount: number };
      error?: string;
    };

    if (!data.success) {
      throw new Error(data.error || "API returned unsuccessful response");
    }

    const replies = data.replies || [];
    return {
      success: true,
      message: `Found ${replies.length} replies to tweet ${params.tweet_id}`,
      data: {
        tweetId: params.tweet_id,
        count: data.count || replies.length,
        replies,
        meta: data.meta || null,
      },
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to get replies for tweet "${params.tweet_id}"`,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

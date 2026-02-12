import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { x402Fetch, getX402BaseUrl, isX402Mode } from "../core/x402/client.js";
import { loadConfig } from "../config/pragma-config.js";

const XGetUserTweetsSchema = z.object({
  username: z.string().describe(
    "X/Twitter username to get tweets from (without @). Example: '0xelpabl0', 'naddotfun'."
  ),
  max_results: z
    .number()
    .min(10)
    .max(100)
    .optional()
    .describe("Number of tweets to return (10-100). Default: 10. Cost scales linearly at $0.007/tweet."),
  exclude: z
    .enum(["replies", "retweets"])
    .optional()
    .describe("Exclude tweet type: 'replies' or 'retweets'. Omit to include all."),
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

interface XGetUserTweetsResult {
  success: boolean;
  message: string;
  data?: {
    username: string;
    count: number;
    tweets: Tweet[];
    meta: { newestId: string; oldestId: string; resultCount: number } | null;
  };
  error?: string;
}

export function registerXGetUserTweets(server: McpServer): void {
  server.tool(
    "x_get_user_tweets",
    "Get a user's recent tweets by username. Returns their timeline with engagement metrics. " +
      "Can exclude replies or retweets. Cost: $0.007 per tweet returned (variable pricing).",
    XGetUserTweetsSchema.shape,
    async (params): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await xGetUserTweetsHandler(
        params as z.infer<typeof XGetUserTweetsSchema>
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}

async function xGetUserTweetsHandler(
  params: z.infer<typeof XGetUserTweetsSchema>
): Promise<XGetUserTweetsResult> {
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

    let apiUrl = `${getX402BaseUrl()}/${chainId}/x/user/${encodeURIComponent(params.username)}/tweets?max_results=${maxResults}`;
    if (params.exclude) {
      apiUrl += `&exclude=${params.exclude}`;
    }

    const response = await x402Fetch(apiUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(`API error (${response.status}): ${response.statusText}`);
    }

    const data = (await response.json()) as {
      success: boolean;
      username?: string;
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
      message: `Found ${tweets.length} tweets from @${params.username}`,
      data: {
        username: data.username || params.username,
        count: data.count || tweets.length,
        tweets,
        meta: data.meta || null,
      },
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to get tweets from "@${params.username}"`,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

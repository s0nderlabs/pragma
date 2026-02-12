import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { x402Fetch, getX402BaseUrl, isX402Mode } from "../core/x402/client.js";
import { loadConfig } from "../config/pragma-config.js";

const XGetTweetSchema = z.object({
  tweet_id: z.string().describe(
    "The numeric tweet ID to look up. " +
    "Example: '1893024529028493352'. Found in tweet URLs: x.com/user/status/{tweet_id}."
  ),
});

interface TweetData {
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

interface XGetTweetResult {
  success: boolean;
  message: string;
  data?: {
    tweet: TweetData;
  };
  error?: string;
}

export function registerXGetTweet(server: McpServer): void {
  server.tool(
    "x_get_tweet",
    "Look up a specific tweet by ID. Returns full tweet text, author info, and engagement metrics " +
      "(likes, retweets, replies, quotes, bookmarks, impressions). Cost: $0.007 per call.",
    XGetTweetSchema.shape,
    async (params): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await xGetTweetHandler(
        params as z.infer<typeof XGetTweetSchema>
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}

async function xGetTweetHandler(
  params: z.infer<typeof XGetTweetSchema>
): Promise<XGetTweetResult> {
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

    const apiUrl = `${getX402BaseUrl()}/${chainId}/x/tweet/${params.tweet_id}`;
    const response = await x402Fetch(apiUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(`API error (${response.status}): ${response.statusText}`);
    }

    const data = (await response.json()) as {
      success: boolean;
      tweet?: TweetData;
      error?: string;
    };

    if (!data.success) {
      throw new Error(data.error || "API returned unsuccessful response");
    }

    if (!data.tweet) {
      throw new Error("Tweet not found");
    }

    return {
      success: true,
      message: `Tweet by ${data.tweet.author?.username ? `@${data.tweet.author.username}` : "unknown"}`,
      data: { tweet: data.tweet },
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to look up tweet "${params.tweet_id}"`,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

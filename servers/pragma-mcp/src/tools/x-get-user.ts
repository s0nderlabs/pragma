import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { x402Fetch, getX402BaseUrl, isX402Mode } from "../core/x402/client.js";
import { loadConfig } from "../config/pragma-config.js";

const XGetUserSchema = z.object({
  username: z.string().describe(
    "X/Twitter username to look up (without @). Example: '0xelpabl0', 'vaborsh'."
  ),
});

interface UserData {
  id: string;
  name: string;
  username: string;
  description: string | null;
  createdAt: string | null;
  verified: boolean;
  profileImageUrl: string | null;
  metrics: {
    followers: number;
    following: number;
    tweets: number;
    listed: number;
    likes: number;
  } | null;
}

interface XGetUserResult {
  success: boolean;
  message: string;
  data?: {
    user: UserData;
  };
  error?: string;
}

export function registerXGetUser(server: McpServer): void {
  server.tool(
    "x_get_user",
    "Look up an X/Twitter user profile by username. Returns bio, follower count, tweet count, " +
      "account age, and verification status. Cost: $0.014 per call.",
    XGetUserSchema.shape,
    async (params): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await xGetUserHandler(
        params as z.infer<typeof XGetUserSchema>
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}

async function xGetUserHandler(
  params: z.infer<typeof XGetUserSchema>
): Promise<XGetUserResult> {
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

    const apiUrl = `${getX402BaseUrl()}/${chainId}/x/user/${encodeURIComponent(params.username)}`;
    const response = await x402Fetch(apiUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(`API error (${response.status}): ${response.statusText}`);
    }

    const data = (await response.json()) as {
      success: boolean;
      user?: UserData;
      error?: string;
    };

    if (!data.success) {
      throw new Error(data.error || "API returned unsuccessful response");
    }

    if (!data.user) {
      throw new Error("User not found");
    }

    return {
      success: true,
      message: `@${data.user.username}: ${data.user.metrics?.followers?.toLocaleString() || 0} followers`,
      data: { user: data.user },
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to look up user "${params.username}"`,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

// List Verified Tokens Tool
// Returns all verified/trusted tokens available for trading
// Use for "what tokens can I trade?" or token discovery
// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { VERIFIED_TOKENS } from "../config/verified-tokens.js";
import { loadVerifiedTokens, getAllTokens } from "../config/tokens.js";
import { loadConfig } from "../config/pragma-config.js";

const ListVerifiedTokensSchema = z.object({
  includeApi: z
    .boolean()
    .optional()
    .describe("Include tokens from Data API in addition to static list (default: true)"),
});

interface TokenEntry {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  categories?: string[];
}

interface ListVerifiedTokensResult {
  success: boolean;
  message: string;
  tokens: TokenEntry[];
  sources: string[];
  counts: {
    total: number;
    staticList: number;
    fromApi: number;
  };
}

export function registerListVerifiedTokens(server: McpServer): void {
  server.tool(
    "list_verified_tokens",
    "List all verified/trusted tokens available for trading. Use to discover tokens or answer 'what tokens can I trade?'. Returns 23+ tokens from static verified list plus any additional from Data API.",
    ListVerifiedTokensSchema.shape,
    async (params): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await listVerifiedTokensHandler(
        params as z.infer<typeof ListVerifiedTokensSchema>
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}

async function listVerifiedTokensHandler(
  params: z.infer<typeof ListVerifiedTokensSchema>
): Promise<ListVerifiedTokensResult> {
  const includeApi = params.includeApi !== false;
  const sources: string[] = ["static-verified-list"];
  const staticCount = VERIFIED_TOKENS.length;
  let apiCount = 0;

  // Start with static list (23 tokens)
  const tokenMap = new Map<string, TokenEntry>();
  for (const token of VERIFIED_TOKENS) {
    tokenMap.set(token.address.toLowerCase(), {
      symbol: token.symbol,
      name: token.name,
      address: token.address,
      decimals: token.decimals,
      categories: token.categories,
    });
  }

  // Optionally add API tokens
  if (includeApi) {
    try {
      const config = await loadConfig();
      if (config?.network?.chainId) {
        await loadVerifiedTokens(config.network.chainId);
        for (const token of getAllTokens()) {
          if (!tokenMap.has(token.address.toLowerCase())) {
            tokenMap.set(token.address.toLowerCase(), {
              symbol: token.symbol,
              name: token.name,
              address: token.address,
              decimals: token.decimals,
              categories: token.categories,
            });
            apiCount++;
          }
        }
        if (apiCount > 0) {
          sources.push("data-api");
        }
      }
    } catch {
      // Continue with static list only
    }
  }

  const tokens = Array.from(tokenMap.values());

  // Sort: MON first, then WMON, then alphabetically by symbol
  tokens.sort((a, b) => {
    if (a.symbol === "MON") return -1;
    if (b.symbol === "MON") return 1;
    if (a.symbol === "WMON") return -1;
    if (b.symbol === "WMON") return 1;
    return a.symbol.localeCompare(b.symbol);
  });

  return {
    success: true,
    message: `Found ${tokens.length} verified tokens (${staticCount} static + ${apiCount} from API)`,
    tokens,
    sources,
    counts: {
      total: tokens.length,
      staticList: staticCount,
      fromApi: apiCount,
    },
  };
}

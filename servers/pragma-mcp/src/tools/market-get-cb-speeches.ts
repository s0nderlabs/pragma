import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { x402Fetch, getX402BaseUrl, isX402Mode } from "../core/x402/client.js";
import { loadConfig } from "../config/pragma-config.js";

const MarketGetCbSpeechesSchema = z.object({
  bank: z
    .string()
    .optional()
    .describe(
      "Filter by central bank code. " +
        "Options: 'FED', 'ECB', 'BOE', 'BOC', 'RBA', 'BOJ', 'SNB', 'RBNZ'. " +
        "Leave empty for all banks."
    ),
  limit: z
    .number()
    .min(1)
    .max(50)
    .optional()
    .describe("Maximum number of speeches to return (1-50). Default: 20."),
});

interface SpeechItem {
  id: number;
  headline: string;
  timestamp: string | null;
  speaker: string | null;
  bank: string | null;
  contentType: string | null;
  isCritical: boolean;
  firstSeenAt: number;
  source: string;
}

interface MarketGetCbSpeechesResult {
  success: boolean;
  message: string;
  data?: {
    bank: string;
    speeches: SpeechItem[];
    count: number;
  };
  error?: string;
}

export function registerMarketGetCbSpeeches(server: McpServer): void {
  server.tool(
    "market_get_cb_speeches",
    "Get recent central bank speeches and policy announcements. " +
      "Filter by bank (FED, ECB, BOE, etc.) or get all. " +
      "Includes speaker names and content classification.",
    MarketGetCbSpeechesSchema.shape,
    async (params): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await marketGetCbSpeechesHandler(
        params as z.infer<typeof MarketGetCbSpeechesSchema>
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}

async function marketGetCbSpeechesHandler(
  params: z.infer<typeof MarketGetCbSpeechesSchema>
): Promise<MarketGetCbSpeechesResult> {
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
    const bank = params.bank?.toUpperCase();
    const limit = params.limit || 20;

    const bankParam = bank ? `&bank=${bank}` : "";
    const apiUrl = `${getX402BaseUrl()}/${chainId}/market/speeches?limit=${limit}${bankParam}`;

    const response = await x402Fetch(apiUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(`API error (${response.status}): ${response.statusText}`);
    }

    const data = (await response.json()) as {
      success: boolean;
      bank?: string;
      speeches?: SpeechItem[];
      error?: string;
    };

    if (!data.success) {
      throw new Error(data.error || "API returned unsuccessful response");
    }

    const speeches = data.speeches || [];
    const criticalCount = speeches.filter((s) => s.isCritical).length;

    return {
      success: true,
      message: `${speeches.length} speeches from ${bank || "all banks"} (${criticalCount} critical)`,
      data: {
        bank: data.bank || "all",
        speeches,
        count: speeches.length,
      },
    };
  } catch (error) {
    return {
      success: false,
      message: "Failed to get central bank speeches",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

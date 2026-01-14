// Set Mode Tool
// Switches between BYOK (free, user provides API keys) and x402 (paid per call) modes
// URLs are resolved at runtime based on mode - no URL manipulation needed
// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadConfig, saveConfig } from "../config/pragma-config.js";

const SetModeSchema = z.object({
  mode: z
    .enum(["byok", "x402"])
    .describe(
      "Mode to switch to. 'byok' (Bring Your Own Keys) = free, you provide API keys. 'x402' = pay per API call with USDC, no keys needed."
    ),
});

interface SetModeResult {
  success: boolean;
  message: string;
  mode?: "byok" | "x402";
  nextSteps?: string[];
  error?: string;
}

export function registerSetMode(server: McpServer): void {
  server.tool(
    "set_mode",
    "Switch between BYOK mode (free, provide your own API keys) and x402 mode (pay per API call with USDC). In x402 mode, all API calls go through the x402 proxy and are paid with USDC from your session key.",
    SetModeSchema.shape,
    async (params): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await setModeHandler(params as z.infer<typeof SetModeSchema>);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );
}

async function setModeHandler(
  params: z.infer<typeof SetModeSchema>
): Promise<SetModeResult> {
  try {
    // Load current config
    const config = await loadConfig();
    if (!config) {
      return {
        success: false,
        message: "Config not found",
        error: "Please run setup_wallet first to create your pragma wallet",
      };
    }

    const targetMode = params.mode;

    // Already in target mode
    if (config.mode === targetMode) {
      return {
        success: true,
        message: `Already in ${targetMode} mode`,
        mode: targetMode,
      };
    }

    // Just change the mode - URLs are resolved at runtime
    config.mode = targetMode;
    await saveConfig(config);

    const nextSteps =
      targetMode === "x402"
        ? [
            "Ensure your session key has USDC for API payments",
            "Check your session key balance",
            "Fund your session key with USDC if needed",
          ]
        : [
            "Configure your API providers using /pragma:providers",
            "Required: RPC endpoint URL",
            "Required: Bundler for transactions",
            "Optional: Quote and data providers for trading",
          ];

    return {
      success: true,
      message: `Switched to ${targetMode} mode`,
      mode: targetMode,
      nextSteps,
    };
  } catch (error) {
    return {
      success: false,
      message: "Failed to switch mode",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

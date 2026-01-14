// Has Providers Tool
// Checks provider configuration status
// In x402 mode, all providers go through api.pr4gma.xyz
// In BYOK mode, checks for adapter files in ~/.pragma/providers/
// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isX402Mode } from "../core/x402/client.js";
import { listAdapters } from "../core/adapters/loader.js";
import { hasProvider } from "../core/signer/index.js";
import { loadConfig } from "../config/pragma-config.js";

const HasProvidersSchema = z.object({});

interface ServiceStatus {
  hasAdapters: boolean;
  adapters: string[];
  activeAdapters?: string[];
}

interface HasProvidersResult {
  configured: boolean;
  mode: "x402" | "byok";
  services: {
    rpc: { configured: boolean };
    bundler: ServiceStatus;
    data: ServiceStatus;
    quote: ServiceStatus;
  };
  message: string;
  signerPath: string;
}

export function registerHasProviders(server: McpServer): void {
  server.tool(
    "has_providers",
    "Check which API providers are configured (RPC, bundler, data, quote). Use to verify provider setup before operations that require them.",
    HasProvidersSchema.shape,
    async (): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await hasProvidersHandler();
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}

async function hasProvidersHandler(): Promise<HasProvidersResult> {
  // Check mode first
  const inX402Mode = await isX402Mode();

  // Get signer path from environment
  const signerPath = process.env.PRAGMA_SIGNER_PATH || "pragma-signer";

  if (inX402Mode) {
    // x402 mode - all providers are available through proxy
    return {
      configured: true,
      mode: "x402",
      services: {
        rpc: { configured: true },
        bundler: { hasAdapters: true, adapters: ["proxy"] },
        data: { hasAdapters: true, adapters: ["proxy"] },
        quote: { hasAdapters: true, adapters: ["proxy"] },
      },
      message: "x402 mode active - all providers available via proxy",
      signerPath,
    };
  }

  // BYOK mode - check adapter files and config
  const config = await loadConfig();

  // Check RPC (stored directly in Keychain, not as adapter)
  let rpcConfigured = false;
  try {
    rpcConfigured = await hasProvider("rpc");
  } catch {
    // Signer not available or error
  }

  // Check adapter files for each service type
  const quoteAdapters = listAdapters("quote");
  const bundlerAdapters = listAdapters("bundler");
  const dataAdapters = listAdapters("data");

  // Get active adapters from config
  const activeQuote = config?.providers?.quote ?? [];
  const activeBundler = config?.providers?.bundler ?? [];
  const activeData = config?.providers?.data ?? [];

  // Determine if configured (needs at least RPC)
  const configured = rpcConfigured;

  // Build message with configured services
  const configuredServices: string[] = [];
  if (rpcConfigured) configuredServices.push("RPC");
  if (quoteAdapters.length > 0) configuredServices.push(`Quote (${quoteAdapters.length} adapter${quoteAdapters.length > 1 ? "s" : ""})`);
  if (bundlerAdapters.length > 0) configuredServices.push(`Bundler (${bundlerAdapters.length} adapter${bundlerAdapters.length > 1 ? "s" : ""})`);
  if (dataAdapters.length > 0) configuredServices.push(`Data (${dataAdapters.length} adapter${dataAdapters.length > 1 ? "s" : ""})`);

  return {
    configured,
    mode: "byok",
    services: {
      rpc: { configured: rpcConfigured },
      quote: {
        hasAdapters: quoteAdapters.length > 0,
        adapters: quoteAdapters,
        activeAdapters: activeQuote.length > 0 ? activeQuote : undefined,
      },
      bundler: {
        hasAdapters: bundlerAdapters.length > 0,
        adapters: bundlerAdapters,
        activeAdapters: activeBundler.length > 0 ? activeBundler : undefined,
      },
      data: {
        hasAdapters: dataAdapters.length > 0,
        adapters: dataAdapters,
        activeAdapters: activeData.length > 0 ? activeData : undefined,
      },
    },
    message: configured
      ? `BYOK mode - services configured: ${configuredServices.join(", ")}`
      : "BYOK mode - no providers configured. Run /pragma:providers to set up.",
    signerPath,
  };
}

// Has Providers Tool
// Checks which API providers are configured
// Safe read-only check - returns boolean status only
// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hasProvider } from "../core/signer/index.js";

const HasProvidersSchema = z.object({});

interface HasProvidersResult {
  configured: boolean;
  providers: {
    rpc: boolean;
    pimlico: boolean;
    monorail: boolean;
    "0x": boolean;
  };
  message: string;
}

export function registerHasProviders(server: McpServer): void {
  server.tool(
    "has_providers",
    "Check which API providers are configured (RPC, Pimlico, Monorail, 0x). Use to verify provider setup before operations that require them.",
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
  let rpc = false;
  let pimlico = false;
  let monorail = false;
  let zeroX = false;

  try {
    rpc = await hasProvider("rpc");
  } catch {
    // Signer not available or error
  }

  try {
    pimlico = await hasProvider("pimlico");
  } catch {
    // Signer not available or error
  }

  try {
    monorail = await hasProvider("monorail");
  } catch {
    // Signer not available or error
  }

  try {
    zeroX = await hasProvider("0x");
  } catch {
    // Signer not available or error
  }

  // RPC is required minimum
  const configured = rpc;

  // Build message with configured providers
  const configuredProviders = [
    rpc && "RPC",
    pimlico && "Pimlico",
    monorail && "Monorail",
    zeroX && "0x",
  ].filter(Boolean);

  return {
    configured,
    providers: { rpc, pimlico, monorail, "0x": zeroX },
    message: configured
      ? `Providers configured: ${configuredProviders.join(", ")}`
      : "RPC provider not configured. Run /pragma:providers to set up.",
  };
}

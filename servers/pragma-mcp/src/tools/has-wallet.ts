// Has Wallet Tool
// Checks if pragma wallet is initialized
// Safe read-only check - returns boolean status only
// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { hasPasskey, hasSessionKey } from "../core/signer/index.js";

const HasWalletSchema = z.object({});

interface HasWalletResult {
  initialized: boolean;
  details: {
    hasPasskey: boolean;
    hasSessionKey: boolean;
    hasConfig: boolean;
  };
  message: string;
}

export function registerHasWallet(server: McpServer): void {
  server.tool(
    "has_wallet",
    "Check if pragma wallet is initialized. Returns status of passkey, session key, and config. Use to verify setup before operations.",
    HasWalletSchema.shape,
    async (): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await hasWalletHandler();
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}

// Expand tilde in path to home directory
function expandTilde(filePath: string): string {
  if (filePath.startsWith("~/")) {
    return path.join(homedir(), filePath.slice(2));
  }
  return filePath;
}

async function hasWalletHandler(): Promise<HasWalletResult> {
  // Get config path from env or default, expanding ~ to home directory
  const rawPath =
    process.env.PRAGMA_CONFIG_PATH ||
    path.join(homedir(), ".pragma", "config.json");
  const configPath = expandTilde(rawPath);

  // Check each component
  const hasConfig = existsSync(configPath);

  let passkey = false;
  let sessionKey = false;

  try {
    passkey = await hasPasskey();
  } catch {
    // Signer not available or error - treat as no passkey
  }

  try {
    sessionKey = await hasSessionKey();
  } catch {
    // Signer not available or error - treat as no session key
  }

  const initialized = hasConfig && passkey && sessionKey;

  return {
    initialized,
    details: {
      hasPasskey: passkey,
      hasSessionKey: sessionKey,
      hasConfig,
    },
    message: initialized
      ? "Pragma wallet is configured and ready"
      : "Pragma wallet not fully configured. Run /pragma:setup to initialize.",
  };
}

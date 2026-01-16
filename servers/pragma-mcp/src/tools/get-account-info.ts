// Get Account Info Tool
// Returns wallet and account configuration info
// No API calls - reads from local config only
// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadConfig, isWalletConfigured } from "../config/pragma-config.js";
import { getChainConfig } from "../config/chains.js";

const GetAccountInfoSchema = z.object({});

interface GetAccountInfoResult {
  success: boolean;
  message: string;
  account?: {
    smartAccountAddress: string;
    sessionKeyAddress: string;
    keyId: string;
  };
  network?: {
    chainId: number;
    chainName: string;
    nativeCurrency: string;
    blockExplorer?: string;
  };
  mode?: "byok" | "x402";
  providers?: {
    quote?: string[];
    bundler?: string[];
    data?: string[];
  };
  status: {
    walletConfigured: boolean;
    providersConfigured: boolean;
  };
  error?: string;
}

export function registerGetAccountInfo(server: McpServer): void {
  server.tool(
    "get_account_info",
    "Get pragma wallet and account configuration. Returns smart account address, session key address, network info, and current mode (BYOK vs x402). Use to verify wallet setup or show user their account details.",
    GetAccountInfoSchema.shape,
    async (): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await getAccountInfoHandler();
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

/**
 * Get account info handler
 */
async function getAccountInfoHandler(): Promise<GetAccountInfoResult> {
  try {
    const config = await loadConfig();

    if (!config) {
      return {
        success: false,
        message: "Wallet not initialized",
        status: {
          walletConfigured: false,
          providersConfigured: false,
        },
        error: "No pragma configuration found. Run setup_wallet to create your wallet.",
      };
    }

    const walletConfigured = isWalletConfigured(config);
    const chainConfig = getChainConfig(config.network.chainId);

    // Check if providers are configured (BYOK mode only)
    const hasProviders = config.mode === "byok"
      ? !!(config.providers && (
          (config.providers.quote?.length ?? 0) > 0 ||
          (config.providers.data?.length ?? 0) > 0
        ))
      : true; // x402 mode doesn't need provider config

    if (!walletConfigured) {
      return {
        success: true,
        message: "Wallet partially configured - missing wallet addresses",
        network: {
          chainId: config.network.chainId,
          chainName: chainConfig.displayName,
          nativeCurrency: chainConfig.nativeCurrency.symbol,
          blockExplorer: chainConfig.blockExplorer,
        },
        mode: config.mode,
        providers: config.mode === "byok" ? config.providers : undefined,
        status: {
          walletConfigured: false,
          providersConfigured: hasProviders,
        },
      };
    }

    return {
      success: true,
      message: `Pragma wallet on ${chainConfig.displayName} (${config.mode} mode)`,
      account: {
        smartAccountAddress: config.wallet!.smartAccountAddress,
        sessionKeyAddress: config.wallet!.sessionKeyAddress,
        keyId: config.wallet!.keyId,
      },
      network: {
        chainId: config.network.chainId,
        chainName: chainConfig.displayName,
        nativeCurrency: chainConfig.nativeCurrency.symbol,
        blockExplorer: chainConfig.blockExplorer,
      },
      mode: config.mode,
      providers: config.mode === "byok" ? config.providers : undefined,
      status: {
        walletConfigured: true,
        providersConfigured: config.mode === "x402" || hasProviders,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return {
      success: false,
      message: "Failed to load account info",
      status: {
        walletConfigured: false,
        providersConfigured: false,
      },
      error: errorMessage,
    };
  }
}

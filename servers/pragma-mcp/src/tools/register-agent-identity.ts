/**
 * Register Agent Identity — ERC-8004 Identity Registry
 *
 * Registers the session key EOA on the ERC-8004 Identity Registry on Monad.
 * Mints an identity NFT to the session key with an agentURI pointing to
 * the per-user agent.json hosted on api.pr4gma.xyz.
 *
 * Copyright (c) 2026 s0nderlabs
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createPublicClient, createWalletClient, formatEther } from "viem";
import {
  loadConfig,
  saveConfig,
  isWalletConfigured,
  getRpcUrl,
} from "../config/pragma-config.js";
import { buildViemChain, getChainConfig } from "../config/chains.js";
import { getSessionKey, getSessionAccount } from "../core/session/keys.js";
import { createSyncHttpTransport } from "../core/x402/client.js";
import {
  getAgentRegistration,
  registerAgent,
  updateAgentURIOnChain,
  buildAgentURI,
  MIN_GAS_FOR_REGISTRATION,
} from "../core/identity/erc8004.js";

const RegisterAgentIdentitySchema = z.object({
  force: z
    .boolean()
    .optional()
    .describe(
      "Re-register even if already registered (mints a new identity NFT). " +
      "Default: false — returns existing registration if found.",
    ),
});

interface RegisterAgentIdentityResult {
  success: boolean;
  message: string;
  registration?: {
    agentId: string;
    txHash?: string;
    agentURI: string;
    sessionKeyAddress: string;
    explorerUrl: string;
  };
  error?: string;
}

export function registerRegisterAgentIdentity(server: McpServer): void {
  server.tool(
    "register_agent_identity",
    "Register this pragma agent on the ERC-8004 Identity Registry on Monad. " +
    "Mints an identity NFT to the session key with agent metadata. " +
    "No Touch ID required — session key signs directly. " +
    "CRITICAL: Session key must have at least 0.01 MON for gas.",
    RegisterAgentIdentitySchema.shape,
    async (params): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await registerAgentIdentityHandler(
        params as z.infer<typeof RegisterAgentIdentitySchema>,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}

async function registerAgentIdentityHandler(
  params: z.infer<typeof RegisterAgentIdentitySchema>,
): Promise<RegisterAgentIdentityResult> {
  try {
    // Load config
    const config = await loadConfig();
    if (!config || !isWalletConfigured(config)) {
      return {
        success: false,
        message: "Wallet not configured",
        error: "Run setup_wallet first to create your pragma wallet.",
      };
    }

    // Get session key
    const sessionKey = await getSessionKey();
    if (!sessionKey) {
      return {
        success: false,
        message: "Session key not found",
        error: "Run setup_wallet to generate a session key.",
      };
    }

    const sessionAccount = getSessionAccount(sessionKey);
    const chainId = config.network.chainId;
    const chainConfig = getChainConfig(chainId);
    const rpcUrl = await getRpcUrl(config);
    const chain = buildViemChain(chainId, rpcUrl);
    const transport = createSyncHttpTransport(rpcUrl, config);

    const publicClient = createPublicClient({ chain, transport });

    // Check existing registration — pass known tokenId from config for fast ownerOf check
    const knownTokenId = config.wallet!.agentId ? BigInt(config.wallet!.agentId) : undefined;
    const existing = await getAgentRegistration(
      publicClient,
      sessionAccount.address,
      knownTokenId,
    );

    if (existing.registered && existing.tokenId !== undefined && !params.force) {
      const agentURI = buildAgentURI(sessionAccount.address, config.wallet!.smartAccountAddress as `0x${string}`);

      // If registered but URI is empty/different, try to update it
      if (existing.agentURI !== agentURI) {
        const walletClient = createWalletClient({
          account: sessionAccount,
          chain,
          transport,
        });
        try {
          await updateAgentURIOnChain(
            walletClient,
            publicClient,
            existing.tokenId,
            agentURI,
            sessionAccount,
          );
        } catch (e) {
          console.error("[erc8004] URI update failed:", e instanceof Error ? e.message : e);
        }
      }

      // Save to config if not already saved
      if (!config.wallet!.agentId) {
        config.wallet!.agentId = existing.tokenId.toString();
        await saveConfig(config);
      }

      return {
        success: true,
        message: "Agent already registered on ERC-8004 Identity Registry",
        registration: {
          agentId: existing.tokenId.toString(),
          agentURI,
          sessionKeyAddress: sessionAccount.address,
          explorerUrl: chainConfig.blockExplorer
            ? `${chainConfig.blockExplorer}/token/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432?a=${sessionAccount.address}`
            : "",
        },
      };
    }

    // Check gas balance before attempting registration
    const gasBalance = await publicClient.getBalance({
      address: sessionAccount.address,
    });
    if (gasBalance < MIN_GAS_FOR_REGISTRATION) {
      return {
        success: false,
        message: "Insufficient gas for registration",
        error: `Session key has ${formatEther(gasBalance)} MON. Need at least 0.01 MON. Fund session key first.`,
      };
    }

    // Register
    const walletClient = createWalletClient({
      account: sessionAccount,
      chain,
      transport,
    });
    const agentURI = buildAgentURI(sessionAccount.address, config.wallet!.smartAccountAddress as `0x${string}`);
    const result = await registerAgent(walletClient, publicClient, agentURI, sessionAccount);

    // Save agentId to config
    config.wallet!.agentId = result.tokenId.toString();
    await saveConfig(config);

    return {
      success: true,
      message: `Agent registered on ERC-8004 Identity Registry (token #${result.tokenId})`,
      registration: {
        agentId: result.tokenId.toString(),
        txHash: result.txHash,
        agentURI,
        sessionKeyAddress: sessionAccount.address,
        explorerUrl: chainConfig.blockExplorer
          ? `${chainConfig.blockExplorer}/tx/${result.txHash}`
          : "",
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return {
      success: false,
      message: "Registration failed",
      error: errorMessage,
    };
  }
}

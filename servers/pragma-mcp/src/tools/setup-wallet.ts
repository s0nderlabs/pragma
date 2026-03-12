// Setup Wallet — creates passkey + smart account with P-256 signing
// File-mode fallback for headless environments (OpenClaw, Linux, Docker)
// Private keys NEVER leave the Keychain (macOS) or secure file storage (headless)
// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { registerAgentInSetup } from "../core/identity/erc8004.js";
import {
  createPasskey,
  getPasskeyPublicKey,
  hasPasskey,
  parseP256PublicKey,
} from "../core/signer/index.js";
import {
  createHybridDelegatorHandle,
  isSmartAccountDeployed,
} from "../core/account/hybridDelegator.js";
import { deploySmartAccount } from "../core/account/deployment.js";
import {
  generateSessionKey,
  getSessionKey,
  storeSessionKey,
} from "../core/session/keys.js";
import {
  createInitialConfig,
  isWalletConfigured,
  loadConfig,
  saveConfig,
} from "../config/pragma-config.js";
import {
  getChainConfig,
  getSupportedChainIds,
  isChainSupported,
  validateRpcEndpoint,
} from "../config/chains.js";

/** Check if running in headless/file-based signer mode */
function isFileMode(): boolean {
  return process.env.PRAGMA_SIGNER_TYPE === "file";
}

const SetupWalletSchema = z.object({
  rpc: z.string().url().optional().describe("RPC endpoint URL. Required for BYOK mode. Omit for x402 mode (auto-configured)."),
  chainId: z.number().optional().describe("Chain ID (auto-detected from RPC if not provided)"),
});

interface SetupResult {
  success: boolean;
  message: string;
  wallet?: {
    smartAccountAddress: string;
    sessionKeyAddress: string;
    keyId: string;
    signingMethod: string;
    chainId: number;
    chainName: string;
    agentId?: string;
    registrationStatus?: string;
  };
  error?: string;
}

export function registerSetupWallet(server: McpServer): void {
  server.tool(
    "setup_wallet",
    "Initialize a new pragma wallet with passkey and smart account. This creates a P-256 key in Keychain (via Touch ID) and deploys a smart account. Private keys NEVER leave your device. Required before any trading operations.",
    SetupWalletSchema.shape,
    async (params): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await setupWallet(params as z.infer<typeof SetupWalletSchema>);

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
 * Headless setup for file-based signer mode (OpenClaw, Linux, Docker).
 *
 * Unlike the passkey flow, this does NOT create a Smart Account or passkey.
 * The user already has a SA (via pragma-wallet on their phone/laptop).
 * We only need a session key + minimal config. The user then provides their
 * SA address during the delegation flow.
 */
async function setupWalletHeadless(params: z.infer<typeof SetupWalletSchema>): Promise<SetupResult> {
  let { chainId } = params;

  try {
    // Check if already configured
    const existingConfig = await loadConfig();
    if (existingConfig) {
      const sessionKey = await getSessionKey();
      if (sessionKey) {
        const chainConfig = getChainConfig(existingConfig.network.chainId);
        return {
          success: true,
          message: "Session key already configured",
          wallet: {
            smartAccountAddress: existingConfig.wallet?.smartAccountAddress ?? "not set — provide via delegation",
            sessionKeyAddress: sessionKey.address,
            keyId: "file-based",
            signingMethod: "secp256k1 (file-based)",
            chainId: existingConfig.network.chainId,
            chainName: chainConfig.displayName,
          },
        };
      }
    }

    // Resolve chain ID (default to Monad mainnet)
    chainId = chainId ?? 143;
    if (!isChainSupported(chainId)) {
      const supported = getSupportedChainIds().join(", ");
      return {
        success: false,
        message: "Chain not supported",
        error: `Chain ${chainId} is not supported. Supported chains: ${supported}`,
      };
    }
    const chainConfig = getChainConfig(chainId);

    // Create config (mode: x402, no wallet section yet — SA comes from delegation)
    const config = existingConfig || createInitialConfig(chainId);
    config.network.chainId = chainId;
    await saveConfig(config);

    // Generate and store session key (file-based via signer module)
    let sessionKey = await getSessionKey();
    if (!sessionKey) {
      sessionKey = generateSessionKey();
      await storeSessionKey(sessionKey);
    }

    return {
      success: true,
      message: `Session key created on ${chainConfig.displayName}. Provide your Smart Account address to continue setup via delegation.`,
      wallet: {
        smartAccountAddress: "not set — provide via delegation",
        sessionKeyAddress: sessionKey.address,
        keyId: "file-based",
        signingMethod: "secp256k1 (file-based)",
        chainId,
        chainName: chainConfig.displayName,
      },
    };
  } catch (error) {
    return mapSetupError(error);
  }
}

/**
 * Orchestrates wallet onboarding: passkey creation, smart account deployment,
 * and session key generation.
 */
async function setupWallet(params: z.infer<typeof SetupWalletSchema>): Promise<SetupResult> {
  // Headless mode: skip passkey/SA, just create session key + config
  if (isFileMode()) {
    return setupWalletHeadless(params);
  }

  const { rpc } = params;
  let { chainId } = params;

  try {
    // Return early if wallet already exists
    const existingConfig = await loadConfig();
    if (existingConfig && isWalletConfigured(existingConfig)) {
      const chainConfig = getChainConfig(existingConfig.network.chainId);
      return {
        success: true,
        message: "Wallet already configured",
        wallet: {
          smartAccountAddress: existingConfig.wallet!.smartAccountAddress,
          sessionKeyAddress: existingConfig.wallet!.sessionKeyAddress,
          keyId: existingConfig.wallet!.keyId || "unknown",
          signingMethod: "P-256 (Touch ID)",
          chainId: existingConfig.network.chainId,
          chainName: chainConfig.displayName,
        },
      };
    }

    // Resolve chain ID: BYOK validates RPC, x402 defaults to Monad mainnet
    if (rpc) {
      const validation = await validateRpcEndpoint(rpc, chainId ?? 0);
      if (!validation.valid) {
        return {
          success: false,
          message: chainId ? "RPC validation failed" : "Failed to connect to RPC",
          error: validation.error || "Could not connect to RPC endpoint",
        };
      }
      const resolvedChainId = validation.actualChainId ?? chainId;
      if (!resolvedChainId) {
        return {
          success: false,
          message: "Failed to detect chain ID",
          error: "RPC did not return a valid chain ID",
        };
      }
      chainId = resolvedChainId;
    } else {
      chainId = chainId ?? 143;
    }

    if (!isChainSupported(chainId)) {
      const supported = getSupportedChainIds().join(", ");
      return {
        success: false,
        message: "Chain not supported",
        error: `Chain ${chainId} is not supported. Supported chains: ${supported}`,
      };
    }

    const chainConfig = getChainConfig(chainId);

    // RPC is only used for validation above; actual URLs are resolved at runtime based on mode
    const config = existingConfig || createInitialConfig(chainId);
    config.network.chainId = chainId;

    // Create or retrieve passkey
    let passkeyPublicKey: `0x${string}`;
    let isNewPasskey = false;

    if (await hasPasskey()) {
      const existingKey = await getPasskeyPublicKey();
      if (!existingKey) {
        return {
          success: false,
          message: "Failed to retrieve existing passkey",
          error: "Passkey exists but could not retrieve public key",
        };
      }
      passkeyPublicKey = existingKey;
    } else {
      passkeyPublicKey = await createPasskey("Create pragma wallet");
      isNewPasskey = true;
    }

    const coords = parseP256PublicKey(passkeyPublicKey);
    console.error(`P-256 Public Key ${isNewPasskey ? "created" : "retrieved"}:`);
    console.error(`  X: 0x${coords.x.toString(16).slice(0, 16)}...`);
    console.error(`  Y: 0x${coords.y.toString(16).slice(0, 16)}...`);

    // During x402 setup, use a free public RPC to avoid the x402 proxy chicken-and-egg:
    // viem's toSmartAccount internally calls getCode via the public client, but the
    // x402 proxy returns 402 and x402Fetch can't pay (no config on disk, no session key).
    const setupRpcOverride = rpc ? undefined : chainConfig.publicRpc;
    const handle = await createHybridDelegatorHandle(config, {
      rpcOverride: setupRpcOverride,
    });

    // Session key must exist before deployment for bootstrap registration
    let sessionKey = await getSessionKey();
    if (!sessionKey) {
      sessionKey = generateSessionKey();
      await storeSessionKey(sessionKey);
    }

    // New passkeys cannot have a deployed account, so skip the RPC check
    const alreadyDeployed = !isNewPasskey && await isSmartAccountDeployed(handle);

    if (!alreadyDeployed) {
      const deployOptions = isNewPasskey ? { skipInitialChecks: true } : undefined;
      const deployResult = await deploySmartAccount(
        handle, config, sessionKey.address, deployOptions
      );

      if (!deployResult.success) {
        return {
          success: false,
          message: "Smart account deployment failed",
          error: deployResult.error || "Unknown deployment error",
        };
      }
    }

    // Passkey public key lives in Keychain; only addresses and keyId are persisted to config
    config.wallet = {
      smartAccountAddress: handle.address,
      sessionKeyAddress: sessionKey.address,
      keyId: handle.keyId,
    };

    await saveConfig(config);

    // ERC-8004 Identity Registration (best-effort, non-blocking)
    let agentId: string | undefined;
    let registrationStatus = "skipped";
    try {
      const regResult = await registerAgentInSetup(config, chainId);
      registrationStatus = regResult.status;
      if (regResult.tokenId) {
        agentId = regResult.tokenId.toString();
        config.wallet!.agentId = agentId;
        await saveConfig(config);
      }
    } catch {
      registrationStatus = "failed";
    }

    return {
      success: true,
      message: `Wallet created on ${chainConfig.displayName}`,
      wallet: {
        smartAccountAddress: handle.address,
        sessionKeyAddress: sessionKey.address,
        keyId: handle.keyId,
        signingMethod: "P-256 (Touch ID)",
        chainId,
        chainName: chainConfig.displayName,
        agentId,
        registrationStatus,
      },
    };
  } catch (error) {
    return mapSetupError(error);
  }
}

/**
 * Maps known error patterns to user-friendly SetupResult messages.
 */
function mapSetupError(error: unknown): SetupResult {
  const errorMessage = error instanceof Error ? error.message : "Unknown error";

  if (errorMessage.includes("Touch ID") || errorMessage.includes("biometric")) {
    return {
      success: false,
      message: "Touch ID authentication required",
      error: "Please authenticate with Touch ID to create your wallet",
    };
  }

  if (errorMessage.includes("not available")) {
    return {
      success: false,
      message: "Secure Enclave not available",
      error: "This device does not support Touch ID. macOS with Touch ID is required.",
    };
  }

  if (errorMessage.includes("DEPRECATED")) {
    return {
      success: false,
      message: "Using outdated code",
      error: errorMessage,
    };
  }

  return {
    success: false,
    message: "Setup failed",
    error: errorMessage,
  };
}

// Setup Wallet Tool
// Creates passkey + smart account for the user
// Uses native P-256 signing - private keys NEVER leave the Keychain
// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
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
  storeSessionKey,
  getSessionKey,
} from "../core/session/keys.js";
import {
  loadConfig,
  saveConfig,
  createInitialConfig,
  isWalletConfigured,
} from "../config/pragma-config.js";
import {
  validateRpcEndpoint,
  isChainSupported,
  getChainConfig,
  getSupportedChainIds,
} from "../config/chains.js";

const SetupWalletSchema = z.object({
  rpc: z.string().url().describe("RPC endpoint URL for your network"),
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
 * Main setup wallet function
 * Orchestrates all onboarding steps with secure P-256 signing
 */
async function setupWallet(params: z.infer<typeof SetupWalletSchema>): Promise<SetupResult> {
  const { rpc } = params;
  let { chainId } = params;

  try {
    // Step 1: Check if already set up
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

    // Step 2: Validate RPC endpoint and detect chain ID
    const validation = await validateRpcEndpoint(rpc, chainId ?? 0);
    if (!validation.valid) {
      // When detecting (chainId was undefined), valid is true if connection succeeded
      // So if not valid, either connection failed or chain mismatch
      return {
        success: false,
        message: chainId ? "RPC validation failed" : "Failed to connect to RPC",
        error: validation.error || "Could not connect to RPC endpoint",
      };
    }
    // Use detected chain ID if not provided
    const resolvedChainId = validation.actualChainId ?? chainId;
    if (!resolvedChainId) {
      return {
        success: false,
        message: "Failed to detect chain ID",
        error: "RPC did not return a valid chain ID",
      };
    }
    chainId = resolvedChainId;

    // Step 3: Check chain is supported
    if (!isChainSupported(chainId)) {
      const supported = getSupportedChainIds().join(", ");
      return {
        success: false,
        message: "Chain not supported",
        error: `Chain ${chainId} is not supported. Supported chains: ${supported}`,
      };
    }

    const chainConfig = getChainConfig(chainId);

    // Step 4: Create initial config
    let config = existingConfig || createInitialConfig(chainId, rpc);
    config.network.rpc = rpc;
    config.network.chainId = chainId;

    // Step 5: Create or retrieve passkey
    let passkeyPublicKey: `0x${string}`;

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
      // Create new passkey (triggers Touch ID)
      passkeyPublicKey = await createPasskey("Create pragma wallet");
    }

    // Log public key info (for debugging, no sensitive data)
    const coords = parseP256PublicKey(passkeyPublicKey);
    console.log("P-256 Public Key created:");
    console.log(`  X: 0x${coords.x.toString(16).slice(0, 16)}...`);
    console.log(`  Y: 0x${coords.y.toString(16).slice(0, 16)}...`);

    // Step 6: Create smart account handle with P-256 passkey
    // This uses native P-256 signing - private key NEVER leaves Keychain
    const handle = await createHybridDelegatorHandle(config);

    // Step 7: Check if smart account is deployed
    const deployed = await isSmartAccountDeployed(handle);

    if (!deployed) {
      // Step 8: Deploy smart account via bundler
      const deployResult = await deploySmartAccount(handle, config);

      if (!deployResult.success) {
        return {
          success: false,
          message: "Smart account deployment failed",
          error: deployResult.error || "Unknown deployment error",
        };
      }
    }

    // Step 9: Generate or retrieve session key
    let sessionKey = await getSessionKey();
    if (!sessionKey) {
      sessionKey = generateSessionKey();
      await storeSessionKey(sessionKey);
    }

    // Step 10: Save config with P-256 info
    config.wallet = {
      smartAccountAddress: handle.address,
      sessionKeyAddress: sessionKey.address,
      passkeyPublicKey,
      keyId: handle.keyId,
    };

    await saveConfig(config);

    // Success!
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
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    // Handle specific error cases
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
}

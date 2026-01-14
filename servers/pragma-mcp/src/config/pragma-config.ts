// pragma Config Management
// Handles reading/writing ~/.pragma/config.json
// Copyright (c) 2026 s0nderlabs

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PragmaConfig } from "../types/index.js";
import { getChainConfig } from "./chains.js";

/**
 * Get the path to the pragma config file
 * Defaults to ~/.pragma/config.json
 * Can be overridden with PRAGMA_CONFIG_PATH env var
 */
export function getConfigPath(): string {
  const configPath = process.env.PRAGMA_CONFIG_PATH;
  if (configPath) {
    return configPath.replace("~", process.env.HOME || "");
  }
  return path.join(process.env.HOME || "", ".pragma", "config.json");
}

/**
 * Get the pragma config directory
 */
export function getConfigDir(): string {
  return path.dirname(getConfigPath());
}

/**
 * Ensure the config directory exists
 * Creates ~/.pragma/ if it doesn't exist
 */
export async function ensureConfigDir(): Promise<void> {
  const configDir = getConfigDir();
  // mkdir with recursive: true never throws EEXIST
  await fs.mkdir(configDir, { recursive: true });
}

/**
 * Check if config file exists
 */
export async function configExists(): Promise<boolean> {
  try {
    await fs.access(getConfigPath());
    return true;
  } catch {
    return false;
  }
}

/**
 * Migrate old config format to new format
 * Removes deprecated fields: rpc, bundler, apis, passkeyPublicKey
 * Normalizes mode to "byok" | "x402"
 */
function migrateConfig(rawConfig: Record<string, unknown>): PragmaConfig {
  // Normalize mode (handle legacy names)
  let mode: "byok" | "x402" = "x402";
  if (rawConfig.mode === "diy" || rawConfig.mode === "byok") {
    mode = "byok";
  } else if (rawConfig.mode === "convenient" || rawConfig.mode === "x402") {
    mode = "x402";
  }

  // Extract network (remove deprecated rpc field)
  const network = rawConfig.network as Record<string, unknown> | undefined;
  const chainId = network?.chainId as number | undefined;
  const name = network?.name as string | undefined;

  if (!chainId) {
    throw new Error("Invalid config: missing network.chainId");
  }

  // Get chain name if missing
  const chainConfig = getChainConfig(chainId);
  const networkName = name || chainConfig.name;

  // Build new config
  const config: PragmaConfig = {
    mode,
    network: {
      chainId,
      name: networkName,
    },
  };

  // Migrate wallet if present (remove passkeyPublicKey)
  const wallet = rawConfig.wallet as Record<string, unknown> | undefined;
  if (wallet) {
    const smartAccountAddress = wallet.smartAccountAddress as `0x${string}` | undefined;
    const sessionKeyAddress = wallet.sessionKeyAddress as `0x${string}` | undefined;
    const keyId = wallet.keyId as string | undefined;

    if (smartAccountAddress && sessionKeyAddress && keyId) {
      config.wallet = {
        smartAccountAddress,
        sessionKeyAddress,
        keyId,
      };
    }
  }

  // Preserve providers field if present
  const providers = rawConfig.providers as {
    quote?: string[];
    bundler?: string[];
    data?: string[];
  } | undefined;
  if (providers) {
    config.providers = providers;
  }

  return config;
}

/**
 * Load the pragma config
 * Automatically migrates old config format to new format
 * @returns Config object or null if not found
 * @throws Error if config is malformed
 */
export async function loadConfig(): Promise<PragmaConfig | null> {
  const configPath = getConfigPath();

  try {
    const content = await fs.readFile(configPath, "utf-8");
    const rawConfig = JSON.parse(content) as Record<string, unknown>;

    // Migrate and validate
    const config = migrateConfig(rawConfig);

    // Check if migration changed anything (compare stringified versions)
    const originalStr = JSON.stringify(rawConfig);
    const migratedStr = JSON.stringify(config);
    if (originalStr !== migratedStr) {
      // Save migrated config
      await saveConfig(config);
      console.log("[config] Migrated config to new format");
    }

    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * Save the pragma config
 * Creates the config directory if it doesn't exist
 * @param config - Config object to save
 */
export async function saveConfig(config: PragmaConfig): Promise<void> {
  await ensureConfigDir();

  const configPath = getConfigPath();

  // Write atomically using a temp file
  const tempPath = `${configPath}.tmp`;
  const content = JSON.stringify(config, null, 2);

  await fs.writeFile(tempPath, content, "utf-8");
  await fs.rename(tempPath, configPath);
}

/**
 * Delete the pragma config
 */
export async function deleteConfig(): Promise<void> {
  const configPath = getConfigPath();
  try {
    await fs.unlink(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

/**
 * Check if wallet is fully configured
 * @returns true if config has all wallet fields populated
 */
export function isWalletConfigured(config: PragmaConfig | null): boolean {
  if (!config?.wallet) return false;
  return !!(
    config.wallet.smartAccountAddress &&
    config.wallet.sessionKeyAddress &&
    config.wallet.keyId
  );
}

/**
 * Get chain config for the configured network
 */
export function getConfiguredChainConfig(config: PragmaConfig) {
  return getChainConfig(config.network.chainId);
}

/**
 * Create a minimal config for initial setup
 * URLs are resolved at runtime based on mode
 * @param chainId - Chain ID to configure
 */
export function createInitialConfig(chainId: number): PragmaConfig {
  const chainConfig = getChainConfig(chainId);

  return {
    mode: "x402", // Default to x402 mode (pay per API call)
    network: {
      chainId,
      name: chainConfig.name,
    },
  };
}

/**
 * Update config with wallet info after setup
 */
export async function updateConfigWithWallet(
  smartAccountAddress: `0x${string}`,
  sessionKeyAddress: `0x${string}`,
  keyId: string
): Promise<PragmaConfig> {
  const config = await loadConfig();
  if (!config) {
    throw new Error("Config not found. Run setup first.");
  }

  config.wallet = {
    smartAccountAddress,
    sessionKeyAddress,
    keyId,
  };

  await saveConfig(config);
  return config;
}

/**
 * Get RPC URL based on mode
 * - x402 mode: Construct URL from hardcoded constant
 * - BYOK mode: Read from Keychain ONLY (no fallback)
 */
export async function getRpcUrl(config: PragmaConfig): Promise<string> {
  if (config.mode === "x402") {
    // x402: Construct from hardcoded constant
    const { getX402BaseUrl } = await import("../core/x402/client.js");
    return `${getX402BaseUrl()}/${config.network.chainId}/rpc`;
  }

  // BYOK: Keychain ONLY, no fallback
  const { getProvider } = await import("../core/signer/index.js");
  const keychainRpc = await getProvider("rpc");
  if (!keychainRpc) {
    throw new Error(
      "RPC not configured. Run /pragma:providers to set your RPC endpoint."
    );
  }
  return keychainRpc;
}

/**
 * Get bundler URL based on mode
 * - x402 mode: Construct URL from hardcoded constant
 * - BYOK mode: Read from Keychain ONLY (no fallback)
 */
export async function getBundlerUrl(config: PragmaConfig): Promise<string> {
  if (config.mode === "x402") {
    // x402: Construct from hardcoded constant
    const { getX402BaseUrl } = await import("../core/x402/client.js");
    return `${getX402BaseUrl()}/${config.network.chainId}/bundler`;
  }

  // BYOK: Check for bundler URL in Keychain
  // Note: Bundler uses direct URL storage (not adapter system) due to JSON-RPC nature
  const { getProvider } = await import("../core/signer/index.js");
  const bundlerUrl = await getProvider("bundler");
  if (!bundlerUrl) {
    throw new Error(
      "Bundler not configured. Run /pragma:providers to set up your bundler provider."
    );
  }
  return bundlerUrl;
}

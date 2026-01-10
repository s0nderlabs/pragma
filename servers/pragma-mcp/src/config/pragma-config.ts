// pragma Config Management
// Handles reading/writing ~/.pragma/config.json
// Copyright (c) 2026 s0nderlabs

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PragmaConfig } from "../types/index.js";
import { getChainConfig, buildViemChain } from "./chains.js";
import type { Chain } from "viem";

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
 * Load the pragma config
 * @returns Config object or null if not found
 * @throws Error if config is malformed
 */
export async function loadConfig(): Promise<PragmaConfig | null> {
  const configPath = getConfigPath();

  try {
    const content = await fs.readFile(configPath, "utf-8");
    const config = JSON.parse(content) as PragmaConfig;

    // Basic validation
    if (!config.mode || !config.network?.chainId || !config.network?.rpc) {
      throw new Error("Invalid config: missing required fields");
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
    config.wallet.passkeyPublicKey
  );
}

/**
 * Build a viem Chain object from the config
 * Convenience function for creating chain from saved config
 */
export function buildChainFromConfig(config: PragmaConfig): Chain {
  return buildViemChain(config.network.chainId, config.network.rpc);
}

/**
 * Get chain config for the configured network
 */
export function getConfiguredChainConfig(config: PragmaConfig) {
  return getChainConfig(config.network.chainId);
}

/**
 * Create a minimal config for initial setup
 * @param chainId - Chain ID to configure
 * @param rpc - RPC URL
 */
export function createInitialConfig(chainId: number, rpc: string): PragmaConfig {
  const chainConfig = getChainConfig(chainId);

  return {
    mode: "diy",
    network: {
      chainId,
      rpc,
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
  passkeyPublicKey: `0x${string}`
): Promise<PragmaConfig> {
  const config = await loadConfig();
  if (!config) {
    throw new Error("Config not found. Run setup first.");
  }

  config.wallet = {
    smartAccountAddress,
    sessionKeyAddress,
    passkeyPublicKey,
  };

  await saveConfig(config);
  return config;
}

/**
 * Get bundler URL from config or environment
 * Falls back to Pimlico URL constructed from API key
 */
export function getBundlerUrl(config: PragmaConfig): string | null {
  // Check config first
  if (config.bundler?.url) {
    return config.bundler.url;
  }

  // Fall back to env var
  const apiKey = process.env.PIMLICO_API_KEY;
  if (apiKey) {
    const chainConfig = getChainConfig(config.network.chainId);
    // Pimlico URL format: https://api.pimlico.io/v2/{chain}/rpc?apikey={key}
    return `https://api.pimlico.io/v2/${chainConfig.name}/rpc?apikey=${apiKey}`;
  }

  return null;
}

/**
 * Get paymaster URL from config or environment
 * Falls back to Pimlico paymaster URL
 */
export function getPaymasterUrl(config: PragmaConfig): string | null {
  // Check config first
  if (config.bundler?.paymasterUrl) {
    return config.bundler.paymasterUrl;
  }

  // Paymaster uses same URL as bundler for Pimlico
  return getBundlerUrl(config);
}

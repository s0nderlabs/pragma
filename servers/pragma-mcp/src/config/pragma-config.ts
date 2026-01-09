// pragma Config Management
// Handles reading/writing ~/.pragma/config.json

import type { PragmaConfig } from "../types/index.js";

// TODO: Implement config read/write

export function getConfigPath(): string {
  const configPath = process.env.PRAGMA_CONFIG_PATH;
  if (configPath) {
    return configPath.replace("~", process.env.HOME || "");
  }
  return `${process.env.HOME}/.pragma/config.json`;
}

export async function loadConfig(): Promise<PragmaConfig | null> {
  // TODO: Implement
  throw new Error("Not implemented");
}

export async function saveConfig(config: PragmaConfig): Promise<void> {
  // TODO: Implement
  throw new Error("Not implemented");
}

export async function ensureConfigDir(): Promise<void> {
  // TODO: Implement - create ~/.pragma/ if not exists
  throw new Error("Not implemented");
}

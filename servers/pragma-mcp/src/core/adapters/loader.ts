// Adapter Loader
// Generic adapter file operations - NO provider-specific logic
// All adapters are user-defined JSON files in ~/.pragma/providers/
// Copyright (c) 2026 s0nderlabs

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type { AdapterDefinition, ServiceType, ProvidersConfig } from "./types.js";

// MARK: - Path Helpers

/**
 * Get the base providers directory
 * @returns Path to ~/.pragma/providers/
 */
export function getProvidersDir(): string {
  return path.join(homedir(), ".pragma", "providers");
}

/**
 * Get the directory for a specific service type
 * @param type - Service type (quote, bundler, data)
 * @returns Path to ~/.pragma/providers/{type}/
 */
export function getServiceDir(type: ServiceType): string {
  return path.join(getProvidersDir(), type);
}

/**
 * Get the full path to an adapter JSON file
 * @param type - Service type
 * @param name - Adapter name (user-defined)
 * @returns Path to ~/.pragma/providers/{type}/{name}.json
 */
export function getAdapterPath(type: ServiceType, name: string): string {
  return path.join(getServiceDir(type), `${name}.json`);
}

// MARK: - Directory Management

/**
 * Ensure the providers directory structure exists
 */
export function ensureProvidersDir(): void {
  const baseDir = getProvidersDir();
  if (!existsSync(baseDir)) {
    mkdirSync(baseDir, { recursive: true });
  }

  // Ensure service type subdirectories exist
  const serviceTypes: ServiceType[] = ["quote", "bundler", "data", "rpc"];
  for (const type of serviceTypes) {
    const serviceDir = getServiceDir(type);
    if (!existsSync(serviceDir)) {
      mkdirSync(serviceDir, { recursive: true });
    }
  }
}

// MARK: - Adapter Operations

/**
 * Check if an adapter exists
 * @param type - Service type
 * @param name - Adapter name
 * @returns True if adapter file exists
 */
export function adapterExists(type: ServiceType, name: string): boolean {
  return existsSync(getAdapterPath(type, name));
}

/**
 * Load an adapter definition from file
 * @param type - Service type
 * @param name - Adapter name
 * @returns Adapter definition or null if not found/invalid
 */
export function loadAdapter(type: ServiceType, name: string): AdapterDefinition | null {
  const filePath = getAdapterPath(type, name);

  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const content = readFileSync(filePath, "utf-8");
    const adapter = JSON.parse(content) as AdapterDefinition;

    // Validate required fields
    if (!adapter.name || !adapter.type || !adapter.endpoint || !adapter.auth) {
      console.warn(`[adapters] Invalid adapter file: ${filePath} - missing required fields`);
      return null;
    }

    // Ensure type matches directory
    if (adapter.type !== type) {
      console.warn(`[adapters] Adapter type mismatch: ${filePath} - expected ${type}, got ${adapter.type}`);
      return null;
    }

    return adapter;
  } catch (error) {
    console.warn(`[adapters] Failed to load adapter: ${filePath}`, error);
    return null;
  }
}

/**
 * List all adapter names for a service type
 * @param type - Service type
 * @returns Array of adapter names (without .json extension)
 */
export function listAdapters(type: ServiceType): string[] {
  const serviceDir = getServiceDir(type);

  if (!existsSync(serviceDir)) {
    return [];
  }

  try {
    const files = readdirSync(serviceDir);
    return files
      .filter((file) => file.endsWith(".json"))
      .map((file) => file.slice(0, -5)); // Remove .json extension
  } catch {
    return [];
  }
}

/**
 * Save an adapter definition to file
 * @param adapter - Adapter definition to save
 */
export function saveAdapter(adapter: AdapterDefinition): void {
  ensureProvidersDir();

  const filePath = getAdapterPath(adapter.type, adapter.name);
  const content = JSON.stringify(adapter, null, 2);

  writeFileSync(filePath, content, "utf-8");
}

/**
 * Delete an adapter
 * @param type - Service type
 * @param name - Adapter name
 */
export function deleteAdapter(type: ServiceType, name: string): void {
  const filePath = getAdapterPath(type, name);

  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
}

// MARK: - Config Integration

/**
 * Get adapters configured for a service type based on config.providers
 * Returns adapters in order specified in config (for fallback support)
 *
 * @param type - Service type
 * @param providersConfig - Providers config from pragma config
 * @returns Array of adapter definitions (in order)
 */
export function getConfiguredAdapters(
  type: ServiceType,
  providersConfig?: ProvidersConfig
): AdapterDefinition[] {
  const adapterNames = providersConfig?.[type] ?? [];

  if (adapterNames.length === 0) {
    // If no config, check if any adapters exist for this type
    const availableNames = listAdapters(type);
    if (availableNames.length === 0) {
      return [];
    }
    // Return first available adapter as default
    const adapter = loadAdapter(type, availableNames[0]);
    return adapter ? [adapter] : [];
  }

  // Load adapters in configured order
  const adapters: AdapterDefinition[] = [];
  for (const name of adapterNames) {
    const adapter = loadAdapter(type, name);
    if (adapter) {
      adapters.push(adapter);
    } else {
      console.warn(`[adapters] Configured adapter not found: ${type}/${name}`);
    }
  }

  return adapters;
}

/**
 * Validate an adapter definition
 * @param adapter - Adapter to validate
 * @returns Validation result with errors if invalid
 */
export function validateAdapter(adapter: Partial<AdapterDefinition>): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!adapter.name) {
    errors.push("Missing required field: name");
  }

  if (!adapter.type) {
    errors.push("Missing required field: type");
  } else if (!["quote", "bundler", "data", "rpc"].includes(adapter.type)) {
    errors.push(`Invalid type: ${adapter.type} (must be quote, bundler, data, or rpc)`);
  }

  if (!adapter.endpoint) {
    errors.push("Missing required field: endpoint");
  } else {
    try {
      new URL(adapter.endpoint);
    } catch {
      errors.push(`Invalid endpoint URL: ${adapter.endpoint}`);
    }
  }

  if (!adapter.auth) {
    errors.push("Missing required field: auth");
  } else {
    if (!["header", "query", "bearer", "none"].includes(adapter.auth.type)) {
      errors.push(`Invalid auth type: ${adapter.auth.type}`);
    }
    if (adapter.auth.type !== "none" && !adapter.auth.keyName) {
      errors.push("Missing auth.keyName for authenticated adapter");
    }
    if (adapter.auth.type === "header" && !adapter.auth.header) {
      errors.push("Missing auth.header for header authentication");
    }
    if (adapter.auth.type === "query" && !adapter.auth.queryParam) {
      errors.push("Missing auth.queryParam for query authentication");
    }
  }

  if (!adapter.chainIds || adapter.chainIds.length === 0) {
    errors.push("Missing or empty chainIds array");
  }

  if (!adapter.request || Object.keys(adapter.request).length === 0) {
    errors.push("Missing or empty request mapping");
  }

  if (!adapter.response || Object.keys(adapter.response).length === 0) {
    errors.push("Missing or empty response mapping");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

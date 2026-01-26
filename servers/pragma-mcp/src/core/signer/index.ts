// pragma Signer Wrapper
// Calls the pragma-signer binary for secure key operations
// Copyright (c) 2026 s0nderlabs

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type { Hex } from "viem";

/**
 * Response from pragma-signer binary
 */
interface SignerResponse {
  success: boolean;
  data?: Record<string, string>;
  error?: string;
}

/**
 * Get the path to the pragma-signer binary
 * Searches in order:
 * 1. PRAGMA_SIGNER_PATH env var
 * 2. ~/.pragma/bin/pragma-signer (user installation)
 * 3. Plugin's bin directory
 * 4. Swift build output (development)
 * 5. Xcode build output (development with signing)
 * 6. System PATH
 */
function getSignerPath(): string {
  // 1. Environment variable override
  if (process.env.PRAGMA_SIGNER_PATH) {
    return process.env.PRAGMA_SIGNER_PATH;
  }

  const home = homedir();
  const candidates = [
    // 2. User installation path
    path.join(home, ".pragma", "bin", "pragma-signer"),

    // 3. Plugin's bin directory (relative to dist/core/signer/index.js)
    path.resolve(__dirname, "../../../bin/pragma-signer"),

    // 4. Swift build output (SwiftPM release build)
    path.resolve(__dirname, "../../../../../swift/.build/release/pragma-signer"),
    path.resolve(__dirname, "../../../../../swift/.build/arm64-apple-macosx/release/pragma-signer"),

    // 5. Xcode derived data (common patterns)
    path.join(home, "Library/Developer/Xcode/DerivedData/PragmaSigner-*/Build/Products/Debug/pragma-signer"),
    path.join(home, "Library/Developer/Xcode/DerivedData/PragmaSigner-*/Build/Products/Release/pragma-signer"),
  ];

  // Check each candidate
  for (const candidate of candidates) {
    // Handle glob patterns (simple implementation)
    if (candidate.includes("*")) {
      // For glob patterns, we'll try the base path and skip if not found
      continue;
    }
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  // 6. Default to system PATH
  return "pragma-signer";
}

/**
 * Execute pragma-signer command and parse JSON response
 */
async function execSigner(args: string[]): Promise<SignerResponse> {
  const signerPath = getSignerPath();

  return new Promise((resolve, reject) => {
    const proc = spawn(signerPath, args, {
      stdio: ["inherit", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code !== 0 && !stdout) {
        reject(new Error(`pragma-signer exited with code ${code}: ${stderr}`));
        return;
      }

      try {
        const response = JSON.parse(stdout.trim()) as SignerResponse;
        resolve(response);
      } catch {
        reject(new Error(`Failed to parse signer response: ${stdout}`));
      }
    });

    proc.on("error", (error) => {
      reject(new Error(`Failed to execute pragma-signer: ${error.message}`));
    });
  });
}

/**
 * Handle signer response - throw on error, return data on success
 */
function handleResponse<T extends Record<string, string>>(
  response: SignerResponse,
  dataKeys?: (keyof T)[]
): T {
  if (!response.success) {
    throw new Error(response.error || "Unknown signer error");
  }

  if (dataKeys && response.data) {
    for (const key of dataKeys) {
      if (!(key in response.data)) {
        throw new Error(`Missing expected key in response: ${String(key)}`);
      }
    }
  }

  return (response.data || {}) as T;
}

// ============================================================================
// Passkey Operations (Secure Enclave)
// ============================================================================

/**
 * Create a new passkey in Keychain
 * Requires Touch ID authentication
 * @param message - Optional custom Touch ID prompt message
 * @returns Uncompressed public key (65 bytes, 0x04...)
 */
export async function createPasskey(message?: string): Promise<Hex> {
  const args = ["create-passkey"];
  if (message) {
    args.push("-m", message);
  }
  const response = await execSigner(args);
  const data = handleResponse<{ publicKey: string }>(response, ["publicKey"]);
  return data.publicKey as Hex;
}

/**
 * Sign data with the passkey
 * Requires Touch ID authentication
 * @param data - Hex data to sign (typically a message hash)
 * @param message - Optional custom Touch ID prompt message (e.g., "Approve swap: 1 ETH -> 2000 USDC")
 * @returns Signature in R||S format (64 bytes)
 */
export async function signWithPasskey(data: Hex, message?: string): Promise<Hex> {
  const args = ["sign", data];
  if (message) {
    args.push("-m", message);
  }
  const response = await execSigner(args);
  const result = handleResponse<{ signature: string }>(response, ["signature"]);
  return result.signature as Hex;
}

/**
 * Get the passkey public key
 * @returns Uncompressed public key (65 bytes, 0x04...) or null if not found
 */
export async function getPasskeyPublicKey(): Promise<Hex | null> {
  try {
    const response = await execSigner(["get-pubkey"]);
    const data = handleResponse<{ publicKey: string }>(response, ["publicKey"]);
    return data.publicKey as Hex;
  } catch (error) {
    // Key not found is not an error condition
    if (error instanceof Error && error.message.includes("not found")) {
      return null;
    }
    throw error;
  }
}

/**
 * Check if passkey exists
 */
export async function hasPasskey(): Promise<boolean> {
  const response = await execSigner(["has-passkey"]);
  const data = handleResponse<{ exists: string }>(response, ["exists"]);
  return data.exists === "true";
}

/**
 * Delete the passkey from Keychain
 * Requires Touch ID authentication
 * @param message - Optional custom Touch ID prompt message
 */
export async function deletePasskey(message?: string): Promise<void> {
  const args = ["delete-passkey"];
  if (message) {
    args.push("-m", message);
  }
  const response = await execSigner(args);
  handleResponse(response);
}

/**
 * @deprecated This function is disabled for security.
 * Private keys should never leave the Keychain.
 * Use signWithPasskey() for P-256 signing instead.
 */
export async function getPasskeyPrivateKey(_message?: string): Promise<Hex> {
  throw new Error(
    "DEPRECATED: getPasskeyPrivateKey is disabled for security. Use signWithPasskey() for P-256 signing."
  );
}

// ============================================================================
// Session Key Operations (Keychain)
// ============================================================================

/**
 * Store a session key in Keychain
 * @param privateKey - Private key as hex string (with or without 0x prefix)
 */
export async function storeSessionKeyInKeychain(privateKey: Hex): Promise<void> {
  const response = await execSigner(["store-session", privateKey]);
  handleResponse(response);
}

/**
 * Get session key from Keychain
 * @returns Private key as hex string (with 0x prefix) or null if not found
 */
export async function getSessionKeyFromKeychain(): Promise<Hex | null> {
  try {
    const response = await execSigner(["get-session"]);
    const data = handleResponse<{ privateKey: string }>(response, ["privateKey"]);
    return data.privateKey as Hex;
  } catch (error) {
    // Key not found is not an error condition
    if (error instanceof Error && error.message.includes("not found")) {
      return null;
    }
    throw error;
  }
}

/**
 * Delete session key from Keychain
 */
export async function deleteSessionKeyFromKeychain(): Promise<void> {
  const response = await execSigner(["delete-session"]);
  handleResponse(response);
}

/**
 * Check if session key exists in Keychain
 */
export async function hasSessionKey(): Promise<boolean> {
  const response = await execSigner(["has-session"]);
  const data = handleResponse<{ exists: string }>(response, ["exists"]);
  return data.exists === "true";
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Parse P-256 public key coordinates from uncompressed format
 * @param publicKey - Uncompressed public key (0x04 || X || Y, 65 bytes)
 * @returns X and Y coordinates as bigints
 */
export function parseP256PublicKey(publicKey: Hex): { x: bigint; y: bigint } {
  // Remove 0x prefix and verify format
  const hex = publicKey.slice(2);

  if (hex.length !== 130) {
    throw new Error(`Invalid public key length: expected 130 hex chars (65 bytes), got ${hex.length}`);
  }

  if (!hex.startsWith("04")) {
    throw new Error("Invalid public key format: expected uncompressed (0x04...)");
  }

  // Extract X and Y (32 bytes each)
  const xHex = hex.slice(2, 66);
  const yHex = hex.slice(66, 130);

  return {
    x: BigInt("0x" + xHex),
    y: BigInt("0x" + yHex),
  };
}

/**
 * Derive Ethereum address from P-256 public key
 * Note: This is for reference - actual address derivation happens in the smart account
 * @param publicKey - Uncompressed public key
 * @returns Ethereum address derived from keccak256 of public key
 */
export function deriveAddressFromP256(publicKey: Hex): Hex {
  // For P-256 passkeys in Delegation Framework, the address is derived
  // from the public key coordinates through the smart account factory
  // This function is placeholder - actual derivation done by SDK
  throw new Error(
    "Address derivation for P-256 passkeys is done through the smart account SDK"
  );
}

// ============================================================================
// Provider Operations (Keychain) - BYOK Mode Only
// ============================================================================

/**
 * Store a provider value (API key or URL) in Keychain
 * Used in BYOK mode when user provides their own API keys
 *
 * Provider names are user-defined (no restrictions).
 * Example names: "my-quote-api", "backup-rpc", "custom-bundler"
 *
 * @param name - User-defined provider name (Keychain key identifier)
 * @param value - The value to store (URL or API key)
 */
export async function storeProvider(name: string, value: string): Promise<void> {
  const response = await execSigner(["store-provider", name, value]);
  handleResponse(response);
}

/**
 * Get a provider value from Keychain
 * Used in BYOK mode when user provides their own API keys
 *
 * @param name - User-defined provider name
 * @returns The stored value or null if not found
 */
export async function getProvider(name: string): Promise<string | null> {
  try {
    const response = await execSigner(["get-provider", name]);
    const data = handleResponse<{ value: string }>(response, ["value"]);
    return data.value;
  } catch (error) {
    // Key not found is not an error condition
    if (error instanceof Error && error.message.includes("not found")) {
      return null;
    }
    // Keychain access errors (e.g., -128 user canceled) should return null
    // This allows fallback to config values in x402 mode
    if (error instanceof Error && error.message.includes("Keychain error")) {
      return null;
    }
    throw error;
  }
}

/**
 * Delete a provider from Keychain
 * @param name - User-defined provider name to delete
 */
export async function deleteProvider(name: string): Promise<void> {
  const response = await execSigner(["delete-provider", name]);
  handleResponse(response);
}

/**
 * Check if a provider exists in Keychain
 * @param name - User-defined provider name to check
 * @returns true if provider exists
 */
export async function hasProvider(name: string): Promise<boolean> {
  const response = await execSigner(["has-provider", name]);
  const data = handleResponse<{ exists: string }>(response, ["exists"]);
  return data.exists === "true";
}

/**
 * List all configured providers
 * @returns Array of provider names that are configured
 */
export async function listProviders(): Promise<string[]> {
  const response = await execSigner(["list-providers"]);
  const data = handleResponse<{ providers: string }>(response, ["providers"]);

  // Parse comma-separated list
  if (!data.providers || data.providers === "") {
    return [];
  }
  return data.providers.split(",");
}

// ============================================================================
// Sub-Agent Key Operations (Keychain) - Autonomous Mode Wallet Pool
// ============================================================================

/**
 * Store a sub-agent key in Keychain
 * @param uuid - Unique identifier for the sub-agent wallet
 * @param privateKey - Private key as hex string (with or without 0x prefix)
 */
export async function storeSubagentKeyInKeychain(uuid: string, privateKey: Hex): Promise<void> {
  const response = await execSigner(["store-subagent", uuid, privateKey]);
  handleResponse(response);
}

/**
 * Get sub-agent key from Keychain
 * @param uuid - Unique identifier for the sub-agent wallet
 * @returns Private key as hex string (with 0x prefix) or null if not found
 */
export async function getSubagentKeyFromKeychain(uuid: string): Promise<Hex | null> {
  try {
    const response = await execSigner(["get-subagent", uuid]);
    const data = handleResponse<{ privateKey: string }>(response, ["privateKey"]);
    return data.privateKey as Hex;
  } catch (error) {
    // Key not found is not an error condition
    if (error instanceof Error && error.message.includes("not found")) {
      return null;
    }
    throw error;
  }
}

/**
 * Delete sub-agent key from Keychain
 * @param uuid - Unique identifier for the sub-agent wallet
 */
export async function deleteSubagentKeyFromKeychain(uuid: string): Promise<void> {
  const response = await execSigner(["delete-subagent", uuid]);
  handleResponse(response);
}

/**
 * Check if sub-agent key exists in Keychain
 * @param uuid - Unique identifier to check
 */
export async function hasSubagentKey(uuid: string): Promise<boolean> {
  const response = await execSigner(["has-subagent", uuid]);
  const data = handleResponse<{ exists: string }>(response, ["exists"]);
  return data.exists === "true";
}

/**
 * List all sub-agent UUIDs stored in Keychain
 * @returns Array of UUID strings for all stored sub-agent keys
 */
export async function listSubagentKeysFromKeychain(): Promise<string[]> {
  const response = await execSigner(["list-subagents"]);
  const data = handleResponse<{ subagents: string }>(response, ["subagents"]);

  // Parse comma-separated list
  if (!data.subagents || data.subagents === "") {
    return [];
  }
  return data.subagents.split(",");
}

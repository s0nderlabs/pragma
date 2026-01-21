// nad.fun HTTP API Client
// HTTP client for the public nad.fun API (https://api.nad.fun/)
// Works in both BYOK and x402 modes (no auth required)
// Copyright (c) 2026 s0nderlabs

import { readFile, stat } from "fs/promises";
import { extname } from "path";
import type { Address, Hex } from "viem";
import { withRetry } from "../utils/retry.js";

// ============================================================================
// Constants
// ============================================================================

export const NADFUN_API_BASE = "https://api.nad.fun";

/**
 * Monad explorer URL for transaction links
 */
export const MONAD_EXPLORER_URL = "https://explorer.monad.xyz";

// ============================================================================
// API Client
// ============================================================================

/**
 * Fetch from nad.fun public HTTP API with retry logic
 *
 * The nad.fun API is public (no authentication required) so this works
 * in both BYOK and x402 modes.
 *
 * @param path - API endpoint path (e.g., "/order/market_cap")
 * @param params - Optional query parameters
 * @returns Parsed JSON response
 * @throws Error if request fails after retries
 *
 * @example
 * ```typescript
 * const data = await fetchNadFunApi<NadFunApiListingResponse>("/order/market_cap", {
 *   page: 1,
 *   limit: 10,
 * });
 * ```
 */
export async function fetchNadFunApi<T>(
  path: string,
  params?: Record<string, string | number | boolean | undefined>
): Promise<T> {
  const url = new URL(path, NADFUN_API_BASE);

  // Add query parameters (skip undefined values)
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    });
  }

  const result = await withRetry(
    async () => {
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        // Include status in error for retry logic to detect transient errors
        throw new Error(`nad.fun API error (${response.status}): ${response.statusText}`);
      }

      return response.json() as Promise<T>;
    },
    {
      operationName: `nadfun-api-${path}`,
      maxRetries: 2,
      baseDelayMs: 500,
    }
  );

  if (!result.success) {
    throw new Error(result.error?.message || "nad.fun API request failed");
  }

  return result.data!;
}

/**
 * POST to nad.fun public HTTP API with retry logic
 *
 * @param path - API endpoint path (e.g., "/metadata/metadata")
 * @param body - JSON body to send
 * @returns Parsed JSON response
 * @throws Error if request fails after retries
 */
export async function postNadFunApi<T>(
  path: string,
  body: Record<string, unknown>
): Promise<T> {
  const url = new URL(path, NADFUN_API_BASE);

  const result = await withRetry(
    async () => {
      const response = await fetch(url.toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => response.statusText);
        throw new Error(`nad.fun API error (${response.status}): ${errorText}`);
      }

      return response.json() as Promise<T>;
    },
    {
      operationName: `nadfun-post-${path}`,
      maxRetries: 2,
      baseDelayMs: 500,
    }
  );

  if (!result.success) {
    throw new Error(result.error?.message || "nad.fun API POST request failed");
  }

  return result.data!;
}

// ============================================================================
// Token Creation API Functions
// ============================================================================

/** Response from /metadata/image endpoint */
export interface ImageUploadResponse {
  image_uri: string;
  is_nsfw: boolean;
}

/** Response from /metadata/metadata endpoint */
export interface MetadataUploadResponse {
  metadata_uri: string;
}

/** Response from /token/salt endpoint */
export interface SaltMiningResponse {
  salt: Hex;
  address: Address;
}

/** Metadata input for token creation */
export interface TokenMetadataInput {
  name: string;
  symbol: string;
  imageUri: string;
  description?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
}

/**
 * Get MIME type from file extension
 */
function getMimeType(ext: string): string {
  const mimeTypes: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
  };
  return mimeTypes[ext.toLowerCase()] || "application/octet-stream";
}

/**
 * Validate image file type
 */
function isValidImageType(ext: string): boolean {
  const validTypes = [".png", ".jpg", ".jpeg", ".webp"];
  return validTypes.includes(ext.toLowerCase());
}

/**
 * Upload token image to nad.fun
 *
 * @param imagePath - Path to local image file (PNG, JPEG, WebP)
 * @returns Image URI from nad.fun storage
 * @throws Error if file not found, too large, or invalid type
 *
 * @example
 * ```typescript
 * const imageUri = await uploadTokenImage("./logo.png");
 * // Returns: "https://storage.nadapp.net/..."
 * ```
 */
export async function uploadTokenImage(imagePath: string): Promise<string> {
  // Validate file extension
  const ext = extname(imagePath);
  if (!isValidImageType(ext)) {
    throw new Error(`Invalid image format '${ext}'. Supported: PNG, JPEG, WebP`);
  }

  // Check file exists and get size
  const fileStat = await stat(imagePath).catch(() => null);
  if (!fileStat) {
    throw new Error(`Image file not found: ${imagePath}`);
  }

  // Validate size (max 5MB)
  const maxSize = 5 * 1024 * 1024;
  if (fileStat.size > maxSize) {
    const sizeMB = (fileStat.size / 1024 / 1024).toFixed(2);
    throw new Error(`Image exceeds 5MB limit (current: ${sizeMB}MB)`);
  }

  // Read file
  const imageBuffer = await readFile(imagePath);
  const mimeType = getMimeType(ext);

  // Upload with retry (longer delay for large files)
  const url = new URL("/metadata/image", NADFUN_API_BASE);

  const result = await withRetry(
    async () => {
      const response = await fetch(url.toString(), {
        method: "POST",
        headers: {
          "Content-Type": mimeType,
          Accept: "application/json",
        },
        body: imageBuffer,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => response.statusText);
        throw new Error(`Image upload failed (${response.status}): ${errorText}`);
      }

      return response.json() as Promise<ImageUploadResponse>;
    },
    {
      operationName: "nadfun-image-upload",
      maxRetries: 2,
      baseDelayMs: 1000, // Longer delay for uploads
    }
  );

  if (!result.success) {
    throw new Error(result.error?.message || "Image upload failed");
  }

  const data = result.data!;

  // Check NSFW flag
  if (data.is_nsfw) {
    throw new Error("Image was flagged as NSFW and rejected by nad.fun");
  }

  return data.image_uri;
}

/**
 * Upload token metadata to nad.fun
 *
 * @param metadata - Token metadata (name, symbol, image URI, socials)
 * @returns Metadata URI from nad.fun storage
 *
 * @example
 * ```typescript
 * const metadataUri = await uploadTokenMetadata({
 *   name: "Moon Cat",
 *   symbol: "MCAT",
 *   imageUri: "https://storage.nadapp.net/...",
 *   description: "The best cat on Monad",
 * });
 * ```
 */
export async function uploadTokenMetadata(
  metadata: TokenMetadataInput
): Promise<string> {
  // Build request body with API field names
  const body: Record<string, string> = {
    image_uri: metadata.imageUri,
    name: metadata.name,
    symbol: metadata.symbol,
  };

  // Add optional fields
  if (metadata.description) {
    body.description = metadata.description;
  }
  if (metadata.twitter) {
    body.twitter = metadata.twitter;
  }
  if (metadata.telegram) {
    body.telegram = metadata.telegram;
  }
  if (metadata.website) {
    body.website = metadata.website;
  }

  const response = await postNadFunApi<MetadataUploadResponse>(
    "/metadata/metadata",
    body
  );

  return response.metadata_uri;
}

/**
 * Mine vanity address salt for token creation
 *
 * The salt produces a token address ending in "7777" (nad.fun convention).
 *
 * @param creator - Creator wallet address
 * @param name - Token name
 * @param symbol - Token symbol
 * @param metadataUri - Metadata URI from uploadTokenMetadata
 * @returns Salt (bytes32) and predicted token address
 *
 * @example
 * ```typescript
 * const { salt, address } = await mineTokenSalt(
 *   "0x123...",
 *   "Moon Cat",
 *   "MCAT",
 *   "https://storage.nadapp.net/metadata-..."
 * );
 * // address ends in "7777"
 * ```
 */
export async function mineTokenSalt(
  creator: Address,
  name: string,
  symbol: string,
  metadataUri: string
): Promise<SaltMiningResponse> {
  const body = {
    creator,
    name,
    symbol,
    metadata_uri: metadataUri,
  };

  const response = await postNadFunApi<SaltMiningResponse>("/token/salt", body);

  return response;
}

// ============================================================================
// File Utility Functions
// ============================================================================

/**
 * Check if a file exists
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get file size in bytes
 */
export async function getFileSize(filePath: string): Promise<number> {
  const fileStat = await stat(filePath);
  return fileStat.size;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Format price change percentage with sign
 *
 * @param percent - Raw percent string from API
 * @returns Formatted string like "+5.20%" or "-3.10%"
 */
export function formatPriceChange(percent: string | undefined): string {
  if (!percent) return "0.00%";

  const num = parseFloat(percent);
  if (isNaN(num)) return "0.00%";

  if (num >= 0) {
    return `+${num.toFixed(2)}%`;
  }
  return `${num.toFixed(2)}%`;
}

/**
 * Format USD price with appropriate precision
 *
 * @param price - Raw price string from API
 * @returns Formatted price string
 */
export function formatPrice(price: string | undefined): string {
  if (!price) return "0.00";

  const num = parseFloat(price);
  if (isNaN(num)) return "0.00";

  // Use more decimal places for very small prices
  if (num < 0.0001) {
    return num.toExponential(2);
  }
  if (num < 0.01) {
    return num.toFixed(6);
  }
  if (num < 1) {
    return num.toFixed(4);
  }
  return num.toFixed(2);
}

/**
 * Format token amount with appropriate precision
 *
 * @param amount - Raw amount string
 * @returns Formatted amount
 */
export function formatAmount(amount: string | undefined): string {
  if (!amount) return "0";

  const num = parseFloat(amount);
  if (isNaN(num)) return "0";

  if (num >= 1_000_000) {
    return `${(num / 1_000_000).toFixed(2)}M`;
  }
  if (num >= 1_000) {
    return `${(num / 1_000).toFixed(2)}K`;
  }
  if (num < 0.0001) {
    return num.toExponential(2);
  }
  if (num < 1) {
    return num.toFixed(6);
  }
  return num.toFixed(2);
}

/**
 * Build explorer URL for a transaction hash
 *
 * @param txHash - Transaction hash
 * @returns Full explorer URL
 */
export function buildExplorerUrl(txHash: string): string {
  return `${MONAD_EXPLORER_URL}/tx/${txHash}`;
}

/**
 * Calculate progress percentage from basis points
 *
 * @param progress - Progress in basis points (0-10000)
 * @returns Formatted percentage string
 */
export function formatProgress(progress: number | undefined): string {
  if (progress === undefined) return "0.00%";
  return `${(progress / 100).toFixed(2)}%`;
}

/**
 * Truncate address for display
 *
 * @param address - Full address
 * @param prefixLen - Characters to show at start (default 6)
 * @param suffixLen - Characters to show at end (default 4)
 * @returns Truncated address like "0x1234...abcd"
 */
export function truncateAddress(
  address: string,
  prefixLen: number = 6,
  suffixLen: number = 4
): string {
  if (address.length <= prefixLen + suffixLen) return address;
  return `${address.slice(0, prefixLen)}...${address.slice(-suffixLen)}`;
}

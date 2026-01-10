// Session Key Management
// Handles session key generation and storage
// Adapted from pragma-v2-stable (H2)
// Copyright (c) 2026 s0nderlabs

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address, Hex, PrivateKeyAccount } from "viem";
import {
  storeSessionKeyInKeychain,
  getSessionKeyFromKeychain,
  deleteSessionKeyFromKeychain,
  hasSessionKey as checkHasSessionKey,
} from "../signer/index.js";

/**
 * Session key information
 */
export interface SessionKey {
  address: Address;
  privateKey: Hex;
}

/**
 * Generate a new random session key
 * Does NOT store it - call storeSessionKey separately
 * @returns Session key with address and private key
 */
export function generateSessionKey(): SessionKey {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);

  return {
    address: account.address,
    privateKey,
  };
}

/**
 * Store session key in Keychain
 * @param key - Session key to store
 */
export async function storeSessionKey(key: SessionKey): Promise<void> {
  await storeSessionKeyInKeychain(key.privateKey);
}

/**
 * Get session key from Keychain
 * @returns Session key or null if not found
 */
export async function getSessionKey(): Promise<SessionKey | null> {
  const privateKey = await getSessionKeyFromKeychain();

  if (!privateKey) {
    return null;
  }

  const account = privateKeyToAccount(privateKey);

  return {
    address: account.address,
    privateKey,
  };
}

/**
 * Delete session key from Keychain
 */
export async function deleteSessionKey(): Promise<void> {
  await deleteSessionKeyFromKeychain();
}

/**
 * Check if session key exists in Keychain
 */
export async function hasSessionKey(): Promise<boolean> {
  return checkHasSessionKey();
}

/**
 * Get viem account from session key
 * @param key - Session key
 * @returns Private key account for signing
 */
export function getSessionAccount(key: SessionKey): PrivateKeyAccount {
  return privateKeyToAccount(key.privateKey);
}

/**
 * Generate and store a new session key
 * Convenience function that combines generation and storage
 * @returns The generated session key
 */
export async function createAndStoreSessionKey(): Promise<SessionKey> {
  const key = generateSessionKey();
  await storeSessionKey(key);
  return key;
}

/**
 * Rotate session key
 * Deletes existing key and creates a new one
 * @returns The new session key
 */
export async function rotateSessionKey(): Promise<SessionKey> {
  await deleteSessionKey();
  return createAndStoreSessionKey();
}

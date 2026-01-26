// Sub-Agent Key Management
// Handles sub-agent wallet generation and storage for autonomous mode
// Copyright (c) 2026 s0nderlabs

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { randomUUID } from "node:crypto";
import {
  storeSubagentKeyInKeychain,
  getSubagentKeyFromKeychain,
  deleteSubagentKeyFromKeychain,
  hasSubagentKey as checkHasSubagentKey,
  listSubagentKeysFromKeychain,
} from "../signer/index.js";

/**
 * Sub-agent wallet information
 */
export interface SubAgentWallet {
  id: string; // UUID
  address: Address;
  privateKey: Hex;
}

/**
 * Generate a new random sub-agent wallet
 * Does NOT store it - call storeSubAgentWallet separately
 * @returns Sub-agent wallet with id, address and private key
 */
export function generateSubAgentWallet(): SubAgentWallet {
  const id = randomUUID();
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);

  return {
    id,
    address: account.address,
    privateKey,
  };
}

/**
 * Store sub-agent wallet in Keychain
 * @param wallet - Sub-agent wallet to store
 */
export async function storeSubAgentWallet(wallet: SubAgentWallet): Promise<void> {
  await storeSubagentKeyInKeychain(wallet.id, wallet.privateKey);
}

/**
 * Get sub-agent wallet from Keychain
 * @param id - UUID of the sub-agent wallet
 * @returns Sub-agent wallet or null if not found
 */
export async function getSubAgentWallet(id: string): Promise<SubAgentWallet | null> {
  const privateKey = await getSubagentKeyFromKeychain(id);

  if (!privateKey) {
    return null;
  }

  const account = privateKeyToAccount(privateKey);

  return {
    id,
    address: account.address,
    privateKey,
  };
}

/**
 * Delete sub-agent wallet from Keychain
 * @param id - UUID of the sub-agent wallet to delete
 */
export async function deleteSubAgentWallet(id: string): Promise<void> {
  await deleteSubagentKeyFromKeychain(id);
}

/**
 * Check if sub-agent wallet exists in Keychain
 * @param id - UUID to check
 */
export async function hasSubAgentWallet(id: string): Promise<boolean> {
  return checkHasSubagentKey(id);
}

/**
 * List all sub-agent wallet IDs from Keychain
 * @returns Array of UUIDs
 */
export async function listSubAgentWalletIds(): Promise<string[]> {
  return listSubagentKeysFromKeychain();
}

/**
 * Get viem account from sub-agent wallet
 * @param wallet - Sub-agent wallet
 * @returns Private key account for signing
 */
export function getSubAgentAccount(wallet: SubAgentWallet) {
  return privateKeyToAccount(wallet.privateKey);
}

/**
 * Generate and store a new sub-agent wallet
 * Convenience function that combines generation and storage
 * @returns The generated sub-agent wallet
 */
export async function createAndStoreSubAgentWallet(): Promise<SubAgentWallet> {
  const wallet = generateSubAgentWallet();
  await storeSubAgentWallet(wallet);
  return wallet;
}

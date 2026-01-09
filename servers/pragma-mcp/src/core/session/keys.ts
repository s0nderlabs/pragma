// Session Key Management
// Handles session key generation and storage
// Adapted from pragma-v2-stable (H2)

import type { Address, Hex } from "viem";

// TODO: Implement - copy and adapt from H2
// Key patterns to preserve:
// - Session key stored in Keychain via pragma-signer
// - Automatic funding when balance low
// - Key rotation support

export interface SessionKey {
  address: Address;
  privateKey: Hex;
}

export async function generateSessionKey(): Promise<SessionKey> {
  throw new Error("Not implemented");
}

export async function getSessionKey(): Promise<SessionKey | null> {
  throw new Error("Not implemented");
}

export async function storeSessionKey(key: SessionKey): Promise<void> {
  throw new Error("Not implemented");
}

export async function deleteSessionKey(): Promise<void> {
  throw new Error("Not implemented");
}

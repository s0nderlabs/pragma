// P-256 Signer Configuration for HybridDelegator
// Provides synthetic WebAuthn signing using native P-256 from Swift Keychain
// Private keys NEVER leave the Keychain - only signatures cross the boundary
// Copyright (c) 2026 s0nderlabs

import type { Hex } from "viem";
import {
  keccak256,
  encodePacked,
  encodeAbiParameters,
  parseAbiParameters,
  concat,
  toHex,
  hexToBytes,
  hashTypedData,
  hashMessage,
} from "viem";
import type { WebAuthnAccount } from "viem/account-abstraction";
import type { SignableMessage } from "viem";
import { signWithPasskey, getPasskeyPublicKey, parseP256PublicKey } from "./index.js";

// ============================================================================
// Constants (matching SDK expectations)
// ============================================================================

/**
 * P-256 curve order n
 * Used for signature malleability normalization
 */
const P256_FIELD_MODULUS = 115792089210356248762697446949407573529996955224135760342422259061068512044369n;
const MALLEABILITY_THRESHOLD = P256_FIELD_MODULUS / 2n;

/**
 * Signature ABI parameters for HybridDelegator
 * Format: (keyIdHash, r, s, authenticatorData, userVerified, clientDataPrefix, clientDataSuffix, responseTypeLocation)
 */
const SIGNATURE_ABI_PARAMS = parseAbiParameters(
  "bytes32, uint256, uint256, bytes, bool, string, string, uint256"
);

// ============================================================================
// Synthetic WebAuthn Data
// ============================================================================

/**
 * Fixed authenticatorData for synthetic WebAuthn
 * This mimics what a real authenticator would provide:
 * - rpIdHash: keccak256("AuthenticatorData") - fake RP ID hash
 * - flags: 0x05 (user present + user verified)
 * - signCount: 0x00000000 (counter not used)
 */
function createAuthenticatorData(): Hex {
  const rpIdHash = keccak256(encodePacked(["string"], ["AuthenticatorData"]));
  const flags = "0x05";
  const signCount = "0x00000000";
  return concat([rpIdHash, flags, signCount]);
}

/**
 * Create clientDataJSON for WebAuthn format
 * The challenge is base64url-encoded and embedded in the JSON
 */
function createClientDataJSON(challenge: Hex): {
  full: string;
  prefix: string;
  suffix: string;
} {
  // Base64url encode the challenge (without padding)
  const challengeBytes = hexToBytes(challenge);
  const base64Challenge = Buffer.from(challengeBytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  const prefix = '{"type":"webauthn.get","challenge":"';
  const suffix = '","origin":"pragma.xyz","crossOrigin":false}';

  return {
    full: prefix + base64Challenge + suffix,
    prefix,
    suffix,
  };
}

/**
 * Compute the WebAuthn message hash that gets signed
 * messageHash = sha256(authenticatorData || sha256(clientDataJSON))
 */
async function computeWebAuthnHash(
  authenticatorData: Hex,
  clientDataJSON: string
): Promise<Hex> {
  // SHA-256 hash of clientDataJSON
  const clientDataJSONBytes = new TextEncoder().encode(clientDataJSON);
  const clientDataHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", clientDataJSONBytes)
  );

  // Concatenate authenticatorData and clientDataHash
  const authDataBytes = hexToBytes(authenticatorData);
  const combined = new Uint8Array(authDataBytes.length + clientDataHash.length);
  combined.set(authDataBytes, 0);
  combined.set(clientDataHash, authDataBytes.length);

  // SHA-256 hash of the combined data
  const messageHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", combined)
  );

  return toHex(messageHash);
}

// ============================================================================
// Signature Parsing and Encoding
// ============================================================================

/**
 * Parse R and S values from raw signature (64 bytes)
 */
function parseRawSignature(signature: Hex): { r: bigint; s: bigint } {
  const bytes = hexToBytes(signature);
  if (bytes.length !== 64) {
    throw new Error(`Invalid signature length: expected 64 bytes, got ${bytes.length}`);
  }

  const rBytes = bytes.slice(0, 32);
  const sBytes = bytes.slice(32, 64);

  return {
    r: BigInt(toHex(rBytes)),
    s: BigInt(toHex(sBytes)),
  };
}

/**
 * Normalize S value to prevent signature malleability
 * If s > n/2, use n - s instead
 */
function normalizeS(s: bigint): bigint {
  if (s > MALLEABILITY_THRESHOLD) {
    return P256_FIELD_MODULUS - s;
  }
  return s;
}

/**
 * Encode the full DeleGator signature for HybridDelegator
 * This format is compatible with the SDK's encodeDeleGatorSignature
 */
function encodeDeleGatorSignature(
  keyIdHash: Hex,
  r: bigint,
  s: bigint,
  authenticatorData: Hex,
  userVerified: boolean,
  clientDataPrefix: string,
  clientDataSuffix: string,
  responseTypeLocation: bigint
): Hex {
  return encodeAbiParameters(SIGNATURE_ABI_PARAMS, [
    keyIdHash,
    r,
    s,
    authenticatorData,
    userVerified,
    clientDataPrefix,
    clientDataSuffix,
    responseTypeLocation,
  ]);
}

// ============================================================================
// Stub Signature for Gas Estimation
// ============================================================================

/**
 * Create a dummy/stub signature for gas estimation
 * This matches the SDK's createDummyWebAuthnSignature
 */
export function createStubSignature(keyId: string): Hex {
  const authenticatorData = createAuthenticatorData();
  const keyIdHash = keccak256(encodePacked(["string"], [keyId])) as Hex;

  // Use a fixed R and S value for the stub
  const rs = 57896044605178124381348723474703786764998477612067880171211129530534256022184n;

  const clientDataPrefix = '{"type":"webauthn.get","challenge":"';
  const clientDataSuffix = '","origin":"pragma.xyz","crossOrigin":false}';
  const responseTypeLocation = 1n;

  return encodeDeleGatorSignature(
    keyIdHash,
    rs,
    rs,
    authenticatorData,
    true,
    clientDataPrefix,
    clientDataSuffix,
    responseTypeLocation
  );
}

// ============================================================================
// Signer Config for SDK
// ============================================================================

/**
 * WebAuthn SignMetadata matching ox/WebAuthnP256.SignMetadata exactly
 * Note: ox uses Hex.Hex which is the same as viem's Hex type
 */
interface WebAuthnSignMetadata {
  authenticatorData: Hex;
  challengeIndex?: number | undefined;
  clientDataJSON: string;
  typeIndex?: number | undefined;
  userVerificationRequired?: boolean | undefined;
}

/**
 * Raw credential response structure matching ox/WebAuthnP256
 * This mimics what a real WebAuthn authenticator would return
 */
interface PublicKeyCredentialRaw {
  id: string;
  type: "public-key";
  authenticatorAttachment?: "platform" | "cross-platform";
  response: {
    authenticatorData: ArrayBuffer;
    clientDataJSON: ArrayBuffer;
    signature: ArrayBuffer;
  };
}

/**
 * Signature result matching viem's WebAuthnSignReturnType exactly
 * from viem/_types/account-abstraction/accounts/types.d.ts
 */
interface WebAuthnSignReturnType {
  signature: Hex;
  webauthn: WebAuthnSignMetadata;
  raw: PublicKeyCredentialRaw;
}

/**
 * P256 owner information for HybridDelegator deployParams
 */
export interface P256Owner {
  keyId: string;
  x: bigint;
  y: bigint;
}

/**
 * Get P256 owner info from the passkey
 * Returns the public key coordinates for use in deployParams
 */
export async function getP256Owner(keyId: string): Promise<P256Owner> {
  const publicKey = await getPasskeyPublicKey();
  if (!publicKey) {
    throw new Error("No passkey found. Create one first with createPasskey()");
  }

  const { x, y } = parseP256PublicKey(publicKey);

  return { keyId, x, y };
}

/**
 * Convert r, s bigints to raw signature hex (64 bytes: r || s)
 * This is the format expected by Signature.toHex in ox/viem
 */
function encodeRawSignature(r: bigint, s: bigint): Hex {
  // Pad r and s to 32 bytes each
  const rHex = r.toString(16).padStart(64, "0");
  const sHex = s.toString(16).padStart(64, "0");
  return `0x${rHex}${sHex}` as Hex;
}

/**
 * Sign a hash and return result with WebAuthn metadata
 * Matches viem's WebAuthnSignReturnType for SDK compatibility.
 *
 * The signature format is raw r||s (64 bytes), matching Signature.toHex({r, s}).
 */
async function signWithWebAuthnFormat(
  hash: Hex,
  keyId: string,
  touchIdMessage?: string
): Promise<WebAuthnSignReturnType> {
  const authenticatorData = createAuthenticatorData();
  const { full: clientDataJSON } = createClientDataJSON(hash);

  // Compute WebAuthn message hash and sign via Swift (Touch ID required)
  const messageHash = await computeWebAuthnHash(authenticatorData, clientDataJSON);
  const rawSignature = await signWithPasskey(messageHash, touchIdMessage ?? "Sign transaction");

  // Parse, normalize S for malleability protection, and encode
  let { r, s } = parseRawSignature(rawSignature);
  s = normalizeS(s);
  const signature = encodeRawSignature(r, s);

  // Locate indices for SDK parsing
  const challengeKeyIndex = clientDataJSON.indexOf('"challenge"');
  const typeIndex = clientDataJSON.indexOf('"type"');

  return {
    signature,
    webauthn: {
      authenticatorData,
      clientDataJSON,
      challengeIndex: challengeKeyIndex >= 0 ? challengeKeyIndex + 13 : undefined,
      typeIndex: typeIndex >= 0 ? typeIndex : undefined,
      userVerificationRequired: true,
    },
    raw: {
      id: keyId,
      type: "public-key",
      authenticatorAttachment: "platform",
      response: {
        authenticatorData: hexToBytes(authenticatorData).buffer as ArrayBuffer,
        clientDataJSON: new TextEncoder().encode(clientDataJSON).buffer as ArrayBuffer,
        signature: hexToBytes(signature).buffer as ArrayBuffer,
      },
    },
  };
}

/**
 * Helper to extract hash from SignableMessage
 * SignableMessage can be: string | { raw: Hex | ByteArray }
 */
function hashSignableMessage(message: SignableMessage): Hex {
  // If it's a string, hash it using EIP-191 personal sign
  if (typeof message === "string") {
    return hashMessage(message);
  }
  // If it's an object with 'raw', use the raw bytes
  if ("raw" in message) {
    if (typeof message.raw === "string") {
      return hashMessage({ raw: message.raw as Hex });
    }
    // ByteArray - convert to Hex and hash
    return hashMessage({ raw: toHex(message.raw) });
  }
  throw new Error("Invalid SignableMessage format");
}

/**
 * Create a WebAuthn account compatible with viem/SDK
 * This is used as the signer for toMetaMaskSmartAccount
 * Matches viem's WebAuthnAccount interface.
 *
 * Note: We use type casting because we're creating a SYNTHETIC WebAuthn response.
 * Real browser WebAuthn has additional properties (rawId, getClientExtensionResults)
 * that we don't need for P-256 signature verification.
 */
export async function createP256WebAuthnAccount(
  keyId: string,
  touchIdMessage?: string
): Promise<WebAuthnAccount> {
  // Get public key
  const publicKey = await getPasskeyPublicKey();
  if (!publicKey) {
    throw new Error("No passkey found. Create one first with createPasskey()");
  }

  // Create the account with explicit type casting for synthetic WebAuthn
  const account: WebAuthnAccount = {
    id: keyId,
    type: "webAuthn",
    publicKey,

    // sign: Direct hash signing
    sign: async ({ hash }) => {
      const result = await signWithWebAuthnFormat(hash, keyId, touchIdMessage);
      // Cast to the expected type - raw property compatibility
      return result as any;
    },

    // signMessage: EIP-191 Personal Sign
    signMessage: async ({ message }) => {
      const hash = hashSignableMessage(message);
      const result = await signWithWebAuthnFormat(hash, keyId, touchIdMessage);
      return result as any;
    },

    // signTypedData: EIP-712 Typed Data
    signTypedData: async (typedData: any) => {
      // Compute hash from the full typed data structure
      // The SDK passes full EIP-712 typed data that needs to be hashed
      const hash = hashTypedData({
        domain: typedData.domain,
        types: typedData.types,
        primaryType: typedData.primaryType,
        message: typedData.message,
      });
      const result = await signWithWebAuthnFormat(hash, keyId, touchIdMessage);
      return result as any;
    },
  };

  return account;
}

/**
 * Create the WebAuthnSignerConfig for the SDK
 * This is the format expected by toMetaMaskSmartAccount for Hybrid implementation
 *
 * The SDK expects WebAuthnSignerConfig type:
 * { webAuthnAccount: WebAuthnAccount; keyId: Hex }
 *
 * From MetaMask Smart Accounts Kit docs:
 * signer: { webAuthnAccount, keyId: toHex(credential.id) }
 * deployParams: [owner, [toHex(credential.id)], [publicKey.x], [publicKey.y]]
 *
 * Both places use toHex(credential.id) - the UTF-8 bytes of the string as hex.
 * The contract/SDK handles the keccak256 hashing internally.
 */
export async function createWebAuthnSignerConfig(
  keyId: string,
  touchIdMessage?: string
): Promise<{
  webAuthnAccount: WebAuthnAccount;
  keyId: Hex;
}> {
  const webAuthnAccount = await createP256WebAuthnAccount(keyId, touchIdMessage);

  // Convert keyId string to hex bytes - matches toHex(credential.id) pattern
  // This is the UTF-8 encoded string as hex, NOT the keccak256 hash
  const keyIdHex = toHex(keyId);

  return {
    webAuthnAccount,
    keyId: keyIdHex,
  };
}

/**
 * Generate a unique key ID for this device/wallet
 * The key ID is used to identify the passkey in the smart contract
 */
export function generateKeyId(): string {
  // Use a deterministic key ID based on timestamp and random bytes
  // In production, this could be derived from device ID or user ID
  const timestamp = Date.now().toString(36);
  const random = crypto.getRandomValues(new Uint8Array(8));
  const randomHex = Array.from(random)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `pragma-${timestamp}-${randomHex}`;
}

/**
 * Create a stored key ID based on public key
 * This ensures the same passkey always gets the same key ID
 */
export async function getOrCreateKeyId(): Promise<string> {
  const publicKey = await getPasskeyPublicKey();
  if (!publicKey) {
    throw new Error("No passkey found");
  }

  // Derive key ID from public key hash for determinism
  const keyIdHash = keccak256(publicKey);
  return `pragma-${keyIdHash.slice(2, 18)}`; // Use first 8 bytes of hash
}

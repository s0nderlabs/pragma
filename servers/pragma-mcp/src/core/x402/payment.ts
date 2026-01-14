// x402 Payment Signing
// EIP-3009 TransferWithAuthorization signature generation
// Copyright (c) 2026 s0nderlabs

import { type Hex, type Address, createWalletClient, http, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getSessionKey } from "../session/keys.js";
import { buildViemChain } from "../../config/chains.js";
// NOTE: DO NOT import x402HttpOptions here - signing is local, no RPC needed
// Using x402HttpOptions would create a circular dependency
import type {
  EIP3009Authorization,
  X402PaymentPayload,
  X402PaymentRequirements,
} from "./types.js";

// MARK: - EIP-3009 Constants

/**
 * EIP-3009 TypedData types for TransferWithAuthorization
 * Used for USDC gasless transfers
 */
const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

// MARK: - Helpers

/**
 * Generate random bytes32 nonce for EIP-3009
 * Each authorization must have a unique nonce
 */
function generateNonce(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return ("0x" +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")) as Hex;
}

// MARK: - Payment Signing

/**
 * Sign EIP-3009 TransferWithAuthorization with session key
 *
 * The session key is an EOA stored in Keychain - no Touch ID required.
 * This enables auto-payment without user interaction for API calls.
 *
 * @param requirements - Payment requirements from 402 response
 * @param usdcAddress - USDC contract address
 * @param chainId - Chain ID for EIP-712 domain
 * @param rpcUrl - RPC URL for wallet client
 * @returns Authorization and signature
 */
export async function signPaymentAuthorization(
  requirements: X402PaymentRequirements,
  usdcAddress: Address,
  chainId: number,
  rpcUrl: string
): Promise<{ authorization: EIP3009Authorization; signature: Hex }> {
  // Get session key from Keychain
  const sessionKey = await getSessionKey();
  if (!sessionKey) {
    throw new Error("Session key not found. Run setup_wallet first.");
  }

  const account = privateKeyToAccount(sessionKey.privateKey);
  const chain = buildViemChain(chainId, rpcUrl);

  // Use regular http transport for signing - no RPC calls needed
  // signTypedData is a local operation, doesn't require network access
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(rpcUrl),
  });

  // Build authorization with time window
  // All addresses must be checksummed for EIP-712 validation
  const now = Math.floor(Date.now() / 1000);
  const authorization: EIP3009Authorization = {
    from: getAddress(sessionKey.address),
    to: getAddress(requirements.payTo),
    value: BigInt(requirements.amount),
    validAfter: BigInt(now - 60), // 1 minute ago (clock skew tolerance)
    validBefore: BigInt(now + 300), // 5 minutes from now
    nonce: generateNonce(),
  };

  // Build EIP-712 domain with USDC contract
  // Use extra fields from requirements if provided (for token name/version)
  // verifyingContract must be checksummed
  const domain = {
    name: requirements.extra?.name || "USDC",
    version: requirements.extra?.version || "2",
    chainId,
    verifyingContract: getAddress(usdcAddress),
  };

  // Sign with session key (EOA - no Touch ID required)
  const signature = await walletClient.signTypedData({
    domain,
    types: EIP3009_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: authorization.from,
      to: authorization.to,
      value: authorization.value,
      validAfter: authorization.validAfter,
      validBefore: authorization.validBefore,
      nonce: authorization.nonce,
    },
  });

  return { authorization, signature };
}

/**
 * Create X-Payment header value from authorization
 *
 * The header is a base64-encoded JSON payload containing:
 * - x402 version
 * - Resource info
 * - Accepted payment requirements
 * - Signed authorization
 *
 * @param authorization - EIP-3009 authorization
 * @param signature - EIP-712 signature
 * @param requirements - Payment requirements
 * @param resource - Resource being accessed
 * @returns Base64-encoded payment header
 */
export function createPaymentHeader(
  authorization: EIP3009Authorization,
  signature: Hex,
  requirements: X402PaymentRequirements,
  resource: { url: string; description: string; mimeType: string }
): string {
  const payload: X402PaymentPayload = {
    x402Version: 2, // Must match server's expected version
    resource,
    accepted: requirements,
    payload: {
      authorization: {
        from: authorization.from,
        to: authorization.to,
        value: authorization.value.toString(),
        validAfter: authorization.validAfter.toString(),
        validBefore: authorization.validBefore.toString(),
        nonce: authorization.nonce,
      },
      signature,
    },
  };

  // Base64 encode for header transport
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

/**
 * Decode X-Payment-Response header
 *
 * @param header - Base64-encoded response header
 * @returns Decoded payment response
 */
export function decodePaymentResponse(header: string): {
  success: boolean;
  txHash?: Hex;
  error?: string;
} {
  try {
    const decoded = Buffer.from(header, "base64").toString("utf-8");
    return JSON.parse(decoded);
  } catch {
    return { success: false, error: "Failed to decode payment response" };
  }
}

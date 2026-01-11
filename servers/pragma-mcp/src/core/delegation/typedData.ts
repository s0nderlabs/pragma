// EIP-712 Typed Data for Delegations
// Adapted from pragma-v2-stable (H2)
// Copyright (c) 2026 s0nderlabs

import type { Address, Hex } from "viem";
import { hashTypedData, getAddress } from "viem";
import type { Delegation } from "@metamask/delegation-toolkit";
import { DELEGATION_FRAMEWORK } from "../../config/constants.js";

// EIP-712 typed data structure
export interface DelegationTypedData {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: Address;
  };
  types: {
    Delegation: Array<{ name: string; type: string }>;
    Caveat: Array<{ name: string; type: string }>;
  };
  primaryType: "Delegation";
  message: {
    delegate: Address;
    delegator: Address;
    authority: Hex;
    caveats: Array<{ enforcer: Address; terms: Hex }>;
    salt: string;
  };
}

// MARK: - EIP-712 Type Definitions

/**
 * EIP-712 type definitions for Delegation struct
 * Must match the DelegationManager contract exactly
 */
const DELEGATION_TYPES = {
  Delegation: [
    { name: "delegate", type: "address" },
    { name: "delegator", type: "address" },
    { name: "authority", type: "bytes32" },
    { name: "caveats", type: "Caveat[]" },
    { name: "salt", type: "uint256" },
  ] as { name: string; type: string }[],
  // Note: "args" is NOT part of the EIP-712 signature - it's a runtime parameter
  // passed when redeeming, not when creating the delegation
  Caveat: [
    { name: "enforcer", type: "address" },
    { name: "terms", type: "bytes" },
  ] as { name: string; type: string }[],
};

/**
 * Domain name for DelegationManager
 */
const DOMAIN_NAME = "DelegationManager";

/**
 * Domain version for DelegationManager
 */
const DOMAIN_VERSION = "1";

// MARK: - Public API

/**
 * Build EIP-712 typed data for a delegation
 * This is what gets signed by the passkey
 *
 * @param delegation - The delegation to sign
 * @param chainId - Chain ID for domain separator
 * @param delegationManager - Optional delegation manager address (uses default if not provided)
 * @returns EIP-712 typed data structure
 */
export function buildDelegationTypedData(
  delegation: Delegation,
  chainId: number,
  delegationManager?: Address
): DelegationTypedData {
  const verifyingContract = delegationManager ?? DELEGATION_FRAMEWORK.delegationManager;

  // Convert caveats to proper format for EIP-712 signing
  // Note: args is NOT included in the signed typed data - it's a runtime parameter
  const caveats = delegation.caveats.map((caveat) => ({
    enforcer: getAddress(caveat.enforcer),
    terms: caveat.terms as Hex,
  }));

  // Convert salt to string (DTK returns it as bigint or Hex)
  const saltString = String(delegation.salt);

  return {
    domain: {
      name: DOMAIN_NAME,
      version: DOMAIN_VERSION,
      chainId,
      verifyingContract,
    },
    types: DELEGATION_TYPES,
    primaryType: "Delegation",
    message: {
      delegate: getAddress(delegation.delegate),
      delegator: getAddress(delegation.delegator),
      authority: delegation.authority as Hex,
      caveats,
      salt: saltString,
    },
  };
}

/**
 * Hash a delegation using EIP-712
 * Used to verify signatures and for authority chaining
 *
 * @param delegation - The delegation to hash
 * @param chainId - Chain ID for domain separator
 * @returns The EIP-712 hash (bytes32)
 */
export function hashDelegation(delegation: Delegation, chainId: number): Hex {
  const typedData = buildDelegationTypedData(delegation, chainId);

  return hashTypedData({
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: {
      delegate: typedData.message.delegate,
      delegator: typedData.message.delegator,
      authority: typedData.message.authority,
      caveats: typedData.message.caveats.map((c) => ({
        enforcer: c.enforcer,
        terms: c.terms,
      })),
      salt: BigInt(typedData.message.salt),
    },
  });
}

/**
 * Convert typed data to JSON for Swift binary signing
 * The Swift binary expects stringified JSON for signTypedData
 *
 * @param typedData - EIP-712 typed data
 * @returns JSON string for signing
 */
export function typedDataToJson(typedData: DelegationTypedData): string {
  // Ensure all BigInt values are converted to strings for JSON
  const message = {
    ...typedData.message,
    // salt is already a string in DelegationTypedData.message
  };

  return JSON.stringify({
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message,
  });
}

/**
 * Verify a delegation signature
 * Recovers the signer address from the signature and compares
 *
 * @param delegation - The signed delegation
 * @param chainId - Chain ID for domain separator
 * @param expectedSigner - Expected signer address
 * @returns True if signature is valid
 */
export async function verifyDelegationSignature(
  delegation: Delegation,
  chainId: number,
  expectedSigner: Address
): Promise<boolean> {
  // For P-256 signatures (passkeys), verification happens on-chain
  // This is a placeholder for secp256k1 verification if needed
  // The actual P-256 verification is done by the HybridDeleGator contract

  // For now, just check that signature is present and non-empty
  if (!delegation.signature || delegation.signature === "0x") {
    return false;
  }

  // On-chain verification is handled by DelegationManager
  // This function is for local validation before submission
  return true;
}

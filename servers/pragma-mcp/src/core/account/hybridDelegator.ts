// HybridDelegator Smart Account with P-256 Passkey
// Creates and manages the smart account with native P-256 signing
// Private keys NEVER leave the Keychain - Touch ID required for all signing
// Using @metamask/smart-accounts-kit v0.3.0 (native Monad support)
// Copyright (c) 2026 s0nderlabs

import {
  type Address,
  type Hex,
  type PublicClient,
  type Chain,
  getAddress,
  createPublicClient,
  http,
  zeroAddress,
  toHex,
} from "viem";
import {
  Implementation,
  toMetaMaskSmartAccount,
  getSmartAccountsEnvironment,
  type MetaMaskSmartAccount,
  type SmartAccountsEnvironment,
} from "@metamask/smart-accounts-kit";
import {
  getP256Owner,
  createWebAuthnSignerConfig,
  getOrCreateKeyId,
  type P256Owner,
} from "../signer/p256SignerConfig.js";
import { getPasskeyPublicKey, parseP256PublicKey } from "../signer/index.js";
import { buildViemChain } from "../../config/chains.js";
import { getRpcUrl } from "../../config/pragma-config.js";
import { x402HttpOptions } from "../x402/client.js";
import type { PragmaConfig } from "../../types/index.js";

/**
 * Handle for interacting with the HybridDelegator smart account
 */
export interface HybridDelegatorHandle {
  smartAccount: MetaMaskSmartAccount<Implementation.Hybrid>;
  address: Address;
  keyId: string;
  p256Owner: P256Owner;
  publicClient: PublicClient;
  chain: Chain;
  environment: SmartAccountsEnvironment;
}

/**
 * Get the P-256 public key coordinates for display
 * Does NOT require Touch ID
 */
export async function getP256Coordinates(): Promise<{ x: bigint; y: bigint } | null> {
  const publicKey = await getPasskeyPublicKey();
  if (!publicKey) return null;
  return parseP256PublicKey(publicKey);
}

/**
 * Build deploy params for HybridDelegator
 * Format: [eoaOwner, keyIds[], xCoords[], yCoords[]]
 */
function buildDeployParams(keyId: string, p256Owner: P256Owner): [Address, Hex[], bigint[], bigint[]] {
  return [
    zeroAddress,
    [toHex(keyId)],
    [p256Owner.x],
    [p256Owner.y],
  ];
}

/**
 * Options for creating a HybridDelegator handle
 */
export interface CreateHybridDelegatorOptions {
  /** Custom message shown in Touch ID prompt */
  touchIdMessage?: string;
}

/**
 * Create a handle for a HybridDelegator smart account
 * Uses native P-256 passkey for signing (via synthetic WebAuthn)
 * Private keys NEVER leave the Keychain
 *
 * @param config - Pragma configuration
 * @param options - Optional settings including custom Touch ID message
 */
export async function createHybridDelegatorHandle(
  config: PragmaConfig,
  options?: CreateHybridDelegatorOptions
): Promise<HybridDelegatorHandle> {
  // Get RPC URL based on mode (x402 = proxy, BYOK = Keychain)
  const rpcUrl = await getRpcUrl(config);
  const chain = buildViemChain(config.network.chainId, rpcUrl);
  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl, x402HttpOptions()),
  });

  const keyId = await getOrCreateKeyId();
  const p256Owner = await getP256Owner(keyId);
  const touchIdMessage = options?.touchIdMessage ?? "Sign transaction";
  const signerConfig = await createWebAuthnSignerConfig(keyId, touchIdMessage);
  const environment = getSmartAccountsEnvironment(config.network.chainId);

  const smartAccount = await toMetaMaskSmartAccount({
    client: publicClient,
    implementation: Implementation.Hybrid,
    signer: signerConfig as any,
    deployParams: buildDeployParams(keyId, p256Owner),
    deploySalt: "0x",
    environment,
  });

  return {
    smartAccount: smartAccount as MetaMaskSmartAccount<Implementation.Hybrid>,
    address: getAddress(await smartAccount.getAddress()),
    keyId,
    p256Owner,
    publicClient,
    chain,
    environment,
  };
}

/**
 * Check if smart account is deployed
 */
export async function isSmartAccountDeployed(
  handle: HybridDelegatorHandle
): Promise<boolean> {
  // Try the SDK method first
  try {
    const deployed = await handle.smartAccount.isDeployed?.();
    if (typeof deployed === "boolean") {
      return deployed;
    }
  } catch {
    // Fall through to bytecode check
  }

  // Check bytecode as fallback
  const bytecode = await handle.publicClient.getBytecode({
    address: handle.address,
  });
  return !!bytecode && bytecode !== "0x";
}

/**
 * Get factory args for deployment
 * @returns Factory address and factory data for deployment
 */
export async function getFactoryArgs(
  handle: HybridDelegatorHandle
): Promise<{ factory: Address; factoryData: Hex } | null> {
  const args = await handle.smartAccount.getFactoryArgs?.();
  if (!args) return null;

  return {
    factory: args.factory as Address,
    factoryData: args.factoryData as Hex,
  };
}

/**
 * Get the account nonce for UserOps
 */
export async function getAccountNonce(
  handle: HybridDelegatorHandle
): Promise<bigint> {
  return (await handle.smartAccount.getNonce?.()) ?? 0n;
}

/**
 * Get the entry point address
 */
export function getEntryPointAddress(handle: HybridDelegatorHandle): Address {
  return handle.smartAccount.entryPoint.address;
}

/**
 * Derive smart account address from passkey without creating full handle
 * Useful for checking if account exists before full setup
 * Does NOT require Touch ID (only uses public key)
 */
export async function deriveSmartAccountAddress(
  chainId: number,
  rpcUrl: string
): Promise<Address> {
  const chain = buildViemChain(chainId, rpcUrl);
  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl, x402HttpOptions()),
  });

  const keyId = await getOrCreateKeyId();
  const p256Owner = await getP256Owner(keyId);
  const signerConfig = await createWebAuthnSignerConfig(keyId);
  const environment = getSmartAccountsEnvironment(chainId);

  const smartAccount = await toMetaMaskSmartAccount({
    client: publicClient,
    implementation: Implementation.Hybrid,
    signer: signerConfig as any,
    deployParams: buildDeployParams(keyId, p256Owner),
    deploySalt: "0x",
    environment,
  });

  return getAddress(await smartAccount.getAddress());
}

/**
 * @deprecated Use createHybridDelegatorHandle instead
 * This function is no longer needed since we use P-256 directly
 */
export async function deriveOwnerFromPasskey(_message?: string): Promise<Address> {
  throw new Error(
    "DEPRECATED: deriveOwnerFromPasskey is no longer used. Smart account now uses P-256 passkey directly."
  );
}

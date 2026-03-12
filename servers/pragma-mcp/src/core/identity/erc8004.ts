/**
 * ERC-8004 Identity Registry Integration
 *
 * Registers pragma agents on the ERC-8004 Identity Registry (ERC-721 NFT).
 * Session key EOA calls register() directly — no delegation or Touch ID needed.
 *
 * @see https://eips.ethereum.org/EIPS/eip-8004
 * Copyright (c) 2026 s0nderlabs
 */

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  parseEventLogs,
  zeroAddress,
  type Address,
  type Hex,
  type PrivateKeyAccount,
  type PublicClient,
  type WalletClient,
} from "viem";
import { IDENTITY_REGISTRY_ADDRESS } from "../../config/constants.js";
import { buildViemChain } from "../../config/chains.js";
import { getRpcUrl } from "../../config/pragma-config.js";
import {
  getSessionKey,
  getSessionAccount,
} from "../session/keys.js";
import { createSyncHttpTransport } from "../x402/client.js";
import { waitForReceiptSync } from "../rpc/index.js";
import { withRetry } from "../utils/retry.js";
import type { PragmaConfig } from "../../types/index.js";

// Minimum gas for an identity registration tx (~0.01 MON)
const MIN_GAS_FOR_REGISTRATION = BigInt("10000000000000000");

// ============================================================================
// ABI (minimal — only what pragma needs)
// ============================================================================

const IDENTITY_REGISTRY_ABI = [
  {
    type: "function",
    name: "register",
    inputs: [{ name: "agentURI", type: "string" }],
    outputs: [{ name: "tokenId", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "updateAgentURI",
    inputs: [
      { name: "tokenId", type: "uint256" },
      { name: "agentURI", type: "string" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "tokenURI",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "string" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "ownerOf",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

// ERC-721 Transfer event for parsing tokenId from mint receipts
const TRANSFER_EVENT_ABI = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
    ],
  },
] as const;

// ============================================================================
// Agent URI
// ============================================================================

/**
 * Build the agentURI for a pragma agent.
 * Points to the per-user agent.json hosted on api.pr4gma.xyz.
 * If ownerAddress is provided, includes it as a query param so the
 * agent.json links the session key to the smart account (HybridDeleGator).
 */
export function buildAgentURI(sessionKeyAddress: Address, ownerAddress?: Address): string {
  const base = `https://api.pr4gma.xyz/agent/${getAddress(sessionKeyAddress)}.json`;
  return ownerAddress ? `${base}?owner=${getAddress(ownerAddress)}` : base;
}

// Re-export for use in standalone tool gas check
export { MIN_GAS_FOR_REGISTRATION };

// ============================================================================
// Read Operations
// ============================================================================

export interface AgentRegistration {
  registered: boolean;
  tokenId?: bigint;
  agentURI?: string;
}

async function fetchTokenURI(publicClient: PublicClient, tokenId: bigint): Promise<string | undefined> {
  try {
    return await publicClient.readContract({
      address: IDENTITY_REGISTRY_ADDRESS,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: "tokenURI",
      args: [tokenId],
    }) as string || undefined;
  } catch (e) {
    console.error("[erc8004] tokenURI fetch failed:", e instanceof Error ? e.message : e);
    return undefined;
  }
}

/**
 * Check if an address has an ERC-8004 identity registration.
 * Uses balanceOf to check registration status. If a known tokenId is
 * provided (from config), verifies it with ownerOf. Otherwise falls back
 * to paginated Transfer event scanning (Monad limits eth_getLogs to 100 blocks).
 */
export async function getAgentRegistration(
  publicClient: PublicClient,
  address: Address,
  knownTokenId?: bigint,
): Promise<AgentRegistration> {
  // Fast path: verify a known tokenId from config
  if (knownTokenId !== undefined) {
    try {
      const owner = await publicClient.readContract({
        address: IDENTITY_REGISTRY_ADDRESS,
        abi: IDENTITY_REGISTRY_ABI,
        functionName: "ownerOf",
        args: [knownTokenId],
      }) as Address;
      if (owner.toLowerCase() === address.toLowerCase()) {
        const agentURI = await fetchTokenURI(publicClient, knownTokenId);
        return { registered: true, tokenId: knownTokenId, agentURI };
      }
    } catch {
      // ownerOf reverts if token doesn't exist — fall through to balanceOf
    }
  }

  const balanceResult = await withRetry(
    async () => publicClient.readContract({
      address: IDENTITY_REGISTRY_ADDRESS,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: "balanceOf",
      args: [address],
    }),
    { operationName: "erc8004-balanceOf" },
  );

  if (!balanceResult.success || balanceResult.data === 0n) {
    return { registered: false };
  }

  // Find tokenId by scanning Transfer events (mint = from zero address)
  // Monad RPC limits eth_getLogs to 100 blocks, so paginate backwards
  try {
    const currentBlock = await publicClient.getBlockNumber();
    const MAX_CHUNK = 100n;
    const MAX_LOOKBACK = 10_000n; // ~2.8 hours on Monad (1s blocks)
    const earliestBlock = currentBlock > MAX_LOOKBACK ? currentBlock - MAX_LOOKBACK : 0n;

    let toBlock = currentBlock;
    while (toBlock > earliestBlock) {
      const fromBlock = toBlock - MAX_CHUNK > earliestBlock ? toBlock - MAX_CHUNK : earliestBlock;
      const logs = await publicClient.getLogs({
        address: IDENTITY_REGISTRY_ADDRESS,
        event: TRANSFER_EVENT_ABI[0],
        args: { from: zeroAddress, to: address },
        fromBlock,
        toBlock,
      });

      if (logs.length > 0) {
        const latestLog = logs[logs.length - 1];
        const tokenId = latestLog.args.tokenId;
        if (tokenId === undefined || tokenId === null) {
          return { registered: true };
        }

        const agentURI = await fetchTokenURI(publicClient, tokenId);
        return { registered: true, tokenId, agentURI };
      }

      toBlock = fromBlock - 1n;
    }
  } catch (e) {
    console.error("[erc8004] Log scanning failed:", e instanceof Error ? e.message : e);
  }

  // balanceOf > 0 but couldn't find tokenId (registered long ago)
  return { registered: true };
}

// ============================================================================
// Write Operations
// ============================================================================

export interface RegisterResult {
  txHash: Hex;
  tokenId: bigint;
  agentURI: string;
  blockNumber: bigint;
}

/**
 * Register an agent on the ERC-8004 Identity Registry.
 * Session key EOA calls register() directly.
 */
export async function registerAgent(
  walletClient: WalletClient,
  publicClient: PublicClient,
  agentURI: string,
  account: PrivateKeyAccount,
): Promise<RegisterResult> {
  const calldata = encodeFunctionData({
    abi: IDENTITY_REGISTRY_ABI,
    functionName: "register",
    args: [agentURI],
  });

  const txHash = await walletClient.sendTransaction({
    account,
    chain: null,
    to: IDENTITY_REGISTRY_ADDRESS,
    data: calldata,
  });

  // Wait for receipt and parse Transfer event for tokenId
  const receipt = await waitForReceiptSync(publicClient, txHash);

  if (receipt.status === "reverted") {
    throw new Error("Registration transaction reverted");
  }

  const logs = parseEventLogs({
    abi: TRANSFER_EVENT_ABI,
    logs: receipt.logs,
  });

  const transferLog = logs.find(
    (log) =>
      log.eventName === "Transfer" &&
      log.args.from?.toLowerCase() === zeroAddress,
  );

  if (!transferLog || transferLog.args.tokenId === undefined) {
    throw new Error("Transfer event not found in registration receipt");
  }

  return {
    txHash,
    tokenId: transferLog.args.tokenId,
    agentURI,
    blockNumber: receipt.blockNumber,
  };
}

/**
 * Update the agentURI for an existing registration.
 */
export async function updateAgentURIOnChain(
  walletClient: WalletClient,
  publicClient: PublicClient,
  tokenId: bigint,
  newURI: string,
  account: PrivateKeyAccount,
): Promise<Hex> {
  const calldata = encodeFunctionData({
    abi: IDENTITY_REGISTRY_ABI,
    functionName: "updateAgentURI",
    args: [tokenId, newURI],
  });

  const txHash = await walletClient.sendTransaction({
    account,
    chain: null,
    to: IDENTITY_REGISTRY_ADDRESS,
    data: calldata,
  });

  const receipt = await waitForReceiptSync(publicClient, txHash);
  if (receipt.status === "reverted") {
    throw new Error("Update agentURI transaction reverted");
  }

  return txHash;
}

// ============================================================================
// Setup Integration
// ============================================================================

export interface SetupRegistrationResult {
  tokenId?: bigint;
  txHash?: Hex;
  status: "registered" | "already_registered" | "skipped" | "failed";
  error?: string;
}

/**
 * Register agent during setup_wallet flow.
 * Best-effort: returns status but never throws.
 */
export async function registerAgentInSetup(
  config: PragmaConfig,
  chainId: number,
): Promise<SetupRegistrationResult> {
  try {
    const sessionKey = await getSessionKey();
    if (!sessionKey) {
      return { status: "skipped", error: "No session key" };
    }

    const sessionAccount = getSessionAccount(sessionKey);
    const rpcUrl = await getRpcUrl(config);
    const chain = buildViemChain(chainId, rpcUrl);
    const transport = createSyncHttpTransport(rpcUrl, config);

    const publicClient = createPublicClient({ chain, transport });

    // Check gas first before any expensive operations
    const balance = await publicClient.getBalance({
      address: sessionAccount.address,
    });
    if (balance < MIN_GAS_FOR_REGISTRATION) {
      return { status: "skipped", error: "Session key has insufficient gas for registration" };
    }

    // Check if already registered — pass known tokenId from config for fast ownerOf check
    const knownTokenId = config.wallet?.agentId ? BigInt(config.wallet.agentId) : undefined;
    const existing = await getAgentRegistration(publicClient, sessionAccount.address, knownTokenId);
    if (existing.registered && existing.tokenId !== undefined) {
      return {
        tokenId: existing.tokenId,
        status: "already_registered",
      };
    }

    // Register
    const walletClient = createWalletClient({
      account: sessionAccount,
      chain,
      transport,
    });
    const agentURI = buildAgentURI(sessionAccount.address, config.wallet?.smartAccountAddress as `0x${string}` | undefined);
    const result = await registerAgent(walletClient, publicClient, agentURI, sessionAccount);

    return {
      tokenId: result.tokenId,
      txHash: result.txHash,
      status: "registered",
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return { status: "failed", error: msg };
  }
}

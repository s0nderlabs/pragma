// nad.fun Token Creation
// Creates new tokens on the bonding curve via delegation framework
// Copyright (c) 2026 s0nderlabs

import type { Address, Hex } from "viem";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  parseEventLogs,
  parseUnits,
  formatUnits,
} from "viem";
import {
  redeemDelegations,
  createExecution,
  ExecutionMode,
} from "@metamask/smart-accounts-kit";
import type { SignedDelegation } from "../delegation/types.js";
import { createNadFunCreateDelegation } from "../delegation/hybrid.js";
import { getCurrentNonce } from "../delegation/nonce.js";
import { getSessionKey, getSessionAccount } from "../session/keys.js";
import { signDelegationWithP256 } from "../signer/p256SignerConfig.js";
import { loadConfig, getRpcUrl } from "../../config/pragma-config.js";
import { buildViemChain, getChainConfig } from "../../config/chains.js";
import { createSyncHttpTransport } from "../x402/client.js";
import { waitForReceiptSync } from "../rpc/index.js";
import { DELEGATION_FRAMEWORK } from "../../config/constants.js";
import {
  ROUTER_CREATE_ABI,
  NADFUN_DEPLOY_FEE,
  DEFAULT_SLIPPAGE_BPS,
} from "./constants.js";
import { getNadFunContracts, getInitialBuyAmountOut } from "./client.js";
import {
  uploadTokenImage,
  uploadTokenMetadata,
  mineTokenSalt,
} from "./api-client.js";
import {
  getMinBalanceForOperation,
  formatSessionKeyBalance,
} from "../session/manager.js";
import type {
  TokenCreationInput,
  CreateQuote,
  CreateResult,
} from "./types.js";

// ============================================================================
// Quote Cache
// ============================================================================

/** Cache for creation quotes (5 min expiry) */
const createQuoteCache = new Map<string, CreateQuote>();

/** Generate unique quote ID */
function generateQuoteId(): string {
  return `create-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Get cached create quote */
export function getCachedCreateQuote(quoteId: string): CreateQuote | undefined {
  return createQuoteCache.get(quoteId);
}

/** Check if create quote is expired */
export function isCreateQuoteExpired(quote: CreateQuote): boolean {
  return Date.now() > quote.expiresAt;
}

/** Delete create quote */
export function deleteCreateQuote(quoteId: string): void {
  createQuoteCache.delete(quoteId);
}

// ============================================================================
// Token Creation ABI (for event parsing)
// ============================================================================

const CREATE_EVENT_ABI = [
  {
    type: "event",
    name: "Create",
    inputs: [
      { type: "address", name: "owner", indexed: true },
      { type: "address", name: "curve", indexed: true },
      { type: "address", name: "token", indexed: true },
      { type: "string", name: "tokenURI" },
      { type: "string", name: "name" },
      { type: "string", name: "symbol" },
      { type: "uint256", name: "virtualNative" },
      { type: "uint256", name: "virtualToken" },
    ],
  },
] as const;

// ============================================================================
// Prepare Token Creation
// ============================================================================

/**
 * Prepare token creation - upload assets and build calldata
 *
 * Flow:
 * 1. Upload image to nad.fun storage
 * 2. Upload metadata (name, symbol, description, socials)
 * 3. Mine vanity address salt (7777 suffix)
 * 4. Build create() calldata
 * 5. Cache quote with 5-min expiry
 */
export async function prepareTokenCreation(
  input: TokenCreationInput,
  creator: Address
): Promise<CreateQuote> {
  const config = await loadConfig();
  if (!config?.wallet) {
    throw new Error("Wallet not configured. Please run setup_wallet first.");
  }

  const chainId = config.network.chainId;

  // Step 1: Upload image
  const imageUri = await uploadTokenImage(input.imagePath);

  // Step 2: Upload metadata
  const metadataUri = await uploadTokenMetadata({
    name: input.name,
    symbol: input.symbol,
    imageUri,
    description: input.description,
    twitter: input.twitter,
    telegram: input.telegram,
    website: input.website,
  });

  // Step 3: Mine vanity address
  const { salt, address: predictedTokenAddress } = await mineTokenSalt(
    creator,
    input.name,
    input.symbol,
    metadataUri
  );

  // Step 4: Build calldata
  let initialAmountOut = 0n;
  if (input.initialBuyMon) {
    const buyWei = parseUnits(input.initialBuyMon, 18);
    const expectedOut = await getInitialBuyAmountOut(buyWei, chainId);
    // Apply slippage (provided or default 5%)
    const slippageBps = input.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
    initialAmountOut = (expectedOut * BigInt(10000 - slippageBps)) / 10000n;
  }

  const calldata = encodeFunctionData({
    abi: ROUTER_CREATE_ABI,
    functionName: "create",
    args: [
      {
        name: input.name,
        symbol: input.symbol,
        tokenURI: metadataUri,
        amountOut: initialAmountOut,
        salt,
        actionId: 1, // Graduate to Capricorn V3
      },
    ],
  });

  // Step 5: Cache quote
  const quoteId = generateQuoteId();
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes

  const quote: CreateQuote = {
    quoteId,
    name: input.name,
    symbol: input.symbol,
    imageUri,
    metadataUri,
    salt,
    predictedTokenAddress,
    initialBuyMon: input.initialBuyMon,
    expiresAt,
    chainId,
    _calldata: calldata,
  };

  createQuoteCache.set(quoteId, quote);

  return quote;
}

// ============================================================================
// Execute Token Creation
// ============================================================================

/**
 * Execute token creation with optional atomic initial buy
 *
 * Flow:
 * 1. Validate quote not expired
 * 2. Check Smart Account balance for deploy fee (+ initial buy if specified)
 * 3. Check Session Key balance for gas only
 * 4. Create delegation with total value (deploy fee + initial buy)
 * 5. Sign with Touch ID
 * 6. Execute via redeemDelegations()
 * 7. Parse Create event for token address
 *
 * CRITICAL: NEVER retry this - state-changing operation
 *
 * Note: Deploy fee + initial buy MON come from Smart Account (via delegation).
 * Session key only needs gas for the transaction.
 */
export async function executeTokenCreation(quoteId: string): Promise<CreateResult> {
  const config = await loadConfig();
  if (!config?.wallet) {
    return {
      success: false,
      error: "Wallet not configured. Please run setup_wallet first.",
    };
  }

  // Get quote
  const quote = getCachedCreateQuote(quoteId);
  if (!quote) {
    return {
      success: false,
      error: "Quote not found. Please prepare a fresh quote.",
    };
  }

  if (isCreateQuoteExpired(quote)) {
    deleteCreateQuote(quoteId);
    return {
      success: false,
      error: "Quote has expired. Please prepare a fresh quote.",
    };
  }

  const userAddress = config.wallet.smartAccountAddress as Address;
  const sessionKeyAddress = config.wallet.sessionKeyAddress as Address;
  const chainId = config.network.chainId;
  const chainConfig = getChainConfig(chainId);
  const contracts = getNadFunContracts(chainId);

  const rpcUrl = await getRpcUrl(config);
  const chain = buildViemChain(chainId, rpcUrl);
  const publicClient = createPublicClient({
    chain,
    transport: createSyncHttpTransport(rpcUrl, config),
  });

  // Check session key exists
  const sessionKey = await getSessionKey();
  if (!sessionKey) {
    return {
      success: false,
      error: "Session key not found. Please run setup_wallet first.",
    };
  }

  // Calculate total value needed: deploy fee + initial buy (if specified)
  const initialBuyWei = quote.initialBuyMon
    ? parseUnits(quote.initialBuyMon, 18)
    : 0n;
  const totalValue = NADFUN_DEPLOY_FEE + initialBuyWei;

  // Check SMART ACCOUNT balance for deploy fee + initial buy
  // The value comes from the Smart Account via delegation, not session key
  const smartAccountBalance = await publicClient.getBalance({ address: userAddress });
  if (smartAccountBalance < totalValue) {
    const needed = formatUnits(totalValue, 18);
    const have = formatUnits(smartAccountBalance, 18);
    const breakdown = quote.initialBuyMon
      ? `10 MON deploy fee + ${quote.initialBuyMon} MON initial buy`
      : `10 MON deploy fee`;
    return {
      success: false,
      error:
        `Smart Account balance too low. ` +
        `Have: ${have} MON, Need: ${needed} MON (${breakdown}). ` +
        `Transfer MON to your Smart Account (${userAddress}) first.`,
    };
  }

  // Check SESSION KEY balance for gas only
  const sessionKeyBalance = await publicClient.getBalance({ address: sessionKeyAddress });
  const minGasRequired = getMinBalanceForOperation("transfer"); // ~0.04 MON for gas
  if (sessionKeyBalance < minGasRequired) {
    return {
      success: false,
      error:
        `Session key needs gas. ` +
        `Have: ${formatSessionKeyBalance(sessionKeyBalance)}, Need: ~0.05 MON for gas. ` +
        `Fund session key (${sessionKeyAddress}) first.`,
    };
  }

  // Get nonce for delegation
  let nonce: bigint;
  try {
    nonce = await getCurrentNonce(publicClient, userAddress);
  } catch (nonceError) {
    return {
      success: false,
      error: `Failed to fetch nonce: ${nonceError instanceof Error ? nonceError.message : String(nonceError)}`,
    };
  }

  // Create delegation with total value (deploy fee + initial buy)
  const createDelegation = createNadFunCreateDelegation({
    router: contracts.router,
    delegator: userAddress,
    sessionKey: sessionKeyAddress,
    nonce,
    chainId,
    calldata: quote._calldata,
    value: totalValue, // Deploy fee + initial buy
  });

  // Sign with Touch ID
  const actionLabel = quote.initialBuyMon
    ? `Create token ${quote.symbol} + buy ${quote.initialBuyMon} MON`
    : `Create token ${quote.symbol} on nad.fun`;
  const signature = await signDelegationWithP256(
    createDelegation.delegation,
    chainId,
    config.wallet.keyId,
    actionLabel
  );
  createDelegation.delegation.signature = signature;

  // Create session wallet
  const sessionAccount = getSessionAccount(sessionKey);
  const sessionWallet = createWalletClient({
    account: sessionAccount,
    chain,
    transport: createSyncHttpTransport(rpcUrl, config),
  });

  // Execute via redeemDelegations
  try {
    const txHash = await redeemDelegations(
      sessionWallet,
      publicClient,
      DELEGATION_FRAMEWORK.delegationManager,
      [
        {
          permissionContext: [createDelegation.delegation as SignedDelegation],
          executions: [
            createExecution({
              target: contracts.router,
              value: totalValue, // Deploy fee + initial buy
              callData: quote._calldata,
            }),
          ],
          mode: ExecutionMode.SingleDefault,
        },
      ]
    );

    // Wait for confirmation
    const receipt = await waitForReceiptSync(publicClient, txHash);

    if (receipt.status === "reverted") {
      return {
        success: false,
        txHash,
        error: "Transaction reverted on-chain. Token name/symbol may already exist.",
      };
    }

    // Parse Create event to get token address
    let tokenAddress: Address | undefined;
    try {
      const logs = parseEventLogs({
        abi: CREATE_EVENT_ABI,
        logs: receipt.logs,
        eventName: "Create",
      });

      if (logs.length > 0) {
        tokenAddress = logs[0].args.token;
      }
    } catch {
      // Event parsing failed, use predicted address
      tokenAddress = quote.predictedTokenAddress;
    }

    // Clean up quote
    deleteCreateQuote(quoteId);

    // Build success message
    let message = `Token ${quote.symbol} created successfully!`;
    if (quote.initialBuyMon) {
      message += ` Initial buy of ${quote.initialBuyMon} MON included.`;
    }

    return {
      success: true,
      txHash,
      explorerUrl: `${chainConfig.blockExplorer}/tx/${txHash}`,
      tokenAddress: tokenAddress || quote.predictedTokenAddress,
      tokenName: quote.name,
      tokenSymbol: quote.symbol,
      message,
      initialBuyMon: quote.initialBuyMon,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return {
      success: false,
      error: `Token creation failed: ${errorMessage}`,
    };
  }
}

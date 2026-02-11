// Headless Execution Module
// Enables execution on OpenClaw (Linux) using root delegation from web-based approval flow.
// No Touch ID, no macOS Keychain — uses file-based session key + root delegation.
// Copyright (c) 2026 s0nderlabs

import {
  createPublicClient,
  createWalletClient,
  decodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  type Address,
  type Hex,
} from "viem";
import {
  redeemDelegations,
  createExecution,
  ExecutionMode,
} from "@metamask/smart-accounts-kit";
import type { SignedDelegation } from "../delegation/types.js";
import { getRpcUrl } from "../../config/pragma-config.js";
import type { PragmaConfig } from "../../types/index.js";
import { buildViemChain, getChainConfig } from "../../config/chains.js";
import { createSyncHttpTransport } from "../x402/client.js";
import { waitForReceiptSync } from "../rpc/index.js";
import {
  DELEGATION_FRAMEWORK,
  ERC20_APPROVE_SELECTOR,
  ERC20_TRANSFER_SELECTOR,
  DELEGATION_GROUPS,
  WHITELISTED_SPENDERS,
} from "../../config/constants.js";
import { setLogicalOrArgs } from "../delegation/logical-or.js";
import { getSessionKey, getSessionAccount } from "../session/keys.js";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import path from "path";

// ============================================================================
// Types
// ============================================================================

export interface HeadlessExecution {
  target: Address;
  value: bigint;
  callData: Hex;
}

export interface HeadlessResult {
  success: boolean;
  message: string;
  txHash?: string;
  explorerUrl?: string;
  error?: string;
}

interface StoredHeadlessDelegation {
  signedDelegation: SignedDelegation;
  protocols?: string[];
  duration?: number;
  retrievedAt?: number;
}

// ============================================================================
// Delegation Loading
// ============================================================================

/**
 * Load root delegation stored by OpenClaw's web-based delegation flow.
 *
 * OpenClaw stores at: ~/.pragma/delegations/root/delegation.json
 * Format: { signedDelegation: { delegate, delegator, authority, salt, caveats, signature } }
 *
 * This is different from pragma-mcp's format (loadRootDelegation in root.ts):
 * - OpenClaw: field name is `signedDelegation`
 * - pragma-mcp: field name is `delegation`
 * - Different storage paths
 */
export function loadHeadlessDelegation(): SignedDelegation | null {
  const delegationPath = path.join(
    homedir(),
    ".pragma",
    "delegations",
    "root",
    "delegation.json"
  );

  if (!existsSync(delegationPath)) {
    return null;
  }

  try {
    const content = readFileSync(delegationPath, "utf-8");
    const data = JSON.parse(content) as StoredHeadlessDelegation;
    return data.signedDelegation ?? null;
  } catch {
    return null;
  }
}

// ============================================================================
// Group Selection
// ============================================================================

import { LOGICAL_OR_WRAPPER_ENFORCER } from "../../config/constants.js";

/**
 * Count the number of LogicalOr groups encoded in a delegation's terms.
 * Returns the group count, or 2 (legacy default) on decode failure.
 */
function getGroupCount(delegation: { caveats: Array<{ enforcer: string; terms: string }> }): number {
  const logicalOrCaveat = delegation.caveats.find(
    (c) => c.enforcer.toLowerCase() === LOGICAL_OR_WRAPPER_ENFORCER.toLowerCase()
  );
  if (!logicalOrCaveat) return 2;

  try {
    const [groups] = decodeAbiParameters(
      [{
        type: "tuple[]",
        components: [{
          name: "caveats",
          type: "tuple[]",
          components: [
            { name: "enforcer", type: "address" },
            { name: "terms", type: "bytes" },
            { name: "args", type: "bytes" },
          ],
        }],
      }],
      logicalOrCaveat.terms as `0x${string}`,
    );
    return groups.length;
  } catch {
    return 2; // Legacy fallback
  }
}

/**
 * Select the correct LogicalOr group for a headless execution.
 *
 * Backward-compatible: only routes to transfer groups (2/3) if the delegation
 * actually contains them (>= 4 groups). Old 2-group delegations fall through
 * to TRADING, preserving existing behavior.
 */
function selectHeadlessGroup(
  execution: HeadlessExecution,
  delegation: { caveats: Array<{ enforcer: string; terms: string }> },
): number {
  const callDataLower = execution.callData.toLowerCase();

  // approve() call → Group 0
  if (callDataLower.startsWith(ERC20_APPROVE_SELECTOR.toLowerCase())) {
    return DELEGATION_GROUPS.APPROVE;
  }

  // Transfer groups only available in 4+ group delegations
  const groupCount = getGroupCount(delegation);
  if (groupCount >= 4) {
    // Native transfer: empty calldata + value > 0 → Group 3
    if ((execution.callData === "0x" || execution.callData === "0x00") && execution.value > 0n) {
      return DELEGATION_GROUPS.NATIVE_TRANSFER;
    }
    // ERC20 transfer(): selector 0xa9059cbb → Group 2
    if (callDataLower.startsWith(ERC20_TRANSFER_SELECTOR.toLowerCase())) {
      return DELEGATION_GROUPS.ERC20_TRANSFER;
    }
  }

  // Everything else (swaps, leverup, nadfun, wrap/unwrap) → Group 1
  return DELEGATION_GROUPS.TRADING;
}

// ============================================================================
// Core Execution
// ============================================================================

/**
 * Execute a single transaction via root delegation chain (headless mode).
 *
 * Used on OpenClaw/Linux where Touch ID is unavailable. The root delegation
 * was obtained via web-based approval flow (user signs with passkey in browser).
 *
 * Flow:
 * 1. Load root delegation from OpenClaw storage
 * 2. Clone and set LogicalOrWrapperEnforcer args (group selection)
 * 3. Build session key wallet
 * 4. redeemDelegations with 1-delegation chain
 * 5. Wait for receipt
 */
export async function executeHeadless(
  execution: HeadlessExecution,
  config: PragmaConfig
): Promise<HeadlessResult> {
  // 1. Load root delegation
  const rootDelegation = loadHeadlessDelegation();
  if (!rootDelegation) {
    return {
      success: false,
      message: "No delegation found",
      error:
        "Root delegation not found at ~/.pragma/delegations/root/delegation.json. " +
        "Please run the delegation flow first (request_delegation → approve → retrieve_delegation).",
    };
  }

  // 2. Clone and set LogicalOr group
  const cloned = structuredClone(rootDelegation);
  const groupIndex = selectHeadlessGroup(execution, rootDelegation);
  setLogicalOrArgs(cloned, groupIndex);

  // 3. Build session key wallet
  const sessionKey = await getSessionKey();
  if (!sessionKey) {
    return {
      success: false,
      message: "Session key not found",
      error: "File-based session key not found. Run setup_wallet first.",
    };
  }

  const chainId = config.network.chainId;
  const rpcUrl = await getRpcUrl(config);
  const chain = buildViemChain(chainId, rpcUrl);
  const chainConfig = getChainConfig(chainId);

  const sessionAccount = getSessionAccount(sessionKey);
  const sessionWallet = createWalletClient({
    account: sessionAccount,
    chain,
    transport: createSyncHttpTransport(rpcUrl, config),
  });

  const publicClient = createPublicClient({
    chain,
    transport: createSyncHttpTransport(rpcUrl, config),
  });

  // 4. Execute via redeemDelegations with 1-delegation chain
  try {
    const txHash = await redeemDelegations(
      sessionWallet,
      publicClient,
      DELEGATION_FRAMEWORK.delegationManager,
      [
        {
          permissionContext: [cloned] as SignedDelegation[],
          executions: [
            createExecution({
              target: execution.target,
              value: execution.value,
              callData: execution.callData,
            }),
          ],
          mode: ExecutionMode.SingleDefault,
        },
      ]
    );

    // 5. Wait for receipt
    const receipt = await waitForReceiptSync(publicClient, txHash);

    if (receipt.status === "reverted") {
      return {
        success: false,
        message: "Transaction reverted on-chain",
        txHash,
        explorerUrl: `${chainConfig.blockExplorer}/tx/${txHash}`,
        error: "Transaction reverted on-chain",
      };
    }

    return {
      success: true,
      message: "Transaction successful",
      txHash,
      explorerUrl: `${chainConfig.blockExplorer}/tx/${txHash}`,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return {
      success: false,
      message: "Transaction failed",
      error: msg,
    };
  }
}

// ============================================================================
// Execution with Approval
// ============================================================================

/**
 * Check if a spender address is whitelisted for approvals.
 */
function isSpenderWhitelisted(spender: Address): boolean {
  const lower = spender.toLowerCase();
  return Object.values(WHITELISTED_SPENDERS).some(
    (addr) => addr.toLowerCase() === lower
  );
}

/**
 * Execute a trade that may require ERC20 approval first (headless mode).
 *
 * Steps:
 * 1. Check current allowance
 * 2. If insufficient, execute MaxUint256 approval via delegation
 * 3. Execute the main trade
 */
export async function executeHeadlessWithApproval(
  token: Address,
  spender: Address,
  requiredAmount: bigint,
  execution: HeadlessExecution,
  config: PragmaConfig
): Promise<HeadlessResult> {
  // Security: validate spender is whitelisted
  if (!isSpenderWhitelisted(spender)) {
    return {
      success: false,
      message: "Spender not whitelisted",
      error: `Spender ${spender} is not whitelisted for headless approvals.`,
    };
  }

  // Check current allowance
  const owner = config.wallet!.smartAccountAddress as Address;
  const chainId = config.network.chainId;
  const rpcUrl = await getRpcUrl(config);
  const chain = buildViemChain(chainId, rpcUrl);

  const publicClient = createPublicClient({
    chain,
    transport: createSyncHttpTransport(rpcUrl, config),
  });

  let hasApproval = false;
  try {
    const allowance = await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [owner, spender],
    });
    hasApproval = allowance >= requiredAmount;
  } catch {
    // Can't read allowance — assume no approval
  }

  // Execute approval if needed
  if (!hasApproval) {
    const maxApproval = BigInt(
      "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
    );
    const approveCalldata = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [spender, maxApproval],
    });

    const approvalResult = await executeHeadless(
      { target: token, value: 0n, callData: approveCalldata },
      config
    );

    if (!approvalResult.success) {
      return {
        success: false,
        message: "Approval failed",
        error: `ERC20 approval failed: ${approvalResult.error}`,
      };
    }

    // Brief delay for approval to be indexed
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  // Execute the main trade
  return await executeHeadless(execution, config);
}

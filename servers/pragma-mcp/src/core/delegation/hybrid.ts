// Hybrid Delegation Builder
// Creates ephemeral delegations using DTK's createDelegation with scope
// Matches H2 (pragma-v2-stable) approach for AllowedCalldataEnforcer compatibility
// Copyright (c) 2026 s0nderlabs

import type { Address, Hex } from "viem";
import { getAddress, pad, toHex, keccak256, concat, numberToHex } from "viem";
import {
  createDelegation,
  type Delegation,
  type Caveats,
} from "@metamask/smart-accounts-kit";

import { buildDelegationTypedData } from "./typedData.js";
import {
  getDTKEnvironment,
  DELEGATION_FRAMEWORK,
  DEFAULT_DELEGATION_EXPIRY_SECONDS,
} from "../../config/constants.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Caveat structure for delegation constraints
 * Each caveat is enforced by a specific enforcer contract
 */
export interface Caveat {
  enforcer: Address;
  terms: Hex;
  args: Hex;
}

/**
 * Result of creating a delegation
 */
export interface DelegationResult {
  delegation: Delegation;
  typedData: ReturnType<typeof buildDelegationTypedData>;
  expiresAt: number;
}

/**
 * AllowedCalldata builder configuration for DTK
 * Each entry specifies a byte position and expected value
 */
export interface AllowedCalldataConfig {
  startIndex: number;
  value: Hex; // 32-byte padded value
}

/**
 * Context needed to create a swap delegation
 */
export interface SwapDelegationContext {
  aggregator: Address;
  destination: Address;
  delegator: Address;
  sessionKey: Address;
  nonce: bigint;
  chainId: number;
  transactionData?: Hex; // For selector extraction
  nativeValueAmount?: bigint; // For valueLte when swapping native tokens
}

/**
 * Context needed to create an approve delegation
 */
export interface ApproveDelegationContext {
  tokenAddress: Address;
  spender: Address;
  amount: bigint;
  delegator: Address;
  sessionKey: Address;
  nonce: bigint;
  chainId: number;
}

/**
 * Context needed to create an ERC20 transfer delegation
 */
export interface ERC20TransferDelegationContext {
  tokenAddress: Address;
  recipient: Address;
  amount: bigint;
  delegator: Address;
  sessionKey: Address;
  nonce: bigint;
  chainId: number;
}

/**
 * Context needed to create a native MON transfer delegation
 * Uses nativeTokenTransferAmount scope (H2 pattern)
 */
export interface NativeTransferDelegationContext {
  recipient: Address;
  amount: bigint;
  delegator: Address;
  sessionKey: Address;
  nonce: bigint;
  chainId: number;
}

/**
 * @deprecated Use ERC20TransferDelegationContext instead
 */
export type TransferDelegationContext = ERC20TransferDelegationContext;

/**
 * Context needed to create a wrap delegation (MON → WMON)
 */
export interface WrapDelegationContext {
  wmonAddress: Address;
  amount: bigint; // Amount of MON to wrap (for valueLte enforcement)
  delegator: Address;
  sessionKey: Address;
  nonce: bigint;
  chainId: number;
}

/**
 * Context needed to create an unwrap delegation (WMON → MON)
 */
export interface UnwrapDelegationContext {
  wmonAddress: Address;
  delegator: Address;
  sessionKey: Address;
  nonce: bigint;
  chainId: number;
}

// ============================================================================
// Constants
// ============================================================================

/** Zero salt for ephemeral delegations */
export const ZERO_SALT = "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;

/** ERC20 approve function selector */
const ERC20_APPROVE_SELECTOR = "0x095ea7b3" as Hex;

/** ERC20 transfer function selector */
const ERC20_TRANSFER_SELECTOR = "0xa9059cbb" as Hex;

/** WMON deposit function selector (wrap MON → WMON) */
const WMON_DEPOSIT_SELECTOR = "0xd0e30db0" as Hex;

/** WMON withdraw function selector (unwrap WMON → MON) */
const WMON_WITHDRAW_SELECTOR = "0x2e1a7d4d" as Hex;

/** DEX aggregate function selector */
const DEX_AGGREGATE_SELECTOR = "0xf99cae99" as Hex;

// Byte offsets for AllowedCalldataEnforcer
const CALLDATA_OFFSETS = {
  approve: {
    spender: 4,  // After selector
    amount: 36,  // 4 + 32
  },
  transfer: {
    recipient: 4,  // After selector
    amount: 36,    // 4 + 32
  },
  aggregate: {
    destination: 132, // Offset 132 in aggregate() calldata
  },
} as const;

// ============================================================================
// Calldata Enforcement Builders
// ============================================================================

/**
 * Build AllowedCalldata config for ERC20 approve
 * Enforces both spender (offset 4) and amount (offset 36)
 */
function buildApproveEnforcement(
  spender: Address,
  amount: bigint
): AllowedCalldataConfig[] {
  return [
    {
      startIndex: CALLDATA_OFFSETS.approve.spender,
      value: pad(spender, { size: 32 }),
    },
    {
      startIndex: CALLDATA_OFFSETS.approve.amount,
      value: pad(toHex(amount), { size: 32 }),
    },
  ];
}

/**
 * Build AllowedCalldata config for ERC20 transfer
 * Enforces both recipient (offset 4) and amount (offset 36)
 * CRITICAL: Prevents both fund theft and over-spending
 */
function buildTransferEnforcement(
  recipient: Address,
  amount: bigint
): AllowedCalldataConfig[] {
  return [
    {
      startIndex: CALLDATA_OFFSETS.transfer.recipient,
      value: pad(recipient, { size: 32 }),
    },
    {
      startIndex: CALLDATA_OFFSETS.transfer.amount,
      value: pad(toHex(amount), { size: 32 }),
    },
  ];
}

// ============================================================================
// Caveat Builders (DTK format)
// ============================================================================

/**
 * Build caveats for ephemeral delegation (DTK format)
 * DTK's createDelegation converts these to proper enforcer caveats
 */
function buildEphemeralCaveats(nonce: bigint, expiresAt: number): Caveats {
  return [
    {
      type: "timestamp" as const,
      afterThreshold: 0,
      beforeThreshold: expiresAt,
    },
    {
      type: "nonce" as const,
      nonce: toHex(nonce),
    },
    {
      type: "limitedCalls" as const,
      limit: 1,
    },
  ] as unknown as Caveats;
}

// ============================================================================
// Delegation Builders
// ============================================================================

/**
 * Create an approve delegation using DTK's createDelegation with scope
 *
 * Security properties:
 * - 5 minute expiry (TimestampEnforcer)
 * - Single use (LimitedCallsEnforcer limit=1)
 * - Nonce-based revocation (NonceEnforcer)
 * - Spender + amount enforcement (AllowedCalldataEnforcer)
 */
export function createApproveDelegation(
  context: ApproveDelegationContext
): DelegationResult {
  const {
    tokenAddress,
    spender,
    amount,
    delegator,
    sessionKey,
    nonce,
    chainId,
  } = context;

  // Expiry: 5 minutes from now
  const expiresAt = Math.floor(Date.now() / 1000) + DEFAULT_DELEGATION_EXPIRY_SECONDS;

  // Build enforcement for spender + amount
  const allowedCalldata = buildApproveEnforcement(spender, amount);

  // Build scope with parameter enforcement
  const scope = {
    type: "functionCall" as const,
    targets: [getAddress(tokenAddress)],
    selectors: [ERC20_APPROVE_SELECTOR],
    allowedCalldata, // DTK converts this to AllowedCalldataEnforcer caveat
  };

  // Build caveats (timestamp, nonce, limitedCalls: 1)
  const caveats = buildEphemeralCaveats(nonce, expiresAt);

  // Get DTK environment
  const environment = getDTKEnvironment();

  // Create delegation using DTK
  const delegation = createDelegation({
    environment,
    scope,
    from: delegator as Hex,
    to: sessionKey as Hex,
    caveats,
    salt: ZERO_SALT,
  });

  // Build EIP-712 typed data for signing
  const typedData = buildDelegationTypedData(
    delegation,
    chainId,
    DELEGATION_FRAMEWORK.delegationManager
  );

  return {
    delegation,
    typedData,
    expiresAt,
  };
}

/**
 * Create a swap delegation using DTK's createDelegation with scope
 *
 * Security properties:
 * - 5 minute expiry (TimestampEnforcer)
 * - Single use (LimitedCallsEnforcer limit=1)
 * - Nonce-based revocation (NonceEnforcer)
 * - Target + selector enforcement (AllowedTargetsEnforcer + AllowedMethodsEnforcer)
 * - Unique salt per delegation (prevents hash collisions)
 *
 * Additional protections:
 * - Target enforcement: Can only call the specific aggregator address
 * - Selector enforcement: Can only call the specific function
 * - timestamp/nonce/limitedCalls caveats
 * - Session key requirement
 * - The router respects the sender's address (user's smart account)
 */
export function createSwapDelegation(
  context: SwapDelegationContext
): DelegationResult {
  const {
    aggregator,
    destination,
    delegator,
    sessionKey,
    nonce,
    chainId,
    transactionData,
    nativeValueAmount,
  } = context;

  // Expiry: 5 minutes from now
  const expiresAt = Math.floor(Date.now() / 1000) + DEFAULT_DELEGATION_EXPIRY_SECONDS;

  // Extract selector from transaction data
  // Default to a generic swap selector if not provided
  const selector = transactionData && transactionData.length >= 10
    ? (transactionData.slice(0, 10) as Hex)
    : ("0x00000000" as Hex); // Will be overwritten by actual calldata selector

  // valueLte: Allow native value if swapping native token, otherwise 0
  const valueLteConfig = { maxValue: nativeValueAmount ?? 0n };

  // Build scope with basic enforcement
  // Protected by: target enforcement, selector enforcement, timestamp/nonce/limitedCalls caveats
  const scope = {
    type: "functionCall" as const,
    targets: [getAddress(aggregator)],
    selectors: [selector],
    valueLte: valueLteConfig,
  };

  // Build caveats (timestamp, nonce, limitedCalls: 1)
  const caveats = buildEphemeralCaveats(nonce, expiresAt);

  // Get DTK environment
  const environment = getDTKEnvironment();

  // Generate unique salt to prevent hash collisions
  // Critical when parallel operations use same nonce
  const uniqueSalt = keccak256(
    concat([
      numberToHex(Date.now(), { size: 32 }),
      numberToHex(Math.floor(Math.random() * 1e18), { size: 32 }),
      toHex(nonce),
    ])
  );

  // Create delegation using DTK
  const delegation = createDelegation({
    environment,
    scope,
    from: delegator as Hex,
    to: sessionKey as Hex,
    caveats,
    salt: uniqueSalt,
  });

  // Build EIP-712 typed data for signing
  const typedData = buildDelegationTypedData(
    delegation,
    chainId,
    DELEGATION_FRAMEWORK.delegationManager
  );

  return {
    delegation,
    typedData,
    expiresAt,
  };
}

/**
 * Create an ERC20 transfer delegation using DTK's createDelegation with scope
 *
 * Security properties:
 * - 5 minute expiry (TimestampEnforcer)
 * - Single use (LimitedCallsEnforcer limit=1)
 * - Nonce-based revocation (NonceEnforcer)
 * - Recipient + amount enforcement (AllowedCalldataEnforcer)
 * - CRITICAL: Enforces both recipient AND amount to prevent fund theft
 */
export function createERC20TransferDelegation(
  context: ERC20TransferDelegationContext
): DelegationResult {
  const {
    tokenAddress,
    recipient,
    amount,
    delegator,
    sessionKey,
    nonce,
    chainId,
  } = context;

  // Expiry: 5 minutes from now
  const expiresAt = Math.floor(Date.now() / 1000) + DEFAULT_DELEGATION_EXPIRY_SECONDS;

  // Build enforcement for recipient + amount (CRITICAL for security)
  const allowedCalldata = buildTransferEnforcement(recipient, amount);

  // Build scope with parameter enforcement
  const scope = {
    type: "functionCall" as const,
    targets: [getAddress(tokenAddress)],
    selectors: [ERC20_TRANSFER_SELECTOR],
    allowedCalldata, // DTK converts this to AllowedCalldataEnforcer caveat
  };

  // Build caveats (timestamp, nonce, limitedCalls: 1)
  const caveats = buildEphemeralCaveats(nonce, expiresAt);

  // Get DTK environment
  const environment = getDTKEnvironment();

  // Create delegation using DTK
  const delegation = createDelegation({
    environment,
    scope,
    from: delegator as Hex,
    to: sessionKey as Hex,
    caveats,
    salt: ZERO_SALT,
  });

  // Build EIP-712 typed data for signing
  const typedData = buildDelegationTypedData(
    delegation,
    chainId,
    DELEGATION_FRAMEWORK.delegationManager
  );

  return {
    delegation,
    typedData,
    expiresAt,
  };
}

/**
 * @deprecated Use createERC20TransferDelegation instead
 */
export const createTransferDelegation = createERC20TransferDelegation;

/**
 * Create a native MON transfer delegation using DTK's createDelegation with scope
 *
 * Uses `nativeTokenTransferAmount` scope (H2 pattern) with AMOUNT-ONLY enforcement.
 *
 * Security model:
 * - Amount: ✅ Enforced via maxAmount in nativeTokenTransferAmount scope
 * - Recipient: ❌ NOT enforced (pragmatic trade-off)
 *
 * SECURITY TRADE-OFF (documented from H2):
 * While recipient substitution is theoretically possible by an attacker with delegation access,
 * the amount cap provides critical protection against unlimited fund drain. This simplified
 * approach avoids complexity of full Execution struct validation (ExactExecutionEnforcer)
 * while maintaining the most important security constraint.
 *
 * Execution struct for native transfers:
 * - target: recipient address
 * - value: transfer amount (wei)
 * - callData: "0x" (empty)
 */
export function createNativeTransferDelegation(
  context: NativeTransferDelegationContext
): DelegationResult {
  const {
    recipient,
    amount,
    delegator,
    sessionKey,
    nonce,
    chainId,
  } = context;

  // Expiry: 5 minutes from now
  const expiresAt = Math.floor(Date.now() / 1000) + DEFAULT_DELEGATION_EXPIRY_SECONDS;

  // Build scope with amount enforcement only (H2 pattern)
  // NOTE: Recipient is NOT enforced - amount cap is the critical protection
  const scope = {
    type: "nativeTokenTransferAmount" as const,
    maxAmount: amount, // Enforces transfer amount
  };

  // Build caveats (timestamp, nonce, limitedCalls: 1)
  const caveats = buildEphemeralCaveats(nonce, expiresAt);

  // Get DTK environment
  const environment = getDTKEnvironment();

  // Create delegation using DTK
  const delegation = createDelegation({
    environment,
    scope,
    from: delegator as Hex,
    to: sessionKey as Hex,
    caveats,
    salt: ZERO_SALT,
  });

  // Build EIP-712 typed data for signing
  const typedData = buildDelegationTypedData(
    delegation,
    chainId,
    DELEGATION_FRAMEWORK.delegationManager
  );

  return {
    delegation,
    typedData,
    expiresAt,
  };
}

/**
 * Create a wrap delegation (MON → WMON) using DTK's createDelegation with scope
 *
 * Security properties:
 * - 5 minute expiry (TimestampEnforcer)
 * - Single use (LimitedCallsEnforcer limit=1)
 * - Nonce-based revocation (NonceEnforcer)
 * - NO parameter enforcement (deposit() takes no params, amount is msg.value)
 */
export function createWrapDelegation(
  context: WrapDelegationContext
): DelegationResult {
  const {
    wmonAddress,
    amount,
    delegator,
    sessionKey,
    nonce,
    chainId,
  } = context;

  // Expiry: 5 minutes from now
  const expiresAt = Math.floor(Date.now() / 1000) + DEFAULT_DELEGATION_EXPIRY_SECONDS;

  // NO allowedCalldata - deposit() has no parameters
  // Amount is sent via msg.value, not calldata
  // valueLte: Allow sending up to the wrap amount as msg.value
  const scope = {
    type: "functionCall" as const,
    targets: [getAddress(wmonAddress)],
    selectors: [WMON_DEPOSIT_SELECTOR],
    valueLte: { maxValue: amount },
  };

  // Build caveats (timestamp, nonce, limitedCalls: 1)
  const caveats = buildEphemeralCaveats(nonce, expiresAt);

  // Get DTK environment
  const environment = getDTKEnvironment();

  // Create delegation using DTK
  const delegation = createDelegation({
    environment,
    scope,
    from: delegator as Hex,
    to: sessionKey as Hex,
    caveats,
    salt: ZERO_SALT,
  });

  // Build EIP-712 typed data for signing
  const typedData = buildDelegationTypedData(
    delegation,
    chainId,
    DELEGATION_FRAMEWORK.delegationManager
  );

  return {
    delegation,
    typedData,
    expiresAt,
  };
}

/**
 * Create an unwrap delegation (WMON → MON) using DTK's createDelegation with scope
 *
 * Security properties:
 * - 5 minute expiry (TimestampEnforcer)
 * - Single use (LimitedCallsEnforcer limit=1)
 * - Nonce-based revocation (NonceEnforcer)
 * - NO parameter enforcement (amount at offset 4, enforcement system designed for offset 132)
 * - Balance validation prevents over-unwrapping
 */
export function createUnwrapDelegation(
  context: UnwrapDelegationContext
): DelegationResult {
  const {
    wmonAddress,
    delegator,
    sessionKey,
    nonce,
    chainId,
  } = context;

  // Expiry: 5 minutes from now
  const expiresAt = Math.floor(Date.now() / 1000) + DEFAULT_DELEGATION_EXPIRY_SECONDS;

  // NO allowedCalldata - amount parameter at offset 4, not 132
  // Balance validation prevents over-unwrapping
  const scope = {
    type: "functionCall" as const,
    targets: [getAddress(wmonAddress)],
    selectors: [WMON_WITHDRAW_SELECTOR],
  };

  // Build caveats (timestamp, nonce, limitedCalls: 1)
  const caveats = buildEphemeralCaveats(nonce, expiresAt);

  // Get DTK environment
  const environment = getDTKEnvironment();

  // Create delegation using DTK
  const delegation = createDelegation({
    environment,
    scope,
    from: delegator as Hex,
    to: sessionKey as Hex,
    caveats,
    salt: ZERO_SALT,
  });

  // Build EIP-712 typed data for signing
  const typedData = buildDelegationTypedData(
    delegation,
    chainId,
    DELEGATION_FRAMEWORK.delegationManager
  );

  return {
    delegation,
    typedData,
    expiresAt,
  };
}

// ============================================================================
// nad.fun Delegation Builders
// ============================================================================

/**
 * Context needed to create a nad.fun buy delegation
 * buy() is payable - sends MON as msg.value
 */
export interface NadFunBuyDelegationContext {
  router: Address;
  delegator: Address;
  sessionKey: Address;
  nonce: bigint;
  chainId: number;
  calldata: Hex;
  value: bigint; // MON to send as msg.value
}

/**
 * Context needed to create a nad.fun sell delegation
 * sell() is nonpayable - requires token approval first
 */
export interface NadFunSellDelegationContext {
  router: Address;
  delegator: Address;
  sessionKey: Address;
  nonce: bigint;
  chainId: number;
  calldata: Hex;
}

/**
 * Create a nad.fun buy delegation using DTK's createDelegation with scope
 *
 * buy() is payable - MON is sent as msg.value to the bonding curve router.
 *
 * Security properties:
 * - 5 minute expiry (TimestampEnforcer)
 * - Single use (LimitedCallsEnforcer limit=1)
 * - Nonce-based revocation (NonceEnforcer)
 * - Target enforcement (can only call the router)
 * - Value enforcement (valueLte limits MON sent)
 * - Unique salt per delegation (prevents hash collisions)
 */
export function createNadFunBuyDelegation(
  context: NadFunBuyDelegationContext
): DelegationResult {
  const {
    router,
    delegator,
    sessionKey,
    nonce,
    chainId,
    calldata,
    value,
  } = context;

  // Expiry: 5 minutes from now
  const expiresAt = Math.floor(Date.now() / 1000) + DEFAULT_DELEGATION_EXPIRY_SECONDS;

  // Extract selector from calldata
  const selector = calldata.slice(0, 10) as Hex;

  // Build scope with value enforcement for MON sent
  const scope = {
    type: "functionCall" as const,
    targets: [getAddress(router)],
    selectors: [selector],
    valueLte: { maxValue: value }, // Enforce max MON sent
  };

  // Build caveats (timestamp, nonce, limitedCalls: 1)
  const caveats = buildEphemeralCaveats(nonce, expiresAt);

  // Get DTK environment
  const environment = getDTKEnvironment();

  // Generate unique salt to prevent hash collisions
  const uniqueSalt = keccak256(
    concat([
      numberToHex(Date.now(), { size: 32 }),
      numberToHex(Math.floor(Math.random() * 1e18), { size: 32 }),
      toHex(nonce),
    ])
  );

  // Create delegation using DTK
  const delegation = createDelegation({
    environment,
    scope,
    from: delegator as Hex,
    to: sessionKey as Hex,
    caveats,
    salt: uniqueSalt,
  });

  // Build EIP-712 typed data for signing
  const typedData = buildDelegationTypedData(
    delegation,
    chainId,
    DELEGATION_FRAMEWORK.delegationManager
  );

  return {
    delegation,
    typedData,
    expiresAt,
  };
}

/**
 * Create a nad.fun sell delegation using DTK's createDelegation with scope
 *
 * sell() is nonpayable - tokens are transferred from the user's account.
 * Requires prior token approval to the router.
 *
 * Security properties:
 * - 5 minute expiry (TimestampEnforcer)
 * - Single use (LimitedCallsEnforcer limit=1)
 * - Nonce-based revocation (NonceEnforcer)
 * - Target enforcement (can only call the router)
 * - Unique salt per delegation (prevents hash collisions)
 */
export function createNadFunSellDelegation(
  context: NadFunSellDelegationContext
): DelegationResult {
  const {
    router,
    delegator,
    sessionKey,
    nonce,
    chainId,
    calldata,
  } = context;

  // Expiry: 5 minutes from now
  const expiresAt = Math.floor(Date.now() / 1000) + DEFAULT_DELEGATION_EXPIRY_SECONDS;

  // Extract selector from calldata
  const selector = calldata.slice(0, 10) as Hex;

  // Build scope - no value enforcement needed (nonpayable)
  const scope = {
    type: "functionCall" as const,
    targets: [getAddress(router)],
    selectors: [selector],
  };

  // Build caveats (timestamp, nonce, limitedCalls: 1)
  const caveats = buildEphemeralCaveats(nonce, expiresAt);

  // Get DTK environment
  const environment = getDTKEnvironment();

  // Generate unique salt to prevent hash collisions
  const uniqueSalt = keccak256(
    concat([
      numberToHex(Date.now(), { size: 32 }),
      numberToHex(Math.floor(Math.random() * 1e18), { size: 32 }),
      toHex(nonce),
    ])
  );

  // Create delegation using DTK
  const delegation = createDelegation({
    environment,
    scope,
    from: delegator as Hex,
    to: sessionKey as Hex,
    caveats,
    salt: uniqueSalt,
  });

  // Build EIP-712 typed data for signing
  const typedData = buildDelegationTypedData(
    delegation,
    chainId,
    DELEGATION_FRAMEWORK.delegationManager
  );

  return {
    delegation,
    typedData,
    expiresAt,
  };
}

/**
 * Context needed to create a nad.fun token creation delegation
 * create() is payable - requires deploy fee (10 MON on mainnet)
 */
export interface NadFunCreateDelegationContext {
  router: Address;
  delegator: Address;
  sessionKey: Address;
  nonce: bigint;
  chainId: number;
  calldata: Hex;
  value: bigint; // Deploy fee (10 MON on mainnet)
}

/**
 * Context needed to create a LeverUp open trade delegation
 */
export interface LeverUpOpenDelegationContext {
  diamond: Address;
  delegator: Address;
  sessionKey: Address;
  nonce: bigint;
  chainId: number;
  calldata: Hex;
  value: bigint; // Pyth update fee
}

/**
 * Context needed to create a LeverUp close trade delegation
 */
export interface LeverUpCloseDelegationContext {
  diamond: Address;
  delegator: Address;
  sessionKey: Address;
  nonce: bigint;
  chainId: number;
  calldata: Hex;
}

/**
 * Context needed to create a LeverUp update margin delegation
 */
export interface LeverUpUpdateMarginDelegationContext {
  diamond: Address;
  delegator: Address;
  sessionKey: Address;
  nonce: bigint;
  chainId: number;
  calldata: Hex;
  value: bigint; // Native MON being added (if any)
}

/**
 * Create a nad.fun token creation delegation using DTK's createDelegation with scope
 *
 * create() is payable - requires deploy fee (10 MON on mainnet) and optional initial buy.
 * The deploy fee and initial buy are transferred to nad.fun during token creation.
 *
 * Security properties:
 * - 5 minute expiry (TimestampEnforcer)
 * - Single use (LimitedCallsEnforcer limit=1)
 * - Nonce-based revocation (NonceEnforcer)
 * - Target enforcement (can only call the router)
 * - Value enforcement (can only send up to deploy fee + initial buy)
 * - Unique salt per delegation (prevents hash collisions)
 */
export function createNadFunCreateDelegation(
  context: NadFunCreateDelegationContext
): DelegationResult {
  const {
    router,
    delegator,
    sessionKey,
    nonce,
    chainId,
    calldata,
    value,
  } = context;

  // Expiry: 5 minutes from now
  const expiresAt = Math.floor(Date.now() / 1000) + DEFAULT_DELEGATION_EXPIRY_SECONDS;

  // Extract selector from calldata
  const selector = calldata.slice(0, 10) as Hex;

  // Build scope - create is payable with deploy fee + optional initial buy
  const scope = {
    type: "functionCall" as const,
    targets: [getAddress(router)],
    selectors: [selector],
    valueLte: { maxValue: value }, // Deploy fee + initial buy
  };

  // Build caveats (timestamp, nonce, limitedCalls: 1)
  const caveats = buildEphemeralCaveats(nonce, expiresAt);

  // Get DTK environment
  const environment = getDTKEnvironment();

  // Generate unique salt to prevent hash collisions
  const uniqueSalt = keccak256(
    concat([
      numberToHex(Date.now(), { size: 32 }),
      numberToHex(Math.floor(Math.random() * 1e18), { size: 32 }),
      toHex(nonce),
    ])
  );

  // Create delegation using DTK
  const delegation = createDelegation({
    environment,
    scope,
    from: delegator as Hex,
    to: sessionKey as Hex,
    caveats,
    salt: uniqueSalt,
  });

  // Build EIP-712 typed data for signing
  const typedData = buildDelegationTypedData(
    delegation,
    chainId,
    DELEGATION_FRAMEWORK.delegationManager
  );

  return {
    delegation,
    typedData,
    expiresAt,
  };
}

/**
 * Create a LeverUp open trade delegation using DTK's createDelegation with scope
 */
export function createLeverUpOpenDelegation(
  context: LeverUpOpenDelegationContext
): DelegationResult {
  const {
    diamond,
    delegator,
    sessionKey,
    nonce,
    chainId,
    calldata,
    value,
  } = context;

  const expiresAt = Math.floor(Date.now() / 1000) + DEFAULT_DELEGATION_EXPIRY_SECONDS;
  const selector = calldata.slice(0, 10) as Hex;

  const scope = {
    type: "functionCall" as const,
    targets: [getAddress(diamond)],
    selectors: [selector],
    valueLte: { maxValue: value },
  };

  const caveats = buildEphemeralCaveats(nonce, expiresAt);
  const environment = getDTKEnvironment();

  const uniqueSalt = keccak256(
    concat([
      numberToHex(Date.now(), { size: 32 }),
      numberToHex(Math.floor(Math.random() * 1e18), { size: 32 }),
      toHex(nonce),
    ])
  );

  const delegation = createDelegation({
    environment,
    scope,
    from: delegator as Hex,
    to: sessionKey as Hex,
    caveats,
    salt: uniqueSalt,
  });

  const typedData = buildDelegationTypedData(
    delegation,
    chainId,
    DELEGATION_FRAMEWORK.delegationManager
  );

  return {
    delegation,
    typedData,
    expiresAt,
  };
}

/**
 * Create a LeverUp close trade delegation
 */
export function createLeverUpCloseDelegation(
  context: LeverUpCloseDelegationContext
): DelegationResult {
  const {
    diamond,
    delegator,
    sessionKey,
    nonce,
    chainId,
    calldata,
  } = context;

  const expiresAt = Math.floor(Date.now() / 1000) + DEFAULT_DELEGATION_EXPIRY_SECONDS;
  const selector = calldata.slice(0, 10) as Hex;

  const scope = {
    type: "functionCall" as const,
    targets: [getAddress(diamond)],
    selectors: [selector],
  };

  const caveats = buildEphemeralCaveats(nonce, expiresAt);
  const environment = getDTKEnvironment();

  const uniqueSalt = keccak256(
    concat([
      numberToHex(Date.now(), { size: 32 }),
      numberToHex(Math.floor(Math.random() * 1e18), { size: 32 }),
      toHex(nonce),
    ])
  );

  const delegation = createDelegation({
    environment,
    scope,
    from: delegator as Hex,
    to: sessionKey as Hex,
    caveats,
    salt: uniqueSalt,
  });

  const typedData = buildDelegationTypedData(
    delegation,
    chainId,
    DELEGATION_FRAMEWORK.delegationManager
  );

  return {
    delegation,
    typedData,
    expiresAt,
  };
}

/**
 * Create a LeverUp update margin delegation
 */
export function createLeverUpUpdateMarginDelegation(
  context: LeverUpUpdateMarginDelegationContext
): DelegationResult {
  const {
    diamond,
    delegator,
    sessionKey,
    nonce,
    chainId,
    calldata,
    value,
  } = context;

  const expiresAt = Math.floor(Date.now() / 1000) + DEFAULT_DELEGATION_EXPIRY_SECONDS;
  const selector = calldata.slice(0, 10) as Hex;

  const scope = {
    type: "functionCall" as const,
    targets: [getAddress(diamond)],
    selectors: [selector],
    valueLte: { maxValue: value },
  };

  const caveats = buildEphemeralCaveats(nonce, expiresAt);
  const environment = getDTKEnvironment();

  const uniqueSalt = keccak256(
    concat([
      numberToHex(Date.now(), { size: 32 }),
      numberToHex(Math.floor(Math.random() * 1e18), { size: 32 }),
      toHex(nonce),
    ])
  );

  const delegation = createDelegation({
    environment,
    scope,
    from: delegator as Hex,
    to: sessionKey as Hex,
    caveats,
    salt: uniqueSalt,
  });

  const typedData = buildDelegationTypedData(
    delegation,
    chainId,
    DELEGATION_FRAMEWORK.delegationManager
  );

  return {
    delegation,
    typedData,
    expiresAt,
  };
}

// ============================================================================
// Legacy Exports (for compatibility)
// ============================================================================

/**
 * Build swap caveats (legacy interface)
 * @deprecated Use createSwapDelegation instead
 */
export function buildSwapCaveats(
  _calldata: Hex,
  expiryTimestamp: bigint
): Caveat[] {
  const expiresAt = Number(expiryTimestamp);
  return [
    {
      enforcer: DELEGATION_FRAMEWORK.enforcers.timestamp,
      terms: "0x" as Hex, // Simplified
      args: "0x" as Hex,
    },
    {
      enforcer: DELEGATION_FRAMEWORK.enforcers.limitedCalls,
      terms: "0x" as Hex,
      args: "0x" as Hex,
    },
  ];
}

/**
 * Build transfer caveats (legacy interface)
 * @deprecated Will be replaced with createTransferDelegation
 */
export function buildTransferCaveats(
  _calldata: Hex,
  expiryTimestamp: bigint
): Caveat[] {
  return buildSwapCaveats(_calldata, expiryTimestamp);
}

/**
 * Build stake caveats (legacy interface)
 * @deprecated Will be replaced with createStakeDelegation
 */
export function buildStakeCaveats(
  _calldata: Hex,
  expiryTimestamp: bigint
): Caveat[] {
  return buildSwapCaveats(_calldata, expiryTimestamp);
}

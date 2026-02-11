// Create Sub-Agent Tool
// Creates a new sub-agent with wallet, delegation, and state
// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  formatEther,
  parseEther,
  http,
  createPublicClient,
  createWalletClient,
  decodeAbiParameters,
  fromHex,
  type Address,
  type Hex,
} from "viem";
import { randomUUID } from "node:crypto";
import { loadConfig, getRpcUrl } from "../config/pragma-config.js";
import { buildViemChain, SUPPORTED_CHAINS } from "../config/chains.js";
import { getSessionKey, getSessionAccount } from "../core/session/keys.js";
import { x402HttpOptions } from "../core/x402/client.js";
import {
  assignWallet,
  releaseWallet,
  getFullWallet,
  createAgentState,
  storeDelegation,
  createContinuousLoop,
  createConditionLoop,
  createIntervalLoop,
  sumActiveMonAllocations,
  sumActiveUsdAllocations,
  KNOWN_TOKEN_SYMBOLS,
  type StoredDelegation,
} from "../core/subagent/index.js";
import { findTokenBySymbol } from "../config/tokens.js";
import { withRetry } from "../core/utils/retry.js";
import {
  createSubDelegation,
  validateSubDelegationParams,
  getSelectorsForAgentType,
} from "../core/delegation/subagent.js";
import { loadRootDelegation, type StoredRootDelegation } from "../core/delegation/root.js";
import { hashDelegation } from "@metamask/delegation-core";
import { formatTimeRemaining } from "../core/utils/index.js";
import { startCaffeinate } from "../core/utils/caffeinate.js";
import { loadHeadlessDelegation } from "../core/execution/headless.js";
import { DELEGATION_FRAMEWORK, VALUE_LTE_ENFORCER } from "../config/constants.js";

// Contract addresses for agent scopes
import { LEVERUP_DIAMOND, WMON_ADDRESS, USDC_ADDRESS, LVUSD_ADDRESS, LVMON_ADDRESS } from "../core/leverup/constants.js";
import { NADFUN_CONTRACTS } from "../core/nadfun/constants.js";

// ============================================================================
// OpenClaw delegation fallback
// ============================================================================

/**
 * Attempt to load root delegation from OpenClaw's web-based delegation path.
 * Falls back to ~/.pragma/delegations/root/delegation.json when
 * ~/.pragma/root-delegation.json (Touch ID flow) doesn't exist.
 *
 * Decodes caveat terms to reconstruct StoredRootDelegation fields.
 */
function loadRootDelegationFromHeadless(): StoredRootDelegation | null {
  const signed = loadHeadlessDelegation();
  if (!signed) return null;

  try {
    // Compute delegation hash
    const delegationForHash = {
      ...signed,
      salt: typeof signed.salt === "bigint" ? signed.salt : BigInt(signed.salt as string),
    };
    const delegationHash = hashDelegation(delegationForHash);

    // Decode caveat terms
    const expiresAt = decodeTimestampExpiry(signed.caveats as Array<{ enforcer: string; terms: string }>);
    const valueLtePerTx = decodeValueLte(signed.caveats as Array<{ enforcer: string; terms: string }>);
    const maxCalls = decodeLimitedCalls(signed.caveats as Array<{ enforcer: string; terms: string }>);

    return {
      delegationHash,
      delegation: signed,
      allowedTargets: [], // Sub-delegation builds its own scope per agent type
      sessionKey: signed.delegate as Address,
      delegator: signed.delegator as Address,
      chainId: 143,
      createdAt: Date.now(),
      expiresAt: expiresAt * 1000, // Convert seconds to ms
      valueLtePerTx: valueLtePerTx.toString(),
      maxCalls,
      approximateBudget: (valueLtePerTx * BigInt(maxCalls)).toString(),
      budgetMon: formatEther(valueLtePerTx * BigInt(maxCalls)),
      budgetUsd: "0",
      maxValuePerTx: formatEther(valueLtePerTx),
    };
  } catch {
    return null;
  }
}

/** Decode TimestampEnforcer caveat → expiry timestamp (seconds) */
function decodeTimestampExpiry(caveats: Array<{ enforcer: string; terms: string }>): number {
  const caveat = caveats.find(
    (c) => c.enforcer.toLowerCase() === DELEGATION_FRAMEWORK.enforcers.timestamp.toLowerCase()
  );
  if (!caveat?.terms || caveat.terms === "0x") return 0;

  // Packed format: 16 bytes afterThreshold + 16 bytes beforeThreshold = 32 bytes
  const termsHex = caveat.terms as Hex;
  // beforeThreshold is bytes 16-31 (the expiry)
  const beforeThreshold = fromHex(`0x${termsHex.slice(34)}` as Hex, "bigint");
  return Number(beforeThreshold);
}

/** Decode ValueLteEnforcer caveat → max value per tx (wei as bigint) */
function decodeValueLte(caveats: Array<{ enforcer: string; terms: string }>): bigint {
  const caveat = caveats.find(
    (c) => c.enforcer.toLowerCase() === VALUE_LTE_ENFORCER.toLowerCase()
  );
  if (!caveat?.terms || caveat.terms === "0x") return 0n;

  // ABI-encoded uint256
  const [value] = decodeAbiParameters([{ type: "uint256" }], caveat.terms as Hex);
  return value;
}

/** Decode LimitedCallsEnforcer caveat → max call count */
function decodeLimitedCalls(caveats: Array<{ enforcer: string; terms: string }>): number {
  const caveat = caveats.find(
    (c) => c.enforcer.toLowerCase() === DELEGATION_FRAMEWORK.enforcers.limitedCalls.toLowerCase()
  );
  if (!caveat?.terms || caveat.terms === "0x") return 0;

  // ABI-encoded uint256
  const [value] = decodeAbiParameters([{ type: "uint256" }], caveat.terms as Hex);
  return Number(value);
}

const CreateSubAgentSchema = z.object({
  agentType: z
    .enum(["kairos", "thymos", "pragma"])
    .describe(
      "Type of sub-agent to create. " +
        "kairos: Strategic/macro trader for perps (patient, calculated). " +
        "thymos: Momentum trader for memecoins (fast, conviction-based). " +
        "pragma: General-purpose agent for any task."
    ),
  budgetMon: z
    .number()
    .min(0)
    .max(100)
    .describe(
      "MON trading capital for this sub-agent. Must fit within root budgetMon. " +
        "kairos/pragma require >= 1 (LeverUp's 1 wei Pyth fee needs ValueLteEnforcer > 0). " +
        "For ERC20 strategies, 1 MON is a safety floor, not actual spend. thymos can use 0."
    ),
  budgetUsd: z
    .number()
    .min(0)
    .optional()
    .describe("USD group budget covering USDC + LVUSD (soft limit, agent self-tracks). Default: 0"),
  allowedGroups: z
    .array(z.enum(["MON", "USD"]))
    .optional()
    .describe(
      "Token groups this agent is allowed to spend. " +
        "MON group: native MON, WMON, LVMON. USD group: USDC, LVUSD. " +
        "Tokens acquired during trading are always sellable. " +
        "Omit for unrestricted access."
    ),
  allowedTokens: z
    .array(z.string())
    .optional()
    .describe(
      "Specific tokens this agent is allowed to spend (by symbol). " +
        "More specific than allowedGroups — when set, takes priority. " +
        "Examples: ['LVUSD'], ['USDC', 'LVUSD'], ['WMON']. " +
        "Tokens acquired during trading are always sellable. " +
        "Omit for no per-token restriction."
    ),
  expiryDays: z
    .number()
    .min(1)
    .max(30)
    .default(7)
    .describe("How many days until delegation expires. Default: 7"),
  maxCalls: z
    .number()
    .min(1)
    .max(100)
    .default(20)
    .describe(
      "Maximum delegation calls (trades + approvals). " +
        "Each trade may need 1-2 calls (approve + execute). Default: 20"
    ),
  fundAmount: z
    .number()
    .min(0)
    .max(10)
    .default(1)
    .describe(
      "Initial gas funding in MON. Set to 0 to skip funding. Default: 1 MON. Max: 10 MON"
    ),
  taskId: z
    .string()
    .optional()
    .describe("Optional Claude Code Task ID for tracking"),
  loopType: z
    .enum(["none", "condition", "continuous", "interval"])
    .default("none")
    .describe(
      "Loop behavior. none=one-shot (agent runs once and stops), " +
        "condition=until condition met (e.g., 'BTC >= 95000'), " +
        "continuous=until budget/expiry exhausted, " +
        "interval=periodic checks at fixed intervals"
    ),
  loopCondition: z
    .string()
    .optional()
    .describe(
      "For condition type: human-readable condition (e.g., 'BTC price >= 95000')"
    ),
  loopIntervalMinutes: z
    .number()
    .min(1)
    .max(1440)
    .optional()
    .describe(
      "For interval type: minutes between checks (e.g., 2 for every 2 minutes)"
    ),
  mission: z
    .string()
    .optional()
    .describe(
      "Natural language task re-injected as the agent's next prompt when the SubagentStop hook blocks exit. " +
        "Must be actionable and self-contained. " +
        "Example: 'Monitor BTC/USD. Buy when price hits $95,000. Budget: 10 MON.'"
    ),
  maxIterations: z
    .number()
    .min(0)
    .max(10000)
    .default(0)
    .describe(
      "Safety valve: max loop iterations before forcing exit. 0 = unlimited. Default: 0"
    ),
});

interface CreateSubAgentResult {
  success: boolean;
  message: string;
  subAgent?: {
    id: string;
    walletAddress: string;
    walletBalance: string;
    agentType: string;
    budget: {
      mon: string;
      usd: string;
      perTransaction: string;
      allowedGroups: string[] | string;
      allowedTokens: string[] | string;
    };
    maxCalls: number;
    expiresAt: string;
    expiresIn: string;
    funding: {
      requested: string;
      existingBalance: string;
      transferred: string;
      decision: "skipped" | "partial" | "full" | "none";
    };
    fundingTx?: string;
    loop?: {
      type: string;
      active: boolean;
      mission?: string;
      condition?: string;
      intervalMinutes?: number;
      maxIterations?: number;
    };
    keychainNote?: string;
  };
  error?: string;
}

/**
 * Build allowed targets based on agent type
 */
function buildAllowedTargets(
  agentType: "kairos" | "thymos" | "pragma",
  dexAggregator: Address | undefined,
  nadfunRouter: Address | undefined
): Address[] {
  switch (agentType) {
    case "kairos": {
      // kairos: perps + swaps + wrap/unwrap + ERC20 tokens for autonomous approvals
      const targets: Address[] = [LEVERUP_DIAMOND, WMON_ADDRESS];
      if (dexAggregator) targets.push(dexAggregator);
      targets.push(USDC_ADDRESS, LVUSD_ADDRESS, LVMON_ADDRESS);
      return targets;
    }

    case "thymos": {
      // thymos: memecoins (nadfun + WMON + dex) + ERC20 tokens for autonomous approvals
      const targets: Address[] = [];
      if (nadfunRouter) targets.push(nadfunRouter);
      targets.push(WMON_ADDRESS);
      if (dexAggregator) targets.push(dexAggregator);
      // Add ERC20 tokens for autonomous approvals
      targets.push(USDC_ADDRESS, LVUSD_ADDRESS, LVMON_ADDRESS);
      return targets;
    }

    case "pragma": {
      // pragma: all trading contracts + ERC20 tokens for autonomous approvals
      const targets: Address[] = [LEVERUP_DIAMOND, WMON_ADDRESS];
      if (dexAggregator) targets.push(dexAggregator);
      if (nadfunRouter) targets.push(nadfunRouter);
      // Add ERC20 tokens for autonomous approvals
      targets.push(USDC_ADDRESS, LVUSD_ADDRESS, LVMON_ADDRESS);
      return targets;
    }
  }
}

export function registerCreateSubAgent(server: McpServer): void {
  server.tool(
    "create_sub_agent",
    "Create a new autonomous sub-agent with its own wallet and delegation. " +
      "Sub-agents can execute trades within their budget constraints without requiring Touch ID. " +
      "The delegation is signed by the session key and inherits from the user's root delegation. " +
      "Use this for autonomous trading or monitoring tasks.",
    CreateSubAgentSchema.shape,
    async (
      params
    ): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await createSubAgentHandler(
        params as z.infer<typeof CreateSubAgentSchema>
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}

async function createSubAgentHandler(
  params: z.infer<typeof CreateSubAgentSchema>
): Promise<CreateSubAgentResult> {
  try {
    const config = await loadConfig();
    if (!config?.wallet) {
      return {
        success: false,
        message: "Wallet not configured",
        error: "Please run setup_wallet first",
      };
    }

    // Load session key
    const sessionKey = await getSessionKey();
    if (!sessionKey) {
      return {
        success: false,
        message: "Session key not found",
        error: "Please run setup_wallet to create a session key",
      };
    }

    const chainId = config.network.chainId;

    // Load and validate root delegation
    // Try macOS path first, then OpenClaw headless path as fallback
    const rootDelegation = loadRootDelegation() ?? loadRootDelegationFromHeadless();
    if (!rootDelegation) {
      return {
        success: false,
        message: "No root delegation found",
        error: "No delegation found. Use the delegation flow (request → approve → retrieve) to create one.",
      };
    }

    // Check root delegation expiry
    if (Date.now() > rootDelegation.expiresAt) {
      return {
        success: false,
        message: "Root delegation has expired",
        error: "Delegation has expired. Please create a new one via the delegation flow.",
      };
    }

    // Verify session key matches
    if (rootDelegation.sessionKey.toLowerCase() !== sessionKey.address.toLowerCase()) {
      return {
        success: false,
        message: "Session key mismatch",
        error: "Delegation was created with a different session key. Please create a new delegation.",
      };
    }

    // Generate agent ID and task ID first
    const agentId = randomUUID();
    const taskId = params.taskId || `subagent-${agentId}`;

    // Get or create wallet from pool and assign to task
    const poolWallet = await assignWallet(taskId);

    // Pre-flight: trigger macOS Keychain prompt while user is present.
    // Without this, the first autonomous trade would stall waiting for approval.
    const keychainAccessible = await getFullWallet(poolWallet.id);
    if (!keychainAccessible) {
      await releaseWallet(poolWallet.id);
      return {
        success: false,
        message: "Wallet key not found in Keychain",
        error:
          `Wallet ${poolWallet.id} exists in pool but private key missing from Keychain. ` +
          `This can happen if Keychain was reset or pragma-signer was rebuilt. ` +
          `Try running setup_wallet to repair, or delete ~/.pragma/wallet-pool.json and retry.`,
      };
    }

    // Wrap all operations in try-catch to release wallet on failure
    try {
      // Calculate valueLtePerTx for on-chain ValueLteEnforcer
      // Per-tx native MON cap = budgetMon / maxCalls
      // 0 budgetMon → 0 valueLtePerTx → blocks all native MON on-chain
      const totalBudgetWei = parseEther(params.budgetMon.toString());
      const valueLtePerTx = params.maxCalls > 0 ? totalBudgetWei / BigInt(params.maxCalls) : 0n;

      // Validate against root delegation budget (user's consent boundary)
      if (rootDelegation.budgetMon !== undefined) {
        const rootBudgetMon = parseFloat(rootDelegation.budgetMon);
        const existingMonWei = await sumActiveMonAllocations();
        const existingMon = parseFloat(formatEther(existingMonWei));
        if (existingMon + params.budgetMon > rootBudgetMon) {
          await releaseWallet(poolWallet.id);
          return {
            success: false,
            message: "Exceeds root MON budget",
            error: `Root authorized ${rootBudgetMon} MON. Already allocated: ${existingMon} MON. Requested: ${params.budgetMon} MON. Total ${existingMon + params.budgetMon} exceeds ${rootBudgetMon}.`,
          };
        }
      }

      if (rootDelegation.budgetUsd !== undefined && params.budgetUsd && params.budgetUsd > 0) {
        const rootBudgetUsd = parseFloat(rootDelegation.budgetUsd);
        if (rootBudgetUsd > 0) {
          const existingUsdRaw = await sumActiveUsdAllocations();
          const existingUsd = parseFloat(existingUsdRaw.toString()) / 1e6; // USD uses 6-decimal canonical
          if (existingUsd + params.budgetUsd > rootBudgetUsd) {
            await releaseWallet(poolWallet.id);
            return {
              success: false,
              message: "Exceeds root USD budget",
              error: `Root authorized ${rootBudgetUsd} USD. Already allocated: ${existingUsd} USD. Requested: ${params.budgetUsd} USD.`,
            };
          }
        }
      }

      // LeverUp-capable agents require budgetMon >= 1:
      // Pyth fee (1 wei) is blocked when ValueLteEnforcer = 0 (i.e. budgetMon: 0)
      const isLeverUpCapable = params.agentType === "kairos" || params.agentType === "pragma";
      if (isLeverUpCapable && params.budgetMon < 1) {
        await releaseWallet(poolWallet.id);
        return {
          success: false,
          message: "Insufficient MON budget for LeverUp agent",
          error: `${params.agentType} agents require budgetMon >= 1. LeverUp's Pyth oracle fee (1 wei) is sent as execution.value — budgetMon: 0 sets ValueLteEnforcer to 0, blocking it. For ERC20 strategies this is a safety floor, not actual spend. Use budgetMon >= 1 or thymos agent type.`,
        };
      }

      // Validate sub-agent per-tx value doesn't exceed root's maxValuePerTx
      if (rootDelegation.maxValuePerTx !== undefined) {
        const rootMaxPerTx = parseEther(rootDelegation.maxValuePerTx);
        if (valueLtePerTx > rootMaxPerTx) {
          await releaseWallet(poolWallet.id);
          return {
            success: false,
            message: "Sub-agent per-tx value exceeds root limit",
            error: `Sub-agent valueLtePerTx (${formatEther(valueLtePerTx)} MON) exceeds root maxValuePerTx (${rootDelegation.maxValuePerTx} MON).`,
          };
        }
      }

      // Build allowed targets based on agent type
      const chainConfig = SUPPORTED_CHAINS[chainId];
      const dexAggregator = chainConfig?.aggregators?.router;
      const nadfunRouter = chainId === 143 ? NADFUN_CONTRACTS[143].router : undefined;
      const allowedTargets = buildAllowedTargets(params.agentType, dexAggregator, nadfunRouter);

      // Get selectors for this agent type
      const allowedSelectors = getSelectorsForAgentType(params.agentType);

      // Validate delegation params
      const validationResult = validateSubDelegationParams({
        subAgentAddress: poolWallet.address as Address,
        mainAgentAddress: sessionKey.address,
        allowedTargets,
        allowedSelectors,
        expiryDays: params.expiryDays,
        valueLtePerTx,
        maxCalls: params.maxCalls,
        chainId,
      });

      if (!validationResult.valid) {
        // Release wallet before returning error
        await releaseWallet(poolWallet.id);
        return {
          success: false,
          message: "Invalid delegation parameters",
          error: validationResult.errors.join(", "),
        };
      }

      // Create sub-delegation with parent delegation for proper authority chain
      const delegationResult = createSubDelegation({
        subAgentAddress: poolWallet.address as Address,
        mainAgentAddress: sessionKey.address,
        parentDelegation: rootDelegation.delegation, // Required for redelegation chain
        allowedTargets,
        allowedSelectors,
        expiryDays: params.expiryDays,
        valueLtePerTx,
        maxCalls: params.maxCalls,
        chainId,
      });

      // Sign delegation with session key
      const sessionAccount = getSessionAccount(sessionKey);
      const signature = await sessionAccount.signTypedData({
        domain: delegationResult.typedData.domain,
        types: delegationResult.typedData.types,
        primaryType: "Delegation",
        message: delegationResult.typedData.message,
      });

      // Create agent state with optional USD group limit
      const tokenLimits: Record<string, bigint> | undefined =
        params.budgetUsd && params.budgetUsd > 0
          ? { [USDC_ADDRESS.toLowerCase()]: BigInt(Math.floor(params.budgetUsd * 1e6)) }
          : undefined;

      // Set group budgets for ledger-based budget enforcement
      const groupBudgets: Record<string, bigint> | undefined =
        params.budgetUsd && params.budgetUsd > 0
          ? { USD: BigInt(Math.floor(params.budgetUsd * 1e6)) }
          : undefined;

      // Resolve allowedTokens symbols to addresses
      let resolvedAllowedTokens: Address[] | undefined;
      if (params.allowedTokens && params.allowedTokens.length > 0) {
        const resolved: Address[] = [];
        const unknown: string[] = [];

        for (const symbol of params.allowedTokens) {
          const upper = symbol.toUpperCase();
          // 1. Core trading tokens (includes LVUSD, LVMON not in verified-tokens)
          const fromKnown = KNOWN_TOKEN_SYMBOLS[upper];
          if (fromKnown) {
            resolved.push(fromKnown);
            continue;
          }
          // 2. Verified tokens registry (WETH, WBTC, CHOG, etc.)
          const fromRegistry = findTokenBySymbol(symbol);
          if (fromRegistry) {
            resolved.push(fromRegistry.address);
            continue;
          }
          unknown.push(symbol);
        }

        if (unknown.length > 0) {
          const knownSymbols = Object.keys(KNOWN_TOKEN_SYMBOLS).join(", ");
          await releaseWallet(poolWallet.id);
          return {
            success: false,
            message: `Unknown token symbols in allowedTokens: [${unknown.join(", ")}]. Core tokens: ${knownSymbols}`,
          };
        }

        resolvedAllowedTokens = resolved;
      }

      await createAgentState({
        id: agentId,
        walletId: poolWallet.id,
        walletAddress: poolWallet.address as Address,
        agentType: params.agentType,
        taskId,
        budget: {
          monAllocated: totalBudgetWei,
          tokenLimits,
          groupBudgets,
          allowedGroups: params.allowedGroups,
          allowedTokens: resolvedAllowedTokens,
        },
        maxCalls: params.maxCalls,
        expiresAt: delegationResult.expiresAt * 1000, // Convert to milliseconds
      });

      // Create signed delegation object for storage
      const signedDelegation = {
        ...delegationResult.delegation,
        signature,
      };

      // Compute delegation hash using DTK's hash function (struct hash, not EIP-712).
      // DTK expects salt as bigint; our delegation stores it as a hex string.
      const delegationForHash = {
        ...delegationResult.delegation,
        salt: BigInt(delegationResult.delegation.salt),
      };
      const delegationHash = hashDelegation(delegationForHash);

      // Store delegation with root delegation reference for chain assembly
      const storedDelegation: StoredDelegation = {
        delegationHash,
        signedDelegation,
        parentDelegationHash: rootDelegation.delegationHash, // Reference to root delegation
        rootDelegation: rootDelegation.delegation, // Full root delegation for chain assembly at execution
        createdAt: Date.now(),
        expiresAt: delegationResult.expiresAt * 1000,
      };
      await storeDelegation(agentId, storedDelegation);

      // Create loop config if requested
      if (params.loopType && params.loopType !== "none") {
        const mission =
          params.mission ||
          `Continue your ${params.agentType} agent task. ` +
            (params.loopCondition
              ? `Condition: ${params.loopCondition}. `
              : "") +
            `Check get_sub_agent_state for current state.`;

        switch (params.loopType) {
          case "continuous":
            createContinuousLoop(agentId, mission, params.maxIterations ?? 0);
            break;
          case "condition":
            createConditionLoop(
              agentId,
              params.loopCondition || "condition not specified",
              mission,
              params.maxIterations ?? 0
            );
            break;
          case "interval":
            createIntervalLoop(
              agentId,
              params.loopIntervalMinutes || 5,
              mission,
              params.maxIterations ?? 0
            );
            break;
        }
      }

      // Prevent macOS idle sleep while agents are running
      startCaffeinate();

      // Check wallet balance and fund if needed
      const rpcUrl = await getRpcUrl(config);
      const chain = buildViemChain(chainId, rpcUrl);

      const publicClient = createPublicClient({
        chain,
        transport: http(rpcUrl, x402HttpOptions(config)),
      });

      // Check sub-agent wallet's existing balance
      const existingBalanceResult = await withRetry(
        async () => publicClient.getBalance({ address: poolWallet.address as Address }),
        { operationName: "check-wallet-balance" }
      );
      const existingBalance = existingBalanceResult.success ? (existingBalanceResult.data ?? 0n) : 0n;

      let fundingTxHash: string | undefined;
      let amountTransferred = 0n;
      let fundingDecision: "skipped" | "partial" | "full" | "none" = "none";

      if (params.fundAmount > 0) {
        const fundAmountWei = parseEther(params.fundAmount.toString());

        if (existingBalance >= fundAmountWei) {
          // Wallet already has enough - skip funding
          fundingDecision = "skipped";
        } else {
          // Need to fund - calculate how much
          const amountNeeded = fundAmountWei - existingBalance;

          const walletClient = createWalletClient({
            account: sessionAccount,
            chain,
            transport: http(rpcUrl, x402HttpOptions(config)),
          });

          // Check session key balance
          const sessionKeyBalanceResult = await withRetry(
            async () => publicClient.getBalance({ address: sessionKey.address }),
            { operationName: "check-session-key-balance" }
          );
          const sessionKeyBalance = sessionKeyBalanceResult.success ? (sessionKeyBalanceResult.data ?? 0n) : 0n;

          if (sessionKeyBalance >= amountNeeded) {
            fundingTxHash = await walletClient.sendTransaction({
              to: poolWallet.address as Address,
              value: amountNeeded,
            });

            await publicClient.waitForTransactionReceipt({ hash: fundingTxHash as `0x${string}` });
            amountTransferred = amountNeeded;
            fundingDecision = existingBalance > 0n ? "partial" : "full";
          }
        }
      }

      // Calculate final wallet balance
      const finalBalance = existingBalance + amountTransferred;

      // Calculate human-readable expiry
      const expiresAtMs = delegationResult.expiresAt * 1000;
      const expiresAt = new Date(expiresAtMs);
      const expiresIn = formatTimeRemaining(expiresAtMs);

      return {
        success: true,
        message: `Created ${params.agentType} sub-agent with ${params.budgetMon} MON budget`,
        subAgent: {
          id: agentId,
          walletAddress: poolWallet.address,
          walletBalance: formatEther(finalBalance) + " MON",
          agentType: params.agentType,
          budget: {
            mon: params.budgetMon + " MON",
            usd: (params.budgetUsd || 0) + " USD",
            perTransaction: formatEther(valueLtePerTx) + " MON/tx",
            allowedGroups: params.allowedGroups || "unrestricted",
            allowedTokens: params.allowedTokens || "none (using allowedGroups)",
          },
          maxCalls: params.maxCalls,
          expiresAt: expiresAt.toISOString(),
          expiresIn,
          funding: {
            requested: params.fundAmount + " MON",
            existingBalance: formatEther(existingBalance) + " MON",
            transferred: formatEther(amountTransferred) + " MON",
            decision: fundingDecision,
          },
          fundingTx: fundingTxHash,
          loop: params.loopType !== "none"
            ? {
                type: params.loopType,
                active: true,
                mission: params.mission,
                condition: params.loopCondition,
                intervalMinutes: params.loopIntervalMinutes,
                maxIterations: params.maxIterations ?? 0,
              }
            : undefined,
          keychainNote:
            "If macOS prompted for Keychain access, select 'Always Allow' to prevent interruptions during autonomous trading.",
        },
      };
    } catch (innerError) {
      // Release wallet back to pool on any failure
      try {
        await releaseWallet(poolWallet.id);
      } catch {
        // Ignore release errors
      }
      throw innerError; // Re-throw to be caught by outer catch
    }
  } catch (error) {
    return {
      success: false,
      message: "Failed to create sub-agent",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

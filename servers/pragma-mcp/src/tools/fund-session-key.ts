// Fund Session Key Tool
// Funds session key with MON (for gas) or USDC (for x402 payments) from smart account
// Supports UserOp (when session key has < 0.02 MON) and Delegation methods
// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  erc20Abi,
  encodeFunctionData,
  type Address,
  type PublicClient,
  type WalletClient,
} from "viem";
import { x402HttpOptions } from "../core/x402/client.js";
import {
  redeemDelegations,
  createExecution,
  ExecutionMode,
} from "@metamask/smart-accounts-kit";
import { loadConfig, isWalletConfigured, getBundlerUrl, getRpcUrl } from "../config/pragma-config.js";
import { buildViemChain } from "../config/chains.js";
import { createHybridDelegatorHandle } from "../core/account/hybridDelegator.js";
import { fundSessionKeyViaUserOp } from "../core/execution/sessionKeyFunding.js";
import {
  checkSessionKeyBalanceForOperation,
  estimateGasForOperations,
  calculateFundingAmount,
  type OperationType,
  SESSION_KEY_FUNDING_AMOUNT,
  MIN_GAS_FOR_DELEGATION,
} from "../core/session/manager.js";
import {
  getUsdcBalance,
  formatUsdcBalance,
  parseUsdcAmount,
  isUsdcConfigured,
  getUsdcAddress,
  MIN_USDC_BALANCE,
  RECOMMENDED_USDC_FUNDING,
} from "../core/x402/usdc.js";
import { createERC20TransferDelegation } from "../core/delegation/hybrid.js";
import { getCurrentNonce } from "../core/delegation/nonce.js";
import { getSessionKey, getSessionAccount } from "../core/session/keys.js";
import { signDelegationWithP256 } from "../core/signer/p256SignerConfig.js";
import { DELEGATION_FRAMEWORK } from "../config/constants.js";
import type { SignedDelegation } from "../core/delegation/types.js";

const FundSessionKeySchema = z.object({
  operationType: z
    .enum(["swap", "transfer", "wrap", "unwrap", "stake", "unstake"])
    .optional()
    .describe(
      "Type of operation to fund for. IMPORTANT: Always specify this for accurate gas calculation! " +
        "Each operation has different gas costs: swap=0.14 MON, transfer/wrap/unwrap=0.04 MON, stake=0.07 MON"
    ),
  estimatedOperations: z
    .number()
    .optional()
    .describe(
      "Number of operations planned. Combined with operationType for accurate calculation. " +
        "Examples: 1 swap = 0.16 MON needed, 3 swaps = 0.44 MON needed"
    ),
  token: z
    .enum(["MON", "USDC"])
    .optional()
    .describe(
      "Token to fund session key with. MON for gas (default), USDC for x402 payments. " +
        "USDC funding requires specifying amount."
    ),
  amount: z
    .string()
    .optional()
    .describe(
      "Amount to fund for USDC only (e.g., '1' for 1 USDC). Default: 1 USDC. " +
        "Ignored for MON funding (calculated from operationType)."
    ),
});

interface FundSessionKeyResult {
  success: boolean;
  message: string;
  funding?: {
    token: "MON" | "USDC";
    method: "userOp" | "delegation";
    fundedAmount: string;
    fundedAmountWei: string;
    newBalance: string;
    newBalanceWei: string;
    txHash: string;
  };
  error?: string;
}

export function registerFundSessionKey(server: McpServer): void {
  server.tool(
    "fund_session_key",
    "Fund session key with MON (for gas) or USDC (for x402 payments) from smart account. Pass operationType for MON, or token='USDC' with amount for x402. Requires Touch ID confirmation.",
    FundSessionKeySchema.shape,
    async (params): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await fundSessionKeyHandler(
        params as z.infer<typeof FundSessionKeySchema>
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );
}

async function fundSessionKeyHandler(
  params: z.infer<typeof FundSessionKeySchema>
): Promise<FundSessionKeyResult> {
  try {
    // Step 1: Load config and verify wallet
    const config = await loadConfig();
    if (!config || !isWalletConfigured(config)) {
      return {
        success: false,
        message: "Wallet not configured",
        error: "Please run setup_wallet first to create your pragma wallet",
      };
    }

    const sessionKeyAddress = config.wallet?.sessionKeyAddress as Address;
    const smartAccountAddress = config.wallet?.smartAccountAddress as Address;

    if (!sessionKeyAddress || !smartAccountAddress) {
      return {
        success: false,
        message: "Session key or smart account not found",
        error: "Wallet addresses are not configured",
      };
    }

    // Step 2: Get RPC URL (mode-aware: skips Keychain in x402 mode)
    const rpcUrl = await getRpcUrl(config);
    const chain = buildViemChain(config.network.chainId, rpcUrl);
    const chainId = config.network.chainId;

    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl, x402HttpOptions()),
    });

    // Step 3: Route to MON or USDC funding
    const token = params.token || "MON";

    if (token === "USDC") {
      return fundSessionKeyUsdc(
        params,
        config,
        sessionKeyAddress,
        smartAccountAddress,
        publicClient as PublicClient,
        chainId,
        rpcUrl,
        chain
      );
    }

    // MON funding path (original logic)
    return fundSessionKeyMon(
      params,
      config,
      sessionKeyAddress,
      smartAccountAddress,
      publicClient as PublicClient
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    // Handle specific error types
    if (errorMessage.includes("Touch ID") || errorMessage.includes("authentication")) {
      return {
        success: false,
        message: "Authentication required",
        error: "Touch ID authentication was cancelled or failed. Please try again.",
      };
    }

    return {
      success: false,
      message: "Failed to fund session key",
      error: errorMessage,
    };
  }
}

// MARK: - MON Funding

async function fundSessionKeyMon(
  params: z.infer<typeof FundSessionKeySchema>,
  config: NonNullable<Awaited<ReturnType<typeof loadConfig>>>,
  sessionKeyAddress: Address,
  smartAccountAddress: Address,
  publicClient: PublicClient
): Promise<FundSessionKeyResult> {
  let bundlerUrl: string;
  try {
    bundlerUrl = await getBundlerUrl(config);
  } catch (error) {
    return {
      success: false,
      message: "Bundler URL not configured",
      error:
        error instanceof Error
          ? error.message
          : "Bundler is required for session key funding. " +
            "Please run /pragma:providers to configure your bundler provider.",
    };
  }

  // Check current balance
  const balanceCheck = await checkSessionKeyBalanceForOperation(
    sessionKeyAddress,
    publicClient,
    params.operationType as OperationType | undefined,
    params.estimatedOperations
  );

  // Check if funding is actually needed
  if (!balanceCheck.needsFunding) {
    return {
      success: true,
      message: "Session key already has sufficient MON balance",
      funding: {
        token: "MON",
        method: balanceCheck.fundingMethod,
        fundedAmount: "0 MON",
        fundedAmountWei: "0",
        newBalance: `${balanceCheck.balanceFormatted} MON`,
        newBalanceWei: balanceCheck.balance.toString(),
        txHash: "0x",
      },
    };
  }

  // Check smart account balance
  const smartAccountBalance = await publicClient.getBalance({
    address: smartAccountAddress,
  });

  // Calculate funding amount
  let fundingAmount: bigint;

  if (params.operationType && params.estimatedOperations && params.estimatedOperations > 0) {
    const operations: OperationType[] = Array(params.estimatedOperations).fill(params.operationType);
    const requiredBalance = estimateGasForOperations(operations);
    fundingAmount = calculateFundingAmount(balanceCheck.balance, requiredBalance);
  } else if (params.estimatedOperations && params.estimatedOperations > 0) {
    fundingAmount = SESSION_KEY_FUNDING_AMOUNT;
  } else {
    fundingAmount = SESSION_KEY_FUNDING_AMOUNT;
  }

  if (smartAccountBalance < fundingAmount) {
    return {
      success: false,
      message: "Insufficient smart account MON balance",
      error:
        `Smart account has ${formatEther(smartAccountBalance)} MON but needs ` +
        `${formatEther(fundingAmount)} MON for session key funding. ` +
        `Please add more MON to your smart account.`,
    };
  }

  // Determine funding method and execute
  const fundingMethod = balanceCheck.balance < MIN_GAS_FOR_DELEGATION ? "userOp" : "delegation";

  // Create descriptive Touch ID message
  const fundingAmountFormatted = formatEther(fundingAmount);
  const touchIdMessage = `Fund session key: ${fundingAmountFormatted} MON (${fundingMethod})`;

  // Create handle for P-256 signing with custom Touch ID message
  const handle = await createHybridDelegatorHandle(config, { touchIdMessage });

  // Fund session key via UserOp (triggers Touch ID)
  const result = await fundSessionKeyViaUserOp({
    handle,
    sessionKeyAddress,
    publicClient,
    bundlerUrl,
    fundingAmount,
  });

  return {
    success: true,
    message: `Session key funded with ${formatEther(result.fundedAmount)} MON via ${fundingMethod}`,
    funding: {
      token: "MON",
      method: fundingMethod,
      fundedAmount: `${formatEther(result.fundedAmount)} MON`,
      fundedAmountWei: result.fundedAmount.toString(),
      newBalance: `${formatEther(result.newBalance)} MON`,
      newBalanceWei: result.newBalance.toString(),
      txHash: result.transactionHash || result.userOpHash,
    },
  };
}

// MARK: - USDC Funding

async function fundSessionKeyUsdc(
  params: z.infer<typeof FundSessionKeySchema>,
  config: NonNullable<Awaited<ReturnType<typeof loadConfig>>>,
  sessionKeyAddress: Address,
  smartAccountAddress: Address,
  publicClient: PublicClient,
  chainId: number,
  rpcUrl: string,
  chain: ReturnType<typeof buildViemChain>
): Promise<FundSessionKeyResult> {
  // Verify USDC is configured for this chain
  if (!isUsdcConfigured(chainId)) {
    return {
      success: false,
      message: "USDC not configured",
      error: `USDC is not configured for chain ${chainId}`,
    };
  }

  const usdcAddress = getUsdcAddress(chainId)!;

  // Check current USDC balance
  const currentUsdcBalance = await getUsdcBalance(sessionKeyAddress, publicClient, chainId);

  // Check if funding is needed
  if (currentUsdcBalance >= MIN_USDC_BALANCE && !params.amount) {
    return {
      success: true,
      message: "Session key already has sufficient USDC balance",
      funding: {
        token: "USDC",
        method: "delegation",
        fundedAmount: "0 USDC",
        fundedAmountWei: "0",
        newBalance: formatUsdcBalance(currentUsdcBalance),
        newBalanceWei: currentUsdcBalance.toString(),
        txHash: "0x",
      },
    };
  }

  // Parse funding amount (default to 1 USDC)
  const fundingAmount = params.amount
    ? parseUsdcAmount(params.amount)
    : RECOMMENDED_USDC_FUNDING;

  // Check smart account USDC balance
  const smartAccountUsdcBalance = await publicClient.readContract({
    address: usdcAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [smartAccountAddress],
  });

  if (smartAccountUsdcBalance < fundingAmount) {
    return {
      success: false,
      message: "Insufficient smart account USDC balance",
      error:
        `Smart account has ${formatUsdcBalance(smartAccountUsdcBalance)} but needs ` +
        `${formatUsdcBalance(fundingAmount)} for session key funding. ` +
        `Please add more USDC to your smart account.`,
    };
  }

  // Check session key MON balance to determine funding method
  const sessionKeyMonBalance = await publicClient.getBalance({ address: sessionKeyAddress });
  const fundingMethod: "userOp" | "delegation" =
    sessionKeyMonBalance < MIN_GAS_FOR_DELEGATION ? "userOp" : "delegation";

  // Get Touch ID message
  const fundingAmountFormatted = formatUsdcBalance(fundingAmount);
  const touchIdMessage = `Fund session key: ${fundingAmountFormatted} (${fundingMethod})`;

  let txHash: string;
  let newBalance: bigint;

  if (fundingMethod === "delegation") {
    // USDC funding via delegation (session key pays gas)
    txHash = await fundUsdcViaDelegation(
      sessionKeyAddress,
      smartAccountAddress,
      usdcAddress,
      fundingAmount,
      publicClient,
      chainId,
      rpcUrl,
      chain,
      config.wallet!.keyId!,
      touchIdMessage
    );
  } else {
    // USDC funding via UserOp (bundler pays gas)
    let bundlerUrl: string;
    try {
      bundlerUrl = await getBundlerUrl(config);
    } catch (error) {
      return {
        success: false,
        message: "Bundler URL not configured",
        error:
          error instanceof Error
            ? error.message
            : "Bundler is required for UserOp-based USDC funding. " +
              "Please run /pragma:providers to configure your bundler provider, or fund session key with MON first.",
      };
    }

    txHash = await fundUsdcViaUserOp(
      sessionKeyAddress,
      smartAccountAddress,
      usdcAddress,
      fundingAmount,
      publicClient,
      bundlerUrl,
      config,
      touchIdMessage
    );
  }

  // Wait for balance to update
  await new Promise((resolve) => setTimeout(resolve, 2000));
  newBalance = await getUsdcBalance(sessionKeyAddress, publicClient, chainId);

  return {
    success: true,
    message: `Session key funded with ${fundingAmountFormatted} via ${fundingMethod}`,
    funding: {
      token: "USDC",
      method: fundingMethod,
      fundedAmount: fundingAmountFormatted,
      fundedAmountWei: fundingAmount.toString(),
      newBalance: formatUsdcBalance(newBalance),
      newBalanceWei: newBalance.toString(),
      txHash,
    },
  };
}

// MARK: - USDC Funding via Delegation

async function fundUsdcViaDelegation(
  sessionKeyAddress: Address,
  smartAccountAddress: Address,
  usdcAddress: Address,
  amount: bigint,
  publicClient: PublicClient,
  chainId: number,
  rpcUrl: string,
  chain: ReturnType<typeof buildViemChain>,
  keyId: string,
  touchIdMessage: string
): Promise<string> {
  // Get session key for execution
  const sessionKey = await getSessionKey();
  if (!sessionKey) {
    throw new Error("Session key not found");
  }

  // Get current nonce
  const nonce = await getCurrentNonce(publicClient, smartAccountAddress);

  // Create ERC20 transfer delegation (SA → session key)
  const delegationResult = createERC20TransferDelegation({
    tokenAddress: usdcAddress,
    recipient: sessionKeyAddress,
    amount,
    delegator: smartAccountAddress,
    sessionKey: sessionKeyAddress,
    nonce,
    chainId,
  });

  // Sign delegation with passkey (Touch ID)
  const signature = await signDelegationWithP256(
    delegationResult.delegation,
    chainId,
    keyId,
    touchIdMessage
  );

  delegationResult.delegation.signature = signature;

  // Build transfer calldata
  const transferCalldata = encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [sessionKeyAddress, amount],
  });

  // Create execution
  const execution = createExecution({
    target: usdcAddress,
    value: 0n,
    callData: transferCalldata,
  });

  // Create session wallet client
  const sessionAccount = getSessionAccount(sessionKey);
  const sessionWallet = createWalletClient({
    account: sessionAccount,
    chain,
    transport: http(rpcUrl, x402HttpOptions()),
  });

  // Execute via delegation
  const txHash = await redeemDelegations(
    sessionWallet as WalletClient,
    publicClient,
    DELEGATION_FRAMEWORK.delegationManager,
    [
      {
        permissionContext: [delegationResult.delegation as SignedDelegation],
        executions: [execution],
        mode: ExecutionMode.SingleDefault,
      },
    ]
  );

  // Wait for confirmation
  await publicClient.waitForTransactionReceipt({
    hash: txHash,
    timeout: 60_000,
  });

  return txHash;
}

// MARK: - USDC Funding via UserOp

async function fundUsdcViaUserOp(
  sessionKeyAddress: Address,
  smartAccountAddress: Address,
  usdcAddress: Address,
  amount: bigint,
  publicClient: PublicClient,
  bundlerUrl: string,
  config: NonNullable<Awaited<ReturnType<typeof loadConfig>>>,
  touchIdMessage: string
): Promise<string> {
  // Build ERC20 transfer calldata
  const transferCalldata = encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [sessionKeyAddress, amount],
  });

  // Create handle for P-256 signing with custom Touch ID message
  const handle = await createHybridDelegatorHandle(config, { touchIdMessage });

  // Use fundSessionKeyViaUserOp with customExecution for USDC transfer
  const result = await fundSessionKeyViaUserOp({
    handle,
    sessionKeyAddress,
    publicClient,
    bundlerUrl,
    fundingAmount: 0n, // Not used when customExecution is provided
    customExecution: {
      target: usdcAddress,
      value: 0n, // No MON value, just ERC20 transfer
      callData: transferCalldata,
    },
  });

  return result.transactionHash || result.userOpHash;
}

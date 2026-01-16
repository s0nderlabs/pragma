// Withdraw Session Key Balance Tool
// Transfers MON or ERC20 tokens from session key to smart account or any address
// Session key owns the tokens directly - no delegation needed
// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  type Address,
  type PublicClient,
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  formatUnits,
  parseEther,
  parseUnits,
  getAddress,
  erc20Abi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig, isWalletConfigured, getRpcUrl } from "../config/pragma-config.js";
import { getChainConfig, buildViemChain } from "../config/chains.js";
import { x402HttpOptions } from "../core/x402/client.js";
import { getSessionKey } from "../core/session/keys.js";
import { resolveToken } from "../core/data/client.js";
import { withRetryOrThrow } from "../core/utils/retry.js";
import { NATIVE_TOKEN_ADDRESS } from "../config/constants.js";

// Gas estimation for session key withdrawal
// Monad uses ~40k gas for simple transfers (not 21k like Ethereum)
// ERC20 transfers use ~65k gas
const NATIVE_ESTIMATED_GAS = 50000n;
const ERC20_ESTIMATED_GAS = 80000n;
const GAS_MARGIN_MULTIPLIER = 2n; // 100% safety margin

const WithdrawSessionKeySchema = z.object({
  token: z
    .string()
    .optional()
    .describe(
      "Token to withdraw. Defaults to 'MON' for native token. " +
      "Use token symbol (e.g., 'USDC', 'WMON') or contract address."
    ),
  amount: z
    .string()
    .describe(
      "Amount to withdraw. Use 'all' for maximum possible amount, " +
      "or specify a decimal amount like '0.5'. For MON, some is reserved for gas."
    ),
  recipient: z
    .string()
    .optional()
    .describe(
      "Recipient address for the withdrawal. If not specified, withdraws to user's smart account. " +
      "Use when user wants to send to an external address."
    ),
});

interface WithdrawSessionKeyResult {
  success: boolean;
  message: string;
  withdrawal?: {
    token: string;
    amount: string;
    recipient: string;
    txHash: string;
    explorerUrl: string;
  };
  sessionKey?: {
    address: string;
    previousBalance: string;
    newBalance: string;
  };
  error?: string;
}

export function registerWithdrawSessionKey(server: McpServer): void {
  server.tool(
    "withdraw_session_key",
    "Withdraw MON or ERC20 tokens from session key to smart account or external address. Use 'all' for maximum amount. Defaults to MON if no token specified. Session key funds are used for gas - withdraw to reclaim unused funds.",
    WithdrawSessionKeySchema.shape,
    async (params): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await withdrawSessionKeyHandler(
        params as z.infer<typeof WithdrawSessionKeySchema>
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

/**
 * Withdraw session key balance handler
 */
async function withdrawSessionKeyHandler(
  params: z.infer<typeof WithdrawSessionKeySchema>
): Promise<WithdrawSessionKeyResult> {
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

    const chainId = config.network.chainId;
    const chainConfig = getChainConfig(chainId);

    // Step 2: Get session key from Keychain
    const sessionKey = await getSessionKey();
    if (!sessionKey) {
      return {
        success: false,
        message: "Session key not found",
        error: "No session key found in Keychain. Run setup_wallet to create one.",
      };
    }

    // Step 3: Get RPC URL
    const rpcUrl = await getRpcUrl(config);
    if (!rpcUrl) {
      return {
        success: false,
        message: "RPC not configured",
        error: "Please configure RPC provider",
      };
    }

    // Step 4: Create public client
    const chain = buildViemChain(chainId, rpcUrl);
    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl, x402HttpOptions(config)),
    }) as PublicClient;

    // Step 5: Resolve token (default to native MON)
    const tokenInput = params.token || "MON";
    const tokenInfo = await resolveToken(tokenInput, chainId);
    if (!tokenInfo) {
      return {
        success: false,
        message: "Token not found",
        error: `Could not find token '${tokenInput}'. Check the symbol or address.`,
      };
    }

    const isNative = tokenInfo.address.toLowerCase() === NATIVE_TOKEN_ADDRESS.toLowerCase();

    // Step 6: Get current balance
    let currentBalance: bigint;
    if (isNative) {
      currentBalance = await publicClient.getBalance({
        address: sessionKey.address,
      });
    } else {
      currentBalance = await publicClient.readContract({
        address: tokenInfo.address as Address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [sessionKey.address],
      });
    }

    const formattedCurrentBalance = isNative
      ? formatEther(currentBalance)
      : formatUnits(currentBalance, tokenInfo.decimals);

    if (currentBalance === 0n) {
      return {
        success: false,
        message: "No balance to withdraw",
        sessionKey: {
          address: sessionKey.address,
          previousBalance: `0 ${tokenInfo.symbol}`,
          newBalance: `0 ${tokenInfo.symbol}`,
        },
        error: `Session key has no ${tokenInfo.symbol} balance. Nothing to withdraw.`,
      };
    }

    // Step 7: Determine recipient (default to smart account)
    const recipientAddress = params.recipient
      ? getAddress(params.recipient)
      : getAddress(config.wallet!.smartAccountAddress);

    // Step 8: Get gas price for estimation
    const gasPrice = await withRetryOrThrow(
      async () => publicClient.getGasPrice(),
      { operationName: "getGasPrice" }
    );
    const estimatedGas = isNative ? NATIVE_ESTIMATED_GAS : ERC20_ESTIMATED_GAS;
    const gasCost = gasPrice * estimatedGas * GAS_MARGIN_MULTIPLIER;

    // Step 9: Check MON balance for gas (always needed)
    const monBalance = isNative
      ? currentBalance
      : await publicClient.getBalance({ address: sessionKey.address });

    if (monBalance < gasCost) {
      return {
        success: false,
        message: "Insufficient MON for gas",
        sessionKey: {
          address: sessionKey.address,
          previousBalance: `${formattedCurrentBalance} ${tokenInfo.symbol}`,
          newBalance: `${formattedCurrentBalance} ${tokenInfo.symbol}`,
        },
        error: `Session key has ${formatEther(monBalance)} MON but needs ${formatEther(gasCost)} MON for gas.`,
      };
    }

    // Step 10: Calculate withdrawal amount
    let withdrawalAmount: bigint;

    if (params.amount.toLowerCase() === "all") {
      if (isNative) {
        // For native MON, reserve gas cost
        if (currentBalance <= gasCost) {
          return {
            success: false,
            message: "Insufficient balance for gas",
            sessionKey: {
              address: sessionKey.address,
              previousBalance: `${formattedCurrentBalance} ${tokenInfo.symbol}`,
              newBalance: `${formattedCurrentBalance} ${tokenInfo.symbol}`,
            },
            error: `Balance (${formattedCurrentBalance} MON) is less than gas cost (${formatEther(gasCost)} MON). Nothing to withdraw.`,
          };
        }
        withdrawalAmount = currentBalance - gasCost;
      } else {
        // For ERC20, withdraw entire balance
        withdrawalAmount = currentBalance;
      }
    } else {
      // Parse specific amount
      withdrawalAmount = isNative
        ? parseEther(params.amount)
        : parseUnits(params.amount, tokenInfo.decimals);

      if (withdrawalAmount <= 0n) {
        return {
          success: false,
          message: "Invalid amount",
          error: "Withdrawal amount must be greater than 0",
        };
      }

      if (withdrawalAmount > currentBalance) {
        return {
          success: false,
          message: "Insufficient balance",
          sessionKey: {
            address: sessionKey.address,
            previousBalance: `${formattedCurrentBalance} ${tokenInfo.symbol}`,
            newBalance: `${formattedCurrentBalance} ${tokenInfo.symbol}`,
          },
          error: `Requested ${params.amount} ${tokenInfo.symbol} but only have ${formattedCurrentBalance} ${tokenInfo.symbol}`,
        };
      }

      // For native MON, check if enough left for gas
      if (isNative && currentBalance - withdrawalAmount < gasCost) {
        return {
          success: false,
          message: "Insufficient balance for gas after withdrawal",
          sessionKey: {
            address: sessionKey.address,
            previousBalance: `${formattedCurrentBalance} ${tokenInfo.symbol}`,
            newBalance: `${formattedCurrentBalance} ${tokenInfo.symbol}`,
          },
          error: `Not enough MON left for gas (${formatEther(gasCost)} MON needed). Try withdrawing less or use 'all'.`,
        };
      }
    }

    // Step 11: Create wallet client with session key
    const sessionAccount = privateKeyToAccount(sessionKey.privateKey);
    const walletClient = createWalletClient({
      account: sessionAccount,
      chain,
      transport: http(rpcUrl, x402HttpOptions(config)),
    });

    // Step 12: Send withdrawal transaction
    let txHash: `0x${string}`;

    if (isNative) {
      // Native MON transfer
      txHash = await walletClient.sendTransaction({
        to: recipientAddress,
        value: withdrawalAmount,
      });
    } else {
      // ERC20 transfer
      txHash = await walletClient.writeContract({
        address: tokenInfo.address as Address,
        abi: erc20Abi,
        functionName: "transfer",
        args: [recipientAddress, withdrawalAmount],
      });
    }

    // Step 13: Wait for confirmation
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
    });

    if (receipt.status !== "success") {
      return {
        success: false,
        message: "Transaction failed",
        error: `Withdrawal transaction failed. Hash: ${txHash}`,
      };
    }

    // Step 14: Get new balance
    let newBalance: bigint;
    if (isNative) {
      newBalance = await publicClient.getBalance({
        address: sessionKey.address,
      });
    } else {
      newBalance = await publicClient.readContract({
        address: tokenInfo.address as Address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [sessionKey.address],
      });
    }

    const formattedNewBalance = isNative
      ? formatEther(newBalance)
      : formatUnits(newBalance, tokenInfo.decimals);

    const formattedWithdrawal = isNative
      ? formatEther(withdrawalAmount)
      : formatUnits(withdrawalAmount, tokenInfo.decimals);

    const explorerUrl = `${chainConfig.blockExplorer}/tx/${txHash}`;
    const isToSmartAccount = recipientAddress.toLowerCase() === config.wallet!.smartAccountAddress.toLowerCase();

    return {
      success: true,
      message: isToSmartAccount
        ? `Withdrew ${formattedWithdrawal} ${tokenInfo.symbol} to your smart account`
        : `Withdrew ${formattedWithdrawal} ${tokenInfo.symbol} to ${recipientAddress}`,
      withdrawal: {
        token: tokenInfo.symbol,
        amount: `${formattedWithdrawal} ${tokenInfo.symbol}`,
        recipient: recipientAddress,
        txHash,
        explorerUrl,
      },
      sessionKey: {
        address: sessionKey.address,
        previousBalance: `${formattedCurrentBalance} ${tokenInfo.symbol}`,
        newBalance: `${formattedNewBalance} ${tokenInfo.symbol}`,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return {
      success: false,
      message: "Withdrawal failed",
      error: errorMessage,
    };
  }
}

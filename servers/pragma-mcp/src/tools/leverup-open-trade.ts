import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadConfig, isWalletConfigured, getRpcUrl } from "../config/pragma-config.js";
import {
  getLeverUpQuote,
  isDegenModeLeverage,
  getMaxTpPercent,
  getCollateralDecimals
} from "../core/leverup/client.js";
import { executeOpenTrade, type CollateralToken } from "../core/leverup/execution.js";
import { executeAutonomousLeverUpOpen } from "../core/execution/autonomous.js";
import { SUPPORTED_PAIRS, DEGEN_MODE_LEVERAGE_OPTIONS } from "../core/leverup/constants.js";
import { getSessionKey, getSessionAccount } from "../core/session/keys.js";
import { buildViemChain } from "../config/chains.js";
import { createSyncHttpTransport } from "../core/x402/client.js";
import { waitForReceiptSync } from "../core/rpc/index.js";
import { DELEGATION_FRAMEWORK } from "../config/constants.js";
import { getCurrentNonce } from "../core/delegation/nonce.js";
import { createLeverUpOpenDelegation, createApproveDelegation } from "../core/delegation/hybrid.js";
import { signDelegationWithP256 } from "../core/signer/p256SignerConfig.js";
import type { SignedDelegation, DelegationBundle } from "../core/delegation/types.js";
import {
  createPublicClient,
  createWalletClient,
  parseUnits,
  formatUnits,
  encodeFunctionData,
  erc20Abi,
  type Address,
  type Hex,
} from "viem";
import { LVUSD_ADDRESS, USDC_ADDRESS, LVMON_ADDRESS } from "../core/leverup/constants.js";
import {
  redeemDelegations,
  createExecution,
  ExecutionMode
} from "@metamask/smart-accounts-kit";

const LeverUpOpenTradeSchema = z.object({
  symbol: z.string().describe(
    "Asset to trade (e.g. BTC, ETH, MON). NOTE: 500BTC and 500ETH are Zero-Fee pairs that ONLY support 500x, 750x, or 1001x leverage."
  ),
  isLong: z.boolean().describe("true for Long, false for Short"),
  marginAmount: z
    .string()
    .describe(
      "Amount of collateral (e.g. '10' for 10 MON). Recommended minimum: $10 USD."
    ),
  leverage: z
    .number()
    .min(1)
    .max(1001)
    .describe(
      "Leverage multiplier. Normal pairs: 1-100x. Zero-Fee pairs (500BTC/500ETH): ONLY 500, 750, or 1001. " +
      "HARD LIMIT: Position size (margin × leverage) must be at least $200 USD."
    ),
  collateralToken: z.enum(["MON", "USDC", "LVUSD", "LVMON"]).default("MON").optional().describe(
    "Collateral token: MON (native), USDC, LVUSD (vault USD), or LVMON (vault MON). Default: MON."
  ),
  slippageBps: z.number().min(0).max(5000).default(100).optional().describe("Slippage in basis points (default: 100 = 1%)"),
  stopLoss: z.string().optional().describe(
    "Stop Loss price in USD (e.g. '85000' for $85,000). Set to automatically close position at this price to limit losses. " +
    "Cannot be cancelled once set, but can be edited."
  ),
  takeProfit: z.string().optional().describe(
    "Take Profit price in USD (e.g. '100000' for $100,000). Set to automatically close position at this price to secure profits. " +
    "Max TP: 500% for leverage <50x, 300% for leverage ≥50x. Cannot be cancelled once set, but can be edited."
  ),
  agentId: z
    .string()
    .optional()
    .describe(
      "Sub-agent ID for autonomous execution (no Touch ID). " +
      "If omitted, uses assistant mode with Touch ID confirmation. " +
      "Note: For ERC20 collateral, approval must be set via assistant mode first."
    ),
});

export function registerLeverUpOpenTrade(server: McpServer): void {
  server.tool(
    "leverup_open_trade",
    "Open a market perpetual position on LeverUp. " +
    "If agentId provided: uses autonomous mode (no Touch ID). " +
    "If no agentId: uses assistant mode (requires Touch ID).",
    LeverUpOpenTradeSchema.shape,
    async (params): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      try {
        const config = await loadConfig();
        if (!config || !isWalletConfigured(config)) {
          throw new Error("Wallet not configured.");
        }

        // DUAL-MODE: Check if autonomous execution requested
        if (params.agentId) {
          // Autonomous path: use pre-signed delegation chain, no Touch ID
          const result = await executeAutonomousLeverUpOpen(params.agentId, {
            symbol: params.symbol,
            isLong: params.isLong,
            marginAmount: params.marginAmount,
            leverage: params.leverage,
            collateralToken: (params.collateralToken as CollateralToken) || "MON",
            slippageBps: params.slippageBps,
            stopLoss: params.stopLoss,
            takeProfit: params.takeProfit,
          });
          return {
            content: [{
              type: "text",
              text: JSON.stringify(result, null, 2)
            }]
          };
        }

        // Assistant path: existing implementation with Touch ID
        const userAddress = config.wallet!.smartAccountAddress as Address;
        const sessionKeyAddress = config.wallet!.sessionKeyAddress as Address;
        const chainId = config.network.chainId;
        const rpcUrl = await getRpcUrl(config);

        const quote = await getLeverUpQuote(
          params.symbol,
          params.isLong,
          params.marginAmount,
          params.leverage,
          params.collateralToken || "MON"
        );

        // Validate leverage for high-leverage (Zero-Fee) pairs
        const pairMetadata = SUPPORTED_PAIRS.find(
          p => p.pair === `${params.symbol}/USD` || p.pair === params.symbol
        );
        if (pairMetadata?.isHighLeverage && !isDegenModeLeverage(params.leverage)) {
          throw new Error(
            `${pairMetadata.pair} is a Zero-Fee pair that ONLY supports ${DEGEN_MODE_LEVERAGE_OPTIONS.join(', ')}x leverage. ` +
            `Requested: ${params.leverage}x. Use a standard pair (BTC, ETH) for lower leverage.`
          );
        }

        const entryPrice = parseFloat(quote.entryPrice);

        // Validate TP limits
        if (params.takeProfit) {
          const tpPrice = parseFloat(params.takeProfit);
          const maxTpPercent = getMaxTpPercent(params.leverage);
          const tpPercent = params.isLong
            ? ((tpPrice - entryPrice) / entryPrice) * 100
            : ((entryPrice - tpPrice) / entryPrice) * 100;

          if (tpPercent <= 0) {
            const direction = params.isLong ? 'above' : 'below';
            throw new Error(
              `Invalid Take Profit price. For a ${params.isLong ? 'Long' : 'Short'} position, TP must be ${direction} entry price ($${entryPrice}).`
            );
          }

          if (tpPercent > maxTpPercent) {
            throw new Error(
              `Take Profit exceeds maximum allowed. For ${params.leverage}x leverage, max TP is ${maxTpPercent}% profit. ` +
              `Requested TP would be ~${tpPercent.toFixed(1)}% profit.`
            );
          }
        }

        // Validate SL direction
        if (params.stopLoss) {
          const slPrice = parseFloat(params.stopLoss);
          const isInvalidSl = params.isLong ? slPrice >= entryPrice : slPrice <= entryPrice;
          if (isInvalidSl) {
            const direction = params.isLong ? 'below' : 'above';
            throw new Error(
              `Invalid Stop Loss for ${params.isLong ? 'Long' : 'Short'} position. SL price ($${slPrice}) must be ${direction} entry price ($${entryPrice}).`
            );
          }
        }

        const slippage = BigInt(params.slippageBps ?? 100);
        const entryPriceWei = parseUnits(quote.entryPrice, 18);
        const slippagePrice = params.isLong
          ? (entryPriceWei * (10000n + slippage)) / 10000n
          : (entryPriceWei * (10000n - slippage)) / 10000n;

        const collateral = params.collateralToken ?? "MON";
        const marginWei = parseUnits(params.marginAmount, getCollateralDecimals(collateral));
        const qtyWei = parseUnits(quote.positionSize, 10);

        const execution = await executeOpenTrade({
          symbol: params.symbol,
          isLong: params.isLong,
          amountIn: marginWei,
          leverage: params.leverage,
          qty: qtyWei,
          price: slippagePrice,
          collateralToken: (params.collateralToken as any) || "MON",
          stopLoss: params.stopLoss ? parseUnits(params.stopLoss, 18) : 0n,
          takeProfit: params.takeProfit ? parseUnits(params.takeProfit, 18) : 0n,
        }, config);

        const chain = buildViemChain(chainId, rpcUrl);
        const publicClient = createPublicClient({
          chain,
          transport: createSyncHttpTransport(rpcUrl, config),
        });

        // Validate balance for collateral (includes fee)
        const decimals = getCollateralDecimals(collateral);

        if (collateral === "MON") {
          // For native MON collateral: execution.value includes both Pyth fee + collateral
          // No wrapping or approval needed - just check native balance
          const nativeBalance = await publicClient.getBalance({ address: userAddress });

          if (nativeBalance < execution.value) {
            const required = formatUnits(execution.amountIn, decimals);
            const tradingFee = formatUnits(execution.amountIn - marginWei, decimals);
            const totalRequired = formatUnits(execution.value, decimals);
            throw new Error(
              `Insufficient native MON balance. Required: ${totalRequired} MON (${params.marginAmount} margin + ${tradingFee} trading fee + Pyth fee). ` +
              `Available: ${formatUnits(nativeBalance, decimals)} MON.`
            );
          }
        } else {
          // For ERC20 collateral: check token balance
          const tokenAddress = collateral === "USDC" ? USDC_ADDRESS
            : collateral === "LVUSD" ? LVUSD_ADDRESS
            : LVMON_ADDRESS;

          const userBalance = await publicClient.readContract({
            address: tokenAddress,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [userAddress],
          });

          if (userBalance < execution.amountIn) {
            const required = formatUnits(execution.amountIn, decimals);
            const available = formatUnits(userBalance, decimals);
            const fee = formatUnits(execution.amountIn - marginWei, decimals);
            throw new Error(
              `Insufficient ${collateral} balance. Required: ${required} ${collateral} (${params.marginAmount} margin + ${fee} fee), Available: ${available} ${collateral}.`
            );
          }
        }

        const nonce = await getCurrentNonce(publicClient, userAddress);

        // Build delegation bundles
        const delegations: DelegationBundle[] = [];

        // For native MON collateral: no wrap or approval needed
        // For ERC20 collateral: approve if needed
        if (collateral !== "MON") {
          // Non-MON collateral: just need approval if insufficient
          const tokenAddress = execution.tokenIn;

          // Check current allowance
          const currentAllowance = await publicClient.readContract({
            address: tokenAddress,
            abi: erc20Abi,
            functionName: "allowance",
            args: [userAddress, execution.to],
          });

          // If allowance insufficient, add approve delegations
          if (currentAllowance < execution.amountIn) {
            // If there's existing non-zero allowance, reset to 0 first (some tokens require this)
            if (currentAllowance > 0n) {
              const resetApproval = createApproveDelegation({
                tokenAddress: tokenAddress,
                spender: execution.to,
                amount: 0n,
                delegator: userAddress,
                sessionKey: sessionKeyAddress,
                nonce,
                chainId,
              });

              delegations.push({
                delegation: resetApproval.delegation as SignedDelegation,
                execution: {
                  target: tokenAddress,
                  value: 0n,
                  callData: encodeFunctionData({
                    abi: erc20Abi,
                    functionName: "approve",
                    args: [execution.to, 0n],
                  }),
                },
                kind: "approve",
              });
            }

            // Approve the exact amount needed
            const newApproval = createApproveDelegation({
              tokenAddress: tokenAddress,
              spender: execution.to,
              amount: execution.amountIn,
              delegator: userAddress,
              sessionKey: sessionKeyAddress,
              nonce,
              chainId,
            });

            delegations.push({
              delegation: newApproval.delegation as SignedDelegation,
              execution: {
                target: tokenAddress,
                value: 0n,
                callData: encodeFunctionData({
                  abi: erc20Abi,
                  functionName: "approve",
                  args: [execution.to, execution.amountIn],
                }),
              },
              kind: "approve",
            });
          }
        }

        // Add the open trade delegation
        const openDelegation = createLeverUpOpenDelegation({
          diamond: execution.to,
          delegator: userAddress,
          sessionKey: sessionKeyAddress,
          nonce,
          chainId,
          calldata: execution.data as Hex,
          value: execution.value,
        });

        delegations.push({
          delegation: openDelegation.delegation as SignedDelegation,
          execution: {
            target: execution.to,
            value: execution.value,
            callData: execution.data as Hex,
          },
          kind: "leverup_open",
        });

        // Burst sign all delegations
        for (const bundle of delegations) {
          let actionLabel: string;
          if (bundle.kind === "approve") {
            actionLabel = `Approve ${collateral} for LeverUp`;
          } else {
            actionLabel = `LeverUp: ${params.leverage}x ${params.isLong ? 'Long' : 'Short'} ${params.symbol}`;
          }

          const signature = await signDelegationWithP256(
            bundle.delegation,
            chainId,
            config.wallet!.keyId,
            actionLabel
          );
          bundle.delegation.signature = signature;
        }

        const sessionKey = await getSessionKey();
        const sessionAccount = getSessionAccount(sessionKey!);
        const sessionWallet = createWalletClient({
          account: sessionAccount,
          chain,
          transport: createSyncHttpTransport(rpcUrl, config),
        });

        // Execute delegations sequentially: approve (if needed) -> trade
        // For native MON, there are no approve delegations

        // Step 1: Execute approve delegations separately (if any)
        const approveBundles = delegations.filter(d => d.kind === "approve");
        if (approveBundles.length > 0) {
          const approveRedemptions = approveBundles.map((bundle) => ({
            permissionContext: [bundle.delegation],
            executions: [
              createExecution({
                target: bundle.execution.target,
                value: bundle.execution.value,
                callData: bundle.execution.callData,
              }),
            ],
            mode: ExecutionMode.SingleDefault,
          }));

          const approveTxHash = await redeemDelegations(
            sessionWallet,
            publicClient,
            DELEGATION_FRAMEWORK.delegationManager,
            approveRedemptions
          );

          const approveReceipt = await waitForReceiptSync(publicClient, approveTxHash);
          if (approveReceipt.status !== "success") {
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  success: false,
                  message: "Failed to approve token. Transaction reverted.",
                }, null, 2)
              }]
            };
          }
        }

        // Step 2: Execute the trade delegation
        const tradeBundle = delegations.find(d => d.kind === "leverup_open");
        if (!tradeBundle) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: false,
                message: "Internal error: trade delegation not found.",
              }, null, 2)
            }]
          };
        }

        const tradeRedemption = [{
          permissionContext: [tradeBundle.delegation],
          executions: [
            createExecution({
              target: tradeBundle.execution.target,
              value: tradeBundle.execution.value,
              callData: tradeBundle.execution.callData,
            }),
          ],
          mode: ExecutionMode.SingleDefault,
        }];

        const txHash = await redeemDelegations(
          sessionWallet,
          publicClient,
          DELEGATION_FRAMEWORK.delegationManager,
          tradeRedemption
        );

        const receipt = await waitForReceiptSync(publicClient, txHash);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: receipt.status === "success",
              message: receipt.status === "success"
                ? `Successfully opened ${params.leverage}x ${params.isLong ? 'Long' : 'Short'} on ${params.symbol}`
                : "Transaction reverted on-chain",
              txHash,
              explorerUrl: `https://monadvision.com/tx/${txHash}`
            }, null, 2)
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              message: error instanceof Error ? error.message : "Unknown error"
            }, null, 2)
          }]
        };
      }
    }
  );
}

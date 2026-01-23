import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadConfig, isWalletConfigured, getRpcUrl } from "../config/pragma-config.js";
import {
  getLimitOrderQuote,
  isDegenModeLeverage,
  getMaxTpPercent,
  getCollateralDecimals
} from "../core/leverup/client.js";
import { executeOpenLimitOrder } from "../core/leverup/execution.js";
import { SUPPORTED_PAIRS, DEGEN_MODE_LEVERAGE_OPTIONS } from "../core/leverup/constants.js";
import { getSessionKey, getSessionAccount } from "../core/session/keys.js";
import { buildViemChain } from "../config/chains.js";
import { createSyncHttpTransport } from "../core/x402/client.js";
import { waitForReceiptSync } from "../core/rpc/index.js";
import { DELEGATION_FRAMEWORK } from "../config/constants.js";
import { getCurrentNonce } from "../core/delegation/nonce.js";
import { createLeverUpLimitOrderDelegation, createApproveDelegation } from "../core/delegation/hybrid.js";
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

const LeverUpOpenLimitOrderSchema = z.object({
  symbol: z.string().describe(
    "Asset to trade (e.g. BTC, ETH, MON). NOTE: 500BTC and 500ETH are Zero-Fee pairs that ONLY support 500x, 750x, or 1001x leverage."
  ),
  isLong: z.boolean().describe(
    "true for Long (order triggers when price drops below trigger price), " +
    "false for Short (order triggers when price rises above trigger price)"
  ),
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
  triggerPrice: z.string().describe(
    "Price at which the order will trigger and fill. " +
    "For LONG orders: must be BELOW current market price (buy the dip). " +
    "For SHORT orders: must be ABOVE current market price (sell the top)."
  ),
  collateralToken: z.enum(["MON", "USDC", "LVUSD", "LVMON"]).default("MON").optional().describe(
    "Collateral token: MON (native), USDC, LVUSD (vault USD), or LVMON (vault MON). Default: MON."
  ),
  stopLoss: z.string().optional().describe(
    "Stop Loss price in USD. Set to automatically close position at this price to limit losses. " +
    "For Long orders, must be below the trigger price. For Short orders, must be above the trigger price."
  ),
  takeProfit: z.string().optional().describe(
    "Take Profit price in USD. Set to automatically close position at this price to secure profits. " +
    "For Long orders, must be above the trigger price. For Short orders, must be below the trigger price. " +
    "Max TP: 500% for leverage <50x, 300% for leverage ≥50x."
  ),
});

interface LeverUpOpenLimitOrderResult {
  success: boolean;
  message: string;
  data?: {
    quote: {
      symbol: string;
      side: string;
      leverage: number;
      triggerPrice: string;
      currentPrice: string;
      marginAmount: string;
      positionSize: string;
      stopLoss?: string;
      takeProfit?: string;
    };
    txHash: string;
    explorerUrl: string;
  };
  error?: string;
}

export function registerLeverUpOpenLimitOrder(server: McpServer): void {
  server.tool(
    "leverup_open_limit_order",
    "Place a limit order on LeverUp that will trigger when the market reaches your specified price. " +
      "For Long orders, the trigger price must be BELOW current market (buy the dip). " +
      "For Short orders, the trigger price must be ABOVE current market (sell the top). " +
      "Requires Touch ID confirmation.",
    LeverUpOpenLimitOrderSchema.shape,
    async (params): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await leverUpOpenLimitOrderHandler(
        params as z.infer<typeof LeverUpOpenLimitOrderSchema>
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

async function leverUpOpenLimitOrderHandler(
  params: z.infer<typeof LeverUpOpenLimitOrderSchema>
): Promise<LeverUpOpenLimitOrderResult> {
  try {
    const config = await loadConfig();
    if (!config || !isWalletConfigured(config)) {
      return {
        success: false,
        message: "Wallet not configured. Run setup_wallet first.",
      };
    }

    const userAddress = config.wallet!.smartAccountAddress as Address;
    const sessionKeyAddress = config.wallet!.sessionKeyAddress as Address;
    const chainId = config.network.chainId;
    const rpcUrl = await getRpcUrl(config);
    const collateral = params.collateralToken ?? "MON";

    // Get quote with trigger price validation
    const quote = await getLimitOrderQuote(
      params.symbol,
      params.isLong,
      params.marginAmount,
      params.leverage,
      params.triggerPrice,
      collateral
    );

    // Check trigger price validity
    if (!quote.isTriggerValid) {
      return {
        success: false,
        message: quote.triggerValidationMessage,
        error: "Invalid trigger price for order direction"
      };
    }

    // Check other warnings (position size, etc.)
    if (!quote.meetsMinimums) {
      return {
        success: false,
        message: quote.warnings.join(" "),
        error: "Quote validation failed"
      };
    }

    // Validate leverage for high-leverage (Zero-Fee) pairs
    const pairMetadata = SUPPORTED_PAIRS.find(
      p => p.pair === `${params.symbol}/USD` || p.pair === params.symbol
    );
    if (pairMetadata?.isHighLeverage && !isDegenModeLeverage(params.leverage)) {
      return {
        success: false,
        message: `${pairMetadata.pair} is a Zero-Fee pair that ONLY supports ${DEGEN_MODE_LEVERAGE_OPTIONS.join(', ')}x leverage. ` +
          `Requested: ${params.leverage}x. Use a standard pair (BTC, ETH) for lower leverage.`,
        error: "Invalid leverage for Zero-Fee pair"
      };
    }

    const triggerPrice = parseFloat(params.triggerPrice);

    // Validate TP relative to TRIGGER price (not current market)
    if (params.takeProfit) {
      const tpPrice = parseFloat(params.takeProfit);
      const maxTpPercent = getMaxTpPercent(params.leverage);
      const tpPercent = params.isLong
        ? ((tpPrice - triggerPrice) / triggerPrice) * 100
        : ((triggerPrice - tpPrice) / triggerPrice) * 100;

      if (tpPercent <= 0) {
        const direction = params.isLong ? 'above' : 'below';
        return {
          success: false,
          message: `Invalid Take Profit price. For a ${params.isLong ? 'Long' : 'Short'} limit order, TP must be ${direction} trigger price ($${triggerPrice}).`,
          error: "Invalid TP direction"
        };
      }

      if (tpPercent > maxTpPercent) {
        return {
          success: false,
          message: `Take Profit exceeds maximum allowed. For ${params.leverage}x leverage, max TP is ${maxTpPercent}% profit from trigger price. ` +
            `Requested TP would be ~${tpPercent.toFixed(1)}% profit.`,
          error: "TP exceeds maximum"
        };
      }
    }

    // Validate SL relative to TRIGGER price (not current market)
    if (params.stopLoss) {
      const slPrice = parseFloat(params.stopLoss);
      const isInvalidSl = params.isLong ? slPrice >= triggerPrice : slPrice <= triggerPrice;
      if (isInvalidSl) {
        const direction = params.isLong ? 'below' : 'above';
        return {
          success: false,
          message: `Invalid Stop Loss for ${params.isLong ? 'Long' : 'Short'} limit order. SL price ($${slPrice}) must be ${direction} trigger price ($${triggerPrice}).`,
          error: "Invalid SL direction"
        };
      }
    }

    const triggerPriceWei = parseUnits(params.triggerPrice, 18);
    const marginWei = parseUnits(params.marginAmount, getCollateralDecimals(collateral));
    const qtyWei = parseUnits(quote.positionSize, 10);

    const execution = await executeOpenLimitOrder({
      symbol: params.symbol,
      isLong: params.isLong,
      amountIn: marginWei,
      leverage: params.leverage,
      qty: qtyWei,
      triggerPrice: triggerPriceWei,
      collateralToken: collateral as any,
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
        return {
          success: false,
          message: `Insufficient native MON balance. Required: ${totalRequired} MON (${params.marginAmount} margin + ${tradingFee} trading fee + Pyth fee). ` +
            `Available: ${formatUnits(nativeBalance, decimals)} MON.`,
          error: "Insufficient balance"
        };
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
        return {
          success: false,
          message: `Insufficient ${collateral} balance. Required: ${required} ${collateral} (${params.marginAmount} margin + ${fee} fee), Available: ${available} ${collateral}.`,
          error: "Insufficient balance"
        };
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

      const currentAllowance = await publicClient.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: "allowance",
        args: [userAddress, execution.to],
      });

      if (currentAllowance < execution.amountIn) {
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

    // Add the limit order delegation
    const limitOrderDelegation = createLeverUpLimitOrderDelegation({
      diamond: execution.to,
      delegator: userAddress,
      sessionKey: sessionKeyAddress,
      nonce,
      chainId,
      calldata: execution.data as Hex,
      value: execution.value,
    });

    delegations.push({
      delegation: limitOrderDelegation.delegation as SignedDelegation,
      execution: {
        target: execution.to,
        value: execution.value,
        callData: execution.data as Hex,
      },
      kind: "leverup_limit_order",
    });

    // Burst sign all delegations
    for (const bundle of delegations) {
      let actionLabel: string;
      if (bundle.kind === "approve") {
        actionLabel = `Approve ${collateral} for LeverUp`;
      } else {
        actionLabel = `LeverUp Limit: ${params.leverage}x ${params.isLong ? 'Long' : 'Short'} ${params.symbol} @ $${params.triggerPrice}`;
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
          success: false,
          message: "Failed to approve token. Transaction reverted.",
          error: "Approve transaction failed"
        };
      }
    }

    // Step 2: Execute the trade delegation
    const tradeBundle = delegations.find(d => d.kind === "leverup_limit_order");
    if (!tradeBundle) {
      return {
        success: false,
        message: "Internal error: trade delegation not found.",
        error: "Missing trade delegation"
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

    if (receipt.status === "success") {
      return {
        success: true,
        message: `Successfully placed ${params.leverage}x ${params.isLong ? 'Long' : 'Short'} limit order on ${params.symbol} at $${params.triggerPrice}. ` +
          `Order will trigger when market ${params.isLong ? 'drops to' : 'rises to'} your price.`,
        data: {
          quote: {
            symbol: quote.symbol,
            side: params.isLong ? "LONG" : "SHORT",
            leverage: params.leverage,
            triggerPrice: `$${params.triggerPrice}`,
            currentPrice: `$${quote.currentPrice}`,
            marginAmount: quote.marginAmount,
            positionSize: `$${quote.positionValueUsd}`,
            stopLoss: params.stopLoss ? `$${params.stopLoss}` : undefined,
            takeProfit: params.takeProfit ? `$${params.takeProfit}` : undefined,
          },
          txHash,
          explorerUrl: `https://monadvision.com/tx/${txHash}`
        }
      };
    } else {
      return {
        success: false,
        message: "Transaction reverted on-chain. Check your collateral balance and try again.",
        error: "Transaction reverted"
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return {
      success: false,
      message: `Failed to place limit order: ${errorMessage}`,
      error: errorMessage
    };
  }
}

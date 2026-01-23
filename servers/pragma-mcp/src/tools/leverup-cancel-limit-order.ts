import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadConfig, isWalletConfigured, getRpcUrl } from "../config/pragma-config.js";
import { executeCancelLimitOrder, executeBatchCancelLimitOrders } from "../core/leverup/execution.js";
import { signDelegationWithP256 } from "../core/signer/p256SignerConfig.js";
import { getSessionKey, getSessionAccount } from "../core/session/keys.js";
import { buildViemChain } from "../config/chains.js";
import { createSyncHttpTransport } from "../core/x402/client.js";
import { waitForReceiptSync } from "../core/rpc/index.js";
import { DELEGATION_FRAMEWORK } from "../config/constants.js";
import { getCurrentNonce } from "../core/delegation/nonce.js";
import { createLeverUpCancelLimitOrderDelegation } from "../core/delegation/hybrid.js";
import {
  createPublicClient,
  createWalletClient,
  type Address,
  type Hex,
} from "viem";
import {
  redeemDelegations,
  createExecution,
  ExecutionMode
} from "@metamask/smart-accounts-kit";

const LeverUpCancelLimitOrderSchema = z.object({
  orderHashes: z
    .array(z.string().regex(/^0x[a-fA-F0-9]{64}$/))
    .min(1)
    .describe(
      "Array of limit order hashes to cancel. Use leverup_list_limit_orders to get the orderHashes of your pending orders."
    ),
});

interface LeverUpCancelLimitOrderResult {
  success: boolean;
  message: string;
  data?: {
    cancelledOrders: string[];
    txHash: string;
    explorerUrl: string;
  };
  error?: string;
}

export function registerLeverUpCancelLimitOrder(server: McpServer): void {
  server.tool(
    "leverup_cancel_limit_order",
    "Cancel one or more pending LeverUp limit orders. " +
      "Requires Touch ID confirmation. " +
      "Use leverup_list_limit_orders first to see your pending orders and their orderHashes.",
    LeverUpCancelLimitOrderSchema.shape,
    async (params): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await leverUpCancelLimitOrderHandler(
        params as z.infer<typeof LeverUpCancelLimitOrderSchema>
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

async function leverUpCancelLimitOrderHandler(
  params: z.infer<typeof LeverUpCancelLimitOrderSchema>
): Promise<LeverUpCancelLimitOrderResult> {
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

    const orderHashes = params.orderHashes as Hex[];

    // Use single cancel for 1 order, batch cancel for multiple
    const execution = orderHashes.length === 1
      ? executeCancelLimitOrder(orderHashes[0])
      : executeBatchCancelLimitOrders(orderHashes);

    const chain = buildViemChain(chainId, rpcUrl);
    const publicClient = createPublicClient({
      chain,
      transport: createSyncHttpTransport(rpcUrl, config),
    });

    // Create delegation for cancel operation (nonpayable)
    const nonce = await getCurrentNonce(publicClient, userAddress);
    const delegationResult = createLeverUpCancelLimitOrderDelegation({
      diamond: execution.to,
      delegator: userAddress,
      sessionKey: sessionKeyAddress,
      nonce,
      chainId,
      calldata: execution.data as Hex,
    });

    // Sign with Touch ID
    const orderCountText = orderHashes.length === 1
      ? `Cancel limit order: ${orderHashes[0].slice(0, 10)}...`
      : `Cancel ${orderHashes.length} limit orders`;
    const signature = await signDelegationWithP256(
      delegationResult.delegation,
      chainId,
      config.wallet!.keyId,
      orderCountText
    );
    delegationResult.delegation.signature = signature;

    // Execute via session key
    const sessionKey = await getSessionKey();
    const sessionAccount = getSessionAccount(sessionKey!);
    const sessionWallet = createWalletClient({
      account: sessionAccount,
      chain,
      transport: createSyncHttpTransport(rpcUrl, config),
    });

    const txHash = await redeemDelegations(
      sessionWallet,
      publicClient,
      DELEGATION_FRAMEWORK.delegationManager,
      [{
        permissionContext: [delegationResult.delegation],
        executions: [createExecution({
          target: execution.to,
          value: execution.value,
          callData: execution.data as Hex
        })],
        mode: ExecutionMode.SingleDefault
      }]
    );

    const receipt = await waitForReceiptSync(publicClient, txHash);

    if (receipt.status === "success") {
      return {
        success: true,
        message: orderHashes.length === 1
          ? `Successfully cancelled limit order ${orderHashes[0]}`
          : `Successfully cancelled ${orderHashes.length} limit orders`,
        data: {
          cancelledOrders: orderHashes,
          txHash,
          explorerUrl: `https://monadvision.com/tx/${txHash}`
        }
      };
    } else {
      return {
        success: false,
        message: "Transaction reverted on-chain. The order may have already been filled or cancelled.",
        error: "Transaction reverted"
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return {
      success: false,
      message: `Failed to cancel limit order: ${errorMessage}`,
      error: errorMessage
    };
  }
}

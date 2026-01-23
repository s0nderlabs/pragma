import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadConfig, isWalletConfigured, getRpcUrl } from "../config/pragma-config.js";
import { executeUpdateTpSl } from "../core/leverup/execution.js";
import { signDelegationWithP256 } from "../core/signer/p256SignerConfig.js";
import { getSessionKey, getSessionAccount } from "../core/session/keys.js";
import { buildViemChain } from "../config/chains.js";
import { createSyncHttpTransport } from "../core/x402/client.js";
import { waitForReceiptSync } from "../core/rpc/index.js";
import { DELEGATION_FRAMEWORK } from "../config/constants.js";
import { getCurrentNonce } from "../core/delegation/nonce.js";
import { createLeverUpUpdateTpSlDelegation } from "../core/delegation/hybrid.js";
import {
  createPublicClient,
  createWalletClient,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import {
  redeemDelegations,
  createExecution,
  ExecutionMode
} from "@metamask/smart-accounts-kit";
import { withRetryOrThrow } from "../core/utils/retry.js";

const LeverUpUpdateTpSlSchema = z.object({
  tradeHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/).describe("The unique identifier of the position."),
  takeProfit: z.string().optional().describe(
    "New take profit price in USD (e.g. '110000' for $110,000). Set to '0' or omit to disable TP."
  ),
  stopLoss: z.string().optional().describe(
    "New stop loss price in USD (e.g. '95000' for $95,000). Set to '0' or omit to disable SL."
  )
});

export function registerLeverUpUpdateTpSl(server: McpServer): void {
  server.tool(
    "leverup_update_tpsl",
    "Update take profit and/or stop loss on an existing LeverUp position. Requires Touch ID confirmation. " +
    "Set a price to '0' to disable that trigger. At least one of takeProfit or stopLoss must be provided.",
    LeverUpUpdateTpSlSchema.shape,
    async (params): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      try {
        const config = await loadConfig();
        if (!config || !isWalletConfigured(config)) {
          throw new Error("Wallet not configured.");
        }

        // At least one of TP or SL must be provided
        if (params.takeProfit === undefined && params.stopLoss === undefined) {
          throw new Error("At least one of takeProfit or stopLoss must be provided.");
        }

        const userAddress = config.wallet!.smartAccountAddress as Address;
        const sessionKeyAddress = config.wallet!.sessionKeyAddress as Address;
        const chainId = config.network.chainId;
        const rpcUrl = await getRpcUrl(config);

        // Parse TP/SL prices (18 decimals like entry price)
        // If not provided, use 0 (which disables the trigger)
        const tpWei = params.takeProfit
          ? parseUnits(params.takeProfit, 18)
          : 0n;
        const slWei = params.stopLoss
          ? parseUnits(params.stopLoss, 18)
          : 0n;

        const execution = executeUpdateTpSl(
          params.tradeHash as Hex,
          tpWei,
          slWei
        );

        const chain = buildViemChain(chainId, rpcUrl);
        const publicClient = createPublicClient({
          chain,
          transport: createSyncHttpTransport(rpcUrl, config),
        });

        const nonce = await withRetryOrThrow(
          () => getCurrentNonce(publicClient, userAddress),
          { operationName: "get-delegation-nonce" }
        );
        const delegationResult = createLeverUpUpdateTpSlDelegation({
          diamond: execution.to,
          delegator: userAddress,
          sessionKey: sessionKeyAddress,
          nonce,
          chainId,
          calldata: execution.data as Hex,
        });

        // Build action label for Touch ID prompt
        const tpLabel = params.takeProfit ? `TP=$${params.takeProfit}` : "";
        const slLabel = params.stopLoss ? `SL=$${params.stopLoss}` : "";
        const actionLabel = `Update ${[tpLabel, slLabel].filter(Boolean).join(", ")} on ${params.tradeHash.slice(0, 10)}...`;

        const signature = await signDelegationWithP256(
          delegationResult.delegation,
          chainId,
          config.wallet!.keyId,
          actionLabel
        );
        delegationResult.delegation.signature = signature;

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

        // Build success message with details
        const updates: string[] = [];
        if (params.takeProfit) {
          updates.push(params.takeProfit === "0" ? "TP disabled" : `TP=$${params.takeProfit}`);
        }
        if (params.stopLoss) {
          updates.push(params.stopLoss === "0" ? "SL disabled" : `SL=$${params.stopLoss}`);
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: receipt.status === "success",
              message: receipt.status === "success"
                ? `Successfully updated ${updates.join(", ")}`
                : "Transaction reverted on-chain",
              txHash,
              explorerUrl: `https://monadvision.com/tx/${txHash}`
            }, null, 2)
          }]
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              message: "Failed to update TP/SL",
              error: errorMessage
            }, null, 2)
          }]
        };
      }
    }
  );
}

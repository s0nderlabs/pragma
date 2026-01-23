import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadConfig, isWalletConfigured, getRpcUrl } from "../config/pragma-config.js";
import { executeCloseTrade } from "../core/leverup/execution.js";
import { signDelegationWithP256 } from "../core/signer/p256SignerConfig.js";
import { getSessionKey, getSessionAccount } from "../core/session/keys.js";
import { buildViemChain } from "../config/chains.js";
import { createSyncHttpTransport } from "../core/x402/client.js";
import { waitForReceiptSync } from "../core/rpc/index.js";
import { DELEGATION_FRAMEWORK } from "../config/constants.js";
import { getCurrentNonce } from "../core/delegation/nonce.js";
import { createLeverUpCloseDelegation } from "../core/delegation/hybrid.js";
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

const LeverUpCloseTradeSchema = z.object({
  tradeHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/).describe("The unique identifier of the position to close."),
});

export function registerLeverUpCloseTrade(server: McpServer): void {
  server.tool(
    "leverup_close_trade",
    "Close an existing LeverUp perpetual position. Requires Touch ID confirmation.",
    LeverUpCloseTradeSchema.shape,
    async (params): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      try {
        const config = await loadConfig();
        if (!config || !isWalletConfigured(config)) {
          throw new Error("Wallet not configured.");
        }

        const userAddress = config.wallet!.smartAccountAddress as Address;
        const sessionKeyAddress = config.wallet!.sessionKeyAddress as Address;
        const chainId = config.network.chainId;
        const rpcUrl = await getRpcUrl(config);

        const execution = await executeCloseTrade(params.tradeHash as Hex);

        const chain = buildViemChain(chainId, rpcUrl);
        const publicClient = createPublicClient({
          chain,
          transport: createSyncHttpTransport(rpcUrl, config),
        });

        const nonce = await getCurrentNonce(publicClient, userAddress);
        const delegationResult = createLeverUpCloseDelegation({
          diamond: execution.to,
          delegator: userAddress,
          sessionKey: sessionKeyAddress,
          nonce,
          chainId,
          calldata: execution.data as Hex,
        });

        const actionLabel = `Close LeverUp Position: ${params.tradeHash.slice(0, 10)}...`;
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

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: receipt.status === "success",
              message: receipt.status === "success" 
                ? `Successfully closed position ${params.tradeHash}`
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

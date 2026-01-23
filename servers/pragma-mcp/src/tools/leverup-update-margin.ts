import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadConfig, isWalletConfigured, getRpcUrl } from "../config/pragma-config.js";
import { getCollateralDecimals } from "../core/leverup/client.js";
import { executeUpdateMargin } from "../core/leverup/execution.js";
import { signDelegationWithP256 } from "../core/signer/p256SignerConfig.js";
import { getSessionKey, getSessionAccount } from "../core/session/keys.js";
import { buildViemChain } from "../config/chains.js";
import { createSyncHttpTransport } from "../core/x402/client.js";
import { waitForReceiptSync } from "../core/rpc/index.js";
import { DELEGATION_FRAMEWORK } from "../config/constants.js";
import { getCurrentNonce } from "../core/delegation/nonce.js";
import { createLeverUpUpdateMarginDelegation } from "../core/delegation/hybrid.js";
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

const LeverUpUpdateMarginSchema = z.object({
  tradeHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/).describe("The unique identifier of the position."),
  amount: z.string().describe("Amount of collateral to add or remove (e.g. '5' for 5 MON)."),
  isAdd: z.boolean().describe("true to add collateral, false to remove."),
  collateralToken: z.enum(["MON", "USDC", "LVUSD", "LVMON"]).default("MON").describe(
    "Collateral token matching the position's collateral. IMPORTANT: Positions opened with 500x, 750x, or 1001x leverage " +
    "(Zero-Fee mode) CANNOT add or remove margin - this operation will fail for those positions."
  )
});

export function registerLeverUpUpdateMargin(server: McpServer): void {
  server.tool(
    "leverup_update_margin",
    "Add or remove collateral from an existing LeverUp position. Requires Touch ID confirmation. " +
    "NOTE: This does NOT work for Zero-Fee positions (500x/750x/1001x leverage) - those positions cannot adjust margin.",
    LeverUpUpdateMarginSchema.shape,
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

        const amountWei = parseUnits(params.amount, getCollateralDecimals(params.collateralToken));
        const execution = await executeUpdateMargin(params.tradeHash as Hex, amountWei, params.isAdd);

        const chain = buildViemChain(chainId, rpcUrl);
        const publicClient = createPublicClient({
          chain,
          transport: createSyncHttpTransport(rpcUrl, config),
        });

        const nonce = await getCurrentNonce(publicClient, userAddress);
        const delegationResult = createLeverUpUpdateMarginDelegation({
          diamond: execution.to,
          delegator: userAddress,
          sessionKey: sessionKeyAddress,
          nonce,
          chainId,
          calldata: execution.data as Hex,
          value: execution.value,
        });

        const actionLabel = `${params.isAdd ? 'Add' : 'Remove'} ${params.amount} ${params.collateralToken || 'MON'} Margin to ${params.tradeHash.slice(0, 10)}...`;
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
                ? `Successfully ${params.isAdd ? 'added' : 'removed'} ${params.amount} margin`
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

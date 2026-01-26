import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadConfig, isWalletConfigured, getRpcUrl } from "../config/pragma-config.js";
import { getCollateralDecimals } from "../core/leverup/client.js";
import { executeAddMargin, type CollateralToken } from "../core/leverup/execution.js";
import { executeAutonomousLeverUpUpdateMargin } from "../core/execution/autonomous.js";
import { signDelegationWithP256 } from "../core/signer/p256SignerConfig.js";
import { getSessionKey, getSessionAccount } from "../core/session/keys.js";
import { buildViemChain } from "../config/chains.js";
import { createSyncHttpTransport } from "../core/x402/client.js";
import { waitForReceiptSync } from "../core/rpc/index.js";
import { DELEGATION_FRAMEWORK } from "../config/constants.js";
import { getCurrentNonce } from "../core/delegation/nonce.js";
import {
  createLeverUpUpdateMarginDelegation,
  createApproveDelegation
} from "../core/delegation/hybrid.js";
import {
  WMON_ADDRESS,
  USDC_ADDRESS,
  LVUSD_ADDRESS,
  LVMON_ADDRESS,
  LEVERUP_DIAMOND
} from "../core/leverup/constants.js";
import {
  createPublicClient,
  createWalletClient,
  parseUnits,
  encodeFunctionData,
  erc20Abi,
  type Address,
  type Hex,
} from "viem";
import {
  redeemDelegations,
  createExecution,
  ExecutionMode
} from "@metamask/smart-accounts-kit";
import { withRetryOrThrow } from "../core/utils/retry.js";

const LeverUpUpdateMarginSchema = z.object({
  tradeHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/).describe("The unique identifier of the position."),
  amount: z.string().describe("Amount of collateral to add (e.g. '5' for 5 MON)."),
  collateralToken: z.enum(["MON", "USDC", "LVUSD", "LVMON"]).default("MON").describe(
    "Collateral token matching the position's collateral. IMPORTANT: Positions opened with 500x, 750x, or 1001x leverage " +
    "(Zero-Fee mode) CANNOT add margin - this operation will fail for those positions."
  ),
  agentId: z
    .string()
    .optional()
    .describe(
      "Sub-agent ID for autonomous execution (no Touch ID). " +
      "If omitted, uses assistant mode with Touch ID confirmation."
    ),
});

/**
 * Get the token address for a given collateral type
 * For MON collateral positions, use WMON address (contract wraps internally)
 */
function getCollateralTokenAddress(collateralToken: CollateralToken): Address {
  switch (collateralToken) {
    case "USDC":
      return USDC_ADDRESS;
    case "LVUSD":
      return LVUSD_ADDRESS;
    case "LVMON":
      return LVMON_ADDRESS;
    case "MON":
    default:
      // For native MON: pass WMON address to the contract
      // The contract identifies MON positions by WMON address
      return WMON_ADDRESS;
  }
}

export function registerLeverUpUpdateMargin(server: McpServer): void {
  server.tool(
    "leverup_update_margin",
    "Add collateral to an existing LeverUp position. " +
    "If agentId provided: uses autonomous mode (no Touch ID). " +
    "If no agentId: uses assistant mode (requires Touch ID). " +
    "NOTE: Only ADDING margin is supported. This does NOT work for Zero-Fee positions (500x/750x/1001x leverage).",
    LeverUpUpdateMarginSchema.shape,
    async (params): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      try {
        const config = await loadConfig();
        if (!config || !isWalletConfigured(config)) {
          throw new Error("Wallet not configured.");
        }

        // DUAL-MODE: Check if autonomous execution requested
        if (params.agentId) {
          // Autonomous path: use pre-signed delegation chain, no Touch ID
          const result = await executeAutonomousLeverUpUpdateMargin(
            params.agentId,
            params.tradeHash as Hex,
            params.amount,
            (params.collateralToken || "MON") as CollateralToken
          );
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

        const collateralToken = (params.collateralToken || "MON") as CollateralToken;
        const tokenAddress = getCollateralTokenAddress(collateralToken);
        const isNativeMon = collateralToken === "MON";
        const amountWei = parseUnits(params.amount, getCollateralDecimals(collateralToken));

        const execution = executeAddMargin(
          params.tradeHash as Hex,
          tokenAddress,
          amountWei,
          isNativeMon
        );

        const chain = buildViemChain(chainId, rpcUrl);
        const publicClient = createPublicClient({
          chain,
          transport: createSyncHttpTransport(rpcUrl, config),
        });

        // Build delegations list
        const delegations: any[] = [];
        let currentNonce = await withRetryOrThrow(
          () => getCurrentNonce(publicClient, userAddress),
          { operationName: "get-delegation-nonce" }
        );

        // If using ERC20 collateral (not native MON), check and create approval if needed
        if (!isNativeMon) {
          const allowance = await withRetryOrThrow(
            async () => publicClient.readContract({
              address: tokenAddress,
              abi: erc20Abi,
              functionName: "allowance",
              args: [userAddress, LEVERUP_DIAMOND]
            }),
            { operationName: "check-allowance" }
          );

          if (allowance < amountWei) {
            const approveDelegation = createApproveDelegation({
              tokenAddress,
              spender: LEVERUP_DIAMOND,
              amount: amountWei,
              delegator: userAddress,
              sessionKey: sessionKeyAddress,
              nonce: currentNonce,
              chainId,
            });
            delegations.push({
              delegation: approveDelegation.delegation,
              execution: {
                target: tokenAddress,
                value: 0n,
                callData: encodeFunctionData({
                  abi: erc20Abi,
                  functionName: "approve",
                  args: [LEVERUP_DIAMOND, amountWei],
                }),
              },
            });
          // NOTE: Do NOT increment nonce - multiple delegations in same batch use same nonce
          }
        }

        // Create add margin delegation
        const marginDelegation = createLeverUpUpdateMarginDelegation({
          diamond: execution.to,
          delegator: userAddress,
          sessionKey: sessionKeyAddress,
          nonce: currentNonce,
          chainId,
          calldata: execution.data as Hex,
          value: execution.value,
        });
        delegations.push({
          delegation: marginDelegation.delegation,
          execution: {
            target: execution.to,
            value: execution.value,
            callData: execution.data as Hex
          }
        });

        // Sign all delegations with Touch ID
        const actionLabel = `Add ${params.amount} ${collateralToken} Margin to ${params.tradeHash.slice(0, 10)}...`;
        for (const d of delegations) {
          const signature = await signDelegationWithP256(
            d.delegation,
            chainId,
            config.wallet!.keyId,
            actionLabel
          );
          d.delegation.signature = signature;
        }

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
          delegations.map(d => ({
            permissionContext: [d.delegation],
            executions: [createExecution(d.execution)],
            mode: ExecutionMode.SingleDefault
          }))
        );

        const receipt = await waitForReceiptSync(publicClient, txHash);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: receipt.status === "success",
              message: receipt.status === "success"
                ? `Successfully added ${params.amount} ${collateralToken} margin`
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
              message: "Failed to add margin",
              error: errorMessage
            }, null, 2)
          }]
        };
      }
    }
  );
}

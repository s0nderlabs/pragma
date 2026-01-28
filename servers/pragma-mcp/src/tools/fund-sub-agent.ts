// Fund Sub-Agent Tool
// Transfers MON from session key to sub-agent wallet for gas
// Copyright (c) 2026 s0nderlabs

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  formatEther,
  parseEther,
  http,
  createPublicClient,
  createWalletClient,
  type Address,
} from "viem";
import { loadConfig, getRpcUrl } from "../config/pragma-config.js";
import { buildViemChain } from "../config/chains.js";
import { getSessionKey, getSessionAccount } from "../core/session/keys.js";
import { x402HttpOptions } from "../core/x402/client.js";
import { loadAgentState, getFullWallet } from "../core/subagent/index.js";
import { withRetryOrThrow } from "../core/utils/retry.js";

const FundSubAgentSchema = z.object({
  subAgentId: z.string().describe("The sub-agent ID (UUID) to fund"),
  amountMon: z
    .number()
    .min(0.001)
    .max(10)
    .default(1)
    .describe(
      "Amount of MON to transfer for gas. Default: 1 MON. Max: 10 MON"
    ),
});

interface FundSubAgentResult {
  success: boolean;
  message: string;
  funding?: {
    subAgentId: string;
    walletAddress: string;
    amountFunded: string;
    previousBalance: string;
    newBalance: string;
    txHash: string;
  };
  error?: string;
}

export function registerFundSubAgent(server: McpServer): void {
  server.tool(
    "fund_sub_agent",
    "Transfer MON from session key to a sub-agent wallet for gas. " +
      "Use to top up a sub-agent that needs more gas for transactions. " +
      "Requires an active session key with sufficient balance.",
    FundSubAgentSchema.shape,
    async (
      params
    ): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await fundSubAgentHandler(
        params as z.infer<typeof FundSubAgentSchema>
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}

async function fundSubAgentHandler(
  params: z.infer<typeof FundSubAgentSchema>
): Promise<FundSubAgentResult> {
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

    // Load sub-agent state
    const state = await loadAgentState(params.subAgentId);
    if (!state) {
      return {
        success: false,
        message: "Sub-agent not found",
        error: `No sub-agent found with ID: ${params.subAgentId}`,
      };
    }

    // Get sub-agent wallet
    const subAgentWallet = await getFullWallet(state.walletId);
    if (!subAgentWallet) {
      return {
        success: false,
        message: "Sub-agent wallet not found",
        error: `Wallet ${state.walletId} not found in pool or Keychain`,
      };
    }

    // Get clients
    const chainId = config.network.chainId;
    const rpcUrl = await getRpcUrl(config);
    const chain = buildViemChain(chainId, rpcUrl);

    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl, x402HttpOptions(config)),
    });

    const sessionAccount = getSessionAccount(sessionKey);
    const walletClient = createWalletClient({
      account: sessionAccount,
      chain,
      transport: http(rpcUrl, x402HttpOptions(config)),
    });

    // Check session key balance (with retry)
    const sessionKeyBalance = await withRetryOrThrow(
      async () => publicClient.getBalance({ address: sessionKey.address }),
      { operationName: "check-session-key-balance" }
    );

    const amountWei = parseEther(params.amountMon.toString());

    if (sessionKeyBalance < amountWei) {
      return {
        success: false,
        message: "Insufficient session key balance",
        error: `Session key has ${formatEther(sessionKeyBalance)} MON, need ${params.amountMon} MON`,
      };
    }

    // Get sub-agent's previous balance (with retry)
    const previousBalance = await withRetryOrThrow(
      async () => publicClient.getBalance({ address: subAgentWallet.address as Address }),
      { operationName: "check-subagent-balance" }
    );

    // Transfer MON from session key to sub-agent
    const txHash = await walletClient.sendTransaction({
      to: subAgentWallet.address as Address,
      value: amountWei,
    });

    // Wait for confirmation
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    // Get new balance (with retry)
    const newBalance = await withRetryOrThrow(
      async () => publicClient.getBalance({ address: subAgentWallet.address as Address }),
      { operationName: "check-new-balance" }
    );

    return {
      success: true,
      message: `Funded sub-agent with ${params.amountMon} MON`,
      funding: {
        subAgentId: params.subAgentId,
        walletAddress: subAgentWallet.address,
        amountFunded: params.amountMon + " MON",
        previousBalance: formatEther(previousBalance) + " MON",
        newBalance: formatEther(newBalance) + " MON",
        txHash,
      },
    };
  } catch (error) {
    return {
      success: false,
      message: "Failed to fund sub-agent",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadConfig, isWalletConfigured } from "../config/pragma-config.js";
import { getUserPositions } from "../core/leverup/client.js";
import {
  getTrackedPositions,
  updateTrackedPositionStatus,
  removeTrackedPosition,
  linkTrackedPosition,
  updateTokenFlows,
  appendJournal,
} from "../core/subagent/state.js";
import { querySettlementInflows } from "../core/execution/autonomous.js";
import { createPublicClient, formatUnits, parseUnits, type Address } from "viem";
import { buildViemChain } from "../config/chains.js";
import { getRpcUrl } from "../config/pragma-config.js";
import { createSyncHttpTransport } from "../core/x402/client.js";

const LeverUpListPositionsSchema = z.object({
  address: z
    .string()
    .optional()
    .describe("Optional address to check positions for. Defaults to your smart account."),
  agentId: z
    .string()
    .optional()
    .describe("Optional sub-agent ID. When provided, reconciles tracked positions to detect keeper-triggered closes (TP/SL/liquidation) and record settlement inflows."),
});

interface LeverUpListPositionsResult {
  success: boolean;
  message: string;
  data?: {
    positions: Array<{
      tradeHash: string;
      pair: string;
      side: string;
      size: string;
      margin: string;
      entryPrice: string;
      stopLoss: string;
      takeProfit: string;
      unrealizedPnL: string;
      pnlPercentage: string;
      liqPrice: string;
      healthFactor: number;
      distanceToLiq: string;
    }>;
    reconciliation?: {
      trackedCount: number;
      linkedCount: number;
      settledCount: number;
      pendingSettlementCount: number;
    };
  };
}

/** Number of blocks to wait after detecting a gone position before querying settlement */
const SETTLEMENT_BLOCK_DELAY = 15;

export function registerLeverUpListPositions(server: McpServer): void {
  server.tool(
    "leverup_list_positions",
    "List all your active LeverUp perpetual positions with PnL and liquidation analysis.",
    LeverUpListPositionsSchema.shape,
    async (params): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await leverupListPositionsHandler(params as z.infer<typeof LeverUpListPositionsSchema>);
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

async function leverupListPositionsHandler(
  params: z.infer<typeof LeverUpListPositionsSchema>
): Promise<LeverUpListPositionsResult> {
  try {
    const config = await loadConfig();
    if (!config || !isWalletConfigured(config)) {
      return {
        success: false,
        message: "Wallet not configured. Run setup_wallet first.",
      };
    }

    const userAddress = (params.address || config.wallet?.smartAccountAddress) as Address;
    const positions = await getUserPositions(userAddress);

    const formattedPositions = positions.map(p => ({
      tradeHash: p.position.positionHash,
      pair: p.position.pair,
      side: p.position.isLong ? "LONG" : "SHORT",
      size: formatUnits(p.position.qty, 10),
      margin: formatUnits(p.position.margin, 18),
      entryPrice: `$${formatUnits(p.position.entryPrice, 18)}`,
      stopLoss: p.position.stopLoss > 0n ? `$${Number(formatUnits(p.position.stopLoss, 18)).toFixed(2)}` : "Not set",
      takeProfit: p.position.takeProfit > 0n ? `$${Number(formatUnits(p.position.takeProfit, 18)).toFixed(2)}` : "Not set",
      unrealizedPnL: p.analysis.unrealizedPnL,
      pnlPercentage: p.analysis.pnlPercentage,
      liqPrice: `$${p.analysis.liqPrice}`,
      healthFactor: p.analysis.healthFactor,
      distanceToLiq: p.analysis.distanceToLiq
    }));

    // Reconcile tracked positions if agentId provided
    let reconciliation: ReconciliationResult | undefined;
    if (params.agentId) {
      try {
        reconciliation = await reconcileTrackedPositions(
          params.agentId,
          userAddress,
          formattedPositions,
          config,
        );
      } catch {
        // Reconciliation is non-critical — never block position list
      }
    }

    const data = {
      positions: formattedPositions,
      ...(reconciliation ? { reconciliation } : {}),
    };

    if (positions.length === 0) {
      return {
        success: true,
        message: "No active LeverUp positions found.",
        data,
      };
    }

    const summary = formattedPositions
      .map(p => `${p.pair} ${p.side}: ${p.unrealizedPnL} (${p.pnlPercentage})`)
      .join(", ");

    return {
      success: true,
      message: `You have ${positions.length} active positions. Summary: ${summary}`,
      data,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return {
      success: false,
      message: `Failed to fetch LeverUp positions: ${errorMessage}`,
    };
  }
}

/**
 * Reconcile agent's tracked positions against the live API positions.
 *
 * 1. Link unlinked tracked positions (no tradeHash) to API positions by pair+side+margin match
 * 2. Detect keeper-triggered closes (tracked position not in API)
 * 3. After settlement delay, query Transfer events for inflows and record them
 */
interface ReconciliationResult {
  trackedCount: number;
  linkedCount: number;
  settledCount: number;
  pendingSettlementCount: number;
}

/** Absolute difference between two bigints */
function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}

async function reconcileTrackedPositions(
  agentId: string,
  userAddress: Address,
  apiPositions: Array<{ tradeHash: string; pair: string; side: string; margin: string }>,
  config: any,
): Promise<ReconciliationResult> {
  const tracked = getTrackedPositions(agentId);
  if (tracked.length === 0) {
    return { trackedCount: 0, linkedCount: 0, settledCount: 0, pendingSettlementCount: 0 };
  }

  const apiTradeHashes = new Set(apiPositions.map(p => p.tradeHash));
  let linkedCount = 0;
  let settledCount = 0;
  let pendingSettlementCount = 0;

  // Phase 1: Link unlinked tracked positions to API positions by pair+side+margin match
  for (let i = 0; i < tracked.length; i++) {
    const tp = tracked[i];
    if (tp.tradeHash) continue; // Already linked

    // Match by pair + side + margin proximity (5% tolerance for fees)
    const trackedMargin = BigInt(tp.margin);
    const matched = apiPositions.find(ap => {
      if (ap.pair !== tp.pair || ap.side !== tp.side) return false;
      const apiMargin = parseUnits(ap.margin, 18);
      return absDiff(apiMargin, trackedMargin) * 100n <= trackedMargin * 5n;
    });

    if (matched) {
      linkTrackedPosition(agentId, i, matched.tradeHash);
      tp.tradeHash = matched.tradeHash; // Update in-memory for phase 2
      linkedCount++;
    }
  }

  // Phase 2: Detect keeper-triggered closes and settle inflows
  // Get current block number for settlement delay check
  const rpcUrl = await getRpcUrl(config);
  const chainId = config.network?.chainId ?? 143;
  const chain = buildViemChain(chainId, rpcUrl);
  const publicClient = createPublicClient({
    chain,
    transport: createSyncHttpTransport(rpcUrl, config),
  });
  const currentBlock = await publicClient.getBlockNumber();

  for (const tp of tracked) {
    if (!tp.tradeHash) continue; // Still unlinked after phase 1

    // Still alive in API -- nothing to do
    if (apiTradeHashes.has(tp.tradeHash)) continue;

    // Position is gone from API -- keeper close (TP/SL/liquidation)
    if (tp.status === "open") {
      updateTrackedPositionStatus(agentId, tp.tradeHash, "pending_settlement", Number(currentBlock));
      pendingSettlementCount++;
      continue;
    }

    if (tp.status !== "pending_settlement" || !tp.detectedGoneAt) continue;

    const blocksSinceGone = Number(currentBlock) - tp.detectedGoneAt;
    if (blocksSinceGone < SETTLEMENT_BLOCK_DELAY) {
      pendingSettlementCount++;
      continue;
    }

    // Enough blocks passed -- query settlement inflows
    const inflows = await querySettlementInflows(
      BigInt(tp.detectedGoneAt),
      currentBlock,
      userAddress,
    );

    if (inflows.length > 0) {
      await updateTokenFlows(agentId, { outflows: [], inflows });
    }

    // Journal the keeper close
    const inflowSummary = inflows.length > 0
      ? inflows.map(i => formatUnits(i.amount, 18)).join(", ")
      : "0 (liquidation)";
    appendJournal(agentId, {
      ts: Date.now(),
      type: "trade_close",
      tradeHash: tp.tradeHash,
      pair: tp.pair,
      side: tp.side,
      pnl: inflowSummary,
      text: `Keeper close detected: ${tp.pair} ${tp.side} -- inflows: ${inflowSummary}`,
      protocol: "leverup",
    });

    removeTrackedPosition(agentId, tp.tradeHash);
    settledCount++;
  }

  return {
    trackedCount: tracked.length,
    linkedCount,
    settledCount,
    pendingSettlementCount,
  };
}

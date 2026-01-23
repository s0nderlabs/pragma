import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadConfig, isWalletConfigured } from "../config/pragma-config.js";
import { getUserLimitOrders } from "../core/leverup/client.js";
import { formatUnits, type Address } from "viem";

const LeverUpListLimitOrdersSchema = z.object({
  address: z
    .string()
    .optional()
    .describe("Optional address to check limit orders for. Defaults to your smart account."),
});

interface FormattedLimitOrder {
  orderHash: string;
  pair: string;
  side: string;
  triggerPrice: string;
  size: string;
  margin: string;
  stopLoss: string;
  takeProfit: string;
  createdAt: string;
}

interface LeverUpListLimitOrdersResult {
  success: boolean;
  message: string;
  data?: {
    orders: FormattedLimitOrder[];
    note: string;
  };
}

export function registerLeverUpListLimitOrders(server: McpServer): void {
  server.tool(
    "leverup_list_limit_orders",
    "List all your pending LeverUp limit orders. " +
      "These are orders that haven't been filled yet and will trigger when the market reaches the specified price. " +
      "For filled positions, use leverup_list_positions instead.",
    LeverUpListLimitOrdersSchema.shape,
    async (params): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const result = await leverUpListLimitOrdersHandler(params as z.infer<typeof LeverUpListLimitOrdersSchema>);
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

async function leverUpListLimitOrdersHandler(
  params: z.infer<typeof LeverUpListLimitOrdersSchema>
): Promise<LeverUpListLimitOrdersResult> {
  try {
    const config = await loadConfig();
    if (!config || !isWalletConfigured(config)) {
      return {
        success: false,
        message: "Wallet not configured. Run setup_wallet first.",
      };
    }

    const userAddress = (params.address || config.wallet?.smartAccountAddress) as Address;
    const orders = await getUserLimitOrders(userAddress);

    if (orders.length === 0) {
      return {
        success: true,
        message: "No pending limit orders found.",
        data: {
          orders: [],
          note: "Limit orders trigger when the market price reaches your specified trigger price. " +
            "Long orders trigger when price drops BELOW the trigger price. " +
            "Short orders trigger when price rises ABOVE the trigger price.",
        }
      };
    }

    const formattedOrders: FormattedLimitOrder[] = orders.map(order => ({
      orderHash: order.orderHash,
      pair: order.pair,
      side: order.isLong ? "LONG" : "SHORT",
      triggerPrice: `$${Number(formatUnits(order.limitPrice, 18)).toFixed(2)}`,
      size: formatUnits(order.qty, 10),
      margin: `${formatUnits(order.amountIn, 18)} (collateral)`,
      stopLoss: order.stopLoss > 0n ? `$${Number(formatUnits(order.stopLoss, 18)).toFixed(2)}` : "Not set",
      takeProfit: order.takeProfit > 0n ? `$${Number(formatUnits(order.takeProfit, 18)).toFixed(2)}` : "Not set",
      createdAt: new Date(order.timestamp * 1000).toISOString(),
    }));

    const summary = formattedOrders
      .map(o => `${o.pair} ${o.side} @ ${o.triggerPrice}`)
      .join(", ");

    return {
      success: true,
      message: `You have ${orders.length} pending limit order${orders.length > 1 ? "s" : ""}. Summary: ${summary}`,
      data: {
        orders: formattedOrders,
        note: "To cancel an order, use leverup_cancel_limit_order with the orderHash. " +
          "Orders will automatically fill when the market reaches your trigger price.",
      }
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return {
      success: false,
      message: `Failed to fetch limit orders: ${errorMessage}`,
    };
  }
}

import { 
  encodeFunctionData, 
  getAddress, 
  type Address, 
  type Hex 
} from "viem";
import {
  LEVERUP_DIAMOND,
  TRADING_PORTAL_ABI,
  SUPPORTED_PAIRS,
  PYTH_CONTRACT,
  PYTH_ABI,
  USDC_ADDRESS,
  LVUSD_ADDRESS,
  LVMON_ADDRESS,
  NATIVE_MON_ADDRESS
} from "./constants.js";
import { fetchPythPriceData } from "./pyth-client.js";
import { createLeverUpClient } from "./client.js";
import { withRetryOrThrow } from "../utils/retry.js";

export type CollateralToken = "MON" | "USDC" | "LVUSD" | "LVMON";

export interface OpenTradeParams {
  symbol: string;
  isLong: boolean;
  amountIn: bigint;
  leverage: number;
  qty: bigint;
  price: bigint;
  stopLoss?: bigint;
  takeProfit?: bigint;
  collateralToken: CollateralToken;
}

export async function executeOpenTrade(
  params: OpenTradeParams,
  config: any
) {
  const pairMetadata = SUPPORTED_PAIRS.find(p => p.pair === `${params.symbol}/USD` || p.pair === params.symbol);
  if (!pairMetadata) throw new Error(`Unsupported pair: ${params.symbol}`);

  const client = await createLeverUpClient(config);

  const priceIds = [pairMetadata.pythId];
  const monMetadata = SUPPORTED_PAIRS.find(p => p.pair === "MON/USD");
  // Fetch MON price for MON or LVMON collateral
  if ((params.collateralToken === "MON" || params.collateralToken === "LVMON") && monMetadata) {
    priceIds.push(monMetadata.pythId);
  }

  const pythUpdate = await fetchPythPriceData(priceIds);
  const priceUpdateData = pythUpdate.binary.data.map(d => d.startsWith("0x") ? d : `0x${d}` as Hex);

  const updateFee = await withRetryOrThrow(
    async () => client.readContract({
      address: PYTH_CONTRACT,
      abi: PYTH_ABI,
      functionName: "getUpdateFee",
      args: [priceUpdateData]
    }),
    { operationName: "leverup-pyth-fee" }
  );

  // Determine tokenIn and lvToken based on collateral type
  // See: https://developer-docs.leverup.xyz/guide/lv-token.html
  let tokenIn: Address;
  let lvToken: Address;

  switch (params.collateralToken) {
    case "USDC":
      tokenIn = USDC_ADDRESS;
      lvToken = LVUSD_ADDRESS;
      break;
    case "LVUSD":
      tokenIn = LVUSD_ADDRESS;
      lvToken = LVUSD_ADDRESS;
      break;
    case "LVMON":
      tokenIn = LVMON_ADDRESS;
      lvToken = LVMON_ADDRESS;
      break;
    case "MON":
    default:
      tokenIn = NATIVE_MON_ADDRESS;
      lvToken = LVMON_ADDRESS;
      break;
  }

  const openFeeBps = 45n;
  const openFee = (params.amountIn * BigInt(params.leverage) * openFeeBps) / 100000n;
  const totalAmountIn = params.amountIn + openFee;

  const openData = {
    pairBase: getAddress(pairMetadata.pairBase),
    isLong: params.isLong,
    tokenIn,
    lvToken,
    amountIn: totalAmountIn,
    qty: params.qty,
    price: params.price,
    stopLoss: params.stopLoss || 0n,
    takeProfit: params.takeProfit || 0n,
    broker: 0
  };

  const calldata = encodeFunctionData({
    abi: TRADING_PORTAL_ABI,
    functionName: "openMarketTradeWithPyth",
    args: [openData, priceUpdateData]
  });

  // Only send native MON value if using native MON collateral
  const msgValue = updateFee + (params.collateralToken === "MON" ? totalAmountIn : 0n);

  return {
    to: LEVERUP_DIAMOND,
    data: calldata,
    value: msgValue,
    tokenIn,
    amountIn: totalAmountIn
  };
}

export async function executeCloseTrade(tradeHash: Hex) {
  const calldata = encodeFunctionData({
    abi: TRADING_PORTAL_ABI,
    functionName: "closeTrade",
    args: [tradeHash]
  });

  return {
    to: LEVERUP_DIAMOND,
    data: calldata,
    value: 0n
  };
}

export async function executeUpdateMargin(
  tradeHash: Hex,
  amount: bigint,
  isAdd: boolean
) {
  const calldata = encodeFunctionData({
    abi: TRADING_PORTAL_ABI,
    functionName: "updateMargin",
    args: [tradeHash, amount, isAdd]
  });

  return {
    to: LEVERUP_DIAMOND,
    data: calldata,
    value: isAdd ? amount : 0n
  };
}
